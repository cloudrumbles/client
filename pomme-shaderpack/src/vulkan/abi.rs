use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde::Serialize;

use crate::expression::Value;
use crate::pack::Pack;

#[derive(Clone, Debug, Serialize)]
pub struct Uniform {
    pub name: String,
    pub ty: String,
    pub count: usize,
    pub offset: usize,
    pub size: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct Sampler {
    pub name: String,
    pub ty: String,
    pub binding: u32,
}
#[derive(Serialize)]
pub struct Abi {
    pub uniforms: Vec<Uniform>,
    pub samplers: Vec<Sampler>,
    pub uniform_size: usize,
}
pub struct Program {
    pub name: String,
    pub vertex: Vec<u32>,
    pub fragment: Vec<u32>,
    pub targets: Vec<usize>,
    pub mipmaps: Vec<usize>,
    pub active_uniforms: BTreeSet<usize>,
    pub samplers: Vec<Sampler>,
    pub source: String,
    pub vertex_source: String,
    pub fragment_source: String,
}
pub struct Compiled {
    pub abi: Abi,
    pub programs: Vec<Program>,
}
fn uniform_re() -> Result<Regex> {
    Ok(Regex::new(
        r"\buniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*(?:=[^;]+)?;",
    )?)
}
fn shape(ty: &str, count: usize) -> Result<usize> {
    let size = match ty {
        "float" | "int" | "uint" | "bool" | "vec2" | "vec3" | "vec4" | "ivec2" | "ivec3"
        | "ivec4" | "uvec2" | "uvec3" | "uvec4" => 16,
        "mat2" => 32,
        "mat3" => 48,
        "mat4" => 64,
        _ => anyhow::bail!("unsupported Vulkan uniform type: {ty}"),
    };
    Ok(size * count)
}
pub fn program_names(pack: &Pack) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for stage in [
        "begin",
        "prepare",
        "shadow",
        "shadowcomp",
        "gbuffers_terrain",
        "deferred",
        "gbuffers_water",
        "composite",
        "final",
    ] {
        let numbered = matches!(stage, "begin" | "prepare" | "deferred" | "composite");
        for i in 0..if numbered { 100 } else { 1 } {
            let name = if i == 0 {
                stage.into()
            } else {
                format!("{stage}{i}")
            };
            if pack.enabled(&name)? && pack.program_path(&name, "fsh").is_some() {
                ensure!(
                    pack.program_path(&name, "vsh").is_some(),
                    "missing {name} vertex program"
                );
                names.push(name);
            }
        }
    }
    ensure!(
        names.iter().any(|n| n == "final") && names.iter().any(|n| n == "gbuffers_terrain"),
        "pack needs final and terrain programs"
    );
    Ok(names)
}
impl Compiled {
    pub fn new(pack: &Pack) -> Result<Self> {
        let names = program_names(pack)?;
        let mut sources = Vec::new();
        let mut uniforms = BTreeMap::new();
        let mut samplers = BTreeSet::new();
        let ure = uniform_re()?;
        for name in names {
            let vertex = pack.source(&pack.program_path(&name, "vsh").unwrap())?;
            let fragment = pack.source(&pack.program_path(&name, "fsh").unwrap())?;
            for source in [&vertex, &fragment] {
                for c in ure.captures_iter(source) {
                    let ty = c[1].to_owned();
                    let name = c[2].to_owned();
                    let count = c.get(3).map_or(Ok(1), |v| v.as_str().parse::<usize>())?;
                    if ty.contains("sampler") {
                        ensure!(
                            count == 1,
                            "sampler arrays require an explicit array binding ABI"
                        );
                        samplers.insert((name, ty));
                    } else {
                        if let Some(old) = uniforms.insert(name.clone(), (ty.clone(), count)) {
                            ensure!(old == (ty, count), "conflicting uniform declaration {name}");
                        }
                    }
                }
            }
            sources.push((name, vertex, fragment));
        }
        for (name, ty, count) in [
            ("pomme_ModelViewMatrix", "mat4", 1),
            ("pomme_ProjectionMatrix", "mat4", 1),
            ("pomme_NormalMatrix", "mat3", 1),
            ("pomme_TextureMatrix", "mat4", 8),
        ] {
            uniforms.insert(name.into(), (ty.into(), count));
        }
        let mut offset = 0;
        let uniforms = uniforms
            .into_iter()
            .map(|(name, (ty, count))| {
                let size = shape(&ty, count)?;
                let u = Uniform {
                    name,
                    ty,
                    count,
                    offset,
                    size,
                };
                offset += size;
                Ok(u)
            })
            .collect::<Result<Vec<_>>>()?;
        let samplers = samplers
            .into_iter()
            .enumerate()
            .map(|(i, (name, ty))| Sampler {
                name,
                ty,
                binding: i as u32 + 1,
            })
            .collect();
        let abi = Abi {
            uniforms,
            samplers,
            uniform_size: offset,
        };
        let compiler = shaderc::Compiler::new()?;
        let mut options = shaderc::CompileOptions::new()?;
        options.set_target_env(
            shaderc::TargetEnv::Vulkan,
            shaderc::EnvVersion::Vulkan1_2 as u32,
        );
        options.set_optimization_level(shaderc::OptimizationLevel::Performance);
        let output_re =
            Regex::new(r"layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*out\s+(\w+)\s+(\w+)\s*;")?;
        let mip_re = Regex::new(r"const\s+bool\s+colortex(\d+)MipmapEnabled\s*=\s*true")?;
        let mut programs = Vec::new();
        for (name, vertex, fragment) in sources {
            let varyings = varying_locations(&vertex, &fragment)?;
            let vs = translate(&vertex, &abi, &varyings, true)?;
            let source = format!("{vertex}\n{fragment}");
            let targets = crate::pack::render_targets(&source)?;
            let fs = translate(&fragment, &abi, &varyings, false)?;
            // OpenGL discards outputs with no draw buffer. Keep them as private
            // variables so Vulkan also discards them without an undefined interface.
            let fs = output_re
                .replace_all(&fs, |c: &regex::Captures| {
                    if c[1].parse::<usize>().unwrap() >= targets.len() {
                        format!("{} {};", &c[2], &c[3])
                    } else {
                        c[0].to_owned()
                    }
                })
                .into_owned();
            let compile = |text: &str, kind, ext| -> Result<Vec<u32>> {
                match compiler.compile_into_spirv(
                    text,
                    kind,
                    &format!("{name}.{ext}"),
                    "main",
                    Some(&options),
                ) {
                    Ok(a) => Ok(a.as_binary().to_vec()),
                    Err(e) => {
                        std::fs::write(
                            std::env::temp_dir().join(format!("pomme-vulkan-{name}.{ext}")),
                            text,
                        )
                        .ok();
                        Err(e.into())
                    }
                }
            };
            let vertex_spv = compile(&vs, shaderc::ShaderKind::Vertex, "vsh")
                .with_context(|| format!("Vulkan vertex {name}"))?;
            let fragment_spv = compile(&fs, shaderc::ShaderKind::Fragment, "fsh")
                .with_context(|| format!("Vulkan fragment {name}"))?;
            let mut active_uniforms = active_members(&vertex_spv);
            active_uniforms.extend(active_members(&fragment_spv));
            let mut bindings = active_bindings(&vertex_spv);
            bindings.extend(active_bindings(&fragment_spv));
            let samplers: Vec<Sampler> = abi
                .samplers
                .iter()
                .filter(|s| bindings.contains(&s.binding))
                .cloned()
                .collect();
            let mipmaps = mip_re
                .captures_iter(&source)
                .map(|c| c[1].parse())
                .collect::<std::result::Result<Vec<_>, _>>()?;
            eprintln!(
                "Vulkan compiled {name}: {} uniforms, {} samplers",
                active_uniforms.len(),
                samplers.len()
            );
            programs.push(Program {
                name,
                vertex: vertex_spv,
                fragment: fragment_spv,
                targets,
                mipmaps,
                active_uniforms,
                samplers,
                source,
                vertex_source: vs,
                fragment_source: fs,
            });
        }
        Ok(Self { abi, programs })
    }
}
fn varying_re() -> Result<Regex> {
    Ok(Regex::new(
        r"(?m)^\s*(?:(flat|smooth|noperspective)\s+)?(varying|in|out|attribute)\s+(\w+)\s+(\w+)\s*;",
    )?)
}
fn varying_locations(vertex: &str, fragment: &str) -> Result<BTreeMap<String, usize>> {
    let re = varying_re()?;
    let mut vars = BTreeMap::new();
    for (source, qualifier) in [(vertex, "out"), (fragment, "in")] {
        for c in re.captures_iter(source) {
            if &c[2] == qualifier || &c[2] == "varying" {
                let name = c[4].to_owned();
                let ty = c[3].to_owned();
                if let Some(old) = vars.insert(name.clone(), ty.clone()) {
                    ensure!(old == ty, "varying type mismatch {name}");
                }
            }
        }
    }
    let all = format!("{vertex}\n{fragment}");
    let structs = Regex::new(r"(?s)struct\s+(\w+)\s*\{([^}]+)\}\s*;")?
        .captures_iter(&all)
        .map(|c| (c[1].to_owned(), c[2].to_owned()))
        .collect::<BTreeMap<_, _>>();
    fn span(ty: &str, structs: &BTreeMap<String, String>, depth: usize) -> Result<usize> {
        ensure!(depth < 16, "recursive varying structure");
        if let Some(fields) = structs.get(ty) {
            let fields = Regex::new(r"(?s)/\*.*?\*/|//[^\n]*")?.replace_all(fields, "");
            let re = Regex::new(r"\b(\w+)\s+\w+\s*(?:\[\s*(\d+)\s*\])?\s*(?:=[^;]+)?;")?;
            let mut size = 0;
            for c in re.captures_iter(&fields) {
                let count = c.get(2).map_or(Ok(1), |m| m.as_str().parse::<usize>())?;
                size += span(&c[1], structs, depth + 1)? * count;
            }
            ensure!(size > 0, "empty or unsupported varying struct {ty}");
            Ok(size)
        } else if let Some(ty) = ty.strip_prefix("mat") {
            Ok(ty.split('x').next().unwrap().parse::<usize>()?)
        } else {
            Ok(1)
        }
    }
    let mut location = 0;
    let mut out = BTreeMap::new();
    for (name, ty) in vars {
        out.insert(name, location);
        location += span(&ty, &structs, 0)?;
    }
    Ok(out)
}
fn translate(
    source: &str,
    abi: &Abi,
    varyings: &BTreeMap<String, usize>,
    vertex: bool,
) -> Result<String> {
    let source = source
        .lines()
        .filter(|l| !l.trim().starts_with("#version") && !l.trim().starts_with("#extension"))
        .collect::<Vec<_>>()
        .join("\n");
    let ure = uniform_re()?;
    let mut body = ure
        .replace_all(&source, |c: &regex::Captures| {
            if c[1].contains("sampler") {
                let s = abi
                    .samplers
                    .iter()
                    .find(|s| s.name == c[2] && s.ty == c[1])
                    .unwrap();
                format!(
                    "layout(set=0,binding={}) uniform {} {};",
                    s.binding, s.ty, s.name
                )
            } else {
                String::new()
            }
        })
        .into_owned();
    let attrs = [
        ("at_tangent", 5),
        ("mc_Entity", 6),
        ("mc_midTexCoord", 7),
        ("at_midBlock", 8),
    ];
    body = varying_re()?
        .replace_all(&body, |c: &regex::Captures| {
            let kind = &c[2];
            let name = &c[4];
            let ty = &c[3];
            let flat = c.get(1).map_or("", |x| x.as_str());
            if vertex && (kind == "attribute" || kind == "in") {
                if let Some((_, loc)) = attrs.iter().find(|(n, _)| *n == name) {
                    format!("layout(location={loc}) in {ty} {name};")
                } else {
                    format!("{flat} {kind} {ty} {name};")
                }
            } else if kind == "varying" || (vertex && kind == "out") || (!vertex && kind == "in") {
                format!(
                    "layout(location={}) {flat} {} {ty} {name};",
                    varyings[name],
                    if vertex { "out" } else { "in" }
                )
            } else {
                c[0].to_owned()
            }
        })
        .into_owned();
    for (from, to) in [
        ("gl_ModelViewMatrix", "pomme_ModelViewMatrix"),
        ("gl_ProjectionMatrix", "pomme_ProjectionMatrix"),
        ("gl_NormalMatrix", "pomme_NormalMatrix"),
        ("gl_TextureMatrix", "pomme_TextureMatrix"),
        ("gl_MultiTexCoord0", "pomme_TexCoord"),
        ("gl_MultiTexCoord1", "pomme_LightCoord"),
        ("gl_Vertex", "pomme_Vertex"),
        ("gl_Normal", "pomme_Normal"),
        ("gl_Color", "pomme_Color"),
        ("gl_VertexID", "gl_VertexIndex"),
        ("gl_FragData", "pomme_FragData"),
        ("gl_FragColor", "pomme_FragColor"),
        ("texture2D", "texture"),
        ("texture2DLod", "textureLod"),
        ("texture2DLodARB", "textureLod"),
    ] {
        body = Regex::new(&format!(r"\b{from}\b"))?
            .replace_all(&body, to)
            .into_owned();
    }
    // Vulkan reserves sampler for a separate sampler object; legacy packs
    // commonly use it as a function parameter name.
    body = Regex::new(r"\bsampler\b")?
        .replace_all(&body, "pommeSampler")
        .into_owned();
    let mut header =
        String::from("#version 450\nlayout(std140,set=0,binding=0) uniform PommeFrame {\n");
    for u in &abi.uniforms {
        header.push_str(&format!(
            "layout(offset={}) {} {}{};\n",
            u.offset,
            u.ty,
            u.name,
            if u.count > 1 {
                format!("[{}]", u.count)
            } else {
                String::new()
            }
        ));
    }
    header.push_str("};\n");
    if vertex {
        header.push_str("layout(location=0) in vec4 pomme_Vertex;\nlayout(location=1) in vec3 pomme_Normal;\nlayout(location=2) in vec4 pomme_TexCoord;\nlayout(location=3) in vec4 pomme_LightCoord;\nlayout(location=4) in vec4 pomme_Color;\n");
        body = Regex::new(r"\bvoid\s+main\s*\(\s*\)")?
            .replace(&body, "void pomme_main()")
            .into_owned();
        body.push_str(
            "\nvoid main(){pomme_main();gl_Position.z=(gl_Position.z+gl_Position.w)*0.5;}\n",
        );
    } else {
        let indices = Regex::new(r"pomme_FragData\s*\[\s*(\d+)\s*\]")?
            .captures_iter(&body)
            .map(|c| c[1].parse::<usize>())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if let Some(max) = indices.iter().max() {
            header.push_str(&format!(
                "layout(location=0) out vec4 pomme_FragData[{}];\n",
                max + 1
            ));
        }
        if body.contains("pomme_FragColor") {
            header.push_str("layout(location=0) out vec4 pomme_FragColor;\n");
        }
    }
    Ok(header + &body)
}
// The optimized SPIR-V access chains identify actually consumed block members,
// so declarations in unused pack helpers don't create placeholder host inputs.
fn active_members(words: &[u32]) -> BTreeSet<usize> {
    let mut binding_zero = BTreeSet::new();
    let mut constants = BTreeMap::new();
    let mut chains = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        let op = words[at] & 0xffff;
        if count == 0 || at + count > words.len() {
            break;
        }
        let args = &words[at + 1..at + count];
        match op {
            71 if args.len() >= 3 && args[1] == 33 && args[2] == 0 => {
                binding_zero.insert(args[0]);
            }
            43 if args.len() >= 3 => {
                constants.insert(args[1], args[2]);
            }
            65 | 66 if args.len() >= 4 => {
                chains.push((args[2], args[3]));
            }
            _ => (),
        }
        at += count;
    }
    chains
        .into_iter()
        .filter(|(base, _)| binding_zero.contains(base))
        .filter_map(|(_, index)| constants.get(&index).map(|n| *n as usize))
        .collect()
}
fn active_bindings(words: &[u32]) -> BTreeSet<u32> {
    let mut bindings = BTreeSet::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            break;
        }
        let args = &words[at + 1..at + count];
        if words[at] & 0xffff == 71 && args.len() >= 3 && args[1] == 33 {
            bindings.insert(args[2]);
        }
        at += count;
    }
    bindings
}
pub(crate) fn input_locations(words: &[u32]) -> BTreeSet<u32> {
    let mut locations = BTreeMap::new();
    let mut inputs = BTreeSet::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            break;
        }
        let a = &words[at + 1..at + count];
        match words[at] & 0xffff {
            71 if a.len() >= 3 && a[1] == 30 => {
                locations.insert(a[0], a[2]);
            }
            59 if a.len() >= 3 && a[2] == 1 => {
                inputs.insert(a[1]);
            }
            _ => {}
        }
        at += count;
    }
    inputs
        .into_iter()
        .filter_map(|i| locations.get(&i).copied())
        .collect()
}
impl Abi {
    pub fn bytes(
        &self,
        values: &BTreeMap<String, Value>,
        active: &BTreeSet<usize>,
    ) -> Result<Vec<u8>> {
        let mut bytes = vec![0; self.uniform_size];
        for (i, u) in self.uniforms.iter().enumerate() {
            if !active.contains(&i) {
                continue;
            }
            let value = values
                .get(&u.name)
                .with_context(|| format!("unbound active Vulkan uniform {}", u.name))?;
            let columns = if u.ty.starts_with("mat") {
                u.ty[3..].parse::<usize>()?
            } else {
                1
            };
            let components = if columns > 1 {
                columns
            } else {
                u.ty.chars()
                    .last()
                    .and_then(|c| c.to_digit(10))
                    .unwrap_or(1) as usize
            };
            ensure!(
                value.0.len() == columns * components * u.count,
                "wrong uniform length {}",
                u.name
            );
            for element in 0..u.count {
                for column in 0..columns {
                    for component in 0..components {
                        let n = value.0
                            [element * columns * components + column * components + component];
                        let word = if u.ty.starts_with('i') || u.ty == "bool" {
                            (n as i32).to_le_bytes()
                        } else if u.ty.starts_with('u') {
                            (n as u32).to_le_bytes()
                        } else {
                            (n as f32).to_le_bytes()
                        };
                        let offset =
                            u.offset + element * u.size / u.count + column * 16 + component * 4;
                        bytes[offset..offset + 4].copy_from_slice(&word);
                    }
                }
            }
        }
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn std140_matrix_padding_and_active_inputs() {
        let abi = Abi {
            uniforms: vec![
                Uniform {
                    name: "m".into(),
                    ty: "mat3".into(),
                    count: 1,
                    offset: 0,
                    size: 48,
                },
                Uniform {
                    name: "unused".into(),
                    ty: "float".into(),
                    count: 1,
                    offset: 48,
                    size: 16,
                },
            ],
            samplers: vec![],
            uniform_size: 64,
        };
        let values = BTreeMap::from([("m".into(), Value((1..=9).map(f64::from).collect()))]);
        let bytes = abi.bytes(&values, &BTreeSet::from([0])).unwrap();
        assert_eq!(f32::from_le_bytes(bytes[16..20].try_into().unwrap()), 4.0);
        assert_eq!(&bytes[12..16], &[0; 4]);
        assert!(abi.bytes(&values, &BTreeSet::from([1])).is_err());
    }
}
