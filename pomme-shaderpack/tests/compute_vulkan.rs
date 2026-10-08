#![cfg(feature = "vulkan")]
//! Original fixture: exercise actual Vulkan dispatch, aliased image/sampler
//! visibility, standalone and associated stages, history reset and replacement.
use std::path::PathBuf;

use glam::Vec3;
use pomme_shaderpack::pack::Pack;
use pomme_shaderpack::runtime::FrameInput;
use pomme_shaderpack::scene::Scene;
use pomme_shaderpack::vulkan::engine::Engine;
use pomme_shaderpack::vulkan::headless::Headless;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pomme-compute-vk-{}", std::process::id()));
        std::fs::create_dir_all(root.join("shaders")).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.0.join("shaders").join(name), text.replace(';', ";\n")).unwrap();
    }
    fn load(&self) -> Pack {
        Pack::load(&self.0, "world0", None, &[]).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
const SCREEN: &str = "#version 330 compatibility\nvarying vec2 uv;void main(){uv=gl_MultiTexCoord0.xy;gl_Position=vec4(gl_Vertex.xy*2.0-1.0,0,1);}\n";
fn screenshot(engine: &Engine, file: &std::path::Path) -> [u8; 4] {
    engine.screenshot(file).unwrap();
    image::open(file).unwrap().to_rgba8().get_pixel(4, 4).0
}
fn close(pixel: [u8; 4], expected: [u8; 4]) {
    for (got, wanted) in pixel.into_iter().zip(expected) {
        assert!(
            got.abs_diff(wanted) <= 2,
            "pixel {pixel:?}, expected {expected:?}"
        );
    }
}

#[test]
#[ignore = "requires a real Vulkan driver; run with positively verified validation layer activation"]
fn dispatch_preserves_current_front_and_raster_visibility_across_resets_and_replacement() {
    let fixture = Fixture::new();
    fixture.write("gbuffers_terrain.vsh", SCREEN);
    fixture.write("gbuffers_terrain.fsh", "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nvoid main(){gl_FragColor=vec4(0.1,0,0,1);}\n");
    fixture.write("setup.csh", "#version 430\nlayout(local_size_x=1,local_size_y=1) in;const ivec3 workGroups=ivec3(8,8,1);layout(rgba16f) uniform image2D colorimg1;void main(){ivec2 p=ivec2(gl_GlobalInvocationID.xy);imageStore(colorimg1,p,imageLoad(colorimg1,p)+vec4(0.1));}\n");
    let compute = "#version 430\nlayout(local_size_x=1,local_size_y=1) in;const ivec3 workGroups=ivec3(8,8,1);layout(rgba16f) writeonly uniform image2D colorimg0;uniform sampler2D colortex0;uniform int worldTime;uniform float rainStrength;void main(){ivec2 p=ivec2(gl_GlobalInvocationID.xy);imageStore(colorimg0,p,vec4(texelFetch(colortex0,p,0).r+0.1,float(worldTime)/24000.0,rainStrength,1));}\n";
    // deferred1 has no fragment pair. deferred2_a must precede deferred2.fsh.
    fixture.write("deferred1.csh", compute);
    fixture.write("deferred2_a.csh", compute);
    fixture.write("deferred2_b.csh", "#version 430\nlayout(local_size_x=1) in;const ivec3 workGroups=ivec3(8,8,1);layout(rgba16f) coherent readonly uniform image2D colorimg0;layout(rgba16f) restrict writeonly uniform image2D colorimg2;void main(){ivec2 p=ivec2(gl_GlobalInvocationID.xy);imageStore(colorimg2,p,imageLoad(colorimg0,p));}\n");
    fixture.write("deferred2.vsh", SCREEN);
    fixture.write("deferred2.fsh", "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nvarying vec2 uv;uniform sampler2D colortex2;uniform sampler2D colortex1;const bool colortex1Clear=false;void main(){vec4 v=texture2D(colortex2,uv);gl_FragColor=vec4(v.r*2,v.g,texture2D(colortex1,uv).r+v.b,1);}\n");
    fixture.write("final.vsh", SCREEN);
    fixture.write("final.fsh", "#version 330 compatibility\nvarying vec2 uv;uniform sampler2D colortex0;void main(){gl_FragColor=texture2D(colortex0,uv);}\n");
    let scene = Scene {
        solid: Vec::new(),
        water: Vec::new(),
        materials: Vec::new(),
        camera: Vec3::ZERO,
        target: Vec3::NEG_Z,
    };
    let context = Headless::new().unwrap();
    eprintln!(
        "COMPUTE_FIXTURE {}",
        serde_json::json!({
            "revision":pomme_shaderpack::BUILD_REVISION,"device":context.name,
            "target_gpu_tested":false,"scenario":"actual fixed dispatch, current-front alias, setup/history/replacement"
        })
    );
    let mut engine = Engine::new(
        (*context.gpu).clone(),
        fixture.load(),
        8,
        8,
        &scene,
        None,
        1,
    )
    .unwrap();
    let names = engine.pass_names();
    let manifest = engine.compute_manifest();
    let producer = manifest
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["program"] == "deferred1")
        .unwrap();
    let consumer = manifest
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["program"] == "deferred2_b")
        .unwrap();
    assert_eq!(producer["images"][0]["access"], "WriteOnly");
    let read = consumer["images"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "colorimg0")
        .unwrap();
    assert_eq!(read["access"], "ReadOnly");
    assert_eq!(read["qualifiers"], serde_json::json!(["coherent"]));
    assert!(
        names.iter().position(|n| n == "deferred1").unwrap()
            < names.iter().position(|n| n == "deferred2_a").unwrap()
    );
    assert!(
        names.iter().position(|n| n == "deferred2_a").unwrap()
            < names.iter().position(|n| n == "deferred2").unwrap()
    );
    let mut input = FrameInput::fixture(&scene, 0, 6000, 0.);
    let file = fixture.0.join("capture.png");
    for frame in 0..3 {
        input.frame = frame;
        engine
            .gpu
            .clone()
            .submit(|cmd| engine.record(cmd, 0, &input))
            .unwrap();
        // No terrain draw: seed is zero; two computes add0.1, fragment doubles.
        close(screenshot(&engine, &file), [102, 64, 26, 255]);
        // Includes skipped setup timestamps; WAIT must not hang on frame2.
        assert_eq!(engine.timings(0).unwrap().len(), names.len());
        let setup_bytes = engine.color_snapshot(1).unwrap().readback().unwrap();
        assert_eq!(setup_bytes.len(), 8 * 8 * 8);
        assert!(
            setup_bytes
                .as_chunks::<8>()
                .0
                .iter()
                .all(|pixel| u16::from_le_bytes([pixel[0], pixel[1]]) == 0x2e66)
        ); // half-float0.1
        assert_eq!(
            engine.compute_dispatches.len(),
            if frame == 0 { 4 } else { 3 }
        );
    }
    input.world_time = 12000;
    input.rain = 0.25;
    input.world_revision += 1;
    engine
        .gpu
        .clone()
        .submit(|cmd| engine.record(cmd, 0, &input))
        .unwrap();
    close(screenshot(&engine, &file), [102, 128, 89, 255]);
    assert_eq!(engine.invalidations, 2);
    assert_eq!(engine.compute_dispatches.len(), 4);
    // Replacement allocates new storage, runs setup and uses new shader bytes.
    drop(engine);
    fixture.write("deferred1.csh", &compute.replace("+0.1", "+0.2"));
    let mut engine = Engine::new(
        (*context.gpu).clone(),
        fixture.load(),
        8,
        8,
        &scene,
        None,
        1,
    )
    .unwrap();
    engine
        .gpu
        .clone()
        .submit(|cmd| engine.record(cmd, 0, &input))
        .unwrap();
    close(screenshot(&engine, &file), [153, 128, 89, 255]);
    drop(engine);
    // These sources compile, but their resource views are incompatible. Reject
    // them before creating an invalid storage descriptor or dispatching it.
    fixture.write("deferred1.csh", &compute.replace("colorimg0", "colorimg00"));
    let error = Engine::new(
        (*context.gpu).clone(),
        fixture.load(),
        8,
        8,
        &scene,
        None,
        1,
    )
    .err()
    .unwrap();
    assert!(
        error.to_string().contains("noncanonical storage image"),
        "{error:#}"
    );
    fixture.write("deferred1.csh", "#version 430\nlayout(local_size_x=1) in;const ivec3 workGroups=ivec3(8,8,1);uniform samplerCube colortex7;layout(rgba16f) writeonly uniform image2D colorimg0;void main(){imageStore(colorimg0,ivec2(gl_GlobalInvocationID.xy),texture(colortex7,vec3(0,0,1)));}\n");
    let error = Engine::new(
        (*context.gpu).clone(),
        fixture.load(),
        8,
        8,
        &scene,
        None,
        1,
    )
    .err()
    .unwrap();
    assert!(
        error
            .to_string()
            .contains("unsupported sampler resource colortex7:samplerCube"),
        "{error:#}"
    );
}
