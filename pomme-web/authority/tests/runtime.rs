use pomme_browser_authority::*;
use std::sync::Mutex;
static TESTS: Mutex<()> = Mutex::new(());
fn world() {
    assert_eq!(authority_reset(-64, 384), 1);
    for (id, group, kind, flags, counterpart, direction) in [
        (0, 0, 0, 0, 0, 0),
        (1, 1, 0, 1, 1, 0),
        (2, 2, 1, 0, 3, 1),
        (3, 2, 1, 2, 2, 1),
        (4, 3, 2, 0, 5, 1),
        (5, 3, 2, 2, 4, 1),
        (6, 4, 3, 0, 7, 1),
        (7, 4, 3, 2, 6, 1),
        (8, 5, 4, 1, 9, 0),
        (9, 5, 4, 3, 8, 0),
        (10, 6, 5, 1, 10, 0),
    ] {
        assert_eq!(
            authority_register(id, group, kind, flags, counterpart, direction),
            1
        );
    }
    unsafe {
        std::slice::from_raw_parts_mut(authority_stage_ptr(), 4096).fill(0);
    }
    assert_eq!(authority_load_section(0, 0, 0), 1);
}
fn snapshot() -> Vec<u8> {
    let count = authority_snapshot() as usize;
    unsafe { std::slice::from_raw_parts(authority_snapshot_ptr(), count).to_vec() }
}
fn restore(bytes: &[u8]) -> u32 {
    unsafe {
        std::slice::from_raw_parts_mut(authority_restore_ptr(), bytes.len()).copy_from_slice(bytes);
    }
    authority_restore(bytes.len() as u32)
}
#[test]
fn lamp_extinguishes_after_four_ticks_and_repower_cancels_turnoff() {
    let _lock = TESTS.lock().unwrap();
    world();
    assert_eq!(authority_block_set(2, 2, 2, 8), 1);
    assert_eq!(authority_block_set(3, 2, 2, 2), 1);
    assert_eq!(authority_use_block(3, 2, 2), 1);
    assert_eq!(authority_block_get(2, 2, 2), 9);
    assert_eq!(authority_use_block(3, 2, 2), 1);
    assert_eq!(authority_pending_ticks(), 1);
    assert_eq!(authority_tick(3), 1);
    assert_eq!(authority_block_get(2, 2, 2), 9);
    assert_eq!(authority_use_block(3, 2, 2), 1);
    assert_eq!(authority_tick(1), 1);
    assert_eq!(authority_block_get(2, 2, 2), 9);
    assert_eq!(authority_use_block(3, 2, 2), 1);
    assert_eq!(authority_tick(4), 1);
    assert_eq!(authority_block_get(2, 2, 2), 8);
}
#[test]
fn buttons_release_at_native_delays_without_click_extending_tick() {
    let _lock = TESTS.lock().unwrap();
    world();
    for (x, off, on, delay) in [(2, 4, 5, 20), (4, 6, 7, 30)] {
        assert_eq!(authority_block_set(x, 2, 2, off), 1);
        assert_eq!(authority_use_block(x, 2, 2), 1);
        assert_eq!(authority_tick(delay - 1), 1);
        assert_eq!(authority_use_block(x, 2, 2), 1);
        assert_eq!(authority_block_get(x, 2, 2), on);
        assert_eq!(authority_tick(1), 1);
        assert_eq!(authority_block_get(x, 2, 2), off);
    }
}
#[test]
fn solid_support_conducts_strong_power_one_block() {
    let _lock = TESTS.lock().unwrap();
    world();
    assert_eq!(authority_block_set(2, 2, 2, 1), 1);
    assert_eq!(authority_block_set(3, 2, 2, 8), 1);
    assert_eq!(authority_block_set(2, 3, 2, 2), 1);
    assert_eq!(authority_use_block(2, 3, 2), 1);
    assert_eq!(authority_block_get(3, 2, 2), 9);
    assert_eq!(authority_use_block(2, 3, 2), 1);
    assert_eq!(authority_tick(4), 1);
    assert_eq!(authority_block_get(3, 2, 2), 8);
}
#[test]
fn replacing_scheduled_button_does_not_overwrite_new_block() {
    let _lock = TESTS.lock().unwrap();
    world();
    authority_block_set(2, 2, 2, 4);
    authority_use_block(2, 2, 2);
    authority_tick(5);
    authority_block_set(2, 2, 2, 1);
    authority_tick(20);
    assert_eq!(authority_block_get(2, 2, 2), 1);
    assert_eq!(authority_pending_ticks(), 0);
}
#[test]
fn saves_restore_remaining_delays_clocks_and_negative_coordinates() {
    let _lock = TESTS.lock().unwrap();
    world();
    unsafe {
        std::slice::from_raw_parts_mut(authority_stage_ptr(), 4096).fill(0);
    }
    assert_eq!(authority_load_section(-2, -4, -3), 1);
    assert_eq!(authority_block_set(-17, -63, -33, 4), 1);
    assert_eq!(authority_use_block(-17, -63, -33), 1);
    assert_eq!(authority_tick(7), 1);
    let bytes = snapshot();
    world();
    assert_eq!(restore(&bytes), 1);
    assert_eq!(authority_world_age(), 7);
    assert_eq!(authority_daytime(), 7);
    assert_eq!(authority_pending_ticks(), 1);
    authority_tick(12);
    assert_eq!(authority_block_get(-17, -63, -33), 5);
    authority_tick(1);
    assert_eq!(authority_block_get(-17, -63, -33), 4);
}
#[test]
fn malformed_or_unknown_state_save_is_rejected_atomically() {
    let _lock = TESTS.lock().unwrap();
    world();
    authority_block_set(2, 2, 2, 10);
    let bytes = snapshot();
    let before = bytes.clone();
    for length in [0, 7, 43, bytes.len() - 1] {
        assert_eq!(restore(&bytes[..length]), 0);
        assert_eq!(snapshot(), before);
    }
    let mut invalid = bytes.clone();
    invalid[56] = 255;
    invalid[57] = 255;
    assert_eq!(restore(&invalid), 0);
    assert_eq!(snapshot(), before);
    let mut extra = bytes.clone();
    extra.push(0);
    assert_eq!(restore(&extra), 0);
    assert_eq!(snapshot(), before);
}
#[test]
fn invalid_world_or_unloaded_edits_are_rejected() {
    let _lock = TESTS.lock().unwrap();
    world();
    assert_eq!(authority_reset(1, 384), 0);
    assert_eq!(authority_reset(i32::MAX - 15, 384), 0);
    assert_eq!(authority_block_set(1000, 2, 2, 1), 0);
    assert_eq!(authority_block_get(1000, 2, 2), u32::MAX);
    assert_eq!(authority_load_section(0, -5, 0), 0);
    assert_eq!(authority_block_set(2, 2, 2, 65536), 0);
    assert_eq!(authority_use_block(2, 2, 2), 0);
}
#[test]
fn stopped_daylight_does_not_stop_world_clock() {
    let _lock = TESTS.lock().unwrap();
    world();
    authority_set_time(23999, 0);
    authority_tick(3);
    assert_eq!(authority_world_age(), 3);
    assert_eq!(authority_daytime(), 23999);
    authority_set_time(23999, 1);
    authority_tick(2);
    assert_eq!(authority_daytime(), 24001);
}
#[test]
fn identical_edits_do_not_emit_new_changes() {
    let _lock = TESTS.lock().unwrap();
    world();
    authority_block_set(2, 2, 2, 1);
    authority_block_set(2, 2, 2, 1);
    assert_eq!(authority_drain_events(), 1);
    assert_eq!(authority_drain_events(), 0);
    authority_tick(100);
    assert_eq!(authority_drain_events(), 0);
}
