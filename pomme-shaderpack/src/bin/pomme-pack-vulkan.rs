#[cfg(feature = "vulkan")]
fn main() -> anyhow::Result<()> {
    use clap::Parser;
    #[derive(Parser)]
    struct Args {
        #[arg(long)]
        pack: std::path::PathBuf,
        #[arg(long, default_value = "world0")]
        dimension: String,
        #[arg(long)]
        profile: Option<String>,
        #[arg(long = "option")]
        options: Vec<String>,
        #[arg(long, default_value = "26.3")]
        minecraft_version: String,
        #[arg(long)]
        render: bool,
        /// Save raw mip-zero current color-buffer bytes and format/extent.
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=15))]
        dump_colortex: Option<u8>,
        #[arg(long, default_value_t = 320)]
        width: u32,
        #[arg(long, default_value_t = 180)]
        height: u32,
        #[arg(long, default_value_t = 4)]
        frames: u32,
        #[arg(long, default_value = "terrain")]
        scene: String,
        #[arg(long)]
        atlas: Option<std::path::PathBuf>,
        #[arg(long, default_value_t = 0)]
        warmup: u32,
        #[arg(long,default_value="static",value_parser=["static","orbit","state-changes"])]
        scenario: String,
        #[arg(long, default_value_t = 6000)]
        time: i32,
        #[arg(long, default_value_t = 0.)]
        rain: f32,
        #[arg(long, default_value = "vulkan-pack-output")]
        output: std::path::PathBuf,
    }
    let a = Args::parse();
    let p = pomme_shaderpack::pack::Pack::load_for_version(
        &a.pack,
        &a.dimension,
        a.profile.as_deref(),
        &a.options,
        pomme_shaderpack::pack::minecraft_version_code(&a.minecraft_version)?,
    )?;
    if a.render {
        use pomme_shaderpack::runtime::FrameInput;
        use pomme_shaderpack::scene::Scene;
        use pomme_shaderpack::vulkan::engine::Engine;
        use pomme_shaderpack::vulkan::headless::Headless;
        std::fs::create_dir_all(&a.output)?;
        let context = Headless::new()?;
        anyhow::ensure!(
            a.frames > 0 && a.frames.checked_add(a.warmup).is_some(),
            "invalid frames"
        );
        anyhow::ensure!((0.0..=1.0).contains(&a.rain), "rain must be in [0,1]");
        let mut scene = Scene::fixture(&a.scene);
        let atlas = a
            .atlas
            .as_ref()
            .map(|p| image::open(p).map(|i| i.to_rgba8()))
            .transpose()?;
        let atlas = atlas
            .as_ref()
            .map(|i| ([i.width(), i.height()], i.as_raw().as_slice()));
        let manifest =
            serde_json::json!({"source_hash":p.digest,"options":p.options,"dimension":p.dimension});
        let mut engine = Engine::new(
            (*context.gpu).clone(),
            p,
            a.width,
            a.height,
            &scene,
            atlas,
            1,
        )?;
        let mut samples = Vec::new();
        for f in 0..a.frames + a.warmup {
            let mut input = FrameInput::fixture(&scene, f, a.time, a.rain);
            if a.scenario == "orbit" {
                let angle = (f as f32) * 0.01;
                let offset = input.camera - input.target;
                input.camera = input.target + glam::Quat::from_rotation_y(angle) * offset;
            }
            if a.scenario == "state-changes" && f >= a.warmup {
                let phase = (f - a.warmup) / 4;
                if phase >= 1 {
                    input.world_time = 18000;
                }
                if phase >= 2 {
                    input.rain = 1.;
                    input.wetness = 1.;
                }
                if phase >= 3 {
                    input.camera += glam::Vec3::new(32., 0., 0.);
                    input.target += glam::Vec3::new(32., 0., 0.);
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
                if (4..=6).contains(&phase) && (f - a.warmup).is_multiple_of(4) {
                    match phase {
                        4 => scene.solid.truncate(scene.solid.len().saturating_sub(36)),
                        5 => {
                            for v in &mut scene.solid {
                                v.light = [0.; 2];
                            }
                        }
                        6 => {
                            for v in &mut scene.solid {
                                v.color = [0.7, 0.2, 0.2, 1.];
                            }
                        }
                        _ => {}
                    }
                    engine.replace_scene(&scene)?;
                }
            }
            let start = std::time::Instant::now();
            let gpu = engine.gpu.clone();
            gpu.submit(|cmd| engine.record(cmd, 0, &input))?;
            if f >= a.warmup {
                samples.push(serde_json::json!({"frame":f,"wall_ms":start.elapsed().as_secs_f64()*1000.,"passes":engine.timings(0)?,"compute_dispatches":engine.compute_dispatches,"input":{"camera":input.camera.to_array(),"world_time":input.world_time,"rain":input.rain,"world_revision":input.world_revision,"lighting_revision":input.lighting_revision,"material_revision":input.material_revision},"invalidations":engine.invalidations}));
            }
        }
        engine.screenshot(&a.output.join("final.png"))?;
        if let Some(index) = a.dump_colortex {
            let image = engine.color_snapshot(index as usize).unwrap();
            std::fs::write(
                a.output.join(format!("colortex{index}.bin")),
                image.readback()?,
            )?;
            std::fs::write(
                a.output.join(format!("colortex{index}.json")),
                serde_json::to_vec_pretty(
                    &serde_json::json!({"index":index,"format":format!("{:?}",image.format),
                    "extent":[image.extent.width,image.extent.height,image.extent.depth],
                    "mip_level":0,"ordering":"raw Vulkan image coordinates, tightly packed","revision":pomme_shaderpack::BUILD_REVISION}),
                )?,
            )?;
        }
        std::fs::write(
            a.output.join("vulkan.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"backend":"Vulkan","device":context.name,"scene":a.scene,"scenario":a.scenario,"warmup":a.warmup,"measurement":"serialized Vulkan graph, GPU timestamps and CPU command recording; excludes game/presentation","manifest":manifest,"width":a.width,"height":a.height,"samples":samples,"compute_programs":engine.compute_manifest(),"invalidations":engine.invalidations,"revision":pomme_shaderpack::BUILD_REVISION}),
            )?,
        )?;
        return Ok(());
    }
    let c = pomme_shaderpack::vulkan::abi::Compiled::new(&p)?;
    std::fs::create_dir_all(&a.output)?;
    std::fs::write(
        a.output.join("abi.json"),
        serde_json::to_vec_pretty(&c.abi)?,
    )?;
    for s in c.programs {
        for (ext, words, text) in [
            ("vert", s.vertex, s.vertex_source),
            ("frag", s.fragment, s.fragment_source),
        ] {
            std::fs::write(a.output.join(format!("{}.{}.glsl", s.name, ext)), text)?;
            std::fs::write(
                a.output.join(format!("{}.{}.spv", s.name, ext)),
                words
                    .iter()
                    .flat_map(|w| w.to_le_bytes())
                    .collect::<Vec<_>>(),
            )?;
        }
    }
    let mut manifest = Vec::new();
    for compute in c.compute_programs {
        std::fs::write(
            a.output.join(format!("{}.comp.glsl", compute.name)),
            &compute.source,
        )?;
        std::fs::write(
            a.output.join(format!("{}.comp.spv", compute.name)),
            compute
                .spirv
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .collect::<Vec<_>>(),
        )?;
        let pomme_shaderpack::compute::Dispatch::Fixed(groups) = compute.dispatch;
        manifest.push(serde_json::json!({"program":compute.name,"base":compute.base,"groups":groups,"local_size":compute.local_size,
            "shared_memory_logical_bytes":compute.shared_memory_bytes,"shared_memory_driver_allocation_bytes":null,
            "spirv_capabilities":compute.capabilities,"samplers":compute.samplers,"images":compute.images}));
    }
    std::fs::write(
        a.output.join("compute.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}
#[cfg(not(feature = "vulkan"))]
fn main() {
    eprintln!("build with --features vulkan");
    std::process::exit(1);
}
