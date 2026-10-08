use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "pomme", about = "Minecraft client")]
pub struct LaunchArgs {
    /// Compare the immutable shared scene with the previous immediate path.
    #[arg(long, value_enum, default_value_t = crate::renderer::scene::RendererPath::Shared)]
    pub renderer_path: crate::renderer::scene::RendererPath,

    /// Original pack directory/ZIP rendered by Vulkan in the game window.
    #[cfg(feature = "shader-packs")]
    #[arg(long)]
    pub shader_pack: Option<String>,
    /// Run the separate OpenGL compatibility reference viewport instead.
    #[cfg(feature = "shader-packs")]
    #[arg(long)]
    pub shader_reference_window: bool,
    /// Additional user pack paths; P in the shader viewport cycles them.
    #[cfg(feature = "shader-packs")]
    #[arg(long = "shader-alternate-pack")]
    pub shader_alternate_packs: Vec<String>,
    #[cfg(feature = "shader-packs")]
    #[arg(long)]
    pub shader_profile: Option<String>,
    #[cfg(feature = "shader-packs")]
    #[arg(long = "shader-option")]
    pub shader_options: Vec<String>,
    #[cfg(feature = "shader-packs")]
    #[arg(long, default_value_t = 640)]
    pub shader_width: u32,
    #[cfg(feature = "shader-packs")]
    #[arg(long, default_value_t = 360)]
    pub shader_height: u32,
    #[cfg(feature = "shader-packs")]
    /// Capture exactly this many submitted pack frames, then stop retaining
    /// diagnostics.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=10_000))]
    pub shader_frames: Option<u32>,
    #[cfg(feature = "shader-packs")]
    #[arg(long, default_value = "shaderpack-live-output")]
    pub shader_output: String,

    #[arg(long)]
    pub version: Option<String>,

    #[arg(long)]
    pub username: Option<String>,

    #[arg(long)]
    pub uuid: Option<String>,

    #[arg(long)]
    pub access_token: Option<String>,

    #[arg(long)]
    pub launch_token: Option<String>,

    #[arg(long)]
    pub assets_dir: Option<String>,

    #[arg(long)]
    pub versions_dir: Option<String>,

    #[arg(long)]
    pub game_dir: Option<String>,

    #[arg(long)]
    pub quick_access_multiplayer: Option<String>,
}
