//! Deterministic block scenes for pack ABI validation and repeatable profiling.
//! These are fixtures, not a substitute for Minecraft world simulation.
use glam::{Mat4, Vec3};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
    pub light: [f32; 2],
    pub color: [f32; 4],
    pub tangent: [f32; 4],
    pub material: [f32; 3],
    pub mid_uv: [f32; 2],
}
pub struct Scene {
    pub solid: Vec<Vertex>,
    pub water: Vec<Vertex>,
    pub camera: Vec3,
    pub target: Vec3,
    /// Vertex material.x indexes these Minecraft block names, rather than a
    /// pack-specific ID.
    pub materials: Vec<String>,
}
impl Scene {
    pub fn fixture(name: &str) -> Self {
        let mut scene = Self {
            solid: Vec::new(),
            water: Vec::new(),
            camera: Vec3::new(28.0, 76.0, 36.0),
            target: Vec3::new(0.0, 65.0, 0.0),
            materials: ["grass_block", "stone", "oak_leaves", "water"]
                .map(String::from)
                .to_vec(),
        };
        for x in -24i32..24 {
            for z in -24i32..24 {
                let height = 64
                    + (x as f32 * 0.17)
                        .sin()
                        .mul_add(2.0, (z as f32 * 0.19).cos() * 2.0) as i32;
                scene.cube(
                    Vec3::new(x as f32, height as f32, z as f32),
                    0,
                    [0.55, 0.8, 0.32, 1.0],
                    240.0,
                    false,
                );
            }
        }
        // Stone pillars cast visible shadows; foliage exercises material IDs.
        for (x, z, h) in [(-7, -4, 7), (3, -8, 11), (9, 5, 5), (-12, 9, 6)] {
            for y in 64..64 + h {
                scene.cube(
                    Vec3::new(x as f32, y as f32, z as f32),
                    1,
                    [1.0; 4],
                    240.0,
                    false,
                );
            }
        }
        for x in -8..-3 {
            for z in 1..6 {
                scene.cube(
                    Vec3::new(x as f32, 72.0, z as f32),
                    2,
                    [0.6, 0.85, 0.4, 1.0],
                    240.0,
                    false,
                );
            }
        }
        if name == "water" {
            for x in -3..8 {
                for z in -3..8 {
                    scene.cube(
                        Vec3::new(x as f32, 68.0, z as f32),
                        3,
                        [0.3, 0.55, 0.85, 1.0],
                        240.0,
                        true,
                    );
                }
            }
        }
        if name == "cave" {
            scene.camera = Vec3::new(0.0, 67.0, 12.0);
            scene.target = Vec3::new(0.0, 66.0, -8.0);
            for x in -8..9 {
                for z in -16..8 {
                    scene.cube(Vec3::new(x as f32, 70.0, z as f32), 1, [1.0; 4], 0.0, false);
                }
            }
        }
        scene
    }
    fn cube(&mut self, p: Vec3, tile: u32, color: [f32; 4], sky: f32, water: bool) {
        let faces = [
            (
                [1., 0., 0.],
                [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]],
            ),
            (
                [-1., 0., 0.],
                [[0., 0., 1.], [0., 1., 1.], [0., 1., 0.], [0., 0., 0.]],
            ),
            (
                [0., 1., 0.],
                [[0., 1., 1.], [1., 1., 1.], [1., 1., 0.], [0., 1., 0.]],
            ),
            (
                [0., -1., 0.],
                [[0., 0., 0.], [1., 0., 0.], [1., 0., 1.], [0., 0., 1.]],
            ),
            (
                [0., 0., 1.],
                [[1., 0., 1.], [1., 1., 1.], [0., 1., 1.], [0., 0., 1.]],
            ),
            (
                [0., 0., -1.],
                [[0., 0., 0.], [0., 1., 0.], [1., 1., 0.], [1., 0., 0.]],
            ),
        ];
        for (normal, corners) in faces {
            let tangent = (Vec3::from(corners[3]) - Vec3::from(corners[0])).normalize();
            for index in [0, 1, 2, 0, 2, 3] {
                let uv = [[0., 1.], [0., 0.], [1., 0.], [1., 1.]][index];
                let v = Vertex {
                    position: (p + Vec3::from(corners[index])).to_array(),
                    normal,
                    uv: [(tile as f32 + uv[0]) * 0.25, uv[1]],
                    light: [0.0, sky],
                    color,
                    tangent: [tangent.x, tangent.y, tangent.z, 1.0],
                    material: [tile as f32, 0.0, 0.0],
                    mid_uv: [(tile as f32 + 0.5) * 0.25, 0.5],
                };
                if water {
                    self.water.push(v)
                } else {
                    self.solid.push(v)
                }
            }
        }
    }
    pub fn mapped_vertices(&self, pack: &crate::pack::Pack, water: bool) -> Vec<Vertex> {
        let ids = self
            .materials
            .iter()
            .map(|name| pack.block_material_id(name) as f32)
            .collect::<Vec<_>>();
        (if water { &self.water } else { &self.solid })
            .iter()
            .map(|v| {
                let mut v = *v;
                v.material[0] = ids.get(v.material[0] as usize).copied().unwrap_or(0.0);
                v
            })
            .collect()
    }
    pub fn view(&self) -> Mat4 {
        glam::camera::rh::view::look_at_mat4(self.camera, self.target, Vec3::Y)
    }
}
