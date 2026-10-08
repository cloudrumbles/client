//! Atomic Inventory.add pickup and prefix-acknowledgment primitives. Durable
//! actor/inventory commit is the worker's single IndexedDB record transaction.
use super::{with_inventory, Inventory, EMPTY};

impl Inventory {
    fn pickup(&mut self, words: &[u32], creative: bool, damaged: bool) -> i32 {
        let Some(mut stack) = self.stack(words) else {
            return -1;
        };
        let mut next = self.state.clone();
        if damaged && stack.count > 0 {
            // Native Inventory.add's damaged branch copies the entire stack
            // into the first ordinary empty slot, without stack splitting.
            if let Some(index) = next.player[..36].iter().position(|slot| slot.count == 0) {
                next.player[index] = stack;
                stack = EMPTY;
            }
        } else {
            Self::add_player(&mut next, &mut stack);
        }
        if creative {
            stack = EMPTY;
        }
        if next != self.state {
            next.revision = next.revision.wrapping_add(1);
            self.state = next;
        }
        stack.count as i32
    }
}

#[no_mangle]
pub extern "C" fn inventory_pickup(
    item: u32,
    count: u32,
    components: u32,
    limit: u32,
    flags: u32,
) -> i32 {
    if flags & !3 != 0 {
        return -1;
    }
    with_inventory(|inventory| {
        inventory.pickup(
            &[item, count, components, limit],
            flags & 1 != 0,
            flags & 2 != 0,
        )
    })
}

#[no_mangle]
pub extern "C" fn inventory_ack_drops_prefix(count: u32, expected_revision: u32) -> u32 {
    with_inventory(|inventory| {
        if inventory.state.revision != expected_revision
            || count as usize > inventory.state.drops.len()
        {
            return 0;
        }
        if count > 0 {
            inventory.state.drops.drain(..count as usize);
            inventory.state.revision = inventory.state.revision.wrapping_add(1);
        }
        1
    })
}
