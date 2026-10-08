struct EnvironmentVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex fn vs_environment(@builtin(vertex_index) index: u32) -> EnvironmentVarying {
    let coordinate = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var output: EnvironmentVarying;
    output.position = vec4<f32>(coordinate * 2.0 - 1.0, 0.0, 1.0);
    output.uv = coordinate * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0);
    return output;
}

@fragment fn fs_environment(input: EnvironmentVarying) -> @location(0) vec4<f32> {
    let longitude = (input.uv.x - 0.5) * 2.0 * PI;
    let latitude = input.uv.y * PI;
    let ray = vec3<f32>(cos(longitude) * sin(latitude), cos(latitude), sin(longitude) * sin(latitude));
    return vec4<f32>(clouded_atmosphere(ray), 1.0);
}
