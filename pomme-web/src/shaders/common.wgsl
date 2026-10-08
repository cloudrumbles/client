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
    environment_fog_color: vec4<f32>, // Linear HDR color, source environment type.
    environment_fog_ranges: vec4<f32>, // Start/end, sky end, cylindrical shape.
    environment_fog_render: vec4<f32>, // Render start/end, modern linear mode, immersion.
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

// Native distances are evaluated per vertex, then interpolated just like
// the original vertex shaders. Leave the existing atmospheric branch intact
// when no source environment fog has been admitted.
fn native_fog_distances(position: vec3<f32>) -> vec2<f32> {
    if (frame.environment_fog_color.w < 0.5) { return vec2<f32>(0.0); }
    let delta = position - frame.eye_time.xyz;
    return vec2<f32>(length(delta), max(length(delta.xz), abs(delta.y)));
}
fn native_fog_fraction(distance: f32, start: f32, end: f32) -> f32 {
    if (distance <= start) { return 0.0; }
    if (distance >= end) { return 1.0; }
    return (distance - start) / (end - start);
}
fn native_fog_value(distances: vec2<f32>) -> f32 {
    let ranges = frame.environment_fog_ranges;
    let render = frame.environment_fog_render;
    if (render.z > 0.5) {
        return max(native_fog_fraction(distances.x, ranges.x, ranges.y),
            native_fog_fraction(distances.y, render.x, render.y));
    }
    let distance = select(distances.x, distances.y, ranges.w > 0.5);
    let factor = native_fog_fraction(distance, ranges.x, ranges.y);
    // Original 1.20.4 linear_fog uses smoothstep; modern uses a linear ratio.
    return factor * factor * (3.0 - 2.0 * factor);
}
fn native_sky_color(surface: vec3<f32>) -> vec3<f32> {
    if (frame.environment_fog_color.w < 0.5) { return surface; }
    if (frame.environment_fog_render.w > 0.5) { return frame.environment_fog_color.rgb; }
    var factor = native_fog_fraction(frame.fog.y, 0.0, frame.environment_fog_ranges.z);
    // Native sky fog uses SkyEnd for both ranges. World render-distance
    // ranges would incorrectly fully fog a sky whose SkyEnd is farther away.
    if (frame.environment_fog_render.z < 0.5) { factor = factor * factor * (3.0 - 2.0 * factor); }
    return mix(surface, frame.environment_fog_color.rgb, factor);
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

fn fog_color_native(world_position: vec3<f32>, surface: vec3<f32>, distances: vec2<f32>) -> vec3<f32> {
    if (frame.environment_fog_color.w > 0.5) {
        return mix(surface, frame.environment_fog_color.rgb, native_fog_value(distances));
    }
    return fog_color(world_position, surface);
}
fn fog_color_material(world_position: vec3<f32>, surface: vec3<f32>, distances: vec2<f32>, flags: u32) -> vec3<f32> {
    // Native first-person rendering selects Fog.NONE for every admitted
    // source fog, including blindness/darkness in air.
    if ((flags & 8388608u) != 0u && frame.environment_fog_color.w > 0.5) { return surface; }
    return fog_color_native(world_position, surface, distances);
}
// Independently implemented bounded directional PCSS. Conceptual audit:
// Photon uses variable penumbras; no Photon code or assets are included here.
const SUN_SHADOW_SEARCH = array<vec2<f32>, 9>(
    vec2<f32>(0.0), vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0),
    vec2<f32>(-1.0,1.0), vec2<f32>(1.0,1.0), vec2<f32>(-1.0,0.0),
    vec2<f32>(1.0,0.0), vec2<f32>(0.0,-1.0), vec2<f32>(0.0,1.0)
);
const SUN_SHADOW_DISC = array<vec2<f32>, 12>(
    vec2<f32>(0.204124145, 0.000000000),
    vec2<f32>(-0.260699267, 0.238821884),
    vec2<f32>(0.039904201, -0.454687792),
    vec2<f32>(0.328594541, 0.428593391),
    vec2<f32>(-0.603011395, -0.106664225),
    vec2<f32>(0.571225035, -0.363366609),
    vec2<f32>(-0.191063595, 0.710747050),
    vec2<f32>(-0.364378997, -0.701589586),
    vec2<f32>(0.790556673, 0.288710029),
    vec2<f32>(-0.822442486, 0.339492303),
    vec2<f32>(0.396471625, -0.847236833),
    vec2<f32>(0.292982446, 0.934074205)
);
fn soft_sun_shadow(uv: vec2<f32>, receiver_depth: f32, texel: vec2<f32>, normal: vec3<f32>) -> f32 {
    let high = frame.screen_quality.z > 1.5;
    let search_count = select(5u,9u,high);
    let search_radius = select(4.0,8.0,high);
    let dimensions = vec2<i32>(textureDimensions(shadow_map));
    // Project the actual surface plane into light UV/depth. Compare each
    // offset against its corresponding receiver depth so broad kernels do
    // not turn a sloped receiver into its own blocker.
    let row_x = vec3<f32>(frame.light_view_projection[0].x,frame.light_view_projection[1].x,frame.light_view_projection[2].x);
    let row_y = vec3<f32>(frame.light_view_projection[0].y,frame.light_view_projection[1].y,frame.light_view_projection[2].y);
    let row_z = vec3<f32>(frame.light_view_projection[0].z,frame.light_view_projection[1].z,frame.light_view_projection[2].z);
    let normal_depth = dot(normal,row_z);
    var receiver_gradient = vec2<f32>(0.0);
    if (abs(normal_depth) > 0.000001) {
        let depth_scale = dot(row_z,row_z) / normal_depth;
        receiver_gradient = vec2<f32>(-2.0 * dot(normal,row_x) / dot(row_x,row_x),
            2.0 * dot(normal,row_y) / dot(row_y,row_y)) * depth_scale;
    }
    var blocker_separation_sum = 0.0;
    var blocker_count = 0.0;
    for (var index = 0u; index < 9u; index++) {
        if (index >= search_count) { break; }
        let offset = SUN_SHADOW_SEARCH[index] * texel * search_radius;
        let sample_uv = uv + offset;
        let pixel = clamp(vec2<i32>(sample_uv * vec2<f32>(dimensions)),vec2<i32>(0),dimensions-vec2<i32>(1));
        let blocker = textureLoad(shadow_map,pixel,0);
        let pixel_uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(dimensions);
        let difference = receiver_depth + dot(receiver_gradient,pixel_uv-uv) - blocker;
        if (blocker < 1.0 && difference > 0.0) { blocker_separation_sum += difference; blocker_count += 1.0; }
    }
    // The center search read preserves thin contact shadows. No blockers
    // means the surface is lit, including steep unoccluded receiver planes.
    if (blocker_count == 0.0) { return 1.0; }
    let light_span = 1.0 / max(length(row_z),0.00001);
    let separation = (blocker_separation_sum / blocker_count) * light_span;
    // Orthographic projection rows give UV per world unit. The 0.02 radian
    // apparent radius agrees with this renderer's analytic solar disk.
    let uv_per_world = 0.5 * length(row_x);
    let radius_pixels = clamp(separation * 0.02 * uv_per_world / texel.x,0.5,select(4.0,8.0,high));
    let filter_count = select(8u,12u,high);
    let normalization = sqrt(12.0 / f32(filter_count));
    var visibility = 0.0;
    for (var index = 0u; index < 12u; index++) {
        if (index >= filter_count) { break; }
        let offset = SUN_SHADOW_DISC[index] * normalization * texel * radius_pixels;
        let pixel = clamp(vec2<i32>((uv+offset) * vec2<f32>(dimensions)),vec2<i32>(0),dimensions-vec2<i32>(1));
        let pixel_uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(dimensions);
        let reference = receiver_depth + dot(receiver_gradient,pixel_uv-uv);
        // A hardware2x2 comparison uses one reference for four different
        // points on a slope. Point comparisons use each texel's corrected
        // receiver depth, without multiplying the bounded texture-read cost.
        visibility += select(0.0,1.0,reference <= textureLoad(shadow_map,pixel,0));
    }
    return visibility / f32(filter_count);
}
fn terrain_shadow_geometry(world_position: vec3<f32>, normal: vec3<f32>, geometric_normal: vec3<f32>) -> f32 {
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
    // Low: original hardware2x2 PCF. Balanced/high: bounded variable penumbra.
    if (frame.screen_quality.z < 0.5) {
        return textureSampleCompareLevel(shadow_map, shadow_sampler, uv, depth);
    }
    return soft_sun_shadow(uv, depth, texel, geometric_normal);
}

fn terrain_shadow(world_position: vec3<f32>, normal: vec3<f32>) -> f32 {
    return terrain_shadow_geometry(world_position, normal, normal);
}
