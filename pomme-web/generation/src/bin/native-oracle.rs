use pomme_upstream_generation_wasm::{block_tick_queue_proof, generate, manifest};
use std::{fs, path::Path};
fn main() {
    let output = std::env::var("POMME_NATIVE_REFERENCE_DIRECTORY")
        .unwrap_or_else(|_| "target/native-reference".to_owned());
    let directory = Path::new(&output);
    fs::create_dir_all(directory).unwrap();
    fs::write(directory.join("registry.json"), manifest()).unwrap();
    let cases = [
        (0i64, 0u32, 0i32, 0i32),
        (42, 0, -17, 31),
        (-1, 0, 1874, -1874),
        (42, 1, 0, 0),
        (-1, 1, -17, 31),
        (42, 2, 0, 0),
        (-1, 2, -17, 31),
    ];
    let selected = std::env::args()
        .nth(1)
        .map(|value| value.parse::<usize>().unwrap());
    for (index, (seed, dimension, x, z)) in cases.into_iter().enumerate() {
        if selected.is_some_and(|selected| selected != index) {
            continue;
        }
        let (blocks, biomes) =
            generate(seed, dimension, x, z, true).expect("valid native test case");
        let bytes = blocks
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        fs::write(directory.join(format!("{index}-blocks.bin")), bytes).unwrap();
        fs::write(directory.join(format!("{index}-biomes.bin")), &biomes).unwrap();
        println!(
            "{index} {seed} {dimension} {x} {z} {} {}",
            blocks.len(),
            biomes.len()
        );
    }
    println!("tick {}", block_tick_queue_proof());
}
