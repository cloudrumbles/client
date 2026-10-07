// Resolve jittered internal-resolution HDR directly into output-resolution
// history. Depth and a reactive mask reject stale samples before accumulation.
struct TemporalSettings {
    inverse_current_vp: mat4x4<f32>,
    previous_vp: mat4x4<f32>,
    current_eye: vec4<f32>,
    previous_eye: vec4<f32>,
    dimensions: vec4<f32>, // Internal width/height, output width/height.
    options: vec4<f32>, // History valid, history weight, far plane, quality ID.
    jitter: vec4<f32>, // Current xy, previous xy raster offsets in internal pixels.
};

@group(0) @binding(0) var temporal_sampler: sampler;
@group(0) @binding(1) var current_hdr: texture_2d<f32>;
@group(0) @binding(2) var current_depth: texture_depth_2d;
@group(0) @binding(3) var current_reactive: texture_2d<f32>;
@group(0) @binding(4) var history_hdr: texture_2d<f32>;
@group(0) @binding(5) var history_depth: texture_2d<f32>;
@group(0) @binding(6) var<uniform> temporal: TemporalSettings;

struct TemporalVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct TemporalOutput {
    @location(0) color: vec4<f32>,
    @location(1) linear_depth: f32,
};

@vertex fn vs_temporal(@builtin(vertex_index) index: u32) -> TemporalVarying {
    let coordinate = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var output: TemporalVarying;
    output.position = vec4<f32>(coordinate * 2.0 - 1.0, 0.0, 1.0);
    output.uv = coordinate * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0);
    return output;
}

fn temporal_safe_hdr(color: vec3<f32>) -> vec3<f32> {
    // Comparisons with NaN are false; clamp also bounds infinities and protects
    // the rgba16float history against overflow without sacrificing HDR glints.
    return select(vec3<f32>(0.0), clamp(color, vec3<f32>(0.0), vec3<f32>(60000.0)), color == color);
}

fn temporal_to_ycocg(color: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(color, vec3<f32>(0.25, 0.5, 0.25)),
        dot(color, vec3<f32>(0.5, 0.0, -0.5)),
        dot(color, vec3<f32>(-0.25, 0.5, -0.25)));
}

fn temporal_from_ycocg(color: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(color.x + color.y - color.z, color.x + color.z, color.x - color.y - color.z);
}

@fragment fn fs_temporal(input: TemporalVarying) -> TemporalOutput {
    let internal_size = temporal.dimensions.xy;
    let output_size = temporal.dimensions.zw;
    let internal_pixels = vec2<i32>(textureDimensions(current_depth));
    // Projection jitter is an actual raster displacement: right/down positive.
    // Compensate it while reconstructing so the output itself never jitters.
    let half_texel = vec2<f32>(0.5) / internal_size;
    let current_uv = clamp(input.uv + temporal.jitter.xy / internal_size, half_texel, vec2<f32>(1.0) - half_texel);
    let current_pixel = clamp(vec2<i32>(current_uv * internal_size), vec2<i32>(0), internal_pixels - vec2<i32>(1));
    let current_color = temporal_safe_hdr(textureSampleLevel(current_hdr, temporal_sampler, current_uv, 0.0).rgb);
    let raw_depth = textureLoad(current_depth, current_pixel, 0);
    let is_sky = raw_depth >= 0.999999;
    let ndc = vec4<f32>(current_uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), raw_depth, 1.0);
    let homogeneous = temporal.inverse_current_vp * ndc;

    var output: TemporalOutput;
    output.color = vec4<f32>(current_color, 1.0);
    output.linear_depth = 0.0;
    if (homogeneous.w <= 0.0000001) {
        return output;
    }
    let world_position = homogeneous.xyz / homogeneous.w;
    // For this perspective projection clip.w is positive camera-linear depth.
    // inverseVP * normalizedClip has w = 1 / originalClip.w.
    if (!is_sky) {
        output.linear_depth = min(1.0 / homogeneous.w, max(temporal.options.z, 1.0));
    }
    if (temporal.options.x < 0.5) {
        return output;
    }

    var previous_world = world_position;
    if (is_sky) {
        // Distant sky follows camera rotation, never camera translation.
        let sky_ray = normalize(world_position - temporal.current_eye.xyz);
        previous_world = temporal.previous_eye.xyz + sky_ray * max(temporal.options.z, 1.0);
    }
    let previous_clip = temporal.previous_vp * vec4<f32>(previous_world, 1.0);
    if (previous_clip.w <= 0.00001) {
        return output;
    }
    let previous_ndc = previous_clip.xyz / previous_clip.w;
    let previous_uv = previous_ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5) - temporal.jitter.zw / internal_size;
    let history_border = vec2<f32>(0.5) / output_size;
    if (any(previous_uv < history_border) || any(previous_uv > vec2<f32>(1.0) - history_border)) {
        return output;
    }
    let history_dimensions = vec2<i32>(textureDimensions(history_depth));
    let history_pixel = clamp(vec2<i32>(previous_uv * output_size), vec2<i32>(0), history_dimensions - vec2<i32>(1));
    // r32float history depth is deliberately unfilterable. A bilinear mixture
    // of foreground/background depths would invalidate disocclusion checks.
    let old_depth = textureLoad(history_depth, history_pixel, 0).r;
    if (is_sky) {
        if (old_depth > 0.0) { return output; }
    } else {
        let depth_tolerance = max(0.08, previous_clip.w * 0.007);
        if (old_depth <= 0.0 || abs(old_depth - previous_clip.w) > depth_tolerance) {
            return output;
        }
    }

    // Clip history to the current 3x3 neighborhood in luminance/chroma space.
    // Variance tightens the box around real surfaces; min/max preserves edges.
    var neighborhood_min = vec3<f32>(60000.0);
    var neighborhood_max = vec3<f32>(-60000.0);
    var mean = vec3<f32>(0.0);
    var second_moment = vec3<f32>(0.0);
    for (var y = -1; y <= 1; y += 1) {
        for (var x = -1; x <= 1; x += 1) {
            let pixel = clamp(current_pixel + vec2<i32>(x, y), vec2<i32>(0), internal_pixels - vec2<i32>(1));
            let sample_color = temporal_to_ycocg(temporal_safe_hdr(textureLoad(current_hdr, pixel, 0).rgb));
            neighborhood_min = min(neighborhood_min, sample_color);
            neighborhood_max = max(neighborhood_max, sample_color);
            mean += sample_color;
            second_moment += sample_color * sample_color;
        }
    }
    mean *= 1.0 / 9.0;
    let deviation = sqrt(max(second_moment * (1.0 / 9.0) - mean * mean, vec3<f32>(0.0)));
    let gamma = select(1.1, 1.3, temporal.options.w > 1.5);
    let current_ycocg = temporal_to_ycocg(current_color);
    // Always include the actual bilinear current sample, even for thin geometry
    // or sharp emissive pixels that differ substantially from their neighbors.
    let clip_min = min(max(neighborhood_min, mean - deviation * gamma), current_ycocg);
    let clip_max = max(min(neighborhood_max, mean + deviation * gamma), current_ycocg);
    let old_color = temporal_safe_hdr(textureSampleLevel(history_hdr, temporal_sampler, previous_uv, 0.0).rgb);
    let clipped_history = clamp(temporal_to_ycocg(old_color), clip_min, clip_max);
    let stable_history = temporal_safe_hdr(temporal_from_ycocg(clipped_history));

    let motion_pixels = length((previous_uv - input.uv) * output_size);
    var history_weight = clamp(temporal.options.y, 0.0, 0.97)
        * (1.0 - 0.55 * smoothstep(0.4, 12.0, motion_pixels));
    let luminance_delta = abs(current_ycocg.x - clipped_history.x) / max(max(current_ycocg.x, clipped_history.x), 0.06);
    history_weight *= 1.0 - 0.5 * smoothstep(0.1, 0.65, luminance_delta);
    let reactive = clamp(textureSampleLevel(current_reactive, temporal_sampler, current_uv, 0.0).r, 0.0, 1.0);
    // Water moves even with a stationary camera. Keep at least 92% of its
    // current sample so waves and glints do not leave trails in the history.
    history_weight = mix(history_weight, min(history_weight, 0.08), reactive);
    output.color = vec4<f32>(temporal_safe_hdr(mix(current_color, stable_history, history_weight)), 1.0);
    return output;
}
