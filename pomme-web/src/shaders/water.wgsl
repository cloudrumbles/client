@group(1) @binding(0) var scene_sampler: sampler;
@group(1) @binding(1) var opaque_scene: texture_2d<f32>;
// A read-only copy of opaque depth, separate from the water depth attachment.
@group(1) @binding(2) var opaque_depth: texture_depth_2d;

struct WaterInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) ambient_occlusion: f32,
    @location(4) face_uv: vec2<f32>,
    @location(5) tile_id: f32,
    @location(6) flags: f32,
};

struct WaterVarying {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) face_uv: vec2<f32>,
    @location(3) @interpolate(flat) tile_id: f32,
    @location(4) @interpolate(flat) flags: f32,
    @location(5) color: vec3<f32>,
};

struct WaterOutput {
    @location(0) color: vec4<f32>,
    @location(1) reactive: vec4<f32>,
};

fn water_screen_position(world_position: vec3<f32>) -> vec3<f32> {
    let clip = frame.view_projection * vec4<f32>(world_position, 1.0);
    if (clip.w <= 0.001) {
        return vec3<f32>(-1.0, -1.0, 2.0);
    }
    let ndc = clip.xyz / clip.w;
    return vec3<f32>(ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5), ndc.z);
}

fn water_scene_position(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let ndc = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
    let homogeneous = frame.inverse_view_projection * ndc;
    return homogeneous.xyz / homogeneous.w;
}

fn water_depth_at(uv: vec2<f32>) -> f32 {
    let dimensions = vec2<i32>(textureDimensions(opaque_depth));
    let pixel = clamp(vec2<i32>(uv * vec2<f32>(dimensions)), vec2<i32>(0), dimensions - vec2<i32>(1));
    return textureLoad(opaque_depth, pixel, 0);
}

// March only through on-screen opaque geometry. The cached environment handles
// off-screen terrain and sky; no ray-march or depth sample runs on low quality.
fn water_screen_reflection(world_position: vec3<f32>, normal: vec3<f32>, direction: vec3<f32>) -> vec4<f32> {
    if (frame.screen_quality.z < 0.5 || frame.screen_quality.w < 0.5 || direction.y < 0.005 || normal.y < 0.35) {
        return vec4<f32>(0.0);
    }
    let high_quality = frame.screen_quality.z > 1.5;
    let step_count = select(18u, 30u, high_quality);
    let maximum_distance = select(48.0, 64.0, high_quality);
    let origin = world_position + normal * 0.08;
    let jitter = hash21(floor(water_screen_position(world_position).xy * frame.screen_quality.xy)) * 0.6;
    var previous_distance = 0.18;
    var previous_separation = -1.0;
    var previous_valid = false;

    for (var step = 0u; step < 30u; step += 1u) {
        if (step >= step_count) { break; }
        let fraction = min((f32(step) + 0.8 + jitter) / f32(step_count), 1.0);
        let distance = 0.18 + maximum_distance * pow(fraction, 1.65);
        let ray_position = origin + direction * distance;
        let screen = water_screen_position(ray_position);
        if (any(screen.xy < vec2<f32>(0.002)) || any(screen.xy > vec2<f32>(0.998)) || screen.z < 0.0 || screen.z > 1.0) {
            break;
        }
        let depth = water_depth_at(screen.xy);
        if (depth >= 0.999999) {
            previous_valid = false;
            previous_distance = distance;
            continue;
        }
        let scene_position = water_scene_position(screen.xy, depth);
        // Camera-linear depth avoids comparing nonlinear perspective z values.
        let separation = dot(ray_position - scene_position, frame.camera_forward.xyz);
        if (previous_valid && previous_separation < 0.0 && separation >= 0.0) {
            var near_distance = previous_distance;
            var far_distance = distance;
            // Refine a front-to-back crossing; every texture read uses an
            // explicit level or textureLoad, including divergent control flow.
            for (var refinement = 0u; refinement < 4u; refinement += 1u) {
                let middle_distance = (near_distance + far_distance) * 0.5;
                let middle_position = origin + direction * middle_distance;
                let middle_screen = water_screen_position(middle_position);
                let middle_depth = water_depth_at(middle_screen.xy);
                var middle_separation = -1.0;
                if (middle_depth < 0.999999) {
                    middle_separation = dot(middle_position - water_scene_position(middle_screen.xy, middle_depth), frame.camera_forward.xyz);
                }
                if (middle_separation >= 0.0) {
                    far_distance = middle_distance;
                } else {
                    near_distance = middle_distance;
                }
            }
            let hit_ray_position = origin + direction * far_distance;
            let hit_screen = water_screen_position(hit_ray_position);
            let hit_depth = water_depth_at(hit_screen.xy);
            let hit_position = water_scene_position(hit_screen.xy, hit_depth);
            let hit_separation = dot(hit_ray_position - hit_position, frame.camera_forward.xyz);
            let thickness = 0.18 + far_distance * 0.018;
            // Reject depth discontinuities, submerged geometry, and the water
            // origin itself instead of treating them as reflected surfaces.
            if (hit_depth < 0.999999 && hit_separation >= 0.0 && hit_separation < thickness
                && hit_position.y > world_position.y + 0.04 && length(hit_position - world_position) > 0.4) {
                let nearest_edge = min(min(hit_screen.x, 1.0 - hit_screen.x), min(hit_screen.y, 1.0 - hit_screen.y));
                let edge_confidence = smoothstep(0.005, 0.09, nearest_edge);
                let distance_confidence = 1.0 - smoothstep(maximum_distance * 0.65, maximum_distance, far_distance);
                let depth_confidence = 1.0 - smoothstep(thickness * 0.45, thickness, hit_separation);
                let ray_confidence = smoothstep(0.005, 0.045, direction.y);
                let confidence = edge_confidence * distance_confidence * depth_confidence * ray_confidence;
                let reflected_color = textureSampleLevel(opaque_scene, scene_sampler, hit_screen.xy, 0.0).rgb;
                return vec4<f32>(reflected_color, confidence);
            }
        }
        previous_distance = distance;
        previous_separation = separation;
        previous_valid = true;
    }
    return vec4<f32>(0.0);
}

@vertex fn vs_water(input: WaterInput) -> WaterVarying {
    var output: WaterVarying;
    output.clip_position = frame.view_projection * vec4<f32>(input.position, 1.0);
    output.world_position = input.position;
    output.normal = input.normal;
    output.face_uv = input.face_uv;
    output.tile_id = input.tile_id;
    output.flags = input.flags;
    output.color = input.color;
    return output;
}

@fragment fn fs_water(input: WaterVarying) -> WaterOutput {
    let time = frame.eye_time.w;
    if ((u32(input.flags) & 8u) != 0u) {
        // Lava is emissive fluid, not blue reflective water. Preserve its
        // atlas texture and advect it slowly without any SSR/refraction work.
        let texel = block_texel(input.tile_id, input.face_uv + vec2<f32>(time * 0.012, time * 0.006));
        let ember = 0.94 + sin(input.world_position.x * 1.3 + input.world_position.z * 0.7 + time) * 0.06;
        var output: WaterOutput;
        output.color = vec4<f32>(fog_color(input.world_position, input.color * texel.rgb * (2.3 * ember) + vec3<f32>(0.30, 0.055, 0.005)), 1.0);
        output.reactive = vec4<f32>(1.0, 0.0, 0.0, 0.0);
        return output;
    }
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
    let terrain_reflection = water_screen_reflection(input.world_position, normal, reflected);
    let reflection = mix(sky_reflection, terrain_reflection.rgb, terrain_reflection.a);
    let half_direction = normalize(view + frame.light_direction_daylight.xyz);
    let glint = pow(max(dot(normal, half_direction), 0.0), 420.0);
    let shadow = terrain_shadow(input.world_position + vec3<f32>(0.0, 0.015, 0.0), normal);
    let sunlight = frame.light_color_day_phase.rgb * glint * mix(0.6, 8.0, frame.light_direction_daylight.w) * shadow;
    let uv = input.clip_position.xy / frame.screen_quality.xy;
    let bend = vec2<f32>(wave_x, -wave_z) * 0.014;
    let behind_water = textureSampleLevel(opaque_scene, scene_sampler, clamp(uv + bend, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).rgb;
    let tint = mix(vec3<f32>(0.025, 0.13, 0.17), vec3<f32>(0.04, 0.24, 0.27), frame.light_direction_daylight.w);
    let transmitted = behind_water * vec3<f32>(0.55, 0.79, 0.83) + tint * 0.34;
    let water = mix(transmitted, reflection * 1.12, fresnel) + sunlight;
    var output: WaterOutput;
    output.color = vec4<f32>(fog_color(input.world_position, water), 1.0);
    // Waves, refraction, reflections, and glints change independently of the
    // static world. Temporal reconstruction must favor the current water pixel.
    output.reactive = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    return output;
}
