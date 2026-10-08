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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ImageAccess {
    ReadOnly,
    WriteOnly,
    ReadWrite,
}
impl ImageAccess {
    fn qualifier(self) -> &'static str {
        match self {
            Self::ReadOnly => "readonly",
            Self::WriteOnly => "writeonly",
            Self::ReadWrite => "",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ImageBinding {
    pub name: String,
    pub ty: String,
    pub binding: u32,
    pub format: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageImage {
    pub name: String,
    pub ty: String,
    pub binding: u32,
    pub format: String,
    pub access: ImageAccess,
    pub qualifiers: Vec<String>,
}
#[derive(Serialize)]
pub struct Abi {
    pub uniforms: Vec<Uniform>,
    pub samplers: Vec<Sampler>,
    /// Shared resource identity. Access and memory qualifiers belong to each
    /// compute program's declaration, rather than to the descriptor binding.
    pub images: Vec<ImageBinding>,
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
pub struct ComputeProgram {
    pub name: String,
    pub base: String,
    /// Vulkan GLSL after uniform/image ABI translation.
    pub source: String,
    pub spirv: Vec<u32>,
    pub dispatch: crate::compute::Dispatch,
    pub local_size: [u32; 3],
    pub active_uniforms: BTreeSet<usize>,
    pub samplers: Vec<Sampler>,
    pub images: Vec<StorageImage>,
    /// Logical storage reflected from optimized SPIR-V types. For implicitly
    /// laid out Workgroup variables this is not the driver's allocation size;
    /// validate pipeline creation/execution against the actual device limits.
    pub shared_memory_bytes: usize,
    pub capabilities: BTreeSet<u32>,
}
pub struct Compiled {
    pub abi: Abi,
    pub programs: Vec<Program>,
    pub compute_programs: Vec<ComputeProgram>,
}
fn uniform_re() -> Result<Regex> {
    Ok(Regex::new(
        r"(?:layout\s*\([^)]*\)\s*)?\buniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*(?:=[^;]+)?;",
    )?)
}
// Resource declarations are normalized independently of graphics interfaces.
// This first ABI supports individually bound, explicitly formatted 2D images;
// storage buffers, image arrays and other image dimensions require another ABI.
fn without_comments(source: &str) -> Result<String> {
    Ok(Regex::new(r"(?s)/\*.*?\*/|//[^\n]*")?
        .replace_all(source, " ")
        .into_owned())
}
fn image_re() -> Result<Regex> {
    Ok(Regex::new(concat!(
        r"(?P<prefix>(?:layout\s*\([^)]*\)\s*|(?:coherent|volatile|restrict|readonly|writeonly|highp|mediump|lowp)\s+)*)",
        r"\buniform\s+(?P<after>(?:(?:coherent|volatile|restrict|readonly|writeonly|highp|mediump|lowp)\s+)*)",
        r"(?P<ty>[iu]?image\w+)\s+(?P<name>\w+)(?P<tail>[^;]*);"
    ))?)
}
fn parsed_image(c: &regex::Captures<'_>) -> Result<StorageImage> {
    let ty = &c["ty"];
    let name = &c["name"];
    ensure!(
        matches!(ty, "image2D" | "iimage2D" | "uimage2D"),
        "unsupported storage image type {ty} ({name})"
    );
    ensure!(
        c["tail"].trim().is_empty(),
        "storage image arrays/initializers require an explicit binding ABI ({name})"
    );
    let qualifiers = format!("{} {}", &c["prefix"], &c["after"]);
    let mut format = None;
    for layout in Regex::new(r"layout\s*\(([^)]*)\)")?.captures_iter(&qualifiers) {
        for token in layout[1].split(',').map(str::trim) {
            if token.contains('=') {
                // Pack-local OpenGL bindings/locations are replaced by this ABI.
                let key = token.split('=').next().unwrap().trim();
                ensure!(
                    matches!(key, "binding" | "set"),
                    "unsupported storage image layout {token} ({name})"
                );
                continue;
            }
            ensure!(
                matches!(
                    token,
                    "rgba32f"
                        | "rgba16f"
                        | "r32f"
                        | "rgba8"
                        | "rgba8_snorm"
                        | "rg32f"
                        | "rg16f"
                        | "r11f_g11f_b10f"
                        | "r16f"
                        | "rgba16"
                        | "rgb10_a2"
                        | "rg16"
                        | "rg8"
                        | "r16"
                        | "r8"
                        | "rgba16_snorm"
                        | "rg16_snorm"
                        | "rg8_snorm"
                        | "r16_snorm"
                        | "r8_snorm"
                        | "rgba32i"
                        | "rgba16i"
                        | "rgba8i"
                        | "r32i"
                        | "rg32i"
                        | "rg16i"
                        | "rg8i"
                        | "r16i"
                        | "r8i"
                        | "rgba32ui"
                        | "rgba16ui"
                        | "rgba8ui"
                        | "r32ui"
                        | "rgb10_a2ui"
                        | "rg32ui"
                        | "rg16ui"
                        | "rg8ui"
                        | "r16ui"
                        | "r8ui"
                ),
                "unsupported storage image format {token} ({name})"
            );
            ensure!(
                format.replace(token.to_owned()).is_none(),
                "multiple storage image formats ({name})"
            );
        }
    }
    let format =
        format.with_context(|| format!("storage image {name} requires an explicit format"))?;
    let expected = if format.ends_with("ui") {
        "uimage2D"
    } else if format.ends_with('i') {
        "iimage2D"
    } else {
        "image2D"
    };
    ensure!(
        ty == expected,
        "storage image {name} type {ty} disagrees with format {format}"
    );
    let mut access = ImageAccess::ReadWrite;
    let mut extra = Vec::new();
    // Remove layout text before examining the independent memory qualifiers.
    let qualifiers = Regex::new(r"layout\s*\([^)]*\)")?.replace_all(&qualifiers, " ");
    for qualifier in qualifiers.split_whitespace() {
        match qualifier {
            "readonly" | "writeonly" => {
                ensure!(
                    access == ImageAccess::ReadWrite,
                    "conflicting storage image access qualifiers ({name})"
                );
                access = if qualifier == "readonly" {
                    ImageAccess::ReadOnly
                } else {
                    ImageAccess::WriteOnly
                };
            }
            "coherent" | "volatile" | "restrict" | "highp" | "mediump" | "lowp" => {
                extra.push(qualifier.to_owned())
            }
            _ => anyhow::bail!("unsupported storage image qualifier {qualifier} ({name})"),
        }
    }
    extra.sort();
    extra.dedup();
    Ok(StorageImage {
        name: name.into(),
        ty: ty.into(),
        binding: 0,
        format,
        access,
        qualifiers: extra,
    })
}
fn collect_declarations(
    source: &str,
    uniforms: &mut BTreeMap<String, (String, usize)>,
    samplers: &mut BTreeSet<(String, String)>,
    images: &mut BTreeMap<String, ImageBinding>,
) -> Result<()> {
    let source = without_comments(source)?;
    ensure!(
        !Regex::new(r"\bbuffer\s*(?:\w+\s*)?\{")?.is_match(&source),
        "storage buffers require an explicit SSBO ABI"
    );
    ensure!(
        !Regex::new(r"\buniform\s+\w+\s*\{")?.is_match(&source),
        "pack uniform blocks require an explicit block ABI"
    );
    ensure!(
        !Regex::new(r"\buniform\s+atomic_uint\b")?.is_match(&source),
        "atomic-counter buffers require an explicit ABI"
    );
    let image_re = image_re()?;
    for c in image_re.captures_iter(&source) {
        let declaration = parsed_image(&c)?;
        let image = ImageBinding {
            name: declaration.name,
            ty: declaration.ty,
            binding: 0,
            format: declaration.format,
        };
        if let Some(previous) = images.get(&image.name) {
            ensure!(
                *previous == image,
                "conflicting storage image declaration {}",
                image.name
            );
        } else {
            images.insert(image.name.clone(), image);
        }
    }
    let source = image_re.replace_all(&source, "");
    for c in uniform_re()?.captures_iter(&source) {
        let ty = c[1].to_owned();
        let name = c[2].to_owned();
        let count = c.get(3).map_or(Ok(1), |v| v.as_str().parse::<usize>())?;
        ensure!(count > 0, "zero-length uniform {name}");
        if ty.contains("sampler") {
            ensure!(
                count == 1,
                "sampler arrays require an explicit array binding ABI"
            );
            samplers.insert((name, ty));
        } else {
            ensure!(
                !ty.contains("image"),
                "unparsed storage image declaration {name}"
            );
            if let Some(old) = uniforms.insert(name.clone(), (ty.clone(), count)) {
                ensure!(old == (ty, count), "conflicting uniform declaration {name}");
            }
        }
    }
    Ok(())
}
fn bind_image(mut image: StorageImage, abi: &Abi) -> Result<StorageImage> {
    let binding = abi
        .images
        .iter()
        .find(|binding| binding.name == image.name)
        .with_context(|| format!("unbound storage image {}", image.name))?;
    ensure!(
        binding.ty == image.ty && binding.format == image.format,
        "conflicting storage image declaration {}",
        image.name
    );
    image.binding = binding.binding;
    Ok(image)
}
fn translate_declarations(source: &str, abi: &Abi) -> Result<String> {
    let source = without_comments(source)?;
    let ire = image_re()?;
    let mut image_replacements = BTreeMap::new();
    for c in ire.captures_iter(&source) {
        let image = bind_image(parsed_image(&c)?, abi)?;
        image_replacements.insert(
            c[0].to_owned(),
            format!(
                "layout(set=0,binding={}, {}) {} {} uniform {} {};",
                image.binding,
                image.format,
                image.access.qualifier(),
                image.qualifiers.join(" "),
                image.ty,
                image.name,
            ),
        );
    }
    let source = ire.replace_all(&source, |c: &regex::Captures<'_>| {
        image_replacements[&c[0]].clone()
    });
    let ure = uniform_re()?;
    let mut replacements = BTreeMap::new();
    for c in ure.captures_iter(&source) {
        let replacement = if c[1].contains("sampler") {
            let sampler = abi
                .samplers
                .iter()
                .find(|s| s.name == c[2] && s.ty == c[1])
                .with_context(|| format!("unbound sampler {}", &c[2]))?;
            format!(
                "layout(set=0,binding={}) uniform {} {};",
                sampler.binding, sampler.ty, sampler.name
            )
        } else if c[1].contains("image") {
            c[0].to_owned()
        } else {
            String::new()
        };
        replacements.insert(c[0].to_owned(), replacement);
    }
    Ok(ure
        .replace_all(&source, |c: &regex::Captures<'_>| {
            replacements[&c[0]].clone()
        })
        .into_owned())
}
fn frame_header(abi: &Abi) -> String {
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
    header
}
fn translate_compute(source: &str, abi: &Abi) -> Result<String> {
    let source = source
        .lines()
        .filter(|line| {
            !line.trim().starts_with("#version") && !line.trim().starts_with("#extension")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut body = translate_declarations(&source, abi)?;
    for (from, to) in [
        ("texture2D", "texture"),
        ("texture2DLod", "textureLod"),
        ("texture2DLodARB", "textureLod"),
        ("sampler", "pommeSampler"),
    ] {
        body = Regex::new(&format!(r"\b{from}\b"))?
            .replace_all(&body, to)
            .into_owned();
    }
    // Compute has no vertex attributes, fragment outputs, clip-depth conversion
    // or actor alpha-test wrapper. Keep the original main and workgroup layout.
    Ok(frame_header(abi) + &body)
}
fn spirv_instructions(words: &[u32]) -> Result<Vec<(u32, &[u32])>> {
    ensure!(
        words.len() >= 5 && words[0] == 0x0723_0203,
        "invalid SPIR-V header"
    );
    let mut out = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        ensure!(
            count > 0 && count <= words.len() - at,
            "invalid SPIR-V instruction extent"
        );
        out.push((words[at] & 0xffff, &words[at + 1..at + count]));
        at += count;
    }
    Ok(out)
}
fn reflected_local_size(words: &[u32]) -> Result<[u32; 3]> {
    // Vulkan1.2 compilation of this first static-dispatch slice uses LocalSize.
    // LocalSizeId/specialization needs maintenance4 and another host contract.
    spirv_instructions(words)?
        .into_iter()
        .find_map(|(op, args)| {
            (op == 16 && args.len() == 5 && args[1] == 17).then(|| [args[2], args[3], args[4]])
        })
        .context("compute SPIR-V lacks a static LocalSize execution mode")
}
fn shared_memory_bytes(words: &[u32]) -> Result<usize> {
    let instructions = spirv_instructions(words)?;
    let mut types = BTreeMap::new();
    let mut constants = BTreeMap::new();
    let mut strides = BTreeMap::new();
    let mut offsets = BTreeMap::new();
    let mut blocks = BTreeSet::new();
    let mut pointers = Vec::new();
    for &(op, args) in &instructions {
        match op {
            20..=24 | 28..=30 | 32 if !args.is_empty() => {
                types.insert(args[0], (op, &args[1..]));
            }
            43 if args.len() >= 3 => {
                let value = u64::from(args[2]) | (args.get(3).map_or(0, |hi| u64::from(*hi)) << 32);
                constants.insert(args[1], usize::try_from(value)?);
            }
            59 if args.len() >= 3 && args[2] == 4 => pointers.push(args[0]),
            71 if args.len() >= 2 && args[1] == 2 => {
                blocks.insert(args[0]);
            }
            71 if args.len() == 3 && args[1] == 6 => {
                strides.insert(args[0], args[2] as usize);
            }
            72 if args.len() == 4 && args[2] == 35 => {
                offsets.insert((args[0], args[1] as usize), args[3] as usize);
            }
            _ => (),
        }
    }
    struct Types<'a> {
        definitions: BTreeMap<u32, (u32, &'a [u32])>,
        constants: BTreeMap<u32, usize>,
        strides: BTreeMap<u32, usize>,
        offsets: BTreeMap<(u32, usize), usize>,
    }
    impl Types<'_> {
        fn size(&self, id: u32, depth: usize) -> Result<usize> {
            ensure!(depth < 32, "recursive/deep Workgroup storage type");
            let &(op, args) = self
                .definitions
                .get(&id)
                .context("unknown Workgroup storage type")?;
            let mul =
                |a: usize, b: usize| a.checked_mul(b).context("Workgroup storage size overflow");
            Ok(match (op, args) {
                (20, []) => 4, // Vulkan treats Boolean as 32-bit for storage accounting.
                (21 | 22, [width, ..]) => {
                    ensure!(
                        *width > 0 && width % 8 == 0,
                        "unsupported Workgroup scalar width"
                    );
                    *width as usize / 8
                }
                (23 | 24, [element, count]) => {
                    mul(self.size(*element, depth + 1)?, *count as usize)?
                }
                (28, [element, length]) => {
                    let count = *self
                        .constants
                        .get(length)
                        .context("Workgroup array length requires an ordinary SPIR-V constant")?;
                    let size = self.size(*element, depth + 1)?;
                    let stride = self.strides.get(&id).copied().unwrap_or(size);
                    ensure!(
                        stride >= size,
                        "Workgroup ArrayStride smaller than element size"
                    );
                    mul(stride, count)?
                }
                (30, members) => {
                    let mut size = 0usize;
                    let explicit = members
                        .iter()
                        .enumerate()
                        .any(|(i, _)| self.offsets.contains_key(&(id, i)));
                    for (i, member) in members.iter().enumerate() {
                        let offset = if explicit {
                            *self
                                .offsets
                                .get(&(id, i))
                                .context("incomplete explicit Workgroup member offsets")?
                        } else {
                            size
                        };
                        size = size.max(
                            offset
                                .checked_add(self.size(*member, depth + 1)?)
                                .context("Workgroup storage size overflow")?,
                        );
                    }
                    size
                }
                _ => anyhow::bail!("unsupported Workgroup storage type opcode {op}"),
            })
        }
    }
    let types = Types {
        definitions: types,
        constants,
        strides,
        offsets,
    };
    let mut ordinary = 0usize;
    let mut explicit = 0usize;
    for pointer in pointers {
        let &(op, args) = types
            .definitions
            .get(&pointer)
            .context("unknown Workgroup pointer type")?;
        ensure!(
            op == 32 && args.len() == 2 && args[0] == 4,
            "invalid Workgroup pointer type"
        );
        let size = types.size(args[1], 0)?;
        if blocks.contains(&args[1]) {
            explicit = explicit.max(size);
        } else {
            ordinary = ordinary
                .checked_add(size)
                .context("Workgroup storage size overflow")?;
        }
    }
    // Implicit Workgroup layout is implementation-dependent. This is logical
    // typed storage, not assumed std140/std430 vec3 padding. Vulkan's permitted
    // std430 allocation ceiling and actual device pipeline validation are distinct:
    // https://docs.vulkan.org/spec/latest/chapters/shaders.html#shaders-scope-workgroup
    ordinary
        .checked_add(explicit)
        .context("Workgroup storage size overflow")
}

fn shape(ty: &str, count: usize) -> Result<usize> {
    let size: usize = match ty {
        "float" | "int" | "uint" | "bool" | "vec2" | "vec3" | "vec4" | "ivec2" | "ivec3"
        | "ivec4" | "uvec2" | "uvec3" | "uvec4" => 16,
        "mat2" => 32,
        "mat3" => 48,
        "mat4" => 64,
        _ => anyhow::bail!("unsupported Vulkan uniform type: {ty}"),
    };
    size.checked_mul(count)
        .context("uniform storage size overflow")
}
pub fn program_names(pack: &Pack) -> Result<Vec<String>> {
    let mut names = Vec::new();
    // Execution phases follow Iris beginHand/beginTranslucents: opaque actors,
    // solid hand, deferred, translucent world/hand, then composite and final.
    for stage in [
        "begin",
        "shadow",
        "shadow_entities",
        "shadow_block",
        "shadowcomp",
        "prepare",
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
        let compute_sources = crate::compute::discover(pack)?;
        let mut sources = Vec::new();
        let mut uniforms = BTreeMap::new();
        let mut samplers = BTreeSet::new();
        let mut images = BTreeMap::new();
        for name in names {
            let source_name = crate::stages::resolve(pack, &name)?.context("unresolved program")?;
            let vertex = pack.source(&pack.program_path(&source_name, "vsh").unwrap())?;
            let fragment = pack.source(&pack.program_path(&source_name, "fsh").unwrap())?;
            for source in [&vertex, &fragment] {
                ensure!(
                    !image_re()?.is_match(&without_comments(source)?),
                    "graphics storage images require a graphics image descriptor ABI ({name})"
                );
                collect_declarations(source, &mut uniforms, &mut samplers, &mut images)?;
            }
            sources.push((name, source_name, vertex, fragment));
        }
        for compute in &compute_sources {
            collect_declarations(&compute.source, &mut uniforms, &mut samplers, &mut images)
                .with_context(|| format!("compute declarations {}", compute.name))?;
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
            .collect::<Vec<_>>();
        let first_image_binding = u32::try_from(samplers.len())? + 1;
        let images = images
            .into_values()
            .enumerate()
            .map(|(i, mut image)| {
                image.binding = first_image_binding + i as u32;
                image
            })
            .collect();
        let abi = Abi {
            uniforms,
            samplers,
            images,
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
        let mut compute_programs = Vec::new();
        for compute in compute_sources {
            let declarations = without_comments(&compute.source)?;
            let mut program_images = BTreeMap::new();
            for declaration in image_re()?.captures_iter(&declarations) {
                let image = bind_image(parsed_image(&declaration)?, &abi)?;
                program_images.insert(image.name.clone(), image);
            }
            let source = translate_compute(&compute.source, &abi)?;
            let artifact = compiler
                .compile_into_spirv(
                    &source,
                    shaderc::ShaderKind::Compute,
                    &format!("{}.csh", compute.name),
                    "main",
                    Some(&options),
                )
                .with_context(|| format!("Vulkan compute {}", compute.name))?;
            let spirv = artifact.as_binary().to_vec();
            ensure!(
                reflected_local_size(&spirv)? == compute.local_size,
                "compute {} local size disagrees with compiled SPIR-V",
                compute.name
            );
            let active_uniforms = active_members(&spirv);
            let bindings = active_bindings(&spirv);
            let samplers = abi
                .samplers
                .iter()
                .filter(|s| bindings.contains(&s.binding))
                .cloned()
                .collect();
            let images = program_images
                .into_values()
                .filter(|image| bindings.contains(&image.binding))
                .collect();
            let shared_memory_bytes = shared_memory_bytes(&spirv)?;
            let capabilities = spirv_instructions(&spirv)?
                .into_iter()
                .filter(|(op, args)| *op == 17 && args.len() == 1)
                .map(|(_, args)| args[0])
                .collect();
            compute_programs.push(ComputeProgram {
                name: compute.name,
                base: compute.base,
                source,
                spirv,
                dispatch: compute.dispatch,
                local_size: compute.local_size,
                active_uniforms,
                samplers,
                images,
                shared_memory_bytes,
                capabilities,
            });
        }
        Ok(Self {
            abi,
            programs,
            compute_programs,
        })
    }
}
fn varying_re() -> Result<Regex> {
    Ok(Regex::new(
        r"(?m)^\s*(?:(flat|smooth|noperspective)\s+)?(varying|in|out|attribute)\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;",
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
                let count = c.get(5).map_or(Ok(1), |m| m.as_str().parse::<usize>())?;
                ensure!(count > 0, "zero-length varying {name}");
                if let Some(old) = vars.insert(name.clone(), (ty.clone(), count)) {
                    ensure!(
                        old == (ty, count),
                        "varying type/array-size mismatch {name}"
                    );
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
    let mut location = 0usize;
    let mut out = BTreeMap::new();
    for (name, (ty, count)) in vars {
        out.insert(name, location);
        location = location
            .checked_add(
                span(&ty, &structs, 0)?
                    .checked_mul(count)
                    .context("varying location span overflow")?,
            )
            .context("varying location span overflow")?;
    }
    Ok(out)
}
fn translate(
    source: &str,
    abi: &Abi,
    varyings: &BTreeMap<String, usize>,
    vertex: bool,
) -> Result<String> {
    // Match the exact native material attribute width. Vulkan supplies W=1
    // for a three-component vertex format read as vec4; actor overrides must
    // preserve that fourth component too.
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
    let mut body = translate_declarations(&source, abi)?;
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
            let array = c
                .get(5)
                .map_or(String::new(), |m| format!("[{}]", m.as_str()));
            let ty = &c[3];
            let flat = c.get(1).map_or("", |x| x.as_str());
            if vertex && (kind == "attribute" || kind == "in") {
                if let Some((_, loc)) = attrs.iter().find(|(n, _)| *n == name) {
                    format!("layout(location={loc}) in {ty} {name}{array};")
                } else {
                    format!("{flat} {kind} {ty} {name}{array};")
                }
            } else if kind == "varying" || (vertex && kind == "out") || (!vertex && kind == "in") {
                format!(
                    "layout(location={}) {flat} {} {ty} {name}{array};",
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
    let mut header = frame_header(abi);
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
            images: vec![],
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
            images: Vec::new(),
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
            images: vec![],
            uniform_size: 64,
        };
        let values = BTreeMap::from([("m".into(), Value((1..=9).map(f64::from).collect()))]);
        let bytes = abi.bytes(&values, &BTreeSet::from([0])).unwrap();
        assert_eq!(f32::from_le_bytes(bytes[16..20].try_into().unwrap()), 4.0);
        assert_eq!(&bytes[12..16], &[0; 4]);
        assert!(abi.bytes(&values, &BTreeSet::from([1])).is_err());
    }
    struct ComputeFixture(std::path::PathBuf);
    impl ComputeFixture {
        fn new(compute: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir()
                .join(format!("pomme-abi-compute-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(directory.join("shaders")).unwrap();
            for stage in [
                "gbuffers_terrain",
                "final",
                "begin",
                "shadowcomp",
                "prepare",
            ] {
                std::fs::write(
                    directory.join(format!("shaders/{stage}.vsh")),
                    "#version 330 compatibility\nvoid main(){gl_Position=ftransform();}\n",
                )
                .unwrap();
                std::fs::write(directory.join(format!("shaders/{stage}.fsh")),
                    "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nuniform float gain;\nuniform sampler2D terrainTex;\nvoid main(){gl_FragColor=texture2D(terrainTex,vec2(0.5))*gain;}\n").unwrap();
            }
            std::fs::write(directory.join("shaders/deferred_a.csh"), compute).unwrap();
            Self(directory)
        }
        fn pack(&self) -> Pack {
            Pack::load(&self.0, "world0", None, &[]).unwrap()
        }
    }
    impl Drop for ComputeFixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn compute_compiles_with_shared_graphics_abi_and_reflects_live_resources() {
        let fixture = ComputeFixture::new(concat!(
            "#version 430 compatibility\nlayout(local_size_x=8) in;\n",
            "const ivec3 workGroups=ivec3(1,1,1);\n",
            "uniform float gain; uniform float computeBias; uniform float unusedComputeInput;\n",
            "uniform sampler2D terrainTex; layout(binding=7) uniform sampler2D lookupTex;\n",
            "layout(rgba16f,binding=3) restrict writeonly uniform image2D resultImage;\n",
            "shared vec3 samples[8][9]; shared float optimizedAway[1000];\n",
            "vec4 sample_at(sampler2D sampler){return texture2D(sampler,vec2(0.5));}\n",
            "void main(){uint i=gl_LocalInvocationID.x; samples[i][0]=(sample_at(terrainTex)+sample_at(lookupTex)).rgb*gain+computeBias; barrier(); imageStore(resultImage,ivec2(gl_GlobalInvocationID.xy),vec4(samples[0][0],1));}\n",
        ));
        let pack = fixture.pack();
        let names = program_names(&pack).unwrap();
        let index = |name| names.iter().position(|n| n == name).unwrap();
        assert!(index("begin") < index("shadowcomp"));
        assert!(index("shadowcomp") < index("prepare"));
        assert!(index("prepare") < index("gbuffers_terrain"));
        let compiled = Compiled::new(&pack).unwrap();
        assert_eq!(compiled.compute_programs.len(), 1);
        assert_eq!(compiled.abi.samplers.len(), 2);
        assert_eq!(compiled.abi.images.len(), 1);
        let compute = &compiled.compute_programs[0];
        assert_eq!(compute.name, "deferred_a");
        assert_eq!(compute.base, "deferred");
        assert_eq!(compute.local_size, [8, 1, 1]);
        assert!(matches!(
            compute.dispatch,
            crate::compute::Dispatch::Fixed([1, 1, 1])
        ));
        assert_eq!(compute.samplers.len(), 2);
        assert_eq!(compute.images.len(), 1);
        let image = &compute.images[0];
        assert_eq!(image.name, "resultImage");
        assert_eq!(image.binding, 3);
        assert_eq!(image.format, "rgba16f");
        assert_eq!(image.access, ImageAccess::WriteOnly);
        assert_eq!(image.qualifiers, ["restrict"]);
        assert_eq!(compute.shared_memory_bytes, 8 * 9 * 3 * 4);
        assert_eq!(compute.capabilities, BTreeSet::from([1]));
        assert!(!compute.source.contains("pomme_main"));
        assert!(!compute.source.contains("gl_Position"));
        assert!(!compute.source.contains("pomme_FragData"));
        assert!(!compute.source.contains("texture2D("));
        let active_names: BTreeSet<_> = compute
            .active_uniforms
            .iter()
            .map(|&i| compiled.abi.uniforms[i].name.as_str())
            .collect();
        assert_eq!(active_names, BTreeSet::from(["computeBias", "gain"]));
        for program in &compiled.programs {
            assert!(
                program
                    .samplers
                    .iter()
                    .all(|sampler| sampler.name == "terrainTex")
            );
            let active_names: BTreeSet<_> = program
                .active_uniforms
                .iter()
                .map(|&i| compiled.abi.uniforms[i].name.as_str())
                .collect();
            assert!(!active_names.contains("computeBias"));
            assert!(!active_names.contains("unusedComputeInput"));
        }
    }
    #[test]
    fn compute_image_bindings_share_identity_and_preserve_each_programs_access() {
        for (producer_qualifiers, consumer_qualifiers, expected_producer, expected_consumer) in [
            ("", "", vec![], vec![]),
            (
                "coherent restrict",
                "coherent",
                vec!["coherent", "restrict"],
                vec!["coherent"],
            ),
            (
                "restrict",
                "volatile restrict",
                vec!["restrict"],
                vec!["restrict", "volatile"],
            ),
        ] {
            let fixture = ComputeFixture::new(&format!(
                "#version 430\nlayout(local_size_x=1) in;\nconst ivec3 workGroups=ivec3(1,1,1);\nlayout(rgba16f,binding=7) {producer_qualifiers} writeonly uniform image2D colorimg0;\nvoid main(){{imageStore(colorimg0,ivec2(0),vec4(0.25));}}\n"
            ));
            std::fs::write(
                fixture.0.join("shaders/deferred_b.csh"),
                format!(
                    "#version 430\nlayout(local_size_x=1) in;\nconst ivec3 workGroups=ivec3(1,1,1);\nlayout(rgba16f,binding=19) {consumer_qualifiers} readonly uniform image2D colorimg0;\nlayout(rgba16f) writeonly uniform image2D colorimg1;\nvoid main(){{imageStore(colorimg1,ivec2(0),imageLoad(colorimg0,ivec2(0)));}}\n"
                ),
            )
            .unwrap();
            let compiled = Compiled::new(&fixture.pack()).unwrap();
            assert_eq!(compiled.abi.images.len(), 2);
            let shared = compiled
                .abi
                .images
                .iter()
                .find(|image| image.name == "colorimg0")
                .unwrap();
            assert_eq!(shared.ty, "image2D");
            assert_eq!(shared.format, "rgba16f");
            assert_eq!(compiled.compute_programs.len(), 2);
            for (name, access, qualifiers) in [
                ("deferred_a", ImageAccess::WriteOnly, expected_producer),
                ("deferred_b", ImageAccess::ReadOnly, expected_consumer),
            ] {
                let program = compiled
                    .compute_programs
                    .iter()
                    .find(|program| program.name == name)
                    .unwrap();
                let image = program
                    .images
                    .iter()
                    .find(|image| image.name == "colorimg0")
                    .unwrap();
                assert_eq!(image.binding, shared.binding);
                assert_eq!(image.access, access);
                assert_eq!(image.qualifiers, qualifiers);
                // Check the compiler's actual interface decorations as well as
                // the metadata used by runtime barriers and mip invalidation.
                let instructions = spirv_instructions(&program.spirv).unwrap();
                let id = instructions
                    .iter()
                    .find(|(op, args)| {
                        *op == 71 && args.len() == 3 && args[1] == 33 && args[2] == shared.binding
                    })
                    .unwrap()
                    .1[0];
                let decorations: BTreeSet<_> = instructions
                    .iter()
                    .filter(|(op, args)| *op == 71 && args.len() >= 2 && args[0] == id)
                    .map(|(_, args)| args[1])
                    .collect();
                assert_eq!(decorations.contains(&24), access == ImageAccess::ReadOnly);
                assert_eq!(decorations.contains(&25), access == ImageAccess::WriteOnly);
                for (qualifier, decoration) in
                    [("coherent", 23), ("restrict", 19), ("volatile", 21)]
                {
                    // GLSL volatile accesses are also coherent; shaderc emits
                    // both SPIR-V decorations without adding a source qualifier.
                    let expected = image.qualifiers.iter().any(|q| q == qualifier)
                        || (qualifier == "coherent"
                            && image.qualifiers.iter().any(|q| q == "volatile"));
                    assert_eq!(
                        decorations.contains(&decoration),
                        expected,
                        "{name}: {qualifier}"
                    );
                }
            }
        }
    }
    #[test]
    fn storage_declarations_reject_unsupported_or_conflicting_abis() {
        for source in [
            "uniform image2D unformatted;",
            "layout(rgba16f) uniform image3D volume;",
            "layout(rgba16f) uniform image2D images[2];",
            "layout(rgba16f) uniform iimage2D wrongNumericType;",
            "layout(rgba16f) readonly writeonly uniform image2D invalidAccess;",
            "layout(std430) buffer Payload { uint words[]; };",
            "uniform atomic_uint counter;",
        ] {
            let error = collect_declarations(
                source,
                &mut BTreeMap::new(),
                &mut BTreeSet::new(),
                &mut BTreeMap::new(),
            );
            assert!(error.is_err(), "accepted unsupported source: {source}");
        }
        let mut images = BTreeMap::new();
        collect_declarations(
            "layout(rgba16f) writeonly uniform image2D result;",
            &mut BTreeMap::new(),
            &mut BTreeSet::new(),
            &mut images,
        )
        .unwrap();
        assert!(
            collect_declarations(
                "layout(rgba32f) writeonly uniform image2D result;",
                &mut BTreeMap::new(),
                &mut BTreeSet::new(),
                &mut images
            )
            .is_err()
        );
        assert_eq!(images["result"].format, "rgba16f");
        assert!(
            collect_declarations(
                "layout(rgba16ui) readonly uniform uimage2D result;",
                &mut BTreeMap::new(),
                &mut BTreeSet::new(),
                &mut images
            )
            .is_err()
        );
        let mut uniforms = BTreeMap::new();
        collect_declarations(
            "uniform vec3 sharedInput;",
            &mut uniforms,
            &mut BTreeSet::new(),
            &mut BTreeMap::new(),
        )
        .unwrap();
        assert!(
            collect_declarations(
                "uniform vec2 sharedInput;",
                &mut uniforms,
                &mut BTreeSet::new(),
                &mut BTreeMap::new()
            )
            .is_err()
        );
    }
    #[test]
    fn integer_storage_images_preserve_access_and_memory_qualifiers() {
        let source = "layout(rgba32ui) uniform coherent readonly uimage2D counters;";
        let mut images = BTreeMap::new();
        collect_declarations(
            source,
            &mut BTreeMap::new(),
            &mut BTreeSet::new(),
            &mut images,
        )
        .unwrap();
        let abi = Abi {
            uniforms: vec![],
            samplers: vec![],
            images: images.into_values().collect(),
            uniform_size: 0,
        };
        let declaration = image_re().unwrap();
        let image = bind_image(
            parsed_image(&declaration.captures(source).unwrap()).unwrap(),
            &abi,
        )
        .unwrap();
        assert_eq!(image.ty, "uimage2D");
        assert_eq!(image.access, ImageAccess::ReadOnly);
        assert_eq!(image.qualifiers, ["coherent"]);
    }
    /// Runs original caller-selected pack sources, with no generated compute
    /// replacement. External packs stay outside the repository and
    /// distribution.
    #[test]
    #[ignore = "set POMME_TEST_SHADER_PACK and optional POMME_TEST_SHADER_PROFILE"]
    fn compile_external_compute_pack_without_source_substitution() {
        let path =
            std::env::var_os("POMME_TEST_SHADER_PACK").expect("POMME_TEST_SHADER_PACK is required");
        let profile = std::env::var("POMME_TEST_SHADER_PROFILE").ok();
        let pack = Pack::load(
            std::path::Path::new(&path),
            "world0",
            profile.as_deref(),
            &[],
        )
        .unwrap();
        let compiled = Compiled::new(&pack).unwrap();
        assert!(!compiled.compute_programs.is_empty());
        for program in &compiled.compute_programs {
            if let Some(directory) = std::env::var_os("POMME_TEST_SPIRV_DIRECTORY") {
                let directory = std::path::PathBuf::from(directory);
                std::fs::create_dir_all(&directory).unwrap();
                let bytes: Vec<_> = program
                    .spirv
                    .iter()
                    .flat_map(|word| word.to_le_bytes())
                    .collect();
                std::fs::write(directory.join(format!("{}.spv", program.name)), bytes).unwrap();
                std::fs::write(
                    directory.join(format!("{}.csh", program.name)),
                    &program.source,
                )
                .unwrap();
            }
            eprintln!(
                "compute {}: local={:?}, shared logical={} bytes, capabilities={:?}, samplers={:?}, images={:?}",
                program.name,
                program.local_size,
                program.shared_memory_bytes,
                program.capabilities,
                program.samplers.iter().map(|s| &s.name).collect::<Vec<_>>(),
                program.images
            );
        }
    }
    #[test]
    fn varying_arrays_reserve_each_matrix_and_structure_location() {
        let declarations = "struct Packet { mat3 basis; vec2 pair[2]; };\nflat out Packet alpha[2];\nflat out mat2 beta[3];\nflat out vec3 sky[9];\nout vec2 z;\n";
        let vertex = format!(
            "#version 330 compatibility\n{declarations}void main(){{gl_Position=vec4(0,0,0,1);}}\n"
        );
        let fragment = declarations
            .replace(" out ", " in ")
            .replace("\nout ", "\nin ");
        let locations = varying_locations(&vertex, &fragment).unwrap();
        assert_eq!(
            locations,
            BTreeMap::from([
                ("alpha".into(), 0),
                ("beta".into(), 10),
                ("sky".into(), 16),
                ("z".into(), 25)
            ])
        );
        let abi = Abi {
            uniforms: vec![Uniform {
                name: "unused".into(),
                ty: "float".into(),
                count: 1,
                offset: 0,
                size: 16,
            }],
            samplers: vec![],
            images: vec![],
            uniform_size: 16,
        };
        let translated = translate(&vertex, &abi, &locations, true).unwrap();
        assert!(translated.contains("layout(location=16) flat out vec3 sky[9];"));
        let compiler = shaderc::Compiler::new().unwrap();
        let mut options = shaderc::CompileOptions::new().unwrap();
        options.set_target_env(
            shaderc::TargetEnv::Vulkan,
            shaderc::EnvVersion::Vulkan1_2 as u32,
        );
        compiler
            .compile_into_spirv(
                &translated,
                shaderc::ShaderKind::Vertex,
                "arrays.vsh",
                "main",
                Some(&options),
            )
            .unwrap();
        assert!(varying_locations("flat out vec3 value[9];", "flat in vec3 value[8];").is_err());
    }
    #[test]
    fn graphics_storage_images_are_rejected_before_shader_compilation() {
        let fixture = ComputeFixture::new(
            "#version 430\nlayout(local_size_x=1) in; const ivec3 workGroups=ivec3(0,1,1); void main(){}\n",
        );
        std::fs::write(fixture.0.join("shaders/final.fsh"),
            "#version 430\nlayout(rgba16f) writeonly uniform image2D colorimg0; out vec4 color; void main(){color=vec4(1);imageStore(colorimg0,ivec2(0),color);}").unwrap();
        let error = match Compiled::new(&fixture.pack()) {
            Ok(_) => panic!("graphics image ABI silently accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("graphics storage images"));
    }
}
