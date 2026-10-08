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

// Native portal surfaces project the imported two textures through differently
// rotated layers. Only fragments on portal tiles pay for these texture reads.
const PORTAL_COLORS = array<vec3<f32>, 16>(
    vec3<f32>(0.022087, 0.098399, 0.110818), vec3<f32>(0.011892, 0.095924, 0.089485),
    vec3<f32>(0.027636, 0.101689, 0.100326), vec3<f32>(0.046564, 0.109883, 0.114838),
    vec3<f32>(0.064901, 0.117696, 0.097189), vec3<f32>(0.063761, 0.086895, 0.123646),
    vec3<f32>(0.084817, 0.111994, 0.166380), vec3<f32>(0.097489, 0.154120, 0.091064),
    vec3<f32>(0.106152, 0.131144, 0.195191), vec3<f32>(0.097721, 0.110188, 0.187229),
    vec3<f32>(0.133516, 0.138278, 0.148582), vec3<f32>(0.070006, 0.243332, 0.235792),
    vec3<f32>(0.196766, 0.142899, 0.214696), vec3<f32>(0.047281, 0.315338, 0.321970),
    vec3<f32>(0.204675, 0.390010, 0.302066), vec3<f32>(0.080955, 0.314821, 0.661491)
);

fn portal_color(tile_id: f32, position: vec3<f32>, metadata: vec4<f32>) -> vec3<f32> {
    let clip = frame.view_projection * vec4<f32>(position, 1.0);
    let projected = clip.xy * 0.5 + vec2<f32>(clip.w * 0.5);
    let divisor = max(abs(clip.w), 0.00001);
    var color = vec3<f32>(0.0);
    if (metadata.z >= 0.0) { color = block_texel(metadata.z, projected / divisor).rgb * PORTAL_COLORS[0]; }
    for (var index = 0u; index < min(u32(metadata.y), 16u); index++) {
        let layer = f32(index + 1u);
        let angle = ((layer * layer * 4321.0 + layer * 9.0) * 2.0) * PI / 180.0;
        let rotation = mat2x2<f32>(vec2<f32>(cos(angle), -sin(angle)), vec2<f32>(sin(angle), cos(angle)));
        let rotated = projected * ((4.5 - layer / 4.0) * 2.0) * rotation;
        let translated = rotated + vec2<f32>(17.0 / layer, (2.0 + layer / 1.5) * frame.world_time.x * 1.5) * clip.w;
        let uv = (translated * 0.5 + vec2<f32>(clip.w * 0.25)) / divisor;
        color += block_texel(tile_id, uv).rgb * PORTAL_COLORS[index];
    }
    return color;
}

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
    if (input.tile_id >= 0.0) {
        let metadata = tile_rectangles[min(u32(input.tile_id), arrayLength(&tile_rectangles) - 1u)].animation;
        if (metadata.y >= 15.0) {
            var portal: TerrainOutput;
            portal.color = vec4<f32>(portal_color(input.tile_id, input.world_position, metadata), 1.0);
            portal.reactive = vec4<f32>(0.9, 0.0, 0.0, 0.0);
            return portal;
        }
    }
    let material_flags = u32(input.flags);
    let eye_layer = (material_flags & 100663296u) != 0u;
    let texel = block_texel(input.tile_id, input.face_uv);
    // Original eye shaders preserve even the lowest-alpha texels. Breeze eyes
    // and wind retain the native 0.1 alpha cutout.
    if (texel.a < 0.1 && !eye_layer) { discard; }
    let normal = normalize(input.normal);
    // World-anchored texels survive greedy meshing and never shimmer with time.
    let anchored_xz = fract((input.world_position.xz + frame.jitter_info.zw) / 4096.0) * 4096.0;
    let material_position = vec3<f32>(anchored_xz.x, fract((input.world_position.y + frame.world_time.z) / 4096.0) * 4096.0, anchored_xz.y);
    let texel_position = floor((material_position - normal * 0.01) * 16.0);
    let grain = hash31(texel_position);
    let block_variation = hash31(floor(material_position - normal * 0.01));
    let texture_modulation = select(0.79 + grain * 0.29 + block_variation * 0.10, 1.0, input.tile_id >= 0.0);
    let albedo = input.color * texel.rgb * texture_modulation;
    // Native glowing glyphs use a full-bright lightmap. Their color remains
    // albedo rather than the material emission used by lamps and fire.
    if ((material_flags & 16777216u) != 0u) {
        var fullbright: TerrainOutput;
        let actor_alpha = (material_flags & 234881024u) != 0u;
        var color = fog_color(input.world_position, albedo);
        if ((material_flags & 33554432u) != 0u) {
            // Additive eyes fade into the existing scene. Adding the fog's
            // atmospheric color here would make transparent black glow.
            color -= fog_color(input.world_position, vec3<f32>(0.0));
        }
        fullbright.color = vec4<f32>(color, select(1.0, texel.a, actor_alpha));
        fullbright.reactive = vec4<f32>(0.9, 0.0, 0.0, 0.0);
        return fullbright;
    }
    let day = frame.light_direction_daylight.w;
    if ((material_flags & 268435456u) != 0u) {
        // Breeze wind uses the lightmap without cardinal/directional shading,
        // native texel alpha, and a separate depth-writing translucent pass.
        let sky_ambient = mix(vec3<f32>(0.055, 0.083, 0.15), vec3<f32>(0.31, 0.40, 0.51), day);
        let lightmap = sky_ambient * input.lighting.x + vec3<f32>(1.0, 0.67, 0.33) * pow(input.lighting.y, 1.5) * 0.85;
        var wind: TerrainOutput;
        wind.color = vec4<f32>(fog_color(input.world_position, albedo * lightmap), texel.a);
        wind.reactive = vec4<f32>(0.9, 0.0, 0.0, 0.0);
        return wind;
    }
    let diffuse = max(dot(normal, frame.light_direction_daylight.xyz), 0.0);
    let visibility = terrain_shadow(input.world_position, normal);
    let particle = (material_flags & 4194304u) != 0u;
    let ao = select(clamp(input.ambient_occlusion, 0.18, 1.0), 1.0, particle);
    let sky_light = input.lighting.x;
    let block_light = input.lighting.y;
    let sky_facing = normal.y * 0.5 + 0.5;
    let ambient = select(vec3<f32>(0.035, 0.014, 0.008), mix(vec3<f32>(0.055, 0.083, 0.15), vec3<f32>(0.31, 0.40, 0.51), day), frame.camera_forward.w > 0.5);
    let ground_bounce = vec3<f32>(0.13, 0.105, 0.067) * day * (1.0 - sky_facing);
    let direct = frame.light_color_day_phase.rgb * diffuse * mix(0.11, 1.72, day) * visibility * sky_light * frame.camera_forward.w * frame.weather_info.w;
    var cached: CachedIrradiance;
    if (!particle && (material_flags & 8388608u) == 0u) { cached = cached_irradiance(input.world_position, normal); }
    let local_hue = select(vec3<f32>(1.0, 0.67, 0.33), clamp(cached.local.rgb / max(cached.local.a, 0.001), vec3<f32>(0.0), vec3<f32>(1.0)), cached.local.a > 0.001 && !particle);
    let local_light = local_hue * pow(block_light, 1.5) * 0.85;
    let cached_bounce = select(vec3<f32>(0.0), cached.bounce.rgb * ao * frame.weather_info.w, cached.bounce.a > 0.5 && !particle);
    var color = albedo * ((ambient * mix(0.56, 1.0, sky_facing) + ground_bounce) * ao * sky_light + direct * mix(0.66, 1.0, ao) + local_light + cached_bounce);
    // The core reserves this saturated amber color for glow blocks. Emission
    // makes their surface and bloom bright; it does not claim indirect GI.
    let legacy_glow = input.tile_id < 0.0 && input.color.r > 0.95 && input.color.g > 0.50 && input.color.b < 0.30;
    let emissive = select(0.0, 1.0, legacy_glow || (u32(input.flags) & 8u) != 0u);
    color += albedo * emissive * 2.2;
    var output: TerrainOutput;
    let blended = (material_flags & 64u) != 0u;
    let alpha = select(select(1.0, texel.a * 0.45, blended), texel.a * clamp(input.ambient_occlusion, 0.0, 1.0), particle);
    if (alpha <= 0.001) { discard; }
    output.color = vec4<f32>(fog_color(input.world_position, color), alpha);
    let reactive = max(select(0.0, 1.0, (material_flags & 8388608u) != 0u), max(select(0.0, 0.9, (material_flags & 2097152u) != 0u), max(block_reactivity(input.tile_id), select(0.0, 0.8, blended))));
    output.reactive = vec4<f32>(reactive, 0.0, 0.0, 0.0);
    return output;
}
