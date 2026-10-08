use std::cell::Cell;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, ensure};
use pomme_gpu_allocator::MemoryLocation;
use pomme_gpu_allocator::vulkan::{Allocation, AllocationCreateDesc, AllocationScheme, Allocator};
use pyronyx::vk;

#[derive(Clone)]
pub struct Gpu {
    pub device: vk::Device,
    pub physical: vk::PhysicalDevice,
    pub allocator: Arc<Mutex<Allocator>>,
    pub queue: vk::Queue,
    pub pool: vk::CommandPool,
    pub independent_blend: bool,
}
impl Gpu {
    pub fn submit(&self, record: impl FnOnce(&vk::CommandBuffer) -> Result<()>) -> Result<()> {
        let info = vk::CommandBufferAllocateInfo {
            command_pool: self.pool,
            level: vk::CommandBufferLevel::Primary,
            command_buffer_count: 1,
            ..Default::default()
        };
        let mut cmd = vk::CommandBuffer::null();
        unsafe {
            self.device
                .allocate_command_buffers(&info, std::slice::from_mut(&mut cmd))?;
        }
        let result = (|| {
            cmd.begin(&vk::CommandBufferBeginInfo {
                flags: vk::CommandBufferUsageFlags::OneTimeSubmit,
                ..Default::default()
            })?;
            record(&cmd)?;
            cmd.end()?;
            self.queue.submit(
                &[vk::SubmitInfo {
                    command_buffer_count: 1,
                    command_buffers: &cmd.handle(),
                    ..Default::default()
                }],
                vk::Fence::null(),
            )?;
            self.queue.wait_idle()?;
            Ok(())
        })();
        self.device.free_command_buffers(self.pool, &[cmd.handle()]);
        result
    }
}
pub struct Buffer {
    gpu: Gpu,
    pub handle: vk::Buffer,
    allocation: Option<Allocation>,
    pub size: usize,
}
impl Buffer {
    pub fn new(gpu: &Gpu, bytes: &[u8], usage: vk::BufferUsageFlags) -> Result<Self> {
        let size = bytes.len().max(16);
        let handle = gpu.device.create_buffer(
            &vk::BufferCreateInfo {
                size: size as u64,
                usage,
                sharing_mode: vk::SharingMode::Exclusive,
                ..Default::default()
            },
            None,
        )?;
        let mut out = Self {
            gpu: gpu.clone(),
            handle,
            allocation: None,
            size,
        };
        let allocation = gpu
            .allocator
            .lock()
            .unwrap()
            .allocate(&AllocationCreateDesc {
                name: "shader pack buffer",
                requirements: gpu.device.get_buffer_memory_requirements(handle),
                location: MemoryLocation::CpuToGpu,
                linear: true,
                allocation_scheme: AllocationScheme::GpuAllocatorManaged,
            })?;
        out.allocation = Some(allocation);
        let a = out.allocation.as_ref().unwrap();
        unsafe {
            gpu.device
                .bind_buffer_memory(handle, a.memory(), a.offset())?;
        }
        out.write(0, bytes)?;
        Ok(out)
    }
    pub fn write(&mut self, offset: usize, bytes: &[u8]) -> Result<()> {
        ensure!(
            offset
                .checked_add(bytes.len())
                .is_some_and(|end| end <= self.size),
            "buffer write outside allocation"
        );
        let a = self
            .allocation
            .as_mut()
            .context("missing buffer allocation")?;
        a.mapped_slice_mut()
            .context("buffer memory is not mapped")?[offset..offset + bytes.len()]
            .copy_from_slice(bytes);
        if !a
            .memory_properties()
            .contains(vk::MemoryPropertyFlags::HostCoherent)
        {
            self.gpu
                .device
                .flush_mapped_memory_ranges(&[vk::MappedMemoryRange {
                    memory: unsafe { a.memory() },
                    offset: 0,
                    size: vk::WHOLE_SIZE,
                    ..Default::default()
                }])?;
        }
        Ok(())
    }
    pub fn bytes(&self) -> Result<&[u8]> {
        let a = self
            .allocation
            .as_ref()
            .context("missing buffer allocation")?;
        if !a
            .memory_properties()
            .contains(vk::MemoryPropertyFlags::HostCoherent)
        {
            self.gpu
                .device
                .invalidate_mapped_memory_ranges(&[vk::MappedMemoryRange {
                    memory: unsafe { a.memory() },
                    offset: 0,
                    size: vk::WHOLE_SIZE,
                    ..Default::default()
                }])?;
        }
        Ok(&a.mapped_slice().context("unmapped buffer")?[..self.size])
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        self.gpu.device.destroy_buffer(self.handle, None);
        if let Some(a) = self.allocation.take() {
            let _ = self.gpu.allocator.lock().unwrap().free(a);
        }
    }
}
pub struct Image {
    gpu: Gpu,
    pub handle: vk::Image,
    pub view: vk::ImageView,
    pub attachment: vk::ImageView,
    pub sampler: vk::Sampler,
    mip_sampler: vk::Sampler,
    mipped: Cell<bool>,
    pub comparison: vk::Sampler,
    pub format: vk::Format,
    pub extent: vk::Extent3D,
    pub levels: u32,
    pub depth: bool,
    layout: Cell<vk::ImageLayout>,
    allocation: Option<Allocation>,
}
impl Image {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        gpu: &Gpu,
        extent: vk::Extent3D,
        format: vk::Format,
        levels: u32,
        render: bool,
        blur: bool,
        clamp: bool,
    ) -> Result<Self> {
        let depth = format == vk::Format::D32Sfloat;
        let props = gpu.physical.get_format_properties(format);
        let required = vk::FormatFeatureFlags::SampledImage
            | if render {
                if depth {
                    vk::FormatFeatureFlags::DepthStencilAttachment
                } else {
                    vk::FormatFeatureFlags::ColorAttachment
                }
            } else {
                vk::FormatFeatureFlags::empty()
            };
        ensure!(
            props.optimal_tiling_features.contains(required),
            "unsupported required Vulkan texture format {format:?}"
        );
        let usage = vk::ImageUsageFlags::Sampled
            | vk::ImageUsageFlags::TransferSrc
            | vk::ImageUsageFlags::TransferDst
            | if render {
                if depth {
                    vk::ImageUsageFlags::DepthStencilAttachment
                } else {
                    vk::ImageUsageFlags::ColorAttachment
                }
            } else {
                vk::ImageUsageFlags::empty()
            };
        let handle = gpu.device.create_image(
            &vk::ImageCreateInfo {
                image_type: if extent.depth > 1 {
                    vk::ImageType::Type3D
                } else {
                    vk::ImageType::Type2D
                },
                format,
                extent,
                mip_levels: levels,
                array_layers: 1,
                samples: vk::SampleCountFlags::Type1,
                tiling: vk::ImageTiling::Optimal,
                usage,
                ..Default::default()
            },
            None,
        )?;
        let mut out = Self {
            gpu: gpu.clone(),
            handle,
            view: vk::ImageView::null(),
            attachment: vk::ImageView::null(),
            sampler: vk::Sampler::null(),
            mip_sampler: vk::Sampler::null(),
            mipped: Cell::new(false),
            comparison: vk::Sampler::null(),
            format,
            extent,
            levels,
            depth,
            layout: Cell::new(vk::ImageLayout::Undefined),
            allocation: None,
        };
        out.allocation = Some(
            gpu.allocator
                .lock()
                .unwrap()
                .allocate(&AllocationCreateDesc {
                    name: "shader pack image",
                    requirements: gpu.device.get_image_memory_requirements(handle),
                    location: MemoryLocation::GpuOnly,
                    linear: false,
                    allocation_scheme: AllocationScheme::GpuAllocatorManaged,
                })?,
        );
        let a = out.allocation.as_ref().unwrap();
        unsafe {
            gpu.device
                .bind_image_memory(handle, a.memory(), a.offset())?;
        }
        let info = vk::ImageViewCreateInfo {
            image: handle,
            view_type: if extent.depth > 1 {
                vk::ImageViewType::Type3D
            } else {
                vk::ImageViewType::Type2D
            },
            format,
            subresource_range: out.range(),
            ..Default::default()
        };
        out.view = gpu.device.create_image_view(&info, None)?;
        out.attachment = gpu.device.create_image_view(
            &vk::ImageViewCreateInfo {
                subresource_range: vk::ImageSubresourceRange {
                    level_count: 1,
                    ..out.range()
                },
                ..info
            },
            None,
        )?;
        let address = if clamp {
            vk::SamplerAddressMode::ClampToEdge
        } else {
            vk::SamplerAddressMode::Repeat
        };
        let info = vk::SamplerCreateInfo {
            mag_filter: if blur {
                vk::Filter::Linear
            } else {
                vk::Filter::Nearest
            },
            min_filter: if blur {
                vk::Filter::Linear
            } else {
                vk::Filter::Nearest
            },
            mipmap_mode: vk::SamplerMipmapMode::Nearest,
            address_mode_u: address,
            address_mode_v: address,
            address_mode_w: address,
            max_lod: 0.,
            ..Default::default()
        };
        out.sampler = gpu.device.create_sampler(&info, None)?;
        out.mip_sampler = gpu.device.create_sampler(
            &vk::SamplerCreateInfo {
                max_lod: (levels - 1) as f32,
                ..info
            },
            None,
        )?;
        if depth {
            out.comparison = gpu.device.create_sampler(
                &vk::SamplerCreateInfo {
                    compare_enable: vk::TRUE,
                    compare_op: vk::CompareOp::LessOrEqual,
                    ..info
                },
                None,
            )?;
        }
        Ok(out)
    }
    pub fn sampling(&self) -> vk::Sampler {
        if self.mipped.get() {
            self.mip_sampler
        } else {
            self.sampler
        }
    }
    pub fn range(&self) -> vk::ImageSubresourceRange {
        vk::ImageSubresourceRange {
            aspect_mask: if self.depth {
                vk::ImageAspectFlags::Depth
            } else {
                vk::ImageAspectFlags::Color
            },
            base_mip_level: 0,
            level_count: self.levels,
            base_array_layer: 0,
            layer_count: 1,
        }
    }
    pub fn layers(&self) -> vk::ImageSubresourceLayers {
        vk::ImageSubresourceLayers {
            aspect_mask: self.range().aspect_mask,
            mip_level: 0,
            base_array_layer: 0,
            layer_count: 1,
        }
    }
    pub fn transition(&self, cmd: &vk::CommandBuffer, layout: vk::ImageLayout) {
        let old = self.layout.replace(layout);
        let barrier = vk::ImageMemoryBarrier {
            image: self.handle,
            old_layout: old,
            new_layout: layout,
            src_access_mask: if old == vk::ImageLayout::Undefined {
                vk::AccessFlags::empty()
            } else {
                vk::AccessFlags::MemoryRead | vk::AccessFlags::MemoryWrite
            },
            dst_access_mask: vk::AccessFlags::MemoryRead | vk::AccessFlags::MemoryWrite,
            src_queue_family_index: vk::QUEUE_FAMILY_IGNORED,
            dst_queue_family_index: vk::QUEUE_FAMILY_IGNORED,
            subresource_range: self.range(),
            ..Default::default()
        };
        cmd.pipeline_barrier(
            vk::PipelineStageFlags::AllCommands,
            vk::PipelineStageFlags::AllCommands,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[barrier],
        );
    }
    pub fn clear(&self, cmd: &vk::CommandBuffer, color: [f32; 4]) {
        self.transition(cmd, vk::ImageLayout::TransferDstOptimal);
        if self.depth {
            cmd.clear_depth_stencil_image(
                self.handle,
                vk::ImageLayout::TransferDstOptimal,
                &vk::ClearDepthStencilValue {
                    depth: 1.0,
                    stencil: 0,
                },
                &[self.range()],
            );
        } else {
            cmd.clear_color_image(
                self.handle,
                vk::ImageLayout::TransferDstOptimal,
                &vk::ClearColorValue { float32: color },
                &[self.range()],
            );
        }
        self.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
    }
    pub fn upload(&self, bytes: &[u8]) -> Result<()> {
        let staging = Buffer::new(&self.gpu, bytes, vk::BufferUsageFlags::TransferSrc)?;
        self.gpu.submit(|cmd| {
            self.transition(cmd, vk::ImageLayout::TransferDstOptimal);
            cmd.copy_buffer_to_image(
                staging.handle,
                self.handle,
                vk::ImageLayout::TransferDstOptimal,
                &[vk::BufferImageCopy {
                    image_subresource: self.layers(),
                    image_extent: self.extent,
                    ..Default::default()
                }],
            );
            self.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
            Ok(())
        })
    }
    pub fn copy_to(&self, cmd: &vk::CommandBuffer, dst: &Image) {
        self.transition(cmd, vk::ImageLayout::TransferSrcOptimal);
        dst.transition(cmd, vk::ImageLayout::TransferDstOptimal);
        cmd.copy_image(
            self.handle,
            vk::ImageLayout::TransferSrcOptimal,
            dst.handle,
            vk::ImageLayout::TransferDstOptimal,
            &[vk::ImageCopy {
                src_subresource: self.layers(),
                dst_subresource: dst.layers(),
                extent: self.extent,
                ..Default::default()
            }],
        );
        self.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
        dst.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
    }
    pub fn mipmaps(&self, cmd: &vk::CommandBuffer) -> Result<()> {
        if self.levels <= 1 {
            return Ok(());
        }
        let props = self.gpu.physical.get_format_properties(self.format);
        ensure!(
            props.optimal_tiling_features.contains(
                vk::FormatFeatureFlags::BlitSrc
                    | vk::FormatFeatureFlags::BlitDst
                    | vk::FormatFeatureFlags::SampledImageFilterLinear
            ),
            "format cannot generate filtered mipmaps {:?}",
            self.format
        );
        self.mipped.set(true);
        self.transition(cmd, vk::ImageLayout::General);
        for i in 1..self.levels {
            let end = |level: u32| vk::Offset3D {
                x: (self.extent.width >> level).max(1) as i32,
                y: (self.extent.height >> level).max(1) as i32,
                z: 1,
            };
            let region = vk::ImageBlit {
                src_subresource: vk::ImageSubresourceLayers {
                    mip_level: i - 1,
                    ..self.layers()
                },
                src_offsets: [vk::Offset3D::default(), end(i - 1)],
                dst_subresource: vk::ImageSubresourceLayers {
                    mip_level: i,
                    ..self.layers()
                },
                dst_offsets: [vk::Offset3D::default(), end(i)],
            };
            cmd.blit_image(
                self.handle,
                vk::ImageLayout::General,
                self.handle,
                vk::ImageLayout::General,
                &[region],
                vk::Filter::Linear,
            );
            self.transition(cmd, vk::ImageLayout::General);
        }
        self.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
        Ok(())
    }
}
impl Drop for Image {
    fn drop(&mut self) {
        let d = &self.gpu.device;
        d.destroy_sampler(self.comparison, None);
        d.destroy_sampler(self.sampler, None);
        d.destroy_sampler(self.mip_sampler, None);
        d.destroy_image_view(self.attachment, None);
        d.destroy_image_view(self.view, None);
        d.destroy_image(self.handle, None);
        if let Some(a) = self.allocation.take() {
            let _ = self.gpu.allocator.lock().unwrap().free(a);
        }
    }
}
pub fn format(name: &str) -> Result<vk::Format> {
    Ok(match name {
        "RGB8" => vk::Format::R8G8B8A8Unorm,
        "RGBA16" => vk::Format::R16G16B16A16Unorm,
        "RGB10_A2" => vk::Format::A2B10G10R10UnormPack32,
        "R11F_G11F_B10F" => vk::Format::B10G11R11UfloatPack32,
        "RGBA8" | "32856" => vk::Format::R8G8B8A8Unorm,
        "RGBA16F" | "34842" => vk::Format::R16G16B16A16Sfloat,
        "RGBA32F" | "34836" => vk::Format::R32G32B32A32Sfloat,
        "RGB16F" | "34843" => vk::Format::R16G16B16A16Sfloat,
        "RGB32F" | "34837" => vk::Format::R32G32B32A32Sfloat,
        "RG16F" | "33327" => vk::Format::R16G16Sfloat,
        "RG32F" | "33328" => vk::Format::R32G32Sfloat,
        "R16F" | "33325" => vk::Format::R16Sfloat,
        "R32F" | "33326" => vk::Format::R32Sfloat,
        "R8" | "33321" => vk::Format::R8Unorm,
        "RG8" | "33323" => vk::Format::R8G8Unorm,
        "R16" | "33322" => vk::Format::R16Unorm,
        _ => anyhow::bail!("unsupported Vulkan pack format {name}"),
    })
}
pub fn custom(gpu: &Gpu, pack: &crate::pack::Pack, value: &str) -> Result<Image> {
    let f = value.split_whitespace().collect::<Vec<_>>();
    let name = *f.first().context("empty texture declaration")?;
    ensure!(
        !name.starts_with("minecraft:"),
        "named game textures need resource integration: {name}"
    );
    let meta = pack
        .text(&format!("{name}.mcmeta"))
        .ok()
        .map(|s| serde_json::from_str::<serde_json::Value>(&s))
        .transpose()?;
    let blur = meta
        .as_ref()
        .and_then(|m| m["texture"]["blur"].as_bool())
        .unwrap_or(false);
    let clamp = meta
        .as_ref()
        .and_then(|m| m["texture"]["clamp"].as_bool())
        .unwrap_or(false);
    if f.len() == 1 {
        let img = image::load_from_memory(pack.bytes(name)?)?.to_rgba8();
        let tex = Image::new(
            gpu,
            vk::Extent3D {
                width: img.width(),
                height: img.height(),
                depth: 1,
            },
            vk::Format::R8G8B8A8Unorm,
            1,
            false,
            blur,
            clamp,
        )?;
        tex.upload(img.as_raw())?;
        return Ok(tex);
    }
    ensure!(
        f.len() == 8 && f[1] == "TEXTURE_3D",
        "unsupported raw texture declaration {value}"
    );
    let extent = vk::Extent3D {
        width: f[3].parse()?,
        height: f[4].parse()?,
        depth: f[5].parse()?,
    };
    let mut bytes = pack.bytes(name)?.to_vec();
    let components = match f[6] {
        "RGBA" => 4,
        "RGB" => 3,
        "RG" => 2,
        "RED" => 1,
        _ => anyhow::bail!("unsupported raw components"),
    };
    let word = match f[7] {
        "HALF_FLOAT" | "UNSIGNED_SHORT" => 2,
        "FLOAT" => 4,
        "UNSIGNED_BYTE" => 1,
        _ => anyhow::bail!("unsupported raw scalar"),
    };
    let texels = extent.width as usize * extent.height as usize * extent.depth as usize;
    ensure!(
        bytes.len() == texels * components * word,
        "incorrect raw texture byte count"
    );
    if components == 3 {
        let alpha = match word {
            2 => 0x3c00u16.to_le_bytes().to_vec(),
            4 => 1f32.to_le_bytes().to_vec(),
            _ => vec![255],
        };
        bytes = bytes
            .chunks_exact(3 * word)
            .flat_map(|rgb| rgb.iter().copied().chain(alpha.iter().copied()))
            .collect();
    }
    let tex = Image::new(gpu, extent, format(f[2])?, 1, false, blur, clamp)?;
    tex.upload(&bytes)?;
    Ok(tex)
}
