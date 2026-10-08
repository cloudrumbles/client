use std::collections::HashSet;
use std::ffi::CString;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use glam::{Quat, Vec3};
use glutin::config::ConfigTemplateBuilder;
use glutin::context::{
    ContextApi, ContextAttributesBuilder, GlProfile, PossiblyCurrentContext, Version,
};
use glutin::display::{GetGlDisplay, GlDisplay};
use glutin::prelude::*;
use glutin::surface::{Surface, SurfaceAttributesBuilder, SwapInterval, WindowSurface};
use glutin_winit::DisplayBuilder;
use raw_window_handle::HasWindowHandle;
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{Window, WindowId};

use crate::gl;
use crate::pack::Pack;
use crate::runtime::{FrameInput, Runtime};
use crate::scene::Scene;

pub struct ViewerOptions {
    pub pack: PathBuf,
    pub profile: Option<String>,
    pub overrides: Vec<String>,
    pub dimension: String,
    pub width: u32,
    pub height: u32,
    pub scene: String,
    pub time: i32,
    pub rain: f32,
    pub atlas: Option<PathBuf>,
    pub max_frames: Option<u32>,
    pub output: PathBuf,
}
struct WindowContext {
    window: Window,
    surface: Surface<WindowSurface>,
    context: PossiblyCurrentContext,
}
struct Viewer {
    runtime: Option<Runtime>,
    context: Option<WindowContext>,
    options: ViewerOptions,
    scene: Scene,
    keys: HashSet<KeyCode>,
    start: Instant,
    last: Instant,
    frame: u32,
    error: Option<anyhow::Error>,
}
impl Viewer {
    fn init(&mut self, events: &ActiveEventLoop) -> Result<()> {
        let attrs = Window::default_attributes()
            .with_title("Pomme — original shader pack (experimental)")
            .with_inner_size(PhysicalSize::new(self.options.width, self.options.height))
            .with_resizable(false);
        let (window, config) = DisplayBuilder::new()
            .with_window_attributes(Some(attrs))
            .build(
                events,
                ConfigTemplateBuilder::new().with_depth_size(24),
                |configs| configs.max_by_key(|c| c.num_samples()).unwrap(),
            )
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let window = window.context("window creation failed")?;
        let raw = window.window_handle()?.as_raw();
        let display = config.display();
        let attributes = ContextAttributesBuilder::new()
            .with_profile(GlProfile::Compatibility)
            .with_context_api(ContextApi::OpenGl(Some(Version::new(4, 3))))
            .build(Some(raw));
        let context = unsafe { display.create_context(&config, &attributes)? };
        let attributes = SurfaceAttributesBuilder::<WindowSurface>::new().build(
            raw,
            NonZeroU32::new(self.options.width).context("zero width")?,
            NonZeroU32::new(self.options.height).context("zero height")?,
        );
        let surface = unsafe { display.create_window_surface(&config, &attributes)? };
        let context = context.make_current(&surface)?;
        surface.set_swap_interval(&context, SwapInterval::DontWait)?;
        let gl = gl::Gl::load_with(|s| display.get_proc_address(&CString::new(s).unwrap()));
        let pack = Pack::load(
            &self.options.pack,
            &self.options.dimension,
            self.options.profile.as_deref(),
            &self.options.overrides,
        )?;
        self.runtime = Some(Runtime::new(
            gl,
            pack,
            self.options.width,
            self.options.height,
            &self.scene,
            self.options.atlas.as_deref(),
        )?);
        self.context = Some(WindowContext {
            window,
            surface,
            context,
        });
        self.last = Instant::now();
        Ok(())
    }
    fn frame(&mut self) -> Result<bool> {
        let now = Instant::now();
        let delta = (now - self.last).as_secs_f32().min(0.1);
        self.last = now;
        let mut forward = (self.scene.target - self.scene.camera).normalize();
        let horizontal = i32::from(self.keys.contains(&KeyCode::ArrowLeft))
            - i32::from(self.keys.contains(&KeyCode::ArrowRight));
        let vertical = i32::from(self.keys.contains(&KeyCode::ArrowUp))
            - i32::from(self.keys.contains(&KeyCode::ArrowDown));
        forward = Quat::from_axis_angle(Vec3::Y, horizontal as f32 * delta) * forward;
        let pitch =
            Quat::from_axis_angle(forward.cross(Vec3::Y).normalize(), vertical as f32 * delta)
                * forward;
        if pitch.y.abs() < 0.98 {
            forward = pitch;
        }
        self.scene.target = self.scene.camera + forward * 10.0;
        let right = forward.cross(Vec3::Y).normalize();
        let mut movement = Vec3::ZERO;
        for (key, direction) in [
            (KeyCode::KeyW, forward),
            (KeyCode::KeyS, -forward),
            (KeyCode::KeyD, right),
            (KeyCode::KeyA, -right),
            (KeyCode::Space, Vec3::Y),
            (KeyCode::ShiftLeft, -Vec3::Y),
        ] {
            if self.keys.contains(&key) {
                movement += direction;
            }
        }
        let step = movement.normalize_or_zero() * delta * 12.0;
        self.scene.camera += step;
        self.scene.target += step;
        let runtime = self.runtime.as_mut().context("runtime unavailable")?;
        let mut input = FrameInput::fixture(
            &self.scene,
            self.frame,
            self.options.time,
            self.options.rain,
        );
        input.delta_seconds = delta;
        input.seconds = (now - self.start).as_secs_f32();
        runtime.render(&input)?;
        let finished = self
            .options
            .max_frames
            .is_some_and(|max| self.frame + 1 >= max);
        if finished {
            std::fs::create_dir_all(&self.options.output)?;
            runtime.screenshot(&self.options.output.join("frame.png"))?;
            std::fs::write(
                self.options.output.join("window.json"),
                serde_json::to_vec_pretty(&serde_json::json!({
                    "runtime_revision":crate::BUILD_REVISION,"backend":"OpenGL compatibility", "presented_frames":self.frame + 1,
                    "capabilities":runtime.capabilities,"pack_sha256":runtime.pack.digest,
                    "options":runtime.pack.options,"scene":self.options.scene,
                    "scene_input":"deterministic fixture, not a Minecraft world", "passes":runtime.pass_names()
                }))?,
            )?;
        }
        let context = self.context.as_ref().unwrap();
        context.surface.swap_buffers(&context.context)?;
        self.frame += 1;
        context.window.request_redraw();
        Ok(finished)
    }
    fn fail(&mut self, events: &ActiveEventLoop, error: anyhow::Error) {
        self.error = Some(error);
        events.exit();
    }
}
impl ApplicationHandler for Viewer {
    fn resumed(&mut self, events: &ActiveEventLoop) {
        if self.context.is_none()
            && let Err(e) = self.init(events)
        {
            self.fail(events, e)
        }
    }
    fn window_event(&mut self, events: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => events.exit(),
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(key) = event.physical_key {
                    if event.state == ElementState::Pressed {
                        self.keys.insert(key);
                        match key {
                            KeyCode::Escape => events.exit(),
                            KeyCode::Digit1 => self.options.time = 6000,
                            KeyCode::Digit2 => self.options.time = 12000,
                            KeyCode::Digit3 => self.options.time = 18000,
                            KeyCode::KeyG => self.options.rain = 1.0 - self.options.rain,
                            KeyCode::KeyR => {
                                let result = (|| {
                                    let runtime =
                                        self.runtime.as_ref().context("runtime unavailable")?;
                                    let pack = Pack::load(
                                        &self.options.pack,
                                        &self.options.dimension,
                                        self.options.profile.as_deref(),
                                        &self.options.overrides,
                                    )?;
                                    Runtime::new(
                                        runtime.gl_dispatch(),
                                        pack,
                                        self.options.width,
                                        self.options.height,
                                        &self.scene,
                                        self.options.atlas.as_deref(),
                                    )
                                })();
                                match result {
                                    Ok(runtime) => self.runtime = Some(runtime),
                                    Err(e) => {
                                        eprintln!("pack reload failed; keeping active pack: {e:#}")
                                    }
                                }
                            }
                            _ => (),
                        }
                    } else {
                        self.keys.remove(&key);
                    }
                }
            }
            WindowEvent::Focused(false) => self.keys.clear(),
            WindowEvent::RedrawRequested => match self.frame() {
                Ok(true) => events.exit(),
                Ok(false) => (),
                Err(e) => self.fail(events, e),
            },
            _ => (),
        }
    }
    fn about_to_wait(&mut self, _: &ActiveEventLoop) {
        if let Some(c) = &self.context {
            c.window.request_redraw();
        }
    }
}
pub fn run(options: ViewerOptions) -> Result<()> {
    let scene = Scene::fixture(&options.scene);
    let now = Instant::now();
    let mut viewer = Viewer {
        runtime: None,
        context: None,
        options,
        scene,
        keys: HashSet::new(),
        start: now,
        last: now,
        frame: 0,
        error: None,
    };
    EventLoop::new()?.run_app(&mut viewer)?;
    // GL resources must be released while the context is still current.
    viewer.runtime.take();
    if let Some(error) = viewer.error {
        Err(error)
    } else {
        Ok(())
    }
}
