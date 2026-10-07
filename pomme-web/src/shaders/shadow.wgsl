struct Frame {
    view_projection: mat4x4<f32>,
    light_view_projection: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;

@vertex fn vs_shadow(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return frame.light_view_projection * vec4<f32>(position, 1.0);
}
