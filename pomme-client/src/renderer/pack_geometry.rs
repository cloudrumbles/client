//! CPU asset lowering shared by the native actor pipelines.
//!
//! Geometry and RGBA bytes are retained when native assets are loaded. Lighting
//! is supplied on each draw by the world snapshot; the zero vertex light below
//! is an unused attribute: actor shaders select measured `Draw::light` instead.
use std::sync::Arc;

use glam::{Mat4, Vec2, Vec3};
use pomme_shaderpack::geometry::{
    Draw, DrawSpace, FrameGeometry, Material, MeshAsset, TextureAsset,
};
use pomme_shaderpack::scene::Vertex;
use sha2::{Digest, Sha256};

use super::chunk::mesher::ChunkVertex;

#[derive(Debug, thiserror::Error)]
pub enum PackGeometryGap {
    #[error("actor kind is outside the supported pack geometry slice")]
    UnsupportedKind,
    #[error("native actor mesh is not loaded")]
    MissingMesh,
    #[error("actor texture or atlas sprite did not load from a real asset")]
    MissingTexture,
    #[error("native actor variant is outside the loaded asset pool")]
    InvalidVariant,
}

pub(crate) struct SourceVertex {
    pub position: [f32; 3],
    pub uv: [f32; 2],
    pub tint: [f32; 4],
    /// Native item baked normals. Entity cube normals are recovered from their
    /// unchanged quad winding, correcting the bake's Y reflection.
    pub normal: Option<[f32; 3]>,
}

pub(crate) struct PartPose {
    pub base: Mat4,
    pub space: DrawSpace,
    pub light: [u8; 2],
    pub tint: [f32; 4],
    pub overlay: [f32; 4],
}

/// Per-frame poses only clone immutable asset handles, never their vertices or
/// pixels. Part ranges keep the native model's vertex-buffer offsets.
pub(crate) fn append_parts(
    frame: &mut FrameGeometry,
    mesh: &Arc<MeshAsset>,
    material: &Arc<Material>,
    ranges: &[(u32, u32)],
    transforms: &[Mat4],
    pose: PartPose,
) -> usize {
    assert_eq!(ranges.len(), transforms.len());
    let before = frame.draws.len();
    for ((start, count), transform) in ranges.iter().zip(transforms) {
        if *count != 0 {
            frame.draws.push(Draw {
                mesh: Arc::clone(mesh),
                material: Arc::clone(material),
                range: *start..*start + *count,
                model: pose.base * *transform,
                space: pose.space,
                light: pose.light,
                tint: pose.tint,
                overlay: pose.overlay,
            });
        }
    }
    frame.draws.len() - before
}

pub(crate) fn packed_tint(value: u32) -> [f32; 4] {
    [
        ((value >> 8) & 255) as f32 / 255.0,
        ((value >> 16) & 255) as f32 / 255.0,
        ((value >> 24) & 255) as f32 / 255.0,
        1.0,
    ]
}

pub(crate) fn chunk_mesh(
    label: &str,
    vertices: &[ChunkVertex],
    y_reflected: bool,
) -> Arc<MeshAsset> {
    let source: Vec<_> = vertices
        .iter()
        .map(|v| SourceVertex {
            position: v.position,
            uv: v.tex_coords.map(|u| u as f32 / 65535.0),
            tint: packed_tint(v.light_tint),
            normal: None,
        })
        .collect();
    quad_mesh(label, &source, if y_reflected { -1.0 } else { 1.0 })
}

/// Lower the native six-vertex quad stream once, preserving every position,
/// UV, tint and explicit normal. Tangents are derived from the real UV axes.
pub(crate) fn quad_mesh(label: &str, source: &[SourceVertex], normal_sign: f32) -> Arc<MeshAsset> {
    assert!(source.len().is_multiple_of(6), "native quad stream");
    let mut vertices = Vec::with_capacity(source.len());
    for quad in source.as_chunks::<6>().0 {
        let p0 = Vec3::from(quad[0].position);
        let e1 = Vec3::from(quad[1].position) - p0;
        let e2 = Vec3::from(quad[2].position) - p0;
        let geometric_normal = (e1.cross(e2) * normal_sign).normalize_or_zero();
        let d1 = Vec2::from(quad[1].uv) - Vec2::from(quad[0].uv);
        let d2 = Vec2::from(quad[2].uv) - Vec2::from(quad[0].uv);
        let determinant = d1.x * d2.y - d1.y * d2.x;
        let (tangent, bitangent) = if determinant.abs() > 1e-12 {
            (
                (e1 * d2.y - e2 * d1.y) / determinant,
                (e2 * d1.x - e1 * d2.x) / determinant,
            )
        } else {
            // Zero-area UVs/geometry are retained as authored, with no normal
            // map basis rather than an invented face direction.
            (Vec3::ZERO, Vec3::ZERO)
        };
        let (mut uv_min, mut uv_max) = (Vec2::splat(f32::INFINITY), Vec2::splat(f32::NEG_INFINITY));
        for vertex in quad {
            uv_min = uv_min.min(Vec2::from(vertex.uv));
            uv_max = uv_max.max(Vec2::from(vertex.uv));
        }
        let mid_uv = ((uv_min + uv_max) * 0.5).to_array();
        for vertex in quad {
            let normal = vertex
                .normal
                .map_or(geometric_normal, Vec3::from)
                .normalize_or_zero();
            let tangent = (tangent - normal * normal.dot(tangent)).normalize_or_zero();
            let handedness = if normal.cross(tangent).dot(bitangent) < 0.0 {
                -1.0
            } else {
                1.0
            };
            vertices.push(Vertex {
                position: vertex.position,
                normal: normal.to_array(),
                uv: vertex.uv,
                light: [0.0; 2],
                color: vertex.tint,
                tangent: [tangent.x, tangent.y, tangent.z, handedness],
                material: [0.0; 3],
                mid_uv,
            });
        }
    }
    let mut hash = Sha256::new();
    for vertex in &vertices {
        for value in vertex
            .position
            .into_iter()
            .chain(vertex.normal)
            .chain(vertex.uv)
            .chain(vertex.color)
            .chain(vertex.tangent)
            .chain(vertex.mid_uv)
        {
            hash.update(value.to_le_bytes());
        }
    }
    Arc::new(MeshAsset {
        key: format!("native/{label}/{}", hex_digest(&hash.finalize())),
        vertices: vertices.into(),
    })
}

fn hex_digest(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn texture_asset(
    label: &str,
    size: [u32; 2],
    pixels: Arc<Vec<u8>>,
) -> Arc<TextureAsset> {
    assert_eq!(pixels.len(), size[0] as usize * size[1] as usize * 4);
    let mut hash = Sha256::new();
    hash.update(size[0].to_le_bytes());
    hash.update(size[1].to_le_bytes());
    hash.update(pixels.as_slice());
    Arc::new(TextureAsset {
        key: format!("native/{label}/{}", hex_digest(&hash.finalize())),
        size,
        pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_cow_vertices_uvs_and_outward_normals_survive_lowering() {
        for model in [
            super::super::entity_model::bake_cow_model(),
            super::super::entity_model::bake_baby_cow_model(),
        ] {
            let mesh = chunk_mesh("cow", &model.vertices, true);
            assert_eq!(mesh.vertices.len(), model.vertices.len());
            // Every Cow cube is emitted with all six faces. This independently
            // checks normals point away from the cube's bounds center, including
            // vanilla's mirrored left legs and the baby's mirrored horn.
            assert!(mesh.vertices.len().is_multiple_of(36));
            for cube in mesh.vertices.as_chunks::<36>().0 {
                let min = cube.iter().fold(Vec3::splat(f32::INFINITY), |a, v| {
                    a.min(Vec3::from(v.position))
                });
                let max = cube.iter().fold(Vec3::splat(f32::NEG_INFINITY), |a, v| {
                    a.max(Vec3::from(v.position))
                });
                let center = (min + max) * 0.5;
                for quad in cube.as_chunks::<6>().0 {
                    let face_center = quad
                        .iter()
                        .fold(Vec3::ZERO, |a, v| a + Vec3::from(v.position))
                        / 6.0;
                    assert!(Vec3::from(quad[0].normal).dot(face_center - center) > 0.0);
                }
            }
            for (source, result) in model.vertices.iter().zip(mesh.vertices.iter()) {
                assert_eq!(source.position, result.position);
                assert_eq!(source.tex_coords.map(|u| u as f32 / 65535.0), result.uv);
                assert!(result.tangent.iter().all(|v| v.is_finite()));
            }
        }
    }

    #[test]
    fn texture_keys_distinguish_equal_sized_real_asset_bytes() {
        let a = texture_asset("test", [1, 1], Arc::new(vec![1, 2, 3, 255]));
        let b = texture_asset("test", [1, 1], Arc::new(vec![3, 2, 1, 255]));
        assert_ne!(a.key, b.key);
        assert_eq!(a.pixels.as_slice(), &[1, 2, 3, 255]);
    }

    #[test]
    fn successive_cow_poses_share_mesh_material_and_pixels() {
        use pomme_shaderpack::geometry::{AlphaMode, MaterialIdentity};
        let model = super::super::entity_model::bake_cow_model();
        let mesh = chunk_mesh("cow", &model.vertices, true);
        let pixels = Arc::new(vec![1, 2, 3, 255]);
        let material = Arc::new(Material {
            identity: MaterialIdentity::Entity("minecraft:cow".into()),
            texture: texture_asset("unit-test", [1, 1], Arc::clone(&pixels)),
            alpha: AlphaMode::Cutout(0.5),
        });
        let mut frames = [FrameGeometry::default(), FrameGeometry::default()];
        for (frame, walk) in frames.iter_mut().zip([0.0, 2.0]) {
            let anim = super::super::entity_model::compute_quadruped_anim(
                &model, 30.0, 40.0, walk, 0.8, 0.0, None,
            );
            append_parts(
                frame,
                &mesh,
                &material,
                &model.part_ranges,
                &model.compute_part_transforms(&anim),
                PartPose {
                    base: Mat4::IDENTITY,
                    space: DrawSpace::World {
                        anchor: glam::DVec3::ZERO,
                    },
                    light: [3, 11],
                    tint: [1.0; 4],
                    overlay: [0.0, 0.0, 0.0, 1.0],
                },
            );
        }
        assert_eq!(frames[0].draws.len(), model.parts.len());
        assert!(
            frames[0]
                .draws
                .iter()
                .zip(&frames[1].draws)
                .any(|(a, b)| !a.model.abs_diff_eq(b.model, 1e-6))
        );
        for frame in &frames {
            for draw in &frame.draws {
                assert!(Arc::ptr_eq(&draw.mesh, &mesh));
                assert!(Arc::ptr_eq(&draw.mesh.vertices, &mesh.vertices));
                assert!(Arc::ptr_eq(&draw.material, &material));
                assert!(Arc::ptr_eq(&draw.material.texture.pixels, &pixels));
                assert_eq!(draw.light, [3, 11]);
                assert!((draw.range.end as usize) <= mesh.vertices.len());
            }
        }
    }
}
