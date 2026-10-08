#!/usr/bin/env python3
"""Run sequential, reproducible original-pack fixtures. No presented-FPS claims."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pack', required=True, type=Path)
parser.add_argument('--binary', type=Path, default=Path('target/release/pomme-shaderpack'))
parser.add_argument('--atlas', type=Path)
parser.add_argument('--output', type=Path, default=Path('native-benchmarks'))
parser.add_argument('--preset', default='photon-low-compat')
parser.add_argument('--frames', type=int, default=120)
parser.add_argument('--warmup', type=int, default=60)
args = parser.parse_args()
presets = json.loads(Path(__file__).with_name('photon-presets.json').read_text())
preset = presets[args.preset]
scenes = [
    ('day', 'terrain', 6000, 0, 'static'),
    ('night', 'terrain', 18000, 0, 'static'),
    ('rain', 'terrain', 6000, 1, 'static'),
    ('water', 'water', 6000, 0, 'static'),
    ('cave', 'cave', 6000, 0, 'static'),
    ('orbit', 'terrain', 6000, 0, 'orbit'),
    ('state-changes', 'terrain', 6000, 0, 'state-changes'),
]
summary = {'measurement': 'serialized offscreen frames, excludes presentation; not GTX 1650 Ti qualification', 'preset': args.preset, 'runs': []}
for name, scene, time, rain, scenario in scenes:
    output = args.output / name
    command = [str(args.binary.resolve()), '--pack', str(args.pack.resolve()), '--profile', preset['profile'], '--width', str(preset['resolution'][0]), '--height', str(preset['resolution'][1]), '--frames', str(args.frames), '--warmup', str(args.warmup), '--scene', scene, '--time', str(time), '--rain', str(rain), '--scenario', scenario, '--output', str(output)]
    for option in preset['options']:
        command.extend(['--option', option])
    if args.atlas:
        command.extend(['--atlas', str(args.atlas.resolve())])
    print('Running', name, flush=True)
    subprocess.run(command, check=True)
    report = json.loads((output / 'benchmark.json').read_text())
    walls = sorted(s['wall_ms'] for s in report['samples'])
    gpu = {}
    for sample in report['samples']:
        for timing in sample['passes']:
            gpu.setdefault(timing['pass'], []).append(timing['gpu_ms'])
    summary['runs'].append({'name': name, 'command': command, 'renderer': report['capabilities']['renderer'], 'pack_sha256': report['pack_sha256'], 'median_wall_ms': statistics.median(walls), 'p95_wall_ms': walls[min(len(walls)-1, int(len(walls)*.95))], 'mean_gpu_ms_by_pass': {p: statistics.mean(t) for p, t in gpu.items()}, 'raw_report': str(output / 'benchmark.json')})
args.output.mkdir(parents=True, exist_ok=True)
(args.output / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
