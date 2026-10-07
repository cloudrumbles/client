struct SkyVarying {
    @builtin(position) position: vec4<f32>,
    @location(0) coordinate: vec2<f32>,
};

@vertex fn vs_sky(@builtin(vertex_index) index: u32) -> SkyVarying {
    let coordinate = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var output: SkyVarying;
    output.position = vec4<f32>(coordinate * 2.0 - 1.0, 1.0, 1.0);
    output.coordinate = coordinate * 2.0 - 1.0;
    return output;
}

@fragment fn fs_sky(input: SkyVarying) -> @location(0) vec4<f32> {
    let ray = normalize(frame.camera_forward.xyz
        + frame.camera_right.xyz * input.coordinate.x * frame.camera_right.w
        + frame.camera_up.xyz * input.coordinate.y * frame.camera_up.w);
    let sun = solar_direction();
    let day = frame.light_direction_daylight.w;
    var color = environment_color(ray);
    let sun_disk = smoothstep(0.99970, 0.99985, dot(ray, sun));
    let moon_disk = smoothstep(0.99956, 0.99979, dot(ray, -sun));
    color += sun_disk * vec3<f32>(9.0, 7.5, 4.6) * smoothstep(-0.10, 0.02, sun.y);
    color += moon_disk * vec3<f32>(0.58, 0.70, 1.02) * (1.0 - day);

    let star_cell = floor(vec2<f32>(atan2(ray.z, ray.x), asin(clamp(ray.y, -1.0, 1.0))) * 680.0);
    let star = pow(hash21(star_cell), 190.0) * (1.0 - day) * smoothstep(0.02, 0.30, ray.y);
    color += vec3<f32>(0.54, 0.66, 1.0) * star * 0.7;

    // Tiny celestial features remain analytic so the bounded environment map
    // can be reused without blurring the sun, moon, or stars.
    return vec4<f32>(color, 1.0);
}
