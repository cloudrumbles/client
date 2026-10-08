//! A real desktop OpenGL compatibility context, including in display-less CI.
use anyhow::{Context as _, Result, ensure};
use khronos_egl as egl;

use crate::gl;

pub struct HeadlessContext {
    pub gl: gl::Gl,
    egl: egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    surface: egl::Surface,
    context: egl::Context,
    _desktop_gl: libloading::Library,
}
impl HeadlessContext {
    pub fn new(width: u32, height: u32) -> Result<Self> {
        unsafe {
            let egl = egl::DynamicInstance::<egl::EGL1_5>::load_required()?;
            // EGL_MESA_platform_surfaceless is a context transport, not a software
            // requirement. Vendor EGL may instead use its default device/display.
            let display = egl
                .get_platform_display(0x31DD, std::ptr::null_mut(), &[egl::ATTRIB_NONE])
                .or_else(|_| {
                    egl.get_display(egl::DEFAULT_DISPLAY)
                        .context("no EGL display")
                        .map_err(|_| egl::Error::BadDisplay)
                })?;
            egl.initialize(display)?;
            egl.bind_api(egl::OPENGL_API)?;
            let config = egl
                .choose_first_config(
                    display,
                    &[
                        egl::SURFACE_TYPE,
                        egl::PBUFFER_BIT,
                        egl::RENDERABLE_TYPE,
                        egl::OPENGL_BIT,
                        egl::RED_SIZE,
                        8,
                        egl::GREEN_SIZE,
                        8,
                        egl::BLUE_SIZE,
                        8,
                        egl::NONE,
                    ],
                )?
                .context("no desktop OpenGL pbuffer configuration")?;
            let context = egl.create_context(
                display,
                config,
                None,
                &[
                    egl::CONTEXT_MAJOR_VERSION,
                    4,
                    egl::CONTEXT_MINOR_VERSION,
                    3,
                    egl::CONTEXT_OPENGL_PROFILE_MASK,
                    egl::CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT,
                    egl::NONE,
                ],
            )?;
            let surface = egl.create_pbuffer_surface(
                display,
                config,
                &[
                    egl::WIDTH,
                    width as i32,
                    egl::HEIGHT,
                    height as i32,
                    egl::NONE,
                ],
            )?;
            egl.make_current(display, Some(surface), Some(surface), Some(context))?;
            let desktop_gl = libloading::Library::new("libGL.so.1")?;
            let gl = gl::Gl::load_with(|name| {
                egl.get_proc_address(name)
                    .map(|f| f as *const std::ffi::c_void)
                    .or_else(|| {
                        desktop_gl
                            .get::<*const std::ffi::c_void>(name.as_bytes())
                            .ok()
                            .map(|s| *s)
                    })
                    .unwrap_or(std::ptr::null())
            });
            ensure!(
                gl.Begin.is_loaded() && gl.DispatchCompute.is_loaded(),
                "OpenGL 4.3 compatibility required"
            );
            Ok(Self {
                gl,
                egl,
                display,
                surface,
                context,
                _desktop_gl: desktop_gl,
            })
        }
    }
}
impl Drop for HeadlessContext {
    fn drop(&mut self) {
        let _ = self.egl.make_current(self.display, None, None, None);
        let _ = self.egl.destroy_surface(self.display, self.surface);
        let _ = self.egl.destroy_context(self.display, self.context);
        let _ = self.egl.terminate(self.display);
    }
}
