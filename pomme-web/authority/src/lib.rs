//! Worker-local authoritative block ticking. See ../README.md for supported
//! behavior and the pinned Pumpkin source used for the portable translation.
pub mod inventory;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, MutexGuard};

type Position = [i32; 3];
const SECTION_SIZE: usize = 4096;
const MAX_SECTIONS: usize = 1024;
const MAX_TICKS: usize = 65536;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const DIRECTIONS: [Position; 6] = [
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
];

#[derive(Clone, Copy, Default)]
struct State {
    registered: bool,
    group: u16,
    kind: u8,
    active: bool,
    solid: bool,
    counterpart: u16,
    direction: u8,
}
#[derive(Clone, Copy)]
struct Tick {
    position: Position,
    group: u16,
    priority: i8,
    order: u64,
}
#[derive(Clone)]
struct Scheduler {
    queue: [Vec<Tick>; 256],
    queued: HashSet<(Position, u16)>,
    offset: usize,
    order: u64,
}
impl Default for Scheduler {
    fn default() -> Self {
        Self {
            queue: std::array::from_fn(|_| Vec::new()),
            queued: HashSet::new(),
            offset: 0,
            order: 0,
        }
    }
}
impl Scheduler {
    fn schedule(&mut self, position: Position, group: u16, delay: u8, priority: i8) -> bool {
        if self.queued.contains(&(position, group)) {
            return true;
        }
        if self.queued.len() >= MAX_TICKS {
            return false;
        }
        self.queued.insert((position, group));
        self.queue[(self.offset + usize::from(delay)) % 256].push(Tick {
            position,
            group,
            priority,
            order: self.order,
        });
        self.order = self.order.wrapping_add(1);
        true
    }
    fn step(&mut self) -> Vec<Tick> {
        self.offset = (self.offset + 1) % 256;
        let mut ticks = std::mem::take(&mut self.queue[self.offset]);
        for tick in &ticks {
            self.queued.remove(&(tick.position, tick.group));
        }
        ticks.sort_unstable_by_key(|tick| (tick.priority, tick.order));
        ticks
    }
}
struct Authority {
    states: Vec<State>,
    sections: BTreeMap<Position, Box<[u16; SECTION_SIZE]>>,
    changes: BTreeMap<Position, u16>,
    scheduler: Scheduler,
    min_y: i32,
    height: i32,
    age: i64,
    daytime: i64,
    daylight: bool,
    staging: Box<[u16; SECTION_SIZE]>,
    bytes: Vec<u8>,
    input: Vec<u8>,
    events: Vec<i32>,
}
impl Default for Authority {
    fn default() -> Self {
        Self {
            states: vec![State::default(); 65536],
            sections: BTreeMap::new(),
            changes: BTreeMap::new(),
            scheduler: Scheduler::default(),
            min_y: -64,
            height: 384,
            age: 0,
            daytime: 0,
            daylight: true,
            staging: Box::new([0; SECTION_SIZE]),
            bytes: Vec::new(),
            input: vec![0; MAX_BYTES],
            events: Vec::new(),
        }
    }
}
fn section(position: Position) -> (Position, usize) {
    (
        [
            position[0].div_euclid(16),
            position[1].div_euclid(16),
            position[2].div_euclid(16),
        ],
        (position[1].rem_euclid(16) * 256
            + position[2].rem_euclid(16) * 16
            + position[0].rem_euclid(16)) as usize,
    )
}
fn offset(position: Position, delta: Position) -> Position {
    [
        position[0].saturating_add(delta[0]),
        position[1].saturating_add(delta[1]),
        position[2].saturating_add(delta[2]),
    ]
}
impl Authority {
    fn mutation_capacity(&self) -> bool {
        self.changes.len() <= MAX_TICKS - 32 && self.scheduler.queued.len() <= MAX_TICKS - 32
    }
    fn get(&self, position: Position) -> Option<u16> {
        let (key, index) = section(position);
        self.sections.get(&key).map(|blocks| blocks[index])
    }
    fn descriptor(&self, position: Position) -> State {
        self.get(position)
            .map(|id| self.states[usize::from(id)])
            .unwrap_or_default()
    }
    fn set(&mut self, position: Position, id: u16) -> bool {
        if !self.states[usize::from(id)].registered {
            return false;
        }
        let (key, index) = section(position);
        let Some(blocks) = self.sections.get_mut(&key) else {
            return false;
        };
        if blocks[index] == id {
            return true;
        }
        if self.changes.len() >= MAX_TICKS && !self.changes.contains_key(&position) {
            return false;
        }
        blocks[index] = id;
        self.changes.insert(position, id);
        true
    }
    fn weak_power(&self, position: Position) -> bool {
        let state = self.descriptor(position);
        state.kind == 5 || ((1..=3).contains(&state.kind) && state.active)
    }
    fn strong_power(&self, position: Position, direction: usize) -> bool {
        let state = self.descriptor(position);
        (1..=3).contains(&state.kind) && state.active && usize::from(state.direction) == direction
    }
    fn receives_power(&self, position: Position) -> bool {
        DIRECTIONS.iter().any(|direction| {
            let neighbor = offset(position, *direction);
            self.weak_power(neighbor)
                || (self.descriptor(neighbor).solid
                    && DIRECTIONS
                        .iter()
                        .enumerate()
                        .any(|(index, side)| self.strong_power(offset(neighbor, *side), index)))
        })
    }
    fn update_lamp(&mut self, position: Position) -> bool {
        let state = self.descriptor(position);
        if state.kind != 4 {
            return true;
        }
        let powered = self.receives_power(position);
        if state.active && !powered {
            self.scheduler.schedule(position, state.group, 4, 0)
        } else if !state.active && powered {
            self.set(position, state.counterpart)
        } else {
            true
        }
    }
    fn notify(&mut self, position: Position) -> bool {
        let mut positions = HashSet::new();
        for side in DIRECTIONS {
            let neighbor = offset(position, side);
            positions.insert(neighbor);
            for next in DIRECTIONS {
                positions.insert(offset(neighbor, next));
            }
        }
        let mut positions: Vec<_> = positions.into_iter().collect();
        positions.sort_unstable();
        positions.into_iter().all(|pos| self.update_lamp(pos))
    }
    fn interact(&mut self, position: Position) -> bool {
        let state = self.descriptor(position);
        if !(1..=3).contains(&state.kind) {
            return false;
        }
        if state.kind != 1 && state.active {
            return true;
        }
        if !self.mutation_capacity() {
            return false;
        }
        if state.kind != 1
            && self.scheduler.queued.len() >= MAX_TICKS
            && !self.scheduler.queued.contains(&(position, state.group))
        {
            return false;
        }
        if !self.set(position, state.counterpart) {
            return false;
        }
        if state.kind != 1 {
            self.scheduler.schedule(
                position,
                state.group,
                if state.kind == 2 { 20 } else { 30 },
                0,
            );
        }
        self.notify(position)
    }
    fn tick(&mut self) -> bool {
        let due = &self.scheduler.queue[(self.scheduler.offset + 1) % 256];
        let mut changes = self.changes.len();
        let mut scheduled = self.scheduler.queued.len() - due.len();
        for tick in due {
            let state = self.descriptor(tick.position);
            if state.group != tick.group || !state.active {
                continue;
            }
            if state.kind == 2 || state.kind == 3 {
                changes += 32;
                scheduled += 32;
            } else if state.kind == 4 {
                changes += 1;
            }
        }
        if changes > MAX_TICKS || scheduled > MAX_TICKS {
            return false;
        }
        self.age = self.age.wrapping_add(1);
        if self.daylight {
            self.daytime = self.daytime.wrapping_add(1);
        }
        for tick in self.scheduler.step() {
            let state = self.descriptor(tick.position);
            if state.group != tick.group {
                continue;
            }
            if (state.kind == 2 || state.kind == 3) && state.active {
                if !self.set(tick.position, state.counterpart) || !self.notify(tick.position) {
                    return false;
                }
            } else if state.kind == 4
                && state.active
                && !self.receives_power(tick.position)
                && !self.set(tick.position, state.counterpart)
            {
                return false;
            }
        }
        true
    }
    fn snapshot(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"PMBA\x01\0\0\0");
        bytes.extend_from_slice(&self.min_y.to_le_bytes());
        bytes.extend_from_slice(&self.height.to_le_bytes());
        bytes.extend_from_slice(&self.age.to_le_bytes());
        bytes.extend_from_slice(&self.daytime.to_le_bytes());
        bytes.extend_from_slice(&u32::from(self.daylight).to_le_bytes());
        bytes.extend_from_slice(&(self.sections.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(self.scheduler.queued.len() as u32).to_le_bytes());
        for (position, blocks) in &self.sections {
            for value in position {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in blocks.iter() {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        for delay in 0..256 {
            for tick in &self.scheduler.queue[(self.scheduler.offset + delay) % 256] {
                for value in tick.position {
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
                bytes.extend_from_slice(&tick.group.to_le_bytes());
                bytes.push(delay as u8);
                bytes.push(tick.priority as u8);
                bytes.extend_from_slice(&tick.order.to_le_bytes());
            }
        }
        bytes
    }
    fn restore(&mut self, length: usize) -> bool {
        let Some(input) = self.input.get(..length) else {
            return false;
        };
        let mut reader = Reader {
            bytes: input,
            offset: 0,
        };
        if reader.take(8) != Some(&b"PMBA\x01\0\0\0"[..]) {
            return false;
        }
        let Some(min_y) = reader.i32() else {
            return false;
        };
        let Some(height) = reader.i32() else {
            return false;
        };
        if !valid_bounds(min_y, height) {
            return false;
        }
        let Some(age) = reader.i64() else {
            return false;
        };
        let Some(daytime) = reader.i64() else {
            return false;
        };
        let Some(daylight) = reader.u32() else {
            return false;
        };
        if daylight > 1 {
            return false;
        }
        let Some(section_count) = reader.u32() else {
            return false;
        };
        let Some(tick_count) = reader.u32() else {
            return false;
        };
        if section_count as usize > MAX_SECTIONS || tick_count as usize > MAX_TICKS {
            return false;
        }
        let mut sections = BTreeMap::new();
        let mut scheduler = Scheduler::default();
        for _ in 0..section_count {
            let Some(pos) = reader.position() else {
                return false;
            };
            if pos[1] < min_y / 16 || pos[1] >= (min_y + height) / 16 {
                return false;
            }
            let mut blocks = Box::new([0; SECTION_SIZE]);
            for id in blocks.iter_mut() {
                let Some(value) = reader.u16() else {
                    return false;
                };
                if !self.states[usize::from(value)].registered {
                    return false;
                }
                *id = value;
            }
            if sections.insert(pos, blocks).is_some() {
                return false;
            }
        }
        for _ in 0..tick_count {
            let Some(position) = reader.position() else {
                return false;
            };
            let Some(group) = reader.u16() else {
                return false;
            };
            let Some(delay) = reader.u8() else {
                return false;
            };
            let Some(priority) = reader.u8() else {
                return false;
            };
            let priority = priority as i8;
            let Some(order) = reader.u64() else {
                return false;
            };
            if !(-3..=3).contains(&priority)
                || order == u64::MAX
                || !sections.contains_key(&section(position).0)
                || !scheduler.queued.insert((position, group))
            {
                return false;
            }
            scheduler.queue[usize::from(delay)].push(Tick {
                position,
                group,
                priority,
                order,
            });
            scheduler.order = scheduler.order.max(order + 1);
        }
        if reader.offset != length {
            return false;
        }
        self.sections = sections;
        self.scheduler = scheduler;
        self.min_y = min_y;
        self.height = height;
        self.age = age;
        self.daytime = daytime;
        self.daylight = daylight != 0;
        self.changes.clear();
        self.events.clear();
        true
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let bytes = self
            .bytes
            .get(self.offset..self.offset.checked_add(count)?)?;
        self.offset += count;
        Some(bytes)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(*self.take(1)?.first()?)
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn i64(&mut self) -> Option<i64> {
        Some(i64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn position(&mut self) -> Option<Position> {
        Some([self.i32()?, self.i32()?, self.i32()?])
    }
}
fn valid_bounds(min_y: i32, height: i32) -> bool {
    min_y % 16 == 0
        && height > 0
        && height <= 4096
        && height % 16 == 0
        && min_y.checked_add(height).is_some()
}
static AUTHORITY: Mutex<Option<Authority>> = Mutex::new(None);
fn authority() -> MutexGuard<'static, Option<Authority>> {
    AUTHORITY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn with_authority<T>(f: impl FnOnce(&mut Authority) -> T) -> T {
    let mut guard = authority();
    f(guard.get_or_insert_with(Authority::default))
}
#[no_mangle]
pub extern "C" fn authority_reset(min_y: i32, height: i32) -> u32 {
    if !valid_bounds(min_y, height) {
        return 0;
    }
    with_authority(|world| {
        world.sections.clear();
        world.changes.clear();
        world.scheduler = Scheduler::default();
        world.min_y = min_y;
        world.height = height;
        world.age = 0;
        world.daytime = 0;
        world.daylight = true;
        world.events.clear();
        1
    })
}
#[no_mangle]
pub extern "C" fn authority_register(
    id: u32,
    group: u32,
    kind: u32,
    flags: u32,
    counterpart: u32,
    direction: u32,
) -> u32 {
    if id > 65535 || group > 65535 || kind > 5 || flags > 3 || counterpart > 65535 || direction > 5
    {
        return 0;
    }
    with_authority(|world| {
        world.states[id as usize] = State {
            registered: true,
            group: group as u16,
            kind: kind as u8,
            active: flags & 2 != 0,
            solid: flags & 1 != 0,
            counterpart: counterpart as u16,
            direction: direction as u8,
        };
        1
    })
}
#[no_mangle]
pub extern "C" fn authority_stage_ptr() -> *mut u16 {
    with_authority(|world| world.staging.as_mut_ptr())
}
#[no_mangle]
pub extern "C" fn authority_load_section(x: i32, y: i32, z: i32) -> u32 {
    with_authority(|world| {
        if y < world.min_y / 16
            || y >= (world.min_y + world.height) / 16
            || (!world.sections.contains_key(&[x, y, z]) && world.sections.len() >= MAX_SECTIONS)
            || world
                .staging
                .iter()
                .any(|&id| !world.states[usize::from(id)].registered)
        {
            return 0;
        }
        world.sections.insert([x, y, z], world.staging.clone());
        1
    })
}
#[no_mangle]
pub extern "C" fn authority_block_get(x: i32, y: i32, z: i32) -> u32 {
    with_authority(|world| world.get([x, y, z]).map_or(u32::MAX, u32::from))
}
#[no_mangle]
pub extern "C" fn authority_block_set(x: i32, y: i32, z: i32, id: u32) -> u32 {
    if id > 65535 {
        return 0;
    }
    with_authority(|world| {
        u32::from(
            world.mutation_capacity()
                && world.set([x, y, z], id as u16)
                && world.notify([x, y, z])
                && world.update_lamp([x, y, z]),
        )
    })
}
#[no_mangle]
pub extern "C" fn authority_use_block(x: i32, y: i32, z: i32) -> u32 {
    with_authority(|world| u32::from(world.interact([x, y, z])))
}
#[no_mangle]
pub extern "C" fn authority_can_use_block(x: i32, y: i32, z: i32) -> u32 {
    with_authority(|world| u32::from((1..=3).contains(&world.descriptor([x, y, z]).kind)))
}
#[no_mangle]
pub extern "C" fn authority_tick(count: u32) -> u32 {
    if count > 1000 {
        return 0;
    }
    with_authority(|world| u32::from((0..count).all(|_| world.tick())))
}
#[no_mangle]
pub extern "C" fn authority_world_age() -> i64 {
    with_authority(|world| world.age)
}
#[no_mangle]
pub extern "C" fn authority_daytime() -> i64 {
    with_authority(|world| world.daytime)
}
#[no_mangle]
pub extern "C" fn authority_set_time(time: i64, daylight: u32) {
    with_authority(|world| {
        world.daytime = time;
        world.daylight = daylight != 0;
    })
}
#[no_mangle]
pub extern "C" fn authority_pending_ticks() -> u32 {
    with_authority(|world| world.scheduler.queued.len() as u32)
}
#[no_mangle]
pub extern "C" fn authority_section_count() -> u32 {
    with_authority(|world| world.sections.len() as u32)
}
#[no_mangle]
pub extern "C" fn authority_drain_events() -> u32 {
    with_authority(|world| {
        world.events.clear();
        for (position, id) in std::mem::take(&mut world.changes) {
            world
                .events
                .extend_from_slice(&[position[0], position[1], position[2], i32::from(id)]);
        }
        (world.events.len() / 4) as u32
    })
}
#[no_mangle]
pub extern "C" fn authority_events_ptr() -> *const i32 {
    with_authority(|world| world.events.as_ptr())
}
#[no_mangle]
pub extern "C" fn authority_snapshot() -> u32 {
    with_authority(|world| {
        world.bytes = world.snapshot();
        world.bytes.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn authority_snapshot_ptr() -> *const u8 {
    with_authority(|world| world.bytes.as_ptr())
}
#[no_mangle]
pub extern "C" fn authority_restore_ptr() -> *mut u8 {
    with_authority(|world| world.input.as_mut_ptr())
}
#[no_mangle]
pub extern "C" fn authority_restore(length: u32) -> u32 {
    with_authority(|world| u32::from(world.restore(length as usize)))
}
#[no_mangle]
pub extern "C" fn authority_section_keys() -> u32 {
    with_authority(|world| {
        world.events.clear();
        for position in world.sections.keys() {
            world.events.extend_from_slice(position);
        }
        world.sections.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn authority_column_keys(x: i32, z: i32) -> u32 {
    with_authority(|world| {
        world.events.clear();
        for position in world.sections.keys() {
            if position[0] == x && position[2] == z {
                world.events.push(position[1]);
            }
        }
        world.events.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn authority_read_section(x: i32, y: i32, z: i32) -> u32 {
    with_authority(|world| {
        let Some(blocks) = world.sections.get(&[x, y, z]) else {
            return 0;
        };
        world.staging.copy_from_slice(blocks.as_slice());
        1
    })
}

#[cfg(test)]
mod scheduler_tests {
    use super::Scheduler;
    #[test]
    fn tick_priority_then_insertion_order_is_preserved() {
        let mut scheduler = Scheduler::default();
        scheduler.schedule([0, 0, 0], 1, 1, 0);
        scheduler.schedule([1, 0, 0], 1, 1, -3);
        scheduler.schedule([2, 0, 0], 1, 1, 0);
        let positions: Vec<_> = scheduler
            .step()
            .into_iter()
            .map(|tick| tick.position)
            .collect();
        assert_eq!(positions, vec![[1, 0, 0], [0, 0, 0], [2, 0, 0]]);
        assert!(scheduler.queued.is_empty());
    }
    #[test]
    fn repeated_schedule_keeps_earlier_due_tick_per_position_and_block() {
        let mut scheduler = Scheduler::default();
        scheduler.schedule([0, 0, 0], 1, 3, 0);
        assert!(scheduler.step().is_empty());
        scheduler.schedule([0, 0, 0], 1, 5, 0);
        scheduler.schedule([0, 0, 0], 2, 1, 0);
        assert_eq!(scheduler.step().len(), 1);
        let due = scheduler.step();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].group, 1);
        assert!(scheduler.step().is_empty());
    }
}
