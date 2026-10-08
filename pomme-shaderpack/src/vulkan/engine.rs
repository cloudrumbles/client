use std::collections::{BTreeMap, HashMap};
use std::mem::{offset_of, size_of};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use glam::{Mat3, Mat4, Vec3};
use pyronyx::vk;
use regex::Regex;

use super::abi::{Compiled, ComputeProgram, ImageAccess, Program, Sampler, StorageImage};
use super::resource::{Buffer, Gpu, Image, custom, format};
use crate::expression::{Uniforms, Value};
use crate::geometry::{
    AlphaMode, DrawSpace, FrameGeometry, MaterialIdentity, MeshAsset, TextureAsset,
};
use crate::pack::Pack;
use crate::runtime::{FrameInput, PassTiming, frame_uniforms, history_discontinuity};
use crate::scene::{Scene, Vertex};
use crate::stages::{is_actor, is_shadow};

struct CachedMesh {
    source: Arc<MeshAsset>,
    buffer: Buffer,
}
struct CachedTexture {
    source: Arc<TextureAsset>,
    image: Image,
}
#[derive(Default, Clone, serde::Serialize)]
pub struct GeometryPreparation {
    pub cpu_ms: f64,
    pub mesh_upload_bytes: usize,
    pub texture_upload_bytes: usize,
    pub uniform_capacity_bytes: usize,
    pub mesh_assets: usize,
    pub texture_assets: usize,
    pub draws: usize,
}
#[derive(Default, Clone, serde::Serialize)]
pub struct GeometryStage {
    pub requested: String,
    pub resolved: String,
    pub draws: usize,
    pub vertices: usize,
    pub material_ids: Vec<i32>,
}
#[derive(Clone, serde::Serialize)]
pub struct ComputeDispatch {
    pub program: String,
    pub groups: [u32; 3],
    pub local_size: [u32; 3],
    pub storage_images: Vec<String>,
}
fn mesh_id(mesh: &Arc<MeshAsset>) -> usize {
    Arc::as_ptr(mesh) as usize
}
fn texture_id(tex: &Arc<TextureAsset>) -> usize {
    Arc::as_ptr(tex) as usize
}
const MAX_ACTOR_ASSETS: usize = 512;
const MAX_ACTOR_DRAWS: usize = 4096;

struct Color {
    images: [Image; 2],
    front: usize,
    clear: bool,
    color: [f32; 4],
}
struct Pass {
    program: Program,
    layout: vk::DescriptorSetLayout,
    pipeline_layout: vk::PipelineLayout,
    render_pass: vk::RenderPass,
    pipeline: vk::Pipeline,
    sets: Vec<vk::DescriptorSet>,
    actor_sets: HashMap<(usize, usize), vk::DescriptorSet>,
    framebuffers: HashMap<Vec<u64>, vk::Framebuffer>,
}
struct ComputePass {
    program: ComputeProgram,
    layout: vk::DescriptorSetLayout,
    pipeline_layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    sets: Vec<vk::DescriptorSet>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Execution {
    Graphics(usize),
    Compute(usize),
}
fn execution_order(graphics: &[&str], compute_bases: &[&str]) -> Result<Vec<Execution>> {
    let mut out = Vec::new();
    for stage in [
        "setup",
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
            "setup" | "begin" | "shadowcomp" | "prepare" | "deferred" | "composite"
        );
        for i in 0..if numbered { 100 } else { 1 } {
            let name = if i == 0 {
                stage.into()
            } else {
                format!("{stage}{i}")
            };
            for (index, base) in compute_bases.iter().enumerate() {
                if *base == name {
                    out.push(Execution::Compute(index));
                }
            }
            for (index, graphics) in graphics.iter().enumerate() {
                if *graphics == name {
                    out.push(Execution::Graphics(index));
                }
            }
        }
    }
    ensure!(
        out.len() == graphics.len() + compute_bases.len(),
        "unmapped shader execution stage"
    );
    Ok(out)
}
fn descriptor_limits(
    limits: &vk::PhysicalDeviceLimits,
    samplers: usize,
    images: usize,
) -> Result<()> {
    ensure!(
        samplers <= limits.max_per_stage_descriptor_samplers as usize
            && samplers <= limits.max_descriptor_set_samplers as usize
            && samplers <= limits.max_per_stage_descriptor_sampled_images as usize
            && samplers <= limits.max_descriptor_set_sampled_images as usize,
        "shader sampled-image/sampler descriptors exceed device limits"
    );
    ensure!(
        images <= limits.max_per_stage_descriptor_storage_images as usize
            && images <= limits.max_descriptor_set_storage_images as usize,
        "shader storage-image descriptors exceed device limits"
    );
    ensure!(
        1 + samplers + images <= limits.max_per_stage_resources as usize
            && limits.max_per_stage_descriptor_uniform_buffers >= 1
            && limits.max_descriptor_set_uniform_buffers_dynamic >= 1,
        "shader resource descriptors exceed device limits"
    );
    Ok(())
}
fn timestamp_elapsed(start: u64, end: u64, bits: u32) -> u64 {
    let mask = if bits >= 64 {
        u64::MAX
    } else {
        (1u64 << bits) - 1
    };
    end.wrapping_sub(start) & mask
}
pub struct Engine {
    pub pack: Pack,
    pub gpu: Gpu,
    compiled: Compiled,
    width: u32,
    height: u32,
    passes: Vec<Pass>,
    computes: Vec<ComputePass>,
    execution: Vec<Execution>,
    setup_done: bool,
    colors: Vec<Color>,
    depths: Vec<Image>,
    shadows: Vec<Image>,
    shadow_colors: Vec<Image>,
    custom: HashMap<String, Image>,
    atlas: Image,
    normals: Image,
    specular: Image,
    noise: Image,
    pub output: Image,
    solid: Buffer,
    water: Buffer,
    fullscreen: Buffer,
    solid_count: u32,
    water_count: u32,
    uniform_buffers: Vec<Buffer>,
    uniform_stride: usize,
    uniform_capacities: Vec<usize>,
    geometry: Arc<FrameGeometry>,
    actor_meshes: HashMap<usize, CachedMesh>,
    actor_textures: HashMap<usize, CachedTexture>,
    pub geometry_preparation: GeometryPreparation,
    pub geometry_stages: Vec<GeometryStage>,
    pub compute_dispatches: Vec<ComputeDispatch>,
    descriptor_pool: vk::DescriptorPool,
    query_pools: Vec<vk::QueryPool>,
    cpu_timings: Vec<Vec<f64>>,
    uniforms: Uniforms,
    previous: Option<FrameInput>,
    previous_view: Mat4,
    previous_projection: Mat4,
    pub invalidations: u32,
    pub revision: String,
}
fn extent(w: u32, h: u32) -> vk::Extent3D {
    vk::Extent3D {
        width: w,
        height: h,
        depth: 1,
    }
}
pub(crate) fn vertex_bytes(vertices: &[Vertex]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(vertices.as_ptr().cast(), std::mem::size_of_val(vertices)) }
}
fn pack_vertices(pack: &Pack, scene: &Scene, source: &[Vertex]) -> Vec<Vertex> {
    // Resolve names/state predicates once per palette, not once per vertex.
    // A live world can submit millions of vertices with only dozens of states.
    let ids = scene
        .materials
        .iter()
        .map(|name| {
            if name.is_empty() {
                0.
            } else {
                pack.block_material_id(name) as f32
            }
        })
        .collect::<Vec<_>>();
    source
        .iter()
        .map(|v| {
            let mut v = *v;
            v.material[0] = ids.get(v.material[0] as usize).copied().unwrap_or(0.);
            v
        })
        .collect()
}
pub(crate) fn screen_vertices() -> Vec<Vertex> {
    [(0., 0.), (1., 0.), (1., 1.), (0., 0.), (1., 1.), (0., 1.)]
        .into_iter()
        .map(|(x, y)| Vertex {
            position: [x, y, 0.],
            normal: [0., 0., 1.],
            uv: [x, y],
            light: [0., 240.],
            color: [1.; 4],
            tangent: [1., 0., 0., 1.],
            material: [0.; 3],
            mid_uv: [x, y],
        })
        .collect()
}
impl Engine {
    pub fn new(
        gpu: Gpu,
        pack: Pack,
        width: u32,
        height: u32,
        scene: &Scene,
        atlas: Option<([u32; 2], &[u8])>,
        slots: usize,
    ) -> Result<Self> {
        ensure!(
            width > 0 && height > 0 && slots > 0,
            "invalid Vulkan pack extent/slots"
        );
        ensure!(
            !pack
                .properties
                .keys()
                .any(|s| s.starts_with("image.") || s.starts_with("bufferObject.")),
            "custom images/SSBOs require their Vulkan storage ABI"
        );
        let compiled = Compiled::new(&pack)?;
        let limits = gpu.physical.get_properties().limits;
        let families = gpu.physical.get_queue_family_properties();
        let family = families
            .get(gpu.queue_family as usize)
            .context("invalid shader-pack queue family")?;
        ensure!(
            family.queue_flags.contains(vk::QueueFlags::Graphics)
                && family.timestamp_valid_bits > 0,
            "shader-pack queue needs graphics and timestamp support"
        );
        ensure!(
            compiled.abi.uniform_size <= limits.max_uniform_buffer_range as usize,
            "pack uniform block exceeds device range"
        );
        let all = compiled
            .programs
            .iter()
            .map(|p| p.source.as_str())
            .chain(compiled.compute_programs.iter().map(|p| p.source.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        let mut colors = Vec::new();
        for i in 0..16 {
            let fmt = Regex::new(&format!(r"const\s+int\s+colortex{i}Format\s*=\s*(\w+)"))?
                .captures(&all)
                .map(|c| c[1].to_owned())
                .unwrap_or_else(|| "RGBA16F".into());
            let mut fmt = format(&fmt)?;
            // Wider floating-point storage is a portable alternative when packed HDR
            // cannot support the pack's filtered mip chain on this device.
            let required = vk::FormatFeatureFlags::BlitSrc
                | vk::FormatFeatureFlags::BlitDst
                | vk::FormatFeatureFlags::SampledImageFilterLinear;
            if fmt == vk::Format::B10G11R11UfloatPack32
                && !gpu
                    .physical
                    .get_format_properties(fmt)
                    .optimal_tiling_features
                    .contains(required)
            {
                eprintln!(
                    "Vulkan packed HDR fallback: colortex{i} uses RGBA16F for filtered mip support"
                );
                fmt = vk::Format::R16G16B16A16Sfloat;
            }
            let mut size = [width, height];
            if let Some(value) = pack.properties.get(&format!("size.buffer.colortex{i}")) {
                let v = value
                    .split_whitespace()
                    .map(str::parse::<f32>)
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                ensure!(v.len() == 2, "invalid buffer size");
                for j in 0..2 {
                    size[j] = if v[j] <= 1.0 {
                        (v[j] * size[j] as f32).max(1.0) as u32
                    } else {
                        v[j] as u32
                    };
                }
            }
            ensure!(
                size.iter()
                    .all(|n| *n > 0 && *n <= limits.max_image_dimension2_d),
                "pack texture extent exceeds device limit"
            );
            let levels = 32 - size[0].max(size[1]).leading_zeros();
            let clear = !Regex::new(&format!(r"const\s+bool\s+colortex{i}Clear\s*=\s*false"))?
                .is_match(&all);
            let mut color = [0.; 4];
            if let Some(c) = Regex::new(&format!(
                r"const\s+vec4\s+colortex{i}ClearColor\s*=\s*vec4\(([^)]+)\)"
            ))?
            .captures(&all)
            {
                let v = c[1]
                    .split(',')
                    .map(|s| s.trim().parse::<f32>())
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                ensure!(v.len() == 1 || v.len() == 4, "invalid clear color");
                for j in 0..4 {
                    color[j] = v[j % v.len()];
                }
            }
            let storage = compiled
                .abi
                .images
                .iter()
                .any(|image| image.name == format!("colorimg{i}"));
            let allocate = if storage {
                Image::new_storage
            } else {
                Image::new
            };
            colors.push(Color {
                images: [
                    allocate(
                        &gpu,
                        extent(size[0], size[1]),
                        fmt,
                        levels,
                        true,
                        false,
                        true,
                    )?,
                    allocate(
                        &gpu,
                        extent(size[0], size[1]),
                        fmt,
                        levels,
                        true,
                        false,
                        true,
                    )?,
                ],
                front: 0,
                clear,
                color,
            });
        }
        let mut depths = Vec::new();
        for _ in 0..3 {
            depths.push(Image::new(
                &gpu,
                extent(width, height),
                vk::Format::D32Sfloat,
                1,
                true,
                false,
                true,
            )?);
        }
        let shadow_size = pack
            .options
            .get("shadowMapResolution")
            .map(|v| v.parse::<u32>())
            .transpose()?
            .or_else(|| {
                Regex::new(r"const\s+int\s+shadowMapResolution\s*=\s*(\d+)")
                    .ok()?
                    .captures(&all)?[1]
                    .parse()
                    .ok()
            })
            .unwrap_or(1024);
        ensure!(
            shadow_size > 0 && shadow_size <= limits.max_image_dimension2_d,
            "shadow extent exceeds device limit"
        );
        let mut shadows = Vec::new();
        let mut shadow_colors = Vec::new();
        for _ in 0..2 {
            shadows.push(Image::new(
                &gpu,
                extent(shadow_size, shadow_size),
                vk::Format::D32Sfloat,
                1,
                true,
                false,
                true,
            )?);
            shadow_colors.push(Image::new(
                &gpu,
                extent(shadow_size, shadow_size),
                vk::Format::R16G16B16A16Sfloat,
                1,
                true,
                false,
                true,
            )?);
        }
        let mut textures = HashMap::new();
        for (key, value) in &pack.properties {
            if let Some(key) = key.strip_prefix("texture.")
                && key != "noise"
            {
                textures.insert(key.to_owned(), custom(&gpu, &pack, value)?);
            }
        }
        let atlas = if let Some((size, pixels)) = atlas {
            let t = Image::new(
                &gpu,
                extent(size[0], size[1]),
                vk::Format::R8G8B8A8Unorm,
                1,
                false,
                false,
                true,
            )?;
            ensure!(
                pixels.len() == size[0] as usize * size[1] as usize * 4,
                "invalid atlas bytes"
            );
            t.upload(pixels)?;
            t
        } else {
            let mut pixels = Vec::new();
            for _y in 0..16 {
                for x in 0..64 {
                    pixels.extend_from_slice(
                        &[
                            [99, 160, 51, 255],
                            [150, 150, 150, 255],
                            [72, 142, 42, 255],
                            [40, 100, 180, 180],
                        ][x / 16],
                    );
                }
            }
            let t = Image::new(
                &gpu,
                extent(64, 16),
                vk::Format::R8G8B8A8Unorm,
                1,
                false,
                false,
                true,
            )?;
            t.upload(&pixels)?;
            t
        };
        let neutral = |rgba: &[u8]| -> Result<Image> {
            let t = Image::new(
                &gpu,
                extent(1, 1),
                vk::Format::R8G8B8A8Unorm,
                1,
                false,
                false,
                true,
            )?;
            t.upload(rgba)?;
            Ok(t)
        };
        let normals = neutral(&[128, 128, 255, 255])?;
        let specular = neutral(&[0, 0, 0, 255])?;
        let noise = if let Some(value) = pack.properties.get("texture.noise") {
            custom(&gpu, &pack, value)?
        } else {
            let t = Image::new(
                &gpu,
                extent(64, 64),
                vk::Format::R8G8B8A8Unorm,
                1,
                false,
                false,
                false,
            )?;
            let mut state = 1u32;
            let data = (0..64 * 64 * 4)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    state as u8
                })
                .collect::<Vec<_>>();
            t.upload(&data)?;
            t
        };
        let output = Image::new(
            &gpu,
            extent(width, height),
            vk::Format::R8G8B8A8Unorm,
            1,
            true,
            false,
            true,
        )?;
        let solid = Buffer::new(
            &gpu,
            vertex_bytes(&pack_vertices(&pack, scene, &scene.solid)),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        let water = Buffer::new(
            &gpu,
            vertex_bytes(&pack_vertices(&pack, scene, &scene.water)),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        let fullscreen = Buffer::new(
            &gpu,
            vertex_bytes(&screen_vertices()),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        let alignment = limits.min_uniform_buffer_offset_alignment as usize;
        let uniform_stride = compiled.abi.uniform_size.div_ceil(alignment) * alignment;
        let program_count = compiled.programs.len() + compiled.compute_programs.len();
        let mut uniform_buffers = Vec::new();
        let query_pools = Vec::new();
        for _ in 0..slots {
            uniform_buffers.push(Buffer::new(
                &gpu,
                &vec![0; uniform_stride * program_count],
                vk::BufferUsageFlags::UniformBuffer,
            )?);
        }
        let uniform_values = Uniforms::new(&pack.properties)?;
        let uniform_capacity = uniform_stride * program_count;
        let mut out = Self {
            pack,
            gpu,
            compiled,
            width,
            height,
            passes: Vec::new(),
            computes: Vec::new(),
            execution: Vec::new(),
            setup_done: false,
            colors,
            depths,
            shadows,
            shadow_colors,
            custom: textures,
            atlas,
            normals,
            specular,
            noise,
            output,
            solid,
            water,
            fullscreen,
            solid_count: scene.solid.len() as u32,
            water_count: scene.water.len() as u32,
            uniform_buffers,
            uniform_stride,
            uniform_capacities: vec![uniform_capacity; slots],
            geometry: Arc::new(FrameGeometry::default()),
            actor_meshes: HashMap::new(),
            actor_textures: HashMap::new(),
            geometry_preparation: GeometryPreparation::default(),
            geometry_stages: Vec::new(),
            compute_dispatches: Vec::new(),
            descriptor_pool: vk::DescriptorPool::null(),
            query_pools,
            cpu_timings: vec![vec![]; slots],
            uniforms: uniform_values,
            previous: None,
            previous_view: Mat4::IDENTITY,
            previous_projection: Mat4::IDENTITY,
            invalidations: 0,
            revision: crate::BUILD_REVISION.into(),
        };
        for _ in 0..slots {
            out.query_pools.push(out.gpu.device.create_query_pool(
                &vk::QueryPoolCreateInfo {
                    query_type: vk::QueryType::Timestamp,
                    query_count: program_count as u32 * 2,
                    ..Default::default()
                },
                None,
            )?);
        }
        let programs = std::mem::take(&mut out.compiled.programs);
        let computes = std::mem::take(&mut out.compiled.compute_programs);
        let actor_passes = programs.iter().filter(|p| is_actor(&p.name)).count();
        let set_count = (program_count + actor_passes * MAX_ACTOR_ASSETS) * slots;
        let sampler_count = programs
            .iter()
            .map(|p| {
                p.samplers.len()
                    * if is_actor(&p.name) {
                        MAX_ACTOR_ASSETS + 1
                    } else {
                        1
                    }
            })
            .sum::<usize>()
            * slots
            + computes.iter().map(|p| p.samplers.len()).sum::<usize>() * slots;
        let storage_count = computes.iter().map(|p| p.images.len()).sum::<usize>() * slots;
        let sizes = [
            vk::DescriptorPoolSize {
                ty: vk::DescriptorType::UniformBufferDynamic,
                descriptor_count: set_count as u32,
            },
            vk::DescriptorPoolSize {
                ty: vk::DescriptorType::CombinedImageSampler,
                descriptor_count: sampler_count.max(1) as u32,
            },
            vk::DescriptorPoolSize {
                ty: vk::DescriptorType::StorageImage,
                descriptor_count: storage_count.max(1) as u32,
            },
        ];
        out.descriptor_pool = out.gpu.device.create_descriptor_pool(
            &vk::DescriptorPoolCreateInfo {
                max_sets: set_count as u32,
                pool_size_count: sizes.len() as u32,
                pool_sizes: sizes.as_ptr(),
                ..Default::default()
            },
            None,
        )?;
        for program in programs {
            out.add_pass(program, slots)?;
        }
        for program in computes {
            out.add_compute(program, slots)?;
        }
        out.build_execution()?;
        out.gpu.submit(|cmd| {
            out.clear_all(cmd);
            Ok(())
        })?;
        Ok(out)
    }
    fn add_pass(&mut self, program: Program, slots: usize) -> Result<()> {
        descriptor_limits(
            &self.gpu.physical.get_properties().limits,
            program.samplers.len(),
            0,
        )?;
        for sampler in &program.samplers {
            self.named_sampler(&program.name, sampler)?;
        }
        let d = &self.gpu.device;
        let mut bindings = vec![vk::DescriptorSetLayoutBinding {
            binding: 0,
            descriptor_type: vk::DescriptorType::UniformBufferDynamic,
            descriptor_count: 1,
            stage_flags: vk::ShaderStageFlags::Vertex | vk::ShaderStageFlags::Fragment,
            ..Default::default()
        }];
        for s in &program.samplers {
            bindings.push(vk::DescriptorSetLayoutBinding {
                binding: s.binding,
                descriptor_type: vk::DescriptorType::CombinedImageSampler,
                descriptor_count: 1,
                stage_flags: vk::ShaderStageFlags::Vertex | vk::ShaderStageFlags::Fragment,
                ..Default::default()
            });
        }
        let layout = d.create_descriptor_set_layout(
            &vk::DescriptorSetLayoutCreateInfo {
                binding_count: bindings.len() as u32,
                bindings: bindings.as_ptr(),
                ..Default::default()
            },
            None,
        )?;
        let index = self.passes.len();
        self.passes.push(Pass {
            program,
            layout,
            pipeline_layout: vk::PipelineLayout::null(),
            render_pass: vk::RenderPass::null(),
            pipeline: vk::Pipeline::null(),
            sets: Vec::new(),
            actor_sets: HashMap::new(),
            framebuffers: HashMap::new(),
        });
        let p = &mut self.passes[index];
        p.pipeline_layout = d.create_pipeline_layout(
            &vk::PipelineLayoutCreateInfo {
                set_layout_count: 1,
                set_layouts: &layout,
                ..Default::default()
            },
            None,
        )?;
        let formats = if is_shadow(&p.program.name) {
            self.shadow_colors
                .iter()
                .map(|i| i.format)
                .collect::<Vec<_>>()
        } else if p.program.name == "final" {
            vec![self.output.format]
        } else {
            p.program
                .targets
                .iter()
                .map(|i| self.colors[*i].images[0].format)
                .collect()
        };
        ensure!(
            formats.len()
                <= self
                    .gpu
                    .physical
                    .get_properties()
                    .limits
                    .max_color_attachments as usize,
            "pass attachments exceed Vulkan device limit"
        );
        let depth = is_shadow(&p.program.name) || p.program.name.starts_with("gbuffers_");
        p.render_pass = render_pass(d, &formats, depth)?;
        let mut blend = Vec::new();
        for (slot, _) in formats.iter().enumerate() {
            let key = format!(
                "blend.{}.colortex{}",
                p.program.source_name,
                p.program.targets.get(slot).copied().unwrap_or(slot)
            );
            let value = self.pack.properties.get(&key).or_else(|| {
                self.pack
                    .properties
                    .get(&format!("blend.{}", p.program.source_name))
            });
            blend.push(blend_state(
                value
                    .map(String::as_str)
                    .or_else(|| is_shadow(&p.program.name).then_some("off")),
            )?);
        }
        // The pipeline must not claim independent attachment blend states unless
        // enabled.
        ensure!(
            self.gpu.independent_blend
                || blend
                    .windows(2)
                    .all(|v| blend_key(&v[0]) == blend_key(&v[1])),
            "device lacks independentBlend; this pass needs attachment replay fallback"
        );
        p.pipeline = pipeline(
            d,
            p.render_pass,
            p.pipeline_layout,
            &p.program.vertex,
            &p.program.fragment,
            &blend,
            depth,
        )?;
        let layouts = vec![layout; slots];
        p.sets = vec![vk::DescriptorSet::null(); slots];
        d.allocate_descriptor_sets(
            &vk::DescriptorSetAllocateInfo {
                descriptor_pool: self.descriptor_pool,
                descriptor_set_count: slots as u32,
                set_layouts: layouts.as_ptr(),
                ..Default::default()
            },
            &mut p.sets,
        )?;
        Ok(())
    }
    fn add_compute(&mut self, program: ComputeProgram, slots: usize) -> Result<()> {
        let limits = self.gpu.physical.get_properties().limits;
        descriptor_limits(&limits, program.samplers.len(), program.images.len())?;
        for sampler in &program.samplers {
            self.named_sampler(&program.name, sampler)?;
        }
        ensure!(
            self.gpu.physical.get_queue_family_properties()[self.gpu.queue_family as usize]
                .queue_flags
                .contains(vk::QueueFlags::Compute),
            "shader compute needs a compute-capable graphics queue"
        );
        let crate::compute::Dispatch::Fixed(groups) = program.dispatch;
        ensure!(
            groups
                .iter()
                .zip(limits.max_compute_work_group_count)
                .all(|(n, max)| *n <= max),
            "{} dispatch exceeds device workgroup-count limit",
            program.name
        );
        ensure!(
            program
                .local_size
                .iter()
                .zip(limits.max_compute_work_group_size)
                .all(|(n, max)| *n > 0 && *n <= max)
                && program
                    .local_size
                    .iter()
                    .map(|n| u64::from(*n))
                    .product::<u64>()
                    <= u64::from(limits.max_compute_work_group_invocations),
            "{} local size exceeds device limits",
            program.name
        );
        // Reflection gives the logical payload, not a guessed vec3 allocation
        // stride. Pipeline creation and validated execution check driver layout.
        ensure!(
            program.shared_memory_bytes <= limits.max_compute_shared_memory_size as usize,
            "{} Workgroup payload exceeds device shared-memory limit",
            program.name
        );
        ensure!(
            program
                .capabilities
                .iter()
                .all(|c| matches!(*c, 0 | 1 | 50)),
            "{} needs optional SPIR-V capabilities {:?}; this storage ABI enables core Shader/ImageQuery only",
            program.name,
            program.capabilities
        );
        for image in &program.images {
            self.storage_image(image)?;
        }
        let d = &self.gpu.device;
        let mut bindings = vec![vk::DescriptorSetLayoutBinding {
            binding: 0,
            descriptor_type: vk::DescriptorType::UniformBufferDynamic,
            descriptor_count: 1,
            stage_flags: vk::ShaderStageFlags::Compute,
            ..Default::default()
        }];
        for s in &program.samplers {
            bindings.push(vk::DescriptorSetLayoutBinding {
                binding: s.binding,
                descriptor_type: vk::DescriptorType::CombinedImageSampler,
                descriptor_count: 1,
                stage_flags: vk::ShaderStageFlags::Compute,
                ..Default::default()
            });
        }
        for image in &program.images {
            bindings.push(vk::DescriptorSetLayoutBinding {
                binding: image.binding,
                descriptor_type: vk::DescriptorType::StorageImage,
                descriptor_count: 1,
                stage_flags: vk::ShaderStageFlags::Compute,
                ..Default::default()
            });
        }
        let layout = d.create_descriptor_set_layout(
            &vk::DescriptorSetLayoutCreateInfo {
                binding_count: bindings.len() as u32,
                bindings: bindings.as_ptr(),
                ..Default::default()
            },
            None,
        )?;
        let index = self.computes.len();
        self.computes.push(ComputePass {
            program,
            layout,
            pipeline_layout: vk::PipelineLayout::null(),
            pipeline: vk::Pipeline::null(),
            sets: Vec::new(),
        });
        let p = &mut self.computes[index];
        p.pipeline_layout = d.create_pipeline_layout(
            &vk::PipelineLayoutCreateInfo {
                set_layout_count: 1,
                set_layouts: &layout,
                ..Default::default()
            },
            None,
        )?;
        let module = d.create_shader_module(
            &vk::ShaderModuleCreateInfo {
                code_size: std::mem::size_of_val(p.program.spirv.as_slice()),
                code: p.program.spirv.as_ptr(),
                ..Default::default()
            },
            None,
        )?;
        let result = d.create_compute_pipelines(
            vk::PipelineCache::null(),
            &[vk::ComputePipelineCreateInfo {
                stage: vk::PipelineShaderStageCreateInfo {
                    stage: vk::ShaderStageFlags::Compute,
                    module,
                    name: c"main".as_ptr(),
                    ..Default::default()
                },
                layout: p.pipeline_layout,
                ..Default::default()
            }],
            None,
            std::slice::from_mut(&mut p.pipeline),
        );
        d.destroy_shader_module(module, None);
        result.with_context(|| {
            format!(
                "compute pipeline {} (logical Workgroup payload {} bytes)",
                p.program.name, p.program.shared_memory_bytes
            )
        })?;
        let layouts = vec![layout; slots];
        p.sets = vec![vk::DescriptorSet::null(); slots];
        d.allocate_descriptor_sets(
            &vk::DescriptorSetAllocateInfo {
                descriptor_pool: self.descriptor_pool,
                descriptor_set_count: slots as u32,
                set_layouts: layouts.as_ptr(),
                ..Default::default()
            },
            &mut p.sets,
        )?;
        Ok(())
    }
    fn build_execution(&mut self) -> Result<()> {
        self.execution = execution_order(
            &self
                .passes
                .iter()
                .map(|p| p.program.name.as_str())
                .collect::<Vec<_>>(),
            &self
                .computes
                .iter()
                .map(|p| p.program.base.as_str())
                .collect::<Vec<_>>(),
        )?;
        Ok(())
    }
    fn execution_name(&self, execution: Execution) -> &str {
        match execution {
            Execution::Graphics(index) => &self.passes[index].program.name,
            Execution::Compute(index) => &self.computes[index].program.name,
        }
    }
    fn storage_image(&self, image: &StorageImage) -> Result<&Image> {
        let index = image
            .name
            .strip_prefix("colorimg")
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|i| *i < self.colors.len())
            .with_context(|| {
                format!(
                    "unbound storage image {}; this ABI supports colorimg0..15",
                    image.name
                )
            })?;
        let color = &self.colors[index];
        ensure!(
            image.name == format!("colorimg{index}"),
            "noncanonical storage image name {}",
            image.name
        );
        let target = &color.images[color.front];
        // Require exact Vulkan format equivalence rather than reinterpret a
        // packed HDR fallback through an incompatible formatted image view.
        let expected = format(&image.format.to_ascii_uppercase())?;
        ensure!(
            target.format == expected,
            "storage image {} format {} disagrees with {:?}",
            image.name,
            image.format,
            target.format
        );
        Ok(target)
    }
    fn record_compute(
        &mut self,
        cmd: &vk::CommandBuffer,
        slot: usize,
        index: usize,
        values: &BTreeMap<String, Value>,
    ) -> Result<()> {
        let p = &self.computes[index];
        let bytes = self
            .compiled
            .abi
            .bytes(values, &p.program.active_uniforms)?;
        let offset = (self.passes.len() + index) * self.uniform_stride;
        self.uniform_buffers[slot].write(offset, &bytes)?;
        let p = &self.computes[index];
        let images = p
            .program
            .images
            .iter()
            .map(|i| self.storage_image(i))
            .collect::<Result<Vec<_>>>()?;
        // A sampler/storage alias names the same CURRENT front. Both descriptors
        // and all mip levels use GENERAL for the whole compute dispatch. Compute
        // writes do not flip the raster ping-pong front.
        for image in &images {
            image.transition(cmd, vk::ImageLayout::General);
        }
        let sampled = p
            .program
            .samplers
            .iter()
            .map(|s| -> Result<_> {
                let image = self.named_sampler(&p.program.name, s)?;
                let layout = if images.iter().any(|i| i.handle == image.handle) {
                    vk::ImageLayout::General
                } else {
                    vk::ImageLayout::ShaderReadOnlyOptimal
                };
                image.transition(cmd, layout);
                Ok(vk::DescriptorImageInfo {
                    sampler: if s.ty == "sampler2DShadow" {
                        image.comparison
                    } else {
                        image.sampling()
                    },
                    image_view: image.view,
                    image_layout: layout,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let stored = images
            .iter()
            .map(|image| vk::DescriptorImageInfo {
                image_view: image.attachment,
                image_layout: vk::ImageLayout::General,
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let buffer = vk::DescriptorBufferInfo {
            buffer: self.uniform_buffers[slot].handle,
            offset: 0,
            range: self.compiled.abi.uniform_size as u64,
        };
        let set = p.sets[slot];
        let mut writes = vec![vk::WriteDescriptorSet {
            dst_set: set,
            dst_binding: 0,
            descriptor_count: 1,
            descriptor_type: vk::DescriptorType::UniformBufferDynamic,
            buffer_info: &buffer,
            ..Default::default()
        }];
        for (s, info) in p.program.samplers.iter().zip(&sampled) {
            writes.push(vk::WriteDescriptorSet {
                dst_set: set,
                dst_binding: s.binding,
                descriptor_count: 1,
                descriptor_type: vk::DescriptorType::CombinedImageSampler,
                image_info: info,
                ..Default::default()
            });
        }
        for (image, info) in p.program.images.iter().zip(&stored) {
            writes.push(vk::WriteDescriptorSet {
                dst_set: set,
                dst_binding: image.binding,
                descriptor_count: 1,
                descriptor_type: vk::DescriptorType::StorageImage,
                image_info: info,
                ..Default::default()
            });
        }
        self.gpu.device.update_descriptor_sets(&writes, &[]);
        cmd.bind_pipeline(vk::PipelineBindPoint::Compute, p.pipeline);
        cmd.bind_descriptor_sets(
            vk::PipelineBindPoint::Compute,
            p.pipeline_layout,
            0,
            &[set],
            &[offset as u32],
        );
        let crate::compute::Dispatch::Fixed(groups) = p.program.dispatch;
        cmd.dispatch(groups[0], groups[1], groups[2]);
        for (image, declaration) in images.iter().zip(&p.program.images) {
            if declaration.access != ImageAccess::ReadOnly {
                image.invalidate_mipmaps();
            }
            // The conservative transition supplies shader-write visibility to
            // subsequent computes, fragment reads, copies and mip generation.
            image.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
        }
        self.compute_dispatches.push(ComputeDispatch {
            program: p.program.name.clone(),
            groups,
            local_size: p.program.local_size,
            storage_images: p.program.images.iter().map(|i| i.name.clone()).collect(),
        });
        Ok(())
    }
    fn clear_all(&self, cmd: &vk::CommandBuffer) {
        for c in &self.colors {
            for t in &c.images {
                t.clear(cmd, c.color);
            }
        }
        for t in self.depths.iter().chain(&self.shadows) {
            t.clear(cmd, [0.; 4]);
        }
        for t in &self.shadow_colors {
            t.clear(cmd, [0.; 4]);
        }
        self.output.clear(cmd, [0.; 4]);
    }
    pub fn replace_scene(&mut self, scene: &Scene) -> Result<()> {
        self.gpu.device.wait_idle()?;
        let solid = Buffer::new(
            &self.gpu,
            vertex_bytes(&pack_vertices(&self.pack, scene, &scene.solid)),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        let water = Buffer::new(
            &self.gpu,
            vertex_bytes(&pack_vertices(&self.pack, scene, &scene.water)),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        self.solid = solid;
        self.water = water;
        self.solid_count = scene.solid.len() as u32;
        self.water_count = scene.water.len() as u32;
        self.previous = None;
        Ok(())
    }
    pub fn replace_atlas(&mut self, size: [u32; 2], pixels: &[u8]) -> Result<()> {
        ensure!(
            pixels.len() == size[0] as usize * size[1] as usize * 4,
            "invalid atlas bytes"
        );
        self.gpu.device.wait_idle()?;
        let atlas = Image::new(
            &self.gpu,
            extent(size[0], size[1]),
            vk::Format::R8G8B8A8Unorm,
            1,
            false,
            false,
            true,
        )?;
        atlas.upload(pixels)?;
        self.atlas = atlas;
        self.previous = None;
        Ok(())
    }
    /// Caller has waited for this frame slot's fence. No actor vertices are
    /// rebuilt here.
    pub fn prepare_geometry(&mut self, slot: usize, geometry: Arc<FrameGeometry>) -> Result<()> {
        let start = std::time::Instant::now();
        ensure!(
            geometry.draws.len() <= MAX_ACTOR_DRAWS,
            "actor draw capacity exceeded"
        );
        let mut stats = GeometryPreparation {
            draws: geometry.draws.len(),
            ..Default::default()
        };
        for draw in &geometry.draws {
            ensure!(
                self.passes
                    .iter()
                    .any(|p| !is_shadow(&p.program.name) && actor_stage(draw, &p.program.name)),
                "pack has no resolved geometry stage for actor material {:?}",
                draw.material.identity
            );
            ensure!(
                draw.light.iter().all(|n| *n <= 15),
                "invalid actor light nibble"
            );
            ensure!(
                draw.range.start <= draw.range.end
                    && draw.range.end as usize <= draw.mesh.vertices.len(),
                "invalid actor vertex range {}",
                draw.mesh.key
            );
            let mid = mesh_id(&draw.mesh);
            if !self.actor_meshes.contains_key(&mid) {
                ensure!(
                    self.actor_meshes.len() < MAX_ACTOR_ASSETS,
                    "actor mesh cache capacity exceeded"
                );
                let data = vertex_bytes(&draw.mesh.vertices);
                let buffer = Buffer::new(&self.gpu, data, vk::BufferUsageFlags::VertexBuffer)?;
                stats.mesh_upload_bytes += data.len();
                self.actor_meshes.insert(
                    mid,
                    CachedMesh {
                        source: Arc::clone(&draw.mesh),
                        buffer,
                    },
                );
            }
            let tid = texture_id(&draw.material.texture);
            if !self.actor_textures.contains_key(&tid) {
                ensure!(
                    self.actor_textures.len() < MAX_ACTOR_ASSETS,
                    "actor texture cache capacity exceeded"
                );
                let tex = &draw.material.texture;
                ensure!(
                    tex.size.iter().all(|n| *n > 0)
                        && tex.pixels.len() == tex.size[0] as usize * tex.size[1] as usize * 4,
                    "invalid actor texture {}",
                    tex.key
                );
                let image = Image::new(
                    &self.gpu,
                    extent(tex.size[0], tex.size[1]),
                    vk::Format::R8G8B8A8Unorm,
                    1,
                    false,
                    false,
                    true,
                )?;
                image.upload(&tex.pixels)?;
                stats.texture_upload_bytes += tex.pixels.len();
                self.actor_textures.insert(
                    tid,
                    CachedTexture {
                        source: Arc::clone(tex),
                        image,
                    },
                );
            }
        }
        let needed = self.uniform_stride * (self.execution.len() + geometry.draws.len() * 2);
        ensure!(
            needed <= u32::MAX as usize,
            "dynamic actor uniform offsets exceed Vulkan range"
        );
        if needed > self.uniform_capacities[slot] {
            let size = needed.next_power_of_two();
            self.uniform_buffers[slot] = Buffer::new(
                &self.gpu,
                &vec![0; size],
                vk::BufferUsageFlags::UniformBuffer,
            )?;
            self.uniform_capacities[slot] = size;
        }
        stats.uniform_capacity_bytes = self.uniform_capacities[slot];
        stats.mesh_assets = self.actor_meshes.len();
        stats.texture_assets = self.actor_textures.len();
        stats.cpu_ms = start.elapsed().as_secs_f64() * 1000.;
        self.geometry_preparation = stats;
        self.geometry = geometry;
        Ok(())
    }
    fn sampler(&self, p: &Program, s: &Sampler) -> Result<&Image> {
        self.named_sampler(&p.name, s)
    }
    fn named_sampler(&self, name: &str, s: &Sampler) -> Result<&Image> {
        let category = if name.starts_with("deferred") {
            "deferred"
        } else if name.starts_with("composite") || name == "final" {
            "composite"
        } else if name.starts_with("prepare") {
            "prepare"
        } else if name.starts_with("shadowcomp") {
            "shadowcomp"
        } else if name.starts_with("begin") {
            "begin"
        } else if name.starts_with("setup") {
            "setup"
        } else if is_shadow(name) {
            "shadow"
        } else {
            "gbuffers"
        };
        let key = format!("{category}.{}", s.name);
        if let Some(tex) = self
            .custom
            .get(&key)
            .or_else(|| self.custom.get(&format!("{key}.1")))
            .filter(|t| (t.extent.depth > 1) == (s.ty == "sampler3D"))
        {
            return Self::checked_sampler(s, tex);
        }
        let result = if let Some(i) = s
            .name
            .strip_prefix("colortex")
            .and_then(|n| n.parse::<usize>().ok())
        {
            self.colors.get(i).map(|c| &c.images[c.front])
        } else if let Some(i) = s
            .name
            .strip_prefix("depthtex")
            .and_then(|n| n.parse::<usize>().ok())
        {
            self.depths.get(i)
        } else if let Some(i) = s
            .name
            .strip_prefix("shadowtex")
            .and_then(|n| n.parse::<usize>().ok())
        {
            self.shadows.get(i)
        } else if let Some(i) = s
            .name
            .strip_prefix("shadowcolor")
            .and_then(|n| n.parse::<usize>().ok())
        {
            self.shadow_colors.get(i)
        } else {
            match s.name.as_str() {
                "gtexture" | "texture" | "tex" => Some(&self.atlas),
                "normals" => Some(&self.normals),
                "specular" => Some(&self.specular),
                "noisetex" => Some(&self.noise),
                _ => None,
            }
        };
        let image = result
            .with_context(|| format!("unbound Vulkan sampler {}:{} in {}", s.name, s.ty, name))?;
        Self::checked_sampler(s, image)
    }
    fn checked_sampler<'a>(sampler: &Sampler, image: &'a Image) -> Result<&'a Image> {
        // Every format currently allocated by the pack's format/custom-texture
        // parser is floating point or normalized. Integer, cube and array
        // sampler ABIs require separate resource/view support.
        let compatible = match sampler.ty.as_str() {
            "sampler2D" => image.extent.depth == 1,
            "sampler3D" => image.extent.depth > 1 && !image.depth,
            "sampler2DShadow" => image.extent.depth == 1 && image.depth,
            _ => false,
        };
        ensure!(
            compatible,
            "unsupported sampler resource {}:{} for {:?} {:?}",
            sampler.name,
            sampler.ty,
            image.extent,
            image.format
        );
        Ok(image)
    }
    pub fn record(
        &mut self,
        cmd: &vk::CommandBuffer,
        slot: usize,
        input: &FrameInput,
    ) -> Result<()> {
        let cut = history_discontinuity(self.previous.as_ref(), input);
        if cut {
            self.clear_all(cmd);
            // clear_all also clears setup-owned color images. Rerun setup
            // after this reset so its initialized data is not silently lost.
            self.setup_done = false;
            self.uniforms.reset();
            self.invalidations += 1;
        }
        for c in &self.colors {
            if c.clear {
                c.images[c.front].clear(cmd, c.color);
            }
        }
        self.depths[0].clear(cmd, [0.; 4]);
        let view = input.view_effect
            * glam::camera::rh::view::look_at_mat4(input.camera, input.target, input.up);
        let relative = view * Mat4::from_translation(input.camera);
        let projection = glam::camera::rh::proj::opengl::perspective(
            input.fov_degrees.to_radians(),
            self.width as f32 / self.height as f32,
            input.near,
            input.far,
        );
        let angle = (input.world_time as f32 - 6000.) / 24000. * std::f32::consts::TAU;
        let sun = Vec3::new(
            -angle.sin(),
            angle.cos() * 0.819152,
            angle.cos() * -0.573576,
        )
        .normalize();
        let light = if sun.y >= 0. { sun } else { -sun };
        let shadow = glam::camera::rh::view::look_at_mat4(light * 128., Vec3::ZERO, Vec3::Z);
        let shadow_projection =
            glam::camera::rh::proj::opengl::orthographic(-128., 128., -128., 128., 0.1, 512.);
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
            Value(vec![
                self.atlas.extent.width as f64,
                self.atlas.extent.height as f64,
            ]),
        );
        base.insert(
            "previousCameraPosition".into(),
            Value(
                if cut {
                    input.camera
                } else {
                    self.previous.as_ref().map_or(input.camera, |i| i.camera)
                }
                .to_array()
                .map(f64::from)
                .to_vec(),
            ),
        );
        for (name, m) in [
            (
                "gbufferPreviousModelView",
                if cut { relative } else { self.previous_view },
            ),
            (
                "gbufferPreviousProjection",
                if cut {
                    projection
                } else {
                    self.previous_projection
                },
            ),
        ] {
            base.insert(
                name.into(),
                Value(m.to_cols_array().map(f64::from).to_vec()),
            );
        }
        let values = self.uniforms.evaluate(&base, input.delta_seconds as f64)?;
        self.geometry_stages.clear();
        self.compute_dispatches.clear();
        let geometry = Arc::clone(&self.geometry);
        let mut actor_uniform = self.execution.len();
        let query = self.query_pools[slot];
        cmd.reset_query_pool(query, 0, self.execution.len() as u32 * 2);
        self.cpu_timings[slot].clear();
        for step in 0..self.execution.len() {
            let cpu_start = std::time::Instant::now();
            let n = match self.execution[step] {
                Execution::Graphics(n) => n,
                Execution::Compute(c) => {
                    cmd.write_timestamp(vk::PipelineStageFlags::TopOfPipe, query, step as u32 * 2);
                    if !self.computes[c].program.base.starts_with("setup") || !self.setup_done {
                        self.record_compute(cmd, slot, c, &values)?;
                    }
                    cmd.write_timestamp(
                        vk::PipelineStageFlags::BottomOfPipe,
                        query,
                        step as u32 * 2 + 1,
                    );
                    self.cpu_timings[slot].push(cpu_start.elapsed().as_secs_f64() * 1000.);
                    continue;
                }
            };
            let mut values = values.clone();
            let is_shadow = is_shadow(&self.passes[n].program.name);
            if is_shadow && self.passes[n].program.name == "shadow" {
                self.shadows[0].clear(cmd, [0.; 4]);
                for t in &self.shadow_colors {
                    t.clear(cmd, [0.; 4]);
                }
            }
            let is_geo = is_shadow || self.passes[n].program.name.starts_with("gbuffers_");
            let model = if is_shadow {
                shadow * Mat4::from_translation(-input.camera)
            } else if is_geo {
                view
            } else {
                Mat4::IDENTITY
            };
            let proj = if is_shadow {
                shadow_projection
            } else if is_geo {
                projection
            } else {
                Mat4::IDENTITY
            };
            values.insert("pomme_ActorInputs".into(), Value::scalar(0.));
            // Values in these branches are disabled for non-actor geometry.
            values.insert("pomme_ActorHandedness".into(), Value::scalar(1.));
            values.insert("pomme_ActorLight".into(), Value(vec![0.; 2]));
            values.insert("pomme_ActorTint".into(), Value(vec![1.; 4]));
            values.insert("pomme_ActorMaterial".into(), Value(vec![0.; 3]));
            values.insert("pomme_AlphaTest".into(), Value::scalar(-1.));
            values.insert(
                "pomme_ModelViewMatrix".into(),
                Value(model.to_cols_array().map(f64::from).to_vec()),
            );
            values.insert(
                "pomme_ProjectionMatrix".into(),
                Value(proj.to_cols_array().map(f64::from).to_vec()),
            );
            values.insert(
                "pomme_NormalMatrix".into(),
                Value(
                    Mat3::from_mat4(model)
                        .inverse()
                        .transpose()
                        .to_cols_array()
                        .map(f64::from)
                        .to_vec(),
                ),
            );
            values.insert(
                "pomme_TextureMatrix".into(),
                Value(
                    (0..8)
                        .flat_map(|_| Mat4::IDENTITY.to_cols_array().map(f64::from))
                        .collect(),
                ),
            );
            if !is_actor(&self.passes[n].program.name) {
                let bytes = self
                    .compiled
                    .abi
                    .bytes(&values, &self.passes[n].program.active_uniforms)?;
                self.uniform_buffers[slot].write(n * self.uniform_stride, &bytes)?;
            }
            cmd.write_timestamp(vk::PipelineStageFlags::TopOfPipe, query, step as u32 * 2);
            let name = self.passes[n].program.name.clone();
            if name == "gbuffers_hand" {
                self.depths[0].copy_to(cmd, &self.depths[2]);
            }
            if name == "deferred" || name == "gbuffers_water" {
                self.depths[0].copy_to(cmd, &self.depths[1]);
            }
            for i in &self.passes[n].program.mipmaps {
                self.colors[*i].images[self.colors[*i].front].mipmaps(cmd)?;
            }
            let targets = if is_shadow {
                self.shadow_colors.iter().collect::<Vec<_>>()
            } else if name == "final" {
                vec![&self.output]
            } else {
                self.passes[n]
                    .program
                    .targets
                    .iter()
                    .map(|i| {
                        let c = &self.colors[*i];
                        &c.images[if is_geo { c.front } else { 1 - c.front }]
                    })
                    .collect()
            };
            if !is_geo && name != "final" {
                for i in &self.passes[n].program.targets {
                    let c = &self.colors[*i];
                    c.images[c.front].copy_to(cmd, &c.images[1 - c.front]);
                }
            }
            let depth = if is_shadow {
                Some(&self.shadows[0])
            } else if is_geo {
                Some(&self.depths[0])
            } else {
                None
            };
            let image_infos = self.passes[n]
                .program
                .samplers
                .iter()
                .map(|s| -> Result<_> {
                    let t = self.sampler(&self.passes[n].program, s)?;
                    ensure!(
                        !targets.iter().any(|a| a.handle == t.handle)
                            && depth.is_none_or(|a| a.handle != t.handle),
                        "attachment feedback requires a snapshot for {} in {name}",
                        s.name
                    );
                    t.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
                    Ok(vk::DescriptorImageInfo {
                        sampler: if s.ty == "sampler2DShadow" {
                            t.comparison
                        } else {
                            t.sampling()
                        },
                        image_view: t.view,
                        image_layout: vk::ImageLayout::ShaderReadOnlyOptimal,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let buffer = vk::DescriptorBufferInfo {
                buffer: self.uniform_buffers[slot].handle,
                offset: 0,
                range: self.compiled.abi.uniform_size as u64,
            };
            let set = self.passes[n].sets[slot];
            let mut writes = vec![vk::WriteDescriptorSet {
                dst_set: set,
                dst_binding: 0,
                descriptor_count: 1,
                descriptor_type: vk::DescriptorType::UniformBufferDynamic,
                buffer_info: &buffer,
                ..Default::default()
            }];
            for (s, info) in self.passes[n].program.samplers.iter().zip(&image_infos) {
                writes.push(vk::WriteDescriptorSet {
                    dst_set: set,
                    dst_binding: s.binding,
                    descriptor_count: 1,
                    descriptor_type: vk::DescriptorType::CombinedImageSampler,
                    image_info: info,
                    ..Default::default()
                });
            }
            self.gpu.device.update_descriptor_sets(&writes, &[]);
            let size = targets.first().context("empty Vulkan pass targets")?.extent;
            ensure!(
                targets
                    .iter()
                    .all(|t| t.extent.width == size.width && t.extent.height == size.height),
                "mixed target sizes in {name}"
            );
            for t in &targets {
                t.transition(cmd, vk::ImageLayout::ColorAttachmentOptimal);
            }
            if let Some(depth) = depth {
                depth.transition(cmd, vk::ImageLayout::DepthStencilAttachmentOptimal);
            }
            let mut views = targets.iter().map(|t| t.attachment).collect::<Vec<_>>();
            if let Some(depth) = depth {
                views.push(depth.attachment);
            }
            let key = views.iter().map(|v| v.0).collect::<Vec<_>>();
            let p = &mut self.passes[n];
            let framebuffer = if let Some(f) = p.framebuffers.get(&key) {
                *f
            } else {
                let f = self.gpu.device.create_framebuffer(
                    &vk::FramebufferCreateInfo {
                        render_pass: p.render_pass,
                        attachment_count: views.len() as u32,
                        attachments: views.as_ptr(),
                        width: size.width,
                        height: size.height,
                        layers: 1,
                        ..Default::default()
                    },
                    None,
                )?;
                p.framebuffers.insert(key, f);
                f
            };
            if is_actor(&name) {
                let mut transitioned = std::collections::HashSet::new();
                for draw in geometry.draws.iter().filter(|d| actor_stage(d, &name)) {
                    let tid = texture_id(&draw.material.texture);
                    if transitioned.insert(tid) {
                        self.actor_textures[&tid]
                            .image
                            .transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
                    }
                }
            }
            cmd.begin_render_pass(
                &vk::RenderPassBeginInfo {
                    render_pass: p.render_pass,
                    framebuffer,
                    render_area: vk::Rect2D {
                        offset: vk::Offset2D { x: 0, y: 0 },
                        extent: vk::Extent2D {
                            width: size.width,
                            height: size.height,
                        },
                    },
                    ..Default::default()
                },
                vk::SubpassContents::Inline,
            );
            cmd.set_viewport(
                0,
                &[vk::Viewport {
                    x: 0.,
                    y: 0.,
                    width: size.width as f32,
                    height: size.height as f32,
                    min_depth: 0.,
                    max_depth: 1.,
                }],
            );
            cmd.set_scissor(
                0,
                &[vk::Rect2D {
                    offset: vk::Offset2D { x: 0, y: 0 },
                    extent: vk::Extent2D {
                        width: size.width,
                        height: size.height,
                    },
                }],
            );
            cmd.bind_pipeline(vk::PipelineBindPoint::Graphics, p.pipeline);
            cmd.bind_descriptor_sets(
                vk::PipelineBindPoint::Graphics,
                p.pipeline_layout,
                0,
                &[set],
                &[(n * self.uniform_stride) as u32],
            );
            let buffer_info_for_actor = vk::DescriptorBufferInfo {
                buffer: self.uniform_buffers[slot].handle,
                offset: 0,
                range: self.compiled.abi.uniform_size as u64,
            };
            let water = name == "gbuffers_water";
            let (buffer, count) = if is_geo {
                if water {
                    (&self.water, self.water_count)
                } else {
                    (&self.solid, self.solid_count)
                }
            } else {
                (&self.fullscreen, 6)
            };
            if is_actor(&name) {
                let source_name = p.program.source_name.clone();
                let active_uniforms = p.program.active_uniforms.clone();
                let samplers = p.program.samplers.clone();
                let mut updated_textures = std::collections::HashSet::new();
                let mut evidence = GeometryStage {
                    requested: name.clone(),
                    resolved: source_name.clone(),
                    ..Default::default()
                };
                let allowed = !is_shadow
                    || self
                        .pack
                        .properties
                        .get(if name == "shadow_entities" {
                            "shadowEntities"
                        } else {
                            "shadowBlockEntities"
                        })
                        .is_none_or(|v| v != "false");
                for draw in geometry
                    .draws
                    .iter()
                    .filter(|draw| allowed && actor_stage(draw, &name))
                {
                    let mut actor_values = values.clone();
                    let model = match draw.space {
                        DrawSpace::World { anchor } => {
                            let rotation = if is_shadow { shadow } else { relative };
                            rotation
                                * Mat4::from_translation(
                                    (anchor - input.camera.as_dvec3()).as_vec3(),
                                )
                                * draw.model
                        }
                        DrawSpace::Hand => draw.model,
                    };
                    let proj = if matches!(draw.space, DrawSpace::Hand) {
                        Mat4::from_scale(Vec3::new(1., 1., 0.125))
                            * geometry
                                .hand_projection
                                .context("missing hand projection")?
                    } else if is_shadow {
                        shadow_projection
                    } else {
                        projection
                    };
                    insert_matrix(&mut actor_values, "pomme_ModelViewMatrix", model);
                    insert_matrix(&mut actor_values, "pomme_ProjectionMatrix", proj);
                    actor_values.insert(
                        "pomme_NormalMatrix".into(),
                        Value(
                            Mat3::from_mat4(model)
                                .inverse()
                                .transpose()
                                .to_cols_array()
                                .map(f64::from)
                                .to_vec(),
                        ),
                    );
                    actor_values.insert("pomme_ActorInputs".into(), Value::scalar(1.));
                    actor_values.insert(
                        "pomme_ActorHandedness".into(),
                        Value::scalar(f64::from(model.determinant().signum())),
                    );
                    actor_values.insert(
                        "pomme_ActorLight".into(),
                        Value(draw.light.map(|v| f64::from(v) * 16.).to_vec()),
                    );
                    actor_values.insert(
                        "pomme_ActorTint".into(),
                        Value(draw.tint.map(f64::from).to_vec()),
                    );
                    actor_values.insert(
                        "entityColor".into(),
                        Value(draw.overlay.map(f64::from).to_vec()),
                    );
                    let id = match &draw.material.identity {
                        MaterialIdentity::Entity(name) => self.pack.entity_material_id(name),
                        MaterialIdentity::Block(state) => self.pack.block_material_id(state),
                        MaterialIdentity::Item(name) => self.pack.item_material_id(name),
                    };
                    let (entity_id, block_id, item_id) = match &draw.material.identity {
                        MaterialIdentity::Entity(_) => (id, -1, -1),
                        MaterialIdentity::Block(_) => (-1, id, -1),
                        MaterialIdentity::Item(_) => (-1, -1, id),
                    };
                    for (key, identity) in [
                        ("entityId", entity_id),
                        ("blockEntityId", block_id),
                        ("currentRenderedItemId", item_id),
                    ] {
                        actor_values.insert(key.into(), Value::scalar(f64::from(identity)));
                    }
                    actor_values.insert(
                        "pomme_ActorMaterial".into(),
                        Value(vec![f64::from(id), 0., 0.]),
                    );
                    actor_values.insert(
                        "pomme_AlphaTest".into(),
                        Value::scalar(alpha_threshold(
                            &self.pack,
                            &source_name,
                            draw.material.alpha,
                        )?),
                    );
                    let offset = actor_uniform * self.uniform_stride;
                    let bytes = self.compiled.abi.bytes(&actor_values, &active_uniforms)?;
                    self.uniform_buffers[slot].write(offset, &bytes)?;
                    actor_uniform += 1;
                    let tid = texture_id(&draw.material.texture);
                    let tex = &self.actor_textures[&tid];
                    debug_assert!(Arc::ptr_eq(&tex.source, &draw.material.texture));
                    let image_infos = samplers
                        .iter()
                        .map(|s| -> Result<_> {
                            let t = if matches!(s.name.as_str(), "gtexture" | "texture" | "tex") {
                                &tex.image
                            } else {
                                self.sampler(&self.passes[n].program, s)?
                            };
                            Ok(vk::DescriptorImageInfo {
                                sampler: if s.ty == "sampler2DShadow" {
                                    t.comparison
                                } else {
                                    t.sampling()
                                },
                                image_view: t.view,
                                image_layout: vk::ImageLayout::ShaderReadOnlyOptimal,
                            })
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let p = &mut self.passes[n];
                    let set = if let Some(set) = p.actor_sets.get(&(slot, tid)) {
                        *set
                    } else {
                        let mut sets = [vk::DescriptorSet::null()];
                        self.gpu.device.allocate_descriptor_sets(
                            &vk::DescriptorSetAllocateInfo {
                                descriptor_pool: self.descriptor_pool,
                                descriptor_set_count: 1,
                                set_layouts: &p.layout,
                                ..Default::default()
                            },
                            &mut sets,
                        )?;
                        p.actor_sets.insert((slot, tid), sets[0]);
                        sets[0]
                    };
                    let mut writes = vec![vk::WriteDescriptorSet {
                        dst_set: set,
                        dst_binding: 0,
                        descriptor_count: 1,
                        descriptor_type: vk::DescriptorType::UniformBufferDynamic,
                        buffer_info: &buffer_info_for_actor,
                        ..Default::default()
                    }];
                    for (sampler, info) in p.program.samplers.iter().zip(&image_infos) {
                        writes.push(vk::WriteDescriptorSet {
                            dst_set: set,
                            dst_binding: sampler.binding,
                            descriptor_count: 1,
                            descriptor_type: vk::DescriptorType::CombinedImageSampler,
                            image_info: info,
                            ..Default::default()
                        });
                    }
                    // One descriptor update before its first bind in this pass.
                    // Later parts share image bindings and use distinct dynamic
                    // uniform offsets. Updating a bound set would invalidate
                    // the command buffer without UPDATE_AFTER_BIND.
                    if updated_textures.insert(tid) {
                        self.gpu.device.update_descriptor_sets(&writes, &[]);
                    }
                    cmd.bind_descriptor_sets(
                        vk::PipelineBindPoint::Graphics,
                        p.pipeline_layout,
                        0,
                        &[set],
                        &[offset as u32],
                    );
                    let mesh = &self.actor_meshes[&mesh_id(&draw.mesh)];
                    debug_assert!(Arc::ptr_eq(&mesh.source, &draw.mesh));
                    cmd.bind_vertex_buffers(0, &[mesh.buffer.handle], &[0]);
                    let count = draw.range.end - draw.range.start;
                    cmd.draw(count, 1, draw.range.start, 0);
                    evidence.draws += 1;
                    evidence.vertices += count as usize;
                    if !evidence.material_ids.contains(&id) {
                        evidence.material_ids.push(id);
                    }
                }
                self.geometry_stages.push(evidence);
            } else {
                cmd.bind_vertex_buffers(0, &[buffer.handle], &[0]);
                cmd.draw(count, 1, 0, 0);
            }
            cmd.end_render_pass();
            let p = &self.passes[n];
            for t in &targets {
                t.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
            }
            if let Some(depth) = depth {
                depth.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
            }
            if is_shadow {
                self.shadows[0].copy_to(cmd, &self.shadows[1]);
            } else if name == "gbuffers_block" {
                self.depths[0].copy_to(cmd, &self.depths[2]);
            } else if name == "gbuffers_hand" {
                self.depths[0].copy_to(cmd, &self.depths[1]);
            } else if !is_geo && name != "final" {
                for i in &p.program.targets {
                    if self
                        .pack
                        .properties
                        .get(&format!("flip.{name}.colortex{i}"))
                        .is_none_or(|s| s != "false")
                    {
                        self.colors[*i].front = 1 - self.colors[*i].front;
                    }
                }
                for (key, value) in &self.pack.properties {
                    if key.starts_with(&format!("flip.{name}.")) && value == "true" {
                        let i: usize = key
                            .rsplit('.')
                            .next()
                            .unwrap()
                            .trim_start_matches("colortex")
                            .parse()?;
                        if !p.program.targets.contains(&i) {
                            self.colors[i].front = 1 - self.colors[i].front;
                        }
                    }
                }
            }
            cmd.write_timestamp(
                vk::PipelineStageFlags::BottomOfPipe,
                query,
                step as u32 * 2 + 1,
            );
            self.cpu_timings[slot].push(cpu_start.elapsed().as_secs_f64() * 1000.);
        }
        self.setup_done = true;
        self.previous = Some(input.clone());
        self.previous_view = relative;
        self.previous_projection = projection;
        Ok(())
    }
    pub fn timings(&self, slot: usize) -> Result<Vec<PassTiming>> {
        let mut bytes = vec![0; self.execution.len() * 2 * 8];
        self.gpu.device.get_query_pool_results(
            self.query_pools[slot],
            0,
            self.execution.len() as u32 * 2,
            &mut bytes,
            8,
            vk::QueryResultFlags::Type64 | vk::QueryResultFlags::Wait,
        )?;
        let timestamps = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| u64::from_le_bytes(*b))
            .collect::<Vec<_>>();
        let period = self.gpu.physical.get_properties().limits.timestamp_period as f64;
        let bits = self.gpu.physical.get_queue_family_properties()[self.gpu.queue_family as usize]
            .timestamp_valid_bits;
        Ok(self
            .execution
            .iter()
            .enumerate()
            .map(|(i, p)| PassTiming {
                pass: self.execution_name(*p).to_owned(),
                gpu_ms: timestamp_elapsed(timestamps[2 * i], timestamps[2 * i + 1], bits) as f64
                    * period
                    / 1e6,
                cpu_submit_ms: self.cpu_timings[slot][i],
            })
            .collect())
    }
    pub fn screenshot(&self, path: &Path) -> Result<()> {
        let mut img = image::RgbaImage::from_raw(self.width, self.height, self.output.readback()?)
            .context("invalid Vulkan screenshot")?;
        image::imageops::flip_vertical_in_place(&mut img);
        img.save(path)?;
        Ok(())
    }
    pub fn pass_names(&self) -> Vec<String> {
        self.execution
            .iter()
            .map(|e| self.execution_name(*e).to_owned())
            .collect()
    }
    pub fn compute_manifest(&self) -> serde_json::Value {
        serde_json::Value::Array(
            self.computes
                .iter()
                .map(|p| {
                    let crate::compute::Dispatch::Fixed(groups) = p.program.dispatch;
                    serde_json::json!({"program":p.program.name,"base":p.program.base,
                "groups":groups,"local_size":p.program.local_size,
                "shared_memory_logical_bytes":p.program.shared_memory_bytes,
                "shared_memory_driver_allocation_bytes":null,
                "spirv_capabilities":p.program.capabilities,
                "samplers":p.program.samplers,"images":p.program.images})
                })
                .collect(),
        )
    }
    pub fn depth_image(&self) -> &Image {
        &self.depths[0]
    }
    /// Current color-buffer front for explicit diagnostics after completion.
    pub fn color_snapshot(&self, index: usize) -> Option<&Image> {
        self.colors
            .get(index)
            .map(|color| &color.images[color.front])
    }
    /// depthtex0: complete world, depthtex1: pre-translucent (including solid
    /// hand), depthtex2: opaque world before the hand, matching Iris.
    pub fn depth_snapshot(&self, index: usize) -> Option<&Image> {
        self.depths.get(index)
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let d = &self.gpu.device;
        let _ = d.wait_idle();
        for p in &self.passes {
            for f in p.framebuffers.values() {
                d.destroy_framebuffer(*f, None);
            }
            d.destroy_pipeline(p.pipeline, None);
            d.destroy_render_pass(p.render_pass, None);
            d.destroy_pipeline_layout(p.pipeline_layout, None);
            d.destroy_descriptor_set_layout(p.layout, None);
        }
        for p in &self.computes {
            d.destroy_pipeline(p.pipeline, None);
            d.destroy_pipeline_layout(p.pipeline_layout, None);
            d.destroy_descriptor_set_layout(p.layout, None);
        }
        d.destroy_descriptor_pool(self.descriptor_pool, None);
        for p in &self.query_pools {
            d.destroy_query_pool(*p, None);
        }
    }
}

fn insert_matrix(values: &mut std::collections::BTreeMap<String, Value>, name: &str, matrix: Mat4) {
    values.insert(
        name.into(),
        Value(matrix.to_cols_array().map(f64::from).to_vec()),
    );
}
fn actor_stage(draw: &crate::geometry::Draw, stage: &str) -> bool {
    let blend = draw.material.alpha == AlphaMode::Blend;
    match (&draw.space, &draw.material.identity) {
        (DrawSpace::Hand, _) => {
            stage
                == if blend {
                    "gbuffers_hand_water"
                } else {
                    "gbuffers_hand"
                }
        }
        (DrawSpace::World { .. }, MaterialIdentity::Entity(_)) => {
            stage == "shadow_entities"
                || stage
                    == if blend {
                        "gbuffers_entities_translucent"
                    } else {
                        "gbuffers_entities"
                    }
        }
        (DrawSpace::World { .. }, MaterialIdentity::Block(_)) => {
            stage == "shadow_block"
                || stage
                    == if blend {
                        "gbuffers_block_translucent"
                    } else {
                        "gbuffers_block"
                    }
        }
        _ => false,
    }
}
fn alpha_threshold(pack: &Pack, source: &str, alpha: AlphaMode) -> Result<f64> {
    if let Some(value) = pack.properties.get(&format!("alphaTest.{source}")) {
        if value.eq_ignore_ascii_case("off") {
            return Ok(-1.);
        }
        let fields = value.split_whitespace().collect::<Vec<_>>();
        ensure!(
            fields.len() == 2 && fields[0] == "GREATER",
            "unsupported alpha-test function {value}"
        );
        return Ok(fields[1].parse()?);
    }
    Ok(match alpha {
        AlphaMode::Cutout(value) => f64::from(value),
        _ => -1.,
    })
}

fn render_pass(d: &vk::Device, formats: &[vk::Format], depth: bool) -> Result<vk::RenderPass> {
    let mut attachments = formats
        .iter()
        .map(|format| vk::AttachmentDescription {
            format: *format,
            samples: vk::SampleCountFlags::Type1,
            load_op: vk::AttachmentLoadOp::Load,
            store_op: vk::AttachmentStoreOp::Store,
            initial_layout: vk::ImageLayout::ColorAttachmentOptimal,
            final_layout: vk::ImageLayout::ColorAttachmentOptimal,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    if depth {
        attachments.push(vk::AttachmentDescription {
            format: vk::Format::D32Sfloat,
            samples: vk::SampleCountFlags::Type1,
            load_op: vk::AttachmentLoadOp::Load,
            store_op: vk::AttachmentStoreOp::Store,
            initial_layout: vk::ImageLayout::DepthStencilAttachmentOptimal,
            final_layout: vk::ImageLayout::DepthStencilAttachmentOptimal,
            ..Default::default()
        });
    }
    let refs = (0..formats.len())
        .map(|i| vk::AttachmentReference {
            attachment: i as u32,
            layout: vk::ImageLayout::ColorAttachmentOptimal,
        })
        .collect::<Vec<_>>();
    let depth_ref = vk::AttachmentReference {
        attachment: formats.len() as u32,
        layout: vk::ImageLayout::DepthStencilAttachmentOptimal,
    };
    let subpass = vk::SubpassDescription {
        pipeline_bind_point: vk::PipelineBindPoint::Graphics,
        color_attachment_count: refs.len() as u32,
        color_attachments: refs.as_ptr(),
        depth_stencil_attachment: if depth { &depth_ref } else { std::ptr::null() },
        ..Default::default()
    };
    Ok(d.create_render_pass(
        &vk::RenderPassCreateInfo {
            attachment_count: attachments.len() as u32,
            attachments: attachments.as_ptr(),
            subpass_count: 1,
            subpasses: &subpass,
            ..Default::default()
        },
        None,
    )?)
}
fn blend_state(value: Option<&str>) -> Result<vk::PipelineColorBlendAttachmentState> {
    let mut out = vk::PipelineColorBlendAttachmentState {
        color_write_mask: vk::ColorComponentFlags::R
            | vk::ColorComponentFlags::G
            | vk::ColorComponentFlags::B
            | vk::ColorComponentFlags::A,
        color_blend_op: vk::BlendOp::Add,
        alpha_blend_op: vk::BlendOp::Add,
        ..Default::default()
    };
    if let Some(value) = value.filter(|v| *v != "off") {
        let factor = |s| -> Result<_> {
            Ok(match s {
                "ZERO" => vk::BlendFactor::Zero,
                "ONE" => vk::BlendFactor::One,
                "SRC_COLOR" => vk::BlendFactor::SrcColor,
                "ONE_MINUS_SRC_COLOR" => vk::BlendFactor::OneMinusSrcColor,
                "DST_COLOR" => vk::BlendFactor::DstColor,
                "ONE_MINUS_DST_COLOR" => vk::BlendFactor::OneMinusDstColor,
                "SRC_ALPHA" => vk::BlendFactor::SrcAlpha,
                "ONE_MINUS_SRC_ALPHA" => vk::BlendFactor::OneMinusSrcAlpha,
                "DST_ALPHA" => vk::BlendFactor::DstAlpha,
                "ONE_MINUS_DST_ALPHA" => vk::BlendFactor::OneMinusDstAlpha,
                "SRC_ALPHA_SATURATE" => vk::BlendFactor::SrcAlphaSaturate,
                _ => anyhow::bail!("unsupported blend factor {s}"),
            })
        };
        let v = value
            .split_whitespace()
            .map(factor)
            .collect::<Result<Vec<_>>>()?;
        ensure!(v.len() == 2 || v.len() == 4, "invalid blend factors");
        out.blend_enable = vk::TRUE;
        out.src_color_blend_factor = v[0];
        out.dst_color_blend_factor = v[1];
        out.src_alpha_blend_factor = v[v.len() - 2];
        out.dst_alpha_blend_factor = v[v.len() - 1];
    }
    Ok(out)
}
pub(crate) fn pipeline(
    d: &vk::Device,
    rp: vk::RenderPass,
    layout: vk::PipelineLayout,
    vs: &[u32],
    fs: &[u32],
    blend: &[vk::PipelineColorBlendAttachmentState],
    depth: bool,
) -> Result<vk::Pipeline> {
    let vertex = d.create_shader_module(
        &vk::ShaderModuleCreateInfo {
            code_size: std::mem::size_of_val(vs),
            code: vs.as_ptr(),
            ..Default::default()
        },
        None,
    )?;
    let fragment = match d.create_shader_module(
        &vk::ShaderModuleCreateInfo {
            code_size: std::mem::size_of_val(fs),
            code: fs.as_ptr(),
            ..Default::default()
        },
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            d.destroy_shader_module(vertex, None);
            return Err(e.into());
        }
    };
    let stages = [
        vk::PipelineShaderStageCreateInfo {
            stage: vk::ShaderStageFlags::Vertex,
            module: vertex,
            name: c"main".as_ptr(),
            ..Default::default()
        },
        vk::PipelineShaderStageCreateInfo {
            stage: vk::ShaderStageFlags::Fragment,
            module: fragment,
            name: c"main".as_ptr(),
            ..Default::default()
        },
    ];
    let binding = vk::VertexInputBindingDescription {
        binding: 0,
        stride: size_of::<Vertex>() as u32,
        input_rate: vk::VertexInputRate::Vertex,
    };
    let locations = super::abi::input_locations(vs);
    ensure!(
        locations.iter().all(|i| *i < 8),
        "active vertex attribute lacks Vulkan host data: {locations:?}"
    );
    let attrs = [
        (vk::Format::R32G32B32Sfloat, offset_of!(Vertex, position)),
        (vk::Format::R32G32B32Sfloat, offset_of!(Vertex, normal)),
        (vk::Format::R32G32Sfloat, offset_of!(Vertex, uv)),
        (vk::Format::R32G32Sfloat, offset_of!(Vertex, light)),
        (vk::Format::R32G32B32A32Sfloat, offset_of!(Vertex, color)),
        (vk::Format::R32G32B32A32Sfloat, offset_of!(Vertex, tangent)),
        (vk::Format::R32G32B32Sfloat, offset_of!(Vertex, material)),
        (vk::Format::R32G32Sfloat, offset_of!(Vertex, mid_uv)),
    ]
    .into_iter()
    .enumerate()
    .filter(|(i, _)| locations.contains(&(*i as u32)))
    .map(
        |(i, (format, offset))| vk::VertexInputAttributeDescription {
            location: i as u32,
            binding: 0,
            format,
            offset: offset as u32,
        },
    )
    .collect::<Vec<_>>();
    let input = vk::PipelineVertexInputStateCreateInfo {
        vertex_binding_description_count: 1,
        vertex_binding_descriptions: &binding,
        vertex_attribute_description_count: attrs.len() as u32,
        vertex_attribute_descriptions: attrs.as_ptr(),
        ..Default::default()
    };
    let assembly = vk::PipelineInputAssemblyStateCreateInfo {
        topology: vk::PrimitiveTopology::TriangleList,
        ..Default::default()
    };
    let viewport = vk::PipelineViewportStateCreateInfo {
        viewport_count: 1,
        scissor_count: 1,
        ..Default::default()
    };
    let raster = vk::PipelineRasterizationStateCreateInfo {
        polygon_mode: vk::PolygonMode::Fill,
        cull_mode: vk::CullModeFlags::empty(),
        front_face: vk::FrontFace::CounterClockwise,
        line_width: 1.,
        ..Default::default()
    };
    let multisample = vk::PipelineMultisampleStateCreateInfo {
        rasterization_samples: vk::SampleCountFlags::Type1,
        ..Default::default()
    };
    let ds = vk::PipelineDepthStencilStateCreateInfo {
        depth_test_enable: if depth { vk::TRUE } else { vk::FALSE },
        depth_write_enable: if depth { vk::TRUE } else { vk::FALSE },
        depth_compare_op: vk::CompareOp::LessOrEqual,
        ..Default::default()
    };
    let bs = vk::PipelineColorBlendStateCreateInfo {
        attachment_count: blend.len() as u32,
        attachments: blend.as_ptr(),
        ..Default::default()
    };
    let states = [vk::DynamicState::Viewport, vk::DynamicState::Scissor];
    let dynamic = vk::PipelineDynamicStateCreateInfo {
        dynamic_state_count: 2,
        dynamic_states: states.as_ptr(),
        ..Default::default()
    };
    let info = vk::GraphicsPipelineCreateInfo {
        stage_count: 2,
        stages: stages.as_ptr(),
        vertex_input_state: &input,
        input_assembly_state: &assembly,
        viewport_state: &viewport,
        rasterization_state: &raster,
        multisample_state: &multisample,
        depth_stencil_state: &ds,
        color_blend_state: &bs,
        dynamic_state: &dynamic,
        layout,
        render_pass: rp,
        ..Default::default()
    };
    let mut pipeline = vk::Pipeline::null();
    let result = d.create_graphics_pipelines(
        vk::PipelineCache::null(),
        &[info],
        None,
        std::slice::from_mut(&mut pipeline),
    );
    d.destroy_shader_module(vertex, None);
    d.destroy_shader_module(fragment, None);
    if let Err(e) = result {
        d.destroy_pipeline(pipeline, None);
        return Err(e.into());
    }
    Ok(pipeline)
}

fn blend_key(
    b: &vk::PipelineColorBlendAttachmentState,
) -> (
    u32,
    vk::BlendFactor,
    vk::BlendFactor,
    vk::BlendOp,
    vk::BlendFactor,
    vk::BlendFactor,
    vk::BlendOp,
    vk::ColorComponentFlags,
) {
    (
        b.blend_enable,
        b.src_color_blend_factor,
        b.dst_color_blend_factor,
        b.color_blend_op,
        b.src_alpha_blend_factor,
        b.dst_alpha_blend_factor,
        b.alpha_blend_op,
        b.color_write_mask,
    )
}

#[cfg(test)]
mod compute_order_tests {
    use super::{Execution, execution_order, timestamp_elapsed};

    #[test]
    fn timestamps_wrap_at_the_queue_counter_width() {
        assert_eq!(timestamp_elapsed(u32::MAX as u64 - 2, 2, 32), 5);
        assert_eq!(timestamp_elapsed(u64::MAX - 2, 2, 64), 5);
        assert_eq!(timestamp_elapsed((1u64 << 40) - 3, 2, 40), 5);
        assert_eq!(timestamp_elapsed(7, 19, 32), 12);
    }

    #[test]
    fn standalone_computes_and_suffixes_run_before_associated_fragments() {
        let graphics = [
            "begin",
            "shadow",
            "shadow_entities",
            "shadowcomp",
            "prepare",
            "gbuffers_terrain",
            "deferred2",
            "gbuffers_water",
            "composite",
            "final",
        ];
        let computes = [
            "setup",
            "begin",
            "shadowcomp",
            "prepare",
            "deferred1",
            "deferred2",
            "deferred2",
            "composite",
        ];
        assert_eq!(
            execution_order(&graphics, &computes).unwrap(),
            vec![
                Execution::Compute(0),
                Execution::Compute(1),
                Execution::Graphics(0),
                Execution::Graphics(1),
                Execution::Graphics(2),
                Execution::Compute(2),
                Execution::Graphics(3),
                Execution::Compute(3),
                Execution::Graphics(4),
                Execution::Graphics(5),
                Execution::Compute(4),
                Execution::Compute(5),
                Execution::Compute(6),
                Execution::Graphics(6),
                Execution::Graphics(7),
                Execution::Compute(7),
                Execution::Graphics(8),
                Execution::Graphics(9),
            ]
        );
        assert!(execution_order(&["unexpected"], &[]).is_err());
        assert!(execution_order(&[], &["deferred100"]).is_err());
    }
}
