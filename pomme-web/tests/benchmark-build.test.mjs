import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentity } from '../scripts/benchmark.mjs';

test('an extracted benchmark records its packaged source commit without claiming current files are clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pomme-build-identity-'));
  try {
    const commit = '6f866bbf7e4b175abd99c75e87d27985c148ee87';
    await writeFile(join(root, 'BUILD.json'), JSON.stringify({ commit, modified: false }));
    assert.deepEqual(await buildIdentity(root), { commit, workingTreeDirty: null, source: 'packaged BUILD.json', packagedSourceDirtyAtBuild: false });
    await writeFile(join(root, 'BUILD.json'), JSON.stringify({ commit, modified: true }));
    assert.equal((await buildIdentity(root)).packagedSourceDirtyAtBuild, true);
    await writeFile(join(root, 'BUILD.json'), JSON.stringify({ commit: 'unknown', modified: false }));
    assert.deepEqual(await buildIdentity(root), { commit: null, workingTreeDirty: null });
    await writeFile(join(root, 'BUILD.json'), 'x'.repeat(16385));
    assert.deepEqual(await buildIdentity(root), { commit: null, workingTreeDirty: null });
  } finally { await rm(root, { recursive: true }); }
});
