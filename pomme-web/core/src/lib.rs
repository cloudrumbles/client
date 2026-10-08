//! Portable, deterministic voxel simulation and meshing for the browser client.
//! The raw ABI has no JavaScript glue or dependency on the native Vulkan client.
//! Calls and returned-memory reads must happen on one worker/thread.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
mod sodium_cache;
use sodium_cache::MeshSampleCache;

pub const WIDTH: usize = 128;
pub const HEIGHT: usize = 64;
pub const DEPTH: usize = 128;
pub const CHUNK_SIZE: usize = 16;
pub const CHUNKS_X: usize = WIDTH / CHUNK_SIZE;
pub const CHUNKS_Z: usize = DEPTH / CHUNK_SIZE;
pub const CHUNK_COUNT: usize = CHUNKS_X * CHUNKS_Z;
pub const VERTEX_FLOATS: usize = 14;
const WATER_LEVEL: usize = 20;

pub const AIR: u16 = 0;
pub const GRASS: u16 = 1;
pub const DIRT: u16 = 2;
pub const STONE: u16 = 3;
pub const WOOD: u16 = 4;
pub const LEAVES: u16 = 5;
pub const SAND: u16 = 6;
pub const WATER: u16 = 7;
pub const GLOW: u16 = 8;

type I3 = [i32; 3];

#[derive(Clone, Copy)]
struct Face {
    normal: I3,
    u: I3,
    v: I3,
}

#[derive(Clone, Copy, PartialEq)]
struct Surface {
    id: u16,
    ao: [f32; 4],
    light: u32,
    tint: u32,
    fluid: bool,
    heights: [f32; 4],
    bottom: f32,
    flow: [f32; 2],
}

impl Surface {
    fn mergeable(self) -> bool {
        self.ao.iter().all(|&value| value == self.ao[0])
            && self.heights.iter().all(|&value| value == self.heights[0])
            && self.flow == [0.0, 0.0]
    }
}

// Cross(u, v) = normal. This yields counterclockwise outward-facing triangles.
const FACES: [Face; 6] = [
    Face {
        normal: [1, 0, 0],
        u: [0, 0, -1],
        v: [0, 1, 0],
    },
    Face {
        normal: [-1, 0, 0],
        u: [0, 0, 1],
        v: [0, 1, 0],
    },
    Face {
        normal: [0, 1, 0],
        u: [1, 0, 0],
        v: [0, 0, -1],
    },
    Face {
        normal: [0, -1, 0],
        u: [1, 0, 0],
        v: [0, 0, 1],
    },
    Face {
        normal: [0, 0, 1],
        u: [1, 0, 0],
        v: [0, 1, 0],
    },
    Face {
        normal: [0, 0, -1],
        u: [-1, 0, 0],
        v: [0, 1, 0],
    },
];

const SECTION_BLOCKS: usize = 4096;
const FLOAT_STAGE_CAPACITY: usize = 32768;
const MAX_MODEL_FLOATS: usize = 16 * 1024 * 1024;
const MAX_COLLISION_BOXES: usize = 65536;
const SOLID: u32 = 1;
const AO_OPAQUE: u32 = 2;
const FLUID: u32 = 4;
const EMISSIVE: u32 = 8;
const CUSTOM_MODEL: u32 = 16;
const CUTOUT: u32 = 32;
const BLEND: u32 = 64;
const INVISIBLE: u32 = 128;
const HEIGHT_IGNORED: u32 = 256;
const MATERIAL_FLAGS: u32 = SOLID
    | AO_OPAQUE
    | FLUID
    | EMISSIVE
    | CUSTOM_MODEL
    | CUTOUT
    | BLEND
    | INVISIBLE
    | HEIGHT_IGNORED;
const LIGHT_PRESENT: u32 = 512;
const LIGHT_MASK: u32 = LIGHT_PRESENT | (15 << 10) | (15 << 14);
const LIGHT_BYTES: usize = SECTION_BLOCKS / 2;
const BIOME_CELLS: usize = 64;
const MAX_TINT_CACHE: usize = 131072;

#[derive(Clone, Copy, PartialEq)]
struct FaceTexture {
    tile: i32,
    rotation: u32,
    uv: [f32; 4],
    tint_kind: u8,
    tint: Option<[f32; 3]>,
}

impl Default for FaceTexture {
    fn default() -> Self {
        Self {
            tile: -1,
            rotation: 0,
            uv: [0.0, 0.0, 1.0, 1.0],
            tint_kind: 0,
            tint: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
struct BlockProperties {
    color: [f32; 3],
    flags: u32,
    registered: bool,
    textures: [FaceTexture; 6],
    emission: u8,
    fluid: ContainedFluid,
}

#[derive(Clone, Copy, Default, PartialEq)]
struct ContainedFluid {
    // 0 = empty, 1 = water (including flowing water), 2 = lava.
    kind: u8,
    level: u8,
    still_tile: i32,
    flow_tile: i32,
}

impl ContainedFluid {
    fn own_height(self) -> f32 {
        if self.kind == 0 {
            0.0
        } else {
            let amount = if self.level == 0 || self.level >= 8 {
                8
            } else {
                8 - self.level
            };
            amount as f32 / 9.0
        }
    }
}

fn default_registry() -> Vec<BlockProperties> {
    let mut registry = vec![
        BlockProperties {
            color: [1.0, 0.0, 1.0],
            flags: SOLID | AO_OPAQUE,
            registered: false,
            textures: [FaceTexture::default(); 6],
            emission: 0,
            fluid: ContainedFluid::default()
        };
        65536
    ];
    for id in AIR..=GLOW {
        registry[id as usize].registered = true;
        registry[id as usize].color = color(id, [0, 1, 0]);
        registry[id as usize].flags = match id {
            AIR => INVISIBLE,
            WATER => FLUID | BLEND,
            WOOD | LEAVES => SOLID | AO_OPAQUE | HEIGHT_IGNORED,
            GLOW => SOLID | AO_OPAQUE | EMISSIVE,
            _ => SOLID | AO_OPAQUE,
        };
        if id == GLOW {
            registry[id as usize].emission = 15;
        }
    }
    registry
}

#[derive(Clone)]
enum SectionBlocks {
    Uniform(u16),
    Dense(Box<[u16; SECTION_BLOCKS]>),
}

#[derive(Clone)]
struct Section {
    blocks: SectionBlocks,
    non_air: usize,
}

impl Section {
    fn from_slice(blocks: &[u16], non_air: usize) -> Self {
        let uniform = blocks.iter().all(|&id| id == blocks[0]);
        let storage = if uniform {
            SectionBlocks::Uniform(blocks[0])
        } else {
            let mut data = Box::new([0; SECTION_BLOCKS]);
            data.copy_from_slice(blocks);
            SectionBlocks::Dense(data)
        };
        Self {
            blocks: storage,
            non_air,
        }
    }

    fn get(&self, index: usize) -> u16 {
        match &self.blocks {
            SectionBlocks::Uniform(id) => *id,
            SectionBlocks::Dense(blocks) => blocks[index],
        }
    }

    fn set(&mut self, index: usize, id: u16) {
        if let SectionBlocks::Uniform(previous) = self.blocks {
            self.blocks = SectionBlocks::Dense(Box::new([previous; SECTION_BLOCKS]));
        }
        if let SectionBlocks::Dense(blocks) = &mut self.blocks {
            blocks[index] = id;
        }
    }

    fn equals(&self, other: &[u16]) -> bool {
        match &self.blocks {
            SectionBlocks::Uniform(id) => other.iter().all(|v| v == id),
            SectionBlocks::Dense(blocks) => blocks.as_slice() == other,
        }
    }

    fn all(&self, predicate: impl Fn(u16) -> bool) -> bool {
        match &self.blocks {
            SectionBlocks::Uniform(id) => predicate(*id),
            SectionBlocks::Dense(blocks) => blocks.iter().all(|&id| predicate(id)),
        }
    }

    fn compact(&mut self) {
        if self.all(|id| id == self.get(0)) {
            self.blocks = SectionBlocks::Uniform(self.get(0));
        }
    }
}

#[derive(Clone)]
struct Column {
    sections: Vec<Option<Section>>,
    lights: Vec<Option<LightSection>>,
    biomes: Vec<Option<Box<[u32; BIOME_CELLS]>>>,
    loaded: bool,
}

#[derive(Clone, Default)]
struct LightSection {
    sky: Option<Box<[u8; LIGHT_BYTES]>>,
    block: Option<Box<[u8; LIGHT_BYTES]>>,
}

#[derive(Clone)]
struct World {
    min_y: i32,
    height: usize,
    origin_x: i32,
    origin_z: i32,
    width_chunks: usize,
    depth_chunks: usize,
    demo: bool,
    columns: Vec<Column>,
    heights: Vec<i32>,
    dirty: Vec<bool>,
    revisions: Vec<u32>,
    revision: u32,
    mesh: Vec<f32>,
    mesh_samples: MeshSampleCache,
    ray_hit: [i32; 7],
    stage: Box<[u16; SECTION_BLOCKS]>,
    float_stage: Vec<f32>,
    registry: Vec<BlockProperties>,
    models: BTreeMap<u16, Arc<[f32]>>,
    model_tints: BTreeMap<u16, Arc<[u8]>>,
    model_tint_pool: BTreeMap<u64, Vec<Arc<[u8]>>>,
    model_tint_count: usize,
    biome_colors: BTreeMap<u32, [u32; 4]>,
    default_biome: u32,
    biome_seed: u64,
    biome_blend_radius: i32,
    swamp_permutation: [u8; 256],
    biome_sample_cache: HashMap<I3, u32>,
    biome_tint_cache: HashMap<[i32; 4], u32>,
    model_pool: BTreeMap<u64, Vec<Arc<[f32]>>>,
    collision_boxes: BTreeMap<u16, Vec<[f32; 6]>>,
    visual_overrides: BTreeMap<I3, u16>,
    model_float_count: usize,
    collision_box_count: usize,
    registry_batch_depth: u32,
    registry_pending: bool,
    collision_padding: i32,
    skylight_default: u8,
    floor_collision: bool,
}

impl World {
    fn empty() -> Self {
        let mut world = Self::configured(0, HEIGHT, 0, 0, CHUNKS_X, CHUNKS_Z);
        world.demo = true;
        world
    }

    fn valid_config(
        min_y: i32,
        height: u32,
        origin_cx: i32,
        origin_cz: i32,
        width_chunks: u32,
        depth_chunks: u32,
    ) -> bool {
        if height == 0
            || height > 1024
            || !height.is_multiple_of(16)
            || min_y % 16 != 0
            || width_chunks == 0
            || depth_chunks == 0
            || width_chunks > 32
            || depth_chunks > 32
        {
            return false;
        }
        let max_y = min_y as i64 + height as i64;
        let x0 = origin_cx as i64 * 16;
        let z0 = origin_cz as i64 * 16;
        [x0, z0, min_y as i64]
            .into_iter()
            .all(|v| v > i32::MIN as i64 + 2)
            && [
                x0 + width_chunks as i64 * 16,
                z0 + depth_chunks as i64 * 16,
                max_y,
            ]
            .into_iter()
            .all(|v| v < i32::MAX as i64 - 2)
    }

    fn configured(
        min_y: i32,
        height: usize,
        origin_cx: i32,
        origin_cz: i32,
        width_chunks: usize,
        depth_chunks: usize,
    ) -> Self {
        let chunk_count = width_chunks * depth_chunks;
        Self {
            min_y,
            height,
            origin_x: origin_cx * 16,
            origin_z: origin_cz * 16,
            width_chunks,
            depth_chunks,
            demo: false,
            columns: vec![
                Column {
                    sections: vec![None; height / 16],
                    lights: vec![None; height / 16],
                    biomes: vec![None; height / 16],
                    loaded: false
                };
                chunk_count
            ],
            heights: vec![min_y; chunk_count * 256],
            dirty: vec![true; chunk_count],
            revisions: vec![1; chunk_count],
            revision: 1,
            mesh: Vec::new(),
            mesh_samples: MeshSampleCache::default(),
            ray_hit: [0; 7],
            stage: Box::new([0; SECTION_BLOCKS]),
            float_stage: vec![0.0; FLOAT_STAGE_CAPACITY],
            registry: default_registry(),
            models: BTreeMap::new(),
            model_tints: BTreeMap::new(),
            model_tint_pool: BTreeMap::new(),
            model_tint_count: 0,
            biome_colors: BTreeMap::new(),
            default_biome: 0,
            biome_seed: 0,
            biome_blend_radius: 2,
            swamp_permutation: swamp_permutation(),
            biome_sample_cache: HashMap::new(),
            biome_tint_cache: HashMap::new(),
            model_pool: BTreeMap::new(),
            collision_boxes: BTreeMap::new(),
            visual_overrides: BTreeMap::new(),
            model_float_count: 0,
            collision_box_count: 0,
            registry_batch_depth: 0,
            registry_pending: false,
            collision_padding: 1,
            skylight_default: 15,
            floor_collision: true,
        }
    }

    fn width(&self) -> usize {
        self.width_chunks * 16
    }
    fn depth(&self) -> usize {
        self.depth_chunks * 16
    }
    fn max_y(&self) -> i32 {
        self.min_y + self.height as i32
    }

    fn column_index(&self, cx: i32, cz: i32) -> Option<usize> {
        let x = cx as i64 - (self.origin_x / 16) as i64;
        let z = cz as i64 - (self.origin_z / 16) as i64;
        if x < 0 || z < 0 || x >= self.width_chunks as i64 || z >= self.depth_chunks as i64 {
            None
        } else {
            Some(z as usize * self.width_chunks + x as usize)
        }
    }

    fn section_index(&self, sy: i32) -> Option<usize> {
        let index = sy as i64 - (self.min_y / 16) as i64;
        if index < 0 || index >= (self.height / 16) as i64 {
            None
        } else {
            Some(index as usize)
        }
    }

    fn address(&self, x: i32, y: i32, z: i32) -> Option<(usize, usize, usize)> {
        if y < self.min_y || y >= self.max_y() {
            return None;
        }
        let column = self.column_index(x.div_euclid(16), z.div_euclid(16))?;
        let section = self.section_index(y.div_euclid(16))?;
        let voxel = (y.rem_euclid(16) as usize * 16 + z.rem_euclid(16) as usize) * 16
            + x.rem_euclid(16) as usize;
        Some((column, section, voxel))
    }

    #[inline]
    fn get(&self, x: i32, y: i32, z: i32) -> u16 {
        self.address(x, y, z)
            .and_then(|(c, s, b)| {
                self.columns[c].sections[s]
                    .as_ref()
                    .map(|section| section.get(b))
            })
            .unwrap_or(AIR)
    }

    fn put_native(&mut self, x: i32, y: i32, z: i32, id: u16) -> bool {
        let Some((c, s, b)) = self.address(x, y, z) else {
            return false;
        };
        if self.get(x, y, z) == id {
            return false;
        }
        if self.columns[c].sections[s].is_none() {
            self.columns[c].sections[s] = Some(Section {
                blocks: SectionBlocks::Uniform(AIR),
                non_air: 0,
            });
        }
        if let Some(section) = self.columns[c].sections[s].as_mut() {
            section.non_air -= usize::from(section.get(b) != AIR);
            section.non_air += usize::from(id != AIR);
            section.set(b, id);
            if section.non_air == 0 {
                self.columns[c].sections[s] = None;
            }
        }
        self.columns[c].loaded = true;
        true
    }

    fn put(&mut self, x: usize, y: usize, z: usize, id: u16) {
        self.put_native(x as i32, y as i32, z as i32, id);
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.wrapping_add(1).max(1);
    }

    fn invalidate_column(&mut self, cx: i32, cz: i32) {
        if let Some(index) = self.column_index(cx, cz) {
            self.dirty[index] = true;
            self.revisions[index] = self.revision;
        }
    }

    fn invalidate_neighbours(&mut self, cx: i32, cz: i32) {
        for dz in -1..=1 {
            for dx in -1..=1 {
                self.invalidate_column(cx + dx, cz + dz);
            }
        }
    }

    fn set(&mut self, x: i32, y: i32, z: i32, id: u32) -> bool {
        if id > u16::MAX as u32 || self.demo && !self.registry[id as usize].registered {
            return false;
        }
        if !self.put_native(x, y, z, id as u16) {
            return false;
        }
        self.visual_overrides.remove(&[x, y, z]);
        self.bump_revision();
        for cz in (z - 1).div_euclid(16)..=(z + 1).div_euclid(16) {
            for cx in (x - 1).div_euclid(16)..=(x + 1).div_euclid(16) {
                self.invalidate_column(cx, cz);
            }
        }
        self.update_height(x, z);
        true
    }

    // Client animation can replace a mesh without altering collision, light,
    // heightmaps, picking, persistence, or the server's confirmed block state.
    fn set_visual_override(&mut self, p: I3, id: u32) -> bool {
        if self
            .column_index(p[0].div_euclid(16), p[2].div_euclid(16))
            .is_none()
            || self.section_index(p[1].div_euclid(16)).is_none()
            || id != u32::MAX && id > u16::MAX as u32
        {
            return false;
        }
        let changed = if id == u32::MAX {
            self.visual_overrides.remove(&p).is_some()
        } else {
            if !self.visual_overrides.contains_key(&p) && self.visual_overrides.len() >= 4096 {
                return false;
            }
            self.visual_overrides.insert(p, id as u16) != Some(id as u16)
        };
        if changed {
            self.bump_revision();
            self.invalidate_neighbours(p[0].div_euclid(16), p[2].div_euclid(16));
        }
        changed
    }

    fn is_solid(&self, id: u16) -> bool {
        self.registry[id as usize].flags & SOLID != 0
    }
    fn is_opaque(&self, id: u16) -> bool {
        self.registry[id as usize].flags & AO_OPAQUE != 0
    }
    fn is_fluid(&self, id: u16) -> bool {
        self.registry[id as usize].flags & FLUID != 0
    }
    fn is_ground(&self, id: u16) -> bool {
        let flags = self.registry[id as usize].flags;
        flags & SOLID != 0 && flags & (FLUID | INVISIBLE | HEIGHT_IGNORED) == 0
    }

    fn height_index(&self, x: i32, z: i32) -> Option<usize> {
        self.column_index(x.div_euclid(16), z.div_euclid(16))?;
        Some((z - self.origin_z) as usize * self.width() + (x - self.origin_x) as usize)
    }

    fn update_height(&mut self, x: i32, z: i32) {
        let Some(index) = self.height_index(x, z) else {
            return;
        };
        let c = self.column_index(x.div_euclid(16), z.div_euclid(16));
        let mut top = self.min_y;
        if let Some(c) = c {
            'sections: for sy in (0..self.height / 16).rev() {
                if let Some(section) = self.columns[c].sections[sy].as_ref() {
                    for local_y in (0..16).rev() {
                        let b = (local_y * 16 + z.rem_euclid(16) as usize) * 16
                            + x.rem_euclid(16) as usize;
                        if self.is_ground(section.get(b)) {
                            top = self.min_y + sy as i32 * 16 + local_y as i32 + 1;
                            break 'sections;
                        }
                    }
                }
            }
        }
        self.heights[index] = top;
    }

    fn update_column_heights(&mut self, c: usize) {
        let cx = self.origin_x + (c % self.width_chunks) as i32 * 16;
        let cz = self.origin_z + (c / self.width_chunks) as i32 * 16;
        for z in cz..cz + 16 {
            for x in cx..cx + 16 {
                self.update_height(x, z);
            }
        }
    }

    fn load_section(&mut self, cx: i32, sy: i32, cz: i32, blocks: &[u16]) -> Option<bool> {
        if blocks.len() != SECTION_BLOCKS {
            return None;
        }
        let c = self.column_index(cx, cz)?;
        let s = self.section_index(sy)?;
        let non_air = blocks.iter().filter(|&&id| id != AIR).count();
        let equal = match self.columns[c].sections[s].as_ref() {
            Some(section) => section.equals(blocks),
            None => non_air == 0,
        };
        let changed = !equal || !self.columns[c].loaded;
        if changed {
            self.columns[c].sections[s] = if non_air == 0 {
                None
            } else {
                Some(Section::from_slice(blocks, non_air))
            };
            self.columns[c].loaded = true;
            self.bump_revision();
            self.invalidate_neighbours(cx, cz);
            self.update_column_heights(c);
        }
        Some(changed)
    }

    fn unload_column(&mut self, cx: i32, cz: i32) -> bool {
        let Some(c) = self.column_index(cx, cz) else {
            return false;
        };
        if !self.columns[c].loaded
            && !self.columns[c].lights.iter().any(Option::is_some)
            && !self.columns[c].biomes.iter().any(Option::is_some)
        {
            return false;
        }
        self.columns[c].sections.fill(None);
        self.columns[c].lights.fill(None);
        self.columns[c].biomes.fill(None);
        self.biome_sample_cache.clear();
        self.biome_tint_cache.clear();
        self.columns[c].loaded = false;
        self.visual_overrides
            .retain(|p, _| p[0].div_euclid(16) != cx || p[2].div_euclid(16) != cz);
        self.bump_revision();
        self.invalidate_neighbours(cx, cz);
        self.update_column_heights(c);
        true
    }

    fn section_count(&self) -> usize {
        self.columns
            .iter()
            .map(|c| c.sections.iter().filter(|s| s.is_some()).count())
            .sum()
    }

    fn rebase(&mut self, origin_cx: i32, origin_cz: i32) -> bool {
        if !Self::valid_config(
            self.min_y,
            self.height as u32,
            origin_cx,
            origin_cz,
            self.width_chunks as u32,
            self.depth_chunks as u32,
        ) {
            return false;
        }
        if self.origin_x / 16 == origin_cx && self.origin_z / 16 == origin_cz {
            return true;
        }
        let old_cx = self.origin_x / 16;
        let old_cz = self.origin_z / 16;
        let replacement = vec![
            Column {
                sections: vec![None; self.height / 16],
                lights: vec![None; self.height / 16],
                biomes: vec![None; self.height / 16],
                loaded: false
            };
            self.columns.len()
        ];
        let previous = std::mem::replace(&mut self.columns, replacement);
        let previous_dirty = std::mem::replace(&mut self.dirty, vec![true; previous.len()]);
        let previous_revisions = std::mem::take(&mut self.revisions);
        self.bump_revision();
        self.revisions = vec![self.revision; previous.len()];
        self.biome_sample_cache.clear();
        self.biome_tint_cache.clear();
        self.origin_x = origin_cx * 16;
        self.origin_z = origin_cz * 16;
        let max_x = self.origin_x + self.width() as i32;
        let max_z = self.origin_z + self.depth() as i32;
        self.visual_overrides.retain(|p, _| {
            p[0] >= self.origin_x && p[0] < max_x && p[2] >= self.origin_z && p[2] < max_z
        });
        let mut evicted_sources = Vec::new();
        for (index, column) in previous.into_iter().enumerate() {
            let cx = old_cx + (index % self.width_chunks) as i32;
            let cz = old_cz + (index / self.width_chunks) as i32;
            if let Some(new_index) = self.column_index(cx, cz) {
                self.columns[new_index] = column;
                self.dirty[new_index] = previous_dirty[index];
                self.revisions[new_index] = previous_revisions[index];
            } else if column.loaded
                || column.lights.iter().any(Option::is_some)
                || column.biomes.iter().any(Option::is_some)
            {
                evicted_sources.push((cx, cz));
            }
        }
        // Uploaded meshes retain their original coordinate origin, so moving
        // the window does not change an interior mesh. Evicted source columns
        // can change adjacent culling, diagonal AO and native face lighting.
        // Preserve pending edits, and invalidate only their affected neighbors.
        for (cx, cz) in evicted_sources {
            self.invalidate_neighbours(cx, cz);
        }
        self.heights.fill(self.min_y);
        for c in 0..self.columns.len() {
            if self.columns[c].loaded {
                self.update_column_heights(c);
            }
        }
        true
    }

    fn registry_changed(&mut self) {
        self.biome_sample_cache.clear();
        self.biome_tint_cache.clear();
        if self.registry_batch_depth > 0 {
            self.registry_pending = true;
            return;
        }
        if !self.columns.iter().any(|column| column.loaded) {
            return;
        }
        self.bump_revision();
        self.dirty.fill(true);
        self.revisions.fill(self.revision);
        for c in 0..self.columns.len() {
            if self.columns[c].loaded {
                self.update_column_heights(c);
            }
        }
    }

    fn register(&mut self, id: u32, color: [f32; 3], flags: u32) -> bool {
        if id > u16::MAX as u32
            || flags & !MATERIAL_FLAGS != 0
            || color.iter().any(|c| !c.is_finite() || *c < 0.0 || *c > 8.0)
        {
            return false;
        }
        if id == 0 && flags != INVISIBLE && flags != 0 {
            return false;
        }
        let props = &mut self.registry[id as usize];
        let flags = if id == 0 { INVISIBLE } else { flags };
        let changed = props.color != color || props.flags != flags || !props.registered;
        props.color = color;
        props.flags = flags;
        props.registered = true;
        if flags & EMISSIVE == 0 {
            props.emission = 0;
        } else if props.emission == 0 {
            props.emission = 15;
        }
        if changed {
            self.registry_changed();
        }
        true
    }

    fn register_fluid(
        &mut self,
        id: u32,
        kind: u32,
        level: u32,
        still_tile: i32,
        flow_tile: i32,
    ) -> bool {
        if id > u16::MAX as u32
            || kind > 2
            || level > 15
            || (id == 0 && kind != 0)
            || [still_tile, flow_tile]
                .iter()
                .any(|tile| *tile < -1 || *tile > 65535)
        {
            return false;
        }
        let fluid = ContainedFluid {
            kind: kind as u8,
            level: level as u8,
            still_tile,
            flow_tile,
        };
        let properties = &mut self.registry[id as usize];
        if properties.fluid != fluid {
            properties.fluid = fluid;
            self.registry_changed();
        }
        true
    }

    // LiquidBlockRenderer.getHeight and calculateAverageHeight. The surface
    // samples block FluidState rather than moving a plant into the liquid pass.
    fn fluid_height_at(&self, p: I3, kind: u8) -> f32 {
        let properties = self.registry[self.get_render_at(p) as usize];
        if properties.fluid.kind == kind {
            if self.registry[self.get_render_at(add(p, [0, 1, 0])) as usize]
                .fluid
                .kind
                == kind
            {
                1.0
            } else {
                properties.fluid.own_height()
            }
        } else if properties.flags & SOLID != 0 {
            -1.0
        } else {
            0.0
        }
    }

    fn fluid_corner_height(&self, p: I3, kind: u8, center: f32, dx: i32, dz: i32) -> f32 {
        let horizontal = self.fluid_height_at(add(p, [dx, 0, 0]), kind);
        let vertical = self.fluid_height_at(add(p, [0, 0, dz]), kind);
        if horizontal >= 1.0 || vertical >= 1.0 {
            return 1.0;
        }
        let diagonal = if horizontal > 0.0 || vertical > 0.0 {
            self.fluid_height_at(add(p, [dx, 0, dz]), kind)
        } else {
            -1.0
        };
        if diagonal >= 1.0 {
            return 1.0;
        }
        let (mut sum, mut weight) = (0.0, 0.0);
        for height in [diagonal, center, horizontal, vertical] {
            if height >= 0.0 {
                let multiplier = if height >= 0.8 { 10.0 } else { 1.0 };
                sum += height * multiplier;
                weight += multiplier;
            }
        }
        sum / weight
    }

    fn fluid_surface(&self, p: I3, fluid: ContainedFluid) -> ([f32; 4], f32, [f32; 2]) {
        let center = self.fluid_height_at(p, fluid.kind);
        let mut heights = if center >= 1.0 {
            [1.0; 4]
        } else {
            [(-1, -1), (-1, 1), (1, 1), (1, -1)]
                .map(|(dx, dz)| self.fluid_corner_height(p, fluid.kind, center, dx, dz))
        };
        let below = self.registry[self.get_render_at(add(p, [0, -1, 0])) as usize];
        let bottom = if below.fluid.kind != fluid.kind && below.flags & AO_OPAQUE == 0 {
            0.001
        } else {
            0.0
        };
        let above = self.registry[self.get_render_at(add(p, [0, 1, 0])) as usize];
        if above.fluid.kind != fluid.kind && above.flags & AO_OPAQUE == 0 {
            heights = heights.map(|height| height - 0.001);
        }
        let mut flow = [0.0; 2];
        for (dx, dz) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let neighbor_p = add(p, [dx, 0, dz]);
            let neighbor = self.registry[self.get_render_at(neighbor_p) as usize];
            if neighbor.fluid.kind != 0 && neighbor.fluid.kind != fluid.kind {
                continue;
            }
            let other = neighbor.fluid.own_height();
            let delta = if other > 0.0 {
                fluid.own_height() - other
            } else if neighbor.flags & SOLID == 0 {
                let down =
                    self.registry[self.get_render_at(add(neighbor_p, [0, -1, 0])) as usize].fluid;
                if down.kind == fluid.kind {
                    fluid.own_height() - (down.own_height() - 8.0 / 9.0)
                } else {
                    0.0
                }
            } else {
                0.0
            };
            flow[0] += dx as f32 * delta;
            flow[1] += dz as f32 * delta;
        }
        (heights, bottom, flow)
    }

    fn load_biomes(&mut self, cx: i32, sy: i32, cz: i32, values: &[u32]) -> Option<bool> {
        if values.len() != BIOME_CELLS {
            return None;
        }
        let c = self.column_index(cx, cz)?;
        let s = self.section_index(sy)?;
        if self.columns[c].biomes[s]
            .as_ref()
            .is_some_and(|existing| existing.as_slice() == values)
        {
            return Some(false);
        }
        let mut copy = Box::new([0; BIOME_CELLS]);
        copy.copy_from_slice(values);
        self.columns[c].biomes[s] = Some(copy);
        self.biome_sample_cache.clear();
        self.biome_tint_cache.clear();
        self.bump_revision();
        // Radius <= 7 plus fuzzy quart selection reaches only adjacent columns.
        self.invalidate_neighbours(cx, cz);
        Some(true)
    }

    fn register_face_tint(&mut self, id: u32, face: u32, kind: u32, rgb: [f32; 3]) -> bool {
        if id > u16::MAX as u32
            || face >= 6
            || kind > 4
            || rgb
                .iter()
                .any(|value| !value.is_finite() || *value < 0.0 || *value > 8.0)
        {
            return false;
        }
        let texture = &mut self.registry[id as usize].textures[face as usize];
        if texture.tint_kind != kind as u8 || texture.tint != Some(rgb) {
            texture.tint_kind = kind as u8;
            texture.tint = Some(rgb);
            self.registry_changed();
        }
        true
    }

    fn register_model_tints(&mut self, id: u32, kinds: &[u8]) -> bool {
        if id > u16::MAX as u32
            || kinds.iter().any(|kind| *kind > 4)
            || self
                .models
                .get(&(id as u16))
                .is_none_or(|model| kinds.len() != model.len() / VERTEX_FLOATS)
        {
            return false;
        }
        if kinds.iter().all(|kind| *kind == 0) {
            if self.model_tints.remove(&(id as u16)).is_some() {
                self.registry_changed();
            }
            return true;
        }
        if self
            .model_tints
            .get(&(id as u16))
            .is_some_and(|existing| existing.as_ref() == kinds)
        {
            return true;
        }
        let hash = kinds.iter().fold(0xcbf29ce484222325u64, |hash, kind| {
            (hash ^ *kind as u64).wrapping_mul(0x100000001b3)
        });
        let shared = self
            .model_tint_pool
            .get(&hash)
            .and_then(|templates| templates.iter().find(|template| template.as_ref() == kinds))
            .cloned();
        let template = if let Some(shared) = shared {
            shared
        } else {
            if self.model_tint_count + kinds.len() > MAX_MODEL_FLOATS / VERTEX_FLOATS {
                return false;
            }
            let template: Arc<[u8]> = Arc::from(kinds);
            self.model_tint_count += kinds.len();
            self.model_tint_pool
                .entry(hash)
                .or_default()
                .push(Arc::clone(&template));
            template
        };
        self.model_tints.insert(id as u16, template);
        self.registry_changed();
        true
    }

    fn noise_biome(&self, quart: I3) -> u32 {
        let Some(c) = self.column_index(quart[0].div_euclid(4), quart[2].div_euclid(4)) else {
            return self.default_biome;
        };
        // LevelChunk clamps quart Y to its first/last biome section.
        let sy = quart[1]
            .div_euclid(4)
            .clamp(self.min_y / 16, self.max_y() / 16 - 1);
        let Some(s) = self.section_index(sy) else {
            return self.default_biome;
        };
        let y = quart[1]
            .clamp(self.min_y / 4, self.max_y() / 4 - 1)
            .rem_euclid(4);
        let index = ((y * 4 + quart[2].rem_euclid(4)) * 4 + quart[0].rem_euclid(4)) as usize;
        self.columns[c].biomes[s]
            .as_ref()
            .map_or(self.default_biome, |values| values[index])
    }

    fn biome_at(&mut self, p: I3) -> u32 {
        if let Some(id) = self.biome_sample_cache.get(&p) {
            return *id;
        }
        let cell = p.map(|axis| (axis - 2).div_euclid(4));
        let fraction = p.map(|axis| (axis - 2).rem_euclid(4) as f64 / 4.0);
        let mut best = f64::INFINITY;
        let mut selected = cell;
        for corner in 0..8 {
            let offset: I3 = std::array::from_fn(|axis| i32::from(corner & (4 >> axis) != 0));
            let quart = std::array::from_fn(|axis| cell[axis] + offset[axis]);
            let distance = fiddled_distance(
                self.biome_seed,
                quart,
                std::array::from_fn(|axis| fraction[axis] - offset[axis] as f64),
            );
            if distance < best {
                best = distance;
                selected = quart;
            }
        }
        let id = self.noise_biome(selected);
        if self.biome_sample_cache.len() < MAX_TINT_CACHE {
            self.biome_sample_cache.insert(p, id);
        }
        id
    }

    fn biome_tint(&mut self, mut p: I3, kind: u8) -> u32 {
        if kind == 0 {
            return 0xffffff;
        }
        let kind = if kind == 4 {
            p[1] -= 1;
            1
        } else {
            kind
        };
        let key = [p[0], p[1], p[2], kind as i32];
        if let Some(color) = self.biome_tint_cache.get(&key) {
            return *color;
        }
        let radius = self.biome_blend_radius;
        let mut sums = [0; 3];
        for z in p[2] - radius..=p[2] + radius {
            for x in p[0] - radius..=p[0] + radius {
                let id = self.biome_at([x, p[1], z]);
                let colors = self
                    .biome_colors
                    .get(&id)
                    .or_else(|| self.biome_colors.get(&self.default_biome))
                    .copied()
                    .unwrap_or([0x7cbd6b, 0x48b518, 4159204, 0]);
                let mut color = colors[kind as usize - 1];
                if kind == 1 {
                    color = match colors[3] {
                        1 => ((color & 0xfefefe) + 2634762) >> 1,
                        2 => {
                            if simplex_noise(
                                &self.swamp_permutation,
                                x as f64 * 0.0225,
                                z as f64 * 0.0225,
                            ) < -0.1
                            {
                                5011004
                            } else {
                                6975545
                            }
                        }
                        _ => color,
                    };
                }
                for (axis, sum) in sums.iter_mut().enumerate() {
                    *sum += (color >> (16 - axis * 8)) & 255;
                }
            }
        }
        let count = ((radius * 2 + 1) * (radius * 2 + 1)) as u32;
        let color = ((sums[0] / count) << 16) | ((sums[1] / count) << 8) | (sums[2] / count);
        if self.biome_tint_cache.len() < MAX_TINT_CACHE {
            self.biome_tint_cache.insert(key, color);
        }
        color
    }

    fn register_face_tile(&mut self, id: u32, face: u32, tile: i32, rotation: u32) -> bool {
        if id > u16::MAX as u32 || face >= 6 || tile < -1 || !rotation.is_multiple_of(90) {
            return false;
        }
        let texture = &mut self.registry[id as usize].textures[face as usize];
        let rotation = rotation % 360;
        if texture.tile != tile || texture.rotation != rotation {
            texture.tile = tile;
            texture.rotation = rotation;
            self.registry_changed();
        }
        true
    }

    fn register_face_uv(&mut self, id: u32, face: u32, uv: [f32; 4]) -> bool {
        if id > u16::MAX as u32 || face >= 6 || uv.iter().any(|n| !n.is_finite() || n.abs() > 64.0)
        {
            return false;
        }
        if self.registry[id as usize].textures[face as usize].uv != uv {
            self.registry[id as usize].textures[face as usize].uv = uv;
            self.registry_changed();
        }
        true
    }

    fn register_model(&mut self, id: u32, vertices: &[f32]) -> bool {
        if id > u16::MAX as u32
            || !vertices.len().is_multiple_of(VERTEX_FLOATS * 3)
            || vertices.iter().any(|v| !v.is_finite())
        {
            return false;
        }
        if vertices.is_empty() {
            self.models.remove(&(id as u16));
            self.model_tints.remove(&(id as u16));
        } else {
            let hash = vertices.iter().fold(0xcbf29ce484222325u64, |h, v| {
                (h ^ v.to_bits() as u64).wrapping_mul(0x100000001b3)
            });
            let existing = self
                .model_pool
                .get(&hash)
                .and_then(|templates| {
                    templates
                        .iter()
                        .find(|template| template.as_ref() == vertices)
                })
                .cloned();
            let template = if let Some(existing) = existing {
                existing
            } else {
                if self.model_float_count + vertices.len() > MAX_MODEL_FLOATS {
                    return false;
                }
                let template: Arc<[f32]> = Arc::from(vertices);
                self.model_float_count += vertices.len();
                self.model_pool
                    .entry(hash)
                    .or_default()
                    .push(Arc::clone(&template));
                template
            };
            self.models.insert(id as u16, template);
        }
        self.registry_changed();
        true
    }

    fn register_collisions(&mut self, id: u32, boxes: &[[f32; 6]]) -> bool {
        if id > u16::MAX as u32
            || boxes.iter().any(|b| {
                b.iter().any(|v| !v.is_finite() || v.abs() > 8.0)
                    || (0..3).any(|a| b[a] >= b[a + 3])
            })
        {
            return false;
        }
        let old_count = self.collision_boxes.get(&(id as u16)).map_or(0, Vec::len);
        if self.collision_box_count - old_count + boxes.len() > MAX_COLLISION_BOXES {
            return false;
        }
        self.collision_box_count = self.collision_box_count - old_count + boxes.len();
        for b in boxes {
            for axis in 0..3 {
                self.collision_padding = self
                    .collision_padding
                    .max((-b[axis]).max(b[axis + 3] - 1.0).ceil() as i32);
            }
        }
        self.collision_boxes.insert(id as u16, boxes.to_vec());
        self.registry_changed();
        true
    }

    fn vertex_ao(&self, p: I3, face: Face, su: i32, sv: i32) -> f32 {
        let base = add(p, face.normal);
        let side_u = self.is_opaque(self.get_render_at(add(base, mul(face.u, su))));
        let side_v = self.is_opaque(self.get_render_at(add(base, mul(face.v, sv))));
        let corner =
            self.is_opaque(self.get_render_at(add(add(base, mul(face.u, su)), mul(face.v, sv))));
        let level = if side_u && side_v {
            0
        } else {
            3 - side_u as u8 - side_v as u8 - corner as u8
        };
        0.48 + level as f32 * (0.52 / 3.0)
    }

    #[inline]
    fn get_at(&self, p: I3) -> u16 {
        self.get(p[0], p[1], p[2])
    }

    #[inline]
    fn get_render_at(&self, p: I3) -> u16 {
        if self.mesh_samples.active() {
            self.sample_states(p).1
        } else {
            self.visual_overrides
                .get(&p)
                .copied()
                .unwrap_or_else(|| self.get_at(p))
        }
    }

    #[inline]
    fn sample_states(&self, p: I3) -> (u16, u16) {
        self.mesh_samples.states(p, || {
            let physical = self.get_at(p);
            (
                physical,
                self.visual_overrides.get(&p).copied().unwrap_or(physical),
            )
        })
    }

    fn light_at(&self, p: I3) -> (u8, u8) {
        if self.mesh_samples.active() {
            self.mesh_samples.light(p, || self.light_at_uncached(p))
        } else {
            self.light_at_uncached(p)
        }
    }

    fn light_at_uncached(&self, p: I3) -> (u8, u8) {
        let Some((c, s, b)) = self.address(p[0], p[1], p[2]) else {
            return (self.skylight_default, 0);
        };
        let physical = if self.mesh_samples.active() {
            self.sample_states(p).0
        } else {
            self.get_at(p)
        };
        let emission = self.registry[physical as usize].emission;
        let Some(light) = self.columns[c].lights[s].as_ref() else {
            return (self.skylight_default, emission);
        };
        let nibble = |data: &[u8; LIGHT_BYTES]| (data[b / 2] >> ((b % 2) * 4)) & 15;
        (
            light
                .sky
                .as_ref()
                .map_or(self.skylight_default, |sky| nibble(sky)),
            light
                .block
                .as_ref()
                .map_or(0, |block| nibble(block))
                .max(emission),
        )
    }

    fn light_flags(&self, p: I3, id: u16) -> u32 {
        let (sky, block) = self.light_at(p);
        LIGHT_PRESENT
            | ((sky as u32) << 10)
            | ((block.max(self.registry[id as usize].emission) as u32) << 14)
    }

    fn load_light(
        &mut self,
        cx: i32,
        sy: i32,
        cz: i32,
        sky: Option<&[u8]>,
        block: Option<&[u8]>,
    ) -> Option<bool> {
        if sky.is_some_and(|bytes| bytes.len() != LIGHT_BYTES)
            || block.is_some_and(|bytes| bytes.len() != LIGHT_BYTES)
        {
            return None;
        }
        let c = self.column_index(cx, cz)?;
        let s = self.section_index(sy)?;
        if sky.is_none() && block.is_none() {
            return Some(false);
        }
        let mut next = self.columns[c].lights[s].clone().unwrap_or_default();
        let mut changed = false;
        for (target, incoming) in [(&mut next.sky, sky), (&mut next.block, block)] {
            if let Some(incoming) = incoming {
                if target
                    .as_ref()
                    .is_none_or(|previous| previous.as_slice() != incoming)
                {
                    let mut data = Box::new([0; LIGHT_BYTES]);
                    data.copy_from_slice(incoming);
                    *target = Some(data);
                    changed = true;
                }
            }
        }
        if changed {
            self.columns[c].lights[s] = Some(next);
            self.bump_revision();
            self.invalidate_neighbours(cx, cz);
        }
        Some(changed)
    }

    fn staged_light(&self, ptr: u32) -> Option<Option<Box<[u8; LIGHT_BYTES]>>> {
        if ptr == 0 {
            return Some(None);
        }
        let base = self.stage.as_ptr() as usize as u32;
        let offset = ptr.checked_sub(base)? as usize;
        if offset.checked_add(LIGHT_BYTES)? > SECTION_BLOCKS * 2 {
            return None;
        }
        let mut data = Box::new([0; LIGHT_BYTES]);
        for (index, byte) in data.iter_mut().enumerate() {
            let pos = offset + index;
            *byte = self.stage[pos / 2].to_le_bytes()[pos % 2];
        }
        Some(Some(data))
    }

    fn mesh_chunk(&mut self, chunk: usize, water: bool) -> usize {
        self.mesh_chunk_with_samples(chunk, water, true)
    }

    fn mesh_chunk_with_samples(&mut self, chunk: usize, water: bool, cache_samples: bool) -> usize {
        self.mesh_samples.disable();
        self.mesh.clear();
        self.biome_sample_cache.clear();
        self.biome_tint_cache.clear();
        if chunk >= self.columns.len() {
            return 0;
        }
        let cx = self.origin_x + (chunk % self.width_chunks) as i32 * 16;
        let cz = self.origin_z + (chunk / self.width_chunks) as i32 * 16;
        let sections: Vec<_> = self.columns[chunk]
            .sections
            .iter()
            .enumerate()
            .filter_map(|(index, section)| {
                section.as_ref().and_then(|section| {
                    // Ordinary terrain has no fluid in most sections. Reject
                    // the empty render pass with one contiguous state scan,
                    // before its six face scans and neighboring-block lookups.
                    // Custom models obey the same visibility and fluid flags.
                    let y = self.min_y + index as i32 * 16;
                    let has_override = self.visual_overrides.keys().any(|p| {
                        p[0] >= cx
                            && p[0] < cx + 16
                            && p[1] >= y
                            && p[1] < y + 16
                            && p[2] >= cz
                            && p[2] < cz + 16
                    });
                    if !has_override
                        && section.all(|id| {
                            let properties = self.registry[id as usize];
                            if water && properties.fluid.kind != 0 {
                                return false;
                            }
                            id == AIR
                                || properties.flags & INVISIBLE != 0
                                || self.is_fluid(id) != water
                        })
                    {
                        return None;
                    }
                    let physical_uniform = section.all(|id| {
                        if water {
                            let fluid = self.registry[id as usize].fluid;
                            let first = self.registry[section.get(0) as usize].fluid;
                            if first.kind != 0 {
                                fluid.kind == first.kind
                            } else {
                                self.is_fluid(id) && fluid.kind == 0
                            }
                        } else {
                            self.is_opaque(id)
                        }
                    });
                    Some((
                        y,
                        !has_override && physical_uniform,
                        !physical_uniform,
                        !self.models.is_empty()
                            && (has_override
                                || !section.all(|id| {
                                    let flags = self.registry[id as usize].flags;
                                    flags & CUSTOM_MODEL == 0
                                        || flags & INVISIBLE != 0
                                        || self.is_fluid(id) != water
                                })),
                    ))
                })
            })
            .collect();
        for (y, uniform_occluder, cache_worthwhile, has_models) in sections {
            // Uniform physical sections already have a cheap boundary path.
            // A visual hole must bypass uniform culling, but does not justify
            // clearing the neighborhood cache for that otherwise uniform data.
            if cache_samples && cache_worthwhile {
                self.mesh_samples.reset([cx, y, cz]);
            }
            self.mesh_region([cx, y, cz], [16, 16, 16], water, uniform_occluder);
            if has_models {
                self.emit_models([cx, y, cz], water);
            }
            self.mesh_samples.disable();
        }
        self.mesh.len() / VERTEX_FLOATS
    }

    fn mesh_region(
        &mut self,
        starts: I3,
        lengths: [usize; 3],
        water: bool,
        uniform_occluder: bool,
    ) {
        let signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        // Greedy merge flat, equally lit surfaces. Nonuniform AO stays at one
        // voxel per quad, preserving the baked corner shading exactly.
        for (face_index, face) in FACES.into_iter().enumerate() {
            let n_axis = vector_axis(face.normal);
            let u_axis = vector_axis(face.u);
            let v_axis = vector_axis(face.v);
            let width = lengths[u_axis];
            let height = lengths[v_axis];
            let position = |layer: usize, u: usize, v: usize| {
                let mut p = [0; 3];
                p[n_axis] = starts[n_axis] + layer as i32;
                p[u_axis] =
                    starts[u_axis] + (if face.u[u_axis] > 0 { u } else { width - 1 - u }) as i32;
                p[v_axis] = starts[v_axis]
                    + (if face.v[v_axis] > 0 {
                        v
                    } else {
                        height - 1 - v
                    }) as i32;
                p
            };
            let mut mask: Vec<Option<Surface>> = vec![None; width * height];
            for layer in 0..lengths[n_axis] {
                if uniform_occluder
                    && layer
                        != if face.normal[n_axis] > 0 {
                            lengths[n_axis] - 1
                        } else {
                            0
                        }
                {
                    continue;
                }
                for v in 0..height {
                    for u in 0..width {
                        let p = position(layer, u, v);
                        let id = self.get_render_at(p);
                        let adjacent = self.get_render_at(add(p, face.normal));
                        let properties = self.registry[id as usize];
                        let adjacent_properties = self.registry[adjacent as usize];
                        let contained = water && properties.fluid.kind != 0;
                        let visible = id != AIR
                            && (contained || properties.flags & (INVISIBLE | CUSTOM_MODEL) == 0)
                            && (contained || self.is_fluid(id) == water)
                            && if contained {
                                properties.flags & AO_OPAQUE == 0
                                    && !self.is_opaque(adjacent)
                                    && adjacent_properties.fluid.kind != properties.fluid.kind
                            } else if water {
                                !self.is_opaque(adjacent)
                                    && !self.is_fluid(adjacent)
                                    && adjacent_properties.fluid.kind == 0
                            } else {
                                !self.is_opaque(adjacent)
                                    && (adjacent != id
                                        || adjacent_properties.flags & INVISIBLE != 0)
                            };
                        mask[v * width + u] = if visible {
                            let (heights, bottom, flow) = if contained {
                                self.fluid_surface(p, properties.fluid)
                            } else {
                                ([1.0; 4], 0.0, [0.0; 2])
                            };
                            Some(Surface {
                                id,
                                tint: self.biome_tint(
                                    p,
                                    if contained {
                                        if properties.fluid.kind == 1 {
                                            3
                                        } else {
                                            0
                                        }
                                    } else {
                                        properties.textures[face_index].tint_kind
                                    },
                                ),
                                light: self.light_flags(add(p, face.normal), id),
                                ao: signs.map(|s| {
                                    if water {
                                        1.0
                                    } else {
                                        self.vertex_ao(p, face, s[0], s[1])
                                    }
                                }),
                                fluid: contained,
                                heights,
                                bottom,
                                flow: if face_index == 2 { flow } else { [0.0; 2] },
                            })
                        } else {
                            None
                        };
                    }
                }
                for v in 0..height {
                    let mut u = 0;
                    while u < width {
                        let Some(surface) = mask[v * width + u] else {
                            u += 1;
                            continue;
                        };
                        let mut quad_width = 1;
                        let mut quad_height = 1;
                        if surface.mergeable()
                            && (surface.fluid
                                || self.registry[surface.id as usize].textures[face_index].uv
                                    == [0.0, 0.0, 1.0, 1.0])
                        {
                            while u + quad_width < width
                                && mask[v * width + u + quad_width] == Some(surface)
                            {
                                quad_width += 1;
                            }
                            'rows: while v + quad_height < height {
                                if surface.fluid
                                    && face.normal[1] == 0
                                    && (surface.heights[0] != 1.0 || surface.bottom != 0.0)
                                {
                                    break;
                                }
                                for offset in 0..quad_width {
                                    if mask[(v + quad_height) * width + u + offset] != Some(surface)
                                    {
                                        break 'rows;
                                    }
                                }
                                quad_height += 1;
                            }
                        }
                        self.emit_quad(
                            position(layer, u, v),
                            face_index,
                            face,
                            quad_width,
                            quad_height,
                            surface,
                        );
                        for row in v..v + quad_height {
                            for column in u..u + quad_width {
                                mask[row * width + column] = None;
                            }
                        }
                        u += quad_width;
                    }
                }
            }
        }
    }

    fn emit_quad(
        &mut self,
        p: I3,
        face_index: usize,
        face: Face,
        width: usize,
        height: usize,
        surface: Surface,
    ) {
        let properties = self.registry[surface.id as usize];
        let rgb = if surface.fluid {
            rgb_components(surface.tint)
        } else if self.demo {
            color(surface.id, face.normal)
        } else {
            let base = properties.textures[face_index]
                .tint
                .unwrap_or(properties.color);
            let tint = rgb_components(surface.tint);
            std::array::from_fn(|axis| base[axis] * tint[axis])
        };
        let texture = if surface.fluid {
            FaceTexture {
                tile: if face.normal[1] == 0 || surface.flow != [0.0; 2] {
                    properties.fluid.flow_tile
                } else {
                    properties.fluid.still_tile
                },
                ..FaceTexture::default()
            }
        } else {
            properties.textures[face_index]
        };
        let corners = [
            [-0.5, -0.5],
            [width as f32 - 0.5, -0.5],
            [width as f32 - 0.5, height as f32 - 0.5],
            [-0.5, height as f32 - 0.5],
        ];
        let tex_coords = [
            [0.0, height as f32],
            [width as f32, height as f32],
            [width as f32, 0.0],
            [0.0, 0.0],
        ];
        let ao = surface.ao;
        let order = if ao[0] + ao[2] > ao[1] + ao[3] {
            [0, 1, 3, 1, 2, 3]
        } else {
            [0, 1, 2, 0, 2, 3]
        };
        for index in order {
            let corner = corners[index];
            let local = std::array::from_fn::<_, 3, _>(|axis| {
                0.5 + face.normal[axis] as f32 * 0.5
                    + face.u[axis] as f32 * corner[0]
                    + face.v[axis] as f32 * corner[1]
            });
            let fluid_height = surface.heights[match (local[0] > 0.5, local[2] > 0.5) {
                (false, false) => 0,
                (false, true) => 1,
                (true, true) => 2,
                (true, false) => 3,
            }];
            for (axis, coordinate) in p.iter().enumerate() {
                let origin = match axis {
                    0 => self.origin_x,
                    1 => self.min_y,
                    2 => self.origin_z,
                    _ => 0,
                };
                let offset = if surface.fluid && axis == 1 {
                    if face.normal[1] < 0 || face.normal[1] == 0 && local[1] < 0.5 {
                        surface.bottom
                    } else {
                        fluid_height
                            + if face.normal[1] == 0 {
                                local[1] - 1.0
                            } else {
                                0.0
                            }
                    }
                } else if surface.fluid && face.normal[axis] != 0 && axis != 1 {
                    local[axis] - face.normal[axis] as f32 * 0.001
                } else {
                    local[axis]
                };
                self.mesh.push((*coordinate - origin) as f32 + offset);
            }
            self.mesh.extend(face.normal.map(|v| v as f32));
            self.mesh.extend(rgb);
            self.mesh.push(ao[index]);
            let [u, v] = if surface.fluid && face.normal[1] == 0 {
                [
                    tex_coords[index][0] * 0.5,
                    if local[1] < 0.5 {
                        0.5
                    } else {
                        (1.0 - fluid_height) * 0.5
                    },
                ]
            } else if surface.fluid && surface.flow != [0.0; 2] {
                let angle = surface.flow[1].atan2(surface.flow[0]) - std::f32::consts::FRAC_PI_2;
                let (sin, cos) = (angle.sin() * 0.25, angle.cos() * 0.25);
                let (x, z) = (local[0] * 2.0 - 1.0, local[2] * 2.0 - 1.0);
                [0.5 + x * cos + z * sin, 0.5 + z * cos - x * sin]
            } else {
                tex_coords[index]
            };
            let [u, v] = match texture.rotation {
                90 => [v, 1.0 - u],
                180 => [1.0 - u, 1.0 - v],
                270 => [1.0 - v, u],
                _ => [u, v],
            };
            self.mesh
                .push(texture.uv[0] + u * (texture.uv[2] - texture.uv[0]));
            self.mesh
                .push(texture.uv[1] + v * (texture.uv[3] - texture.uv[1]));
            self.mesh.push(texture.tile as f32);
            let flags = if surface.fluid {
                FLUID
                    | BLEND
                    | if properties.fluid.kind == 2 {
                        EMISSIVE
                    } else {
                        0
                    }
            } else {
                properties.flags
            };
            self.mesh.push((flags | surface.light) as f32);
        }
    }

    fn emit_models(&mut self, starts: I3, water: bool) {
        for y in starts[1]..starts[1] + 16 {
            for z in starts[2]..starts[2] + 16 {
                for x in starts[0]..starts[0] + 16 {
                    let id = self.get_render_at([x, y, z]);
                    let properties = self.registry[id as usize];
                    if properties.flags & CUSTOM_MODEL == 0
                        || properties.flags & INVISIBLE != 0
                        || self.is_fluid(id) != water
                    {
                        continue;
                    }
                    let Some(model) = self.models.get(&id).cloned() else {
                        continue;
                    };
                    let tint_kinds = self.model_tints.get(&id).cloned();
                    for (triangle_index, triangle) in model
                        .as_chunks::<{ VERTEX_FLOATS * 3 }>()
                        .0
                        .iter()
                        .enumerate()
                    {
                        let cullface = triangle[13] as u32 >> 18 & 7;
                        if (1..=6).contains(&cullface)
                            && self.is_opaque(
                                self.get_render_at(add(
                                    [x, y, z],
                                    FACES[cullface as usize - 1].normal,
                                )),
                            )
                        {
                            continue;
                        }
                        for (vertex_index, vertex) in
                            triangle.as_chunks::<VERTEX_FLOATS>().0.iter().enumerate()
                        {
                            let axis = (0..3)
                                .max_by(|&a, &b| {
                                    vertex[3 + a].abs().total_cmp(&vertex[3 + b].abs())
                                })
                                .unwrap_or(1);
                            let mut normal = [0; 3];
                            normal[axis] = if vertex[3 + axis] < 0.0 { -1 } else { 1 };
                            let face = FACES
                                .into_iter()
                                .find(|face| face.normal == normal)
                                .unwrap_or(FACES[2]);
                            let side = |direction: I3| {
                                if (0..3)
                                    .map(|a| (vertex[a] - 0.5) * direction[a] as f32)
                                    .sum::<f32>()
                                    < 0.0
                                {
                                    -1
                                } else {
                                    1
                                }
                            };
                            let ao = self.vertex_ao([x, y, z], face, side(face.u), side(face.v));
                            let light = self.light_flags(add([x, y, z], face.normal), id);
                            self.mesh.extend([
                                vertex[0] + (x - self.origin_x) as f32,
                                vertex[1] + (y - self.min_y) as f32,
                                vertex[2] + (z - self.origin_z) as f32,
                            ]);
                            self.mesh.extend_from_slice(&vertex[3..]);
                            let kind = tint_kinds
                                .as_ref()
                                .and_then(|kinds| kinds.get(triangle_index * 3 + vertex_index))
                                .copied()
                                .unwrap_or(0);
                            if kind != 0 {
                                let tint = rgb_components(self.biome_tint([x, y, z], kind));
                                let start = self.mesh.len() - VERTEX_FLOATS + 6;
                                for (axis, channel) in tint.into_iter().enumerate() {
                                    self.mesh[start + axis] *= channel;
                                }
                            }
                            let ao_index = self.mesh.len() - VERTEX_FLOATS + 9;
                            self.mesh[ao_index] *= ao;
                            if let Some(flags) = self.mesh.last_mut() {
                                *flags = ((*flags as u32 & !LIGHT_MASK) | light) as f32;
                            }
                        }
                    }
                }
            }
        }
    }

    fn collides(&self, min: [f64; 3], max: [f64; 3]) -> bool {
        if min.iter().chain(max.iter()).any(|n| !n.is_finite()) {
            return true;
        }
        if (0..3).any(|i| min[i] >= max[i]) {
            return false;
        }
        if min[0] < self.origin_x as f64
            || self.floor_collision && min[1] < self.min_y as f64
            || min[2] < self.origin_z as f64
            || max[0] > (self.origin_x + self.width() as i32) as f64
            || max[2] > (self.origin_z + self.depth() as i32) as f64
        {
            return true;
        }
        let lo = min.map(|n| n.floor() as i32);
        let hi = max.map(|n| (n - 0.0001).floor() as i32);
        // Inspect adjacent cells because fence/rotated model collision boxes can
        // extend beyond their owning voxel. Every candidate is tested exactly.
        for z in lo[2].saturating_sub(self.collision_padding)
            ..=hi[2].saturating_add(self.collision_padding)
        {
            for y in lo[1].saturating_sub(self.collision_padding).max(self.min_y)
                ..=hi[1]
                    .saturating_add(self.collision_padding)
                    .min(self.max_y() - 1)
            {
                for x in lo[0].saturating_sub(self.collision_padding)
                    ..=hi[0].saturating_add(self.collision_padding)
                {
                    let id = self.get(x, y, z);
                    if !self.is_solid(id) {
                        continue;
                    }
                    let full = [[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]];
                    let boxes = self
                        .collision_boxes
                        .get(&id)
                        .map_or(full.as_slice(), Vec::as_slice);
                    for b in boxes {
                        let offset = [x as f64, y as f64, z as f64];
                        if (0..3).all(|a| {
                            min[a] < offset[a] + b[a + 3] as f64 - 0.0001
                                && max[a] > offset[a] + b[a] as f64 + 0.0001
                        }) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
    fn generate(seed: u32) -> Self {
        let mut world = Self::empty();
        for z in 0..DEPTH {
            for x in 0..WIDTH {
                let broad = noise(seed, x as f32 / 47.0, z as f32 / 47.0);
                let medium = noise(seed ^ 0xc4ab_37e9, x as f32 / 17.0, z as f32 / 17.0);
                let fine = noise(seed ^ 0x32a1_f40d, x as f32 / 6.0, z as f32 / 6.0);
                let ridge = ((x as f32 * 0.055).sin() * (z as f32 * 0.041).cos()) * 4.0;
                let top = (12.0 + broad * 17.0 + medium * 5.0 + fine * 2.0 + ridge)
                    .round()
                    .clamp(8.0, 42.0) as usize;
                world.heights[z * WIDTH + x] = (top + 1) as i32;
                for y in 0..=top {
                    let id = if y == top {
                        if top <= WATER_LEVEL + 1 {
                            SAND
                        } else {
                            GRASS
                        }
                    } else if y + 3 >= top {
                        if top <= WATER_LEVEL {
                            SAND
                        } else {
                            DIRT
                        }
                    } else {
                        STONE
                    };
                    world.put(x, y, z, id);
                }
                if top < WATER_LEVEL {
                    for y in top + 1..=WATER_LEVEL {
                        world.put(x, y, z, WATER);
                    }
                }
            }
        }

        // Stable tree placement independent of meshing and camera order.
        for z in 3..DEPTH - 3 {
            for x in 3..WIDTH - 3 {
                let h = world.heights[z * WIDTH + x] as usize;
                if h <= WATER_LEVEL + 2 || h + 7 >= HEIGHT {
                    continue;
                }
                if !hash(seed ^ 0x8774_bbf1, x as i32, z as i32).is_multiple_of(113) {
                    continue;
                }
                if world.get(x as i32, h as i32 - 1, z as i32) != GRASS {
                    continue;
                }
                // The trunk is surrounded by a compact, stepped crown.
                for y in h..h + 5 {
                    world.put(x, y, z, WOOD);
                }
                for dy in 2..=6 {
                    let radius: i32 = if dy == 6 { 1 } else { 2 };
                    for dz in -radius..=radius {
                        for dx in -radius..=radius {
                            if dx.abs() == radius && dz.abs() == radius && dy != 3 {
                                continue;
                            }
                            let px = (x as i32 + dx) as usize;
                            let pz = (z as i32 + dz) as usize;
                            if world.get(px as i32, (h + dy) as i32, pz as i32) == AIR {
                                world.put(px, h + dy, pz, LEAVES);
                            }
                        }
                    }
                }
            }
        }
        for column in &mut world.columns {
            for section in column.sections.iter_mut().flatten() {
                section.compact();
            }
        }
        world
    }

    fn raycast(&mut self, origin: [f64; 3], direction: [f64; 3], distance: f64) -> bool {
        self.ray_hit = [0; 7];
        if origin
            .iter()
            .chain(direction.iter())
            .any(|n| !n.is_finite())
            || origin
                .iter()
                .any(|n| *n < i32::MIN as f64 || *n >= i32::MAX as f64 + 1.0)
            || !distance.is_finite()
            || distance <= 0.0
        {
            return false;
        }
        let length = direction.iter().map(|n| n * n).sum::<f64>().sqrt();
        if !length.is_finite() || length <= 0.00001 {
            return false;
        }
        let dir = direction.map(|n| n / length);
        let mut cell = origin.map(|n| n.floor() as i32);
        let step = dir.map(|n| {
            if n > 0.0 {
                1
            } else if n < 0.0 {
                -1
            } else {
                0
            }
        });
        let delta = dir.map(|n| {
            if n == 0.0 {
                f64::INFINITY
            } else {
                (1.0 / n).abs()
            }
        });
        let mut t = [0.0; 3];
        for i in 0..3 {
            t[i] = if dir[i] > 0.0 {
                (cell[i] as f64 + 1.0 - origin[i]) / dir[i]
            } else if dir[i] < 0.0 {
                (cell[i] as f64 - origin[i]) / dir[i]
            } else {
                f64::INFINITY
            };
        }
        let mut travelled = 0.0;
        let mut previous = cell;
        // The bound prevents pathological input from doing unlimited CPU work.
        for _ in 0..8192 {
            if travelled > distance {
                break;
            }
            let id = self.get_at(cell);
            if self.ray_hits_voxel(id, cell, origin, dir, distance) {
                self.ray_hit = [
                    cell[0],
                    cell[1],
                    cell[2],
                    previous[0],
                    previous[1],
                    previous[2],
                    id as i32,
                ];
                return true;
            }
            previous = cell;
            let axis = if t[0] <= t[1] && t[0] <= t[2] {
                0
            } else if t[1] <= t[2] {
                1
            } else {
                2
            };
            travelled = t[axis];
            let Some(next) = cell[axis].checked_add(step[axis]) else {
                break;
            };
            cell[axis] = next;
            t[axis] += delta[axis];
        }
        false
    }

    fn ray_hits_voxel(
        &self,
        id: u16,
        position: I3,
        origin: [f64; 3],
        direction: [f64; 3],
        distance: f64,
    ) -> bool {
        let flags = self.registry[id as usize].flags;
        if id == AIR || flags & FLUID != 0 || flags & INVISIBLE != 0 && flags & SOLID == 0 {
            return false;
        }
        let offset = position.map(|p| p as f64);
        if flags & CUSTOM_MODEL != 0 {
            let Some(model) = self.models.get(&id) else {
                return false;
            };
            for triangle in model.as_chunks::<{ VERTEX_FLOATS * 3 }>().0 {
                let vertex = |index: usize| {
                    [
                        triangle[index] as f64 + offset[0],
                        triangle[index + 1] as f64 + offset[1],
                        triangle[index + 2] as f64 + offset[2],
                    ]
                };
                if ray_triangle(
                    origin,
                    direction,
                    vertex(0),
                    vertex(VERTEX_FLOATS),
                    vertex(VERTEX_FLOATS * 2),
                    distance,
                ) {
                    return true;
                }
            }
            return false;
        }
        let full = [[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]];
        let boxes = self
            .collision_boxes
            .get(&id)
            .map_or(full.as_slice(), Vec::as_slice);
        boxes.iter().any(|b| {
            ray_box(
                origin,
                direction,
                [
                    b[0] as f64 + offset[0],
                    b[1] as f64 + offset[1],
                    b[2] as f64 + offset[2],
                ],
                [
                    b[3] as f64 + offset[0],
                    b[4] as f64 + offset[1],
                    b[5] as f64 + offset[2],
                ],
                distance,
            )
        })
    }
    #[cfg(test)]
    fn snapshot(&self) -> Vec<u16> {
        (self.origin_z..self.origin_z + self.depth() as i32)
            .flat_map(|z| {
                (self.min_y..self.max_y()).flat_map(move |y| {
                    (self.origin_x..self.origin_x + self.width() as i32)
                        .map(move |x| self.get(x, y, z))
                })
            })
            .collect()
    }
}

#[inline]
fn add(a: I3, b: I3) -> I3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn mul(a: I3, b: i32) -> I3 {
    [a[0] * b, a[1] * b, a[2] * b]
}
fn vector_axis(a: I3) -> usize {
    if a[0] != 0 {
        0
    } else if a[1] != 0 {
        1
    } else {
        2
    }
}

fn ray_box(
    origin: [f64; 3],
    direction: [f64; 3],
    min: [f64; 3],
    max: [f64; 3],
    distance: f64,
) -> bool {
    let mut near: f64 = 0.0;
    let mut far = distance;
    for axis in 0..3 {
        if direction[axis].abs() < 0.000001 {
            if origin[axis] < min[axis] || origin[axis] > max[axis] {
                return false;
            }
        } else {
            let a = (min[axis] - origin[axis]) / direction[axis];
            let b = (max[axis] - origin[axis]) / direction[axis];
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return false;
            }
        }
    }
    true
}

fn ray_triangle(
    origin: [f64; 3],
    direction: [f64; 3],
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
    distance: f64,
) -> bool {
    let subtract = |x: [f64; 3], y: [f64; 3]| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let cross = |x: [f64; 3], y: [f64; 3]| {
        [
            x[1] * y[2] - x[2] * y[1],
            x[2] * y[0] - x[0] * y[2],
            x[0] * y[1] - x[1] * y[0],
        ]
    };
    let dot = |x: [f64; 3], y: [f64; 3]| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let edge1 = subtract(b, a);
    let edge2 = subtract(c, a);
    let p = cross(direction, edge2);
    let determinant = dot(edge1, p);
    if determinant.abs() < 0.000001 {
        return false;
    }
    let inverse = 1.0 / determinant;
    let t = subtract(origin, a);
    let u = dot(t, p) * inverse;
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross(t, edge1);
    let v = dot(direction, q) * inverse;
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let reach = dot(edge2, q) * inverse;
    reach >= 0.0 && reach <= distance
}
fn hash(seed: u32, x: i32, z: i32) -> u32 {
    let mut h = seed ^ (x as u32).wrapping_mul(0x9e37_79b9) ^ (z as u32).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 16)).wrapping_mul(0x7feb_352d);
    h = (h ^ (h >> 15)).wrapping_mul(0x846c_a68b);
    h ^ (h >> 16)
}

fn noise(seed: u32, x: f32, z: f32) -> f32 {
    let ix = x.floor() as i32;
    let iz = z.floor() as i32;
    let fx = x - ix as f32;
    let fz = z - iz as f32;
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let n = |px, pz| (hash(seed, px, pz) & 0xffff) as f32 / 65535.0;
    let a = n(ix, iz) * (1.0 - sx) + n(ix + 1, iz) * sx;
    let b = n(ix, iz + 1) * (1.0 - sx) + n(ix + 1, iz + 1) * sx;
    a * (1.0 - sz) + b * sz
}

fn rgb_components(color: u32) -> [f32; 3] {
    std::array::from_fn(|axis| ((color >> (16 - axis * 8)) & 255) as f32 / 255.0)
}

// Native BiomeManager's signed-long generator wraps modulo 2^64.
fn biome_lcg(seed: u64, salt: u64) -> u64 {
    seed.wrapping_mul(
        seed.wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407),
    )
    .wrapping_add(salt)
}
fn fiddled_distance(seed: u64, quart: I3, offset: [f64; 3]) -> f64 {
    let mut state = seed;
    for coordinate in quart.into_iter().chain(quart) {
        state = biome_lcg(state, coordinate as i64 as u64);
    }
    let mut jitter = [0.0; 3];
    for (axis, value) in jitter.iter_mut().enumerate() {
        *value = (((state as i64 >> 24).rem_euclid(1024) as f64 / 1024.0) - 0.5) * 0.9;
        if axis < 2 {
            state = biome_lcg(state, seed);
        }
    }
    // Preserve Java's z,y,x addition order at near-equal boundaries.
    let square = |axis: usize| (offset[axis] + jitter[axis]).powi(2);
    square(2) + square(1) + square(0)
}
fn swamp_permutation() -> [u8; 256] {
    let mut state = (2345u64 ^ 0x5deece66d) & ((1u64 << 48) - 1);
    let mut next = |bits: u32| {
        state = state.wrapping_mul(0x5deece66d).wrapping_add(11) & ((1u64 << 48) - 1);
        (state >> (48 - bits)) as u32
    };
    // SimplexNoise consumes three nextDouble calls for unused offsets.
    for _ in 0..3 {
        next(26);
        next(27);
    }
    let mut permutation = std::array::from_fn(|index| index as u8);
    for index in 0..256 {
        let bound = (256 - index) as u32;
        let value = if bound.is_power_of_two() {
            ((bound as u64 * next(31) as u64) >> 31) as u32
        } else {
            loop {
                let bits = next(31);
                let value = bits % bound;
                if bits.wrapping_sub(value).wrapping_add(bound - 1) < 0x80000000 {
                    break value;
                }
            }
        };
        permutation.swap(index, index + value as usize);
    }
    permutation
}
fn simplex_noise(permutation: &[u8; 256], x: f64, z: f64) -> f64 {
    let sqrt3 = 3.0f64.sqrt();
    let f = (sqrt3 - 1.0) * 0.5;
    let g = (3.0 - sqrt3) / 6.0;
    let skew = (x + z) * f;
    let i = (x + skew).floor() as i32;
    let j = (z + skew).floor() as i32;
    let unskew = (i + j) as f64 * g;
    let x0 = x - (i as f64 - unskew);
    let z0 = z - (j as f64 - unskew);
    let (di, dj) = if x0 > z0 { (1, 0) } else { (0, 1) };
    let lookup = |value: i32| permutation[value.rem_euclid(256) as usize] as i32;
    let gradients = [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
        [1, 0],
        [-1, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [0, 1],
        [0, -1],
    ];
    let corner = |dx: i32, dz: i32, px: f64, pz: f64| {
        let attenuation = 0.5 - px * px - pz * pz;
        if attenuation < 0.0 {
            return 0.0;
        }
        let gradient = gradients[(lookup(i + dx + lookup(j + dz)) % 12) as usize];
        let squared = attenuation * attenuation;
        squared * squared * (gradient[0] as f64 * px + gradient[1] as f64 * pz)
    };
    70.0 * (corner(0, 0, x0, z0)
        + corner(di, dj, x0 - di as f64 + g, z0 - dj as f64 + g)
        + corner(1, 1, x0 - 1.0 + 2.0 * g, z0 - 1.0 + 2.0 * g))
}

fn color(id: u16, normal: I3) -> [f32; 3] {
    match id {
        GRASS if normal[1] > 0 => [0.34, 0.56, 0.18],
        GRASS if normal[1] == 0 => [0.38, 0.38, 0.19],
        GRASS | DIRT => [0.38, 0.25, 0.14],
        STONE => [0.49, 0.51, 0.54],
        WOOD => [0.31, 0.22, 0.13],
        LEAVES => [0.25, 0.46, 0.14],
        SAND => [0.73, 0.65, 0.42],
        WATER => [0.12, 0.38, 0.53],
        GLOW => [1.0, 0.62, 0.20],
        _ => [1.0, 0.0, 1.0],
    }
}

static WORLD: Mutex<Option<World>> = Mutex::new(None);

fn world_guard() -> MutexGuard<'static, Option<World>> {
    WORLD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[no_mangle]
pub extern "C" fn world_init(seed: u32) {
    *world_guard() = Some(World::generate(seed));
}
#[no_mangle]
pub extern "C" fn world_reset(
    min_y: i32,
    height: u32,
    origin_cx: i32,
    origin_cz: i32,
    width_chunks: u32,
    depth_chunks: u32,
) -> u32 {
    if !World::valid_config(
        min_y,
        height,
        origin_cx,
        origin_cz,
        width_chunks,
        depth_chunks,
    ) {
        return 0;
    }
    let mut replacement = World::configured(
        min_y,
        height as usize,
        origin_cx,
        origin_cz,
        width_chunks as usize,
        depth_chunks as usize,
    );
    let mut guard = world_guard();
    if let Some(previous) = guard.as_mut() {
        replacement.registry = std::mem::take(&mut previous.registry);
        replacement.models = std::mem::take(&mut previous.models);
        replacement.model_tints = std::mem::take(&mut previous.model_tints);
        replacement.model_tint_pool = std::mem::take(&mut previous.model_tint_pool);
        replacement.model_tint_count = previous.model_tint_count;
        replacement.biome_colors = std::mem::take(&mut previous.biome_colors);
        replacement.default_biome = previous.default_biome;
        replacement.biome_seed = previous.biome_seed;
        replacement.biome_blend_radius = previous.biome_blend_radius;
        replacement.model_pool = std::mem::take(&mut previous.model_pool);
        replacement.collision_boxes = std::mem::take(&mut previous.collision_boxes);
        replacement.model_float_count = previous.model_float_count;
        replacement.collision_box_count = previous.collision_box_count;
        replacement.collision_padding = previous.collision_padding;
    }
    *guard = Some(replacement);
    1
}
#[no_mangle]
pub extern "C" fn world_rebase(origin_cx: i32, origin_cz: i32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.rebase(origin_cx, origin_cz) as u32)
}
#[no_mangle]
pub extern "C" fn world_width() -> u32 {
    world_guard()
        .as_ref()
        .map_or(WIDTH as u32, |w| w.width() as u32)
}
#[no_mangle]
pub extern "C" fn world_height() -> u32 {
    world_guard()
        .as_ref()
        .map_or(HEIGHT as u32, |w| w.height as u32)
}
#[no_mangle]
pub extern "C" fn world_depth() -> u32 {
    world_guard()
        .as_ref()
        .map_or(DEPTH as u32, |w| w.depth() as u32)
}
#[no_mangle]
pub extern "C" fn world_min_y() -> i32 {
    world_guard().as_ref().map_or(0, |w| w.min_y)
}
#[no_mangle]
pub extern "C" fn world_origin_x() -> i32 {
    world_guard().as_ref().map_or(0, |w| w.origin_x)
}
#[no_mangle]
pub extern "C" fn world_origin_z() -> i32 {
    world_guard().as_ref().map_or(0, |w| w.origin_z)
}
#[no_mangle]
pub extern "C" fn mesh_origin_x() -> i32 {
    world_origin_x()
}
#[no_mangle]
pub extern "C" fn mesh_origin_y() -> i32 {
    world_min_y()
}
#[no_mangle]
pub extern "C" fn mesh_origin_z() -> i32 {
    world_origin_z()
}
#[no_mangle]
pub extern "C" fn world_chunk_count() -> u32 {
    world_guard()
        .as_ref()
        .map_or(CHUNK_COUNT as u32, |w| w.columns.len() as u32)
}
#[no_mangle]
pub extern "C" fn world_chunk_size() -> u32 {
    CHUNK_SIZE as u32
}
#[no_mangle]
pub extern "C" fn mesh_vertex_stride() -> u32 {
    VERTEX_FLOATS as u32
}
#[no_mangle]
pub extern "C" fn world_revision() -> u32 {
    world_guard().as_ref().map_or(0, |w| w.revision)
}
#[no_mangle]
pub extern "C" fn world_section_count() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.section_count() as u32)
}
#[no_mangle]
pub extern "C" fn world_light_section_count() -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.columns
            .iter()
            .map(|c| c.lights.iter().filter(|s| s.is_some()).count())
            .sum::<usize>() as u32
    })
}
#[no_mangle]
pub extern "C" fn world_set_skylight_default(level: u32) -> u32 {
    if level > 15 {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.skylight_default != level as u8 {
        w.skylight_default = level as u8;
        w.bump_revision();
        w.dirty.fill(true);
        w.revisions.fill(w.revision);
    }
    1
}
#[no_mangle]
pub extern "C" fn world_set_floor_collision(enabled: u32) -> u32 {
    if enabled > 1 {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    w.floor_collision = enabled != 0;
    1
}
#[no_mangle]
pub extern "C" fn world_model_float_count() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.model_float_count as u32)
}
#[no_mangle]
pub extern "C" fn world_column_loaded(cx: i32, cz: i32) -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.column_index(cx, cz)
            .map_or(0, |c| w.columns[c].loaded as u32)
    })
}
#[no_mangle]
pub extern "C" fn world_stage_ptr() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.stage.as_ptr() as usize as u32)
}
#[no_mangle]
pub extern "C" fn world_stage_capacity() -> u32 {
    SECTION_BLOCKS as u32
}
#[no_mangle]
pub extern "C" fn world_float_stage_ptr() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.float_stage.as_ptr() as usize as u32)
}
#[no_mangle]
pub extern "C" fn world_float_stage_capacity() -> u32 {
    FLOAT_STAGE_CAPACITY as u32
}
#[no_mangle]
pub extern "C" fn block_registry_begin() -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.registry_batch_depth >= 64 {
        return 0;
    }
    w.registry_batch_depth += 1;
    1
}
#[no_mangle]
pub extern "C" fn block_registry_end() -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.registry_batch_depth == 0 {
        return 0;
    }
    w.registry_batch_depth -= 1;
    if w.registry_batch_depth == 0 && w.registry_pending {
        w.registry_pending = false;
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn block_registry_clear() -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    w.registry = default_registry();
    w.models.clear();
    w.model_tints.clear();
    w.model_tint_pool.clear();
    w.model_tint_count = 0;
    w.model_pool.clear();
    w.collision_boxes.clear();
    w.model_float_count = 0;
    w.collision_box_count = 0;
    w.collision_padding = 1;
    w.registry_changed();
    1
}
#[no_mangle]
pub extern "C" fn world_load_section(cx: i32, sy: i32, cz: i32, ptr: u32, len: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if len != SECTION_BLOCKS as u32 || ptr != w.stage.as_ptr() as usize as u32 {
        return 0;
    }
    let blocks = w.stage.to_vec();
    w.load_section(cx, sy, cz, &blocks).is_some() as u32
}
#[no_mangle]
pub extern "C" fn world_load_biomes(cx: i32, sy: i32, cz: i32, ptr: u32, len: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if len != BIOME_CELLS as u32 || ptr != w.stage.as_ptr() as usize as u32 {
        return 0;
    }
    // Copy native-endian u32s from the existing, aligned 8 KiB staging buffer.
    let values: Vec<u32> = w.stage[..BIOME_CELLS * 2]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|words| {
            u32::from_ne_bytes([
                words[0].to_ne_bytes()[0],
                words[0].to_ne_bytes()[1],
                words[1].to_ne_bytes()[0],
                words[1].to_ne_bytes()[1],
            ])
        })
        .collect();
    w.load_biomes(cx, sy, cz, &values).is_some() as u32
}
#[no_mangle]
pub extern "C" fn world_biome_tint(x: i32, y: i32, z: i32, kind: u32) -> u32 {
    if kind > 4
        || [x, y, z]
            .into_iter()
            .any(|coordinate| !(i32::MIN + 16..=i32::MAX - 16).contains(&coordinate))
    {
        return 0xffffff;
    }
    world_guard()
        .as_mut()
        .map_or(0xffffff, |w| w.biome_tint([x, y, z], kind as u8))
}
#[no_mangle]
pub extern "C" fn world_biome_section_count() -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.columns
            .iter()
            .map(|column| {
                column
                    .biomes
                    .iter()
                    .filter(|section| section.is_some())
                    .count()
            })
            .sum::<usize>() as u32
    })
}
#[no_mangle]
pub extern "C" fn biome_tints_register(
    id: u32,
    grass: u32,
    foliage: u32,
    water: u32,
    modifier: u32,
) -> u32 {
    if [grass, foliage, water]
        .into_iter()
        .any(|color| color > 0xffffff)
        || modifier > 2
    {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.biome_colors.len() >= 4096 && !w.biome_colors.contains_key(&id) {
        return 0;
    }
    let colors = [grass, foliage, water, modifier];
    if w.biome_colors.get(&id) != Some(&colors) {
        w.biome_colors.insert(id, colors);
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn biome_tints_clear() -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if !w.biome_colors.is_empty() {
        w.biome_colors.clear();
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn world_set_biome_default(id: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.default_biome != id {
        w.default_biome = id;
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn world_set_biome_seed(low: u32, high: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    let seed = (high as u64) << 32 | low as u64;
    if w.biome_seed != seed {
        w.biome_seed = seed;
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn world_set_biome_blend_radius(radius: u32) -> u32 {
    if radius > 7 {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.biome_blend_radius != radius as i32 {
        w.biome_blend_radius = radius as i32;
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn block_face_tint(id: u32, face: u32, kind: u32, r: f32, g: f32, b: f32) -> u32 {
    world_guard().as_mut().map_or(0, |w| {
        w.register_face_tint(id, face, kind, [r, g, b]) as u32
    })
}
#[no_mangle]
pub extern "C" fn block_fluid_register(
    id: u32,
    kind: u32,
    level: u32,
    still_tile: i32,
    flow_tile: i32,
) -> u32 {
    world_guard().as_mut().map_or(0, |w| {
        w.register_fluid(id, kind, level, still_tile, flow_tile) as u32
    })
}
#[no_mangle]
pub extern "C" fn block_model_tints(id: u32, ptr: u32, count: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if ptr != w.float_stage.as_ptr() as usize as u32 || count as usize > FLOAT_STAGE_CAPACITY {
        return 0;
    }
    let staged = &w.float_stage[..count as usize];
    if staged
        .iter()
        .any(|kind| !kind.is_finite() || *kind < 0.0 || *kind > 4.0 || kind.fract() != 0.0)
    {
        return 0;
    }
    let kinds: Vec<u8> = staged.iter().map(|kind| *kind as u8).collect();
    w.register_model_tints(id, &kinds) as u32
}

#[no_mangle]
pub extern "C" fn world_load_light(
    cx: i32,
    sy: i32,
    cz: i32,
    sky_ptr: u32,
    block_ptr: u32,
    len: u32,
) -> u32 {
    if len != LIGHT_BYTES as u32 {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    let Some(sky) = w.staged_light(sky_ptr) else {
        return 0;
    };
    let Some(block) = w.staged_light(block_ptr) else {
        return 0;
    };
    w.load_light(
        cx,
        sy,
        cz,
        sky.as_ref().map(|s| s.as_slice()),
        block.as_ref().map(|s| s.as_slice()),
    )
    .is_some() as u32
}
#[no_mangle]
pub extern "C" fn world_unload_column(cx: i32, cz: i32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.unload_column(cx, cz) as u32)
}
#[no_mangle]
pub extern "C" fn block_register(id: u32, r: f32, g: f32, b: f32, flags: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.register(id, [r, g, b], flags) as u32)
}
#[no_mangle]
pub extern "C" fn block_light_emission(id: u32, level: u32) -> u32 {
    if id > u16::MAX as u32 || level > 15 {
        return 0;
    }
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if w.registry[id as usize].emission != level as u8 {
        w.registry[id as usize].emission = level as u8;
        w.registry_changed();
    }
    1
}
#[no_mangle]
pub extern "C" fn block_face_tile(id: u32, face: u32, tile: i32, rotation: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.register_face_tile(id, face, tile, rotation) as u32)
}
#[no_mangle]
pub extern "C" fn block_face_uv(id: u32, face: u32, u0: f32, v0: f32, u1: f32, v1: f32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.register_face_uv(id, face, [u0, v0, u1, v1]) as u32)
}
#[no_mangle]
pub extern "C" fn block_model_register(id: u32, ptr: u32, float_count: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if ptr != w.float_stage.as_ptr() as usize as u32 || float_count as usize > FLOAT_STAGE_CAPACITY
    {
        return 0;
    }
    let vertices = w.float_stage[..float_count as usize].to_vec();
    w.register_model(id, &vertices) as u32
}
#[no_mangle]
pub extern "C" fn block_collision_register(id: u32, ptr: u32, box_count: u32) -> u32 {
    let mut guard = world_guard();
    let Some(w) = guard.as_mut() else {
        return 0;
    };
    if ptr != w.float_stage.as_ptr() as usize as u32
        || box_count as usize > FLOAT_STAGE_CAPACITY / 6
    {
        return 0;
    }
    let boxes: Vec<[f32; 6]> = w.float_stage[..box_count as usize * 6]
        .as_chunks::<6>()
        .0
        .to_vec();
    w.register_collisions(id, &boxes) as u32
}
#[no_mangle]
pub extern "C" fn block_get(x: i32, y: i32, z: i32) -> u32 {
    world_guard().as_ref().map_or(0, |w| w.get(x, y, z) as u32)
}
#[no_mangle]
pub extern "C" fn block_render_override(x: i32, y: i32, z: i32, id: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.set_visual_override([x, y, z], id) as u32)
}
#[no_mangle]
pub extern "C" fn block_solid(id: u32) -> u32 {
    if id > u16::MAX as u32 {
        0
    } else {
        world_guard()
            .as_ref()
            .map_or(0, |w| w.is_solid(id as u16) as u32)
    }
}
#[no_mangle]
pub extern "C" fn block_flags(id: u32) -> u32 {
    if id > u16::MAX as u32 {
        0
    } else {
        world_guard()
            .as_ref()
            .map_or(0, |w| w.registry[id as usize].flags)
    }
}
#[no_mangle]
pub extern "C" fn block_set(x: i32, y: i32, z: i32, id: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.set(x, y, z, id) as u32)
}
#[no_mangle]
pub extern "C" fn terrain_height(x: i32, z: i32) -> i32 {
    world_guard().as_ref().map_or(0, |w| {
        w.height_index(x, z)
            .map_or(w.min_y, |index| w.heights[index])
    })
}
#[no_mangle]
pub extern "C" fn mesh_chunk(index: u32, water: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.mesh_chunk(index as usize, water != 0) as u32)
}
#[no_mangle]
pub extern "C" fn mesh_ptr() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.mesh.as_ptr() as usize as u32)
}
#[no_mangle]
pub extern "C" fn mesh_dirty(index: u32) -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.dirty.get(index as usize).copied().unwrap_or(false) as u32
    })
}
#[no_mangle]
pub extern "C" fn mesh_clean(index: u32) {
    if let Some(w) = world_guard().as_mut() {
        if let Some(dirty) = w.dirty.get_mut(index as usize) {
            *dirty = false;
        }
    }
}
#[no_mangle]
pub extern "C" fn chunk_revision(index: u32) -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.revisions.get(index as usize).copied().unwrap_or(0))
}
#[no_mangle]
pub extern "C" fn collides_aabb(
    min_x: f64,
    min_y: f64,
    min_z: f64,
    max_x: f64,
    max_y: f64,
    max_z: f64,
) -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.collides([min_x, min_y, min_z], [max_x, max_y, max_z]) as u32
    })
}
#[no_mangle]
pub extern "C" fn ray_cast(
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    max_distance: f64,
) -> u32 {
    world_guard().as_mut().map_or(0, |w| {
        w.raycast([ox, oy, oz], [dx, dy, dz], max_distance) as u32
    })
}
#[no_mangle]
pub extern "C" fn ray_hit_ptr() -> u32 {
    world_guard()
        .as_ref()
        .map_or(0, |w| w.ray_hit.as_ptr() as usize as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_mesh(world: &mut World, cx: i32, cz: i32, water: bool) -> Vec<f64> {
        let index = world.column_index(cx, cz).unwrap();
        world.mesh_chunk(index, water);
        let mut geometry: Vec<f64> = world.mesh.iter().map(|&value| value as f64).collect();
        for vertex in geometry.as_chunks_mut::<VERTEX_FLOATS>().0 {
            vertex[0] += world.origin_x as f64;
            vertex[1] += world.min_y as f64;
            vertex[2] += world.origin_z as f64;
        }
        geometry
    }

    #[test]
    fn local_y_meshes_preserve_cubes_and_fractional_templates_at_i32_height_extremes() {
        for min_y in [-2_147_483_632, 2_147_482_608] {
            assert!(World::valid_config(min_y, 1024, 0, 0, 1, 1));
            let mut world = World::configured(min_y, 1024, 0, 0, 1, 1);
            world.register(650, [0.5, 0.6, 0.7], SOLID | AO_OPAQUE);
            world.register(651, [0.5, 0.6, 0.7], SOLID | CUSTOM_MODEL);
            let mut template = Vec::new();
            for face in FACES {
                let corners = [[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]];
                for corner in [0, 1, 2, 0, 2, 3] {
                    template.extend((0..3).map(|axis| {
                        0.5 + face.normal[axis] as f32 * 0.25
                            + face.u[axis] as f32 * corners[corner][0]
                            + face.v[axis] as f32 * corners[corner][1]
                    }));
                    template.extend(face.normal.map(|axis| axis as f32));
                    template.extend([
                        0.5,
                        0.6,
                        0.7,
                        1.0,
                        0.0,
                        0.0,
                        -1.0,
                        (SOLID | CUSTOM_MODEL) as f32,
                    ]);
                }
            }
            assert!(world.register_model(651, &template));
            assert!(world.register_collisions(651, &[[0.25, 0.25, 0.25, 0.75, 0.75, 0.75]]));
            assert!(world.set(1, min_y, 1, 650));
            assert!(world.set(2, min_y + 1023, 2, 650));
            assert!(world.set(5, min_y + 8, 5, 651));
            assert_eq!(world.mesh_chunk(0, false), 108);
            let mut cube_ys = Vec::new();
            let mut model_ys = Vec::new();
            for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
                if vertex[13] as u32 & CUSTOM_MODEL == 0 {
                    cube_ys.push(vertex[1]);
                } else {
                    model_ys.push(vertex[1]);
                }
            }
            assert_eq!(cube_ys.len(), 72);
            for y in [0.0, 1.0, 1023.0, 1024.0] {
                assert!(cube_ys.contains(&y));
            }
            assert!(cube_ys
                .iter()
                .all(|y| [0.0, 1.0, 1023.0, 1024.0].contains(y)));
            assert!(model_ys.contains(&8.25) && model_ys.contains(&8.75));
            assert!(model_ys.iter().all(|y| [8.25, 8.75].contains(y)));
            let native = native_mesh(&mut world, 0, 0, false);
            assert!(native
                .as_chunks::<VERTEX_FLOATS>()
                .0
                .iter()
                .any(|v| v[1] == min_y as f64 + 1.0));
            assert!(native
                .as_chunks::<VERTEX_FLOATS>()
                .0
                .iter()
                .any(|v| v[1] == min_y as f64 + 8.25));
            assert!(world.collides(
                [5.3, min_y as f64 + 8.3, 5.3],
                [5.7, min_y as f64 + 8.7, 5.7]
            ));
            assert!(!world.collides(
                [5.3, min_y as f64 + 8.8, 5.3],
                [5.7, min_y as f64 + 8.9, 5.7]
            ));
        }
    }

    #[test]
    fn visual_animation_overrides_preserve_confirmed_physics_and_restore_meshes() {
        let mut world = World::configured(0, 32, 0, 0, 2, 1);
        world.load_section(0, 0, 0, &[STONE; SECTION_BLOCKS]);
        world.mesh_chunk(0, false);
        let original = world.mesh.clone();
        let height = world.heights.clone();
        assert!(world.set_visual_override([8, 8, 8], AIR as u32));
        assert_eq!(world.get(8, 8, 8), STONE);
        assert!(world.collides([8.1, 8.1, 8.1], [8.9, 8.9, 8.9]));
        assert!(world.raycast([8.5, 8.5, 8.5], [1.0, 0.0, 0.0], 3.0));
        assert_eq!(&world.ray_hit[..3], &[8, 8, 8]);
        assert_eq!(world.heights, height);
        world.mesh_chunk(0, false);
        assert!(
            world.mesh.len() > original.len(),
            "the six interior hole faces must bypass uniform-section culling"
        );
        assert!(world.set_visual_override([8, 8, 8], u32::MAX));
        world.mesh_chunk(0, false);
        assert_eq!(world.mesh, original);
        assert!(world.set_visual_override([8, 8, 8], AIR as u32));
        assert!(world.rebase(1, 0));
        assert!(
            world.visual_overrides.is_empty(),
            "evicted animations cannot leak into a new column"
        );
        world.load_section(1, 0, 0, &[STONE; SECTION_BLOCKS]);
        assert!(world.set_visual_override([20, 8, 8], AIR as u32));
        assert!(world.unload_column(1, 0));
        assert!(world.visual_overrides.is_empty());
    }

    #[test]
    fn seeded_world_is_deterministic_and_varied() {
        let first = World::generate(42);
        let second = World::generate(42);
        let other = World::generate(43);
        let first_blocks = first.snapshot();
        assert_eq!(first_blocks, second.snapshot());
        assert_ne!(first_blocks, other.snapshot());
        for id in [GRASS, STONE, WOOD, LEAVES, SAND, WATER] {
            assert!(first_blocks.contains(&id), "missing block {id}");
        }
    }

    #[test]
    fn corner_edit_invalidates_ao_neighbours_and_revisions() {
        let mut world = World::empty();
        world.dirty.fill(false);
        assert!(world.set(15, 20, 15, STONE as u32));
        assert_eq!(world.dirty.iter().filter(|&&v| v).count(), 4);
        for i in [0, 1, CHUNKS_X, CHUNKS_X + 1] {
            assert!(world.dirty[i]);
            assert_eq!(world.revisions[i], world.revision);
        }
        let revision = world.revision;
        assert!(!world.set(15, 20, 15, STONE as u32));
        assert!(!world.set(-1, 20, 15, STONE as u32));
        assert!(!world.set(2, 20, 2, 999));
        assert_eq!(world.revision, revision);
    }

    #[test]
    fn mesh_excludes_internal_faces_and_separates_water() {
        let mut world = World::empty();
        world.put(2, 2, 2, STONE);
        world.put(3, 2, 2, STONE);
        // Two adjacent equal blocks become one six-sided rectangular prism.
        assert_eq!(world.mesh_chunk(0, false), 6 * 6);
        let area = world
            .mesh
            .as_chunks::<{ VERTEX_FLOATS * 3 }>()
            .0
            .iter()
            .map(|tri| {
                let u = [
                    tri[VERTEX_FLOATS] - tri[0],
                    tri[VERTEX_FLOATS + 1] - tri[1],
                    tri[VERTEX_FLOATS + 2] - tri[2],
                ];
                let v = [
                    tri[VERTEX_FLOATS * 2] - tri[0],
                    tri[VERTEX_FLOATS * 2 + 1] - tri[1],
                    tri[VERTEX_FLOATS * 2 + 2] - tri[2],
                ];
                let cross = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                cross.iter().map(|n| n * n).sum::<f32>().sqrt() * 0.5
            })
            .sum::<f32>();
        assert_eq!(area, 10.0);
        assert_eq!(world.mesh_chunk(0, true), 0);
        world.put(3, 2, 2, WATER);
        assert_eq!(world.mesh_chunk(0, false), 6 * 6);
        assert_eq!(world.mesh_chunk(0, true), 5 * 6);
        assert_eq!(world.mesh.len() % VERTEX_FLOATS, 0);
        assert!(world.mesh.iter().all(|f| f.is_finite()));
    }

    #[test]
    fn contained_water_preserves_native_plant_mesh_picking_and_fluid_continuity() {
        let mut world = World::configured(0, 16, 0, 0, 1, 1);
        assert!(world.register(500, [1.0; 3], FLUID | BLEND));
        assert!(world.register_fluid(500, 1, 0, 10, 11));
        assert!(world.register(501, [1.0; 3], CUSTOM_MODEL | CUTOUT));
        assert!(world.register_fluid(501, 1, 0, 10, 11));
        let mut model = Vec::new();
        for p in [[0.0, 0.5, 0.0], [0.0, 0.5, 1.0], [1.0, 0.5, 1.0]] {
            model.extend(p);
            model.extend([
                0.0,
                1.0,
                0.0,
                1.0,
                1.0,
                1.0,
                1.0,
                0.0,
                0.0,
                12.0,
                (CUSTOM_MODEL | CUTOUT) as f32,
            ]);
        }
        assert!(world.register_model(501, &model));
        world.load_section(0, 0, 0, &[500; SECTION_BLOCKS]);
        world.mesh_chunk(0, true);
        let full_water = world.mesh.clone();
        // The full boundary still merges instead of emitting all 4096 cubes.
        assert!(full_water.len() / VERTEX_FLOATS < 1024);
        world.set(8, 8, 8, 501);
        world.mesh_chunk(0, true);
        assert_eq!(
            full_water, world.mesh,
            "submerged plant creates no fluid cavity"
        );
        assert_eq!(world.mesh_chunk(0, false), 3);
        assert!(world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .all(|v| v[12] == 12.0 && v[13] as u32 & FLUID == 0));
        assert!(!world.collides([8.1, 8.1, 8.1], [8.9, 8.9, 8.9]));
        assert!(world.raycast([8.25, 11.0, 8.75], [0.0, -1.0, 0.0], 5.0));
        assert_eq!(&world.ray_hit[..3], &[8, 8, 8]);
    }

    #[test]
    fn native_fluid_heights_keep_source_falling_levels_and_solid_collisions_separate() {
        let mut world = World::configured(0, 16, 0, 0, 1, 1);
        assert!(world.register(500, [1.0; 3], CUSTOM_MODEL | CUTOUT));
        assert!(world.register_fluid(500, 1, 0, 10, 11));
        world.set(8, 8, 8, 500);
        assert_eq!(world.mesh_chunk(0, true), 36);
        let expected = (8.0 / 9.0) * 10.0 / 12.0 - 0.001;
        for v in world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .filter(|v| v[4] == 1.0)
        {
            assert!((v[1] - 8.0 - expected).abs() < 1e-6);
            assert_eq!(v[12], 10.0);
        }
        assert!(world.register_fluid(500, 1, 12, 10, 11));
        world.mesh_chunk(0, true);
        for v in world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .filter(|v| v[4] == 1.0)
        {
            assert!(
                (v[1] - 8.0 - expected).abs() < 1e-6,
                "falling fluid keeps amount eight"
            );
        }
        assert!(world.register_fluid(500, 1, 7, 10, 11));
        world.mesh_chunk(0, true);
        let shallow = (1.0 / 9.0) / 3.0 - 0.001;
        for v in world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .filter(|v| v[4] == 1.0)
        {
            assert!((v[1] - 8.0 - shallow).abs() < 1e-6);
        }
        assert!(world.register(501, [1.0; 3], SOLID | CUSTOM_MODEL));
        assert!(world.register_collisions(501, &[[0.0, 0.0, 0.0, 1.0, 0.5, 1.0]]));
        assert!(world.register_fluid(501, 1, 0, 10, 11));
        world.set(8, 8, 8, 501);
        assert!(world.collides([8.1, 8.1, 8.1], [8.9, 8.4, 8.9]));
        assert!(!world.collides([8.1, 8.6, 8.1], [8.9, 8.9, 8.9]));
        assert_eq!(world.heights[world.height_index(8, 8).unwrap()], 9);
        assert!(!world.register_fluid(0, 1, 0, 10, 11));
        assert!(!world.register_fluid(500, 3, 0, 10, 11));
        assert!(!world.register_fluid(500, 1, 16, 10, 11));
        assert!(!world.register_fluid(500, 1, 0, -2, 11));
        assert!(!world.register_fluid(65536, 1, 0, 10, 11));
    }

    #[test]
    fn skipping_empty_section_passes_preserves_mixed_fluid_and_custom_meshes() {
        let mut world = World::configured(0, 64, 0, 0, 1, 1);
        world.register(500, [0.7, 0.7, 0.7], SOLID | AO_OPAQUE);
        world.register(501, [0.2, 0.4, 0.8], FLUID | BLEND);
        world.register(502, [0.4, 0.7, 0.2], CUSTOM_MODEL | CUTOUT);
        world.register(503, [0.2, 0.4, 0.8], CUSTOM_MODEL | FLUID | BLEND);
        world.register(504, [0.0, 0.0, 0.0], INVISIBLE | FLUID);
        for id in [502, 503] {
            let mut vertices = Vec::new();
            for p in [[0.0, 0.5, 0.0], [0.0, 0.5, 1.0], [1.0, 0.5, 1.0]] {
                vertices.extend(p);
                vertices.extend([
                    0.0,
                    1.0,
                    0.0,
                    0.4,
                    0.7,
                    0.2,
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    world.registry[id as usize].flags as f32,
                ]);
            }
            assert!(world.register_model(id, &vertices));
        }
        let solid: Vec<_> = (0..SECTION_BLOCKS)
            .map(|index| if index % 2 == 0 { STONE } else { 500 })
            .collect();
        world.load_section(0, 0, 0, &solid);
        let mut mixed = [AIR; SECTION_BLOCKS];
        mixed[0] = 502;
        mixed[1] = 503;
        mixed[2] = 501;
        world.load_section(0, 1, 0, &mixed);
        world.load_section(0, 2, 0, &[501; SECTION_BLOCKS]);
        world.load_section(0, 3, 0, &[504; SECTION_BLOCKS]);

        for water in [false, true] {
            world.mesh_chunk(0, water);
            let optimized = world.mesh.clone();
            assert!(!optimized.is_empty());
            world.mesh.clear();
            // Original meshing visits every non-air section for both passes.
            // Compare every position, UV, model flag, AO, and light value.
            for section_y in 0..4 {
                let section = world.columns[0].sections[section_y].as_ref().unwrap();
                let uniform_occluder = section.all(|id| {
                    if water {
                        world.is_fluid(id)
                    } else {
                        world.is_opaque(id)
                    }
                });
                let start = [0, section_y as i32 * 16, 0];
                world.mesh_region(start, [16, 16, 16], water, uniform_occluder);
                world.emit_models(start, water);
            }
            assert_eq!(optimized, world.mesh);
        }
        world.load_section(0, 1, 0, &[502; SECTION_BLOCKS]);
        world.load_section(0, 2, 0, &[AIR; SECTION_BLOCKS]);
        assert_eq!(world.mesh_chunk(0, true), 0);
        world.set(2, 20, 2, 501);
        assert!(world.mesh_chunk(0, true) > 0);
        world.set(2, 20, 2, AIR as u32);
        assert_eq!(world.mesh_chunk(0, true), 0);
    }

    #[test]
    fn sodium_sample_cache_preserves_complete_meshes_across_native_mutations_and_huge_origins() {
        fn check(world: &mut World, cx: i32, cz: i32, stage: &str) {
            let column = world.column_index(cx, cz).unwrap();
            for water in [false, true] {
                world.mesh_chunk_with_samples(column, water, false);
                let expected: Vec<_> = world.mesh.iter().map(|v| v.to_bits()).collect();
                world.mesh_chunk_with_samples(column, water, true);
                let actual: Vec<_> = world.mesh.iter().map(|v| v.to_bits()).collect();
                assert_eq!(
                    actual, expected,
                    "{stage}: complete mesh at {cx},{cz}, fluid={water}"
                );
            }
            assert!(
                world
                    .mesh_samples
                    .states([cx * 16, world.min_y, cz * 16], || (7, 8))
                    == (7, 8),
                "samples must be inactive outside a mesh pass"
            );
        }
        for (origin_cx, origin_cz, min_y) in [
            (-1, -1, -32),
            (134_217_700, -134_217_720, -2_147_483_632),
            (-134_217_720, 134_217_700, 2_147_483_552),
        ] {
            assert!(World::valid_config(min_y, 32, origin_cx, origin_cz, 3, 3));
            let mut world = World::configured(min_y, 32, origin_cx, origin_cz, 3, 3);
            world.register(500, [0.6, 0.5, 0.4], SOLID | AO_OPAQUE);
            world.register(501, [0.7, 0.9, 0.5], CUSTOM_MODEL | CUTOUT);
            world.register(502, [0.4, 0.5, 0.8], FLUID | BLEND);
            world.register(503, [0.8, 0.7, 0.6], SOLID | EMISSIVE);
            world.register_fluid(501, 1, 4, 11, 12);
            world.register_fluid(502, 1, 7, 11, 12);
            let template: Vec<f32> = [
                [0.125, 0.375, 0.125],
                [0.125, 0.375, 0.875],
                [0.875, 0.375, 0.875],
            ]
            .into_iter()
            .flat_map(|p| {
                p.into_iter().chain([
                    0.0,
                    1.0,
                    0.0,
                    0.7,
                    0.9,
                    0.5,
                    1.0,
                    0.25,
                    0.75,
                    13.0,
                    (CUSTOM_MODEL | CUTOUT) as f32,
                ])
            })
            .collect();
            assert!(world.register_model(501, &template));
            for cz in origin_cz..origin_cz + 3 {
                for cx in origin_cx..origin_cx + 3 {
                    for dy in 0..2 {
                        let blocks: Vec<_> = (0..SECTION_BLOCKS)
                            .map(|index| match (index * 17 + dy * 29) % 37 {
                                0..=6 => 500,
                                7 => 501,
                                8..=10 => 502,
                                11 => 503,
                                _ => AIR,
                            })
                            .collect();
                        let sy = min_y / 16 + dy as i32;
                        assert_eq!(world.load_section(cx, sy, cz, &blocks), Some(true));
                        world.load_light(
                            cx,
                            sy,
                            cz,
                            Some(&[0x93; LIGHT_BYTES]),
                            Some(&[0x62; LIGHT_BYTES]),
                        );
                    }
                }
            }
            let cx = origin_cx + 1;
            let cz = origin_cz + 1;
            let p = [cx * 16 + 15, min_y + 15, cz * 16 + 15];
            check(
                &mut world,
                cx,
                cz,
                "initial native models and flowing fluids",
            );
            assert!(world.set_visual_override(p, AIR as u32));
            assert!(world.set(p[0] + 1, p[1] + 1, p[2] + 1, 503));
            world.load_light(
                cx,
                min_y / 16,
                cz,
                Some(&[0x12; LIGHT_BYTES]),
                Some(&[0xfe; LIGHT_BYTES]),
            );
            check(
                &mut world,
                cx,
                cz,
                "visual hole, diagonal emission and new light channels",
            );
            assert!(world.set_visual_override(p, 501));
            world.register_fluid(501, 1, 0, 14, 15);
            world.register(500, [0.4, 0.5, 0.6], SOLID);
            world.registry[503].emission = 4;
            world.registry_changed();
            check(
                &mut world,
                cx,
                cz,
                "visual native model and changed fluid/AO/emission registry",
            );
            assert!(world.set_visual_override(p, u32::MAX));
            assert!(world.unload_column(cx + 1, cz + 1));
            check(
                &mut world,
                cx,
                cz,
                "restored physical state and removed diagonal neighbor",
            );
            assert!(world.rebase(origin_cx + 1, origin_cz));
            check(
                &mut world,
                cx,
                cz,
                "window rebase with retained source column",
            );
        }
    }

    #[test]
    fn mesh_triangles_face_outward() {
        let mut world = World::empty();
        world.put(2, 2, 2, STONE);
        world.mesh_chunk(0, false);
        for tri in world.mesh.as_chunks::<{ VERTEX_FLOATS * 3 }>().0 {
            let a = &tri[0..3];
            let b = &tri[VERTEX_FLOATS..VERTEX_FLOATS + 3];
            let c = &tri[VERTEX_FLOATS * 2..VERTEX_FLOATS * 2 + 3];
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cross = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            assert!(
                cross
                    .iter()
                    .zip(&tri[3..6])
                    .map(|(c, n)| c * n)
                    .sum::<f32>()
                    > 0.0
            );
        }
    }

    #[test]
    fn ao_is_baked_and_darkens_an_occluded_corner() {
        let mut world = World::empty();
        let face = FACES[2];
        let p = [5, 5, 5];
        assert_eq!(world.vertex_ao(p, face, 1, 1), 1.0);
        world.put(5, 5, 5, STONE);
        world.put(6, 6, 5, STONE);
        world.put(5, 6, 4, STONE);
        assert!((world.vertex_ao(p, face, 1, 1) - 0.48).abs() < 0.0001);
        world.mesh_chunk(0, false);
        assert!(world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .any(|v| v[9] < 0.5));
        assert!(world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .all(|v| (0.48..=1.0).contains(&v[9])));
    }

    #[test]
    fn collision_respects_water_and_touching_surfaces() {
        let mut world = World::empty();
        world.put(2, 2, 2, STONE);
        world.put(3, 2, 2, WATER);
        assert!(world.collides([2.1, 2.1, 2.1], [2.9, 2.9, 2.9]));
        assert!(!world.collides([2.1, 3.0, 2.1], [2.9, 4.8, 2.9]));
        assert!(!world.collides([3.1, 2.1, 2.1], [3.9, 2.9, 2.9]));
        assert!(world.collides([-0.1, 2.0, 2.0], [0.1, 3.0, 3.0]));
    }

    #[test]
    fn dda_raycast_provides_exact_hit_and_placement_cell() {
        let mut world = World::empty();
        world.put(4, 2, 2, STONE);
        world.put(2, 2, 2, WATER);
        assert!(world.raycast([1.5, 2.5, 2.5], [1.0, 0.0, 0.0], 8.0));
        assert_eq!(world.ray_hit, [4, 2, 2, 3, 2, 2, STONE as i32]);
        assert!(!world.raycast([1.5, 2.5, 2.5], [1.0, 0.0, 0.0], 2.0));
        assert!(!world.raycast([1.5, 2.5, 2.5], [0.0, 0.0, 0.0], 8.0));
        assert!(world.raycast([5.5, 2.5, 2.5], [-1.0, 0.0, 0.0], 8.0));
        assert_eq!(world.ray_hit[3], 5);
    }

    #[test]
    fn terrain_height_updates_on_ground_edits() {
        let mut world = World::empty();
        world.set(2, 3, 2, STONE as u32);
        assert_eq!(world.heights[2 * WIDTH + 2], 4);
        world.set(2, 7, 2, WOOD as u32);
        assert_eq!(world.heights[2 * WIDTH + 2], 4);
        world.set(2, 3, 2, AIR as u32);
        assert_eq!(world.heights[2 * WIDTH + 2], 0);
    }

    #[test]
    fn imported_sections_preserve_native_negative_coordinates_and_u16_states() {
        let mut world = World::configured(-64, 384, -2, -3, 4, 4);
        world.dirty.fill(false);
        let mut blocks = [AIR; SECTION_BLOCKS];
        blocks[(15 * 16 + 1) * 16 + 2] = 40000;
        assert!(world.register(40000, [0.2, 0.4, 0.6], SOLID | AO_OPAQUE));
        assert_eq!(world.load_section(-1, -4, -2, &blocks), Some(true));
        assert_eq!(world.get(-14, -49, -31), 40000);
        assert_eq!(world.get(-14, -65, -31), AIR);
        assert_eq!(world.get(-14, 320, -31), AIR);
        assert_eq!(world.section_count(), 1);
        assert_eq!(
            world.revision, 2,
            "bulk import advances once for 4096 values"
        );
        let dirty: Vec<_> = world
            .dirty
            .iter()
            .enumerate()
            .filter_map(|(i, &dirty)| dirty.then_some(i))
            .collect();
        assert_eq!(dirty, [0, 1, 2, 4, 5, 6, 8, 9, 10]);
        assert_eq!(world.heights[world.height_index(-14, -31).unwrap()], -48);
        assert_eq!(world.mesh_chunk(5, false), 36);
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            assert!((18.0..=19.0).contains(&vertex[0]));
            assert!((15.0..=16.0).contains(&vertex[1]));
            assert_eq!(&vertex[6..9], &[0.2, 0.4, 0.6]);
        }
        let revision = world.revision;
        assert_eq!(world.load_section(-1, -4, -2, &blocks), Some(false));
        assert_eq!(world.revision, revision);
        assert_eq!(world.load_section(-1, -5, -2, &blocks), None);
        assert_eq!(world.load_section(-1, 20, -2, &blocks), None);
        assert_eq!(world.load_section(2, -4, -2, &blocks), None);
        assert!(world.unload_column(-1, -2));
        assert_eq!(world.section_count(), 0);
        assert_eq!(world.get(-14, -49, -31), AIR);
        assert_eq!(world.mesh_chunk(5, false), 0);
        assert!(!world.unload_column(-1, -2));
    }

    #[test]
    fn sparse_empty_and_uniform_sections_remain_compact_and_edits_expand_safely() {
        let mut world = World::configured(-64, 384, 0, 0, 2, 2);
        let empty = [AIR; SECTION_BLOCKS];
        assert_eq!(world.load_section(0, -4, 0, &empty), Some(true));
        assert!(world.columns[0].loaded);
        assert_eq!(world.section_count(), 0);
        let solid = [65535; SECTION_BLOCKS];
        assert_eq!(world.load_section(0, -4, 0, &solid), Some(true));
        assert!(matches!(
            world.columns[0].sections[0].as_ref().unwrap().blocks,
            SectionBlocks::Uniform(65535)
        ));
        assert_eq!(world.mesh_chunk(0, false), 36);
        assert!(world.set(1, -63, 1, AIR as u32));
        assert!(matches!(
            world.columns[0].sections[0].as_ref().unwrap().blocks,
            SectionBlocks::Dense(_)
        ));
        assert_eq!(world.get(0, -64, 0), 65535);
        assert_eq!(world.get(1, -63, 1), AIR);
        assert!(
            world.mesh_chunk(0, false) > 36,
            "carving reveals internal geometry"
        );
        assert_eq!(world.load_section(0, -4, 0, &empty), Some(true));
        assert_eq!(world.section_count(), 0);
    }

    #[test]
    fn moving_window_preserves_overlap_and_evicts_outside_columns() {
        let mut world = World::configured(-64, 384, -1, -1, 2, 2);
        let mut blocks = [AIR; SECTION_BLOCKS];
        blocks[0] = 300;
        world.load_section(-1, -4, -1, &blocks);
        world.load_section(0, -4, 0, &blocks);
        let revision = world.revision;
        assert!(world.rebase(0, 0));
        assert_eq!(world.origin_x, 0);
        assert_eq!(world.origin_z, 0);
        assert_eq!(world.get(0, -64, 0), 300);
        assert_eq!(world.get(-16, -64, -16), AIR);
        assert_eq!(world.section_count(), 1);
        assert!(world.columns[0].loaded);
        assert!(!world.columns[3].loaded);
        assert_eq!(world.revision, revision + 1);
        assert!(world.dirty.iter().all(|&dirty| dirty));
        assert_eq!(world.heights[0], -63);
        assert!(!world.rebase(i32::MAX, 0));
    }

    #[test]
    fn moving_full_window_preserves_exact_interior_opaque_and_fluid_meshes() {
        let mut world = World::configured(-64, 32, -8, -8, 16, 16);
        for cz in -8..8 {
            for cx in -8..8 {
                world.load_section(cx, -4, cz, &[STONE; SECTION_BLOCKS]);
                world.load_section(cx, -3, cz, &[WATER; SECTION_BLOCKS]);
                let sky = [(cx.rem_euclid(16) as u8) * 17; LIGHT_BYTES];
                let block = [(cz.rem_euclid(16) as u8) * 17; LIGHT_BYTES];
                world.load_light(cx, -3, cz, Some(&sky), Some(&block));
            }
        }
        let mut previous = BTreeMap::new();
        for cz in -8..8 {
            for cx in -6..8 {
                for water in [false, true] {
                    let geometry = native_mesh(&mut world, cx, cz, water);
                    assert!(!geometry.is_empty());
                    previous.insert((cx, cz, water), geometry);
                }
            }
        }
        let old_revisions = world.revisions.clone();
        world.dirty.fill(false);
        let revision = world.revision;
        assert!(world.rebase(-7, -8));
        assert_eq!(world.revision, revision + 1);
        assert_eq!(world.dirty.iter().filter(|&&dirty| dirty).count(), 32);
        assert_eq!(world.section_count(), 480);
        for cz in -8..8 {
            for cx in -7..9 {
                let index = world.column_index(cx, cz).unwrap();
                if cx == -7 || cx == 8 {
                    assert!(world.dirty[index]);
                    assert_eq!(world.revisions[index], world.revision);
                } else {
                    assert!(!world.dirty[index]);
                    let old_index = (cz + 8) as usize * 16 + (cx + 8) as usize;
                    assert_eq!(world.revisions[index], old_revisions[old_index]);
                    for water in [false, true] {
                        assert_eq!(
                            native_mesh(&mut world, cx, cz, water),
                            previous[&(cx, cz, water)],
                            "native mesh changed at {cx},{cz}, fluid={water}"
                        );
                    }
                    let height = world.height_index(cx * 16, cz * 16).unwrap();
                    assert_eq!(world.heights[height], -48);
                    assert!(world.collides(
                        [(cx * 16) as f64 + 0.1, -63.9, (cz * 16) as f64 + 0.1],
                        [(cx * 16) as f64 + 0.9, -63.1, (cz * 16) as f64 + 0.9]
                    ));
                }
            }
        }
    }

    #[test]
    fn moving_window_invalidates_diagonal_ao_from_evicted_sources() {
        let mut world = World::configured(0, 16, -1, -1, 4, 4);
        world.set(0, 5, 0, STONE as u32);
        world.set(-1, 6, -1, STONE as u32);
        let before = native_mesh(&mut world, 0, 0, false);
        assert!(before
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .any(|v| v[9] < 1.0));
        world.dirty.fill(false);
        assert!(world.rebase(0, 0));
        // Seven entering slots plus the retained diagonal AO neighbor.
        assert_eq!(world.dirty.iter().filter(|&&dirty| dirty).count(), 8);
        assert!(world.dirty[0]);
        assert_eq!(world.revisions[0], world.revision);
        assert!(!world.dirty[5]);
        let after = native_mesh(&mut world, 0, 0, false);
        assert_eq!(after.len(), before.len());
        assert!(after
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .all(|v| v[9] == 1.0));
        assert_ne!(after, before);
    }

    #[test]
    fn moving_window_invalidates_evicted_light_without_loaded_terrain() {
        let mut world = World::configured(0, 16, 0, 0, 4, 4);
        world.set(16, 5, 24, STONE as u32);
        world.load_light(
            0,
            0,
            1,
            Some(&[0x33; LIGHT_BYTES]),
            Some(&[0x99; LIGHT_BYTES]),
        );
        assert!(!world.columns[4].loaded);
        let before = native_mesh(&mut world, 1, 1, false);
        assert!(before.as_chunks::<VERTEX_FLOATS>().0.iter().any(|v| {
            v[3] == -1.0 && ((v[13] as u32 >> 10) & 15) == 3 && ((v[13] as u32 >> 14) & 15) == 9
        }));
        world.dirty.fill(false);
        assert!(world.rebase(1, 0));
        assert!(world.dirty[4]);
        assert_eq!(world.revisions[4], world.revision);
        let after = native_mesh(&mut world, 1, 1, false);
        assert!(after
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .filter(|v| v[3] == -1.0)
            .all(|v| { ((v[13] as u32 >> 10) & 15) == 15 && ((v[13] as u32 >> 14) & 15) == 0 }));
    }

    #[test]
    fn moving_window_preserves_pending_edit_revision_and_teleports_cleanly() {
        let mut world = World::configured(0, 16, 0, 0, 4, 4);
        for cz in 0..4 {
            for cx in 0..4 {
                world.load_section(cx, 0, cz, &[STONE; SECTION_BLOCKS]);
            }
        }
        world.dirty.fill(false);
        assert!(world.set(40, 8, 40, WATER as u32));
        let edit_revision = world.revision;
        assert!(world.rebase(1, 0));
        let index = world.column_index(2, 2).unwrap();
        assert!(world.dirty[index]);
        assert_eq!(world.revisions[index], edit_revision);
        assert_eq!(world.get(40, 8, 40), WATER);
        assert_eq!(world.dirty.iter().filter(|&&dirty| dirty).count(), 9);
        let dirty = world.dirty.clone();
        let revisions = world.revisions.clone();
        let revision = world.revision;
        assert!(world.rebase(1, 0));
        assert_eq!(world.dirty, dirty);
        assert_eq!(world.revisions, revisions);
        assert_eq!(world.revision, revision);
        assert!(world.rebase(100, -100));
        assert!(world.dirty.iter().all(|&dirty| dirty));
        assert!(world
            .revisions
            .iter()
            .all(|&revision| revision == world.revision));
        assert_eq!(world.section_count(), 0);
        assert_eq!(world.get(40, 8, 40), AIR);
        assert!(world.heights.iter().all(|&height| height == world.min_y));
    }

    #[test]
    fn invisible_native_states_do_not_render_collide_or_raise_height() {
        let mut world = World::configured(-64, 384, 0, 0, 1, 1);
        assert!(world.register(400, [0.0; 3], INVISIBLE));
        assert!(world.set(1, -60, 1, 400));
        assert_eq!(world.get(1, -60, 1), 400);
        assert_eq!(world.mesh_chunk(0, false), 0);
        assert!(!world.collides([1.1, -59.9, 1.1], [1.9, -59.1, 1.9]));
        assert_eq!(world.heights[world.height_index(1, 1).unwrap()], -64);
        assert!(!world.raycast([1.5, -57.0, 1.5], [0.0, -1.0, 0.0], 6.0));
    }

    #[test]
    fn models_share_storage_translate_geometry_and_use_native_partial_collisions() {
        let mut world = World::configured(-64, 384, -1, -1, 2, 2);
        let flags = SOLID | CUSTOM_MODEL;
        assert!(world.register(500, [0.8, 0.2, 0.1], flags));
        assert!(world.register(501, [0.8, 0.2, 0.1], flags));
        let mut template = Vec::new();
        for p in [
            [0.0, 0.5, 0.0],
            [0.0, 0.5, 1.0],
            [1.0, 0.5, 1.0],
            [0.0, 0.5, 0.0],
            [1.0, 0.5, 1.0],
            [1.0, 0.5, 0.0],
        ] {
            template.extend(p);
            template.extend([
                0.0,
                1.0,
                0.0,
                0.8,
                0.2,
                0.1,
                1.0,
                0.0,
                0.0,
                4.0,
                flags as f32,
            ]);
        }
        assert!(world.register_model(500, &template));
        assert!(world.register_model(501, &template));
        assert_eq!(
            world.model_float_count,
            template.len(),
            "identical states share one template allocation"
        );
        assert!(Arc::ptr_eq(
            world.models.get(&500).unwrap(),
            world.models.get(&501).unwrap()
        ));
        assert!(world.register_collisions(500, &[[0.0, 0.0, 0.0, 1.0, 0.5, 1.0]]));
        assert!(world.set(-14, -60, -14, 500));
        assert_eq!(
            world.mesh_chunk(0, false),
            6,
            "custom template replaces cube geometry"
        );
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            assert_eq!(vertex[1], 4.5);
            assert_eq!(vertex[12], 4.0);
            assert_eq!(vertex[13] as u32 & MATERIAL_FLAGS, flags);
        }
        assert!(world.collides([-13.9, -59.9, -13.9], [-13.1, -59.6, -13.1]));
        assert!(!world.collides([-13.9, -59.4, -13.9], [-13.1, -58.0, -13.1]));
        assert!(world.raycast([-13.5, -58.0, -13.5], [0.0, -1.0, 0.0], 6.0));
        assert!(
            !world.raycast([-15.5, -59.25, -13.5], [1.0, 0.0, 0.0], 6.0),
            "empty half of slab is not pickable"
        );
        assert!(world.register_collisions(501, &[[0.25, 0.0, 0.25, 0.75, 1.5, 0.75]]));
        assert!(world.set(-12, -60, -14, 501));
        assert!(
            world.collides([-11.7, -58.8, -13.7], [-11.3, -58.6, -13.3]),
            "fence-height box is checked from adjacent cell"
        );
        assert!(!world.register_model(500, &[f32::NAN; VERTEX_FLOATS * 3]));
        assert!(!world.register_collisions(500, &[[1.0, 0.0, 0.0, 0.0, 1.0, 1.0]]));
    }

    #[test]
    fn face_tiles_uvs_and_material_flags_survive_greedy_merging() {
        let mut world = World::configured(0, 64, 0, 0, 1, 1);
        assert!(world.register(300, [0.4, 0.5, 0.6], SOLID | AO_OPAQUE));
        for face in 0..6 {
            assert!(world.register_face_tile(300, face, face as i32 + 10, 0));
        }
        assert!(world.set(2, 2, 2, 300));
        assert!(world.set(3, 2, 2, 300));
        assert_eq!(world.mesh_chunk(0, false), 36);
        assert!(world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .any(|vertex| vertex[10] == 2.0 || vertex[11] == 2.0));
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            assert!((10.0..=15.0).contains(&vertex[12]));
            assert_eq!(vertex[13] as u32 & MATERIAL_FLAGS, SOLID | AO_OPAQUE);
            assert_eq!(vertex[13] as u32 >> 10 & 15, 15);
        }
        assert!(!world.register_face_tile(300, 6, 10, 0));
        assert!(!world.register_face_tile(300, 0, 10, 45));
        assert!(!world.register_face_uv(300, 0, [f32::INFINITY; 4]));
        assert!(world.register_face_tile(300, 2, 12, 90));
        assert!(world.register_face_uv(300, 2, [0.25, 0.25, 0.75, 0.75]));
        assert_eq!(
            world.mesh_chunk(0, false),
            42,
            "cropped faces keep one tile region per block"
        );
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            if vertex[4] == 1.0 {
                assert!((0.25..=0.75).contains(&vertex[10]));
                assert!((0.25..=0.75).contains(&vertex[11]));
            }
        }
    }

    #[test]
    fn config_rejects_unbounded_invalid_windows_before_allocating() {
        assert!(World::valid_config(-64, 384, -1000, 2000, 32, 32));
        assert!(!World::valid_config(-63, 384, 0, 0, 1, 1));
        assert!(!World::valid_config(-64, 383, 0, 0, 1, 1));
        assert!(!World::valid_config(-64, 1025, 0, 0, 1, 1));
        assert!(!World::valid_config(-64, 384, 0, 0, 33, 1));
        assert!(!World::valid_config(-64, 384, i32::MAX, 0, 1, 1));
        assert!(!World::valid_config(-64, 384, 0, 0, 0, 1));
    }

    #[test]
    fn native_light_nibbles_reach_face_vertices_and_updates_preserve_other_channel() {
        let mut world = World::configured(-64, 384, 0, 0, 1, 1);
        world.set(2, -60, 2, 300);
        let dark = [0u8; LIGHT_BYTES];
        let revision = world.revision;
        assert_eq!(
            world.load_light(0, -4, 0, Some(&dark), Some(&dark)),
            Some(true)
        );
        assert_eq!(world.revision, revision + 1);
        world.mesh_chunk(0, false);
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            assert_eq!(
                vertex[13] as u32 & LIGHT_MASK,
                LIGHT_PRESENT,
                "server zero is darkness, not absent lighting"
            );
        }
        let mut sky = dark;
        let up_index = (5 * 16 + 2) * 16 + 2;
        sky[up_index / 2] = 7;
        world.load_light(0, -4, 0, Some(&sky), None);
        let mut block = dark;
        let east_index = (4 * 16 + 2) * 16 + 3;
        block[east_index / 2] = 9 << 4;
        world.load_light(0, -4, 0, None, Some(&block));
        world.mesh_chunk(0, false);
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            if vertex[4] == 1.0 {
                assert_eq!(vertex[13] as u32 >> 10 & 15, 7);
            }
            if vertex[3] == 1.0 {
                assert_eq!(vertex[13] as u32 >> 14 & 15, 9);
            }
        }
        let revision = world.revision;
        assert_eq!(world.load_light(0, -4, 0, None, Some(&block)), Some(false));
        assert_eq!(world.revision, revision);
        assert!(world.unload_column(0, 0));
        assert!(world.columns[0].lights.iter().all(Option::is_none));
    }

    #[test]
    fn face_light_samples_air_section_across_vertical_section_boundary() {
        let mut world = World::configured(-64, 384, 0, 0, 1, 1);
        world.set(2, -49, 2, 300);
        let dark = [0u8; LIGHT_BYTES];
        let dim = [0x22u8; LIGHT_BYTES];
        world.load_light(0, -4, 0, Some(&dark), Some(&dark));
        world.load_light(0, -3, 0, Some(&dim), Some(&dark));
        assert_eq!(
            world.section_count(),
            1,
            "lighting does not allocate geometry for empty section"
        );
        world.mesh_chunk(0, false);
        for vertex in world.mesh.as_chunks::<VERTEX_FLOATS>().0 {
            let sky = vertex[13] as u32 >> 10 & 15;
            assert_eq!(sky, if vertex[4] == 1.0 { 2 } else { 0 });
        }
    }

    #[test]
    fn f64_queries_preserve_subblock_collision_and_picking_near_world_border() {
        let mut world = World::configured(-64, 384, 1874998, -1874998, 2, 2);
        let x = world.origin_x + 4;
        let z = world.origin_z + 4;
        world.set(x, -60, z, 300);
        assert!(world.collides(
            [x as f64 + 0.1, -59.9, z as f64 + 0.1],
            [x as f64 + 0.9, -59.1, z as f64 + 0.9]
        ));
        assert!(!world.collides(
            [x as f64 - 0.9, -59.9, z as f64 + 0.1],
            [x as f64 - 0.1, -59.1, z as f64 + 0.9]
        ));
        assert!(world.raycast(
            [x as f64 - 1.5, -59.5, z as f64 + 0.5],
            [1.0, 0.0, 0.0],
            6.0
        ));
        assert_eq!(world.ray_hit[0], x);
        assert_eq!(world.ray_hit[2], z);
    }

    #[test]
    fn server_world_can_fall_into_void_below_native_build_height() {
        let mut world = World::configured(0, 256, -1, -1, 2, 2);
        assert!(world.collides([0.1, -1.0, 0.1], [0.9, 0.8, 0.9]));
        world.floor_collision = false;
        assert!(!world.collides([0.1, -1.0, 0.1], [0.9, 0.8, 0.9]));
        assert!(!world.collides([0.1, -100.0, 0.1], [0.9, -98.2, 0.9]));
        world.set(0, 0, 0, 300);
        assert!(
            world.collides([0.1, -1.0, 0.1], [0.9, 0.8, 0.9]),
            "real terrain still collides while its floor boundary is disabled"
        );
    }

    #[test]
    fn visible_noncolliding_resource_models_remain_pickable() {
        let mut world = World::configured(0, 64, 0, 0, 1, 1);
        world.register(700, [0.4, 0.7, 0.2], CUSTOM_MODEL);
        let mut vertices = Vec::new();
        for p in [[0.0, 0.5, 0.0], [0.0, 0.5, 1.0], [1.0, 0.5, 1.0]] {
            vertices.extend(p);
            vertices.extend([
                0.0,
                1.0,
                0.0,
                0.4,
                0.7,
                0.2,
                1.0,
                0.0,
                0.0,
                1.0,
                CUSTOM_MODEL as f32,
            ]);
        }
        world.register_model(700, &vertices);
        world.register_collisions(700, &[]);
        world.set(2, 2, 2, 700);
        assert_eq!(world.mesh_chunk(0, false), 3);
        assert!(!world.collides([2.1, 2.1, 2.1], [2.9, 2.9, 2.9]));
        assert!(world.raycast([2.25, 4.0, 2.75], [0.0, -1.0, 0.0], 5.0));
        assert_eq!(world.ray_hit[6], 700);
    }
    #[test]
    fn native_swamp_noise_matches_java_random_and_simplex_reference() {
        let permutation = swamp_permutation();
        assert_eq!(
            &permutation[..10],
            &[64, 175, 124, 148, 10, 239, 244, 91, 138, 73]
        );
        for (x, z, expected) in [
            (0, 0, 0.0),
            (17, -33, -0.15635687620754438),
            (-450, 1200, -0.491_253_570_454_940_1),
            (30000, -30000, 0.0),
        ] {
            assert!(
                (simplex_noise(&permutation, x as f64 * 0.0225, z as f64 * 0.0225) - expected)
                    .abs()
                    < 1e-13
            );
        }
    }

    #[test]
    fn native_biome_tints_preserve_negative_quarts_blend_boundaries_and_merge_colors() {
        let mut world = World::configured(-16, 32, -1, 0, 2, 1);
        world
            .biome_colors
            .insert(1, [0xff0000, 0x00ff00, 0x0000ff, 0]);
        world
            .biome_colors
            .insert(2, [0x0000ff, 0xff0000, 0x00ff00, 0]);
        world.default_biome = 1;
        world.biome_blend_radius = 0;
        let mut biomes = [1; BIOME_CELLS];
        for y in 0..4 {
            for z in 0..4 {
                for x in 2..4 {
                    biomes[(y * 4 + z) * 4 + x] = 2;
                }
            }
        }
        assert_eq!(world.load_biomes(0, 0, 0, &biomes), Some(true));
        assert_eq!(world.load_biomes(0, 0, 0, &biomes), Some(false));
        assert_eq!(world.load_biomes(-1, -1, 0, &[2; BIOME_CELLS]), Some(true));
        assert_eq!(world.noise_biome([-1, -1, 0]), 2);
        assert_eq!(
            world.noise_biome([-1, -1000, 0]),
            2,
            "quart Y clamps to first loaded dimension section"
        );
        assert_eq!(
            world.noise_biome([3, 1000, 0]),
            2,
            "quart Y clamps to last loaded dimension section"
        );
        world.register(600, [1.0; 3], SOLID | AO_OPAQUE);
        for face in 0..6 {
            assert!(world.register_face_tint(600, face, 1, [1.0; 3]));
        }
        for z in 0..16 {
            for x in 0..16 {
                world.set(x, 8, z, 600);
            }
        }
        world.mesh_chunk(1, false);
        let tops: Vec<_> = world
            .mesh
            .as_chunks::<VERTEX_FLOATS>()
            .0
            .iter()
            .filter(|vertex| vertex[4] == 1.0)
            .collect();
        assert!(
            tops.len() > 6,
            "different native RGB colors cannot merge into one flat top"
        );
        assert!(tops
            .iter()
            .any(|vertex| vertex[6] == 1.0 && vertex[8] == 0.0));
        assert!(tops
            .iter()
            .any(|vertex| vertex[6] == 0.0 && vertex[8] == 1.0));
        world.biome_blend_radius = 2;
        world.biome_tint_cache.clear();
        let blended = world.biome_tint([8, 8, 8], 1);
        let mut red = 0;
        for z in 6..=10 {
            for x in 6..=10 {
                if world.biome_at([x, 8, z]) == 1 {
                    red += 255;
                }
            }
        }
        assert_eq!(
            blended,
            ((red / 25) << 16) | ((25 * 255 - red) / 25),
            "native integer RGB averages truncate separately"
        );
        assert!(blended != 0xff0000 && blended != 0x0000ff);
        world.biome_blend_radius = 0;
        world.load_biomes(0, 0, 0, &[1; BIOME_CELLS]);
        world.mesh_chunk(1, false);
        assert_eq!(
            world
                .mesh
                .as_chunks::<VERTEX_FLOATS>()
                .0
                .iter()
                .filter(|vertex| vertex[4] == 1.0)
                .count(),
            6,
            "uniform tints preserve greedy meshing"
        );
        let before = world.biome_tint([8, 8, 8], 3);
        world.load_biomes(0, 0, 0, &[2; BIOME_CELLS]);
        assert_ne!(
            world.biome_tint([8, 8, 8], 3),
            before,
            "biome updates invalidate cached dynamic tint samples"
        );
        assert!(
            world.collides([8.1, 8.1, 8.1], [8.9, 8.9, 8.9]),
            "tints never alter confirmed physics"
        );
        assert!(world.rebase(0, 0));
        assert_eq!(
            world.columns[0].biomes[1].as_ref().map(|values| values[0]),
            Some(2)
        );
        assert!(world.unload_column(0, 0));
        assert!(world.columns[0].biomes.iter().all(Option::is_none));
    }
}
