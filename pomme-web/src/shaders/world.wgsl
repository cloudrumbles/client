struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
};

struct TerrainVarying {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
};

@vertex fn vs_terrain(input: VertexInput) -> TerrainVarying {
    var output: TerrainVarying;
    output.clip_position = frame.view_projection * vec4<f32>(input.position, 1.0);
    output.world_position = input.position;
    output.normal = input.normal;
    output.color = input.color;
    output.ambient_occlusion = input.ambient_occlusion;
    return output;
}

@fragment fn fs_terrain(input: TerrainVarying) -> @location(0) vec4<f32> {
    let normal = normalize(input.normal);
    // World-anchored texels survive greedy meshing and never shimmer with time.
    let texel_position = floor((input.world_position - normal * 0.01) * 16.0);
    let grain = hash31(texel_position);
    let block_variation = hash31(floor(input.world_position - normal * 0.01));
    let albedo = input.color * (0.79 + grain * 0.29 + block_variation * 0.10);
    let day = frame.light_direction_daylight.w;
    let diffuse = max(dot(normal, frame.light_direction_daylight.xyz), 0.0);
    let visibility = terrain_shadow(input.world_position, normal);
    let ao = clamp(input.ambient_occlusion, 0.18, 1.0);
    let sky_facing = normal.y * 0.5 + 0.5;
    let ambient = mix(vec3<f32>(0.055, 0.083, 0.15), vec3<f32>(0.31, 0.40, 0.51), day);
    let ground_bounce = vec3<f32>(0.13, 0.105, 0.067) * day * (1.0 - sky_facing);
    let direct = frame.light_color_day_phase.rgb * diffuse * mix(0.11, 1.72, day) * visibility;
    var color = albedo * (ambient * mix(0.56, 1.0, sky_facing) * ao + ground_bounce * ao + direct * mix(0.66, 1.0, ao));
    // The core reserves this saturated amber color for glow blocks. Emission
    // makes their surface and bloom bright; it does not claim indirect GI.
    let emissive = select(0.0, 1.0, input.color.r > 0.95 && input.color.g > 0.50 && input.color.b < 0.30);
    color += albedo * emissive * 2.2;
    return vec4<f32>(fog_color(input.world_position, color), 1.0);
}
