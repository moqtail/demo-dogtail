# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
Writes src/brain.fixture.json: match states, the observations env.py makes of them and a small network's
outputs, so brain.test.ts can check that src/brain.ts sees and thinks the same.
Run: train/.venv/bin/python train/make_fixture.py
"""
import json
import pathlib

import numpy as np
import torch

from env import ACTIONS, DECIDE, OBS, SUBSTEPS, decode, observe, scripted
from sim import SLOTS, Arena

rng = np.random.default_rng(3)
ar = Arena(2, 4, seed=5)
cases = []
for step in range(120):
    turn, boost, fire = decode(scripted(ar, rng, 0.8))
    for _ in range(SUBSTEPS):
        ar.substep(turn, boost, fire, DECIDE / SUBSTEPS)
    if step % 40 != 39:
        continue
    obs = observe(ar)
    for e in range(ar.E):
        for p in range(ar.P):
            plane = lambda q: {'x': ar.x[e, q], 'y': ar.y[e, q], 'a': ar.a[e, q], 'hp': int(ar.hp[e, q]),
                               'shielded': bool(ar.shielded[e, q])}
            me = plane(p) | {'armor': ar.armor[e, p], 'rapid': ar.rapid[e, p], 'cooldown': ar.cooldown[e, p],
                             'deadFor': max(ar.dead_for[e, p], 0)}
            others = [plane(q) for q in range(ar.P) if q != p and ar.alive[e, q]]
            bullets = [{'x': ar.bx[e, q, s], 'y': ar.by[e, q, s], 'a': ar.ba[e, q, s], 'age': ar.bage[e, q, s],
                        'owner': str(q)} for q in range(ar.P) if q != p for s in range(SLOTS) if ar.bon[e, q, s]]
            drops = [{'key': str(i), 'x': ar.px[e, i], 'y': ar.py[e, i], 'kind': ['shield', 'rapid', 'heart'][ar.pkind[e, i]]}
                     for i in range(ar.px.shape[1]) if ar.pttl[e, i] > 0]
            cases.append({'view': {'me': me, 'others': others, 'bullets': bullets, 'drops': drops},
                          'obs': obs[e, p].tolist()})

# A small network of the same shape: forward() doesn't care about the width, and the file stays small.
torch.manual_seed(0)
actor = torch.nn.Sequential(torch.nn.Linear(OBS, 16), torch.nn.Tanh(), torch.nn.Linear(16, 16), torch.nn.Tanh(),
                            torch.nn.Linear(16, ACTIONS))
layers = [m for m in actor if isinstance(m, torch.nn.Linear)]
brain = [{'w': m.weight.detach().numpy().tolist(), 'b': m.bias.detach().numpy().tolist()} for m in layers]
with torch.no_grad():
    logits = actor(torch.tensor([c['obs'] for c in cases[:8]])).numpy().tolist()
out = pathlib.Path(__file__).parent.parent / 'src' / 'brain.fixture.json'
r = lambda v: round(float(v), 6) if isinstance(v, (float, np.floating)) else v
tidy = lambda o: {k: tidy(v) for k, v in o.items()} if isinstance(o, dict) else [tidy(v) for v in o] if isinstance(o, list) else r(o)
out.write_text(json.dumps(tidy({'cases': cases, 'brain': brain, 'logits': logits})))
print(f'{len(cases)} cases -> {out}')
