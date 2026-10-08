#!/usr/bin/env python3
"""Inspect pinned original Photon compute captures; never infer hardware FPS."""
import argparse
import hashlib
import json
import math
import pathlib
import re
import struct

p = argparse.ArgumentParser()
p.add_argument('--directory', type=pathlib.Path, required=True)
p.add_argument('--revision', required=True)
p.add_argument('--binary', type=pathlib.Path, required=True)
p.add_argument('--frames', type=int, required=True)
p.add_argument('--native', action='store_true')
a = p.parse_args()
data = json.loads((a.directory / ('vulkan-live.json' if a.native else 'vulkan.json')).read_text())
assert data['revision'] == a.revision, data['revision']
samples = data['samples']
assert len(samples) == a.frames
assert 'llvmpipe' in data['device'], data['device']
pack_hash = data['pack_hash'] if a.native else data['manifest']['source_hash']
assert pack_hash == 'c286e149eed07ca55685a0d1b7df49b45921b20401bb9ffb2f9baea9c57a2845'
for s in samples:
    dispatches = s['compute_dispatches']
    assert any(d['program'] == 'deferred4_a' and d['groups'] == [1, 1, 1]
               and d['local_size'] == [256, 1, 1] and d['storage_images'] == ['colorimg4']
               for d in dispatches), dispatches
program = next(c for c in data['compute_programs'] if c['program'] == 'deferred4_a')
assert program['shared_memory_logical_bytes'] == 27648
assert program['shared_memory_driver_allocation_bytes'] is None
log = (a.directory / ('client.log' if a.native else 'validation.log')).read_text(errors='replace')
assert re.search(r'Insert instance layer "VK_LAYER_KHRONOS_validation"', log), 'activation unproven'
errors = re.findall(r'VUID-[^\s]+|Validation Error|ERROR.*VK_LAYER', log)
assert not errors, errors
out = dict(revision=a.revision, device=data['device'], samples=len(samples), pack_hash=pack_hash,
           compute_programs=data['compute_programs'], last_dispatch=samples[-1]['compute_dispatches'],
           validation_status='verified', validation_errors=0, physical_GTX_1650_Ti_tested=False,
           binary_sha256=hashlib.sha256(a.binary.read_bytes()).hexdigest(),
           measured_scope=data['measurement'])
if a.native:
    last = samples[-1]
    out['last_input'] = {k: last[k] for k in ['camera', 'world_time', 'world_day', 'rain', 'world_revision']}
    out['last_geometry_stages'] = last['geometry_stages']
    out['last_geometry_preparation'] = last['geometry_preparation']
    out['history_invalidations'] = [samples[0]['history_invalidations'], last['history_invalidations']]
else:
    out['invalidations'] = data['invalidations']
    image = json.loads((a.directory / 'colortex4.json').read_text())
    assert image['revision'] == a.revision and image['format'] == 'R16G16B16A16Sfloat', image
    width, height, depth = image['extent']
    assert depth == 1 and height > 11
    raw = (a.directory / 'colortex4.bin').read_bytes()
    assert len(raw) == width * height * 8
    values = [list(struct.unpack_from('<eeee', raw, 8 * (row * width + width - 1))) for row in range(2, 12)]
    assert all(math.isfinite(x) for row in values for x in row)
    assert any(abs(x) > .00001 for row in values for x in row[:3])
    out['original_photon_metadata_rows_2_to_11'] = values
    out['metadata_finite_nonzero'] = True
(a.directory / 'inspection.json').write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps({k: out[k] for k in ['revision', 'device', 'samples', 'validation_status', 'binary_sha256']}, indent=2))
