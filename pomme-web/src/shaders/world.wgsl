struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
    @location(4) face_uv: vec2<f32>,
    @location(5) tile_id: f32,
    @location(6) flags: f32,
};

struct TerrainVarying {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
    @location(4) face_uv: vec2<f32>,
    @location(5) @interpolate(flat) tile_id: f32,
    @location(6) @interpolate(flat) flags: f32,
    @location(7) lighting: vec2<f32>,
};
struct TerrainOutput {
    @location(0) color: vec4<f32>,
    @location(1) reactive: vec4<f32>,
};

@vertex fn vs_terrain(input: VertexInput) -> TerrainVarying {
    var output: TerrainVarying;
    output.clip_position = frame.view_projection * vec4<f32>(input.position, 1.0);
    output.world_position = input.position;
    output.normal = input.normal;
    output.color = input.color;
    output.ambient_occlusion = input.ambient_occlusion;
    output.face_uv = input.face_uv;
    output.tile_id = input.tile_id;
    output.flags = input.flags;
    let flags = u32(input.flags);
    output.lighting = vec2<f32>(select(1.0, f32((flags >> 10u) & 15u) / 15.0, (flags & 512u) != 0u), f32((flags >> 14u) & 15u) / 15.0);
    return output;
}

@fragment fn fs_terrain(input: TerrainVarying) -> TerrainOutput {
    let texel = block_texel(input.tile_id, input.face_uv);
    if (texel.a < 0.1) { discard; }
    let normal = normalize(input.normal);
    // World-anchored texels survive greedy meshing and never shimmer with time.
    let anchored_xz = fract((input.world_position.xz + frame.jitter_info.zw) / 4096.0) * 4096.0;
    let material_position = vec3<f32>(anchored_xz.x, input.world_position.y, anchored_xz.y);
    let texel_position = floor((material_position - normal * 0.01) * 16.0);
    let grain = hash31(texel_position);
    let block_variation = hash31(floor(material_position - normal * 0.01));
    let texture_modulation = select(0.79 + grain * 0.29 + block_variation * 0.10, 1.0, input.tile_id >= 0.0);
    let albedo = input.color * texel.rgb * texture_modulation;
    let day = frame.light_direction_daylight.w;
    let diffuse = max(dot(normal, frame.light_direction_daylight.xyz), 0.0);
    let visibility = terrain_shadow(input.world_position, normal);
    let ao = clamp(input.ambient_occlusion, 0.18, 1.0);
    let material_flags = u32(input.flags);
    let sky_light = input.lighting.x;
    let block_light = input.lighting.y;
    let sky_facing = normal.y * 0.5 + 0.5;
    let ambient = select(vec3<f32>(0.035, 0.014, 0.008), mix(vec3<f32>(0.055, 0.083, 0.15), vec3<f32>(0.31, 0.40, 0.51), day), frame.camera_forward.w > 0.5);
    let ground_bounce = vec3<f32>(0.13, 0.105, 0.067) * day * (1.0 - sky_facing);
    let direct = frame.light_color_day_phase.rgb * diffuse * mix(0.11, 1.72, day) * visibility * sky_light * frame.camera_forward.w;
    let local_light = vec3<f32>(1.0, 0.67, 0.33) * pow(block_light, 1.5) * 0.85;
    var color = albedo * ((ambient * mix(0.56, 1.0, sky_facing) + ground_bounce) * ao * sky_light + direct * mix(0.66, 1.0, ao) + local_light);
    // The core reserves this saturated amber color for glow blocks. Emission
    // makes their surface and bloom bright; it does not claim indirect GI.
    let legacy_glow = input.tile_id < 0.0 && input.color.r > 0.95 && input.color.g > 0.50 && input.color.b < 0.30;
    let emissive = select(0.0, 1.0, legacy_glow || (u32(input.flags) & 8u) != 0u);
    color += albedo * emissive * 2.2;
    var output: TerrainOutput;
    let blended = (material_flags & 64u) != 0u;
    output.color = vec4<f32>(fog_color(input.world_position, color), select(1.0, texel.a * 0.45, blended));
    let reactive = max(select(0.0, 0.9, (material_flags & 2097152u) != 0u), max(block_reactivity(input.tile_id), select(0.0, 0.8, blended)));
    output.reactive = vec4<f32>(reactive, 0.0, 0.0, 0.0);
    return output;
}
