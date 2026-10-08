import { getLanguage, parseTextComponent, textComponent, withTextStyle } from './text.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
const compareNames = (a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
const numberText = (score, objective) => {
  const format = score.number_format ?? objective.number_format;
  if (format === 0) return '';
  if (format === 2) return textComponent(score.styling ?? objective.styling);
  return String(score.value);
};
const TEAM_COLORS = ['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'];
const numberComponent = (score, objective, defaultColor) => {
  const format = score.number_format ?? objective.number_format;
  if (format === 0) return { text: '' };
  if (format === 2) return parseTextComponent(score.styling ?? objective.styling);
  return withTextStyle({ text: String(score.value) }, format === 1 ? score.styling ?? objective.styling : { color: defaultColor });
};

export const EFFECT_NAMES = ['Speed', 'Slowness', 'Haste', 'Mining fatigue', 'Strength', 'Instant health', 'Instant damage', 'Jump boost', 'Nausea', 'Regeneration', 'Resistance', 'Fire resistance', 'Water breathing', 'Invisibility', 'Blindness', 'Night vision', 'Hunger', 'Weakness', 'Poison', 'Wither', 'Health boost', 'Absorption', 'Saturation', 'Glowing', 'Levitation', 'Luck', 'Bad luck', 'Slow falling', 'Conduit power', 'Dolphin’s grace', 'Bad omen', 'Hero of the village', 'Darkness'];

export function effectText(effect) {
  const fallback = EFFECT_NAMES[effect.id] || effect.name?.replaceAll('_', ' ') || `Effect ${effect.id}`;
  const name = effect.name ? { translate: `effect.minecraft.${effect.name}`, fallback } : { text: fallback };
  const label = effect.amplifier > 0 ? textComponent({ translate: 'potion.withAmplifier', fallback: '%s %s', with: [name, { translate: `potion.potency.${effect.amplifier}`, fallback: String(effect.amplifier + 1) }] }) : textComponent(name);
  if (effect.duration < 0) return `${label} ∞`;
  const seconds = Math.max(0, Math.ceil(effect.duration / 20));
  return `${label} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class ServerHud {
  constructor() {
    this.bossBars = new Map(); this.objectives = new Map(); this.scores = new Map();
    this.displays = new Map(); this.teams = new Map(); this.players = [];
    this.header = ''; this.footer = ''; this.actionBar = ''; this.actionRemaining = 0;
    this.title = ''; this.subtitle = ''; this.titleRemaining = 0;
    this.headerComponent = ''; this.footerComponent = ''; this.actionBarComponent = ''; this.titleComponent = ''; this.subtitleComponent = '';
    this.titleTimes = { fadeIn: 10, stay: 70, fadeOut: 20 };
    this.revision = 0;
    this.languageRevision = getLanguage().revision;
  }

  action(text, component = text) { this.actionBarComponent = parseTextComponent(component); this.actionBar = textComponent(this.actionBarComponent); this.actionRemaining = 3; this.revision++; }

  packet(name, data) {
    switch (name) {
      case 'boss_bar': {
        const key = data.entityUUID;
        if (data.action === 1) this.bossBars.delete(key);
        else if (data.action === 0) this.bossBars.set(key, { ...data, title: textComponent(data.title), titleComponent: parseTextComponent(data.title), health: clamp(data.health, 0, 1) });
        else {
          const bar = this.bossBars.get(key); if (!bar) break;
          if (data.action === 2) bar.health = clamp(data.health, 0, 1);
          if (data.action === 3) { bar.title = textComponent(data.title); bar.titleComponent = parseTextComponent(data.title); }
          if (data.action === 4) { bar.color = data.color; bar.dividers = data.dividers; }
          if (data.action === 5) bar.flags = data.flags;
        }
        break;
      }
      case 'action_bar': this.action(data.text); break;
      case 'set_title_text': this.title = textComponent(data.text); this.titleComponent = parseTextComponent(data.text); this.titleRemaining = Object.values(this.titleTimes).reduce((sum, value) => sum + value, 0) / 20; break;
      case 'set_title_subtitle': this.subtitle = textComponent(data.text); this.subtitleComponent = parseTextComponent(data.text); break;
      case 'set_title_time':
        for (const key of ['fadeIn', 'stay', 'fadeOut']) if (Number.isInteger(data[key]) && data[key] >= 0) this.titleTimes[key] = data[key];
        if (this.titleRemaining > 0) this.titleRemaining = Object.values(this.titleTimes).reduce((sum, value) => sum + value, 0) / 20;
        break;
      case 'clear_titles': this.title = ''; this.subtitle = ''; this.titleComponent = ''; this.subtitleComponent = ''; this.titleRemaining = 0; if (data.reset) this.titleTimes = { fadeIn: 10, stay: 70, fadeOut: 20 }; break;
      case 'playerlist_header': this.header = textComponent(data.header); this.footer = textComponent(data.footer); this.headerComponent = parseTextComponent(data.header); this.footerComponent = parseTextComponent(data.footer); break;
      case 'scoreboard_objective':
        if (data.action === 1) {
          this.objectives.delete(data.name); this.scores.delete(data.name);
          for (const [position, name] of this.displays) if (name === data.name) this.displays.delete(position);
        } else this.objectives.set(data.name, { ...this.objectives.get(data.name), ...data, displayText: textComponent(data.displayText), displayComponent: parseTextComponent(data.displayText) });
        break;
      case 'scoreboard_display_objective':
        if (data.name) this.displays.set(data.position, data.name); else this.displays.delete(data.position);
        break;
      case 'scoreboard_score': {
        let objective = this.scores.get(data.scoreName);
        if (!objective) { objective = new Map(); this.scores.set(data.scoreName, objective); }
        objective.set(data.itemName, { ...data, display_name: data.display_name ? textComponent(data.display_name) : undefined, displayComponent: data.display_name ? parseTextComponent(data.display_name) : undefined });
        break;
      }
      case 'reset_score':
        if (data.objective_name) this.scores.get(data.objective_name)?.delete(data.entity_name);
        else for (const scores of this.scores.values()) scores.delete(data.entity_name);
        break;
      case 'teams': {
        if (data.mode === 1) { this.teams.delete(data.team); break; }
        const team = this.teams.get(data.team) || { players: new Set() };
        if (data.mode === 0 || data.mode === 2) Object.assign(team, data, { prefix: textComponent(data.prefix), suffix: textComponent(data.suffix), prefixComponent: parseTextComponent(data.prefix), suffixComponent: parseTextComponent(data.suffix), players: team.players });
        if (data.mode === 0 || data.mode === 3) for (const player of data.players || []) {
          for (const other of this.teams.values()) other.players.delete(player);
          team.players.add(player);
        }
        if (data.mode === 4) for (const player of data.players || []) team.players.delete(player);
        this.teams.set(data.team, team); break;
      }
      default: return false;
    }
    this.revision++; return true;
  }

  tick(dt) {
    if (this.languageRevision !== getLanguage().revision) this.refreshLanguage();
    const previous = [this.titleRemaining > 0, this.actionRemaining > 0];
    this.titleRemaining = Math.max(0, this.titleRemaining - dt);
    this.actionRemaining = Math.max(0, this.actionRemaining - dt);
    if (previous[0] !== (this.titleRemaining > 0) || previous[1] !== (this.actionRemaining > 0)) this.revision++;
  }

  refreshLanguage() {
    for (const key of ['header', 'footer', 'actionBar', 'title', 'subtitle']) this[key] = textComponent(this[`${key}Component`]);
    for (const bar of this.bossBars.values()) bar.title = textComponent(bar.titleComponent);
    for (const objective of this.objectives.values()) objective.displayText = textComponent(objective.displayComponent);
    for (const scores of this.scores.values()) for (const score of scores.values()) if (score.displayComponent !== undefined) score.display_name = textComponent(score.displayComponent);
    for (const team of this.teams.values()) { team.prefix = textComponent(team.prefixComponent); team.suffix = textComponent(team.suffixComponent); }
    this.languageRevision = getLanguage().revision; this.revision++;
  }

  get titleOpacity() {
    const { fadeIn, stay, fadeOut } = this.titleTimes;
    const remaining = this.titleRemaining * 20, elapsed = fadeIn + stay + fadeOut - remaining;
    if (remaining <= 0) return 0;
    if (fadeIn > 0 && elapsed < fadeIn) return clamp(elapsed / fadeIn, 0, 1);
    if (fadeOut > 0 && remaining < fadeOut) return clamp(remaining / fadeOut, 0, 1);
    return 1;
  }

  decoratedName(name) {
    const team = [...this.teams.values()].find((team) => team.players.has(name));
    return team ? `${team.prefix || ''}${name}${team.suffix || ''}` : name;
  }

  decoratedComponent(name) {
    const team = [...this.teams.values()].find((team) => team.players.has(name));
    if (!team) return { text: name };
    return { text: '', ...(TEAM_COLORS[team.formatting] ? { color: TEAM_COLORS[team.formatting] } : {}), extra: [team.prefixComponent ?? team.prefix ?? '', { text: name }, team.suffixComponent ?? team.suffix ?? ''] };
  }

  sidebar(playerName) {
    const team = [...this.teams.values()].find((team) => team.players.has(playerName));
    const colorSlot = team && team.formatting >= 0 && team.formatting <= 15 ? this.displays.get(3 + team.formatting) : undefined;
    const name = colorSlot || this.displays.get(1), objective = this.objectives.get(name);
    if (!objective) return null;
    const rows = [...(this.scores.get(name)?.values() || [])]
      .filter((score) => !score.itemName.startsWith('#'))
      .sort((a, b) => b.value - a.value || compareNames(a.itemName, b.itemName))
      .slice(0, 15).map((score) => ({ name: score.display_name ?? this.decoratedName(score.itemName), value: numberText(score, objective) }));
    return { title: objective.displayText, rows };
  }

  sidebarComponents(playerName) {
    const team = [...this.teams.values()].find((team) => team.players.has(playerName));
    const colorSlot = team && team.formatting >= 0 && team.formatting <= 15 ? this.displays.get(3 + team.formatting) : undefined;
    const name = colorSlot || this.displays.get(1), objective = this.objectives.get(name);
    if (!objective) return null;
    const rows = [...(this.scores.get(name)?.values() || [])]
      .filter(score => !score.itemName.startsWith('#')).sort((a, b) => b.value - a.value || compareNames(a.itemName, b.itemName)).slice(0, 15)
      .map(score => ({ nameComponent: score.displayComponent ?? this.decoratedComponent(score.itemName), valueComponent: numberComponent(score, objective, 'red') }));
    return { titleComponent: objective.displayComponent ?? objective.displayText, rows };
  }

  playerList() {
    const objective = this.objectives.get(this.displays.get(0));
    const scores = this.scores.get(this.displays.get(0));
    const teamName = (player) => [...this.teams.entries()].find(([, team]) => team.players.has(player.name))?.[0] || '';
    return this.players.filter((player) => player.listed !== false && player.listed !== 0)
      .sort((a, b) => Number(a.gamemode === 3) - Number(b.gamemode === 3) || compareNames(teamName(a), teamName(b)) || compareNames(a.name || '', b.name || ''))
      .slice(0, 80).map((player) => ({ ...player, display: player.displayName ? textComponent(player.displayName) : this.decoratedName(player.name || player.uuid), displayComponent: player.displayName ? parseTextComponent(player.displayName) : this.decoratedComponent(player.name || player.uuid), score: objective && scores?.has(player.name) ? numberText(scores.get(player.name), objective) : '', scoreComponent: objective && scores?.has(player.name) ? numberComponent(scores.get(player.name), objective, 'yellow') : { text: '' } }));
  }
}
