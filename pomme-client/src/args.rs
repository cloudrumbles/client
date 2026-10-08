use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "pomme", about = "Minecraft client")]
pub struct LaunchArgs {
    /// Original pack directory/ZIP in an experimental second native live-world
    /// viewport.
    #[cfg(feature = "shader-packs")]
    #[arg(long)]
    pub shader_pack: Option<String>,
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
    #[arg(long)]
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
