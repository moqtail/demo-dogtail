# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
Trains a DOGtail pilot with PPO. Each match has 4 planes: 2 flown by the policy being trained and 2
opponents, either the rule-based pilot (env.scripted) or an earlier copy of the policy (self-play).
Run: train/.venv/bin/python train/ppo.py [million steps]   Output: train/out/policy.pt, brain.json
"""
import json
import pathlib
import sys
import time

import numpy as np
import torch
from torch import nn

from env import ACTIONS, DECIDE, OBS, SUBSTEPS, decode, observe, scripted
from sim import Arena

E, P, LEARN = 256, 4, 2  # matches, planes per match, of which the policy flies the first LEARN
T = 128  # decisions per rollout
EPOCHS, MINIBATCH = 4, 8192
GAMMA, LAMBDA, CLIP, ENT, VF, LR = 0.99, 0.95, 0.2, 0.01, 0.5, 3e-4
NOISE = 6.0  # px of error on other planes' positions, as seen over the network
TOTAL = int(float(sys.argv[1] if len(sys.argv) > 1 else 40) * 1e6)
OUT = pathlib.Path(__file__).parent / 'out'


def mlp(out):
    return nn.Sequential(nn.Linear(OBS, 128), nn.Tanh(), nn.Linear(128, 128), nn.Tanh(), nn.Linear(128, out))


class Agent(nn.Module):
    def __init__(self):
        super().__init__()
        self.actor, self.critic = mlp(ACTIONS), mlp(1)

    def act(self, obs, greedy=False):
        logits = self.actor(obs)
        dist = torch.distributions.Categorical(logits=logits)
        a = logits.argmax(-1) if greedy else dist.sample()
        return a, dist.log_prob(a), dist.entropy(), self.critic(obs).squeeze(-1)


def main():
    torch.set_num_threads(8)
    rng = np.random.default_rng(0)
    torch.manual_seed(0)
    OUT.mkdir(exist_ok=True)
    ar = Arena(E, P, seed=1)
    agent = Agent()
    opt = torch.optim.Adam(agent.parameters(), lr=LR, eps=1e-5)
    pool = []  # earlier copies of the policy, for self-play
    rival = Agent()
    N = E * LEARN
    buf = {k: torch.zeros((T, N)) for k in ('logp', 'rew', 'val', 'act', 'live')}
    buf_obs = torch.zeros((T, N, OBS))
    updates = TOTAL // (T * N)
    obs = observe(ar, NOISE, rng)
    t0 = time.time()
    for u in range(updates):
        frac = u / updates
        for g in opt.param_groups:
            g['lr'] = LR * (1 - frac)
        aim = 0.02 * max(0.0, 1 - frac / 0.3)  # a nudge to point at someone, gone after 30%
        # Opponents this rollout: rule-based in some matches, an earlier policy in the rest.
        selfplay = np.zeros(E, bool)
        if pool:
            selfplay = rng.random(E) < min(0.6, 0.1 + frac)
            rival.load_state_dict(pool[rng.integers(len(pool))])
        skill = rng.uniform(0.5, 1.0, (E, 1))
        stats = {'k_s': 0, 'd_s': 0, 'k_p': 0, 'd_p': 0}
        for t in range(T):
            o = torch.from_numpy(obs[:, :LEARN].reshape(N, OBS))
            with torch.no_grad():
                a, logp, _, v = agent.act(o)
            act = scripted(ar, rng, skill)
            if selfplay.any():
                with torch.no_grad():
                    ra, _, _, _ = rival.act(torch.from_numpy(obs[:, LEARN:].reshape(-1, OBS)))
                act[:, LEARN:] = np.where(selfplay[:, None], ra.numpy().reshape(E, P - LEARN), act[:, LEARN:])
            act[:, :LEARN] = a.numpy().reshape(E, LEARN)
            live = ar.alive[:, :LEARN].copy()
            turn, boost, fire = decode(act)
            rew = np.zeros((E, P))
            for _ in range(SUBSTEPS):
                r = ar.substep(turn, boost, fire, DECIDE / SUBSTEPS)
                rew += r['kills'] - r['deaths'] + 0.2 * (r['dealt'] - r['taken']) + 0.1 * r['grabs']
                for key, k in (('k', 'kills'), ('d', 'deaths')):
                    stats[f'{key}_s'] += r[k][~selfplay, :LEARN].sum()
                    stats[f'{key}_p'] += r[k][selfplay, :LEARN].sum()
            obs = observe(ar, NOISE, rng)
            # Aim nudge: the nearest plane straight ahead and in range.
            e = obs[:, :LEARN, 7:11]
            facing = e[..., 0] * np.clip(e[..., 1] / np.maximum(e[..., 3], 1e-6), 0, 1) * (e[..., 3] < 0.75)
            rew[:, :LEARN] += aim * facing
            buf_obs[t] = o
            buf['act'][t], buf['logp'][t], buf['val'][t] = a.float(), logp, v
            buf['rew'][t] = torch.from_numpy(rew[:, :LEARN].reshape(N)).float()
            buf['live'][t] = torch.from_numpy(live.reshape(N)).float()

        # GAE over an endless match (respawns are not episode ends).
        with torch.no_grad():
            nv = agent.act(torch.from_numpy(obs[:, :LEARN].reshape(N, OBS)))[3]
        adv = torch.zeros((T, N))
        last = torch.zeros(N)
        for t in reversed(range(T)):
            nxt = nv if t == T - 1 else buf['val'][t + 1]
            delta = buf['rew'][t] + GAMMA * nxt - buf['val'][t]
            last = delta + GAMMA * LAMBDA * last
            adv[t] = last
        ret = adv + buf['val']

        # PPO update, only on decisions made while alive (a dead plane's choice changes nothing).
        keep = buf['live'].reshape(-1) > 0
        b_obs, b_act = buf_obs.reshape(-1, OBS)[keep], buf['act'].reshape(-1)[keep].long()
        b_logp, b_adv, b_ret = buf['logp'].reshape(-1)[keep], adv.reshape(-1)[keep], ret.reshape(-1)[keep]
        b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)
        n = len(b_obs)
        for _ in range(EPOCHS):
            perm = torch.randperm(n)
            for i in range(0, n, MINIBATCH):
                j = perm[i:i + MINIBATCH]
                logits = agent.actor(b_obs[j])
                dist = torch.distributions.Categorical(logits=logits)
                ratio = (dist.log_prob(b_act[j]) - b_logp[j]).exp()
                pg = -torch.min(ratio * b_adv[j], ratio.clamp(1 - CLIP, 1 + CLIP) * b_adv[j]).mean()
                vloss = ((agent.critic(b_obs[j]).squeeze(-1) - b_ret[j]) ** 2).mean()
                loss = pg + VF * vloss - ENT * dist.entropy().mean()
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(agent.parameters(), 0.5)
                opt.step()

        if u % 10 == 0:
            pool.append({k: v.clone() for k, v in agent.state_dict().items()})
            pool = pool[-12:]
        if u % 5 == 0 or u == updates - 1:
            kd = lambda k, d: f'{stats[k] / max(stats[d], 1):.2f}'
            steps = (u + 1) * T * N
            print(f'{steps / 1e6:6.1f}M steps  {time.time() - t0:5.0f}s  K/D vs rule-based {kd("k_s", "d_s")}'
                  f'  vs self {kd("k_p", "d_p")}  entropy {dist.entropy().mean():.2f}', flush=True)
            torch.save(agent.state_dict(), OUT / 'policy.pt')
    export(agent)


def export(agent):
    """The actor's weights as JSON, for the forward pass in src/brain.ts."""
    layers = [m for m in agent.actor if isinstance(m, nn.Linear)]
    data = [{'w': m.weight.detach().numpy().round(5).tolist(), 'b': m.bias.detach().numpy().round(5).tolist()}
            for m in layers]
    (OUT / 'brain.json').write_text(json.dumps(data))
    print('wrote', OUT / 'brain.json')


if __name__ == '__main__':
    main()
