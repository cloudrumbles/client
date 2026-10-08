//! Publish measured lighting and native asset poses as generic pack draws.
use std::sync::Arc;

use glam::DVec3;
use pomme_shaderpack::geometry::FrameGeometry;

use super::Renderer;
use super::camera::Camera;
use super::pipelines::block_entity::BlockEntityRenderInfo;
use super::pipelines::entity_renderer::EntityRenderInfo;
use super::pipelines::held_item::{HeldItemInfo, UseAnim};

#[derive(Default)]
pub struct ActorEnvironment {
    entities: Vec<Option<[u8; 2]>>,
    blocks: Vec<Option<([u8; 2], String)>>,
    hand: Option<[u8; 2]>,
}
fn light(chunks: &crate::world::chunk::ChunkStore, position: DVec3) -> Option<[u8; 2]> {
    let [x, y, z] = position.floor().to_array().map(|v| v as i32);
    let published = chunks
        .light_data
        .get(&(x.div_euclid(16), z.div_euclid(16)))?;
    Some([
        published.get_block_light(x, y, z),
        published.get_sky_light(x, y, z),
    ])
}
impl ActorEnvironment {
    pub fn capture(
        game: &crate::app::phases::in_game::GameState,
        entities: &[EntityRenderInfo],
        blocks: &[BlockEntityRenderInfo],
        camera: DVec3,
    ) -> Self {
        let chunks = &game.chunk_store;
        Self {
            entities: entities
                .iter()
                .map(|info| {
                    light(
                        chunks,
                        *info.position + DVec3::Y * f64::from(info.sleeping_eye_height),
                    )
                })
                .collect(),
            blocks: blocks
                .iter()
                .map(|info| {
                    let position = DVec3::new(
                        f64::from(info.pos.x),
                        f64::from(info.pos.y),
                        f64::from(info.pos.z),
                    );
                    let illumination = light(chunks, position)?;
                    let state = chunks.get_block_state(info.pos.x, info.pos.y, info.pos.z);
                    let name = crate::world::block::block_id(state);
                    let properties = crate::world::block::block_properties(state)
                        .entries()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join(",");
                    Some((illumination, format!("{name}[{properties}]")))
                })
                .collect(),
            hand: light(chunks, camera),
        }
    }
}
#[derive(serde::Serialize)]
pub struct Gap {
    pub category: &'static str,
    pub input: usize,
    pub reason: String,
}
pub struct PackScene {
    pub geometry: Arc<FrameGeometry>,
    pub entities: Vec<bool>,
    pub blocks: Vec<bool>,
    pub hand: bool,
    pub gaps: Vec<Gap>,
    pub preparation_ms: f64,
}
impl PackScene {
    pub fn evidence(&self) -> serde_json::Value {
        serde_json::json!({"draws":self.geometry.draws.len(),"entities":self.entities.iter().filter(|v|**v).count(),
            "block_entities":self.blocks.iter().filter(|v|**v).count(),"held_item":self.hand,
            "preparation_ms":self.preparation_ms,"gaps":self.gaps})
    }
}
impl Renderer {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lower_pack_scene(
        &self,
        camera: &Camera,
        entities: &[EntityRenderInfo],
        blocks: &[BlockEntityRenderInfo],
        item: Option<&HeldItemInfo>,
        visible: bool,
        swing: f32,
        use_anim: Option<UseAnim>,
    ) -> PackScene {
        let start = std::time::Instant::now();
        let mut frame = FrameGeometry::default();
        let mut result = PackScene {
            geometry: Arc::new(FrameGeometry::default()),
            entities: vec![false; entities.len()],
            blocks: vec![false; blocks.len()],
            hand: false,
            gaps: Vec::new(),
            preparation_ms: 0.,
        };
        for (index, info) in entities.iter().enumerate() {
            let Some(light) = self
                .pack_actor_environment
                .entities
                .get(index)
                .copied()
                .flatten()
            else {
                result.gaps.push(Gap {
                    category: "entity",
                    input: index,
                    reason: "published light data unavailable".into(),
                });
                continue;
            };
            match self
                .entity_renderer
                .append_pack_cow(info, camera.anchor(), light, &mut frame)
            {
                Ok(count) => result.entities[index] = count > 0,
                Err(error) => result.gaps.push(Gap {
                    category: "entity",
                    input: index,
                    reason: error.to_string(),
                }),
            }
        }
        for (index, info) in blocks.iter().enumerate() {
            let Some((light, state)) = self
                .pack_actor_environment
                .blocks
                .get(index)
                .and_then(Option::as_ref)
            else {
                result.gaps.push(Gap {
                    category: "block_entity",
                    input: index,
                    reason: "published light data unavailable".into(),
                });
                continue;
            };
            match self.block_entity_pipeline.append_pack_chest(
                info,
                camera.anchor(),
                *light,
                state,
                &mut frame,
            ) {
                Ok(count) => result.blocks[index] = count > 0,
                Err(error) => result.gaps.push(Gap {
                    category: "block_entity",
                    input: index,
                    reason: error.to_string(),
                }),
            }
        }
        if visible
            && camera.mode == super::camera::CameraMode::FirstPerson
            && camera.top_down().is_none()
            && let Some(item) = item
        {
            if let Some(light) = self.pack_actor_environment.hand {
                match self.held_item_pipeline.pack_draw(
                    item,
                    &self.item_entity_pipeline,
                    camera.view_effect_matrix(),
                    swing,
                    use_anim,
                    light,
                ) {
                    Ok(draw) => {
                        frame.draws.push(draw);
                        result.hand = true;
                        // Same native HUD FOV and clip planes; OpenGL pack clip convention.
                        frame.hand_projection = Some(glam::camera::rh::proj::opengl::perspective(
                            camera.hud_fov_radians(),
                            self.swapchain.extent.width as f32
                                / self.swapchain.extent.height.max(1) as f32,
                            0.05,
                            10.,
                        ));
                    }
                    Err(error) => result.gaps.push(Gap {
                        category: "hand",
                        input: 0,
                        reason: error.to_string(),
                    }),
                }
            } else {
                result.gaps.push(Gap {
                    category: "hand",
                    input: 0,
                    reason: "published light data unavailable".into(),
                });
            }
        }
        result.geometry = Arc::new(frame);
        result.preparation_ms = start.elapsed().as_secs_f64() * 1000.;
        result
    }
}
