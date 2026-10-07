//! Portable, deterministic voxel simulation and meshing for the browser client.
//! The raw ABI has no JavaScript glue or dependency on the native Vulkan client.
//! Calls and returned-memory reads must happen on one worker/thread.

use std::sync::{Mutex, MutexGuard};

pub const WIDTH: usize = 128;
pub const HEIGHT: usize = 64;
pub const DEPTH: usize = 128;
pub const CHUNK_SIZE: usize = 16;
pub const CHUNKS_X: usize = WIDTH / CHUNK_SIZE;
pub const CHUNKS_Z: usize = DEPTH / CHUNK_SIZE;
pub const CHUNK_COUNT: usize = CHUNKS_X * CHUNKS_Z;
pub const VERTEX_FLOATS: usize = 10;
const WATER_LEVEL: usize = 20;

pub const AIR: u8 = 0;
pub const GRASS: u8 = 1;
pub const DIRT: u8 = 2;
pub const STONE: u8 = 3;
pub const WOOD: u8 = 4;
pub const LEAVES: u8 = 5;
pub const SAND: u8 = 6;
pub const WATER: u8 = 7;
pub const GLOW: u8 = 8;

type I3 = [i32; 3];

#[derive(Clone, Copy)]
struct Face {
    normal: I3,
    u: I3,
    v: I3,
}

#[derive(Clone, Copy, PartialEq)]
struct Surface {
    id: u8,
    ao: [f32; 4],
}

impl Surface {
    fn mergeable(self) -> bool {
        self.ao.iter().all(|&value| value == self.ao[0])
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

#[derive(Clone)]
struct World {
    blocks: Vec<u8>,
    heights: Vec<u16>,
    dirty: [bool; CHUNK_COUNT],
    revisions: [u32; CHUNK_COUNT],
    revision: u32,
    mesh: Vec<f32>,
    ray_hit: [i32; 7],
}

impl World {
    fn empty() -> Self {
        Self {
            blocks: vec![AIR; WIDTH * HEIGHT * DEPTH],
            heights: vec![0; WIDTH * DEPTH],
            dirty: [true; CHUNK_COUNT],
            revisions: [1; CHUNK_COUNT],
            revision: 1,
            mesh: Vec::new(),
            ray_hit: [0; 7],
        }
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
                world.heights[z * WIDTH + x] = (top + 1) as u16;
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
        world
    }

    #[inline]
    fn index(x: usize, y: usize, z: usize) -> usize {
        (z * HEIGHT + y) * WIDTH + x
    }

    #[inline]
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if x < 0 || y < 0 || z < 0 || x >= WIDTH as i32 || y >= HEIGHT as i32 || z >= DEPTH as i32 {
            AIR
        } else {
            self.blocks[Self::index(x as usize, y as usize, z as usize)]
        }
    }

    fn put(&mut self, x: usize, y: usize, z: usize, id: u8) {
        self.blocks[Self::index(x, y, z)] = id;
    }

    fn set(&mut self, x: i32, y: i32, z: i32, id: u32) -> bool {
        if x < 0
            || y < 0
            || z < 0
            || x >= WIDTH as i32
            || y >= HEIGHT as i32
            || z >= DEPTH as i32
            || id > GLOW as u32
        {
            return false;
        }
        let idx = Self::index(x as usize, y as usize, z as usize);
        if self.blocks[idx] == id as u8 {
            return false;
        }
        self.blocks[idx] = id as u8;
        self.revision = self.revision.wrapping_add(1).max(1);
        // Vertex AO samples diagonally across boundaries, so corner edits also
        // invalidate the diagonally adjacent chunk, not just face neighbours.
        for cz in ((z - 1).max(0) as usize / CHUNK_SIZE)
            ..=((z + 1).min(DEPTH as i32 - 1) as usize / CHUNK_SIZE)
        {
            for cx in ((x - 1).max(0) as usize / CHUNK_SIZE)
                ..=((x + 1).min(WIDTH as i32 - 1) as usize / CHUNK_SIZE)
            {
                let chunk = cz * CHUNKS_X + cx;
                self.dirty[chunk] = true;
                self.revisions[chunk] = self.revision;
            }
        }
        let top = (0..HEIGHT)
            .rev()
            .find(|&py| is_ground(self.get(x, py as i32, z)))
            .map_or(0, |py| py + 1);
        self.heights[z as usize * WIDTH + x as usize] = top as u16;
        true
    }

    fn vertex_ao(&self, p: I3, face: Face, su: i32, sv: i32) -> f32 {
        let base = add(p, face.normal);
        let side_u = is_solid(self.get_at(add(base, mul(face.u, su))));
        let side_v = is_solid(self.get_at(add(base, mul(face.v, sv))));
        let corner = is_solid(self.get_at(add(add(base, mul(face.u, su)), mul(face.v, sv))));
        let level = if side_u && side_v {
            0
        } else {
            3 - side_u as u8 - side_v as u8 - corner as u8
        };
        0.48 + level as f32 * (0.52 / 3.0)
    }

    #[inline]
    fn get_at(&self, p: I3) -> u8 {
        self.get(p[0], p[1], p[2])
    }

    fn mesh_chunk(&mut self, chunk: usize, water: bool) -> usize {
        self.mesh.clear();
        if chunk >= CHUNK_COUNT {
            return 0;
        }
        let x_start = (chunk % CHUNKS_X) * CHUNK_SIZE;
        let z_start = (chunk / CHUNKS_X) * CHUNK_SIZE;
        let starts = [x_start, 0, z_start];
        let lengths = [CHUNK_SIZE, HEIGHT, CHUNK_SIZE];
        let signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        // Greedy merge flat, equally lit surfaces. Nonuniform AO stays at one
        // voxel per quad, preserving the baked corner shading exactly.
        for face in FACES {
            let n_axis = vector_axis(face.normal);
            let u_axis = vector_axis(face.u);
            let v_axis = vector_axis(face.v);
            let width = lengths[u_axis];
            let height = lengths[v_axis];
            let position = |layer: usize, u: usize, v: usize| {
                let mut p = [0; 3];
                p[n_axis] = (starts[n_axis] + layer) as i32;
                p[u_axis] =
                    (starts[u_axis] + if face.u[u_axis] > 0 { u } else { width - 1 - u }) as i32;
                p[v_axis] = (starts[v_axis]
                    + if face.v[v_axis] > 0 {
                        v
                    } else {
                        height - 1 - v
                    }) as i32;
                p
            };
            let mut mask: Vec<Option<Surface>> = vec![None; width * height];
            for layer in 0..lengths[n_axis] {
                for v in 0..height {
                    for u in 0..width {
                        let p = position(layer, u, v);
                        let id = self.get_at(p);
                        let adjacent = self.get_at(add(p, face.normal));
                        let visible = id != AIR
                            && (id == WATER) == water
                            && if water {
                                adjacent == AIR
                            } else {
                                !is_solid(adjacent)
                            };
                        mask[v * width + u] = if visible {
                            Some(Surface {
                                id,
                                ao: signs.map(|s| {
                                    if water {
                                        1.0
                                    } else {
                                        self.vertex_ao(p, face, s[0], s[1])
                                    }
                                }),
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
                        if surface.mergeable() {
                            while u + quad_width < width
                                && mask[v * width + u + quad_width] == Some(surface)
                            {
                                quad_width += 1;
                            }
                            'rows: while v + quad_height < height {
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
        self.mesh.len() / VERTEX_FLOATS
    }

    fn emit_quad(&mut self, p: I3, face: Face, width: usize, height: usize, surface: Surface) {
        let rgb = color(surface.id, face.normal);
        let corners = [
            [-0.5, -0.5],
            [width as f32 - 0.5, -0.5],
            [width as f32 - 0.5, height as f32 - 0.5],
            [-0.5, height as f32 - 0.5],
        ];
        // Pick the less visible diagonal to avoid an AO crease.
        let ao = surface.ao;
        let order = if ao[0] + ao[2] > ao[1] + ao[3] {
            [0, 1, 3, 1, 2, 3]
        } else {
            [0, 1, 2, 0, 2, 3]
        };
        for index in order {
            let corner = corners[index];
            for (axis, coordinate) in p.iter().enumerate() {
                self.mesh.push(
                    *coordinate as f32
                        + 0.5
                        + face.normal[axis] as f32 * 0.5
                        + face.u[axis] as f32 * corner[0]
                        + face.v[axis] as f32 * corner[1],
                );
            }
            self.mesh.extend(face.normal.map(|v| v as f32));
            self.mesh.extend(rgb);
            self.mesh.push(ao[index]);
        }
    }

    fn collides(&self, min: [f32; 3], max: [f32; 3]) -> bool {
        if min.iter().chain(max.iter()).any(|n| !n.is_finite()) {
            return true;
        }
        if (0..3).any(|i| min[i] >= max[i]) {
            return false;
        }
        let limits = [WIDTH as f32, HEIGHT as f32, DEPTH as f32];
        // The finite demo world's horizontal edge and floor are solid. Above
        // the build height remains open for jumping and free-flight cameras.
        if min[0] < 0.0 || min[1] < 0.0 || min[2] < 0.0 || max[0] > limits[0] || max[2] > limits[2]
        {
            return true;
        }
        let lo = min.map(|n| n.floor() as i32);
        let hi = max.map(|n| (n - 0.0001).floor() as i32);
        for z in lo[2]..=hi[2] {
            for y in lo[1].max(0)..=hi[1].min(HEIGHT as i32 - 1) {
                for x in lo[0]..=hi[0] {
                    if is_solid(self.get(x, y, z)) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn raycast(&mut self, origin: [f32; 3], direction: [f32; 3], distance: f32) -> bool {
        self.ray_hit = [0; 7];
        if origin
            .iter()
            .chain(direction.iter())
            .any(|n| !n.is_finite())
            || !distance.is_finite()
            || distance <= 0.0
        {
            return false;
        }
        let length = direction.iter().map(|n| n * n).sum::<f32>().sqrt();
        if length <= 0.00001 {
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
                f32::INFINITY
            } else {
                (1.0 / n).abs()
            }
        });
        let mut t = [0.0; 3];
        for i in 0..3 {
            t[i] = if dir[i] > 0.0 {
                (cell[i] as f32 + 1.0 - origin[i]) / dir[i]
            } else if dir[i] < 0.0 {
                (cell[i] as f32 - origin[i]) / dir[i]
            } else {
                f32::INFINITY
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
            if is_solid(id) {
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
            cell[axis] += step[axis];
            t[axis] += delta[axis];
        }
        false
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
#[inline]
fn is_solid(id: u8) -> bool {
    id != AIR && id != WATER
}
fn is_ground(id: u8) -> bool {
    matches!(id, GRASS | DIRT | STONE | SAND | GLOW)
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

fn color(id: u8, normal: I3) -> [f32; 3] {
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
pub extern "C" fn world_width() -> u32 {
    WIDTH as u32
}
#[no_mangle]
pub extern "C" fn world_height() -> u32 {
    HEIGHT as u32
}
#[no_mangle]
pub extern "C" fn world_depth() -> u32 {
    DEPTH as u32
}
#[no_mangle]
pub extern "C" fn world_chunk_count() -> u32 {
    CHUNK_COUNT as u32
}
#[no_mangle]
pub extern "C" fn world_chunk_size() -> u32 {
    CHUNK_SIZE as u32
}
#[no_mangle]
pub extern "C" fn world_revision() -> u32 {
    world_guard().as_ref().map_or(0, |w| w.revision)
}
#[no_mangle]
pub extern "C" fn block_get(x: i32, y: i32, z: i32) -> u32 {
    world_guard().as_ref().map_or(0, |w| w.get(x, y, z) as u32)
}
#[no_mangle]
pub extern "C" fn block_solid(id: u32) -> u32 {
    (id > 0 && id <= GLOW as u32 && id != WATER as u32) as u32
}
#[no_mangle]
pub extern "C" fn block_set(x: i32, y: i32, z: i32, id: u32) -> u32 {
    world_guard()
        .as_mut()
        .map_or(0, |w| w.set(x, y, z, id) as u32)
}
#[no_mangle]
pub extern "C" fn terrain_height(x: i32, z: i32) -> u32 {
    if x < 0 || z < 0 || x >= WIDTH as i32 || z >= DEPTH as i32 {
        return 0;
    }
    world_guard()
        .as_ref()
        .map_or(0, |w| w.heights[z as usize * WIDTH + x as usize] as u32)
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
    min_x: f32,
    min_y: f32,
    min_z: f32,
    max_x: f32,
    max_y: f32,
    max_z: f32,
) -> u32 {
    world_guard().as_ref().map_or(0, |w| {
        w.collides([min_x, min_y, min_z], [max_x, max_y, max_z]) as u32
    })
}
#[no_mangle]
pub extern "C" fn ray_cast(
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_distance: f32,
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

    #[test]
    fn seeded_world_is_deterministic_and_varied() {
        let first = World::generate(42);
        let second = World::generate(42);
        let other = World::generate(43);
        assert_eq!(first.blocks, second.blocks);
        assert_ne!(first.blocks, other.blocks);
        for id in [GRASS, STONE, WOOD, LEAVES, SAND, WATER] {
            assert!(first.blocks.contains(&id), "missing block {id}");
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
                let u = [tri[10] - tri[0], tri[11] - tri[1], tri[12] - tri[2]];
                let v = [tri[20] - tri[0], tri[21] - tri[1], tri[22] - tri[2]];
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
    fn mesh_triangles_face_outward() {
        let mut world = World::empty();
        world.put(2, 2, 2, STONE);
        world.mesh_chunk(0, false);
        for tri in world.mesh.as_chunks::<{ VERTEX_FLOATS * 3 }>().0 {
            let a = &tri[0..3];
            let b = &tri[10..13];
            let c = &tri[20..23];
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
}
