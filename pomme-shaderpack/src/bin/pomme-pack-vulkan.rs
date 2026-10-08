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
        #[arg(long, default_value_t = 320)]
        width: u32,
        #[arg(long, default_value_t = 180)]
        height: u32,
        #[arg(long, default_value_t = 4)]
        frames: u32,
        #[arg(long, default_value = "terrain")]
        scene: String,
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
        let scene = Scene::fixture(&a.scene);
        let manifest =
            serde_json::json!({"source_hash":p.digest,"options":p.options,"dimension":p.dimension});
        let mut engine = Engine::new(
            (*context.gpu).clone(),
            p,
            a.width,
            a.height,
            &scene,
            None,
            1,
        )?;
        let mut samples = Vec::new();
        for f in 0..a.frames {
            let input = FrameInput::fixture(&scene, f, a.time, a.rain);
            let start = std::time::Instant::now();
            let gpu = engine.gpu.clone();
            gpu.submit(|cmd| engine.record(cmd, 0, &input))?;
            samples.push(serde_json::json!({"frame":f,"wall_ms":start.elapsed().as_secs_f64()*1000.,"passes":engine.timings(0)?}));
        }
        engine.screenshot(&a.output.join("final.png"))?;
        std::fs::write(
            a.output.join("vulkan.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"backend":"Vulkan","device":context.name,"manifest":manifest,"width":a.width,"height":a.height,"samples":samples,"invalidations":engine.invalidations,"revision":pomme_shaderpack::BUILD_REVISION}),
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
    Ok(())
}
#[cfg(not(feature = "vulkan"))]
fn main() {
    eprintln!("build with --features vulkan");
    std::process::exit(1);
}
