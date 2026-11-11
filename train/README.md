# Training the aces

The aces that fill quiet rooms are flown by a network trained here with reinforcement learning (PPO). The game only needs its weights, `src/brain.json`; nothing in this folder runs in the browser.

- **Simulator** (`sim.py`): `game.ts`'s rules in numpy, stepping hundreds of matches at once, about 250,000 plane-decisions a second on a laptop. `test_parity.py` plays a recorded dogfight from `game.ts` (`golden.ts`) and checks every frame matches.
- **What a pilot sees** (`env.py`, 73 numbers, relative to its own nose): its health, shields and cooldowns; the nearest 3 planes, 6 enemy bullets and 2 power-ups. Other planes' positions get a few pixels of noise, as they do over the network.
- **What it does**: every 100 ms, one of 12 actions (turn left, none or right × boost × fire).
- **Rewards**: +1 a kill, −1 a death, ±0.2 a hit dealt or taken, +0.1 a power-up, and early on a small nudge for pointing at someone.
- **Opponents**: a rule-based pilot (chases the nearest plane, aims ahead, fires when lined up) and earlier copies of itself.
- **In the browser** (`src/brain.ts`): the same observation and the network's forward pass in plain TypeScript, no ML library. `src/brain.test.ts` checks it against PyTorch on states from the simulator (`make_fixture.py` writes them).

## Levels

The levels weaken the same network at play time, without retraining: blurrier vision of other planes, slower reactions and less certain choices (`LEVELS` in `src/ace.ts`, which `evaluate.py` must match). Kills per death against the rule-based pilot:

| Level              | Kills per death |
| ------------------ | --------------- |
| Easy               | 0.45            |
| Moderate (default) | 0.93            |
| Hard               | 3.14            |

## Run

```bash
python3 -m venv train/.venv && train/.venv/bin/pip install numpy torch
train/.venv/bin/python train/test_parity.py   # simulator matches game.ts
train/.venv/bin/python train/ppo.py 100       # 100M steps, ~25 min on an M4 Pro; writes train/out/
train/.venv/bin/python train/evaluate.py      # each level vs rule-based, fresh matches
cp train/out/brain.json src/brain.json        # ship it
```
