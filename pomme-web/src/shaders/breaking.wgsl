struct BreakingInput {
    @location(0) position: vec3<f32>,
    @location(4) uv: vec2<f32>,
    @location(5) tile: f32,
    @location(6) flags: f32,
};
struct BreakingVarying {
    @builtin(position) clip: vec4<f32>,
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) @interpolate(flat) tile: f32,
    @location(3) @interpolate(flat) fog: u32,
};
struct BreakingOutput {
    @location(0) color: vec4<f32>,
    @location(1) reactive: vec4<f32>,
};
@vertex fn vs_breaking(input: BreakingInput) -> BreakingVarying {
    var output: BreakingVarying;
    output.clip = frame.view_projection * vec4<f32>(input.position, 1.0);
    output.position = input.position; output.uv = input.uv; output.tile = input.tile; output.fog = u32(input.flags) & 1u;
    return output;
}
@fragment fn fs_breaking(input: BreakingVarying) -> BreakingOutput {
    // This material group binds the atlas's source-unorm view. A destroy
    // texture is a multiplication factor, so gray128 must stay about 0.5.
    let texel = block_texel(input.tile, input.uv);
    if (texel.a < 0.1) { discard; }
    var output: BreakingOutput;
    var color = texel.rgb;
    if (input.fog != 0u) { color = fog_color(input.position, color); }
    output.color = vec4<f32>(color, texel.a); output.reactive = vec4<f32>(1.0,1.0,0.0,0.0);
    return output;
}
@fragment fn fs_breaking_removed(input: BreakingVarying) -> BreakingOutput {
    var output: BreakingOutput;
    output.color = vec4<f32>(0.0); output.reactive = vec4<f32>(1.0,1.0,0.0,0.0);
    return output;
}
