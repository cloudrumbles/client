//! GPU-only composition into the game's compatible render pass, with matching
//! depth and explicit display-color conversion. No window or CPU pixel bridge.
use anyhow::Result;
use pyronyx::vk;

use super::engine::{pipeline, screen_vertices, vertex_bytes};
use super::resource::{Buffer, Gpu, Image};
pub struct Presenter {
    gpu: Gpu,
    pipeline: vk::Pipeline,
    layout: vk::PipelineLayout,
    descriptor_layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    sets: Vec<vk::DescriptorSet>,
    vertices: Buffer,
}
impl Presenter {
    pub fn new(gpu: Gpu, render_pass: vk::RenderPass, srgb: bool, slots: usize) -> Result<Self> {
        let bindings = [0, 1].map(|binding| vk::DescriptorSetLayoutBinding {
            binding,
            descriptor_type: vk::DescriptorType::CombinedImageSampler,
            descriptor_count: 1,
            stage_flags: vk::ShaderStageFlags::Fragment,
            ..Default::default()
        });
        let descriptor_layout = gpu.device.create_descriptor_set_layout(
            &vk::DescriptorSetLayoutCreateInfo {
                binding_count: 2,
                bindings: bindings.as_ptr(),
                ..Default::default()
            },
            None,
        )?;
        let vertices = Buffer::new(
            &gpu,
            vertex_bytes(&screen_vertices()),
            vk::BufferUsageFlags::VertexBuffer,
        )?;
        let mut out = Self {
            gpu,
            pipeline: vk::Pipeline::null(),
            layout: vk::PipelineLayout::null(),
            descriptor_layout,
            pool: vk::DescriptorPool::null(),
            sets: Vec::new(),
            vertices,
        };
        let d = &out.gpu.device;
        out.layout = d.create_pipeline_layout(
            &vk::PipelineLayoutCreateInfo {
                set_layout_count: 1,
                set_layouts: &descriptor_layout,
                ..Default::default()
            },
            None,
        )?;
        let size = vk::DescriptorPoolSize {
            ty: vk::DescriptorType::CombinedImageSampler,
            descriptor_count: slots as u32 * 2,
        };
        out.pool = d.create_descriptor_pool(
            &vk::DescriptorPoolCreateInfo {
                max_sets: slots as u32,
                pool_size_count: 1,
                pool_sizes: &size,
                ..Default::default()
            },
            None,
        )?;
        let layouts = vec![descriptor_layout; slots];
        out.sets = vec![vk::DescriptorSet::null(); slots];
        d.allocate_descriptor_sets(
            &vk::DescriptorSetAllocateInfo {
                descriptor_pool: out.pool,
                descriptor_set_count: slots as u32,
                set_layouts: layouts.as_ptr(),
                ..Default::default()
            },
            &mut out.sets,
        )?;
        let compiler = shaderc::Compiler::new()?;
        let mut options = shaderc::CompileOptions::new()?;
        options.set_target_env(
            shaderc::TargetEnv::Vulkan,
            shaderc::EnvVersion::Vulkan1_2 as u32,
        );
        let vs=compiler.compile_into_spirv("#version 450\nlayout(location=0) in vec3 position;layout(location=0) out vec2 uv;void main(){uv=position.xy;gl_Position=vec4(position.xy*2.-1.,0.,1.);}",shaderc::ShaderKind::Vertex,"pack-present.vert","main",Some(&options))?;
        let fs = format!(
            "#version 450\nlayout(set=0,binding=0) uniform sampler2D scene;layout(set=0,binding=1) uniform sampler2D depth;layout(location=0) in vec2 uv;layout(location=0) out vec4 color;void main(){{vec4 c=texture(scene,uv);{} color=c;gl_FragDepth=texture(depth,uv).r;}}",
            if srgb {
                "c.rgb=mix(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c.rgb));"
            } else {
                ""
            }
        );
        let fs = compiler.compile_into_spirv(
            &fs,
            shaderc::ShaderKind::Fragment,
            "pack-present.frag",
            "main",
            Some(&options),
        )?;
        let blend = vk::PipelineColorBlendAttachmentState {
            color_write_mask: vk::ColorComponentFlags::R
                | vk::ColorComponentFlags::G
                | vk::ColorComponentFlags::B
                | vk::ColorComponentFlags::A,
            ..Default::default()
        };
        out.pipeline = pipeline(
            d,
            render_pass,
            out.layout,
            vs.as_binary(),
            fs.as_binary(),
            &[blend],
            true,
        )?;
        Ok(out)
    }
    /// Called before beginning the main render pass, after its frame fence.
    pub fn prepare(&self, cmd: &vk::CommandBuffer, slot: usize, color: &Image, depth: &Image) {
        color.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
        depth.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
        let images = [color, depth].map(|t| vk::DescriptorImageInfo {
            sampler: t.sampler,
            image_view: t.view,
            image_layout: vk::ImageLayout::ShaderReadOnlyOptimal,
        });
        let writes = images
            .iter()
            .enumerate()
            .map(|(i, info)| vk::WriteDescriptorSet {
                dst_set: self.sets[slot],
                dst_binding: i as u32,
                descriptor_count: 1,
                descriptor_type: vk::DescriptorType::CombinedImageSampler,
                image_info: info,
                ..Default::default()
            })
            .collect::<Vec<_>>();
        self.gpu.device.update_descriptor_sets(&writes, &[]);
    }
    /// Inside the game's main render pass; restore its viewport afterwards.
    pub fn draw(&self, cmd: &vk::CommandBuffer, slot: usize, extent: vk::Extent2D) {
        cmd.set_viewport(
            0,
            &[vk::Viewport {
                x: 0.,
                y: extent.height as f32,
                width: extent.width as f32,
                height: -(extent.height as f32),
                min_depth: 0.,
                max_depth: 1.,
            }],
        );
        cmd.bind_pipeline(vk::PipelineBindPoint::Graphics, self.pipeline);
        cmd.bind_descriptor_sets(
            vk::PipelineBindPoint::Graphics,
            self.layout,
            0,
            &[self.sets[slot]],
            &[],
        );
        cmd.bind_vertex_buffers(0, &[self.vertices.handle], &[0]);
        cmd.draw(6, 1, 0, 0);
    }
}
impl Drop for Presenter {
    fn drop(&mut self) {
        let d = &self.gpu.device;
        let _ = d.wait_idle();
        d.destroy_pipeline(self.pipeline, None);
        d.destroy_pipeline_layout(self.layout, None);
        d.destroy_descriptor_pool(self.pool, None);
        d.destroy_descriptor_set_layout(self.descriptor_layout, None);
    }
}
