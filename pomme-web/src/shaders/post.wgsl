@group(0) @binding(0) var image_sampler: sampler;
@group(0) @binding(1) var hdr_scene: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
struct PostSettings {
    exposure_bloom: vec4<f32>,
};
@group(0) @binding(3) var<uniform> settings: PostSettings;

struct FullscreenVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex fn vs_fullscreen(@builtin(vertex_index) index: u32) -> FullscreenVarying {
    let coordinate = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var output: FullscreenVarying;
    output.position = vec4<f32>(coordinate * 2.0 - 1.0, 0.0, 1.0);
    output.uv = coordinate * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0);
    return output;
}

fn aces(color: vec3<f32>) -> vec3<f32> {
    return clamp((color * (2.51 * color + vec3<f32>(0.03)))
        / (color * (2.43 * color + vec3<f32>(0.59)) + vec3<f32>(0.14)), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment fn fs_post(input: FullscreenVarying) -> @location(0) vec4<f32> {
    var color = textureSample(hdr_scene, image_sampler, input.uv).rgb;
    color += textureSample(bloom, image_sampler, input.uv).rgb * settings.exposure_bloom.y;
    color = aces(color * settings.exposure_bloom.x);
    // The presentation texture is unorm, so encode linear HDR to display gamma.
    color = pow(color, vec3<f32>(1.0 / 2.2));
    let vignette = 1.0 - dot(input.uv - vec2<f32>(0.5), input.uv - vec2<f32>(0.5)) * 0.17;
    return vec4<f32>(color * vignette, 1.0);
}
