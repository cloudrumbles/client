//! Shared live-world input. The game's existing chunk lifecycle owns updates.
use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use crate::runtime::FrameInput;
use crate::scene::{Scene, Vertex};

pub type SharedWorld = Arc<Mutex<LiveWorld>>;
#[derive(Clone)]
pub struct LiveSection {
    pub section: i32,
    pub solid: Vec<Vertex>,
    pub water: Vec<Vertex>,
}
#[derive(Clone)]
pub struct LiveAtlas {
    pub revision: u64,
    pub size: [u32; 2],
    pub pixels: Arc<Vec<u8>>,
}
#[derive(Clone, Default, serde::Serialize)]
pub struct GameSnapshot {
    pub tick: u64,
    pub client_loaded: bool,
    pub loaded_columns: usize,
    pub tracked_entities: usize,
    pub inventory: Vec<(usize, String, i32)>,
    pub inventory_open: bool,
    pub dimension: String,
}
pub struct LiveWorld {
    sections: BTreeMap<(i32, i32, i32), Arc<LiveSection>>,
    epochs: BTreeMap<(i32, i32, i32), u64>,
    pub materials: Arc<Vec<String>>,
    pub revision: u64,
    pub generation: u64,
    pub frame: Option<FrameInput>,
    pub atlas: Option<LiveAtlas>,
    pub active: bool,
    pub game: GameSnapshot,
}
/// Immutable input lease. Updates/unloads cannot alter payloads retained by an
/// older frame. This owns CPU data, never device handles or a second GPU
/// device.
pub struct WorldSnapshot {
    sections: Arc<[Arc<LiveSection>]>,
    pub generation: u64,
    pub revision: u64,
    pub materials: Arc<Vec<String>>,
    pub frame: Option<FrameInput>,
    pub atlas: Option<LiveAtlas>,
    pub game: GameSnapshot,
}
impl WorldSnapshot {
    pub fn section_count(&self) -> usize {
        self.sections.len()
    }
    pub fn scene(&self) -> Scene {
        Scene {
            solid: self
                .sections
                .iter()
                .flat_map(|s| s.solid.iter().copied())
                .collect(),
            water: self
                .sections
                .iter()
                .flat_map(|s| s.water.iter().copied())
                .collect(),
            camera: self.frame.as_ref().map_or(glam::Vec3::ZERO, |f| f.camera),
            target: self.frame.as_ref().map_or(glam::Vec3::NEG_Z, |f| f.target),
            materials: self.materials.as_ref().clone(),
        }
    }
}
impl LiveWorld {
    pub fn shared() -> SharedWorld {
        Arc::new(Mutex::new(Self {
            sections: BTreeMap::new(),
            epochs: BTreeMap::new(),
            materials: Arc::new(Vec::new()),
            revision: 0,
            generation: 0,
            frame: None,
            atlas: None,
            active: true,
            game: GameSnapshot::default(),
        }))
    }
    pub fn material(&mut self, index: usize, name: String) {
        if self.materials.get(index).is_some_and(|old| old == &name) {
            return;
        }
        let materials = Arc::make_mut(&mut self.materials);
        if materials.len() <= index {
            materials.resize(index + 1, String::new());
        }
        materials[index] = name;
        self.revision += 1;
    }
    pub fn replace_sections(
        &mut self,
        column: [i32; 2],
        replaced: Range<i32>,
        epoch: u64,
        sections: Vec<LiveSection>,
    ) {
        let mut incoming = sections
            .into_iter()
            .map(|s| (s.section, s))
            .collect::<BTreeMap<_, _>>();
        let mut changed = false;
        for section in replaced {
            let key = (column[0], column[1], section);
            if self.epochs.get(&key).is_some_and(|old| *old >= epoch) {
                continue;
            }
            self.epochs.insert(key, epoch);
            if let Some(mesh) = incoming.remove(&section) {
                self.sections.insert(key, Arc::new(mesh));
            } else {
                self.sections.remove(&key);
            }
            changed = true;
        }
        if changed {
            self.revision += 1;
        }
    }
    pub fn remove_column(&mut self, column: [i32; 2]) {
        self.sections.retain(|(x, z, _), _| [*x, *z] != column);
        for ((x, z, _), epoch) in &mut self.epochs {
            if [*x, *z] == column {
                *epoch = epoch.saturating_add(1);
            }
        }
        // Keep tombstones: delayed lower-epoch replacements cannot restore old
        // sections.
        self.revision += 1;
    }
    pub fn clear(&mut self) {
        self.sections.clear();
        self.epochs.clear();
        self.materials = Arc::new(Vec::new());
        self.frame = None;
        self.generation += 1;
        self.revision += 1;
    }
    pub fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            sections: self.sections.values().cloned().collect(),
            generation: self.generation,
            revision: self.revision,
            materials: Arc::clone(&self.materials),
            frame: self.frame.clone(),
            atlas: self.atlas.clone(),
            game: self.game.clone(),
        }
    }
    pub fn scene(&self) -> Scene {
        let frame = self.frame.as_ref();
        Scene {
            solid: self
                .sections
                .values()
                .flat_map(|s| s.solid.iter().copied())
                .collect(),
            water: self
                .sections
                .values()
                .flat_map(|s| s.water.iter().copied())
                .collect(),
            camera: frame.map_or(glam::Vec3::ZERO, |f| f.camera),
            target: frame.map_or(glam::Vec3::NEG_Z, |f| f.target),
            materials: self.materials.as_ref().clone(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_lease_retains_geometry_materials_atlas_and_dimension_after_clear() {
        let shared = LiveWorld::shared();
        let mut w = shared.lock().unwrap();
        w.material(0, "minecraft:stone".into());
        w.game.dimension = "minecraft:overworld".into();
        w.atlas = Some(LiveAtlas {
            revision: 1,
            size: [1, 1],
            pixels: Arc::new(vec![255; 4]),
        });
        w.replace_sections(
            [0, 0],
            0..1,
            1,
            vec![LiveSection {
                section: 0,
                solid: vec![Scene::fixture("terrain").solid[0]],
                water: Vec::new(),
            }],
        );
        let old = w.snapshot();
        let same = w.snapshot();
        assert!(Arc::ptr_eq(&old.sections[0], &same.sections[0]));
        assert!(Arc::ptr_eq(&old.materials, &same.materials));
        w.material(0, "minecraft:dirt".into());
        assert_eq!(old.materials[0], "minecraft:stone");
        w.clear();
        w.game.dimension = "minecraft:the_nether".into();
        let new = w.snapshot();
        assert_eq!(old.scene().solid.len(), 1);
        assert!(new.scene().solid.is_empty());
        assert_eq!(old.atlas.unwrap().pixels.as_slice(), &[255; 4]);
        assert_ne!(old.generation, new.generation);
        assert_eq!(old.game.dimension, "minecraft:overworld");
        assert_eq!(new.game.dimension, "minecraft:the_nether");
    }
    #[test]
    fn unload_keeps_epoch_tombstone_until_world_clear() {
        let shared = LiveWorld::shared();
        let mut world = shared.lock().unwrap();
        let section = || LiveSection {
            section: 0,
            solid: Scene::fixture("terrain").solid,
            water: Vec::new(),
        };
        world.replace_sections([1, 2], 0..1, 4, vec![section()]);
        world.remove_column([1, 2]);
        world.replace_sections([1, 2], 0..1, 4, vec![section()]);
        assert!(world.scene().solid.is_empty());
        world.replace_sections([1, 2], 0..1, 6, vec![section()]);
        assert!(!world.scene().solid.is_empty());
        world.clear();
        world.replace_sections([1, 2], 0..1, 1, vec![section()]);
        assert!(!world.scene().solid.is_empty());
    }
    #[test]
    fn empty_newer_sections_prevent_stale_mesh_resurrection() {
        let shared = LiveWorld::shared();
        let mut world = shared.lock().unwrap();
        let scene = Scene::fixture("terrain");
        world.replace_sections(
            [1, 2],
            0..1,
            4,
            vec![LiveSection {
                section: 0,
                solid: scene.solid,
                water: Vec::new(),
            }],
        );
        assert!(!world.scene().solid.is_empty());
        world.replace_sections([1, 2], 0..1, 5, Vec::new());
        world.replace_sections(
            [1, 2],
            0..1,
            4,
            vec![LiveSection {
                section: 0,
                solid: Scene::fixture("terrain").solid,
                water: Vec::new(),
            }],
        );
        assert!(world.scene().solid.is_empty());
        world.clear();
        assert!(world.frame.is_none());
    }
}
