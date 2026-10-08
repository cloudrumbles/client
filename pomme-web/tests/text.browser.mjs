import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync, zipSync } from '../vendor/fflate.js';

const encode = value => new TextEncoder().encode(JSON.stringify(value));
let files, nativeAssets = false;
if (process.env.POMME_MINECRAFT_JAR) {
  files = unzipSync(new Uint8Array(await readFile(process.env.POMME_MINECRAFT_JAR)), { filter: entry => /^assets\/minecraft\/lang\/en_us\.json$/.test(entry.name) });
  assert.ok(files['assets/minecraft/lang/en_us.json'], 'The private client JAR must contain English language data.');
  nativeAssets = true;
} else files = { 'assets/minecraft/lang/en_us.json': encode({ 'test.joined': '%s joined the test', 'test.block': 'Changed %s, %s, %s' }) };
const base = zipSync(files), overlay = zipSync({ 'assets/custom/lang/en_us.json': encode({ 'test.override': 'Imported %1$s, %1$s!', 'test.joined': '%s joined with an override' }) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__text-base.zip', route => route.fulfill({ body: Buffer.from(base), contentType: 'application/zip' }));
  await page.route('**/__text-overlay.zip', route => route.fulfill({ body: Buffer.from(overlay), contentType: 'application/zip' }));
  await page.goto(new URL('/src/text.js', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async ({ nativeAssets }) => {
    const { setLanguage, textComponent, renderTextComponent } = await import('/src/text.js');
    const { textComponent: protocolText } = await import('/src/minecraft.js');
    const { loadResourcePack } = await import('/src/assets.js');
    const registry = { blocks: [{ name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' }], items: [] };
    const bytes = async path => new Uint8Array(await (await fetch(path)).arrayBuffer());
    const base = await bytes('/__text-base.zip'), overlay = await bytes('/__text-overlay.zip');
    const imported = await loadResourcePack(base, { registry });
    const status = setLanguage(imported.languages);
    const joined = textComponent({ translate: nativeAssets ? 'multiplayer.player.joined' : 'test.joined', with: [{ text: 'Alex' }] });
    const changed = textComponent({ translate: nativeAssets ? 'commands.setblock.success' : 'test.block', with: [12, 64, -7] });
    const container = nativeAssets ? protocolText({ translate: 'container.chest' }) : protocolText({ translate: 'test.joined', with: ['Alex'] });
    if (nativeAssets && (joined !== 'Alex joined the game' || changed !== 'Changed the block at 12, 64, -7' || container !== 'Chest')) throw new Error(`Private JAR translation mismatch: ${joined} | ${changed} | ${container}`);
    const layered = await loadResourcePack([base, overlay], { registry }); setLanguage(layered.languages);
    const stacked = textComponent({ translate: 'test.override', with: ['Alex'] });
    if (stacked !== 'Imported Alex, Alex!') throw new Error('Namespaced server pack translations must override in stack order.');
    const preserved = nativeAssets ? textComponent({ translate: 'container.chest' }) : textComponent({ translate: 'test.block', with: [1, 2, 3] });
    if (preserved !== (nativeAssets ? 'Chest' : 'Changed 1, 2, 3')) throw new Error('Overlay must preserve unrelated base language keys.');
    document.body.replaceChildren(); const element = document.createElement('div'); document.body.append(element);
    element.style.font = '20px monospace'; element.style.padding = '30px';
    renderTextComponent(element, { translate: 'test.override', color: 'gold', with: [{ text: '<img src=x onerror=alert(1)>', color: 'green', bold: true }] });
    if (element.querySelector('img') || element.textContent !== 'Imported <img src=x onerror=alert(1)>, <img src=x onerror=alert(1)>!') throw new Error('Chat components must render literal safe text nodes.');
    const green = [...element.children].filter(span => getComputedStyle(span).color === 'rgb(85, 255, 85)' && getComputedStyle(span).fontWeight === '700').length;
    if (green !== 2) throw new Error('Styled translation arguments must retain inherited/native colors.');
    setLanguage(null); if (textComponent({ translate: 'test.override', with: ['Alex'] }) !== 'test.override') throw new Error('Pack removal must clear imported translations.');
    return { nativeAssets, entries: status.entries, joined, changed, container, stacked, preserved, styledArguments: green, literalSafe: true };
  }, { nativeAssets });
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/text-rendering.png' });
  await writeFile('test-results/text-rendering.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
