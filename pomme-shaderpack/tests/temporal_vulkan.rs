#![cfg(feature = "vulkan")]
//! Original pack fixture: retained setup/storage data, actual geometry refresh,
//! current environment uniforms and pack-owned smooth state across edits.
use std::path::PathBuf;

use glam::Vec3;
use pomme_shaderpack::pack::Pack;
use pomme_shaderpack::runtime::FrameInput;
use pomme_shaderpack::scene::{Scene, Vertex};
use pomme_shaderpack::vulkan::engine::Engine;
use pomme_shaderpack::vulkan::headless::Headless;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pomme-temporal-vk-{}", std::process::id()));
        std::fs::create_dir_all(path.join("shaders")).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, source: &str) {
        std::fs::write(
            self.0.join("shaders").join(name),
            source.replace(';', ";\n"),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
const SCREEN: &str = "#version 330 compatibility\nvarying vec2 uv;void main(){uv=gl_MultiTexCoord0.xy;gl_Position=vec4(gl_Vertex.xy*2.0-1.0,0,1);}\n";

fn scene(color: f32) -> Scene {
    Scene {
        solid: [[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]]
            .map(|position| Vertex {
                position,
                normal: [0., 0., 1.],
                uv: [0.; 2],
                light: [color * 240., 240.],
                color: [color, 0., 0., 1.],
                tangent: [1., 0., 0., 1.],
                material: [0.; 3],
                mid_uv: [0.; 2],
            })
            .to_vec(),
        water: Vec::new(),
        materials: Vec::new(),
        camera: Vec3::ZERO,
        target: Vec3::NEG_Z,
    }
}

#[test]
#[ignore = "requires a real Vulkan driver; run with positively verified validation layer activation"]
fn content_updates_preserve_retained_data_and_smoothing_until_explicit_epoch_reset() {
    let f = Fixture::new();
    f.write("gbuffers_terrain.vsh", "#version 330 compatibility\nvarying vec2 content;void main(){content=vec2(gl_Color.r,gl_MultiTexCoord1.x/240.0);gl_Position=vec4(gl_Vertex.xy*2.0-1.0,0,1);}\n");
    f.write("gbuffers_terrain.fsh", "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nvarying vec2 content;void main(){gl_FragColor=vec4(0.5*(content.x+content.y),0,0,1);}\n");
    f.write("setup.csh", "#version 430\nlayout(local_size_x=1) in;const ivec3 workGroups=ivec3(8,8,1);layout(rgba16f) writeonly uniform image2D colorimg1;void main(){imageStore(colorimg1,ivec2(gl_GlobalInvocationID.xy),vec4(0.125));}\n");
    f.write("deferred1.csh", "#version 430\nlayout(local_size_x=1) in;const ivec3 workGroups=ivec3(8,8,1);layout(rgba16f) uniform image2D colorimg1;void main(){ivec2 p=ivec2(gl_GlobalInvocationID.xy);imageStore(colorimg1,p,imageLoad(colorimg1,p)+vec4(0.03125));}\n");
    f.write(
        "shaders.properties",
        "uniform.float.clock_delta = abs(worldTime - smooth(worldTime, 1.0, 1.0))\n",
    );
    f.write("final.vsh", SCREEN);
    f.write("final.fsh", "#version 330 compatibility\nvarying vec2 uv;uniform sampler2D colortex0;uniform sampler2D colortex1;uniform int worldTime;uniform float rainStrength;uniform float clock_delta;const bool colortex1Clear=false;void main(){gl_FragColor=vec4(texture2D(colortex1,uv).r,texture2D(colortex0,uv).r+float(worldTime)/24000.0,rainStrength+clock_delta/24000.0,1);}\n");
    let context = Headless::new().unwrap();
    let pack = Pack::load(&f.0, "world0", None, &[]).unwrap();
    let mut engine = Engine::new((*context.gpu).clone(), pack, 8, 8, &scene(0.), None, 1).unwrap();
    let mut input = FrameInput::fixture(&scene(0.), 0, 6000, 0.);
    let mut samples = Vec::new();
    let evidence = std::env::var_os("POMME_TEMPORAL_EVIDENCE").map(PathBuf::from);
    if let Some(path) = &evidence {
        std::fs::create_dir_all(path).unwrap();
    }
    for frame in 0..8 {
        input.frame = frame;
        input.seconds = frame as f32 / 60.;
        match frame {
            1 => {
                engine.replace_scene(&scene(0.125)).unwrap();
                input.world_revision += 1;
            }
            2 => {
                engine.replace_scene(&scene(0.25)).unwrap();
                input.lighting_revision += 1;
            }
            3 => input.world_time = 12000,
            4 => {
                input.rain = 0.25;
                input.wetness = 0.125;
                input.eye_brightness = [16., 128.];
                input.temperature = 0.25;
                input.rainfall = 0.75;
            }
            5 => {
                input.world_time = 0;
                input.world_day = 1;
            }
            6 => input.history_epoch += 1,
            _ => {}
        }
        engine
            .gpu
            .clone()
            .submit(|cmd| engine.record(cmd, 0, &input))
            .unwrap();
        let path = f.0.join(format!("frame-{frame}.png"));
        engine.screenshot(&path).unwrap();
        let pixel = image::open(&path).unwrap().to_rgba8().get_pixel(4, 4).0;
        let expected_counter = if frame < 6 {
            0.125 + (frame + 1) as f32 / 32.
        } else {
            0.125 + (frame - 5) as f32 / 32.
        };
        let expected_green = (if frame == 0 {
            0.
        } else if frame == 1 {
            0.125
        } else {
            0.25
        }) + input.world_time as f32 / 24000.;
        assert!(
            pixel[0].abs_diff((expected_counter * 255.).round() as u8) <= 2,
            "frame{frame}: {pixel:?}"
        );
        assert!(
            pixel[1].abs_diff((expected_green * 255.).round() as u8) <= 2,
            "current geometry/time did not update at frame{frame}: {pixel:?}"
        );
        if frame == 3 {
            assert!(
                pixel[2] > 50,
                "pack smooth state lost the time command: {pixel:?}"
            );
        }
        if frame == 6 {
            assert!(
                pixel[2].abs_diff(64) <= 2,
                "explicit epoch did not reset smooth state: {pixel:?}"
            );
        }
        assert_eq!(engine.invalidations, if frame < 6 { 1 } else { 2 });
        assert_eq!(
            engine.compute_dispatches.len(),
            if frame == 0 || frame == 6 { 2 } else { 1 }
        );
        if let Some(dir) = &evidence {
            std::fs::copy(&path, dir.join(format!("frame-{frame}.png"))).unwrap();
        }
        samples.push(serde_json::json!({"frame":frame,"pixel":pixel,"expected_history_value":expected_counter,"history_epoch":input.history_epoch,"world_revision":input.world_revision,"lighting_revision":input.lighting_revision,"world_time":input.world_time,"world_day":input.world_day,"rain":input.rain,"invalidations":engine.invalidations,"compute_dispatches":engine.compute_dispatches}));
    }
    let result = serde_json::json!({"revision":pomme_shaderpack::BUILD_REVISION,"device":context.name,"target_gpu_tested":false,"scenario":"content, lighting, time commands, day, weather preserve original retained storage and smooth; explicit epoch resets","samples":samples});
    if let Some(dir) = &evidence {
        std::fs::write(
            dir.join("temporal.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
    }
    eprintln!("TEMPORAL_FIXTURE {result}");
}
