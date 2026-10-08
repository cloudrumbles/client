fn main() {
    let path = "target/source/assets/blocks.json";
    println!("cargo:rerun-if-changed={path}");
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("pinned source registry"))
            .expect("source block registry JSON");
    let count = json["blocks"]
        .as_array()
        .expect("source blocks")
        .iter()
        .flat_map(|block| block["states"].as_array().expect("source states"))
        .map(|state| state["id"].as_u64().expect("source state ID"))
        .max()
        .expect("source state count")
        + 1;
    println!("cargo:rustc-env=POMME_SOURCE_STATE_COUNT={count}");
}
