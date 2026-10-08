// One camera/light block, shared by the sky, terrain, and water passes.
// Light-space geometry and ambient occlusion are cached; these inexpensive
// per-pixel operations still respond correctly when the player turns.
struct Frame {
    view_projection: mat4x4<f32>,
    light_view_projection: mat4x4<f32>,
    eye_time: vec4<f32>,
    light_direction_daylight: vec4<f32>,
    light_color_day_phase: vec4<f32>,
    camera_right: vec4<f32>,
    camera_up: vec4<f32>,
    camera_forward: vec4<f32>,
    fog: vec4<f32>,
    screen_quality: vec4<f32>,
    inverse_view_projection: mat4x4<f32>,
    jitter_info: vec4<f32>,
    weather_info: vec4<f32>,
    world_time: vec4<f32>,
    irradiance_origin: vec4<f32>,
    irradiance_extent: vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
@group(0) @binding(3) var sky_environment: texture_2d<f32>;
@group(0) @binding(4) var environment_sampler: sampler;
@group(0) @binding(5) var local_irradiance: texture_3d<f32>;
@group(0) @binding(6) var bounce_irradiance: texture_3d<f32>;

struct CachedIrradiance {
    local: vec4<f32>,
    bounce: vec4<f32>,
};

fn cached_irradiance(position: vec3<f32>, normal: vec3<f32>) -> CachedIrradiance {
    var output: CachedIrradiance;
    output.local = vec4<f32>(0.0);
    output.bounce = vec4<f32>(0.0);
    if (frame.irradiance_extent.w < 0.5) { return output; }
    let coordinate = vec3<i32>(floor((position + normal * 0.05 - frame.irradiance_origin.xyz) / frame.irradiance_origin.w));
    if (any(coordinate < vec3<i32>(0)) || any(coordinate >= vec3<i32>(frame.irradiance_extent.xyz))) { return output; }
    // A single known air cell prevents interpolation through voxel walls.
    output.local = textureLoad(local_irradiance, coordinate, 0);
    output.bounce = textureLoad(bounce_irradiance, coordinate, 0);
    return output;
}

const PI: f32 = 3.14159265359;

fn hash21(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
    return fract((p3.x + p3.y) * p3.z);
}

fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
    return fract((q.x + q.y) * q.z);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0)), u.x), u.y);
}

fn solar_direction() -> vec3<f32> {
    let angle = frame.light_color_day_phase.w * 2.0 * PI;
    return normalize(vec3<f32>(cos(angle) * 0.75, sin(angle), -cos(angle) * 0.45));
}

fn atmosphere(ray: vec3<f32>) -> vec3<f32> {
    if (frame.camera_forward.w < 0.5) { return vec3<f32>(0.065, 0.016, 0.008); }
    let sun = solar_direction();
    let day = frame.light_direction_daylight.w;
    let height = pow(clamp(ray.y * 0.5 + 0.5, 0.0, 1.0), 0.7);
    let night_top = vec3<f32>(0.004, 0.009, 0.028);
    let night_horizon = vec3<f32>(0.028, 0.049, 0.085);
    let day_top = vec3<f32>(0.085, 0.31, 0.69);
    let day_horizon = vec3<f32>(0.65, 0.82, 0.99);
    var sky = mix(mix(night_horizon, night_top, height),
                  mix(day_horizon, day_top, height), day);
    let horizon = pow(1.0 - abs(ray.y), 6.0);
    let sunset = (1.0 - smoothstep(0.06, 0.38, abs(sun.y))) * smoothstep(-0.22, 0.05, sun.y);
    sky += vec3<f32>(1.4, 0.38, 0.09) * horizon * sunset * pow(max(dot(ray, sun), 0.0), 3.0);
    sky += vec3<f32>(1.0, 0.76, 0.42) * pow(max(dot(ray, sun), 0.0), 48.0) * day * 0.38;
    let overcast = mix(vec3<f32>(0.012, 0.018, 0.03), vec3<f32>(0.21, 0.25, 0.29), day);
    return mix(sky, overcast, clamp(frame.weather_info.x * 0.65 + frame.weather_info.y * 0.3, 0.0, 0.95));
}

fn environment_color(ray: vec3<f32>) -> vec3<f32> {
    let uv = vec2<f32>(atan2(ray.z, ray.x) / (2.0 * PI) + 0.5,
        acos(clamp(ray.y, -1.0, 1.0)) / PI);
    return textureSampleLevel(sky_environment, environment_sampler, uv, 0.0).rgb + vec3<f32>(0.65, 0.71, 0.85) * frame.weather_info.z;
}

// Called only when the environment cache is invalidated. Camera rendering and
// water reflections then share a texture lookup instead of repeating noise.
fn clouded_atmosphere(ray: vec3<f32>) -> vec3<f32> {
    var color = atmosphere(ray);
    if (frame.camera_forward.w < 0.5) { return color; }
    if (ray.y > 0.035 && frame.screen_quality.z > 0.5) {
        let sun = solar_direction();
        let day = frame.light_direction_daylight.w;
        let cloud_position = ray.xz / (ray.y + 0.20) * 4.0 + frame.eye_time.xz * 0.0018;
        let wind = vec2<f32>(frame.eye_time.w * 0.006, frame.eye_time.w * 0.002);
        if (frame.screen_quality.z > 1.5) {
            // A bounded six-slice participating cloud layer. This runs only
            // when the environment cache updates, never for every camera or
            // reflected-water pixel. Accumulated extinction gives soft depth.
            var transmission = 1.0;
            var radiance = vec3<f32>(0.0);
            for (var slice = 0; slice < 6; slice += 1) {
                let height = (f32(slice) + 0.5) / 6.0;
                let position = ray.xz / (ray.y + 0.20) * (3.4 + height * 1.2)
                    + frame.eye_time.xz * 0.0018 + wind;
                let noise = noise2(position) * 0.70 + noise2(position * 2.13 + vec2<f32>(height * 0.71)) * 0.30;
                let profile = pow(sin(height * PI), 0.8);
                let density = clamp((noise - 0.43) * 3.6, 0.0, 1.0) * profile;
                let opacity = (1.0 - exp(-density * 0.68)) * smoothstep(0.035, 0.20, ray.y);
                let self_shadow = mix(0.60, 1.0, height);
                let silver = pow(max(dot(ray, sun), 0.0), 12.0) * day * (1.0 - density) * 0.85;
                let lit = mix(vec3<f32>(0.035, 0.055, 0.10), vec3<f32>(0.78, 0.86, 0.95), day) * self_shadow
                    + frame.light_color_day_phase.rgb * silver;
                radiance += transmission * opacity * lit;
                transmission *= 1.0 - opacity;
            }
            return color * transmission + radiance;
        }
        var cloud_noise = noise2(cloud_position + wind) * 0.63
            + noise2(cloud_position * 2.13 + wind) * 0.25;
        cloud_noise += 0.06;
        let cloud = smoothstep(0.49, 0.72, cloud_noise) * smoothstep(0.035, 0.20, ray.y);
        let cloud_light = mix(vec3<f32>(0.035, 0.055, 0.10), vec3<f32>(0.76, 0.85, 0.93), day);
        let lining = pow(max(dot(ray, sun), 0.0), 12.0) * day;
        color = mix(color, cloud_light + frame.light_color_day_phase.rgb * lining * 0.6, cloud * 0.90);
    }
    return color;
}

fn fog_color(world_position: vec3<f32>, surface: vec3<f32>) -> vec3<f32> {
    let delta = world_position - frame.eye_time.xyz;
    let distance = length(delta);
    let ray = delta / max(distance, 0.001);
    let height_density = exp(-max(world_position.y - frame.fog.x, 0.0) * 0.029);
    let density = frame.fog.z * mix(0.48, 1.0, height_density);
    let fog_amount = 1.0 - exp(-distance * distance * density);
    let light_scatter = pow(max(dot(ray, frame.light_direction_daylight.xyz), 0.0), 10.0);
    let color = atmosphere(ray) + frame.light_color_day_phase.rgb * light_scatter * frame.light_direction_daylight.w * 0.19;
    return mix(surface, color, clamp(fog_amount, 0.0, 0.91));
}

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
