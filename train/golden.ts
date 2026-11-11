// Copyright 2026 The MOQtail Authors
// SPDX-License-Identifier: Apache-2.0
//
// Plays a dogfight with game.ts's own rules and random inputs, and prints every frame as JSON, so
// test_parity.py can check that sim.py plays it the same way. Run: node train/golden.ts > golden.json
import { findHit, FIRE_COOLDOWN, stepBullets, stepPlane, type Bullet, type Plane } from '../src/game.ts'

let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) // fixed, so runs repeat

const dt = 1 / 30
const planes: Plane[] = [
  { x: 800, y: 500, a: 0, hp: 3 },
  { x: 900, y: 520, a: Math.PI, hp: 3 },
  { x: 850, y: 420, a: Math.PI / 2, hp: 3 },
]
const cooldown = planes.map(() => 0)
let bullets: Bullet[] = []
const frames = []
for (let f = 0; f < 2000; f++) {
  const inputs = planes.map(() => ({
    turn: Math.floor(rand() * 3) - 1,
    boost: rand() < 0.3,
    fire: rand() < 0.6,
  }))
  planes.forEach((p, i) => {
    if (p.hp > 0)
      stepPlane(p, { left: inputs[i]!.turn < 0, right: inputs[i]!.turn > 0, boost: inputs[i]!.boost }, dt)
  })
  planes.forEach((p, i) => {
    cooldown[i]! -= dt
    if (p.hp > 0 && inputs[i]!.fire && cooldown[i]! <= 0) {
      cooldown[i] = FIRE_COOLDOWN
      bullets.push({ x: p.x, y: p.y, a: p.a, age: 0, owner: String(i) })
    }
  })
  bullets = stepBullets(bullets, dt)
  planes.forEach((p, i) => {
    if (p.hp <= 0) return
    const hit = findHit(p, String(i), bullets)
    if (hit >= 0) {
      bullets.splice(hit, 1)
      p.hp--
    }
  })
  frames.push({ inputs, planes: planes.map((p) => ({ ...p })), bullets: bullets.length })
}
console.log(JSON.stringify(frames))
