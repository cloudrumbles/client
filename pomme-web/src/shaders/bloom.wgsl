@group(0) @binding(0) var image_sampler: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;
struct BloomSettings {
    texel_direction: vec4<f32>,
    threshold: vec4<f32>,
};
@group(0) @binding(2) var<uniform> settings: BloomSettings;

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

@fragment fn fs_extract(input: FullscreenVarying) -> @location(0) vec4<f32> {
    let texel = settings.texel_direction.xy;
    let color = (textureSample(source, image_sampler, input.uv + texel * vec2<f32>(-0.75, -0.75)).rgb
        + textureSample(source, image_sampler, input.uv + texel * vec2<f32>(0.75, -0.75)).rgb
        + textureSample(source, image_sampler, input.uv + texel * vec2<f32>(-0.75, 0.75)).rgb
        + textureSample(source, image_sampler, input.uv + texel * vec2<f32>(0.75, 0.75)).rgb) * 0.25;
    let brightness = max(max(color.r, color.g), color.b);
    let amount = max(brightness - settings.threshold.x, 0.0) / max(brightness, 0.001);
    return vec4<f32>(min(color * amount, vec3<f32>(12.0)), 1.0);
}

@fragment fn fs_blur(input: FullscreenVarying) -> @location(0) vec4<f32> {
    let step = settings.texel_direction.xy * settings.texel_direction.zw;
    var color = textureSample(source, image_sampler, input.uv).rgb * 0.227027;
    color += textureSample(source, image_sampler, input.uv + step * 1.384615).rgb * 0.316216;
    color += textureSample(source, image_sampler, input.uv - step * 1.384615).rgb * 0.316216;
    color += textureSample(source, image_sampler, input.uv + step * 3.230769).rgb * 0.070270;
    color += textureSample(source, image_sampler, input.uv - step * 3.230769).rgb * 0.070270;
    return vec4<f32>(color, 1.0);
}
