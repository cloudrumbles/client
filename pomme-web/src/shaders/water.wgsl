@group(1) @binding(0) var scene_sampler: sampler;
@group(1) @binding(1) var opaque_scene: texture_2d<f32>;

struct WaterInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
};

struct WaterVarying {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
};

@vertex fn vs_water(input: WaterInput) -> WaterVarying {
    var output: WaterVarying;
    output.clip_position = frame.view_projection * vec4<f32>(input.position, 1.0);
    output.world_position = input.position;
    output.normal = input.normal;
    return output;
}

@fragment fn fs_water(input: WaterVarying) -> @location(0) vec4<f32> {
    let time = frame.eye_time.w;
    let xz = input.world_position.xz;
    let wave_x = cos(xz.x * 1.75 + xz.y * 0.65 + time * 1.4) * 0.032
        + cos(xz.x * 0.54 - xz.y * 1.25 - time * 0.9) * 0.028;
    let wave_z = sin(xz.x * 1.20 + xz.y * 1.55 + time * 1.1) * 0.034
        + sin(xz.x * 0.78 - xz.y * 0.44 + time * 0.7) * 0.022;
    let normal = normalize(input.normal + vec3<f32>(wave_x, 0.0, wave_z));
    let view = normalize(frame.eye_time.xyz - input.world_position);
    let facing = clamp(dot(normal, view), 0.0, 1.0);
    let fresnel = 0.025 + 0.975 * pow(1.0 - facing, 5.0);
    let reflected = reflect(-view, normal);
    let sky_reflection = environment_color(reflected);
    let half_direction = normalize(view + frame.light_direction_daylight.xyz);
    let glint = pow(max(dot(normal, half_direction), 0.0), 420.0);
    let shadow = terrain_shadow(input.world_position + vec3<f32>(0.0, 0.015, 0.0), normal);
    let sunlight = frame.light_color_day_phase.rgb * glint * mix(0.6, 8.0, frame.light_direction_daylight.w) * shadow;
    let uv = input.clip_position.xy / frame.screen_quality.xy;
    let bend = vec2<f32>(wave_x, -wave_z) * 0.014;
    let behind_water = textureSample(opaque_scene, scene_sampler, clamp(uv + bend, vec2<f32>(0.001), vec2<f32>(0.999))).rgb;
    let tint = mix(vec3<f32>(0.025, 0.13, 0.17), vec3<f32>(0.04, 0.24, 0.27), frame.light_direction_daylight.w);
    let transmitted = behind_water * vec3<f32>(0.55, 0.79, 0.83) + tint * 0.34;
    let water = mix(transmitted, sky_reflection * 1.12, fresnel) + sunlight;
    return vec4<f32>(fog_color(input.world_position, water), 1.0);
}
