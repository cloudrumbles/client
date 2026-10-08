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
    pub source_name: String,
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
    // Execution phases follow Iris beginHand/beginTranslucents: opaque actors,
    // solid hand, deferred, translucent world/hand, then composite and final.
    for stage in [
        "begin",
        "prepare",
        "shadow",
        "shadow_entities",
        "shadow_block",
        "shadowcomp",
        "gbuffers_terrain",
        "gbuffers_entities",
        "gbuffers_block",
        "gbuffers_hand",
        "deferred",
        "gbuffers_water",
        "gbuffers_entities_translucent",
        "gbuffers_block_translucent",
        "gbuffers_hand_water",
        "composite",
        "final",
    ] {
        let numbered = matches!(
            stage,
            "begin" | "prepare" | "shadowcomp" | "deferred" | "composite"
        );
        for i in 0..if numbered { 100 } else { 1 } {
            let name = if i == 0 {
                stage.into()
            } else {
                format!("{stage}{i}")
            };
            if crate::stages::resolve(pack, &name)?.is_some() {
                names.push(name);
            }
        }
    }
    ensure!(
        names.iter().any(|n| n == "final") && names.iter().any(|n| n == "gbuffers_terrain"),
        "pack needs resolvable final and terrain programs"
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
            let source_name = crate::stages::resolve(pack, &name)?.context("unresolved program")?;
            let vertex = pack.source(&pack.program_path(&source_name, "vsh").unwrap())?;
            let fragment = pack.source(&pack.program_path(&source_name, "fsh").unwrap())?;
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
            sources.push((name, source_name, vertex, fragment));
        }
        for (name, ty, count) in [
            ("pomme_ModelViewMatrix", "mat4", 1),
            ("pomme_ProjectionMatrix", "mat4", 1),
            ("pomme_NormalMatrix", "mat3", 1),
            ("pomme_TextureMatrix", "mat4", 8),
            ("pomme_ActorInputs", "bool", 1),
            ("pomme_ActorLight", "vec2", 1),
            ("pomme_ActorTint", "vec4", 1),
            ("pomme_ActorMaterial", "vec3", 1),
            ("pomme_ActorHandedness", "float", 1),
            ("pomme_AlphaTest", "float", 1),
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
        for (name, source_name, vertex, fragment) in sources {
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
                source_name,
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
    // Actor material storage is RGB, like the native vertex format. Keep the
    // pack's vec4 declaration and Vulkan's default value for its missing W.
    let actor_material = if vertex
        && varying_re()?
            .captures_iter(source)
            .any(|c| matches!(&c[2], "attribute" | "in") && &c[3] == "vec4" && &c[4] == "mc_Entity")
    {
        "vec4(pomme_ActorMaterial,1.0)"
    } else {
        "pomme_ActorMaterial"
    };
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
    body = Regex::new(r"\bat_tangent\b")?
        .replace_all(&body, "pomme_MeshTangent")
        .into_owned();
    body = Regex::new(r"\bmc_Entity\b")?
        .replace_all(&body, "pomme_MeshMaterial")
        .into_owned();
    let attrs = [
        ("pomme_MeshTangent", 5),
        ("pomme_MeshMaterial", 6),
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
        ("gl_MultiTexCoord1", "pomme_EffectiveLight"),
        ("gl_Vertex", "pomme_Vertex"),
        ("gl_Normal", "pomme_Normal"),
        ("gl_Color", "pomme_EffectiveColor"),
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
        // GLSL compatibility's ftransform is the fixed-function MVP operation.
        // The wrapper below performs Vulkan's clip-depth conversion afterwards.
        body = Regex::new(r"\bftransform\s*\(\s*\)")?
            .replace_all(
                &body,
                "(pomme_ProjectionMatrix*pomme_ModelViewMatrix*pomme_Vertex)",
            )
            .into_owned();
        header.push_str("layout(location=0) in vec4 pomme_Vertex;\nlayout(location=1) in vec3 pomme_Normal;\nlayout(location=2) in vec4 pomme_TexCoord;\nlayout(location=3) in vec4 pomme_LightCoord;\nlayout(location=4) in vec4 pomme_Color;\n");
        body = Regex::new(r"\bpomme_MeshTangent\b")?
            .replace_all(&body, "pomme_EffectiveTangent")
            .into_owned();
        body = body.replace(
            "in vec4 pomme_EffectiveTangent;",
            "in vec4 pomme_MeshTangent;",
        );
        header.push_str("#define pomme_EffectiveTangent vec4(pomme_MeshTangent.xyz,pomme_MeshTangent.w*(pomme_ActorInputs?pomme_ActorHandedness:1.0))\n");
        body = Regex::new(r"\bpomme_MeshMaterial\b")?
            .replace_all(&body, "pomme_EffectiveMaterial")
            .into_owned();
        // Its declaration must remain an input, not expand through the value alias.
        body = body.replace(
            "in vec3 pomme_EffectiveMaterial;",
            "in vec3 pomme_MeshMaterial;",
        );
        body = body.replace(
            "in vec4 pomme_EffectiveMaterial;",
            "in vec4 pomme_MeshMaterial;",
        );
        header.push_str("#define pomme_EffectiveLight (pomme_ActorInputs?vec4(pomme_ActorLight,0,1):pomme_LightCoord)\n#define pomme_EffectiveColor (pomme_ActorInputs?pomme_ActorTint*pomme_Color:pomme_Color)\n");
        header.push_str(&format!("#define pomme_EffectiveMaterial (pomme_ActorInputs?{actor_material}:pomme_MeshMaterial)\n"));
        body = Regex::new(r"\bvoid\s+main\s*\(\s*\)")?
            .replace(&body, "void pomme_main()")
            .into_owned();
        body.push_str(
            "\nvoid main(){pomme_main();gl_Position.z=(gl_Position.z+gl_Position.w)*0.5;}\n",
        );
    } else {
        body = body.replace("pomme_EffectiveColor", "pomme_ActorTint");
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
        let output = if body.contains("pomme_FragColor") {
            Some("pomme_FragColor".to_owned())
        } else if !indices.is_empty() {
            Some("pomme_FragData[0]".to_owned())
        } else {
            Regex::new(r"layout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4\s+(\w+)")?
                .captures(&body)
                .map(|c| c[1].to_owned())
        };
        if let Some(output) = output {
            body = Regex::new(r"\bvoid\s+main\s*\(\s*\)")?
                .replace(&body, "void pomme_main()")
                .into_owned();
            body.push_str(&format!("\nvoid main(){{pomme_main();if(pomme_ActorInputs&&pomme_AlphaTest>=0.0&&{output}.a<=pomme_AlphaTest)discard;}}\n"));
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
    fn material_vec3_and_vec4_aliases_compile_with_all_components_used() {
        let abi = Abi {
            uniforms: vec![
                Uniform {
                    name: "pomme_ActorInputs".into(),
                    ty: "bool".into(),
                    count: 1,
                    offset: 0,
                    size: 16,
                },
                Uniform {
                    name: "pomme_ActorMaterial".into(),
                    ty: "vec3".into(),
                    count: 1,
                    offset: 16,
                    size: 16,
                },
            ],
            samplers: vec![],
            uniform_size: 32,
        };
        let compiler = shaderc::Compiler::new().unwrap();
        let mut options = shaderc::CompileOptions::new().unwrap();
        options.set_target_env(
            shaderc::TargetEnv::Vulkan,
            shaderc::EnvVersion::Vulkan1_2 as u32,
        );
        for (ty, value) in [("vec3", "vec4(mc_Entity,1.0)"), ("vec4", "mc_Entity")] {
            let source = translate(
                &format!("#version 330 compatibility\nattribute {ty} mc_Entity;\nvoid main(){{gl_Position={value};}}"),
                &abi,
                &BTreeMap::new(),
                true,
            ).unwrap();
            assert!(source.contains(&format!("layout(location=6) in {ty} pomme_MeshMaterial;")));
            compiler
                .compile_into_spirv(
                    &source,
                    shaderc::ShaderKind::Vertex,
                    &format!("material-{ty}.vsh"),
                    "main",
                    Some(&options),
                )
                .unwrap_or_else(|error| panic!("{ty}: {error}"));
        }
    }
    #[test]
    fn compatibility_ftransform_compiles_for_vulkan() {
        let abi = Abi {
            uniforms: ["pomme_ModelViewMatrix", "pomme_ProjectionMatrix"]
                .into_iter()
                .enumerate()
                .map(|(i, name)| Uniform {
                    name: name.into(),
                    ty: "mat4".into(),
                    count: 1,
                    offset: i * 64,
                    size: 64,
                })
                .collect(),
            samplers: Vec::new(),
            uniform_size: 128,
        };
        let source = translate(
            "#version 330 compatibility\nvoid main(){gl_Position=ftransform();}",
            &abi,
            &BTreeMap::new(),
            true,
        )
        .unwrap();
        let compiler = shaderc::Compiler::new().unwrap();
        let mut options = shaderc::CompileOptions::new().unwrap();
        options.set_target_env(
            shaderc::TargetEnv::Vulkan,
            shaderc::EnvVersion::Vulkan1_2 as u32,
        );
        compiler
            .compile_into_spirv(
                &source,
                shaderc::ShaderKind::Vertex,
                "legacy.vsh",
                "main",
                Some(&options),
            )
            .unwrap();
    }
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
