//! A real Vulkan graphics queue for deterministic pack tests without a display.
use std::ffi::CStr;
use std::mem::ManuallyDrop;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use pomme_gpu_allocator::vulkan::{Allocator, AllocatorCreateDesc};
use pyronyx::vk;

use super::resource::Gpu;

pub struct Headless {
    pub gpu: ManuallyDrop<Gpu>,
    pub name: String,
    instance: vk::Instance,
    allocator: ManuallyDrop<Arc<Mutex<Allocator>>>,
}
impl Headless {
    pub fn new() -> Result<Self> {
        let app = vk::ApplicationInfo {
            application_name: c"Pomme pack Vulkan test".as_ptr(),
            api_version: vk::API_VERSION_1_2,
            ..Default::default()
        };
        let instance = unsafe {
            vk::Instance::create(
                &vk::InstanceCreateInfo {
                    application_info: &app,
                    ..Default::default()
                },
                None,
            )?
        };
        let devices = unsafe { instance.enumerate_physical_devices()? };
        let (physical, family) = devices
            .into_iter()
            .find_map(|p| {
                p.get_queue_family_properties()
                    .iter()
                    .position(|q| {
                        q.queue_flags
                            .contains(vk::QueueFlags::Graphics | vk::QueueFlags::Compute)
                            && q.timestamp_valid_bits > 0
                    })
                    .map(|i| (p, i as u32))
            })
            .context("no timestamp-capable Vulkan graphics queue")?;
        let supported = physical.get_features();
        let enabled = vk::PhysicalDeviceFeatures {
            independent_blend: supported.independent_blend,
            ..Default::default()
        };
        let priority = 1.;
        let q = vk::DeviceQueueCreateInfo {
            queue_family_index: family,
            queue_count: 1,
            queue_priorities: &priority,
            ..Default::default()
        };
        let device = unsafe {
            physical.create_device(
                &vk::DeviceCreateInfo {
                    queue_create_info_count: 1,
                    queue_create_infos: &q,
                    enabled_features: &enabled,
                    ..Default::default()
                },
                None,
                &instance,
            )?
        };
        let queue = unsafe { device.get_device_queue(family, 0) };
        let pool = device.create_command_pool(
            &vk::CommandPoolCreateInfo {
                queue_family_index: family,
                flags: vk::CommandPoolCreateFlags::ResetCommandBuffer,
                ..Default::default()
            },
            None,
        )?;
        let allocator = Arc::new(Mutex::new(Allocator::new(&AllocatorCreateDesc {
            instance: instance.clone(),
            device: device.clone(),
            physical_device: physical,
            debug_settings: Default::default(),
            buffer_device_address: false,
            allocation_sizes: Default::default(),
        })?));
        let properties = physical.get_properties();
        let name = unsafe { CStr::from_ptr(properties.device_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        let gpu = Gpu {
            device,
            physical,
            queue,
            pool,
            queue_family: family,
            allocator: allocator.clone(),
            independent_blend: enabled.independent_blend == vk::TRUE,
        };
        Ok(Self {
            gpu: ManuallyDrop::new(gpu),
            name,
            instance,
            allocator: ManuallyDrop::new(allocator),
        })
    }
}
impl Drop for Headless {
    fn drop(&mut self) {
        let device = self.gpu.device.clone();
        let _ = device.wait_idle();
        device.destroy_command_pool(self.gpu.pool, None);
        unsafe {
            ManuallyDrop::drop(&mut self.gpu);
            ManuallyDrop::drop(&mut self.allocator);
            device.destroy(None);
            self.instance.destroy(None);
        }
    }
}
