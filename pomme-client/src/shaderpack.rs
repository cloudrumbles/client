//! Experimental second viewport driven by the existing game, not a second
//! client.
use std::sync::{Arc, OnceLock};

use glam::Vec3;
use pomme_shaderpack::live::{LiveAtlas, LiveSection, LiveWorld, SharedWorld};
use pomme_shaderpack::runtime::FrameInput;
use pomme_shaderpack::scene::Vertex;

use crate::renderer::camera::Camera;
use crate::renderer::chunk::atlas::TextureAtlas;
use crate::renderer::chunk::mesher::ChunkMeshData;
use crate::renderer::pipelines::sky::SkyState;

struct Options {
    pack: String,
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
    viewport: pomme_shaderpack::viewer::LiveViewport,
    eye_brightness: [f32; 2],
    climate: [f32; 2],
}
impl Bridge {
    pub fn start(
        events: &winit::event_loop::ActiveEventLoop,
        atlas: &TextureAtlas,
    ) -> Option<Self> {
        let options = OPTIONS.get()?;
        let shared = LiveWorld::shared();
        shared.lock().unwrap().atlas = Some(LiveAtlas {
            revision: 1,
            size: atlas.cpu_size,
            pixels: Arc::clone(&atlas.cpu_pixels),
        });
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
                viewport,
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
        if id != self.viewport.window_id() {
            return false;
        }
        self.viewport.event(event);
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
        render_distance: u32,
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
        frame.far = (render_distance * 16 * 4).max(256) as f32;
        frame.eye_in_water = eyes_in_water;
        frame.eye_brightness = self.eye_brightness;
        frame.temperature = self.climate[0];
        frame.rainfall = self.climate[1];
        self.shared.lock().unwrap().frame = Some(frame);
        if let Err(error) = self.viewport.tick() {
            tracing::error!("Live shader frame failed: {error:#}");
            self.shared.lock().unwrap().active = false;
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
