//! Portable shaped/shapeless crafting and stack transactions. Native recipe,
//! item and remainder data are registered by the caller; no item IDs are assumed.
use std::collections::BTreeMap;
use std::sync::Mutex;
mod menu;
mod transfer;

const MAX_ITEMS: usize = 65536;
const MAX_RECIPES: usize = 8192;
const MAX_MEMBERS: usize = 262144;
const MAX_DROPS: usize = 64;
const MAX_COMPONENTS: u32 = 4095;
const STAGE_WORDS: usize = 65536;
const EMPTY: Stack = Stack {
    item: 0,
    count: 0,
    components: 0,
    limit: 0,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stack {
    item: u32,
    count: u32,
    components: u32,
    limit: u32,
}
impl Stack {
    fn same(self, other: Self) -> bool {
        self.count > 0
            && other.count > 0
            && self.item == other.item
            && self.components == other.components
    }
    fn with_count(self, count: u32) -> Self {
        if count == 0 {
            EMPTY
        } else {
            Self { count, ..self }
        }
    }
    fn words(self) -> [u32; 4] {
        [self.item, self.count, self.components, self.limit]
    }
}
#[derive(Clone, Copy, Default)]
struct Item {
    registered: bool,
    limit: u32,
    remainder: Option<u32>,
    equipment: u32,
}
struct Recipe {
    key: u32,
    width: usize,
    height: usize,
    shaped: bool,
    ingredients: Vec<Vec<u32>>,
    output: Stack,
}
#[derive(Clone, PartialEq, Eq)]
struct State {
    width: usize,
    height: usize,
    selected: usize,
    revision: u32,
    grid: [Stack; 9],
    player: [Stack; 41],
    cursor: Stack,
    drops: Vec<Stack>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            width: 2,
            height: 2,
            selected: 0,
            revision: 0,
            grid: [EMPTY; 9],
            player: [EMPTY; 41],
            cursor: EMPTY,
            drops: Vec::new(),
        }
    }
}
struct Inventory {
    air: u32,
    items: Vec<Item>,
    recipes: Vec<Recipe>,
    keys: BTreeMap<u32, usize>,
    members: usize,
    state: State,
    staging: Vec<u32>,
    output: Vec<u32>,
    drag: menu::Drag,
}
impl Default for Inventory {
    fn default() -> Self {
        Self {
            air: u32::MAX,
            items: vec![Item::default(); MAX_ITEMS],
            recipes: Vec::new(),
            keys: BTreeMap::new(),
            members: 0,
            state: State::default(),
            staging: vec![0; STAGE_WORDS],
            output: Vec::new(),
            drag: menu::Drag::default(),
        }
    }
}
impl Inventory {
    fn stack(&self, words: &[u32]) -> Option<Stack> {
        let &[item, count, components, limit] = words else {
            return None;
        };
        if count == 0 || item == self.air {
            return Some(EMPTY);
        }
        if item as usize >= MAX_ITEMS
            || !self.items[item as usize].registered
            || count > 99
            || components > MAX_COMPONENTS
            || !(1..=99).contains(&limit)
        {
            return None;
        }
        Some(Stack {
            item,
            count,
            components,
            limit,
        })
    }
    fn register_recipe(&mut self, count: usize) -> bool {
        if !(10..=STAGE_WORDS).contains(&count) || self.recipes.len() >= MAX_RECIPES {
            return false;
        }
        let data = &self.staging[..count];
        let (kind, width, height, key) = (data[0], data[1] as usize, data[2] as usize, data[3]);
        let Some(output) = self.stack(&data[4..8]) else {
            return false;
        };
        let n = data[8] as usize;
        if !(1..=2).contains(&kind)
            || output.count == 0
            || key == u32::MAX
            || self.keys.contains_key(&key)
            || !(1..=9).contains(&n)
            || !(1..=3).contains(&width)
            || !(1..=3).contains(&height)
            || kind == 1 && n != width * height
        {
            return false;
        }
        let mut offset = 9;
        let mut ingredients = Vec::with_capacity(n);
        let mut members = 0;
        for _ in 0..n {
            let Some(&length) = data.get(offset) else {
                return false;
            };
            offset += 1;
            let length = length as usize;
            if length > 4096 || kind == 2 && length == 0 {
                return false;
            }
            let Some(ids) = data.get(offset..offset + length) else {
                return false;
            };
            if ids
                .iter()
                .any(|id| *id as usize >= MAX_ITEMS || !self.items[*id as usize].registered)
            {
                return false;
            }
            let mut ids = ids.to_vec();
            ids.sort_unstable();
            ids.dedup();
            members += ids.len();
            ingredients.push(ids);
            offset += length;
        }
        if offset != count
            || self.members + members > MAX_MEMBERS
            || ingredients.iter().all(Vec::is_empty)
        {
            return false;
        }
        self.members += members;
        self.keys.insert(key, self.recipes.len());
        self.recipes.push(Recipe {
            key,
            width,
            height,
            shaped: kind == 1,
            ingredients,
            output,
        });
        true
    }
    fn find(&self, state: &State) -> Option<&Recipe> {
        let mut left = state.width;
        let mut right = 0;
        let mut top = state.height;
        let mut bottom = 0;
        let mut occupied = Vec::with_capacity(9);
        for y in 0..state.height {
            for x in 0..state.width {
                let stack = state.grid[y * state.width + x];
                if stack.count > 0 {
                    left = left.min(x);
                    right = right.max(x);
                    top = top.min(y);
                    bottom = bottom.max(y);
                    occupied.push(stack.item);
                }
            }
        }
        if occupied.is_empty() {
            return None;
        }
        let width = right - left + 1;
        let height = bottom - top + 1;
        self.recipes.iter().find(|recipe| {
            if recipe.shaped {
                if width != recipe.width || height != recipe.height {
                    return false;
                }
                [false, true].into_iter().any(|mirror| {
                    (0..height).all(|y| {
                        (0..width).all(|x| {
                            let ingredient = &recipe.ingredients
                                [y * width + if mirror { width - 1 - x } else { x }];
                            let stack = state.grid[(y + top) * state.width + x + left];
                            if ingredient.is_empty() {
                                stack.count == 0
                            } else {
                                stack.count > 0 && ingredient.binary_search(&stack.item).is_ok()
                            }
                        })
                    })
                })
            } else {
                if occupied.len() != recipe.ingredients.len() {
                    return false;
                }
                // Bounded bipartite matching: at most 9 * 512 states, including
                // overlapping tags. A greedy ingredient assignment is incorrect.
                let mut reachable = [false; 512];
                reachable[0] = true;
                for ingredient in &recipe.ingredients {
                    let mut next = [false; 512];
                    for (mask, valid) in reachable.into_iter().enumerate().take(1 << occupied.len())
                    {
                        if !valid {
                            continue;
                        }
                        for (index, item) in occupied.iter().enumerate() {
                            if mask & (1 << index) == 0 && ingredient.binary_search(item).is_ok() {
                                next[mask | (1 << index)] = true;
                            }
                        }
                    }
                    reachable = next;
                }
                reachable[(1 << occupied.len()) - 1]
            }
        })
    }
    fn remainder(&self, stack: Stack) -> Stack {
        let Some(item) = self.items[stack.item as usize].remainder else {
            return EMPTY;
        };
        if item == self.air {
            return EMPTY;
        }
        Stack {
            item,
            count: 1,
            components: 0,
            limit: self.items[item as usize].limit,
        }
    }
    fn add_player(state: &mut State, stack: &mut Stack) {
        let order = std::iter::once(state.selected)
            .chain(std::iter::once(40))
            .chain(0..36);
        for index in order {
            let current = state.player[index];
            if current.same(*stack) && current.limit > 1 {
                let take = stack.count.min(current.limit.saturating_sub(current.count));
                state.player[index] = current.with_count(current.count + take);
                *stack = stack.with_count(stack.count - take);
                if stack.count == 0 {
                    return;
                }
            }
        }
        for index in 0..36 {
            if state.player[index].count > 0 {
                continue;
            }
            let take = stack.count.min(stack.limit);
            state.player[index] = stack.with_count(take);
            *stack = stack.with_count(stack.count - take);
            if stack.count == 0 {
                return;
            }
        }
    }
    fn quick_move(state: &mut State, stack: &mut Stack) {
        let order = (0..9).rev().chain((9..36).rev()).collect::<Vec<_>>();
        for &index in &order {
            let current = state.player[index];
            if current.same(*stack) {
                let take = stack.count.min(stack.limit.saturating_sub(current.count));
                state.player[index] = current.with_count(current.count + take);
                *stack = stack.with_count(stack.count - take);
                if stack.count == 0 {
                    return;
                }
            }
        }
        for index in order {
            if state.player[index].count > 0 {
                continue;
            }
            let take = stack.count.min(stack.limit);
            state.player[index] = stack.with_count(take);
            *stack = stack.with_count(stack.count - take);
            if stack.count == 0 {
                return;
            }
        }
    }
    fn drop(state: &mut State, stack: Stack) -> bool {
        if stack.count == 0 {
            return true;
        }
        if state.drops.len() >= MAX_DROPS {
            return false;
        }
        state.drops.push(stack);
        true
    }
    fn consume(&self, state: &mut State) -> bool {
        for index in 0..state.width * state.height {
            let input = state.grid[index];
            if input.count == 0 {
                continue;
            }
            let mut remainder = self.remainder(input);
            state.grid[index] = input.with_count(input.count - 1);
            if remainder.count == 0 {
                continue;
            }
            let current = state.grid[index];
            if current.count == 0 {
                state.grid[index] = remainder;
            } else if current.same(remainder) {
                state.grid[index] = remainder.with_count(remainder.count + current.count);
            } else {
                Self::add_player(state, &mut remainder);
                if !Self::drop(state, remainder) {
                    return false;
                }
            }
        }
        true
    }
    fn craft(&mut self, destination: u32, batches: u32) -> i32 {
        if destination > 1 || !(1..=64).contains(&batches) {
            return -1;
        }
        let mut next = self.state.clone();
        let mut crafted = 0;
        for _ in 0..batches {
            let Some(recipe) = self.find(&next) else {
                break;
            };
            let mut output = recipe.output;
            if destination == 0 {
                if next.cursor.count > 0
                    && (!next.cursor.same(output)
                        || next.cursor.count + output.count > next.cursor.limit)
                {
                    break;
                }
                next.cursor = output.with_count(next.cursor.count + output.count);
            } else {
                Self::quick_move(&mut next, &mut output);
                if output.count == recipe.output.count {
                    break;
                }
                // CraftingMenu.quickMoveStack consumes one recipe after a partial
                // move and drops the untransferred result rather than duplicating it.
                if !Self::drop(&mut next, output) {
                    return -1;
                }
            }
            if !self.consume(&mut next) {
                return -1;
            }
            crafted += 1;
        }
        if crafted > 0 {
            next.revision = next.revision.wrapping_add(1);
            self.state = next;
        }
        crafted
    }
    fn change_grid(&mut self, width: usize, height: usize) -> bool {
        if !matches!((width, height), (2, 2) | (3, 3)) {
            return false;
        }
        let mut next = self.state.clone();
        // AbstractContainerMenu.removed returns the cursor first; the crafting
        // menu then clears its input container through placeItemBackInInventory.
        let mut cursor = next.cursor;
        next.cursor = EMPTY;
        Self::add_player(&mut next, &mut cursor);
        if !Self::drop(&mut next, cursor) {
            return false;
        }
        for index in 0..next.width * next.height {
            let mut stack = next.grid[index];
            next.grid[index] = EMPTY;
            Self::add_player(&mut next, &mut stack);
            if !Self::drop(&mut next, stack) {
                return false;
            }
        }
        next.width = width;
        next.height = height;
        next.revision = next.revision.wrapping_add(1);
        self.state = next;
        self.drag = menu::Drag::default();
        true
    }
    fn click(&mut self, area: u32, index: usize, button: u32) -> bool {
        if button > 1 {
            return false;
        }
        let target = match area {
            0 if index < self.state.width * self.state.height => &mut self.state.grid[index],
            1 if index < 36 => &mut self.state.player[index],
            _ => return false,
        };
        let cursor = &mut self.state.cursor;
        let before = (*target, *cursor);
        if cursor.count == 0 && target.count > 0 {
            let take = if button == 1 {
                target.count.div_ceil(2)
            } else {
                target.count
            };
            *cursor = target.with_count(take);
            *target = target.with_count(target.count - take);
        } else if cursor.count > 0 && (target.count == 0 || target.same(*cursor)) {
            let take = cursor
                .count
                .min(cursor.limit.saturating_sub(target.count))
                .min(if button == 1 { 1 } else { u32::MAX });
            if take > 0 {
                *target = cursor.with_count(target.count + take);
                *cursor = cursor.with_count(cursor.count - take);
            }
        } else if cursor.count > 0 && target.count > 0 && cursor.count <= cursor.limit {
            std::mem::swap(cursor, target);
        }
        if before != (*target, *cursor) {
            self.state.revision = self.state.revision.wrapping_add(1);
        }
        true
    }
    fn snapshot(&self) -> Vec<u32> {
        let s = &self.state;
        let mut words = vec![
            0x50494e56,
            1,
            s.width as u32,
            s.height as u32,
            s.selected as u32,
            s.revision,
            s.drops.len() as u32,
        ];
        for stack in s
            .grid
            .iter()
            .chain(&s.player)
            .chain(std::iter::once(&s.cursor))
            .chain(&s.drops)
        {
            words.extend(stack.words());
        }
        words
    }
    fn restore(&mut self, count: usize) -> bool {
        if !(211..=467).contains(&count) {
            return false;
        }
        let data = &self.staging[..count];
        let (width, height, selected, drop_count) = (
            data[2] as usize,
            data[3] as usize,
            data[4] as usize,
            data[6] as usize,
        );
        if data[0] != 0x50494e56
            || data[1] != 1
            || !matches!((width, height), (2, 2) | (3, 3))
            || selected > 8
            || drop_count > MAX_DROPS
            || count != 7 + (51 + drop_count) * 4
        {
            return false;
        }
        let mut next = State {
            width,
            height,
            selected,
            revision: data[5],
            ..State::default()
        };
        for (index, words) in data[7..].as_chunks::<4>().0.iter().enumerate() {
            let Some(stack) = self.stack(words) else {
                return false;
            };
            if index < 9 {
                if index >= width * height && stack.count > 0 {
                    return false;
                }
                next.grid[index] = stack;
            } else if index < 50 {
                next.player[index - 9] = stack;
            } else if index == 50 {
                next.cursor = stack;
            } else {
                if stack.count == 0 {
                    return false;
                }
                next.drops.push(stack);
            }
        }
        self.state = next;
        self.drag = menu::Drag::default();
        true
    }
}
static INVENTORY: Mutex<Option<Inventory>> = Mutex::new(None);
fn with_inventory<T>(f: impl FnOnce(&mut Inventory) -> T) -> T {
    let mut guard = match INVENTORY.lock() {
        Ok(guard) => guard,
        Err(error) => error.into_inner(),
    };
    f(guard.get_or_insert_with(Inventory::default))
}
#[no_mangle]
pub extern "C" fn inventory_stage_ptr() -> *mut u32 {
    with_inventory(|inventory| inventory.staging.as_mut_ptr())
}
#[no_mangle]
pub extern "C" fn inventory_register_item(id: u32, limit: u32, remainder: u32) -> u32 {
    if id as usize >= MAX_ITEMS
        || !(1..=99).contains(&limit)
        || remainder != u32::MAX && remainder as usize >= MAX_ITEMS
    {
        return 0;
    }
    with_inventory(|inventory| {
        if remainder != u32::MAX && !inventory.items[remainder as usize].registered {
            return 0;
        }
        inventory.items[id as usize] = Item {
            registered: true,
            limit,
            remainder: (remainder != u32::MAX).then_some(remainder),
            equipment: inventory.items[id as usize].equipment,
        };
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_empty_item(id: u32) -> u32 {
    with_inventory(|inventory| {
        if id as usize >= MAX_ITEMS || !inventory.items[id as usize].registered {
            return 0;
        }
        inventory.air = id;
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_register_recipe(count: u32) -> u32 {
    with_inventory(|inventory| u32::from(inventory.register_recipe(count as usize)))
}
#[no_mangle]
pub extern "C" fn inventory_reset(width: u32, height: u32) -> u32 {
    if !matches!((width, height), (2, 2) | (3, 3)) {
        return 0;
    }
    with_inventory(|inventory| {
        inventory.state = State {
            width: width as usize,
            height: height as usize,
            ..State::default()
        };
        inventory.drag = menu::Drag::default();
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_change_grid(width: u32, height: u32) -> u32 {
    with_inventory(|inventory| u32::from(inventory.change_grid(width as usize, height as usize)))
}
#[no_mangle]
pub extern "C" fn inventory_slot_set(
    area: u32,
    index: u32,
    item: u32,
    count: u32,
    components: u32,
    limit: u32,
) -> u32 {
    with_inventory(|inventory| {
        let Some(stack) = inventory.stack(&[item, count, components, limit]) else {
            return 0;
        };
        let state = &mut inventory.state;
        let index = index as usize;
        let target = match area {
            0 if index < state.width * state.height => &mut state.grid[index],
            1 if index < 41 => &mut state.player[index],
            2 if index == 0 => &mut state.cursor,
            _ => return 0,
        };
        if *target != stack {
            *target = stack;
            state.revision = state.revision.wrapping_add(1);
        }
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_selected(slot: u32) -> u32 {
    if slot > 8 {
        return 0;
    }
    with_inventory(|inventory| {
        inventory.state.selected = slot as usize;
        1
    })
}
#[no_mangle]
pub extern "C" fn inventory_click(area: u32, index: u32, button: u32) -> u32 {
    with_inventory(|inventory| u32::from(inventory.click(area, index as usize, button)))
}
#[no_mangle]
pub extern "C" fn inventory_craft(destination: u32, batches: u32) -> i32 {
    with_inventory(|inventory| inventory.craft(destination, batches))
}
#[no_mangle]
pub extern "C" fn inventory_read() -> u32 {
    with_inventory(|inventory| {
        inventory.output = inventory.snapshot();
        inventory.output.push(
            inventory
                .find(&inventory.state)
                .map_or(u32::MAX, |recipe| recipe.key),
        );
        inventory.output.extend(
            inventory
                .find(&inventory.state)
                .map_or(EMPTY, |recipe| recipe.output)
                .words(),
        );
        inventory.output.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn inventory_snapshot() -> u32 {
    with_inventory(|inventory| {
        inventory.output = inventory.snapshot();
        inventory.output.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn inventory_output_ptr() -> *const u32 {
    with_inventory(|inventory| inventory.output.as_ptr())
}
#[no_mangle]
pub extern "C" fn inventory_restore(count: u32) -> u32 {
    with_inventory(|inventory| u32::from(inventory.restore(count as usize)))
}
#[no_mangle]
pub extern "C" fn inventory_ack_drops() {
    with_inventory(|inventory| inventory.state.drops.clear());
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inventory() -> Inventory {
        let mut result = Inventory::default();
        for id in 1..=6 {
            result.items[id] = Item {
                registered: true,
                limit: 64,
                remainder: None,
                equipment: 0,
            };
        }
        result
    }
    fn stack(item: u32, count: u32) -> Stack {
        Stack {
            item,
            count,
            components: 0,
            limit: 64,
        }
    }
    fn recipe(shaped: bool, ingredients: Vec<Vec<u32>>, output: Stack) -> Recipe {
        Recipe {
            key: 4,
            width: 2,
            height: 1,
            shaped,
            ingredients,
            output,
        }
    }
    #[test]
    fn shapeless_overlapping_ingredients_require_bipartite_matching() {
        let mut i = inventory();
        i.recipes
            .push(recipe(false, vec![vec![1, 2], vec![1]], stack(3, 1)));
        i.state.grid[0] = stack(1, 1);
        i.state.grid[1] = stack(2, 1);
        assert!(i.find(&i.state).is_some());
        assert_eq!(i.craft(0, 1), 1);
        assert_eq!(i.state.cursor, stack(3, 1));
    }
    #[test]
    fn asymmetric_shape_matches_translated_and_mirrored_but_not_vertical_flip() {
        let mut i = inventory();
        i.state.width = 3;
        i.state.height = 3;
        i.recipes
            .push(recipe(true, vec![vec![1], vec![2]], stack(3, 1)));
        i.state.grid[7] = stack(2, 2);
        i.state.grid[8] = stack(1, 2);
        assert!(i.find(&i.state).is_some());
        assert_eq!(i.craft(0, 1), 1);
        assert_eq!(i.state.grid[7].count, 1);
        i.state.grid[1] = stack(1, 1);
        assert!(i.find(&i.state).is_none());
    }
    #[test]
    fn remainder_uses_input_slot_then_selected_stack_then_offhand_and_drops_overflow() {
        let mut i = inventory();
        i.items[1].remainder = Some(2);
        i.recipes.push(recipe(false, vec![vec![1]], stack(3, 1)));
        i.state.grid[0] = stack(1, 2);
        i.state.player.fill(stack(4, 64));
        i.state.player[0] = stack(2, 63);
        assert_eq!(i.craft(0, 1), 1);
        assert_eq!(i.state.player[0].count, 64);
        assert!(i.state.drops.is_empty());
        assert_eq!(i.craft(0, 1), 1);
        assert_eq!(i.state.grid[0], stack(2, 1));
        i.state.grid[0] = stack(1, 2);
        assert_eq!(i.craft(0, 1), 1);
        assert_eq!(i.state.drops, vec![stack(2, 1)]);
    }
    #[test]
    fn components_never_merge_and_partial_quick_move_consumes_once_and_drops_rest() {
        let mut i = inventory();
        i.recipes.push(recipe(false, vec![vec![1]], stack(3, 4)));
        i.state.grid[0] = stack(1, 2);
        i.state.player.fill(stack(4, 64));
        i.state.player[8] = stack(3, 63);
        assert_eq!(i.craft(1, 64), 1);
        assert_eq!(i.state.player[8].count, 64);
        assert_eq!(i.state.grid[0].count, 1);
        assert_eq!(i.state.drops, vec![stack(3, 3)]);
        i.state.cursor = Stack {
            components: 1,
            ..stack(3, 1)
        };
        let before = i.snapshot();
        assert_eq!(i.craft(0, 1), 0);
        assert_eq!(i.snapshot(), before);
    }
    #[test]
    fn full_drop_queue_rejects_transaction_without_consuming_or_changing_inventory() {
        let mut i = inventory();
        i.items[1].remainder = Some(2);
        i.recipes.push(recipe(false, vec![vec![1]], stack(3, 1)));
        i.state.grid[0] = stack(1, 2);
        i.state.player.fill(stack(4, 64));
        i.state.drops = vec![stack(2, 1); MAX_DROPS];
        let before = i.snapshot();
        assert_eq!(i.craft(0, 1), -1);
        assert_eq!(i.snapshot(), before);
    }
    #[test]
    fn closing_grid_returns_cursor_then_inputs_and_keeps_existing_player_components() {
        let mut i = inventory();
        i.state.cursor = stack(2, 4);
        i.state.grid[0] = stack(1, 3);
        i.state.player[0] = Stack {
            components: 7,
            ..stack(1, 2)
        };
        assert!(i.change_grid(3, 3));
        assert_eq!(i.state.player[0].components, 7);
        assert_eq!(i.state.player[1], stack(2, 4));
        assert_eq!(i.state.player[2], stack(1, 3));
        assert_eq!(i.state.cursor, EMPTY);
        assert!(i.state.grid.iter().all(|stack| stack.count == 0));
        assert_eq!(i.state.width, 3);
    }
    #[test]
    fn grid_change_drop_overflow_rolls_back_every_slot_and_width() {
        let mut i = inventory();
        i.state.player.fill(stack(4, 64));
        i.state.cursor = stack(2, 1);
        i.state.grid[0] = stack(1, 1);
        i.state.drops = vec![stack(3, 1); MAX_DROPS - 1];
        let before = i.snapshot();
        assert!(!i.change_grid(3, 3));
        assert_eq!(i.snapshot(), before);
    }
    #[test]
    fn snapshot_restore_is_atomic_and_retains_components_cursor_and_drop_queue() {
        let mut i = inventory();
        i.state.grid[3] = Stack {
            components: 9,
            ..stack(1, 2)
        };
        i.state.cursor = stack(2, 3);
        i.state.drops.push(stack(3, 4));
        let saved = i.snapshot();
        i.staging[..saved.len()].copy_from_slice(&saved);
        i.state = State::default();
        assert!(i.restore(saved.len()));
        assert_eq!(i.snapshot(), saved);
        i.staging[8] = 100;
        assert!(!i.restore(saved.len()));
        assert_eq!(i.snapshot(), saved);
    }
}
