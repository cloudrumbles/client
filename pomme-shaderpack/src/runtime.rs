use std::collections::{BTreeMap, HashMap};
use std::ffi::{CStr, CString};
use std::mem::{offset_of, size_of};
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Vec3};
use regex::Regex;
use serde::Serialize;

use crate::expression::{Uniforms, Value};
use crate::gl;
use crate::pack::Pack;
use crate::scene::{Scene, Vertex};

#[derive(Serialize)]
pub struct Capabilities {
    pub vendor: String,
    pub renderer: String,
    pub version: String,
    pub glsl: String,
    pub max_texture_size: i32,
    pub max_draw_buffers: i32,
    pub max_texture_units: i32,
    pub max_compute_shared_memory: i32,
    pub nv_mesh_shader: bool,
    pub nv_vertex_buffer_unified_memory: bool,
    pub nv_representative_fragment_test: bool,
    pub nvidium_missing_extensions: Vec<String>,
    pub extensions: Vec<String>,
}
impl Capabilities {
    pub fn query(g: &gl::Gl) -> Self {
        unsafe {
            let string = |key| {
                CStr::from_ptr(g.GetString(key).cast())
                    .to_string_lossy()
                    .into_owned()
            };
            let integer = |key| {
                let mut v = 0;
                g.GetIntegerv(key, &mut v);
                v
            };
            let extensions = (0..integer(gl::NUM_EXTENSIONS))
                .map(|i| {
                    CStr::from_ptr(g.GetStringi(gl::EXTENSIONS, i as u32).cast())
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<String>>();
            Self {
                vendor: string(gl::VENDOR),
                renderer: string(gl::RENDERER),
                version: string(gl::VERSION),
                glsl: string(gl::SHADING_LANGUAGE_VERSION),
                max_texture_size: integer(gl::MAX_TEXTURE_SIZE),
                max_draw_buffers: integer(gl::MAX_DRAW_BUFFERS),
                max_texture_units: integer(gl::MAX_COMBINED_TEXTURE_IMAGE_UNITS),
                max_compute_shared_memory: integer(gl::MAX_COMPUTE_SHARED_MEMORY_SIZE),
                nv_mesh_shader: extensions.iter().any(|e| e == "GL_NV_mesh_shader"),
                nv_vertex_buffer_unified_memory: extensions
                    .iter()
                    .any(|e| e == "GL_NV_vertex_buffer_unified_memory"),
                nv_representative_fragment_test: extensions
                    .iter()
                    .any(|e| e == "GL_NV_representative_fragment_test"),
                nvidium_missing_extensions: [
                    "GL_NV_mesh_shader",
                    "GL_NV_uniform_buffer_unified_memory",
                    "GL_NV_vertex_buffer_unified_memory",
                    "GL_NV_representative_fragment_test",
                    "GL_ARB_sparse_buffer",
                    "GL_NV_bindless_multi_draw_indirect",
                ]
                .into_iter()
                .filter(|required| !extensions.iter().any(|e| e == required))
                .map(String::from)
                .collect(),
                extensions,
            }
        }
    }
}
#[derive(Clone, Copy)]
struct Texture {
    id: u32,
    target: u32,
    width: u32,
    height: u32,
    format: u32,
}
struct ColorBuffer {
    textures: [Texture; 2],
    front: usize,
    clear: bool,
    clear_color: [f32; 4],
}
struct Binding {
    name: String,
    location: i32,
    ty: u32,
}
struct Pass {
    gl: gl::Gl,
    name: String,
    id: u32,
    targets: Vec<usize>,
    bindings: Vec<Binding>,
    mipmaps: Vec<usize>,
    compute: Option<[u32; 3]>,
    blends: Vec<Option<[u32; 4]>>,
    attributes: [i32; 3],
}
impl Drop for Pass {
    fn drop(&mut self) {
        unsafe {
            self.gl.DeleteProgram(self.id);
        }
    }
}
struct ProgramGuard<'a> {
    gl: &'a gl::Gl,
    id: u32,
}
impl Drop for ProgramGuard<'_> {
    fn drop(&mut self) {
        if self.id != 0 {
            unsafe {
                self.gl.DeleteProgram(self.id);
            }
        }
    }
}
// Cleans up partially constructed/reloaded packs as well as successful ones.
struct PendingResources {
    gl: gl::Gl,
    textures: Vec<Texture>,
    vbos: Vec<u32>,
    fbo: u32,
}
impl Drop for PendingResources {
    fn drop(&mut self) {
        unsafe {
            for t in &self.textures {
                self.gl.DeleteTextures(1, &t.id);
            }
            self.gl
                .DeleteBuffers(self.vbos.len() as i32, self.vbos.as_ptr());
            self.gl.DeleteFramebuffers(1, &self.fbo);
        }
    }
}
#[derive(Serialize, Clone)]
pub struct PassTiming {
    pub pass: String,
    pub gpu_ms: f64,
    pub cpu_submit_ms: f64,
}
#[derive(Clone)]
pub struct FrameInput {
    pub camera: Vec3,
    pub target: Vec3,
    pub up: Vec3,
    pub world_time: i32,
    pub world_day: i32,
    pub rain: f32,
    pub wetness: f32,
    pub frame: u32,
    pub seconds: f32,
    pub delta_seconds: f32,
    /// World/history identity. Content edits keep this epoch; replacing the
    /// world or explicitly restarting temporal state advances it.
    pub history_epoch: u64,
    /// Content revisions refresh geometry/lighting without clearing pack-owned
    /// temporal targets or custom-uniform smoothing.
    pub world_revision: u64,
    pub lighting_revision: u64,
    /// Atlas/UV/material resource identity, rather than animated texel content.
    pub material_revision: u64,
    pub fov_degrees: f32,
    pub view_effect: Mat4,
    pub near: f32,
    pub far: f32,
    pub eye_in_water: bool,
    pub eye_brightness: [f32; 2],
    pub temperature: f32,
    pub rainfall: f32,
}
impl FrameInput {
    pub fn fixture(scene: &Scene, frame: u32, time: i32, rain: f32) -> Self {
        Self {
            camera: scene.camera,
            target: scene.target,
            up: Vec3::Y,
            world_time: time,
            world_day: 0,
            rain,
            wetness: rain,
            frame,
            seconds: frame as f32 / 60.0,
            delta_seconds: 1.0 / 60.0,
            history_epoch: 0,
            world_revision: 0,
            lighting_revision: 0,
            material_revision: 0,
            fov_degrees: 70.0,
            view_effect: Mat4::IDENTITY,
            near: 0.05,
            far: 256.0,
            eye_in_water: false,
            eye_brightness: [0.0, 240.0],
            temperature: 0.8,
            rainfall: 0.4,
        }
    }
}
pub(crate) fn history_discontinuity(previous: Option<&FrameInput>, input: &FrameInput) -> bool {
    previous.is_none_or(|p| {
        let previous_direction = (p.target - p.camera).normalize_or_zero();
        let direction = (input.target - input.camera).normalize_or_zero();
        p.history_epoch != input.history_epoch
            || p.material_revision != input.material_revision
            || p.camera.distance(input.camera) > 8.0
            || previous_direction.dot(direction) < 0.5
            || p.near != input.near
            || p.fov_degrees != input.fov_degrees
            || p.far != input.far
            || p.eye_in_water != input.eye_in_water
    })
}
pub struct Runtime {
    gl: gl::Gl,
    pub pack: Pack,
    pub capabilities: Capabilities,
    width: u32,
    height: u32,
    passes: Vec<Pass>,
    colors: Vec<ColorBuffer>,
    depths: [Texture; 3],
    shadows: [Texture; 2],
    shadow_colors: [Texture; 2],
    custom: HashMap<String, Texture>,
    owned: Vec<Texture>,
    fbo: u32,
    uniforms: Uniforms,
    atlas: Texture,
    normals: Texture,
    specular: Texture,
    noise: Texture,
    solid_vbo: u32,
    water_vbo: u32,
    solid_count: i32,
    water_count: i32,
    previous: Option<FrameInput>,
    previous_view: Mat4,
    previous_projection: Mat4,
    pub invalidations: u32,
}

fn format(name: &str) -> Result<(u32, u32, u32)> {
    Ok(match name {
        "RGBA8" => (gl::RGBA8, gl::RGBA, gl::UNSIGNED_BYTE),
        "RGB8" => (gl::RGB8, gl::RGB, gl::UNSIGNED_BYTE),
        "RGBA16" => (gl::RGBA16, gl::RGBA, gl::UNSIGNED_SHORT),
        "RGBA16F" => (gl::RGBA16F, gl::RGBA, gl::HALF_FLOAT),
        "RGB16F" => (gl::RGB16F, gl::RGB, gl::HALF_FLOAT),
        "RG16F" => (gl::RG16F, gl::RG, gl::HALF_FLOAT),
        "R16F" => (gl::R16F, gl::RED, gl::HALF_FLOAT),
        "R32F" => (gl::R32F, gl::RED, gl::FLOAT),
        "R11F_G11F_B10F" => (gl::R11F_G11F_B10F, gl::RGB, gl::FLOAT),
        "R8" => (gl::R8, gl::RED, gl::UNSIGNED_BYTE),
        _ => bail!("unsupported texture format {name}"),
    })
}
#[allow(clippy::too_many_arguments)] // Mirrors the OpenGL texture storage contract.
fn texture(
    g: &gl::Gl,
    width: u32,
    height: u32,
    format: u32,
    external: u32,
    ty: u32,
    data: Option<&[u8]>,
    repeat: bool,
) -> Texture {
    unsafe {
        let mut id = 0;
        g.GenTextures(1, &mut id);
        g.BindTexture(gl::TEXTURE_2D, id);
        g.TexImage2D(
            gl::TEXTURE_2D,
            0,
            format as i32,
            width as i32,
            height as i32,
            0,
            external,
            ty,
            data.map(|d| d.as_ptr().cast()).unwrap_or(std::ptr::null()),
        );
        g.TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::NEAREST as i32);
        g.TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::NEAREST as i32);
        for p in [gl::TEXTURE_WRAP_S, gl::TEXTURE_WRAP_T] {
            g.TexParameteri(
                gl::TEXTURE_2D,
                p,
                if repeat {
                    gl::REPEAT
                } else {
                    gl::CLAMP_TO_EDGE
                } as i32,
            );
        }
        Texture {
            id,
            target: gl::TEXTURE_2D,
            width,
            height,
            format,
        }
    }
}
fn compile(g: &gl::Gl, pack: &Pack, name: &str, ext: &str, ty: u32) -> Result<(u32, String)> {
    unsafe {
        let path = pack
            .program_path(name, ext)
            .with_context(|| format!("missing {name}.{ext}"))?;
        let source = pack.source(&path)?;
        let c = CString::new(source.clone())?;
        let id = g.CreateShader(ty);
        g.ShaderSource(id, 1, &c.as_ptr(), std::ptr::null());
        g.CompileShader(id);
        let mut ok = 0;
        g.GetShaderiv(id, gl::COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let mut size = 0;
            g.GetShaderiv(id, gl::INFO_LOG_LENGTH, &mut size);
            let mut log = vec![0; size.max(1) as usize];
            g.GetShaderInfoLog(id, size, std::ptr::null_mut(), log.as_mut_ptr().cast());
            g.DeleteShader(id);
            std::fs::write(
                std::env::temp_dir().join(format!("pomme-{name}.{ext}")),
                &source,
            )
            .ok();
            bail!(
                "{path}: {} (expanded source in temporary directory)",
                String::from_utf8_lossy(&log)
            );
        }
        Ok((id, source))
    }
}
fn blend_mode(value: &str) -> Result<Option<[u32; 4]>> {
    if value == "off" {
        return Ok(None);
    }
    let factor = |name| {
        Ok(match name {
            "ZERO" => gl::ZERO,
            "ONE" => gl::ONE,
            "SRC_COLOR" => gl::SRC_COLOR,
            "ONE_MINUS_SRC_COLOR" => gl::ONE_MINUS_SRC_COLOR,
            "DST_COLOR" => gl::DST_COLOR,
            "ONE_MINUS_DST_COLOR" => gl::ONE_MINUS_DST_COLOR,
            "SRC_ALPHA" => gl::SRC_ALPHA,
            "ONE_MINUS_SRC_ALPHA" => gl::ONE_MINUS_SRC_ALPHA,
            "DST_ALPHA" => gl::DST_ALPHA,
            "ONE_MINUS_DST_ALPHA" => gl::ONE_MINUS_DST_ALPHA,
            "SRC_ALPHA_SATURATE" => gl::SRC_ALPHA_SATURATE,
            _ => bail!("unsupported blend factor {name}"),
        })
    };
    let factors = value
        .split_whitespace()
        .map(factor)
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        factors.len() == 2 || factors.len() == 4,
        "blend needs two or four factors"
    );
    Ok(Some([
        factors[0],
        factors[1],
        factors[factors.len() - 2],
        factors[factors.len() - 1],
    ]))
}
fn program(g: &gl::Gl, pack: &Pack, name: &str, compute: bool) -> Result<Pass> {
    unsafe {
        let stages = if compute {
            vec![("csh", gl::COMPUTE_SHADER)]
        } else {
            vec![("vsh", gl::VERTEX_SHADER), ("fsh", gl::FRAGMENT_SHADER)]
        };
        let id = g.CreateProgram();
        let mut guard = ProgramGuard { gl: g, id };
        let mut sources = String::new();
        for (ext, ty) in stages {
            let (s, text) = compile(g, pack, name, ext, ty)?;
            g.AttachShader(id, s);
            g.DeleteShader(s);
            sources.push_str(&text);
        }
        // Compatibility built-ins occupy conventional attribute slots (vertex
        // 0, normal 2, color 3, UV 8/9). Keep pack attributes out of those slots.
        for (name, location) in [
            ("mc_Entity", 10),
            ("mc_midTexCoord", 11),
            ("at_tangent", 12),
            ("at_midBlock", 13),
        ] {
            g.BindAttribLocation(id, location, CString::new(name)?.as_ptr());
        }
        g.LinkProgram(id);
        let mut ok = 0;
        g.GetProgramiv(id, gl::LINK_STATUS, &mut ok);
        if ok == 0 {
            let mut size = 0;
            g.GetProgramiv(id, gl::INFO_LOG_LENGTH, &mut size);
            let mut log = vec![0; size.max(1) as usize];
            g.GetProgramInfoLog(id, size, std::ptr::null_mut(), log.as_mut_ptr().cast());
            bail!("{name} linking: {}", String::from_utf8_lossy(&log))
        }
        let targets = crate::pack::render_targets(&sources)?;
        ensure!(
            targets.iter().all(|i| *i < 16),
            "unsupported target above colortex15"
        );
        let mut count = 0;
        g.GetProgramiv(id, gl::ACTIVE_UNIFORMS, &mut count);
        let mut bindings = Vec::new();
        for i in 0..count {
            let mut namebuf = vec![0u8; 256];
            let mut len = 0;
            let mut size = 0;
            let mut ty = 0;
            g.GetActiveUniform(
                id,
                i as u32,
                256,
                &mut len,
                &mut size,
                &mut ty,
                namebuf.as_mut_ptr().cast(),
            );
            let name = String::from_utf8(namebuf[..len as usize].to_vec())?;
            if name.starts_with("gl_") {
                continue;
            }
            ensure!(size == 1, "uniform array unsupported: {name}");
            let c = CString::new(name.clone())?;
            bindings.push(Binding {
                name,
                location: g.GetUniformLocation(id, c.as_ptr()),
                ty,
            });
        }
        let mipmaps = Regex::new(r"const\s+bool\s+colortex(\d+)MipmapEnabled\s*=\s*true")?
            .captures_iter(&sources)
            .map(|c| c[1].parse())
            .collect::<std::result::Result<Vec<usize>, _>>()?;
        let compute = if compute {
            let c = Regex::new(
                r"const\s+ivec3\s+workGroups\s*=\s*ivec3\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)",
            )?
            .captures(&sources)
            .context("compute shader requires explicit workGroups")?;
            Some([c[1].parse()?, c[2].parse()?, c[3].parse()?])
        } else {
            None
        };
        let mut blends = Vec::new();
        for target in &targets {
            let setting = pack
                .properties
                .get(&format!("blend.{name}.colortex{target}"))
                .or_else(|| pack.properties.get(&format!("blend.{name}")));
            blends.push(setting.map(|s| blend_mode(s)).transpose()?.flatten());
        }
        let attributes = ["at_tangent", "mc_Entity", "mc_midTexCoord"]
            .map(|name| g.GetAttribLocation(id, CString::new(name).unwrap().as_ptr()));
        eprintln!("linked {name}");
        guard.id = 0;
        Ok(Pass {
            gl: g.clone(),
            name: name.into(),
            id,
            targets,
            bindings,
            mipmaps,
            compute,
            blends,
            attributes,
        })
    }
}
impl Runtime {
    pub fn gl_dispatch(&self) -> gl::Gl {
        self.gl.clone()
    }
    pub fn new(
        g: gl::Gl,
        pack: Pack,
        width: u32,
        height: u32,
        scene: &Scene,
        atlas_path: Option<&Path>,
    ) -> Result<Self> {
        unsafe {
            let caps = Capabilities::query(&g);
            eprintln!("OpenGL: {} ({})", caps.renderer, caps.version);
            ensure!(
                width > 0
                    && height > 0
                    && width <= caps.max_texture_size as u32
                    && height <= caps.max_texture_size as u32,
                "invalid render size"
            );
            ensure!(
                !pack
                    .properties
                    .keys()
                    .any(|s| s.starts_with("image.") || s.starts_with("bufferObject.")),
                "custom images/SSBOs are not supported yet; choose a profile without these features"
            );
            let mut passes = Vec::new();
            let mut add = |name: &str, compute: bool| -> Result<()> {
                if pack.enabled(name)?
                    && pack
                        .program_path(name, if compute { "csh" } else { "fsh" })
                        .is_some()
                {
                    passes.push(program(&g, &pack, name, compute)?)
                }
                Ok(())
            };
            for stage in ["begin", "prepare"] {
                for i in 0..100 {
                    let name = if i == 0 {
                        stage.into()
                    } else {
                        format!("{stage}{i}")
                    };
                    add(&name, false)?;
                    for suffix in ["", "_a", "_b", "_c"] {
                        add(&format!("{name}{suffix}"), true)?;
                    }
                }
            }
            add("shadow", false)?;
            add("shadowcomp", false)?;
            add("shadowcomp", true)?;
            add("gbuffers_terrain", false)?;
            for i in 0..100 {
                let name = if i == 0 {
                    "deferred".into()
                } else {
                    format!("deferred{i}")
                };
                add(&name, false)?;
                for suffix in ["", "_a", "_b", "_c"] {
                    add(&format!("{name}{suffix}"), true)?;
                }
            }
            add("gbuffers_water", false)?;
            for i in 0..100 {
                let name = if i == 0 {
                    "composite".into()
                } else {
                    format!("composite{i}")
                };
                add(&name, false)?;
                for suffix in ["", "_a", "_b", "_c"] {
                    add(&format!("{name}{suffix}"), true)?;
                }
            }
            add("final", false)?;
            ensure!(
                passes.iter().any(|p| p.name == "final")
                    && passes.iter().any(|p| p.name == "gbuffers_terrain"),
                "pack must provide final and gbuffers_terrain"
            );
            let all = pack
                .files
                .iter()
                .filter(|(n, _)| n.ends_with(".glsl") || n.ends_with(".fsh"))
                .map(|(_, b)| String::from_utf8_lossy(b))
                .collect::<Vec<_>>()
                .join("\n");
            let mut pending = PendingResources {
                gl: g.clone(),
                textures: Vec::new(),
                vbos: Vec::new(),
                fbo: 0,
            };
            let mut fbo = 0;
            g.GenFramebuffers(1, &mut fbo);
            pending.fbo = fbo;
            g.BindFramebuffer(gl::FRAMEBUFFER, fbo);

            let mut colors = Vec::new();
            for i in 0..16 {
                let re = Regex::new(&format!(r"const\s+int\s+colortex{i}Format\s*=\s*(\w+)"))?;
                let fmt = re
                    .captures(&all)
                    .map(|c| c[1].to_owned())
                    .unwrap_or_else(|| "RGBA8".into());
                let (internal, external, ty) = format(&fmt)?;
                let mut size = [width, height];
                if let Some(value) = pack.properties.get(&format!("size.buffer.colortex{i}")) {
                    let parts = value.split_whitespace().collect::<Vec<_>>();
                    ensure!(parts.len() == 2, "invalid buffer size");
                    for j in 0..2 {
                        let n: f64 = parts[j].parse()?;
                        size[j] = if parts[j].contains('.') {
                            (n * size[j] as f64) as u32
                        } else {
                            n as u32
                        };
                        ensure!(
                            size[j] > 0 && size[j] <= caps.max_texture_size as u32,
                            "buffer size exceeds limits"
                        );
                    }
                }
                let textures = [
                    texture(&g, size[0], size[1], internal, external, ty, None, false),
                    texture(&g, size[0], size[1], internal, external, ty, None, false),
                ];
                pending.textures.extend(textures);
                let clear = Regex::new(&format!(r"const\s+bool\s+colortex{i}Clear\s*=\s*false"))?
                    .find(&all)
                    .is_none();
                let mut clear_color = [0.0; 4];
                if let Some(c) = Regex::new(&format!(
                    r"const\s+vec4\s+colortex{i}ClearColor\s*=\s*vec4\(([^)]+)\)"
                ))?
                .captures(&all)
                {
                    let parts = c[1].split(',').map(str::trim).collect::<Vec<_>>();
                    ensure!(parts.len() == 1 || parts.len() == 4, "invalid clear color");
                    for j in 0..4 {
                        clear_color[j] = parts[j % parts.len()].parse()?;
                    }
                }
                colors.push(ColorBuffer {
                    textures,
                    front: 0,
                    clear,
                    clear_color,
                });
            }
            let depths = std::array::from_fn(|_| {
                texture(
                    &g,
                    width,
                    height,
                    gl::DEPTH_COMPONENT32F,
                    gl::DEPTH_COMPONENT,
                    gl::FLOAT,
                    None,
                    false,
                )
            });
            pending.textures.extend(depths);
            let mut shadow_size = 1024u32;
            if let Some(value) = pack.options.get("shadowMapResolution") {
                shadow_size = value.parse()?;
            } else if let Some(c) =
                Regex::new(r"const\s+int\s+shadowMapResolution\s*=\s*(\d+)")?.captures(&all)
            {
                shadow_size = c[1].parse()?;
            }
            ensure!(
                shadow_size <= caps.max_texture_size as u32,
                "shadow map exceeds device limits"
            );
            let shadows = std::array::from_fn(|_| {
                texture(
                    &g,
                    shadow_size,
                    shadow_size,
                    gl::DEPTH_COMPONENT32F,
                    gl::DEPTH_COMPONENT,
                    gl::FLOAT,
                    None,
                    false,
                )
            });
            pending.textures.extend(shadows);
            let shadow_colors = std::array::from_fn(|_| {
                texture(
                    &g,
                    shadow_size,
                    shadow_size,
                    gl::RGBA16F,
                    gl::RGBA,
                    gl::FLOAT,
                    None,
                    false,
                )
            });
            pending.textures.extend(shadow_colors);
            let mut custom = HashMap::new();
            for (key, value) in &pack.properties {
                if !key.starts_with("texture.") || key == "texture.noise" {
                    continue;
                }
                let tex = load_custom(&g, &pack, value)?;
                pending.textures.push(tex);
                custom.insert(key[8..].into(), tex);
            }
            let noise = if let Some(path) = pack.properties.get("texture.noise") {
                load_custom(&g, &pack, path)?
            } else {
                texture(
                    &g,
                    1,
                    1,
                    gl::RGBA8,
                    gl::RGBA,
                    gl::UNSIGNED_BYTE,
                    Some(&[127, 127, 127, 255]),
                    true,
                )
            };
            pending.textures.push(noise);
            let atlas = if let Some(path) = atlas_path {
                let image = image::open(path)?.to_rgba8();
                texture(
                    &g,
                    image.width(),
                    image.height(),
                    gl::RGBA8,
                    gl::RGBA,
                    gl::UNSIGNED_BYTE,
                    Some(image.as_raw()),
                    true,
                )
            } else {
                texture(
                    &g,
                    4,
                    1,
                    gl::RGBA8,
                    gl::RGBA,
                    gl::UNSIGNED_BYTE,
                    Some(&[
                        100, 160, 70, 255, 128, 128, 128, 255, 90, 140, 50, 255, 80, 130, 190, 255,
                    ]),
                    true,
                )
            };
            pending.textures.push(atlas);
            let normals = texture(
                &g,
                1,
                1,
                gl::RGBA8,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                Some(&[128, 128, 255, 255]),
                true,
            );
            pending.textures.push(normals);
            let specular = texture(
                &g,
                1,
                1,
                gl::RGBA8,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                Some(&[0, 0, 0, 255]),
                true,
            );
            pending.textures.push(specular);
            let upload = |vertices: &[Vertex]| {
                let mut vbo = 0;
                g.GenBuffers(1, &mut vbo);
                g.BindBuffer(gl::ARRAY_BUFFER, vbo);
                g.BufferData(
                    gl::ARRAY_BUFFER,
                    std::mem::size_of_val(vertices) as isize,
                    vertices.as_ptr().cast(),
                    gl::STATIC_DRAW,
                );
                vbo
            };
            ensure!(
                scene.solid.len() <= i32::MAX as usize && scene.water.len() <= i32::MAX as usize,
                "too many scene vertices"
            );
            let solid_vbo = upload(&scene.mapped_vertices(&pack, false));
            pending.vbos.push(solid_vbo);
            let water_vbo = upload(&scene.mapped_vertices(&pack, true));
            pending.vbos.push(water_vbo);
            let uniforms = Uniforms::new(&pack.properties)?;
            let mut runtime = Self {
                gl: g,
                pack,
                capabilities: caps,
                width,
                height,
                passes,
                colors,
                depths,
                shadows,
                shadow_colors,
                custom,
                owned: std::mem::take(&mut pending.textures),
                fbo,
                uniforms,
                atlas,
                normals,
                specular,
                noise,
                solid_vbo,
                water_vbo,
                solid_count: scene.solid.len() as i32,
                water_count: scene.water.len() as i32,
                previous: None,
                previous_view: Mat4::IDENTITY,
                previous_projection: Mat4::IDENTITY,
                invalidations: 0,
            };
            pending.vbos.clear();
            pending.fbo = 0;
            runtime.clear_all()?;
            runtime.check("initialization")?;
            Ok(runtime)
        }
    }
    /// The caller supplies the world revision in FrameInput after changing
    /// geometry. Replaces static vertex data only when chunks change, never
    /// for camera motion.
    pub fn replace_atlas(&mut self, size: [u32; 2], pixels: &[u8]) -> Result<()> {
        ensure!(
            size.into_iter()
                .all(|s| s > 0 && s <= self.capabilities.max_texture_size as u32),
            "invalid atlas size"
        );
        ensure!(
            pixels.len() == size[0] as usize * size[1] as usize * 4,
            "invalid atlas pixel count"
        );
        let next = texture(
            &self.gl,
            size[0],
            size[1],
            gl::RGBA8,
            gl::RGBA,
            gl::UNSIGNED_BYTE,
            Some(pixels),
            false,
        );
        if let Some(old) = self.owned.iter_mut().find(|t| t.id == self.atlas.id) {
            *old = next;
        }
        unsafe {
            self.gl.DeleteTextures(1, &self.atlas.id);
        }
        self.atlas = next;
        self.previous = None;
        self.check("atlas replacement")
    }
    pub fn replace_geometry(&mut self, scene: &Scene) -> Result<()> {
        ensure!(
            scene.solid.len() <= i32::MAX as usize && scene.water.len() <= i32::MAX as usize,
            "too many scene vertices"
        );
        unsafe {
            for (vbo, vertices) in [
                (self.solid_vbo, scene.mapped_vertices(&self.pack, false)),
                (self.water_vbo, scene.mapped_vertices(&self.pack, true)),
            ] {
                self.gl.BindBuffer(gl::ARRAY_BUFFER, vbo);
                self.gl.BufferData(
                    gl::ARRAY_BUFFER,
                    std::mem::size_of_val(vertices.as_slice()) as isize,
                    vertices.as_ptr().cast(),
                    gl::STATIC_DRAW,
                );
            }
        }
        self.solid_count = scene.solid.len() as i32;
        self.water_count = scene.water.len() as i32;
        // Current geometry/depth changes immediately. The pack owns rejection
        // of edited/disoccluded pixels in retained temporal targets.
        self.check("geometry replacement")
    }
    pub fn pass_names(&self) -> Vec<String> {
        self.passes.iter().map(|p| p.name.clone()).collect()
    }
    fn check(&self, where_: &str) -> Result<()> {
        let error = unsafe { self.gl.GetError() };
        ensure!(
            error == gl::NO_ERROR,
            "OpenGL error 0x{error:x} during {where_}"
        );
        Ok(())
    }
    fn attach(&self, targets: &[Texture], depth: Option<Texture>) -> Result<()> {
        unsafe {
            let g = &self.gl;
            g.BindFramebuffer(gl::FRAMEBUFFER, self.fbo);
            for i in 0..self.capabilities.max_draw_buffers as u32 {
                g.FramebufferTexture2D(
                    gl::FRAMEBUFFER,
                    gl::COLOR_ATTACHMENT0 + i,
                    gl::TEXTURE_2D,
                    targets.get(i as usize).map(|t| t.id).unwrap_or(0),
                    0,
                );
            }
            g.FramebufferTexture2D(
                gl::FRAMEBUFFER,
                gl::DEPTH_ATTACHMENT,
                gl::TEXTURE_2D,
                depth.map(|t| t.id).unwrap_or(0),
                0,
            );
            let attachments = (0..targets.len())
                .map(|i| gl::COLOR_ATTACHMENT0 + i as u32)
                .collect::<Vec<_>>();
            if attachments.is_empty() {
                g.DrawBuffer(gl::NONE);
                g.ReadBuffer(gl::NONE)
            } else {
                g.DrawBuffers(attachments.len() as i32, attachments.as_ptr());
                g.ReadBuffer(gl::COLOR_ATTACHMENT0)
            }
            let status = g.CheckFramebufferStatus(gl::FRAMEBUFFER);
            ensure!(
                status == gl::FRAMEBUFFER_COMPLETE,
                "incomplete framebuffer 0x{status:x}"
            );
            Ok(())
        }
    }
    fn clear_all(&mut self) -> Result<()> {
        for c in &self.colors {
            for t in c.textures {
                self.attach(&[t], None)?;
                unsafe {
                    self.gl.ClearBufferfv(gl::COLOR, 0, c.clear_color.as_ptr());
                }
            }
        }
        for t in self.depths.into_iter().chain(self.shadows) {
            self.attach(&[], Some(t))?;
            unsafe {
                self.gl.Clear(gl::DEPTH_BUFFER_BIT);
            }
        }
        for t in self.shadow_colors {
            self.attach(&[t], None)?;
            unsafe {
                self.gl.ClearBufferfv(gl::COLOR, 0, [0.0; 4].as_ptr());
            }
        }
        self.uniforms.reset();
        self.invalidations += 1;
        Ok(())
    }
    pub fn render(&mut self, input: &FrameInput) -> Result<Vec<PassTiming>> {
        unsafe {
            let discontinuity = history_discontinuity(self.previous.as_ref(), input);
            if discontinuity {
                self.clear_all()?;
            }
            for c in &self.colors {
                if c.clear {
                    self.attach(&[c.textures[c.front]], None)?;
                    self.gl.ClearBufferfv(gl::COLOR, 0, c.clear_color.as_ptr());
                }
            }
            self.attach(&[], Some(self.depths[0]))?;
            self.gl.Clear(gl::DEPTH_BUFFER_BIT);
            let view = input.view_effect
                * glam::camera::rh::view::look_at_mat4(input.camera, input.target, input.up);
            let relative = view * Mat4::from_translation(input.camera);
            let projection = glam::camera::rh::proj::opengl::perspective(
                input.fov_degrees.to_radians(),
                self.width as f32 / self.height as f32,
                input.near,
                input.far,
            );
            let angle = (input.world_time as f32 - 6000.0) / 24000.0 * std::f32::consts::TAU;
            let sun = Vec3::new(
                -angle.sin(),
                angle.cos() * 0.819152,
                angle.cos() * -0.573576,
            )
            .normalize();
            let light = if sun.y >= 0.0 { sun } else { -sun };
            let shadow = glam::camera::rh::view::look_at_mat4(light * 128.0, Vec3::ZERO, Vec3::Z);
            let shadow_projection =
                glam::camera::rh::proj::opengl::orthographic(-128., 128., -128., 128., 0.1, 512.0);
            let mut base = frame_uniforms(
                input,
                self.width,
                self.height,
                relative,
                projection,
                shadow,
                shadow_projection,
                sun,
            );
            base.insert(
                "atlasSize".into(),
                Value(vec![self.atlas.width as f64, self.atlas.height as f64]),
            );
            let previous = if discontinuity {
                input
            } else {
                self.previous.as_ref().unwrap_or(input)
            };
            base.insert(
                "previousCameraPosition".into(),
                Value(previous.camera.to_array().map(f64::from).to_vec()),
            );
            base.insert(
                "gbufferPreviousModelView".into(),
                Value(
                    if discontinuity {
                        relative
                    } else {
                        self.previous_view
                    }
                    .to_cols_array()
                    .map(f64::from)
                    .to_vec(),
                ),
            );
            base.insert(
                "gbufferPreviousProjection".into(),
                Value(
                    if discontinuity {
                        projection
                    } else {
                        self.previous_projection
                    }
                    .to_cols_array()
                    .map(f64::from)
                    .to_vec(),
                ),
            );
            let values = self.uniforms.evaluate(&base, input.delta_seconds as f64)?;
            let mut queries = Vec::new();
            let mut timings = Vec::new();
            for index in 0..self.passes.len() {
                let pass = &self.passes[index];
                let start = std::time::Instant::now();
                let mut query = 0;
                self.gl.GenQueries(1, &mut query);
                self.gl.BeginQuery(gl::TIME_ELAPSED, query);
                self.gl.UseProgram(pass.id);
                self.bind(pass, &values)?;
                if let Some(groups) = pass.compute {
                    self.gl.DispatchCompute(groups[0], groups[1], groups[2]);
                    self.gl.MemoryBarrier(
                        gl::SHADER_IMAGE_ACCESS_BARRIER_BIT | gl::TEXTURE_FETCH_BARRIER_BIT,
                    );
                } else if pass.name == "shadow" {
                    self.attach(&self.shadow_colors, Some(self.shadows[0]))?;
                    self.gl.Viewport(
                        0,
                        0,
                        self.shadows[0].width as i32,
                        self.shadows[0].height as i32,
                    );
                    self.gl.Clear(gl::COLOR_BUFFER_BIT | gl::DEPTH_BUFFER_BIT);
                    self.geometry(
                        pass,
                        self.solid_vbo,
                        self.solid_count,
                        shadow * Mat4::from_translation(-input.camera),
                        shadow_projection,
                    );
                    self.copy(self.shadows[0], self.shadows[1]);
                } else if pass.name.starts_with("gbuffers_") {
                    let targets = pass
                        .targets
                        .iter()
                        .map(|i| self.colors[*i].textures[self.colors[*i].front])
                        .collect::<Vec<_>>();
                    self.attach(&targets, Some(self.depths[0]))?;
                    self.gl
                        .Viewport(0, 0, self.width as i32, self.height as i32);
                    let water = pass.name == "gbuffers_water";
                    self.geometry(
                        pass,
                        if water {
                            self.water_vbo
                        } else {
                            self.solid_vbo
                        },
                        if water {
                            self.water_count
                        } else {
                            self.solid_count
                        },
                        view,
                        projection,
                    );
                    if !water {
                        self.copy(self.depths[0], self.depths[1]);
                        self.copy(self.depths[0], self.depths[2]);
                    }
                } else {
                    for i in &pass.mipmaps {
                        let t = self.colors[*i].textures[self.colors[*i].front];
                        self.gl.BindTexture(gl::TEXTURE_2D, t.id);
                        self.gl.GenerateMipmap(gl::TEXTURE_2D);
                        self.gl.TexParameteri(
                            gl::TEXTURE_2D,
                            gl::TEXTURE_MIN_FILTER,
                            gl::NEAREST_MIPMAP_NEAREST as i32,
                        );
                    }
                    // Generating mips changed the active texture binding; restore the ABI.
                    self.bind(pass, &values)?;
                    if pass.name == "final" {
                        self.gl.BindFramebuffer(gl::FRAMEBUFFER, 0);
                        self.gl
                            .Viewport(0, 0, self.width as i32, self.height as i32);
                    } else {
                        let targets = pass
                            .targets
                            .iter()
                            .map(|i| self.colors[*i].textures[1 - self.colors[*i].front])
                            .collect::<Vec<_>>();
                        // Passes may discard or update only a tile. Preserve untouched texels.
                        for i in &pass.targets {
                            let c = &self.colors[*i];
                            self.copy(c.textures[c.front], c.textures[1 - c.front]);
                        }
                        self.attach(&targets, None)?;
                        let t = targets[0];
                        self.gl.Viewport(0, 0, t.width as i32, t.height as i32);
                    }
                    self.gl.Disable(gl::DEPTH_TEST);
                    self.blend(pass);
                    self.gl.Disable(gl::CULL_FACE);
                    self.gl.DepthMask(gl::FALSE);
                    self.gl.BindBuffer(gl::ARRAY_BUFFER, 0);
                    self.gl.Begin(gl::QUADS);
                    for (x, y) in [(0., 0.), (1., 0.), (1., 1.), (0., 1.)] {
                        self.gl.MultiTexCoord2f(gl::TEXTURE0, x, y);
                        self.gl.Vertex2f(x, y);
                    }
                    self.gl.End();
                    self.gl.DepthMask(gl::TRUE);
                    if pass.name != "final" {
                        for i in &pass.targets {
                            self.colors[*i].front = 1 - self.colors[*i].front;
                        }
                    }
                    for (key, value) in &self.pack.properties {
                        if key.starts_with(&format!("flip.{}.", pass.name)) && value == "true" {
                            let i: usize = key
                                .rsplit('.')
                                .next()
                                .unwrap()
                                .trim_start_matches("colortex")
                                .parse()?;
                            if !pass.targets.contains(&i) {
                                self.colors[i].front = 1 - self.colors[i].front;
                            }
                        }
                    }
                }
                self.gl.EndQuery(gl::TIME_ELAPSED);
                self.check(&pass.name)?;
                timings.push(PassTiming {
                    pass: pass.name.clone(),
                    gpu_ms: 0.0,
                    cpu_submit_ms: start.elapsed().as_secs_f64() * 1000.0,
                });
                queries.push(query);
            }
            // Serialized diagnostic measurements: each sample waits for the submitted
            // frame. This is explicitly reported, and does not claim presented FPS.
            for (q, t) in queries.into_iter().zip(&mut timings) {
                let mut ns = 0;
                self.gl.GetQueryObjectui64v(q, gl::QUERY_RESULT, &mut ns);
                t.gpu_ms = ns as f64 / 1e6;
                self.gl.DeleteQueries(1, &q);
            }
            self.previous = Some(input.clone());
            self.previous_view = relative;
            self.previous_projection = projection;
            Ok(timings)
        }
    }
    fn copy(&self, src: Texture, dst: Texture) {
        unsafe {
            self.gl.CopyImageSubData(
                src.id,
                src.target,
                0,
                0,
                0,
                0,
                dst.id,
                dst.target,
                0,
                0,
                0,
                0,
                src.width as i32,
                src.height as i32,
                1,
            );
        }
    }
    fn bind(&self, p: &Pass, values: &BTreeMap<String, Value>) -> Result<()> {
        unsafe {
            let mut unit = 0;
            for b in &p.bindings {
                if [gl::SAMPLER_2D, gl::SAMPLER_3D, gl::SAMPLER_2D_SHADOW].contains(&b.ty) {
                    let category = if p.name.starts_with("deferred") {
                        "deferred"
                    } else if p.name.starts_with("composite") {
                        "composite"
                    } else {
                        "gbuffers"
                    };
                    let key = format!("{category}.{}", b.name);
                    // OpenGL binds 2D and 3D resources independently on one texture
                    // unit. Iris custom textures can override one target while the
                    // same sampler name still resolves to a render target elsewhere.
                    let expected = if b.ty == gl::SAMPLER_3D {
                        gl::TEXTURE_3D
                    } else {
                        gl::TEXTURE_2D
                    };
                    let tex = self
                        .custom
                        .get(&key)
                        .or_else(|| self.custom.get(&format!("{key}.1")))
                        .copied()
                        .filter(|t| t.target == expected)
                        .or_else(|| {
                            if let Some(i) = b
                                .name
                                .strip_prefix("colortex")
                                .and_then(|s| s.parse::<usize>().ok())
                            {
                                self.colors.get(i).map(|c| c.textures[c.front])
                            } else if let Some(i) = b
                                .name
                                .strip_prefix("depthtex")
                                .and_then(|s| s.parse::<usize>().ok())
                            {
                                self.depths.get(i).copied()
                            } else if let Some(i) = b
                                .name
                                .strip_prefix("shadowtex")
                                .and_then(|s| s.parse::<usize>().ok())
                            {
                                self.shadows.get(i).copied()
                            } else if let Some(i) = b
                                .name
                                .strip_prefix("shadowcolor")
                                .and_then(|s| s.parse::<usize>().ok())
                            {
                                self.shadow_colors.get(i).copied()
                            } else {
                                match b.name.as_str() {
                                    "tex" | "gtexture" | "texture" => Some(self.atlas),
                                    "normals" => Some(self.normals),
                                    "specular" => Some(self.specular),
                                    "noisetex" => Some(self.noise),
                                    _ => None,
                                }
                            }
                        })
                        .with_context(|| format!("unbound sampler {} in {}", b.name, p.name))?;
                    ensure!(
                        unit < self.capabilities.max_texture_units,
                        "too many sampler bindings"
                    );
                    self.gl.ActiveTexture(gl::TEXTURE0 + unit as u32);
                    self.gl.BindTexture(tex.target, tex.id);
                    if b.ty == gl::SAMPLER_2D_SHADOW {
                        self.gl.TexParameteri(
                            tex.target,
                            gl::TEXTURE_COMPARE_MODE,
                            gl::COMPARE_REF_TO_TEXTURE as i32,
                        );
                        self.gl.TexParameteri(
                            tex.target,
                            gl::TEXTURE_COMPARE_FUNC,
                            gl::LEQUAL as i32,
                        );
                    } else if tex.format == gl::DEPTH_COMPONENT32F {
                        self.gl.TexParameteri(
                            tex.target,
                            gl::TEXTURE_COMPARE_MODE,
                            gl::NONE as i32,
                        );
                    }
                    self.gl.Uniform1i(b.location, unit);
                    unit += 1;
                } else if b.ty == gl::IMAGE_2D {
                    let i: usize = b
                        .name
                        .strip_prefix("colorimg")
                        .context("only colorimg image bindings supported")?
                        .parse()?;
                    let c = self.colors.get(i).context("image target out of range")?;
                    let t = c.textures[c.front];
                    self.gl.BindImageTexture(
                        i as u32,
                        t.id,
                        0,
                        gl::FALSE,
                        0,
                        gl::READ_WRITE,
                        t.format,
                    );
                    self.gl.Uniform1i(b.location, i as i32);
                } else {
                    let v = values
                        .get(&b.name)
                        .with_context(|| format!("unbound uniform {} in {}", b.name, p.name))?;
                    let f = v.0.iter().map(|x| *x as f32).collect::<Vec<_>>();
                    let n = v.0.iter().map(|x| *x as i32).collect::<Vec<_>>();
                    let length = match b.ty {
                        gl::FLOAT | gl::INT | gl::BOOL => 1,
                        gl::FLOAT_VEC2 | gl::INT_VEC2 => 2,
                        gl::FLOAT_VEC3 | gl::INT_VEC3 => 3,
                        gl::FLOAT_VEC4 | gl::INT_VEC4 => 4,
                        gl::FLOAT_MAT4 => 16,
                        _ => bail!("unsupported uniform type {}: 0x{:x}", b.name, b.ty),
                    };
                    ensure!(v.0.len() == length, "wrong uniform size {}", b.name);
                    match b.ty {
                        gl::FLOAT => self.gl.Uniform1f(b.location, f[0]),
                        gl::INT | gl::BOOL => self.gl.Uniform1i(b.location, n[0]),
                        gl::FLOAT_VEC2 => self.gl.Uniform2fv(b.location, 1, f.as_ptr()),
                        gl::FLOAT_VEC3 => self.gl.Uniform3fv(b.location, 1, f.as_ptr()),
                        gl::FLOAT_VEC4 => self.gl.Uniform4fv(b.location, 1, f.as_ptr()),
                        gl::INT_VEC2 => self.gl.Uniform2iv(b.location, 1, n.as_ptr()),
                        gl::INT_VEC3 => self.gl.Uniform3iv(b.location, 1, n.as_ptr()),
                        gl::INT_VEC4 => self.gl.Uniform4iv(b.location, 1, n.as_ptr()),
                        gl::FLOAT_MAT4 => {
                            self.gl
                                .UniformMatrix4fv(b.location, 1, gl::FALSE, f.as_ptr())
                        }
                        _ => unreachable!(),
                    }
                }
            }
            Ok(())
        }
    }
    fn blend(&self, pass: &Pass) {
        unsafe {
            self.gl.Disable(gl::BLEND);
            for (index, mode) in pass.blends.iter().enumerate() {
                if let Some(f) = mode {
                    self.gl.Enablei(gl::BLEND, index as u32);
                    self.gl
                        .BlendFuncSeparatei(index as u32, f[0], f[1], f[2], f[3]);
                    self.gl
                        .BlendEquationSeparatei(index as u32, gl::FUNC_ADD, gl::FUNC_ADD);
                }
            }
        }
    }
    fn geometry(&self, p: &Pass, vbo: u32, count: i32, view: Mat4, projection: Mat4) {
        unsafe {
            let g = &self.gl;
            g.Enable(gl::DEPTH_TEST);
            g.DepthFunc(gl::LEQUAL);
            g.DepthMask(gl::TRUE);
            g.Disable(gl::CULL_FACE);
            self.blend(p);
            g.MatrixMode(gl::PROJECTION);
            g.LoadMatrixf(projection.to_cols_array().as_ptr());
            g.MatrixMode(gl::MODELVIEW);
            g.LoadMatrixf(view.to_cols_array().as_ptr());
            g.ActiveTexture(gl::TEXTURE0);
            g.MatrixMode(gl::TEXTURE);
            g.LoadIdentity();
            g.MatrixMode(gl::MODELVIEW);
            g.BindBuffer(gl::ARRAY_BUFFER, vbo);
            let stride = size_of::<Vertex>() as i32;
            g.EnableClientState(gl::VERTEX_ARRAY);
            g.VertexPointer(
                3,
                gl::FLOAT,
                stride,
                offset_of!(Vertex, position) as *const _,
            );
            g.EnableClientState(gl::NORMAL_ARRAY);
            g.NormalPointer(gl::FLOAT, stride, offset_of!(Vertex, normal) as *const _);
            g.EnableClientState(gl::COLOR_ARRAY);
            g.ColorPointer(4, gl::FLOAT, stride, offset_of!(Vertex, color) as *const _);
            for (unit, offset) in [
                (gl::TEXTURE0, offset_of!(Vertex, uv)),
                (gl::TEXTURE1, offset_of!(Vertex, light)),
            ] {
                g.ClientActiveTexture(unit);
                g.EnableClientState(gl::TEXTURE_COORD_ARRAY);
                g.TexCoordPointer(2, gl::FLOAT, stride, offset as *const _);
            }
            let mut attrs = Vec::new();
            for ((size, offset), loc) in [
                (4, offset_of!(Vertex, tangent)),
                (3, offset_of!(Vertex, material)),
                (2, offset_of!(Vertex, mid_uv)),
            ]
            .into_iter()
            .zip(p.attributes)
            {
                if loc >= 0 {
                    g.EnableVertexAttribArray(loc as u32);
                    g.VertexAttribPointer(
                        loc as u32,
                        size,
                        gl::FLOAT,
                        gl::FALSE,
                        stride,
                        offset as *const _,
                    );
                    attrs.push(loc);
                }
            }
            g.DrawArrays(gl::TRIANGLES, 0, count);
            for loc in attrs {
                g.DisableVertexAttribArray(loc as u32);
            }
            for unit in [gl::TEXTURE0, gl::TEXTURE1] {
                g.ClientActiveTexture(unit);
                g.DisableClientState(gl::TEXTURE_COORD_ARRAY);
            }
            g.ClientActiveTexture(gl::TEXTURE0);
            for state in [gl::VERTEX_ARRAY, gl::NORMAL_ARRAY, gl::COLOR_ARRAY] {
                g.DisableClientState(state);
            }
        }
    }
    pub fn screenshot(&self, path: &Path) -> Result<()> {
        unsafe {
            let mut bytes = vec![0u8; (self.width * self.height * 4) as usize];
            self.gl.BindFramebuffer(gl::FRAMEBUFFER, 0);
            self.gl.PixelStorei(gl::PACK_ALIGNMENT, 1);
            self.gl.ReadPixels(
                0,
                0,
                self.width as i32,
                self.height as i32,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                bytes.as_mut_ptr().cast(),
            );
            self.check("screenshot readback")?;
            let mut image = image::RgbaImage::from_raw(self.width, self.height, bytes)
                .context("invalid screenshot dimensions")?;
            image::imageops::flip_vertical_in_place(&mut image);
            image.save(path)?;
            Ok(())
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            for t in &self.owned {
                self.gl.DeleteTextures(1, &t.id);
            }
            self.gl.DeleteBuffers(1, &self.solid_vbo);
            self.gl.DeleteBuffers(1, &self.water_vbo);
            self.gl.DeleteFramebuffers(1, &self.fbo);
        }
    }
}

fn load_custom(g: &gl::Gl, pack: &Pack, value: &str) -> Result<Texture> {
    unsafe {
        let fields = value.split_whitespace().collect::<Vec<_>>();
        let name = fields.first().context("empty texture property")?;
        let metadata = pack
            .text(&format!("{name}.mcmeta"))
            .ok()
            .map(|s| serde_json::from_str::<serde_json::Value>(&s))
            .transpose()?;
        let blur = metadata
            .as_ref()
            .and_then(|m| m["texture"]["blur"].as_bool())
            .unwrap_or(false);
        let clamp = metadata
            .as_ref()
            .and_then(|m| m["texture"]["clamp"].as_bool())
            .unwrap_or(false);
        ensure!(
            !name.starts_with("minecraft:"),
            "Minecraft named custom textures require resource integration: {name}"
        );
        if fields.len() == 1 {
            let img = image::load_from_memory(pack.bytes(name)?)?.to_rgba8();
            let tex = texture(
                g,
                img.width(),
                img.height(),
                gl::RGBA8,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                Some(img.as_raw()),
                !clamp,
            );
            if blur {
                for p in [gl::TEXTURE_MIN_FILTER, gl::TEXTURE_MAG_FILTER] {
                    g.TexParameteri(gl::TEXTURE_2D, p, gl::LINEAR as i32);
                }
            }
            return Ok(tex);
        }
        ensure!(
            fields.len() == 8 && fields[1] == "TEXTURE_3D",
            "unsupported custom texture declaration: {value}"
        );
        let (internal, external, ty) = format(fields[2])?;
        let w: u32 = fields[3].parse()?;
        let h: u32 = fields[4].parse()?;
        let d: u32 = fields[5].parse()?;
        let components = match external {
            gl::RGBA => 4,
            gl::RGB => 3,
            gl::RG => 2,
            _ => 1,
        };
        let bytes_per = match ty {
            gl::HALF_FLOAT | gl::UNSIGNED_SHORT => 2,
            gl::FLOAT => 4,
            _ => 1,
        };
        let data = pack.bytes(name)?;
        ensure!(
            data.len() == w as usize * h as usize * d as usize * components * bytes_per,
            "incorrect raw texture byte count {name}"
        );
        let mut id = 0;
        g.GenTextures(1, &mut id);
        g.BindTexture(gl::TEXTURE_3D, id);
        g.PixelStorei(gl::UNPACK_ALIGNMENT, 1);
        g.TexImage3D(
            gl::TEXTURE_3D,
            0,
            internal as i32,
            w as i32,
            h as i32,
            d as i32,
            0,
            external,
            ty,
            data.as_ptr().cast(),
        );
        for p in [gl::TEXTURE_MIN_FILTER, gl::TEXTURE_MAG_FILTER] {
            g.TexParameteri(
                gl::TEXTURE_3D,
                p,
                if blur { gl::LINEAR } else { gl::NEAREST } as i32,
            );
        }
        for p in [gl::TEXTURE_WRAP_S, gl::TEXTURE_WRAP_T, gl::TEXTURE_WRAP_R] {
            g.TexParameteri(
                gl::TEXTURE_3D,
                p,
                if clamp { gl::CLAMP_TO_EDGE } else { gl::REPEAT } as i32,
            );
        }
        Ok(Texture {
            id,
            target: gl::TEXTURE_3D,
            width: w,
            height: h,
            format: internal,
        })
    }
}
#[allow(clippy::too_many_arguments)] // Frame transforms and dimensions form the host ABI.
pub(crate) fn frame_uniforms(
    i: &FrameInput,
    w: u32,
    h: u32,
    view: Mat4,
    projection: Mat4,
    shadow: Mat4,
    shadow_projection: Mat4,
    sun: Vec3,
) -> BTreeMap<String, Value> {
    let mut b = BTreeMap::new();
    for (name, value) in [
        ("viewWidth", w as f64),
        ("viewHeight", h as f64),
        ("aspectRatio", w as f64 / h as f64),
        ("frameCounter", i.frame as f64),
        ("frameTimeCounter", i.seconds as f64),
        ("frameTime", i.delta_seconds as f64),
        ("worldTime", i.world_time as f64),
        ("worldDay", i.world_day as f64),
        ("moonPhase", (i.world_day % 8) as f64),
        ("sunAngle", (i.world_time as f64 / 24000.0) % 1.0),
        ("near", i.near as f64),
        ("far", i.far as f64),
        ("eyeAltitude", i.camera.y as f64),
        ("rainStrength", i.rain as f64),
        ("wetness", i.wetness as f64),
        ("screenBrightness", 0.5),
        ("isEyeInWater", f64::from(i.eye_in_water)),
        ("blindness", 0.0),
        ("nightVision", 0.0),
        ("darknessFactor", 0.0),
        ("darknessLightFactor", 0.0),
        ("heldBlockLightValue", 0.0),
        ("heldBlockLightValue2", 0.0),
        ("heldItemId", 0.0),
        ("heldItemId2", 0.0),
        ("hideGUI", 1.0),
        ("isSleeping", 0.0),
        ("entityId", 0.0),
        ("blockEntityId", 0.0),
        ("temperature", i.temperature as f64),
        ("rainfall", i.rainfall as f64),
        ("biome", 1.0),
        ("biome_category", 0.0),
        ("biome_precipitation", 1.0),
        ("BIOME_PALE_GARDEN", 250.0),
        ("CAT_DESERT", 1.0),
        ("CAT_MESA", 2.0),
        ("CAT_SAVANNA", 3.0),
        ("CAT_ICY", 4.0),
        ("CAT_TAIGA", 5.0),
        ("CAT_JUNGLE", 6.0),
        ("CAT_SWAMP", 7.0),
        ("alphaTestRef", 0.1),
    ] {
        b.insert(name.into(), Value::scalar(value));
    }
    for (name, value) in [
        ("cameraPosition", i.camera.to_array().to_vec()),
        (
            "upPosition",
            (view.transform_vector3(Vec3::Y) * 100.0)
                .to_array()
                .to_vec(),
        ),
        (
            "sunPosition",
            (view.transform_vector3(sun) * 100.0).to_array().to_vec(),
        ),
        (
            "moonPosition",
            (view.transform_vector3(-sun) * 100.0).to_array().to_vec(),
        ),
        ("fogColor", vec![0.6, 0.7, 0.8]),
        ("skyColor", vec![0.45, 0.65, 0.9]),
        ("eyeBrightness", i.eye_brightness.to_vec()),
        ("eyeBrightnessSmooth", i.eye_brightness.to_vec()),
        ("atlasSize", vec![64.0, 16.0]),
        ("entityColor", vec![0.0; 4]),
        ("lightningBoltPosition", vec![0.0; 4]),
    ] {
        b.insert(
            name.into(),
            Value(value.into_iter().map(f64::from).collect()),
        );
    }
    for (name, matrix) in [
        ("gbufferModelView", view),
        ("gbufferModelViewInverse", view.inverse()),
        ("gbufferProjection", projection),
        ("gbufferProjectionInverse", projection.inverse()),
        ("shadowModelView", shadow),
        ("shadowModelViewInverse", shadow.inverse()),
        ("shadowProjection", shadow_projection),
        ("shadowProjectionInverse", shadow_projection.inverse()),
    ] {
        let cols = matrix.to_cols_array();
        b.insert(name.into(), Value(cols.map(f64::from).to_vec()));
        for c in 0..4 {
            for r in 0..4 {
                b.insert(
                    format!("{name}.{c}.{r}"),
                    Value::scalar(cols[c * 4 + r] as f64),
                );
            }
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blend_factors_validate_and_preserve_separate_alpha() {
        assert_eq!(blend_mode("off").unwrap(), None);
        assert_eq!(
            blend_mode("ONE ONE_MINUS_SRC_ALPHA ZERO ONE").unwrap(),
            Some([gl::ONE, gl::ONE_MINUS_SRC_ALPHA, gl::ZERO, gl::ONE])
        );
        assert!(blend_mode("ONE UNKNOWN").is_err());
        assert!(blend_mode("ONE").is_err());
    }
    #[test]
    fn history_survives_content_and_pack_owned_environment_changes() {
        let scene = Scene::fixture("terrain");
        let before = FrameInput::fixture(&scene, 1, 6000, 0.0);
        let mut after = before.clone();
        after.frame += 1;
        after.world_time += 1;
        after.camera += Vec3::X * 0.1;
        after.target += Vec3::X * 0.1;
        assert!(!history_discontinuity(Some(&before), &after));
        let mutations: [fn(&mut FrameInput); 9] = [
            |i| i.world_revision += 1,
            |i| i.lighting_revision += 1,
            |i| i.world_time = 18000,
            |i| i.world_day += 1,
            |i| i.rain = 1.0,
            |i| i.wetness = 0.5,
            |i| i.eye_brightness[0] = 16.0,
            |i| i.temperature = 0.0,
            |i| i.rainfall = 0.0,
        ];
        for mutate in mutations {
            let mut changed = before.clone();
            mutate(&mut changed);
            assert!(!history_discontinuity(Some(&before), &changed));
        }
        let mut midnight = before.clone();
        midnight.world_time = 23999;
        let mut next_day = midnight.clone();
        next_day.world_time = 0;
        next_day.world_day += 1;
        assert!(!history_discontinuity(Some(&midnight), &next_day));
    }
    #[test]
    fn history_resets_for_identity_resources_and_camera_projection_cuts() {
        let scene = Scene::fixture("terrain");
        let before = FrameInput::fixture(&scene, 1, 6000, 0.0);
        let mutations: [fn(&mut FrameInput); 8] = [
            |i| i.history_epoch += 1,
            |i| i.material_revision += 1,
            |i| i.near *= 2.0,
            |i| i.far *= 2.0,
            |i| i.fov_degrees += 10.0,
            |i| i.eye_in_water = true,
            |i| {
                i.camera += Vec3::X * 9.0;
                i.target += Vec3::X * 9.0;
            },
            |i| i.target = i.camera - (i.target - i.camera),
        ];
        for mutate in mutations {
            let mut changed = before.clone();
            mutate(&mut changed);
            assert!(history_discontinuity(Some(&before), &changed));
        }
        assert!(history_discontinuity(None, &before));
    }
    #[test]
    fn environment_uniforms_refresh_and_pack_smooth_observes_clock_commands() {
        let scene = Scene::fixture("terrain");
        let mut before = FrameInput::fixture(&scene, 0, 23999, 0.0);
        let base = |i: &FrameInput| {
            frame_uniforms(
                i,
                8,
                8,
                Mat4::IDENTITY,
                Mat4::IDENTITY,
                Mat4::IDENTITY,
                Mat4::IDENTITY,
                Vec3::Y,
            )
        };
        // Pack-defined expressions, with the same clock-delta form used by
        // original packs. No host-specific shader or target exception is used.
        let props = BTreeMap::from([
            (
                "uniform.float.world_age".into(),
                "((worldDay % 128) * 24000.0 + worldTime) / 20.0".into(),
            ),
            (
                "variable.float.world_age_delta".into(),
                "abs(world_age - smooth(world_age, 0.1, 0.1))".into(),
            ),
            (
                "uniform.bool.world_age_changed".into(),
                "world_age_delta > 1.0".into(),
            ),
        ]);
        let mut uniforms = Uniforms::new(&props).unwrap();
        assert_eq!(
            uniforms.evaluate(&base(&before), 1. / 60.).unwrap()["world_age_changed"].first(),
            0.
        );
        let mut after = before.clone();
        after.world_time = 0;
        after.world_day = 1;
        after.rain = 0.5;
        after.wetness = 0.25;
        assert!(!history_discontinuity(Some(&before), &after));
        let values = uniforms.evaluate(&base(&after), 1. / 60.).unwrap();
        for (name, expected) in [
            ("worldTime", 0.),
            ("worldDay", 1.),
            ("rainStrength", 0.5),
            ("wetness", 0.25),
        ] {
            assert_eq!(values[name].first(), expected);
        }
        assert_eq!(values["world_age_changed"].first(), 0.);
        before = after.clone();
        after.world_time = 12000;
        after.world_revision += 1;
        after.lighting_revision += 1;
        assert!(!history_discontinuity(Some(&before), &after));
        assert_eq!(
            uniforms.evaluate(&base(&after), 1. / 60.).unwrap()["world_age_changed"].first(),
            1.
        );
        after.history_epoch += 1;
        assert!(history_discontinuity(Some(&before), &after));
        uniforms.reset();
        assert_eq!(
            uniforms.evaluate(&base(&after), 1. / 60.).unwrap()["world_age_changed"].first(),
            0.
        );
    }
}
