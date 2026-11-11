# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
How good is the trained pilot? Matches of 2 trained vs 2 rule-based pilots (best skill), fresh seeds,
5 minutes each. Run: train/.venv/bin/python train/evaluate.py [policy.pt]
"""
import pathlib
import sys

import numpy as np
import torch

from env import DECIDE, SUBSTEPS, decode, observe, scripted
from ppo import NOISE, Agent
from sim import Arena

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent / 'out' / 'policy.pt')
agent = Agent()
agent.load_state_dict(torch.load(path))
rng = np.random.default_rng(1234)
E, P = 128, 4
ar = Arena(E, P, seed=999)
k = np.zeros(P)
d = np.zeros(P)
for step in range(int(300 / DECIDE)):
    obs = observe(ar, NOISE, rng)
    act = scripted(ar, rng, 1.0)
    with torch.no_grad():
        a = agent.act(torch.from_numpy(obs[:, :2].reshape(-1, obs.shape[-1])))[0]
    act[:, :2] = a.numpy().reshape(E, 2)
    turn, boost, fire = decode(act)
    for _ in range(SUBSTEPS):
        r = ar.substep(turn, boost, fire, DECIDE / SUBSTEPS)
        k += r['kills'].sum(0)
        d += r['deaths'].sum(0)
per = lambda v: v / E / 5  # per plane per minute
print(f'trained:    {per(k[:2]).mean():.2f} kills/min, {per(d[:2]).mean():.2f} deaths/min, K/D {k[:2].sum() / d[:2].sum():.2f}')
print(f'rule-based: {per(k[2:]).mean():.2f} kills/min, {per(d[2:]).mean():.2f} deaths/min, K/D {k[2:].sum() / d[2:].sum():.2f}')
