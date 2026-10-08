#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { importLevelDat } from '../src/anvil.js';
import { identifyBenchmarkAdapter, qualifyBenchmark } from '../src/benchmark-result.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const help = `Run a fixed 30-second Pomme camera route on saved Minecraft terrain.

  npm run benchmark -- --jar /path/client.jar --region /path/r.0.0.mca --level /path/level.dat --width 1280 --height 720 --quality balanced --scale 1

Options:
  --jar PATH             Private local client JAR or resource pack ZIP
  --region PATH          Saved r.x.z.mca file; repeat for up to 64 regions
  --level PATH           Optional level.dat, including saved-world version/spawn
  --version VERSION      Native registry version; inferred from client JAR
  --width N --height N   Output pixels, default 1280 by 720 (device scale 1)
  --quality PRESET       low, balanced, or high; default balanced
  --scale N              Fixed render scale in 0.5..1; default 1
  --browser PATH         Chromium executable (or CHROMIUM_PATH)
  --url URL              Existing client URL; otherwise start a local server
  --headless             Explicitly run without a browser window
  --no-sandbox           Explicit Chromium option for container environments
  --software-smoke       Permit SwiftShader for harness validation only
  --output PATH          JSON result, default test-results/hardware-benchmark.json
                        Use - to write the complete JSON to stdout
  --help                Show this help

Hardware mode requires imported assets/regions and rejects software adapters.
Only an exposed NVIDIA GeForce GTX 1650 Ti model with measured frame and GPU
budgets can verify the target. Anonymous hardware measurements remain useful.
Exit codes: 0 target verified or software harness passed; 2 target unverified;
1 invalid run. Original assets are read locally and never included in results.`;

export function parseBenchmarkArguments(args) {
  const options = { width: 1280, height: 720, quality: 'balanced', scale: 1, regions: [], output: 'test-results/hardware-benchmark.json', browser: process.env.CHROMIUM_PATH };
  const flags = new Map([['--headless', 'headless'], ['--no-sandbox', 'noSandbox'], ['--software-smoke', 'softwareSmoke'], ['--help', 'help']]);
  const values = new Map([['--jar', 'jar'], ['--region', 'region'], ['--level', 'level'], ['--version', 'version'], ['--width', 'width'], ['--height', 'height'], ['--quality', 'quality'], ['--scale', 'scale'], ['--browser', 'browser'], ['--url', 'url'], ['--output', 'output']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) { options[flags.get(arg)] = true; continue; }
    if (!values.has(arg)) throw new Error(`Unknown option ${arg}. Use --help.`);
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    const name = values.get(arg);
    if (name === 'region') options.regions.push(resolve(value));
    else options[name] = ['width', 'height', 'scale'].includes(name) ? Number(value) : value;
  }
  if (options.help) return options;
  for (const dimension of ['width', 'height']) if (!Number.isInteger(options[dimension]) || options[dimension] < 128 || options[dimension] > 8192) throw new Error(`${dimension} must be an integer in 128..8192.`);
  if (!['low', 'balanced', 'high'].includes(options.quality)) throw new Error('quality must be low, balanced, or high.');
  if (!Number.isFinite(options.scale) || options.scale < .5 || options.scale > 1) throw new Error('scale must be in 0.5..1.');
  if (options.regions.length > 64 || options.regions.some(path => !/^r\.-?\d+\.-?\d+\.mca$/i.test(basename(path)))) throw new Error('Pass at most 64 regions with their original r.x.z.mca filenames.');
  if (!options.softwareSmoke && (!options.jar || !options.regions.length)) throw new Error('Hardware verification requires --jar and at least one --region. Use --software-smoke for a demo harness check.');
  if (options.level && basename(options.level) !== 'level.dat') throw new Error('Keep the original level.dat filename.');
  if (options.url && !['http:', 'https:'].includes(new URL(options.url).protocol)) throw new Error('url must use HTTP or HTTPS.');
  return options;
}

async function describeFile(path, maxBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${basename(path)} is missing or exceeds its size limit.`);
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name: basename(path), bytes: info.size, sha256: hash.digest('hex') };
}

async function readSource(options) {
  const source = { assets: null, regions: [], level: null, registryVersion: null, worldVersion: null, dataVersion: null };
  if (options.jar) {
    source.assets = await describeFile(options.jar, 256 * 1024 * 1024);
    const bytes = await readFile(options.jar);
    const manifest = unzipSync(bytes, { filter: entry => entry.name === 'version.json' && entry.originalSize <= 1024 * 1024 })['version.json'];
    if (manifest) {
      const version = JSON.parse(new TextDecoder().decode(manifest));
      source.assets.version = version.id ?? null; source.assets.dataVersion = version.world_version ?? null;
    }
  }
  for (const path of options.regions) source.regions.push(await describeFile(path, 128 * 1024 * 1024));
  if (source.regions.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024) throw new Error('Region files exceed the importer’s 256 MB total limit.');
  if (options.level) {
    source.level = await describeFile(options.level, 16 * 1024 * 1024);
    const metadata = await importLevelDat(await readFile(options.level));
    source.worldVersion = metadata.version || null; source.dataVersion = metadata.dataVersion ?? null;
    source.worldName = metadata.name; source.spawn = metadata.spawn;
  }
  source.registryVersion = options.version ?? source.assets?.version ?? source.worldVersion ?? '1.20.4';
  if (!['1.20.4', '1.21.11', '26.1'].includes(source.registryVersion)) throw new Error(`No browser registry is built for ${source.registryVersion}. Available: 1.20.4, 1.21.11, 26.1.`);
  if (source.assets?.version && source.assets.version !== source.registryVersion) throw new Error('The client JAR version differs from the requested native registry.');
  return source;
}

async function startLocalServer() {
  const probe = createServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], { cwd: project, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = null; child.once('error', error => { failure = error; });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure || child.exitCode !== null) { child.kill(); throw failure ?? new Error('The local benchmark server stopped.'); }
    try { const response = await fetch(url); if (response.ok) return { child, url }; } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  child.kill(); throw new Error('Local server startup timed out. Run npm run build first.');
}

export async function buildIdentity(directory = project) {
  const run = promisify(execFile);
  try {
    const [commit, status] = await Promise.all([run('git', ['rev-parse', 'HEAD'], { cwd: directory }), run('git', ['status', '--porcelain'], { cwd: directory })]);
    return { commit: commit.stdout.trim(), workingTreeDirty: Boolean(status.stdout.trim()) };
  } catch {
    try {
      const path = resolve(directory, 'BUILD.json');
      if ((await stat(path)).size > 16384) throw new Error('Build manifest is too large.');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (!/^[0-9a-f]{40}$/.test(manifest.commit) || typeof manifest.modified !== 'boolean') throw new Error('Build manifest has no valid source identity.');
      return { commit: manifest.commit, workingTreeDirty: null, source: 'packaged BUILD.json', packagedSourceDirtyAtBuild: manifest.modified };
    } catch { return { commit: null, workingTreeDirty: null }; }
  }
}

export async function runBenchmark(options) {
  const errors = [];
  let browser, localServer, source = null, result = null, sourceImport = null, observedAdapter = null, interrupted = false;
  const requestedSettings = { width: options.width, height: options.height, quality: options.quality, scale: options.scale };
  const onInterrupt = () => { interrupted = true; errors.push('The benchmark was interrupted.'); void browser?.close().catch(() => {}); localServer?.child.kill(); };
  const checkInterrupted = () => { if (interrupted) throw new Error('The benchmark was interrupted.'); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  try {
    source = await readSource(options);
    checkInterrupted();
    if (!options.url) localServer = await startLocalServer();
    checkInterrupted();
    const softwareArgs = options.softwareSmoke ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [];
    browser = await chromium.launch({ headless: Boolean(options.headless), ...(options.browser ? { executablePath: options.browser } : {}), args: [...(options.noSandbox ? ['--no-sandbox'] : []), ...softwareArgs] });
    checkInterrupted();
    const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(180000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('favicon.ico') && !/\/favicon\.ico(?:\?|$)/.test(message.location().url)) errors.push(message.text());
    });
    await page.goto(options.url ?? localServer.url);
    await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.engine));
    if (await page.locator('html').getAttribute('data-engine') !== 'ready') throw new Error(await page.locator('#error').textContent());
    observedAdapter = await page.evaluate(() => window.pomme.renderer.stats().adapterInfo);
    const detected = identifyBenchmarkAdapter(observedAdapter);
    if (!options.softwareSmoke && !detected.hardwareAdapter) throw new Error(`Hardware benchmark rejected this adapter: ${detected.evidence}. Use --software-smoke only to validate the harness.`);
    await page.evaluate(settings => {
      document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false;
      document.querySelector('#quality').value = settings.quality;
      const resolution = document.querySelector('#resolution'); resolution.value = String(settings.scale); resolution.dispatchEvent(new Event('input'));
      for (const [id, multiple] of [['benchmark-assets', false], ['benchmark-regions', true]]) {
        const input = document.createElement('input'); input.type = 'file'; input.id = id; input.multiple = multiple; input.hidden = true; document.body.append(input);
      }
    }, requestedSettings);
    if (options.jar) {
      process.stderr.write(`Loading ${basename(options.jar)} locally…\n`);
      await page.locator('#benchmark-assets').setInputFiles(resolve(options.jar));
      source.assetImport = await page.evaluate(async version => {
        const pack = await window.pomme.loadPack(document.querySelector('#benchmark-assets').files[0], { version });
        return { tileCount: pack?.atlas?.tiles.length ?? 0, materialCount: pack?.materials?.size ?? 0, diagnostics: pack?.diagnostics ?? null };
      }, source.registryVersion);
    }
    if (options.regions.length) {
      process.stderr.write(`Importing ${options.regions.length} saved region files…\n`);
      await page.locator('#benchmark-regions').setInputFiles([...options.regions, ...(options.level ? [resolve(options.level)] : [])]);
      sourceImport = await page.evaluate(async version => window.pomme.importFiles([...document.querySelector('#benchmark-regions').files], { version }), source.registryVersion);
    }
    await page.waitForFunction(() => window.pomme.ready && window.pomme.renderer.stats().totalChunks > 0);
    const actualVersion = await page.evaluate(() => window.pomme.registry?.version?.minecraftVersion ?? null);
    if (options.regions.length && actualVersion !== source.registryVersion) throw new Error(`Loaded registry ${actualVersion} differs from requested ${source.registryVersion}.`);
    source.actualRegistryVersion = actualVersion;
    process.stderr.write(`Running the 30-second fixed route (${options.width}×${options.height}, ${options.quality}, scale ${options.scale})…\n`);
    await page.evaluate(() => window.pomme.startBenchmark());
    await page.waitForFunction(() => window.pomme.benchmark || document.documentElement.dataset.engine === 'error', null, { timeout: 90000 });
    result = await page.evaluate(() => window.pomme.benchmark);
    if (!result) throw new Error(await page.locator('#error').textContent() || 'The renderer stopped before exporting the benchmark.');
  } catch (error) {
    errors.push(error.message);
  } finally {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    await browser?.close().catch(() => {});
    localServer?.child.kill();
  }
  return {
    schemaVersion: 1, timestamp: new Date().toISOString(), harness: 'pomme-web/scripts/benchmark.mjs',
    softwareSmoke: Boolean(options.softwareSmoke), headless: Boolean(options.headless), browserExecutable: options.browser ? basename(options.browser) : 'Playwright Chromium',
    build: await buildIdentity(), adapter: observedAdapter, source, sourceImport, requestedSettings,
    qualification: qualifyBenchmark(result, { softwareSmoke: options.softwareSmoke, errors, source, requestedSettings }),
    errors, result,
  };
}

async function main() {
  const options = parseBenchmarkArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${help}\n`); return; }
  const report = await runBenchmark(options), json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output === '-') process.stdout.write(json);
  else {
    const output = resolve(options.output); await mkdir(dirname(output), { recursive: true }); await writeFile(output, json);
    process.stdout.write(`${report.qualification.status}: ${output}\n`);
    if (report.qualification.frames) process.stdout.write(`${report.qualification.frames.averageFps.toFixed(2)} average FPS; p95 ${report.qualification.frames.p95Ms.toFixed(2)} ms; target verified: ${report.qualification.targetVerified}\n`);
  }
  for (const error of report.errors) process.stderr.write(`${error}\n`);
  process.exitCode = report.qualification.targetVerified || options.softwareSmoke && report.qualification.harnessValid ? 0 : report.qualification.harnessValid ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
