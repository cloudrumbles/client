use std::path::PathBuf;

use anyhow::{Result, ensure};
use clap::Parser;
use pomme_shaderpack::context::HeadlessContext;
use pomme_shaderpack::pack::Pack;
use pomme_shaderpack::runtime::{FrameInput, Runtime};
use pomme_shaderpack::scene::Scene;
use serde::Serialize;

#[derive(Parser)]
#[command(about = "Native original shader-pack execution and deterministic rendering benchmark")]
struct Args {
    #[arg(long)]
    pack: PathBuf,
    #[arg(long = "alternate-pack")]
    alternate_packs: Vec<PathBuf>,
    #[arg(long, default_value = "world0")]
    dimension: String,
    #[arg(long, default_value = "1.21.11")]
    minecraft_version: String,
    #[arg(long)]
    profile: Option<String>,
    #[arg(long = "option")]
    options: Vec<String>,
    #[arg(long, default_value_t = 640)]
    width: u32,
    #[arg(long, default_value_t = 360)]
    height: u32,
    #[arg(long, default_value_t = 8)]
    frames: u32,
    #[arg(long, default_value_t = 2)]
    warmup: u32,
    #[arg(long,default_value="terrain",value_parser=["terrain","water","cave"])]
    scene: String,
    #[arg(long, default_value_t = 6000)]
    time: i32,
    #[arg(long, default_value_t = 0.0)]
    rain: f32,
    #[arg(long)]
    atlas: Option<PathBuf>,
    #[arg(long, default_value = "shaderpack-output")]
    output: PathBuf,
    /// Interactive native window. WASD/space/shift move; 1/2/3 set time;
    /// G changes rain; R reloads the selected pack; Escape closes.
    #[arg(long)]
    window: bool,
    /// Close a native window after this many presented frames and save
    /// evidence.
    #[arg(long)]
    window_frames: Option<u32>,
    /// Reproducible camera motion or content/environment changes followed by
    /// explicit resource and history-epoch resets.
    #[arg(long,default_value="static",value_parser=["static","orbit","state-changes"])]
    scenario: String,
    /// Write the resolved pack manifest without creating a GPU context.
    #[arg(long)]
    inspect: bool,
}
#[derive(Serialize)]
struct Sample {
    frame: u32,
    wall_ms: f64,
    passes: Vec<pomme_shaderpack::runtime::PassTiming>,
    input: serde_json::Value,
    history_invalidations: u32,
}
fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.frames > 0 && args.frames.checked_add(args.warmup).is_some(),
        "invalid frame count"
    );
    ensure!(
        args.window_frames.is_none_or(|n| n > 0),
        "window frames must be positive"
    );
    ensure!((0.0..=1.0).contains(&args.rain), "rain must be in [0,1]");
    let minecraft_version =
        pomme_shaderpack::pack::minecraft_version_code(&args.minecraft_version)?;
    if args.window {
        return pomme_shaderpack::viewer::run(pomme_shaderpack::viewer::ViewerOptions {
            pack: args.pack,
            alternate_packs: args.alternate_packs,
            profile: args.profile,
            overrides: args.options,
            dimension: args.dimension,
            minecraft_version,
            width: args.width,
            height: args.height,
            scene: args.scene,
            time: args.time,
            rain: args.rain,
            atlas: args.atlas,
            max_frames: args.window_frames,
            output: args.output,
        });
    }
    let pack = Pack::load_for_version(
        &args.pack,
        &args.dimension,
        args.profile.as_deref(),
        &args.options,
        minecraft_version,
    )?;
    std::fs::create_dir_all(&args.output)?;
    std::fs::write(
        args.output.join("pack.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"pack_sha256":pack.digest,"options":pack.options,"ignored_profile_options":pack.ignored_profile_options,"properties":pack.properties}),
        )?,
    )?;
    if args.inspect {
        return Ok(());
    }
    let mut scene = Scene::fixture(&args.scene);
    let context = HeadlessContext::new(args.width, args.height)?;
    let mut runtime = Runtime::new(
        context.gl.clone(),
        pack,
        args.width,
        args.height,
        &scene,
        args.atlas.as_deref(),
    )?;
    std::fs::create_dir_all(&args.output)?;
    let mut samples = Vec::new();
    for frame in 0..args.frames + args.warmup {
        let mut input = FrameInput::fixture(&scene, frame, args.time, args.rain);
        if args.scenario == "orbit" {
            let angle = frame as f32 * 0.01;
            let offset = glam::Quat::from_rotation_y(angle) * (scene.camera - scene.target);
            input.camera = scene.target + offset;
        }
        if args.scenario == "state-changes" && frame >= args.warmup {
            let phase = (frame - args.warmup) / 4;
            if phase >= 1 {
                input.world_time = 18000;
            }
            if phase >= 2 {
                input.rain = 1.0;
                input.wetness = 1.0;
            }
            if phase >= 3 {
                input.camera += glam::Vec3::X * 16.0;
                input.target += glam::Vec3::X * 16.0;
            }
            if phase >= 4 {
                input.world_revision = 1;
            }
            if phase >= 5 {
                input.lighting_revision = 1;
            }
            if phase >= 6 {
                input.material_revision = 1;
            }
            if phase >= 7 {
                input.history_epoch = 1;
            }
            if phase >= 4 && (frame - args.warmup).is_multiple_of(4) && phase <= 6 {
                if phase == 4 {
                    scene.solid.truncate(scene.solid.len() - 36);
                }
                if phase == 5 {
                    for v in &mut scene.solid {
                        v.light = [0.0, 0.0];
                    }
                }
                if phase == 6 {
                    for v in &mut scene.solid {
                        v.color = [0.7, 0.2, 0.2, 1.0];
                    }
                }
                runtime.replace_geometry(&scene)?;
            }
        }
        let start = std::time::Instant::now();
        let passes = runtime.render(&input)?;
        if frame >= args.warmup {
            samples.push(Sample {
                frame,
                wall_ms: start.elapsed().as_secs_f64() * 1000.0,
                passes,
                input: serde_json::json!({"camera":input.camera.to_array(),"target":input.target.to_array(),"history_epoch":input.history_epoch,"world_time":input.world_time,"world_day":input.world_day,"rain":input.rain,"wetness":input.wetness,"world_revision":input.world_revision,"lighting_revision":input.lighting_revision,"material_revision":input.material_revision}),
                history_invalidations: runtime.invalidations,
            });
        }
    }
    runtime.screenshot(&args.output.join("frame.png"))?;
    let report = serde_json::json!({"schema":1,"runtime_revision":pomme_shaderpack::BUILD_REVISION,"build_profile":if cfg!(debug_assertions){"debug"}else{"release"},"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"backend":"OpenGL compatibility","measurement":"serialized offscreen frames; GPU timer queries; excludes presentation; not target-GPU qualification","capabilities":runtime.capabilities,"pack_sha256":runtime.pack.digest,"profile":args.profile,"options":runtime.pack.options,"ignored_profile_options":runtime.pack.ignored_profile_options,"dimension":args.dimension,"minecraft_version":args.minecraft_version,"resolution":[args.width,args.height],"scene":args.scene,"scenario":args.scenario,"scene_input":"deterministic block fixture; not a loaded Minecraft world","fixture_revision":2,"time":args.time,"rain":args.rain,"solid_vertices":scene.solid.len(),"water_vertices":scene.water.len(),"warmup":args.warmup,"invalidations":runtime.invalidations,"passes":runtime.pass_names(),"samples":samples});
    std::fs::write(
        args.output.join("benchmark.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    eprintln!("Saved {}", args.output.display());
    Ok(())
}
