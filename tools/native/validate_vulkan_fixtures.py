#!/usr/bin/env python3
"""Run real Vulkan fixtures and require positive validation-layer activation."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path('vulkan-fixture-results'))
parser.add_argument('--timeout', type=int, default=900)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
env['VK_INSTANCE_LAYERS'] = 'VK_LAYER_KHRONOS_validation'
env['VK_LOADER_DEBUG'] = 'layer,error'
results = []
for fixture in ['actor_vulkan', 'compute_vulkan']:
    command = ['cargo', 'test', '--locked', '--release', '-p', 'pomme-shaderpack',
               '--features', 'vulkan', '--test', fixture, '--', '--ignored', '--nocapture']
    log = args.output / f'{fixture}.log'
    try:
        with log.open('w') as handle:
            status = subprocess.run(command, env=env, stdout=handle, stderr=subprocess.STDOUT,
                                    timeout=args.timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        status = 124
    content = log.read_text(errors='replace')
    activated = bool(re.search(r'Insert instance layer\s+"VK_LAYER_KHRONOS_validation"', content))
    diagnostics = re.findall(r'VUID-[A-Za-z0-9_-]+|Validation Error|ERROR\s*\|\s*(?:LAYER|DRIVER)', content)
    results.append({'fixture': fixture, 'command': command, 'exit_code': status,
                    'validation_status': 'verified' if activated else 'unverified',
                    'validation_errors': len(diagnostics) if activated else None,
                    'passed': status == 0 and activated and not diagnostics,
                    'log': str(log)})
    print(json.dumps(results[-1]), flush=True)
(args.output / 'result.json').write_text(json.dumps({'fixtures': results}, indent=2) + '\n')
sys.exit(0 if all(result['passed'] for result in results) else 1)
