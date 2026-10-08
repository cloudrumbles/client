import { parseTextComponent, textComponent } from './text.js';

export const CUSTOM_STATISTICS = ['leave_game', 'play_time', 'total_world_time', 'time_since_death', 'time_since_rest', 'sneak_time', 'walk_one_cm', 'crouch_one_cm', 'sprint_one_cm', 'walk_on_water_one_cm', 'fall_one_cm', 'climb_one_cm', 'fly_one_cm', 'walk_under_water_one_cm', 'minecart_one_cm', 'boat_one_cm', 'pig_one_cm', 'horse_one_cm', 'aviate_one_cm', 'swim_one_cm', 'strider_one_cm', 'jump', 'drop', 'damage_dealt', 'damage_dealt_absorbed', 'damage_dealt_resisted', 'damage_taken', 'damage_blocked_by_shield', 'damage_absorbed', 'damage_resisted', 'deaths', 'mob_kills', 'animals_bred', 'player_kills', 'fish_caught', 'talked_to_villager', 'traded_with_villager', 'eat_cake_slice', 'fill_cauldron', 'use_cauldron', 'clean_armor', 'clean_banner', 'clean_shulker_box', 'interact_with_brewingstand', 'interact_with_beacon', 'inspect_dropper', 'inspect_hopper', 'inspect_dispenser', 'play_noteblock', 'tune_noteblock', 'pot_flower', 'trigger_trapped_chest', 'open_enderchest', 'enchant_item', 'play_record', 'interact_with_furnace', 'interact_with_crafting_table', 'open_chest', 'sleep_in_bed', 'open_shulker_box', 'open_barrel', 'interact_with_blast_furnace', 'interact_with_smoker', 'interact_with_lectern', 'interact_with_campfire', 'interact_with_cartography_table', 'interact_with_loom', 'interact_with_stonecutter', 'bell_ring', 'raid_trigger', 'raid_win', 'interact_with_anvil', 'interact_with_grindstone', 'target_hit', 'interact_with_smithing_table'];
export const STATISTIC_CATEGORIES = ['Blocks mined', 'Items crafted', 'Items used', 'Items broken', 'Items picked up', 'Items dropped', 'Mobs killed', 'Killed by', 'General'];

export function statisticValue(category, id, value) {
  if (category !== 8) return value.toLocaleString('en-US');
  const name = CUSTOM_STATISTICS[id];
  if (name?.endsWith('_one_cm')) return value >= 100000 ? `${(value / 100000).toFixed(2)} km` : `${(value / 100).toFixed(2)} m`;
  if (name?.includes('time')) {
    const seconds = value / 20;
    return seconds >= 86400 ? `${(seconds / 86400).toFixed(2)} days` : seconds >= 3600 ? `${(seconds / 3600).toFixed(2)} h` : seconds >= 60 ? `${(seconds / 60).toFixed(2)} min` : `${seconds.toFixed(2)} s`;
  }
  if (name?.startsWith('damage_')) return (value / 10).toFixed(2);
  return value.toLocaleString('en-US');
}

export class ServerProgress {
  constructor() { this.advancements = new Map(); this.progress = new Map(); this.statistics = new Map(); this.statisticsReceived = false; this.selectedTab = null; this.toasts = []; }

  advancement(packet) {
    if (packet.reset) { this.advancements.clear(); this.progress.clear(); this.toasts = []; this.selectedTab = null; }
    const removed = new Set(packet.identifiers || []);
    let changed = true;
    while (changed) { changed = false; for (const [id, node] of this.advancements) if (!removed.has(id) && removed.has(node.parentId)) { removed.add(id); changed = true; } }
    for (const id of removed) { this.advancements.delete(id); this.progress.delete(id); }
    for (const mapping of packet.advancementMapping || []) this.advancements.set(mapping.key, { ...mapping.value, id: mapping.key });
    for (const mapping of packet.progressMapping || []) {
      const previous = this.completed(mapping.key);
      this.progress.set(mapping.key, new Map(mapping.value.map((criterion) => [criterion.criterionIdentifier, criterion.criterionProgress])));
      const node = this.advancements.get(mapping.key);
      if (!packet.reset && !previous && this.completed(mapping.key) && node?.displayData?.flags?.show_toast) this.toasts.push({ id: mapping.key, remaining: 5 });
    }
    if (this.selectedTab && !this.advancements.has(this.selectedTab)) this.selectedTab = null;
  }

  completion(id) {
    const requirements = this.advancements.get(id)?.requirements || [], progress = this.progress.get(id);
    const done = requirements.filter((group) => group.some((criterion) => progress?.get(criterion) !== undefined && progress?.get(criterion) !== null)).length;
    return { done, total: requirements.length, complete: requirements.length > 0 && done === requirements.length };
  }

  completed(id) { return this.completion(id).complete; }

  root(id) {
    const visited = new Set(); let node = this.advancements.get(id);
    while (node?.parentId && this.advancements.has(node.parentId) && !visited.has(node.id)) { visited.add(node.id); node = this.advancements.get(node.parentId); }
    return node?.id;
  }

  roots() { return [...this.advancements.values()].filter((node) => !node.parentId && node.displayData); }

  visible(tab) {
    return [...this.advancements.values()].filter((node) => node.displayData && this.root(node.id) === tab && (!node.displayData.flags?.hidden || this.completed(node.id)))
      .sort((a, b) => a.displayData.xCord - b.displayData.xCord || a.displayData.yCord - b.displayData.yCord);
  }

  stats(entries) { for (const entry of entries || []) this.statistics.set(`${entry.categoryId},${entry.statisticId}`, { ...entry }); this.statisticsReceived = true; }

  statisticRows(registry, category) {
    const definitions = category === 0 ? registry.blocks : category >= 1 && category <= 5 ? registry.items : registry.entities;
    const lookup = new Map((definitions || []).map((entry) => [entry.id, entry]));
    const blockNames = new Set((registry.blocks || []).map(entry => entry.name));
    return [...this.statistics.values()].filter((entry) => entry.categoryId === category).map((entry) => {
      const definition = lookup.get(entry.statisticId), fallback = category === 8 ? CUSTOM_STATISTICS[entry.statisticId]?.replaceAll('_', ' ') : definition?.displayName || definition?.name?.replaceAll('_', ' ');
      const key = category === 8 ? CUSTOM_STATISTICS[entry.statisticId] && `stat.minecraft.${CUSTOM_STATISTICS[entry.statisticId]}` : definition?.name && `${category === 0 || category <= 5 && blockNames.has(definition.name) ? 'block' : category <= 5 ? 'item' : 'entity'}.minecraft.${definition.name}`;
      const name = key ? textComponent({ translate: key, fallback: fallback || `Statistic ${entry.statisticId}` }) : fallback;
      return { ...entry, name: name || `Statistic ${entry.statisticId}`, formatted: statisticValue(category, entry.statisticId, entry.value) };
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  }

  tick(dt) { for (const toast of this.toasts) toast.remaining -= dt; this.toasts = this.toasts.filter((toast) => toast.remaining > 0).slice(-5); }

  title(id) { return textComponent(this.advancements.get(id)?.displayData?.title); }
  titleComponent(id) { return parseTextComponent(this.advancements.get(id)?.displayData?.title); }
  descriptionComponent(id) { return parseTextComponent(this.advancements.get(id)?.displayData?.description); }
  toastComponent(id) {
    const frame = this.advancements.get(id)?.displayData?.frameType;
    return { translate: `advancements.toast.${['task', 'challenge', 'goal'][frame] || 'task'}`, fallback: ['Advancement made!', 'Challenge complete!', 'Goal reached!'][frame] || 'Advancement made!' };
  }
}
