// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Adapted from latest Sodium ArrayLightDataCache at:
// 8aa723c69af6ce40255862df6c3bf8c6cca9d883.
// Original Sodium authors/contributors and notices: ../third_party/sodium/NOTICE.
// Changes: portable Rust; independently cached render/physical states and native
// light nibbles; checked coordinates; no JVM, world access, or AO policy here.

use std::cell::Cell;

const NEIGHBOR_BLOCK_RADIUS: i32 = 2;
const BLOCK_LENGTH: usize = 16 + NEIGHBOR_BLOCK_RADIUS as usize * 2;
pub(crate) const SAMPLE_COUNT: usize = BLOCK_LENGTH * BLOCK_LENGTH * BLOCK_LENGTH;
const STATES_PRESENT: u64 = 1 << 32;
const LIGHT_PRESENT: u64 = 1 << 48;

#[derive(Clone, Default)]
pub(crate) struct MeshSampleCache {
    words: Vec<Cell<u64>>,
    offset: [i32; 3],
    active: bool,
}

impl MeshSampleCache {
    pub(crate) fn reset(&mut self, origin: [i32; 3]) {
        self.disable();
        let [Some(x), Some(y), Some(z)] =
            origin.map(|coordinate| coordinate.checked_sub(NEIGHBOR_BLOCK_RADIUS))
        else {
            return;
        };
        self.offset = [x, y, z];
        self.words.resize_with(SAMPLE_COUNT, || Cell::new(0));
        for word in &self.words {
            word.set(0);
        }
        self.active = true;
    }

    pub(crate) fn disable(&mut self) {
        self.active = false;
    }

    #[inline]
    pub(crate) fn active(&self) -> bool {
        self.active
    }

    #[inline]
    fn slot(&self, position: [i32; 3]) -> Option<&Cell<u64>> {
        if !self.active {
            return None;
        }
        let coordinates =
            std::array::from_fn::<_, 3, _>(|axis| position[axis] as i64 - self.offset[axis] as i64);
        if coordinates
            .iter()
            .any(|&coordinate| coordinate < 0 || coordinate >= BLOCK_LENGTH as i64)
        {
            return None;
        }
        let [x, y, z] = coordinates.map(|coordinate| coordinate as usize);
        Some(&self.words[(z * BLOCK_LENGTH * BLOCK_LENGTH) + (y * BLOCK_LENGTH) + x])
    }

    #[inline]
    pub(crate) fn states(
        &self,
        position: [i32; 3],
        compute: impl FnOnce() -> (u16, u16),
    ) -> (u16, u16) {
        let Some(slot) = self.slot(position) else {
            return compute();
        };
        let word = slot.get();
        if word & STATES_PRESENT != 0 {
            return (word as u16, (word >> 16) as u16);
        }
        let (physical, render) = compute();
        slot.set(word | STATES_PRESENT | u64::from(physical) | (u64::from(render) << 16));
        (physical, render)
    }

    #[inline]
    pub(crate) fn light(&self, position: [i32; 3], compute: impl FnOnce() -> (u8, u8)) -> (u8, u8) {
        let Some(slot) = self.slot(position) else {
            return compute();
        };
        let word = slot.get();
        if word & LIGHT_PRESENT != 0 {
            return (((word >> 40) & 15) as u8, ((word >> 44) & 15) as u8);
        }
        let (sky, block) = compute();
        // Computing light can populate the physical/render state in this slot.
        // Preserve that new word rather than overwriting it with the old read.
        slot.set(
            slot.get()
                | LIGHT_PRESENT
                | (u64::from(sky & 15) << 40)
                | (u64::from(block & 15) << 44),
        );
        (sky, block)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_and_maximum_state_ids_and_dark_light_are_cached_and_reset() {
        let mut cache = MeshSampleCache::default();
        cache.reset([-32, -64, 48]);
        let position = [-33, -65, 47];
        let mut computes = 0;
        assert_eq!(
            cache.states(position, || {
                computes += 1;
                (0, u16::MAX)
            }),
            (0, u16::MAX)
        );
        assert_eq!(
            cache.states(position, || {
                computes += 1;
                (12, 13)
            }),
            (0, u16::MAX)
        );
        assert_eq!(computes, 1);
        assert_eq!(cache.light(position, || (0, 0)), (0, 0));
        assert_eq!(cache.light(position, || (15, 15)), (0, 0));
        let pointer = cache.words.as_ptr();
        cache.reset([-32, -64, 48]);
        assert_eq!(cache.words.as_ptr(), pointer);
        assert_eq!(cache.words.len() * std::mem::size_of::<Cell<u64>>(), 64000);
        assert_eq!(cache.states(position, || (12, 13)), (12, 13));
        assert_eq!(cache.light(position, || (2, 15)), (2, 15));
        cache.disable();
        assert_eq!(cache.states(position, || (90, 91)), (90, 91));
    }

    #[test]
    fn neighboring_section_and_extreme_positions_never_alias_or_overflow() {
        let mut cache = MeshSampleCache::default();
        cache.reset([i32::MAX - 32, i32::MIN + 32, i32::MAX - 32]);
        let p = [i32::MAX - 16, i32::MIN + 31, i32::MAX - 33];
        assert_eq!(cache.states(p, || (4, 5)), (4, 5));
        assert_eq!(cache.states(p, || (8, 9)), (4, 5));
        assert_eq!(cache.states([i32::MIN, i32::MAX, 0], || (8, 9)), (8, 9));
        cache.reset([i32::MIN, 0, 0]);
        assert!(!cache.active);
    }

    #[test]
    fn light_miss_keeps_physical_and_visual_state_computed_by_its_callback() {
        let mut cache = MeshSampleCache::default();
        cache.reset([0, 0, 0]);
        assert_eq!(
            cache.light([1, 1, 1], || {
                cache.states([1, 1, 1], || (7, 12));
                (15, 9)
            }),
            (15, 9)
        );
        assert_eq!(cache.states([1, 1, 1], || (0, 0)), (7, 12));
    }
}
