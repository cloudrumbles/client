//! Version 1 of the immutable native renderer input contract.
//!
//! CPU payloads are owned by a frame. GPU terrain references are valid only in
//! the recording epoch: the renderer owns the arenas and retires slices after
//! its existing frame fences. A retained CPU snapshot cannot submit old
//! handles.
use std::sync::{Arc, OnceLock};

use super::camera::{Camera, CloudMode};
use super::pipelines::block_entity::BlockEntityRenderInfo;
use super::pipelines::entity_renderer::EntityRenderInfo;
use super::pipelines::held_item::{HeldItemInfo, UseAnim};
use super::pipelines::item_entity::ItemRenderInfo;
use super::pipelines::particle::ParticleQuad;
use super::pipelines::sky::SkyState;
use super::pipelines::weather::WeatherColumn;

pub const CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererPath {
    Legacy,
    #[default]
    Shared,
}
static PATH: OnceLock<RendererPath> = OnceLock::new();
pub fn configure(path: RendererPath) {
    let _ = PATH.set(path);
}
pub fn path() -> RendererPath {
    *PATH.get().unwrap_or(&RendererPath::Shared)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct ResourceEpoch {
    pub world: u64,
    pub terrain: u64,
    pub atlas: u64,
    pub models: u64,
    pub surface: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SceneVersion {
    pub contract: u32,
    pub frame: u64,
    pub resources: ResourceEpoch,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryCategory {
    NearTerrain,
    DistantTerrain,
    Entities,
    BlockEntities,
    Hands,
    Particles,
    Weather,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialDomain {
    BlockStateAtlas,
    EntityModelTexture,
    BlockEntityModelTexture,
    ItemModelOrSkin,
    ParticleAtlas,
    PrecipitationTexture,
}
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct CategorySummary {
    pub geometry: GeometryCategory,
    pub material: MaterialDomain,
    /// Native draw inputs, not an estimate of rendered/visible primitives.
    pub inputs: usize,
}

/// Indexed native terrain draw references. Solid/cutout/water remain distinct
/// material coverage classes; these indices refer to the renderer-owned arena.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct TerrainDraw {
    pub origin: [i32; 3],
    pub lod: u8,
    pub upload_epoch: u64,
    pub first_index: u32,
    pub vertex_offset: i32,
    pub water_first_index: u32,
    pub solid_indices: u32,
    pub cutout_indices: u32,
    pub water_indices: u32,
}

/// The authoritative camera is cloned only after this frame's far plane and
/// effects are applied. Every world pipeline consumes this frozen Camera.
/// RH, anchor-relative world coordinates, Vulkan +Y down, forward Z in [0,1],
/// depth clear 1 and LESS/LESS_EQUAL. Pack legacy matrices are derived from the
/// same camera; the existing pack ABI converts GL clip Z at its boundary.
pub struct SceneSnapshot {
    pub version: SceneVersion,
    pub camera: Camera,
    pub sky: SkyState,
    pub near_terrain: Arc<[TerrainDraw]>,
    pub distant_terrain: Arc<[TerrainDraw]>,
    pub entities: Arc<[EntityRenderInfo]>,
    pub item_entities: Arc<[ItemRenderInfo]>,
    pub block_entities: Arc<[BlockEntityRenderInfo]>,
    pub particles: Arc<[ParticleQuad]>,
    pub weather: Arc<[WeatherColumn]>,
    pub hands: Hands,
    pub render_distance: u32,
    pub eyes_in_water: bool,
    pub cloud_mode: CloudMode,
    #[cfg(feature = "shader-packs")]
    pub pack_world: Option<Arc<pomme_shaderpack::live::WorldSnapshot>>,
}
pub struct Hands {
    pub item: Option<HeldItemInfo>,
    pub swing: f32,
    pub use_anim: Option<UseAnim>,
    pub visible: bool,
}
impl SceneSnapshot {
    pub fn accepts(&self, resources: ResourceEpoch) -> bool {
        self.version.contract == CONTRACT_VERSION && self.version.resources == resources
    }
    pub fn categories(&self) -> [CategorySummary; 8] {
        use GeometryCategory::*;
        use MaterialDomain::*;
        let entry = |geometry, material, inputs| CategorySummary {
            geometry,
            material,
            inputs,
        };
        [
            entry(NearTerrain, BlockStateAtlas, self.near_terrain.len()),
            entry(DistantTerrain, BlockStateAtlas, self.distant_terrain.len()),
            entry(Entities, EntityModelTexture, self.entities.len()),
            entry(Entities, ItemModelOrSkin, self.item_entities.len()),
            entry(
                BlockEntities,
                BlockEntityModelTexture,
                self.block_entities.len(),
            ),
            entry(Hands, ItemModelOrSkin, usize::from(self.hands.visible)),
            entry(Particles, ParticleAtlas, self.particles.len()),
            entry(Weather, PrecipitationTexture, self.weather.len()),
        ]
    }
    pub fn evidence(&self) -> serde_json::Value {
        serde_json::json!({
            "version": self.version,
            "categories": self.categories(),
            "camera": {
                "anchor": self.camera.anchor().to_array(),
                "position": (*self.camera.position + self.camera.third_person_offset().as_dvec3()).to_array(),
                "fov": self.camera.fov_degrees(),
                "clip": self.camera.clip_planes(),
                "depth": "forward_zero_to_one",
            },
            "world_time": self.sky.day_time,
            "rain": self.sky.rain(),
        })
    }
}

/// Mutable producer metadata, separate from published immutable frame inputs.
#[derive(Default)]
pub struct ScenePublisher {
    pub resources: ResourceEpoch,
    serial: u64,
    terrain_cache: Option<(u64, Arc<[TerrainDraw]>)>,
}
impl ScenePublisher {
    pub fn next_version(&mut self) -> SceneVersion {
        self.serial += 1;
        SceneVersion {
            contract: CONTRACT_VERSION,
            frame: self.serial,
            resources: self.resources,
        }
    }
    pub fn terrain(&mut self, gather: impl FnOnce() -> Vec<TerrainDraw>) -> Arc<[TerrainDraw]> {
        if self
            .terrain_cache
            .as_ref()
            .is_none_or(|(r, _)| *r != self.resources.terrain)
        {
            self.terrain_cache = Some((self.resources.terrain, gather().into()));
        }
        Arc::clone(&self.terrain_cache.as_ref().unwrap().1)
    }
    pub fn clear_world(&mut self) {
        self.resources.world += 1;
        self.resources.terrain += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty_snapshot(camera: Camera, version: SceneVersion) -> SceneSnapshot {
        SceneSnapshot {
            version,
            camera,
            sky: SkyState::default_day(),
            near_terrain: Arc::from([]),
            distant_terrain: Arc::from([]),
            entities: Arc::from([]),
            item_entities: Arc::from([]),
            block_entities: Arc::from([]),
            particles: Arc::from([]),
            weather: Arc::from([]),
            hands: Hands {
                item: None,
                swing: 0.,
                use_anim: None,
                visible: true,
            },
            render_distance: 32,
            eyes_in_water: false,
            cloud_mode: CloudMode::Fancy,
            #[cfg(feature = "shader-packs")]
            pack_world: None,
        }
    }
    #[test]
    fn retained_frame_keeps_actor_weather_and_camera_inputs_after_producer_changes() {
        let mut camera = Camera::new(16. / 9.);
        camera.set_render_distance(32);
        camera.set_hurt(8, 30., 1.);
        camera.set_view_bob(2., 0.08, true);
        let mut particles = vec![ParticleQuad {
            pos: [1., 2., 3.],
            size: 0.2,
            u0: 0.,
            u1: 1.,
            v0: 0.,
            v1: 1.,
            color: 0xff112233,
            translucent: true,
        }];
        let mut weather = vec![WeatherColumn {
            x: -1,
            z: 2,
            bottom_y: 64.,
            top_y: 90.,
            precip: super::super::pipelines::weather::Precip::Rain,
            light: 0.5,
        }];
        let mut p = ScenePublisher::default();
        let mut s = empty_snapshot(camera.clone(), p.next_version());
        s.particles = particles.clone().into();
        s.weather = weather.clone().into();
        let snapshot = Arc::new(s);
        let projection = snapshot.camera.view_projection();
        let clip = snapshot.camera.clip_planes();
        particles[0].pos[0] = 1000.;
        weather.clear();
        camera.set_render_distance(4);
        camera.base_fov_degrees = 110.;
        assert_eq!(snapshot.particles[0].pos, [1., 2., 3.]);
        assert_eq!(snapshot.weather.len(), 1);
        assert_eq!(snapshot.camera.view_projection(), projection);
        assert_eq!(snapshot.camera.clip_planes(), clip);
        assert_eq!(clip[1], 2048.);
        assert_ne!(camera.view_projection(), projection);
    }
    #[test]
    fn retained_gpu_references_reject_every_changed_resource_generation() {
        let mut p = ScenePublisher::default();
        let snapshot = empty_snapshot(Camera::new(1.), p.next_version());
        assert!(snapshot.accepts(p.next_version().resources));
        for resources in [
            ResourceEpoch {
                world: 1,
                ..Default::default()
            },
            ResourceEpoch {
                terrain: 1,
                ..Default::default()
            },
            ResourceEpoch {
                atlas: 1,
                ..Default::default()
            },
            ResourceEpoch {
                models: 1,
                ..Default::default()
            },
            ResourceEpoch {
                surface: 1,
                ..Default::default()
            },
        ] {
            assert!(!snapshot.accepts(resources));
        }
    }
    #[test]
    fn frame_versions_and_resource_epochs_are_independent() {
        let mut p = ScenePublisher::default();
        let first = p.next_version();
        let second = p.next_version();
        assert!(second.frame > first.frame);
        assert_eq!(first.resources, second.resources);
        p.clear_world();
        let third = p.next_version();
        assert_ne!(third.resources.world, second.resources.world);
        assert_ne!(third.resources.terrain, second.resources.terrain);
    }
    #[test]
    fn immutable_terrain_cache_survives_edits_without_recopied_geometry() {
        let mut p = ScenePublisher::default();
        let old = p.terrain(|| {
            vec![TerrainDraw {
                origin: [16, 64, -16],
                lod: 0,
                upload_epoch: 1,
                first_index: 0,
                vertex_offset: 0,
                water_first_index: 6,
                solid_indices: 6,
                cutout_indices: 0,
                water_indices: 0,
            }]
        });
        let same = p.terrain(|| panic!("unchanged topology must be retained"));
        assert!(Arc::ptr_eq(&old, &same));
        p.resources.terrain += 1;
        let new = p.terrain(Vec::new);
        assert!(new.is_empty());
        assert_eq!(old[0].solid_indices, 6);
    }
}
