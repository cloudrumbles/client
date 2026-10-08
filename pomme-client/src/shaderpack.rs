//! Replaceable original packs on the game Vulkan device; optional GL reference.
use std::sync::{Arc, OnceLock};

use glam::Vec3;
use pomme_shaderpack::live::{LiveAtlas, LiveSection, LiveWorld, SharedWorld, WorldSnapshot};
use pomme_shaderpack::runtime::FrameInput;
use pomme_shaderpack::scene::Vertex;

use crate::renderer::camera::Camera;
use crate::renderer::chunk::atlas::TextureAtlas;
use crate::renderer::chunk::mesher::ChunkMeshData;
use crate::renderer::pipelines::sky::SkyState;

struct Options {
    pack: String,
    reference: bool,
    alternates: Vec<String>,
    minecraft_version: u32,
    profile: Option<String>,
    options: Vec<String>,
    width: u32,
    height: u32,
    frames: Option<u32>,
    output: String,
}
static OPTIONS: OnceLock<Options> = OnceLock::new();
pub fn configure(args: &crate::args::LaunchArgs, version: &str) {
    if let Some(pack) = &args.shader_pack {
        let Ok(minecraft_version) = pomme_shaderpack::pack::minecraft_version_code(version) else {
            eprintln!("shader pack preprocessing needs a release version: {version}");
            return;
        };
        let _ = OPTIONS.set(Options {
            pack: pack.clone(),
            reference: args.shader_reference_window,
            alternates: args.shader_alternate_packs.clone(),
            minecraft_version,
            profile: args.shader_profile.clone(),
            options: args.shader_options.clone(),
            width: args.shader_width,
            height: args.shader_height,
            frames: args.shader_frames,
            output: args.shader_output.clone(),
        });
    }
}
pub fn enabled() -> bool {
    OPTIONS.get().is_some()
}
#[derive(Clone, Copy)]
pub struct ShaderMeshVertex {
    pub vertex: Vertex,
    pub state: u32,
}
pub struct Bridge {
    shared: SharedWorld,
    viewport: Option<pomme_shaderpack::viewer::LiveViewport>,
    native: Option<NativePack>,
    eye_brightness: [f32; 2],
    climate: [f32; 2],
}
impl Bridge {
    pub fn start(
        events: &winit::event_loop::ActiveEventLoop,
        atlas: &TextureAtlas,
        ctx: &crate::renderer::context::VulkanContext,
    ) -> Option<Self> {
        let options = OPTIONS.get()?;
        let shared = LiveWorld::shared();
        shared.lock().unwrap().atlas = Some(LiveAtlas {
            revision: 1,
            size: atlas.cpu_size,
            pixels: Arc::clone(&atlas.cpu_pixels),
        });
        if !options.reference {
            let gpu = pomme_shaderpack::vulkan::resource::Gpu {
                device: ctx.device.clone(),
                physical: ctx.physical_device,
                allocator: Arc::clone(&ctx.allocator),
                queue: ctx.graphics_queue,
                pool: ctx.command_pool,
                independent_blend: ctx.independent_blend,
            };
            return Some(Self {
                shared,
                viewport: None,
                native: Some(NativePack::new(gpu)),
                eye_brightness: [0., 240.],
                climate: [0.8, 0.4],
            });
        }
        let viewer = pomme_shaderpack::viewer::ViewerOptions {
            pack: options.pack.clone().into(),
            alternate_packs: options.alternates.iter().map(Into::into).collect(),
            profile: options.profile.clone(),
            overrides: options.options.clone(),
            dimension: "world0".into(),
            minecraft_version: options.minecraft_version,
            width: options.width,
            height: options.height,
            scene: "live".into(),
            time: 6000,
            rain: 0.0,
            atlas: None,
            max_frames: options.frames,
            output: options.output.clone().into(),
        };
        match pomme_shaderpack::viewer::LiveViewport::new(events, viewer, Arc::clone(&shared)) {
            Ok(viewport) => Some(Self {
                shared,
                viewport: Some(viewport),
                native: None,
                eye_brightness: [0.0, 240.0],
                climate: [0.8, 0.4],
            }),
            Err(error) => {
                tracing::error!("Live shader-pack viewport failed: {error:#}");
                None
            }
        }
    }
    pub fn event(
        &mut self,
        id: winit::window::WindowId,
        event: &winit::event::WindowEvent,
    ) -> bool {
        let Some(viewport) = &mut self.viewport else {
            return false;
        };
        if id != viewport.window_id() {
            return false;
        }
        viewport.event(event);
        true
    }
    pub fn atlas(&self, atlas: &TextureAtlas) {
        let mut state = self.shared.lock().unwrap();
        let revision = state.atlas.as_ref().map_or(1, |a| a.revision + 1);
        state.clear(); // Old meshes carry UVs for the previous atlas.
        state.atlas = Some(LiveAtlas {
            revision,
            size: atlas.cpu_size,
            pixels: Arc::clone(&atlas.cpu_pixels),
        });
    }
    pub fn meshes(&self, meshes: &[ChunkMeshData]) {
        let mut world = self.shared.lock().unwrap();
        if !world.active {
            return;
        }
        for mesh in meshes {
            let sections = mesh
                .sections
                .iter()
                .map(|section| {
                    let origin = Vec3::new(
                        (mesh.pos.x * 16) as f32,
                        (mesh.min_y + section.section_index * 16) as f32,
                        (mesh.pos.z * 16) as f32,
                    );
                    let vertices = section
                        .shader_vertices
                        .iter()
                        .map(|source| {
                            if world
                                .materials
                                .get(source.state as usize)
                                .is_none_or(|name| name.is_empty())
                                && let Some(state) = crate::world::block::try_state(source.state)
                            {
                                let name = crate::world::block::block_id(state);
                                let properties = crate::world::block::block_properties(state)
                                    .entries()
                                    .map(|(k, v)| format!("{k}={v}"))
                                    .collect::<Vec<_>>()
                                    .join(",");
                                world.material(
                                    source.state as usize,
                                    format!("{name}[{properties}]"),
                                );
                            }
                            let mut v = source.vertex;
                            v.position = (Vec3::from(v.position) + origin).to_array();
                            v
                        })
                        .collect::<Vec<_>>();
                    let expand = |indices: &[u32]| {
                        indices
                            .iter()
                            .filter_map(|i| vertices.get(*i as usize).copied())
                            .collect()
                    };
                    LiveSection {
                        section: section.section_index,
                        solid: expand(&section.indices),
                        water: expand(&section.water_indices),
                    }
                })
                .collect();
            world.replace_sections(
                [mesh.pos.x, mesh.pos.z],
                mesh.replaced.clone(),
                mesh.upload_epoch,
                sections,
            );
        }
    }
    pub fn remove(&self, pos: &azalea_core::position::ChunkPos) {
        self.shared.lock().unwrap().remove_column([pos.x, pos.z]);
    }
    pub fn clear(&self) {
        self.shared.lock().unwrap().clear();
    }
    pub fn snapshot(&self) -> Arc<WorldSnapshot> {
        Arc::new(self.shared.lock().unwrap().snapshot())
    }
    pub fn environment(&mut self, game: &crate::app::phases::in_game::GameState, position: Vec3) {
        let chunks = &game.chunk_store;
        let climates = &game.biome_climate;
        let [x, y, z] = position.floor().to_array().map(|v| v as i32);
        self.eye_brightness = [
            chunks.get_block_light(x, y, z) as f32 * 16.0,
            chunks.get_sky_light(x, y, z) as f32 * 16.0,
        ];
        let climate = climates
            .get(&chunks.biome_id(x, y, z))
            .copied()
            .unwrap_or_default();
        self.climate = [climate.temperature, climate.downfall];
        self.shared.lock().unwrap().game = pomme_shaderpack::live::GameSnapshot {
            tick: game.tick_count,
            client_loaded: game.client_loaded,
            loaded_columns: chunks.loaded_positions().count(),
            tracked_entities: game.entity_positions.len(),
            inventory: game
                .player
                .inventory
                .slots()
                .iter()
                .enumerate()
                .filter(|(_, item)| item.count() > 0)
                .map(|(slot, item)| (slot, format!("{:?}", item.kind()), item.count()))
                .collect(),
            inventory_open: game.inventory_open || game.creative_inventory_open,
            dimension: game.dimension.clone(),
        };
    }
    pub fn frame(
        &mut self,
        camera: &Camera,
        sky: &SkyState,
        _render_distance: u32,
        eyes_in_water: bool,
    ) {
        let (position, target, up) = camera.shader_view();
        let mut frame = FrameInput::fixture(
            &pomme_shaderpack::scene::Scene {
                solid: Vec::new(),
                water: Vec::new(),
                camera: position,
                target,
                materials: Vec::new(),
            },
            0,
            (sky.day_time % 24000) as i32,
            sky.rain(),
        );
        frame.up = up;
        frame.world_day = (sky.day_time / 24000) as i32;
        frame.fov_degrees = camera.fov_degrees();
        [frame.near, frame.far] = camera.shader_clip_planes();
        frame.view_effect = camera.shader_view_effect();
        frame.eye_in_water = eyes_in_water;
        frame.eye_brightness = self.eye_brightness;
        frame.temperature = self.climate[0];
        frame.rainfall = self.climate[1];
        self.shared.lock().unwrap().frame = Some(frame);
        if let Some(viewport) = &mut self.viewport
            && let Err(error) = viewport.tick()
        {
            tracing::error!("Live shader frame failed: {error:#}");
            self.shared.lock().unwrap().active = false;
        }
    }
    pub fn prepare(
        &mut self,
        slot: usize,
        extent: pyronyx::vk::Extent2D,
        rp: pyronyx::vk::RenderPass,
        format: pyronyx::vk::Format,
        scene: Option<&crate::renderer::scene::SceneSnapshot>,
    ) -> anyhow::Result<bool> {
        let Some(native) = &mut self.native else {
            return Ok(false);
        };
        native.prepare(&self.shared, slot, extent, rp, format, scene)
    }
    pub fn record(&mut self, cmd: &pyronyx::vk::CommandBuffer, slot: usize) -> anyhow::Result<()> {
        if let Some(n) = &mut self.native {
            n.record(cmd, slot)
        } else {
            Ok(())
        }
    }
    /// Called only after all queue work has completed. Discard speculative
    /// image-layout/history state from an unsubmitted, failed command buffer.
    pub fn abort(&mut self) {
        if let Some(n) = &mut self.native {
            n.presenter = None;
            n.engine = None;
            n.pending.fill(None);
            n.failed = true;
        }
        tracing::error!("Shader pack disabled after failure; F6 retries the selected pack");
    }
    pub fn draw(
        &self,
        cmd: &pyronyx::vk::CommandBuffer,
        slot: usize,
        extent: pyronyx::vk::Extent2D,
    ) {
        if let Some(n) = &self.native
            && let Some(p) = &n.presenter
        {
            p.draw(cmd, slot, extent);
        }
    }
    pub fn key(&mut self, key: winit::keyboard::KeyCode) {
        if let Some(n) = &mut self.native {
            match key {
                winit::keyboard::KeyCode::F6 => {
                    n.failed = false;
                    n.reload = true;
                }
                winit::keyboard::KeyCode::F7 => {
                    n.failed = false;
                    n.next_pack = true;
                    n.reload = true;
                }
                _ => {}
            }
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.lock() {
            state.active = false;
        }
    }
}

struct NativePack {
    engine: Option<pomme_shaderpack::vulkan::engine::Engine>,
    presenter: Option<pomme_shaderpack::vulkan::present::Presenter>,
    gpu: pomme_shaderpack::vulkan::resource::Gpu,
    size: [u32; 2],
    dimension: String,
    path: usize,
    world_revision: u64,
    atlas_revision: u64,
    input: Option<FrameInput>,
    frame: u32,
    start: std::time::Instant,
    last: std::time::Instant,
    pending: Vec<Option<serde_json::Value>>,
    samples: Vec<serde_json::Value>,
    reloads: Vec<serde_json::Value>,
    saved: bool,
    reload: bool,
    next_pack: bool,
    failed: bool,
}
impl NativePack {
    fn new(gpu: pomme_shaderpack::vulkan::resource::Gpu) -> Self {
        Self {
            engine: None,
            presenter: None,
            gpu,
            size: [0; 2],
            dimension: String::new(),
            path: 0,
            world_revision: u64::MAX,
            atlas_revision: 0,
            input: None,
            frame: 0,
            start: std::time::Instant::now(),
            last: std::time::Instant::now(),
            pending: vec![None; crate::renderer::MAX_FRAMES_IN_FLIGHT],
            samples: Vec::new(),
            reloads: Vec::new(),
            saved: false,
            reload: false,
            next_pack: false,
            failed: false,
        }
    }
    fn prepare(
        &mut self,
        shared: &SharedWorld,
        slot: usize,
        extent: pyronyx::vk::Extent2D,
        rp: pyronyx::vk::RenderPass,
        format: pyronyx::vk::Format,
        scene: Option<&crate::renderer::scene::SceneSnapshot>,
    ) -> anyhow::Result<bool> {
        use pomme_shaderpack::pack::Pack;
        use pomme_shaderpack::vulkan::engine::Engine;
        use pomme_shaderpack::vulkan::present::Presenter;
        if self.failed {
            return Ok(false);
        }
        let options = OPTIONS.get().unwrap();
        if let Some(mut sample) = self.pending[slot].take()
            && let Some(e) = &self.engine
        {
            sample["passes"] = serde_json::to_value(e.timings(slot)?)?;
            if !self.saved {
                self.samples.push(sample);
            }
        }
        if !self.saved
            && options
                .frames
                .is_some_and(|n| self.samples.len() >= n as usize)
        {
            let e = self.engine.as_ref().unwrap();
            self.gpu.device.wait_idle()?;
            let output = std::path::Path::new(&options.output);
            std::fs::create_dir_all(output)?;
            e.screenshot(&output.join("vulkan-live.png"))?;
            self.samples.sort_by_key(|s| s["frame"].as_u64());
            std::fs::write(
                output.join("vulkan-live.json"),
                serde_json::to_vec_pretty(
                    &serde_json::json!({"backend":"Vulkan in native game window","device":unsafe{std::ffi::CStr::from_ptr(self.gpu.physical.get_properties().device_name.as_ptr())}.to_string_lossy(),"revision":pomme_shaderpack::BUILD_REVISION,"pack_hash":e.pack.digest,"options":e.pack.options,"size":self.size,"passes":e.pass_names(),"measurement":"Vulkan pack-pass timestamp queries; excludes forward actors, UI and presentation; not gameplay FPS","samples":self.samples,"reloads":self.reloads}),
                )?,
            )?;
            self.saved = true;
            tracing::info!("Vulkan shader capture completed: {}", options.output);
        }
        let immediate;
        let state = if let Some(snapshot) = scene.and_then(|s| s.pack_world.as_deref()) {
            snapshot
        } else {
            immediate = shared.lock().unwrap().snapshot();
            &immediate
        };
        let Some(mut input) = state.frame.clone() else {
            return Ok(false);
        };
        let dimension = match state.game.dimension.as_str() {
            "minecraft:overworld" | "" => "world0",
            "minecraft:the_nether" => "world-1",
            "minecraft:the_end" => "world1",
            other => anyhow::bail!("shader dimension mapping unsupported: {other}"),
        };
        let scale = (options.width.max(1) as f64 / extent.width.max(1) as f64)
            .min(options.height.max(1) as f64 / extent.height.max(1) as f64)
            .min(1.);
        let size = [
            (extent.width as f64 * scale).round().max(1.) as u32,
            (extent.height as f64 * scale).round().max(1.) as u32,
        ];
        let [width, height] = size;
        if self.engine.is_none() || self.size != size || self.dimension != dimension || self.reload
        {
            self.gpu.device.wait_idle()?;
            // Collect every outstanding old query before replacing its pool.
            if let Some(e) = &self.engine {
                for sample_slot in 0..self.pending.len() {
                    if let Some(mut s) = self.pending[sample_slot].take() {
                        s["passes"] = serde_json::to_value(e.timings(sample_slot)?)?;
                        if !self.saved {
                            self.samples.push(s);
                        }
                    }
                }
            }
            let next = if self.next_pack {
                (self.path + 1) % (options.alternates.len() + 1)
            } else {
                self.path
            };
            let path = if next == 0 {
                &options.pack
            } else {
                &options.alternates[next - 1]
            };
            let result = (|| -> anyhow::Result<_> {
                let pack = Pack::load_for_version(
                    std::path::Path::new(path),
                    dimension,
                    options.profile.as_deref(),
                    &options.options,
                    options.minecraft_version,
                )?;
                let scene = state.scene();
                let atlas = state.atlas.as_ref().map(|a| (a.size, a.pixels.as_slice()));
                let engine = Engine::new(
                    self.gpu.clone(),
                    pack,
                    width,
                    height,
                    &scene,
                    atlas,
                    crate::renderer::MAX_FRAMES_IN_FLIGHT,
                )?;
                let presenter = Presenter::new(
                    self.gpu.clone(),
                    rp,
                    matches!(
                        format,
                        pyronyx::vk::Format::B8G8R8A8Srgb | pyronyx::vk::Format::R8G8B8A8Srgb
                    ),
                    crate::renderer::MAX_FRAMES_IN_FLIGHT,
                )?;
                Ok((engine, presenter))
            })();
            match result {
                Ok((engine, presenter)) => {
                    tracing::info!(frame=self.frame, path, pack_hash=%engine.pack.digest, dimension, "Vulkan shader pack activated");
                    self.reloads.push(serde_json::json!({"frame":self.frame,"pack_hash":engine.pack.digest,"path":path,"dimension":dimension}));
                    self.engine = Some(engine);
                    self.presenter = Some(presenter);
                    self.size = size;
                    self.dimension = dimension.into();
                    self.path = next;
                    self.world_revision = state.revision;
                    self.atlas_revision = state.atlas.as_ref().map_or(0, |a| a.revision);
                }
                Err(e)
                    if self.engine.is_some()
                        && self.size == size
                        && self.dimension == dimension =>
                {
                    tracing::error!("Vulkan pack reload failed; keeping active pack: {e:#}")
                }
                Err(e) => return Err(e),
            }
            self.reload = false;
            self.next_pack = false;
        }
        let e = self.engine.as_mut().unwrap();
        if self.world_revision != state.revision {
            e.replace_scene(&state.scene())?;
            self.world_revision = state.revision;
        }
        if let Some(a) = &state.atlas
            && a.revision != self.atlas_revision
        {
            e.replace_atlas(a.size, &a.pixels)?;
            self.atlas_revision = a.revision;
        }
        let now = std::time::Instant::now();
        input.frame = self.frame;
        input.seconds = self.start.elapsed().as_secs_f32();
        input.delta_seconds = now.duration_since(self.last).as_secs_f32().min(0.1);
        input.world_revision = self.world_revision;
        input.material_revision = self.atlas_revision;
        self.last = now;
        self.input = Some(input);
        let input = self.input.as_ref().unwrap();
        self.pending[slot] = Some(
            serde_json::json!({"frame":self.frame,"world_time":input.world_time,"world_day":input.world_day,"rain":input.rain,"eye_in_water":input.eye_in_water,"world_revision":input.world_revision,"camera":input.camera.to_array(),"pack_hash":e.pack.digest,"history_invalidations":e.invalidations,"game":state.game}),
        );
        if let Some(sample) = &mut self.pending[slot] {
            sample["renderer_path"] = serde_json::to_value(crate::renderer::scene::path())?;
            if let Some(scene) = scene {
                sample["scene_snapshot"] = scene.evidence();
                sample["scene_snapshot"]["pack_sections"] = state.section_count().into();
                sample["scene_snapshot"]["pack_world_generation"] = state.generation.into();
            }
        }
        Ok(true)
    }
    fn record(&mut self, cmd: &pyronyx::vk::CommandBuffer, slot: usize) -> anyhow::Result<()> {
        let e = self.engine.as_mut().unwrap();
        e.record(cmd, slot, self.input.as_ref().unwrap())?;
        if let Some(s) = &mut self.pending[slot] {
            s["history_invalidations"] = e.invalidations.into();
        }
        self.presenter
            .as_ref()
            .unwrap()
            .prepare(cmd, slot, &e.output, e.depth_image());
        self.frame += 1;
        Ok(())
    }
}
