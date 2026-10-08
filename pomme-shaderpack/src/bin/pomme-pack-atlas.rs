//! Extract an optional tiny benchmark atlas from the user's own vanilla jar.
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use clap::Parser;
#[derive(Parser)]
struct Args {
    #[arg(long)]
    client_jar: PathBuf,
    #[arg(long)]
    output: PathBuf,
}
fn main() -> Result<()> {
    let args = Args::parse();
    let mut jar = zip::ZipArchive::new(std::fs::File::open(args.client_jar)?)?;
    let mut atlas = image::RgbaImage::new(64, 16);
    for (tile, name) in ["grass_block_top", "stone", "oak_leaves", "water_still"]
        .iter()
        .enumerate()
    {
        let mut entry = jar
            .by_name(&format!("assets/minecraft/textures/block/{name}.png"))
            .with_context(|| format!("missing vanilla texture {name}"))?;
        ensure!(entry.size() < 1024 * 1024, "texture is too large");
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes)?;
        let image = image::load_from_memory(&bytes)?.to_rgba8();
        ensure!(
            image.width() >= 16 && image.height() >= 16,
            "texture is smaller than a tile"
        );
        let frame = image::imageops::crop_imm(&image, 0, 0, 16, 16).to_image();
        image::imageops::replace(&mut atlas, &frame, tile as i64 * 16, 0);
    }
    atlas.save(&args.output)?;
    eprintln!(
        "Saved {} (first animation frames; vanilla assets are not bundled)",
        args.output.display()
    );
    Ok(())
}
