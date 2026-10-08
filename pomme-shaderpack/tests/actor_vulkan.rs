#![cfg(feature = "vulkan")]
//! A real Vulkan fixture tests actor ABI/fallback/depth contracts independently
//! of any particular pack. Actual Photon/live-world validation is separate.
use std::path::PathBuf;
use std::sync::Arc;

use glam::{DVec3, Mat4, Vec3};
use pomme_shaderpack::geometry::*;
use pomme_shaderpack::pack::Pack;
use pomme_shaderpack::runtime::FrameInput;
use pomme_shaderpack::scene::{Scene, Vertex};
use pomme_shaderpack::vulkan::engine::Engine;
use pomme_shaderpack::vulkan::headless::Headless;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pomme-actor-vk-{}", std::process::id()));
        std::fs::create_dir_all(path.join("shaders")).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.0.join("shaders").join(name), text.replace(";", ";\n")).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn quad(key: &str) -> Arc<MeshAsset> {
    let vertices = [
        [-0.8, -0.8, 0.],
        [0.8, -0.8, 0.],
        [0.8, 0.8, 0.],
        [-0.8, -0.8, 0.],
        [0.8, 0.8, 0.],
        [-0.8, 0.8, 0.],
    ]
    .map(|position| Vertex {
        position,
        normal: [0., 0., 1.],
        uv: [(position[0] + 0.8) / 1.6, (position[1] + 0.8) / 1.6],
        light: [0.; 2],
        color: [1.; 4],
        tangent: [1., 0., 0., 1.],
        material: [0.; 3],
        mid_uv: [0.5; 2],
    });
    Arc::new(MeshAsset {
        key: key.into(),
        vertices: Arc::from(vertices),
    })
}
fn read_depth(engine: &Engine, index: usize) -> Vec<f32> {
    use pomme_shaderpack::vulkan::resource::Buffer;
    use pyronyx::vk;
    let image = engine.depth_snapshot(index).unwrap();
    let buffer = Buffer::new(
        &engine.gpu,
        &vec![0; image.extent.width as usize * image.extent.height as usize * 4],
        vk::BufferUsageFlags::TransferDst,
    )
    .unwrap();
    engine
        .gpu
        .submit(|cmd| {
            image.transition(cmd, vk::ImageLayout::TransferSrcOptimal);
            cmd.copy_image_to_buffer(
                image.handle,
                vk::ImageLayout::TransferSrcOptimal,
                buffer.handle,
                &[vk::BufferImageCopy {
                    image_subresource: image.layers(),
                    image_extent: image.extent,
                    ..Default::default()
                }],
            );
            image.transition(cmd, vk::ImageLayout::ShaderReadOnlyOptimal);
            Ok(())
        })
        .unwrap();
    buffer
        .bytes()
        .unwrap()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}
fn draw(
    mesh: Arc<MeshAsset>,
    texture: Arc<TextureAsset>,
    identity: MaterialIdentity,
    model: Mat4,
    space: DrawSpace,
    light: [u8; 2],
) -> Draw {
    Draw {
        mesh,
        material: Arc::new(Material {
            identity,
            texture,
            alpha: AlphaMode::Cutout(0.1),
        }),
        range: 0..6,
        model,
        space,
        light,
        tint: [1.; 4],
        overlay: [0.; 4],
    }
}
#[test]
#[ignore = "requires real Vulkan driver; run with explicit validation on Mesa or target GPU"]
fn actor_stages_use_real_texture_light_material_poses_and_fallbacks_with_bounded_uploads() {
    let fixture = Fixture::new();
    // Omit entities and hand deliberately: they must resolve to textured_lit,
    // while block entities use their independent block -> terrain fallback.
    let vs = "#version 330 compatibility\nvarying vec2 uv; varying vec2 light; varying vec3 normal; attribute vec3 mc_Entity; varying float material; void main(){uv=gl_MultiTexCoord0.xy;light=gl_MultiTexCoord1.xy;normal=gl_NormalMatrix*gl_Normal;material=mc_Entity.x;gl_Position=ftransform();}\n";
    let fs = "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nvarying vec2 uv;varying vec2 light;varying vec3 normal;varying float material;uniform sampler2D gtexture;void main(){vec4 tex=texture2D(gtexture,uv);gl_FragColor=vec4(tex.r*light.y/240.0,tex.g*normal.z,tex.b*material/100.0,tex.a);}\n";
    for stage in ["gbuffers_terrain", "gbuffers_textured_lit", "shadow"] {
        fixture.write(&format!("{stage}.vsh"), vs);
        fixture.write(&format!("{stage}.fsh"), fs);
    }
    fixture.write("final.vsh","#version 330 compatibility\nvarying vec2 uv;void main(){uv=gl_MultiTexCoord0.xy;gl_Position=vec4(gl_Vertex.xy*2.0-1.0,0,1);}\n");
    fixture.write("final.fsh","#version 330 compatibility\nvarying vec2 uv;uniform sampler2D colortex0;void main(){gl_FragColor=texture2D(colortex0,uv);}\n");
    fixture.write(
        "shaders.properties",
        "shadowEntities=true\nshadowBlockEntities=true\n",
    );
    fixture.write("entity.properties", "entity.50=minecraft:cow\n");
    fixture.write(
        "block.properties",
        "block.75=minecraft:chest:facing=south\n",
    );
    fixture.write("item.properties", "item.25=minecraft:stone\n");
    let pack = Pack::load(&fixture.0, "world0", None, &[]).unwrap();
    assert_eq!(pack.entity_material_id("minecraft:cow"), 50);
    assert_eq!(pack.entity_material_id("minecraft:unmapped"), -1);
    assert_eq!(pack.item_material_id("minecraft:unmapped"), -1);
    assert_eq!(
        pack.block_material_id("minecraft:chest[facing=south,type=single]"),
        75
    );
    assert_eq!(pack.item_material_id("minecraft:stone"), 25);
    let context = Headless::new().unwrap();
    let scene = Scene {
        solid: vec![],
        water: vec![],
        camera: Vec3::new(0., 0., 4.),
        target: Vec3::ZERO,
        materials: vec![],
    };
    let mut engine = Engine::new((*context.gpu).clone(), pack, 64, 64, &scene, None, 1).unwrap();
    let mesh = quad("test-quad");
    let texture = Arc::new(TextureAsset {
        key: "rgba-split".into(),
        size: [2, 1],
        pixels: Arc::new(vec![255, 255, 255, 255, 255, 255, 255, 0]),
    });
    let mut geometry = FrameGeometry::default();
    geometry.draws.push(draw(
        Arc::clone(&mesh),
        Arc::clone(&texture),
        MaterialIdentity::Entity("minecraft:cow".into()),
        Mat4::IDENTITY,
        DrawSpace::World {
            anchor: DVec3::ZERO,
        },
        [3, 12],
    ));
    // Real models submit multiple parts with the same texture/descriptor.
    // A second off-center part catches forbidden descriptor rewrites after bind.
    geometry.draws.push(draw(
        Arc::clone(&mesh),
        Arc::clone(&texture),
        MaterialIdentity::Entity("minecraft:cow".into()),
        Mat4::from_translation(Vec3::new(1.2, 0., 0.)),
        DrawSpace::World {
            anchor: DVec3::ZERO,
        },
        [3, 12],
    ));
    let geometry = Arc::new(geometry);
    engine.prepare_geometry(0, Arc::clone(&geometry)).unwrap();
    assert!(engine.geometry_preparation.mesh_upload_bytes > 0);
    assert_eq!(engine.geometry_preparation.texture_upload_bytes, 8);
    let input = FrameInput::fixture(&scene, 0, 6000, 0.);
    engine
        .gpu
        .clone()
        .submit(|cmd| engine.record(cmd, 0, &input))
        .unwrap();
    engine.screenshot(&fixture.0.join("entity.png")).unwrap();
    let image = image::open(fixture.0.join("entity.png"))
        .unwrap()
        .to_rgba8();
    let pixels = image
        .pixels()
        .filter(|p| p[3] > 0 && p[0] > 0)
        .collect::<Vec<_>>();
    assert!(
        !pixels.is_empty(),
        "actor did not rasterize through fallback stage"
    );
    assert!(
        pixels
            .iter()
            .any(|p| p[0] > 180 && p[0] < 225 && p[1] > 240 && p[2] > 115 && p[2] < 140),
        "light, normal or material not supplied"
    );
    assert!(
        image.pixels().any(|p| p[0] == 0),
        "texture cutout did not preserve transparent coverage"
    );
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "gbuffers_entities"
                && s.resolved == "gbuffers_textured_lit"
                && s.draws == 2
                && s.material_ids == [50])
    );
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "shadow_entities" && s.resolved == "shadow" && s.draws == 2)
    );
    for frame in 1..20 {
        engine.prepare_geometry(0, Arc::clone(&geometry)).unwrap();
        assert_eq!(engine.geometry_preparation.mesh_upload_bytes, 0);
        assert_eq!(engine.geometry_preparation.texture_upload_bytes, 0);
        let mut input = input.clone();
        input.frame = frame;
        engine
            .gpu
            .clone()
            .submit(|cmd| engine.record(cmd, 0, &input))
            .unwrap();
    }
    engine
        .pack
        .properties
        .insert("shadowEntities".into(), "false".into());
    engine
        .gpu
        .clone()
        .submit(|cmd| engine.record(cmd, 0, &input))
        .unwrap();
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "shadow_entities" && s.draws == 0)
    );
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "gbuffers_entities" && s.draws == 2)
    );
    let mut mixed = FrameGeometry {
        hand_projection: Some(glam::camera::rh::proj::opengl::perspective(
            70_f32.to_radians(),
            1.,
            0.05,
            10.,
        )),
        ..Default::default()
    };
    mixed.draws.push(draw(
        Arc::clone(&mesh),
        Arc::clone(&texture),
        MaterialIdentity::Block("minecraft:chest[facing=south,type=single]".into()),
        Mat4::from_translation(Vec3::new(0.2, 0., 0.)),
        DrawSpace::World {
            anchor: DVec3::ZERO,
        },
        [0, 15],
    ));
    mixed.draws.push(draw(
        mesh,
        texture,
        MaterialIdentity::Item("minecraft:stone".into()),
        Mat4::from_translation(Vec3::new(-0.5, -0.5, -1.)),
        DrawSpace::Hand,
        [0, 8],
    ));
    engine.prepare_geometry(0, Arc::new(mixed)).unwrap();
    engine
        .gpu
        .clone()
        .submit(|cmd| engine.record(cmd, 0, &input))
        .unwrap();
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "gbuffers_block"
                && s.resolved == "gbuffers_terrain"
                && s.material_ids == [75])
    );
    assert!(
        engine
            .geometry_stages
            .iter()
            .any(|s| s.requested == "gbuffers_hand"
                && s.resolved == "gbuffers_textured_lit"
                && s.material_ids == [25])
    );
    let before_hand = read_depth(&engine, 2);
    let after_hand = read_depth(&engine, 1);
    assert!(
        before_hand
            .iter()
            .zip(&after_hand)
            .any(|(before, after)| *after < *before - 0.1 && *after > 0.5),
        "hand projection/depth did not stay distinct from opaque world depth"
    );
    assert_eq!(read_depth(&engine, 0), after_hand);
    assert_eq!(
        engine
            .geometry_stages
            .iter()
            .filter(|s| s.requested.starts_with("shadow"))
            .map(|s| s.draws)
            .sum::<usize>(),
        1,
        "first-person hand must not cast world shadows"
    );
}
