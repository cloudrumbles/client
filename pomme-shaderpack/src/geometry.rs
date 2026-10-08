//! Immutable actor assets and per-frame poses consumed by pack geometry stages.
//! Meshes/textures are shared across frames; only draws and pose matrices
//! change.
use std::ops::Range;
use std::sync::Arc;

use glam::{DVec3, Mat4};

use crate::scene::Vertex;

pub struct MeshAsset {
    /// Stable within the asset generation; never reuse for different vertices.
    pub key: String,
    pub vertices: Arc<[Vertex]>,
}
pub struct TextureAsset {
    /// Stable within the asset generation; never reuse for different pixels.
    pub key: String,
    pub size: [u32; 2],
    pub pixels: Arc<Vec<u8>>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaterialIdentity {
    Entity(String),
    /// Full block-state descriptor, including properties used by
    /// block.properties.
    Block(String),
    Item(String),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AlphaMode {
    Cutout(f32),
    Opaque,
    Blend,
}
pub struct Material {
    pub identity: MaterialIdentity,
    pub texture: Arc<TextureAsset>,
    pub alpha: AlphaMode,
}
#[derive(Clone, Copy)]
pub enum DrawSpace {
    /// Model matrix is relative to this double-precision world anchor.
    World { anchor: DVec3 },
    /// Model matrix is already in first-person view space, including view bob.
    Hand,
}
pub struct Draw {
    pub mesh: Arc<MeshAsset>,
    pub material: Arc<Material>,
    pub range: Range<u32>,
    pub model: Mat4,
    pub space: DrawSpace,
    /// Actual block and sky light nibbles, in that order (0..=15).
    pub light: [u8; 2],
    pub tint: [f32; 4],
    /// Iris entityColor: RGB overlay and its direct blend coefficient.
    pub overlay: [f32; 4],
}
#[derive(Default)]
pub struct FrameGeometry {
    pub draws: Vec<Draw>,
    /// OpenGL clip-space first-person projection, before MC_HAND_DEPTH scaling.
    /// Separate from world projection; view bob is in each hand model matrix.
    pub hand_projection: Option<Mat4>,
}
