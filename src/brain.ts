/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A pilot trained with reinforcement learning (train/): what it sees, and the network that picks what
 * to do. observe() must match train/env.py's observe() number for number; brain.test.ts checks it.
 */

import {
  ARMOR,
  FIRE_COOLDOWN,
  H,
  MAX_HP,
  RAPID,
  RESPAWN_DELAY,
  W,
  wrapDelta,
  type Bullet,
  type Plane,
  type PowerUp,
} from './game'

const K_ENEMIES = 3
const K_BULLETS = 6
const K_POWERS = 2

/** One dense layer: weights [out][in] and biases [out], from train/ppo.py's export. */
export type Brain = { w: number[][]; b: number[] }[]

/** What a bot knows about the match: its own plane and timers, and the rest as seen on the network. */
export type View = {
  me: Plane & { armor: number; rapid: number; cooldown: number; deadFor: number }
  /** Other live planes. */
  others: Plane[]
  /** Other planes' bullets. */
  bullets: Bullet[]
  drops: PowerUp[]
}

/** Nearest first, at most k, with the offset to each across the wrap. */
function nearest<T extends { x: number; y: number }>(me: Plane, items: T[], k: number) {
  return items
    .map((it) => {
      const dx = wrapDelta(me.x, it.x, W)
      const dy = wrapDelta(me.y, it.y, H)
      return { it, dx, dy, d: Math.hypot(dx, dy) }
    })
    .sort((p, q) => p.d - q.d)
    .slice(0, k)
}

export function observe(v: View): number[] {
  const { me } = v
  const c = Math.cos(me.a)
  const s = Math.sin(me.a)
  const rot = (dx: number, dy: number) => [dx * c + dy * s, -dx * s + dy * c] as const
  const dead = me.deadFor > 0
  const out = [
    me.hp / (MAX_HP + 1),
    me.shielded ? 1 : 0,
    Math.max(me.armor, 0) / ARMOR,
    Math.max(me.rapid, 0) / RAPID,
    Math.max(me.cooldown, 0) / FIRE_COOLDOWN,
    dead ? 1 : 0,
    Math.min(Math.max(me.deadFor, 0), RESPAWN_DELAY) / RESPAWN_DELAY,
  ]
  const pad = (n: number, per: number) => out.push(...new Array<number>((n * per) | 0).fill(0))
  const enemies = nearest(me, v.others, K_ENEMIES)
  for (const { it, dx, dy, d } of enemies) {
    const [rx, ry] = rot(dx, dy)
    out.push(1, rx / 800, ry / 800, d / 800, Math.cos(it.a - me.a), Math.sin(it.a - me.a), it.hp / (MAX_HP + 1))
    out.push(it.shielded ? 1 : 0)
  }
  pad(K_ENEMIES - enemies.length, 8)
  const bullets = nearest(me, v.bullets, K_BULLETS)
  for (const { it, dx, dy } of bullets) {
    const [rx, ry] = rot(dx, dy)
    out.push(1, rx / 400, ry / 400, Math.cos(it.a - me.a), Math.sin(it.a - me.a))
  }
  pad(K_BULLETS - bullets.length, 5)
  const drops = nearest(me, v.drops, K_POWERS)
  for (const { it, dx, dy } of drops) {
    const [rx, ry] = rot(dx, dy)
    out.push(
      1,
      rx / 800,
      ry / 800,
      it.kind === 'shield' ? 1 : 0,
      it.kind === 'rapid' ? 1 : 0,
      it.kind === 'heart' ? 1 : 0,
    )
  }
  pad(K_POWERS - drops.length, 6)
  return out
}

/** The network's scores for the 12 actions: dense layers with tanh between them. */
export function forward(brain: Brain, obs: number[]): number[] {
  let x = obs
  brain.forEach((layer, i) => {
    x = layer.w.map((row, o) => row.reduce((sum, w, j) => sum + w * x[j]!, layer.b[o]!))
    if (i < brain.length - 1) x = x.map(Math.tanh)
  })
  return x
}

/**
 * An action, drawn from the network's odds as in training (a pilot that always takes the top one is
 * easy to read). A `temp` above 1 evens the odds, so worse actions come up more often. `rand` is for tests.
 */
export function decide(brain: Brain, obs: number[], rand = Math.random, temp = 1): number {
  const logits = forward(brain, obs).map((l) => l / temp)
  const top = Math.max(...logits)
  const odds = logits.map((l) => Math.exp(l - top))
  let r = rand() * odds.reduce((a, b) => a + b, 0)
  for (let i = 0; i < odds.length; i++) if ((r -= odds[i]!) <= 0) return i
  return odds.length - 1
}

/** Action index to controls, as train/env.py's decode(). */
export const controls = (act: number) => ({ turn: (act % 3) - 1, boost: Math.floor(act / 3) % 2 === 1, fire: act >= 6 })
