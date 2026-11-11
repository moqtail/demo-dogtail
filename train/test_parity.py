# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""sim.py must play a dogfight exactly as game.ts does. Run: train/.venv/bin/python train/test_parity.py"""
import json
import pathlib
import subprocess

import numpy as np

from sim import Arena

root = pathlib.Path(__file__).parent
frames = json.loads(subprocess.run(['node', str(root / 'golden.ts')], capture_output=True, check=True, text=True).stdout)

arena = Arena(1, 3, powerups=False, respawn=False)
arena.x[0] = [800, 900, 850]
arena.y[0] = [500, 520, 420]
arena.a[0] = [0, np.pi, np.pi / 2]
arena.shield[:] = 0
hits = 0
for f, frame in enumerate(frames):
    turn = np.array([[i['turn'] for i in frame['inputs']]], float)
    boost = np.array([[i['boost'] for i in frame['inputs']]])
    fire = np.array([[i['fire'] for i in frame['inputs']]])
    hits += arena.substep(turn, boost, fire, 1 / 30)['taken'].sum()
    for i, p in enumerate(frame['planes']):
        assert arena.hp[0, i] == p['hp'], (f, i, arena.hp[0, i], p['hp'])
        assert arena.alive[0, i] == (p['hp'] > 0), (f, i)
        if p['hp'] > 0:
            got = (arena.x[0, i], arena.y[0, i], arena.a[0, i])
            assert np.allclose(got, (p['x'], p['y'], p['a']), atol=1e-6), (f, i, got, p)
    assert arena.bon.sum() == frame['bullets'], (f, arena.bon.sum(), frame['bullets'])
print(f'parity ok: {len(frames)} frames, {int(hits)} hits, final hp {[p["hp"] for p in frames[-1]["planes"]]}')
