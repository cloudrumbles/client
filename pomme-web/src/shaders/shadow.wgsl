struct Frame {
    view_projection: mat4x4<f32>,
    light_view_projection: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;

struct ShadowVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) face_uv: vec2<f32>,
    @location(1) @interpolate(flat) tile_id: f32,
    @location(2) @interpolate(flat) flags: f32,
};

@vertex fn vs_shadow(@location(0) position: vec3<f32>, @location(4) face_uv: vec2<f32>, @location(5) tile_id: f32, @location(6) flags: f32) -> ShadowVarying {
    var output: ShadowVarying;
    output.position = frame.light_view_projection * vec4<f32>(position, 1.0);
    output.face_uv = face_uv;
    output.tile_id = tile_id;
    output.flags = flags;
    return output;
}

@fragment fn fs_shadow(input: ShadowVarying) {
    let flags = u32(input.flags);
    if ((flags & 64u) != 0u) { discard; }
    if ((flags & 8u) != 0u && (flags & 1u) == 0u) { discard; }
    if (block_texel(input.tile_id, input.face_uv).a < 0.1) { discard; }
}
