# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
How good is the trained pilot, at each difficulty? Matches of 2 trained vs 2 rule-based pilots (best
skill), fresh seeds, 5 minutes each. A level weakens the same network without retraining:
  noise: px of error on where it sees other planes (trained with NOISE)
  every: decides every `every` x 100 ms, holding its last action in between (slower reactions)
  temp:  softens its choices; above 1 it takes worse actions more often
Run: train/.venv/bin/python train/evaluate.py [policy.pt]
"""
import pathlib
import sys

import numpy as np
import torch

from env import DECIDE, SUBSTEPS, decode, observe, scripted
from ppo import NOISE, Agent
from sim import Arena

# Must match LEVELS in src/ace.ts.
LEVELS = {
    'easy': {'noise': 80.0, 'every': 4, 'temp': 3.0},
    'moderate': {'noise': 40.0, 'every': 3, 'temp': 2.0},
    'hard': {'noise': NOISE, 'every': 1, 'temp': 1.0},
}


def kd(agent, noise, every, temp, minutes=5, seed=1234):
    rng = np.random.default_rng(seed)
    E, P = 128, 4
    ar = Arena(E, P, seed=seed)
    k = np.zeros(P)
    d = np.zeros(P)
    held = np.zeros((E, 2), np.int64)
    for step in range(int(minutes * 60 / DECIDE)):
        act = scripted(ar, rng, 1.0)
        if step % every == 0:
            obs = observe(ar, noise, rng)
            with torch.no_grad():
                logits = agent.actor(torch.from_numpy(obs[:, :2].reshape(-1, obs.shape[-1]))) / temp
            held = torch.distributions.Categorical(logits=logits).sample().numpy().reshape(E, 2)
        act[:, :2] = held
        turn, boost, fire = decode(act)
        for _ in range(SUBSTEPS):
            r = ar.substep(turn, boost, fire, DECIDE / SUBSTEPS)
            k += r['kills'].sum(0)
            d += r['deaths'].sum(0)
    return k[:2].sum() / d[:2].sum(), k[:2].sum() / E / 2 / minutes, d[:2].sum() / E / 2 / minutes


if __name__ == '__main__':
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent / 'out' / 'policy.pt')
    agent = Agent()
    agent.load_state_dict(torch.load(path))
    for name, lv in LEVELS.items():
        ratio, kills, deaths = kd(agent, **lv)
        print(f'{name:9} {kills:.2f} kills/min, {deaths:.2f} deaths/min, K/D {ratio:.2f} vs the best rule-based pilot')
