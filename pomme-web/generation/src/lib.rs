//! Browser port of Pumpkin 70b31323967bb99fd4feefab8e96124be369cd6f (Minecraft 1.21.11).
//! Native terrain stage functions and their data are called directly. No game rules are rewritten.
use pumpkin_data::{Block, chunk::Biome};
use pumpkin_util::{math::position::BlockPos, world_seed::Seed};
use pumpkin_world::{
    ProtoChunk,
    dimension::Dimension,
    generation::{
        generator::{GeneratorInit, VanillaGenerator},
        settings::gen_settings_from_dimension,
    },
};
use std::{cell::RefCell, rc::Rc, sync::OnceLock};
struct Job {
    generator: Rc<VanillaGenerator>,
    chunk: ProtoChunk,
    stage: u32,
    blocks: Vec<u16>,
    biomes: Vec<u8>,
}
thread_local! {
 static JOB:RefCell<Option<Job>>=const{RefCell::new(None)};
 static GENERATOR:RefCell<Option<(i64,u32,Rc<VanillaGenerator>)>>=const{RefCell::new(None)};
}
fn dimension(value: u32) -> Option<Dimension> {
    match value {
        0 => Some(Dimension::Overworld),
        1 => Some(Dimension::Nether),
        2 => Some(Dimension::End),
        _ => None,
    }
}
fn job(seed: i64, dim: u32, x: i32, z: i32) -> Option<Job> {
    let dimension_id = dim;
    let dim = dimension(dim)?;
    if !(-1_875_000..1_875_000).contains(&x) || !(-1_875_000..1_875_000).contains(&z) {
        return None;
    }
    let generator = GENERATOR.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some((cached_seed, cached_dimension, generator)) = &*cache
            && *cached_seed == seed
            && *cached_dimension == dimension_id
        {
            return generator.clone();
        }
        let generator = Rc::new(VanillaGenerator::new(Seed(seed as u64), dim));
        *cache = Some((seed, dimension_id, generator.clone()));
        generator
    });
    let settings = gen_settings_from_dimension(&dim);
    let chunk = ProtoChunk::new(
        x,
        z,
        settings,
        generator.default_block,
        pumpkin_world::biome::hash_seed(seed as u64),
    );
    Some(Job {
        generator,
        chunk,
        stage: 0,
        blocks: Vec::new(),
        biomes: Vec::new(),
    })
}
fn advance(job: &mut Job) -> u32 {
    let generator = &job.generator;
    let settings = gen_settings_from_dimension(&generator.dimension);
    match job.stage {
        0 => job
            .chunk
            .step_to_biomes(generator.dimension, &generator.base_router),
        1 => job
            .chunk
            .step_to_noise(settings, &generator.random_config, &generator.base_router),
        2 => job.chunk.step_to_surface(
            settings,
            &generator.random_config,
            &generator.terrain_cache,
            &generator.base_router,
        ),
        _ => return 0,
    };
    job.stage += 1;
    job.stage
}
fn extract(job: &mut Job) {
    let settings = gen_settings_from_dimension(&job.generator.dimension);
    let height = settings.shape.height as i32;
    let min_y = settings.shape.min_y as i32;
    job.blocks.clear();
    job.biomes.clear();
    job.blocks.reserve(height as usize * 256);
    job.biomes.reserve(height as usize * 4);
    for y in 0..height {
        for z in 0..16 {
            for x in 0..16 {
                job.blocks.push(job.chunk.get_block_state_raw(x, y, z));
            }
        }
    }
    for y in 0..height / 4 {
        for z in 0..4 {
            for x in 0..4 {
                job.biomes
                    .push(job.chunk.get_biome(x, min_y.div_euclid(4) + y, z).id);
            }
        }
    }
}
pub fn generate(seed: i64, dim: u32, x: i32, z: i32, surface: bool) -> Option<(Vec<u16>, Vec<u8>)> {
    let mut job = job(seed, dim, x, z)?;
    advance(&mut job);
    advance(&mut job);
    if surface {
        advance(&mut job);
    }
    extract(&mut job);
    Some((job.blocks, job.biomes))
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_begin(seed: i64, dim: u32, x: i32, z: i32) -> u32 {
    let value = job(seed, dim, x, z);
    let ok = value.is_some();
    JOB.with(|slot| *slot.borrow_mut() = value);
    u32::from(ok)
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_advance() -> u32 {
    JOB.with(|slot| slot.borrow_mut().as_mut().map_or(0, advance))
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_extract() -> u32 {
    JOB.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(job) = slot.as_mut() else {
            return 0;
        };
        if job.stage < 2 {
            return 0;
        }
        extract(job);
        job.blocks.len() as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_cancel() {
    JOB.with(|slot| *slot.borrow_mut() = None);
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_blocks_ptr() -> *const u16 {
    JOB.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |job| job.blocks.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_biomes_ptr() -> *const u8 {
    JOB.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |job| job.biomes.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_biomes_len() -> u32 {
    JOB.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(0, |job| job.biomes.len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_min_y() -> i32 {
    JOB.with(|slot| {
        slot.borrow().as_ref().map_or(0, |job| {
            gen_settings_from_dimension(&job.generator.dimension)
                .shape
                .min_y as i32
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_height() -> u32 {
    JOB.with(|slot| {
        slot.borrow().as_ref().map_or(0, |job| {
            gen_settings_from_dimension(&job.generator.dimension)
                .shape
                .height as u32
        })
    })
}
static MANIFEST: OnceLock<Vec<u8>> = OnceLock::new();
pub fn manifest() -> &'static [u8] {
    MANIFEST.get_or_init(||{
 let count:usize=env!("POMME_SOURCE_STATE_COUNT").parse().expect("compiled source count");
 let states=(0..count).map(|id|{let block=Block::from_state_id(id as u16);assert!(block.states.iter().any(|state|state.id==id as u16));let properties=block.properties(id as u16).map_or_else(Vec::new,|properties|properties.to_props());serde_json::json!({"id":id,"name":format!("minecraft:{}",block.name),"properties":properties.into_iter().collect::<std::collections::BTreeMap<_,_>>()})}).collect::<Vec<_>>();
 let biomes=(0..=255u8).filter_map(Biome::from_id).map(|biome|serde_json::json!({"id":biome.id,"name":format!("minecraft:{}",biome.registry_id)})).collect::<Vec<_>>();
 serde_json::to_vec(&serde_json::json!({"minecraftVersion":"1.21.11","sourceCommit":"70b31323967bb99fd4feefab8e96124be369cd6f","stages":["biomes","noise","surface"],"states":states,"biomes":biomes})).expect("registry manifest JSON")})
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_manifest_ptr() -> *const u8 {
    manifest().as_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn generator_manifest_len() -> u32 {
    manifest().len() as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn block_tick_queue_proof() -> u32 {
    use pumpkin_world::tick::{ScheduledTick, TickPriority, scheduler::ChunkTickScheduler};
    let mut queue = ChunkTickScheduler::default();
    let a = ScheduledTick {
        delay: 2,
        priority: TickPriority::High,
        position: BlockPos::new(-17, -64, 31),
        value: &Block::STONE,
    };
    let b = ScheduledTick {
        delay: 1,
        priority: TickPriority::Normal,
        position: BlockPos::new(0, 319, 0),
        value: &Block::DIRT,
    };
    queue.schedule_tick(&a, 7);
    queue.schedule_tick(&a, 99);
    queue.schedule_tick(&b, 8);
    let first = queue.step_tick();
    if first.len() != 1 || first[0].position != b.position {
        return 0;
    }
    let second = queue.step_tick();
    if second.len() != 1
        || second[0].sub_tick_order != 7
        || second[0].priority != TickPriority::High
        || queue.is_scheduled(a.position, a.value)
    {
        return 0;
    }
    let wrapped = ScheduledTick { delay: 255, ..a };
    queue.schedule_tick(&wrapped, 11);
    for _ in 0..254 {
        if !queue.step_tick().is_empty() {
            return 0;
        }
    }
    let last = queue.step_tick();
    if last.len() != 1 || last[0].sub_tick_order != 11 {
        return 0;
    }
    255127
}
