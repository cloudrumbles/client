//! Native AbstractContainerMenu input transactions for ordinary item storage.
//! Slot indices are the original InventoryMenu/CraftingMenu indices. Equipment
//! defaults are supplied from verified native item data; effect/world authority
//! is separate from creative menu storage.
use super::{with_inventory, Inventory, Stack, State, EMPTY, MAX_ITEMS};

#[derive(Clone)]
pub(super) struct Drag {
    status: u32,
    kind: u32,
    slots: [bool; 46],
}
impl Default for Drag {
    fn default() -> Self {
        Self {
            status: 0,
            kind: 0,
            slots: [false; 46],
        }
    }
}

// Ephemeral menu input is deliberately separate from saved inventory slots.
// Durable reopen cancels QUICK_CRAFT; an aborted transaction must retain it.
#[no_mangle]
pub extern "C" fn inventory_transient_snapshot() -> u32 {
    with_inventory(|inventory| {
        inventory.output = vec![1, inventory.drag.status, inventory.drag.kind];
        inventory.output.extend(inventory.drag.slots.map(u32::from));
        inventory.output.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn inventory_transient_restore(count: u32) -> u32 {
    with_inventory(|inventory| {
        if count != 49 {
            return 0;
        }
        let words = &inventory.staging[..count as usize];
        if words[0] != 1
            || words[1] > 1
            || words[2] > 2
            || words[3..].iter().any(|&word| word > 1)
            || words[1] == 0 && words[2..].iter().any(|&word| word != 0)
        {
            return 0;
        }
        let mut slots = [false; 46];
        for (slot, &word) in slots.iter_mut().zip(&words[3..]) {
            *slot = word != 0;
        }
        inventory.drag = Drag {
            status: words[1],
            kind: words[2],
            slots,
        };
        1
    })
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    Result,
    Grid(usize),
    Player(usize),
}
impl Inventory {
    fn menu_slot(state: &State, index: usize) -> Option<Slot> {
        match (state.width, index) {
            (_, 0) => Some(Slot::Result),
            (2, 1..=4) | (3, 1..=9) => Some(Slot::Grid(index - 1)),
            (2, 5..=8) => Some(Slot::Player(44 - index)),
            (2, 9..=35) => Some(Slot::Player(index)),
            (2, 36..=44) => Some(Slot::Player(index - 36)),
            (2, 45) => Some(Slot::Player(40)),
            (3, 10..=36) => Some(Slot::Player(index - 1)),
            (3, 37..=45) => Some(Slot::Player(index - 37)),
            _ => None,
        }
    }
    fn menu_get(&self, state: &State, slot: Slot) -> Stack {
        match slot {
            Slot::Result => self.find(state).map_or(EMPTY, |recipe| recipe.output),
            Slot::Grid(index) => state.grid[index],
            Slot::Player(index) => state.player[index],
        }
    }
    fn menu_set(state: &mut State, slot: Slot, stack: Stack) {
        match slot {
            Slot::Grid(index) => state.grid[index] = stack,
            Slot::Player(index) => state.player[index] = stack,
            Slot::Result => {}
        }
    }
    fn menu_limit(slot: Slot, stack: Stack) -> u32 {
        if matches!(slot, Slot::Player(36..=39)) {
            1
        } else {
            stack.limit
        }
    }
    fn menu_place(&self, slot: Slot, stack: Stack) -> bool {
        match slot {
            Slot::Result => false,
            Slot::Player(index @ 36..=39) => {
                self.items[stack.item as usize].equipment == (index - 35) as u32
            }
            _ => true,
        }
    }
    fn menu_remove(
        &self,
        state: &mut State,
        slot: Slot,
        count: u32,
        capacity: u32,
    ) -> Option<Stack> {
        let existing = self.menu_get(state, slot);
        if existing.count == 0 || matches!(slot, Slot::Result) && capacity < existing.count {
            return Some(EMPTY);
        }
        if matches!(slot, Slot::Result) {
            // ResultContainer.removeItem ignores the requested count. Native
            // ResultSlot.onTake then consumes one input per occupied grid cell.
            if !self.consume(state) {
                return None;
            }
            return Some(existing);
        }
        let take = count.min(capacity).min(existing.count);
        Self::menu_set(state, slot, existing.with_count(existing.count - take));
        Some(existing.with_count(take))
    }
    fn menu_pickup(&self, state: &mut State, index: i32, button: u32) -> bool {
        if button > 1 {
            return true;
        }
        if index == -999 {
            let count = state
                .cursor
                .count
                .min(if button == 1 { 1 } else { u32::MAX });
            let dropped = state.cursor.with_count(count);
            if !Self::drop(state, dropped) {
                return false;
            }
            state.cursor = state.cursor.with_count(state.cursor.count - count);
            return true;
        }
        let Some(slot) = usize::try_from(index)
            .ok()
            .and_then(|index| Self::menu_slot(state, index))
        else {
            return true;
        };
        let existing = self.menu_get(state, slot);
        let cursor = state.cursor;
        if existing.count == 0 {
            if cursor.count > 0 && self.menu_place(slot, cursor) {
                let take = cursor
                    .count
                    .min(Self::menu_limit(slot, cursor))
                    .min(if button == 1 { 1 } else { u32::MAX });
                Self::menu_set(state, slot, cursor.with_count(take));
                state.cursor = cursor.with_count(cursor.count - take);
            }
        } else if cursor.count == 0 {
            let count = if button == 1 {
                existing.count.div_ceil(2)
            } else {
                existing.count
            };
            let Some(removed) = self.menu_remove(state, slot, count, u32::MAX) else {
                return false;
            };
            state.cursor = removed;
        } else if self.menu_place(slot, cursor) {
            if existing.same(cursor) {
                let take = cursor
                    .count
                    .min(Self::menu_limit(slot, cursor).saturating_sub(existing.count))
                    .min(if button == 1 { 1 } else { u32::MAX });
                Self::menu_set(state, slot, existing.with_count(existing.count + take));
                state.cursor = cursor.with_count(cursor.count - take);
            } else if cursor.count <= Self::menu_limit(slot, cursor) {
                Self::menu_set(state, slot, cursor);
                state.cursor = existing;
            }
        } else if existing.same(cursor) {
            let Some(removed) = self.menu_remove(
                state,
                slot,
                existing.count,
                cursor.limit.saturating_sub(cursor.count),
            ) else {
                return false;
            };
            state.cursor = cursor.with_count(cursor.count + removed.count);
        }
        true
    }
    fn menu_move(
        &self,
        state: &mut State,
        stack: &mut Stack,
        start: usize,
        end: usize,
        reverse: bool,
    ) -> bool {
        let indices: Vec<_> = if reverse {
            (start..end).rev().collect()
        } else {
            (start..end).collect()
        };
        let before = stack.count;
        if stack.limit > 1 {
            for &index in &indices {
                let Some(slot) = Self::menu_slot(state, index) else {
                    continue;
                };
                let current = self.menu_get(state, slot);
                if current.same(*stack) {
                    let count = stack
                        .count
                        .min(Self::menu_limit(slot, current).saturating_sub(current.count));
                    Self::menu_set(state, slot, current.with_count(current.count + count));
                    *stack = stack.with_count(stack.count - count);
                    if stack.count == 0 {
                        break;
                    }
                }
            }
        }
        if stack.count > 0 {
            for index in indices {
                let Some(slot) = Self::menu_slot(state, index) else {
                    continue;
                };
                if self.menu_get(state, slot).count == 0 && self.menu_place(slot, *stack) {
                    let count = stack.count.min(Self::menu_limit(slot, *stack));
                    Self::menu_set(state, slot, stack.with_count(count));
                    *stack = stack.with_count(stack.count - count);
                    break;
                }
            }
        }
        before != stack.count
    }
    fn menu_quick_move(&self, state: &mut State, index: usize) -> bool {
        let Some(slot) = Self::menu_slot(state, index) else {
            return true;
        };
        // Every valid input count is <=99. Each ordinary iteration must move
        // >=1, while a recipe iteration consumes >=1 from a nonempty input.
        for _ in 0..99 {
            let before = self.menu_get(state, slot);
            if before.count == 0 {
                return true;
            }
            let mut stack = before;
            let moved = if index == 0 {
                let start = if state.width == 2 { 9 } else { 10 };
                let end = if state.width == 2 { 45 } else { 46 };
                self.menu_move(state, &mut stack, start, end, true)
            } else if state.width == 3 {
                if index >= 10 {
                    self.menu_move(state, &mut stack, 1, 10, false)
                        || if index < 37 {
                            self.menu_move(state, &mut stack, 37, 46, false)
                        } else {
                            self.menu_move(state, &mut stack, 10, 37, false)
                        }
                } else {
                    self.menu_move(state, &mut stack, 10, 46, false)
                }
            } else if index < 9 {
                self.menu_move(state, &mut stack, 9, 45, false)
            } else {
                let equipment = self.items[stack.item as usize].equipment as usize;
                let target = if (1..=4).contains(&equipment) {
                    Some(9 - equipment)
                } else if equipment == 5 {
                    Some(45)
                } else {
                    None
                };
                if let Some(target) = target.filter(|&target| {
                    Self::menu_slot(state, target)
                        .is_some_and(|slot| self.menu_get(state, slot).count == 0)
                }) {
                    self.menu_move(state, &mut stack, target, target + 1, false)
                } else if index < 36 {
                    self.menu_move(state, &mut stack, 36, 45, false)
                } else if index < 45 {
                    self.menu_move(state, &mut stack, 9, 36, false)
                } else {
                    self.menu_move(state, &mut stack, 9, 45, false)
                }
            };
            if !moved {
                return true;
            }
            if slot == Slot::Result {
                if !self.consume(state) || !Self::drop(state, stack) {
                    return false;
                }
            } else {
                Self::menu_set(state, slot, stack);
            }
            let refreshed = self.menu_get(state, slot);
            if refreshed.count == 0 || refreshed.item != before.item {
                return true;
            }
        }
        true
    }
    fn menu_swap(&self, state: &mut State, index: usize, button: u32, creative: bool) -> bool {
        if button > 8 && button != 40 {
            return true;
        }
        let Some(slot) = Self::menu_slot(state, index) else {
            return true;
        };
        if slot == Slot::Player(button as usize) {
            return true;
        }
        let hotbar = state.player[button as usize];
        let existing = self.menu_get(state, slot);
        if hotbar.count == 0 {
            if existing.count > 0 {
                let Some(removed) = self.menu_remove(state, slot, existing.count, u32::MAX) else {
                    return false;
                };
                state.player[button as usize] = removed;
            }
        } else if self.menu_place(slot, hotbar) {
            let take = hotbar.count.min(Self::menu_limit(slot, hotbar));
            Self::menu_set(state, slot, hotbar.with_count(take));
            if hotbar.count > take {
                state.player[button as usize] = hotbar.with_count(hotbar.count - take);
                let mut displaced = existing;
                Self::add_player(state, &mut displaced);
                // Inventory.add consumes unplaceable leftovers for players
                // with infinite materials; survival instead returns them for
                // the enclosing menu's explicit player.drop call.
                if creative {
                    displaced = EMPTY;
                }
                if !Self::drop(state, displaced) {
                    return false;
                }
            } else {
                state.player[button as usize] = existing;
            }
        }
        true
    }
    fn menu_collect(&self, state: &mut State, index: usize, button: u32) -> bool {
        let Some(clicked) = Self::menu_slot(state, index) else {
            return true;
        };
        if state.cursor.count == 0 || self.menu_get(state, clicked).count > 0 {
            return true;
        }
        let indices: Vec<_> = if button == 0 {
            (1..46).collect()
        } else {
            (1..46).rev().collect()
        };
        for pass in 0..2 {
            for &index in &indices {
                if state.cursor.count >= state.cursor.limit {
                    return true;
                }
                let Some(slot) = Self::menu_slot(state, index) else {
                    continue;
                };
                let current = self.menu_get(state, slot);
                if current.same(state.cursor)
                    && (pass != 0 || current.count != current.limit)
                    && current.count <= state.cursor.limit
                {
                    let Some(taken) = self.menu_remove(
                        state,
                        slot,
                        current.count,
                        state.cursor.limit - state.cursor.count,
                    ) else {
                        return false;
                    };
                    state.cursor = state.cursor.with_count(state.cursor.count + taken.count);
                }
            }
        }
        true
    }
    fn menu_drag(
        &self,
        state: &mut State,
        drag: &mut Drag,
        index: i32,
        button: u32,
        creative: bool,
    ) -> bool {
        let header = button & 3;
        if !(drag.status == 1 && header == 2 || drag.status == header) || state.cursor.count == 0 {
            *drag = Drag::default();
            return true;
        }
        match header {
            0 => {
                let kind = button >> 2 & 3;
                *drag = Drag::default();
                if kind < 2 || kind == 2 && creative {
                    drag.status = 1;
                    drag.kind = kind;
                }
            }
            1 => {
                let Some(index) = usize::try_from(index).ok().filter(|&index| index < 46) else {
                    *drag = Drag::default();
                    return true;
                };
                let Some(slot) = Self::menu_slot(state, index) else {
                    return true;
                };
                let count = drag.slots.iter().filter(|&&selected| selected).count() as u32;
                let current = self.menu_get(state, slot);
                if self.menu_place(slot, state.cursor)
                    && (current.count == 0
                        || current.same(state.cursor) && current.count <= state.cursor.limit)
                    && (drag.kind == 2 || state.cursor.count > count)
                {
                    drag.slots[index] = true;
                }
            }
            2 => {
                let count = drag.slots.iter().filter(|&&selected| selected).count() as u32;
                let kind = drag.kind;
                if count == 1 {
                    let target = drag.slots.iter().position(|&selected| selected);
                    *drag = Drag::default();
                    if let Some(target) = target {
                        return self.menu_pickup(state, target as i32, kind);
                    }
                    return true;
                }
                let cursor = state.cursor;
                let share = match kind {
                    0 if count > 0 => cursor.count / count,
                    1 => 1,
                    2 => cursor.limit,
                    _ => 0,
                };
                let mut remaining = i64::from(cursor.count);
                for (index, &selected) in drag.slots.iter().enumerate() {
                    if !selected {
                        continue;
                    }
                    let Some(slot) = Self::menu_slot(state, index) else {
                        continue;
                    };
                    let current = self.menu_get(state, slot);
                    if self.menu_place(slot, cursor)
                        && (current.count == 0
                            || current.same(cursor) && current.count <= cursor.limit)
                        && (kind == 2 || cursor.count >= count)
                    {
                        let next = (current.count + share).min(Self::menu_limit(slot, cursor));
                        remaining -= i64::from(next) - i64::from(current.count);
                        Self::menu_set(state, slot, cursor.with_count(next));
                    }
                }
                state.cursor = cursor.with_count(remaining.max(0) as u32);
                *drag = Drag::default();
            }
            _ => *drag = Drag::default(),
        }
        true
    }
    fn menu_click(
        &mut self,
        index: i32,
        button: u32,
        mode: u32,
        creative: bool,
        modern: bool,
        allow_drops: bool,
    ) -> i32 {
        if mode > 6 || button > 40 || index != -999 && !(0..46).contains(&index) {
            return -1;
        }
        let mut next = self.state.clone();
        let mut drag = self.drag.clone();
        let accepted = if mode == 5 {
            self.menu_drag(&mut next, &mut drag, index, button, creative)
        } else if drag.status != 0 {
            drag = Drag::default();
            true
        } else {
            let slot = usize::try_from(index)
                .ok()
                .and_then(|index| Self::menu_slot(&next, index));
            match mode {
                0 => self.menu_pickup(&mut next, index, button),
                1 if button < 2 && index == -999 => self.menu_pickup(&mut next, index, button),
                1 if button < 2 && index >= 0 => self.menu_quick_move(&mut next, index as usize),
                2 if index >= 0 => self.menu_swap(&mut next, index as usize, button, creative),
                3 if creative && next.cursor.count == 0 => {
                    if let Some(slot) = slot {
                        let stack = self.menu_get(&next, slot);
                        next.cursor = stack.with_count(stack.limit);
                    }
                    true
                }
                4 if next.cursor.count == 0 => {
                    if let Some(slot) = slot {
                        let first = self.menu_get(&next, slot);
                        let count = if button == 0 { 1 } else { first.count };
                        let mut valid = true;
                        for _ in 0..99 {
                            let Some(taken) = self.menu_remove(&mut next, slot, count, u32::MAX)
                            else {
                                valid = false;
                                break;
                            };
                            if !Self::drop(&mut next, taken) {
                                valid = false;
                                break;
                            }
                            let refreshed = self.menu_get(&next, slot);
                            if button != 1
                                || !modern
                                || taken.count == 0
                                || refreshed.count == 0
                                || refreshed.item != first.item
                            {
                                break;
                            }
                        }
                        valid
                    } else {
                        true
                    }
                }
                6 if index >= 0 => self.menu_collect(&mut next, index as usize, button),
                _ => true,
            }
        };
        // Production has no world item-entity consumer yet. An operation which
        // would transfer any stack to drops must reject atomically when gated.
        if !accepted || !allow_drops && next.drops.len() != self.state.drops.len() {
            return -2;
        }
        if next != self.state {
            next.revision = next.revision.wrapping_add(1);
            self.state = next;
        }
        self.drag = drag;
        1
    }
}

#[no_mangle]
pub extern "C" fn inventory_item_equipment(item: u32, equipment: u32) -> u32 {
    if item as usize >= MAX_ITEMS || equipment > 5 {
        return 0;
    }
    with_inventory(|inventory| {
        if !inventory.items[item as usize].registered {
            return 0;
        }
        inventory.items[item as usize].equipment = equipment;
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_menu_click(index: i32, button: u32, mode: u32, flags: u32) -> i32 {
    if flags & !7 != 0 {
        return -1;
    }
    with_inventory(|inventory| {
        inventory.menu_click(
            index,
            button,
            mode,
            flags & 1 != 0,
            flags & 2 != 0,
            flags & 4 != 0,
        )
    })
}
