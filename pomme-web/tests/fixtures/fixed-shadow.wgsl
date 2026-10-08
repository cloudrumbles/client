// Original fixed-kernel renderer retained as a GPU comparison control.
fn terrain_shadow(world_position: vec3<f32>, normal: vec3<f32>) -> f32 {
    if (frame.camera_forward.w < 0.5) { return 1.0; }
    let light_clip = frame.light_view_projection * vec4<f32>(world_position, 1.0);
    let light_ndc = light_clip.xyz / light_clip.w;
    let uv = light_ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (any(uv < vec2<f32>(0.003)) || any(uv > vec2<f32>(0.997)) || light_ndc.z < 0.0 || light_ndc.z > 1.0) {
        return 1.0;
    }
    let alignment = clamp(dot(normal, frame.light_direction_daylight.xyz), 0.0, 1.0);
    let depth = light_ndc.z - (0.00023 + (1.0 - alignment) * 0.0012) * frame.fog.w;
    let texel = 1.0 / vec2<f32>(textureDimensions(shadow_map));
    // Low: hardware 2x2 PCF. Balanced/high: a stable 3x3 filter.
    if (frame.screen_quality.z < 0.5) {
        return textureSampleCompareLevel(shadow_map, shadow_sampler, uv, depth);
    }
    var shadow = 0.0;
    for (var x = -1; x <= 1; x += 1) {
        for (var y = -1; y <= 1; y += 1) {
            shadow += textureSampleCompareLevel(shadow_map, shadow_sampler, uv + vec2<f32>(f32(x), f32(y)) * texel, depth);
        }
    }
    return shadow / 9.0;
}

fn terrain_shadow_geometry(world_position: vec3<f32>, normal: vec3<f32>, geometric_normal: vec3<f32>) -> f32 {
    return terrain_shadow(world_position, normal);
}
