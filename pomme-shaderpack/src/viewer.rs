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
    pub alternate_packs: Vec<PathBuf>,
    pub profile: Option<String>,
    pub overrides: Vec<String>,
    pub dimension: String,
    pub minecraft_version: u32,
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
#[derive(serde::Serialize)]
struct WindowSample {
    frame: u32,
    world_time: i32,
    world_revision: u64,
    history_epoch: u64,
    rain: f32,
    camera: [f32; 3],
    wall_ms: f64,
    passes: Vec<crate::runtime::PassTiming>,
    history_invalidations: u32,
    game: Option<crate::live::GameSnapshot>,
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
    live: Option<crate::live::SharedWorld>,
    live_revision: u64,
    atlas_revision: u64,
    samples: std::collections::VecDeque<WindowSample>,
    reloads: Vec<serde_json::Value>,
}
impl Viewer {
    fn init(&mut self, events: &ActiveEventLoop) -> Result<()> {
        let attrs = Window::default_attributes()
            .with_title(if self.live.is_some() {
                "Pomme — live original shader pack (control the game window)"
            } else {
                "Pomme — original shader pack (experimental)"
            })
            .with_inner_size(PhysicalSize::new(self.options.width, self.options.height))
            .with_resizable(false)
            .with_active(self.live.is_none());
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
        let pack = Pack::load_for_version(
            &self.options.pack,
            &self.options.dimension,
            self.options.profile.as_deref(),
            &self.options.overrides,
            self.options.minecraft_version,
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
    fn reload(&mut self, path: PathBuf, dimension: String) -> Result<()> {
        let runtime = self.runtime.as_ref().context("runtime unavailable")?;
        let pack = Pack::load_for_version(
            &path,
            &dimension,
            self.options.profile.as_deref(),
            &self.options.overrides,
            self.options.minecraft_version,
        )?;
        let replacement = Runtime::new(
            runtime.gl_dispatch(),
            pack,
            self.options.width,
            self.options.height,
            &self.scene,
            self.options.atlas.as_deref(),
        )?;
        self.reloads.push(serde_json::json!({"frame": self.frame,
            "previous_sha256": runtime.pack.digest, "sha256": replacement.pack.digest,
            "dimension": dimension, "options":replacement.pack.options}));
        self.runtime = Some(replacement);
        self.options.pack = path;
        self.options.dimension = dimension;
        self.live_revision = u64::MAX;
        self.atlas_revision = u64::MAX;
        Ok(())
    }
    fn reload_key(&mut self, key: KeyCode) {
        let next = if key == KeyCode::KeyP {
            self.options.alternate_packs.first().cloned()
        } else {
            Some(self.options.pack.clone())
        };
        if let Some(next) = next {
            let old = self.options.pack.clone();
            match self.reload(next, self.options.dimension.clone()) {
                Ok(()) if key == KeyCode::KeyP => {
                    self.options.alternate_packs.remove(0);
                    self.options.alternate_packs.push(old);
                }
                Ok(()) => (),
                Err(e) => eprintln!("pack reload failed; keeping active pack: {e:#}"),
            }
        }
    }
    fn frame(&mut self) -> Result<bool> {
        let mut live_input = None;
        if let Some(shared) = &self.live {
            let (mut input, scene, revision, atlas, dimension) = {
                let world = shared
                    .lock()
                    .map_err(|_| anyhow::anyhow!("live world lock poisoned"))?;
                if !world.active {
                    return Ok(true);
                }
                let Some(input) = world.frame_input() else {
                    drop(world);
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    self.context.as_ref().unwrap().window.request_redraw();
                    return Ok(false);
                };
                (
                    input,
                    (self.live_revision != world.revision).then(|| world.scene()),
                    world.revision,
                    world
                        .atlas
                        .as_ref()
                        .filter(|a| self.atlas_revision != a.revision)
                        .map(|a| (a.revision, a.size, std::sync::Arc::clone(&a.pixels))),
                    world.game.dimension.clone(),
                )
            };
            let pack_dimension = match dimension.as_str() {
                "minecraft:overworld" | "" => "world0",
                "minecraft:the_nether" => "world-1",
                "minecraft:the_end" => "world1",
                _ => anyhow::bail!("shader dimension mapping unsupported: {dimension}"),
            };
            if self.options.dimension != pack_dimension {
                self.reload(self.options.pack.clone(), pack_dimension.into())?;
            }
            let runtime = self.runtime.as_mut().context("runtime unavailable")?;
            if let Some(scene) = scene {
                self.scene = scene;
                runtime.replace_geometry(&self.scene)?;
                self.live_revision = revision;
            }
            if let Some((revision, size, pixels)) = atlas {
                runtime.replace_atlas(size, &pixels)?;
                self.atlas_revision = revision;
            }
            input.world_revision = revision;
            live_input = Some(input);
        }
        if self.live.is_some() && self.scene.solid.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(16));
            self.context.as_ref().unwrap().window.request_redraw();
            return Ok(false);
        }
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
        if let Some(live) = live_input {
            input = live;
        }
        input.frame = self.frame;
        input.delta_seconds = delta;
        input.seconds = (now - self.start).as_secs_f32();
        let render_start = Instant::now();
        let passes = runtime.render(&input)?;
        if self.samples.len() == 600 {
            self.samples.pop_front();
        }
        self.samples.push_back(WindowSample {
            frame: self.frame,
            world_time: input.world_time,
            world_revision: input.world_revision,
            history_epoch: input.history_epoch,
            rain: input.rain,
            camera: input.camera.to_array(),
            wall_ms: render_start.elapsed().as_secs_f64() * 1000.0,
            passes,
            history_invalidations: runtime.invalidations,
            game: self
                .live
                .as_ref()
                .map(|shared| shared.lock().unwrap().game.clone()),
        });
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
                    "options":runtime.pack.options,"scene":self.options.scene,"solid_vertices":self.scene.solid.len(),"water_vertices":self.scene.water.len(),"world_revision":input.world_revision,"history_epoch":input.history_epoch,"world_time":input.world_time,"world_day":input.world_day,"rain":input.rain,"camera":input.camera.to_array(),
                    "scene_input":if self.live.is_some(){"live native Minecraft chunk meshes"}else{"deterministic fixture, not a Minecraft world"}, "passes":runtime.pass_names(),"measurement":"serialized pack viewport frames; GPU timer readback; excludes main Vulkan rendering; not gameplay-FPS qualification","samples":self.samples,"reloads":self.reloads,"minecraft_version":self.options.minecraft_version,"dimension":self.options.dimension,"eye_brightness":input.eye_brightness,"temperature":input.temperature,"rainfall":input.rainfall
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
                            KeyCode::KeyR | KeyCode::KeyP => self.reload_key(key),
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
/// Additional window owned by the caller's existing winit event loop.
/// Both GPU contexts remain on the game thread; no second event loop is
/// created.
pub struct LiveViewport {
    viewer: Viewer,
    finished: bool,
}
impl LiveViewport {
    pub fn new(
        events: &ActiveEventLoop,
        options: ViewerOptions,
        world: crate::live::SharedWorld,
    ) -> Result<Self> {
        let mut viewer = new_viewer(options, Some(world));
        viewer.init(events)?;
        Ok(Self {
            viewer,
            finished: false,
        })
    }
    pub fn window_id(&self) -> WindowId {
        self.viewer.context.as_ref().unwrap().window.id()
    }
    pub fn tick(&mut self) -> Result<()> {
        if !self.finished && self.viewer.frame()? {
            self.finished = true;
            self.viewer
                .context
                .as_ref()
                .unwrap()
                .window
                .set_visible(false);
            if let Some(shared) = &self.viewer.live {
                shared.lock().unwrap().active = false;
            }
        }
        Ok(())
    }
    pub fn event(&mut self, event: &WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.finished = true;
                self.viewer
                    .context
                    .as_ref()
                    .unwrap()
                    .window
                    .set_visible(false);
                if let Some(shared) = &self.viewer.live {
                    shared.lock().unwrap().active = false;
                }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if let PhysicalKey::Code(key @ (KeyCode::KeyR | KeyCode::KeyP)) = event.physical_key
                {
                    self.viewer.reload_key(key);
                }
            }
            _ => (),
        }
    }
}
impl Drop for LiveViewport {
    fn drop(&mut self) {
        self.viewer.runtime.take();
    }
}
fn new_viewer(options: ViewerOptions, live: Option<crate::live::SharedWorld>) -> Viewer {
    let scene = if live.is_some() {
        Scene {
            solid: Vec::new(),
            water: Vec::new(),
            camera: Vec3::ZERO,
            target: Vec3::NEG_Z,
            materials: Vec::new(),
        }
    } else {
        Scene::fixture(&options.scene)
    };
    let now = Instant::now();
    Viewer {
        runtime: None,
        context: None,
        options,
        scene,
        keys: HashSet::new(),
        start: now,
        last: now,
        frame: 0,
        error: None,
        live,
        live_revision: u64::MAX,
        atlas_revision: u64::MAX,
        samples: std::collections::VecDeque::new(),
        reloads: Vec::new(),
    }
}
pub fn run(options: ViewerOptions) -> Result<()> {
    let mut viewer = new_viewer(options, None);
    EventLoop::new()?.run_app(&mut viewer)?;
    viewer.runtime.take();
    if let Some(error) = viewer.error {
        Err(error)
    } else {
        Ok(())
    }
}
