// Atlas tiles contain an extruded border. UVs remain local to each block face,
// so greedy quads repeat their original texture rather than stretching it.
@group(1) @binding(0) var atlas_sampler: sampler;
@group(1) @binding(1) var block_atlas: texture_2d<f32>;
struct AtlasTile {
    rectangle: vec4<f32>,
    animation: vec4<f32>,
};
@group(1) @binding(2) var<storage, read> tile_rectangles: array<AtlasTile>;

fn block_texel(tile_id: f32, face_uv: vec2<f32>) -> vec4<f32> {
    if (tile_id < 0.0) { return vec4<f32>(1.0); }
    let index = min(u32(tile_id), arrayLength(&tile_rectangles) - 1u);
    let rectangle = tile_rectangles[index].rectangle;
    let uv = rectangle.xy + fract(face_uv) * rectangle.zw;
    return textureSampleLevel(block_atlas, atlas_sampler, uv, 0.0);
}

fn block_reactivity(tile_id: f32) -> f32 {
    if (tile_id < 0.0) { return 0.0; }
    let index = min(u32(tile_id), arrayLength(&tile_rectangles) - 1u);
    return tile_rectangles[index].animation.x * 0.75;
}
