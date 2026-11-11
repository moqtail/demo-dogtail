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
 * A computer-flown player: aces hosted in a player's tab (main.ts) and the dev bots (bots-worker.ts).
 * It plays by the same rules as a person: its own pos, shots and hit detection on its own track. With a
 * brain it is flown by the trained network (brain.ts); without one it wanders, for load tests.
 */

import { controls, decide, observe, type Brain } from './brain'
import {
  ARMOR,
  FIRE_COOLDOWN,
  maxHpFor,
  PICKUP_RADIUS,
  powerUpsAt,
  predict,
  RAPID,
  RESPAWN_DELAY,
  SPAWN_SHIELD,
  findHit,
  shotLag,
  spawn,
  stepBullets,
  stepPlane,
  wrapDist,
  type Bullet,
  type ClockSync,
  type MetaMsg,
  type Plane,
  type WireMsg,
} from './game'
import type { Senders } from './net'

export class Ace {
  plane: Plane = spawn()
  kills = 0
  deaths = 0
  #bullets: Bullet[] = []
  #shield = SPAWN_SHIELD
  #armor = 0
  #rapid = 0
  #cooldown = 0
  #deadFor = 0
  #turn = 0 // the wandering bot's current turn
  #peers = new Map<string, { p: Plane; seen: number }>()
  #grabbed = new Set<string>()
  #killsSeen = new Set<string>()

  constructor(
    readonly id: string,
    readonly look: Omit<MetaMsg, 'kills' | 'deaths'>,
    readonly room: string,
    readonly brain: Brain | undefined,
    readonly send: Senders,
    readonly clock: ClockSync,
  ) {
    this.meta()
  }

  meta() {
    this.send.sendMeta({ ...this.look, kills: this.kills, deaths: this.deaths })
  }

  #stamp = () => (this.clock.offset === undefined ? undefined : Date.now() + this.clock.offset)

  /** A message from another player, from the network or from this tab. */
  hear(from: string, w: WireMsg) {
    if (w.t === 'pos') this.#peers.set(from, { p: w.p, seen: Date.now() })
    else if (w.t === 'shot')
      this.#bullets.push(...stepBullets([{ ...w, age: 0, owner: from }], shotLag(w.ts, Date.now(), this.clock.offset)))
    else if (w.t === 'grab') this.#grabbed.add(w.k)
    else if (w.t === 'kill' && w.by === this.id && !this.#killsSeen.has(`${from}:${w.n}`)) {
      this.#killsSeen.add(`${from}:${w.n}`) // a kill is sent three times; count it once
      this.kills++
      this.meta()
    }
  }

  /** Every 100 ms: decide, then three 1/30 s frames in main.ts's order, as in training (train/sim.py). */
  tick() {
    const now = Date.now()
    for (const [id, { seen }] of this.#peers) if (now - seen > 3000) this.#peers.delete(id)
    const drops = powerUpsAt(this.room, now + (this.clock.offset ?? 0)).filter((d) => !this.#grabbed.has(d.key))
    let act: { turn: number; boost: boolean; fire: boolean }
    if (this.brain) {
      const others = [...this.#peers.values()]
        .filter(({ p }) => p.hp > 0 && !p.away)
        .map(({ p, seen }) => predict(p, (now - seen) / 1000))
      const me = {
        ...this.plane,
        armor: this.#armor,
        rapid: this.#rapid,
        cooldown: this.#cooldown,
        deadFor: this.#deadFor,
      }
      act = controls(decide(this.brain, observe({ me, others, bullets: this.#bullets, drops })))
    } else {
      if (Math.random() < 0.05) this.#turn = Math.floor(Math.random() * 3) - 1 // now and then: left, straight or right
      act = { turn: this.#turn, boost: false, fire: Math.random() < 0.1 }
    }
    const dt = 0.1 / 3
    for (let f = 0; f < 3; f++) this.#frame(act, drops, dt)
    this.send.sendPos({ ...this.plane, ts: this.#stamp() })
  }

  #frame(act: { turn: number; boost: boolean; fire: boolean }, drops: ReturnType<typeof powerUpsAt>, dt: number) {
    const players = this.#peers.size + 1
    if (this.#deadFor > 0 && (this.#deadFor -= dt) <= 0) {
      this.plane = spawn(
        maxHpFor(players),
        [...this.#peers.values()].map(({ p }) => p),
      )
      this.#shield = SPAWN_SHIELD
    }
    const alive = this.#deadFor <= 0
    this.#shield -= dt
    this.#armor -= dt
    this.#rapid -= dt
    this.plane.shielded = this.#shield > 0 || this.#armor > 0
    const p = this.plane
    const got = alive
      ? drops.find((d) => !this.#grabbed.has(d.key) && wrapDist(p.x, p.y, d.x, d.y) < PICKUP_RADIUS)
      : undefined
    if (got) {
      this.#grabbed.add(got.key)
      for (let k = 0; k < 2; k++) this.send.sendEvent({ t: 'grab', k: got.key })
      if (got.kind === 'shield') this.#armor = ARMOR
      else if (got.kind === 'rapid') this.#rapid = RAPID
      else p.hp = Math.min(p.hp + 1, maxHpFor(players) + 1)
    }
    if (alive) stepPlane(p, { left: act.turn < 0, right: act.turn > 0, boost: act.boost }, dt)
    this.#cooldown -= dt
    if (alive && act.fire && this.#cooldown <= 0) {
      this.#cooldown = this.#rapid > 0 ? FIRE_COOLDOWN / 2 : FIRE_COOLDOWN
      this.#shield = 0
      this.send.sendEvent({ t: 'shot', x: p.x, y: p.y, a: p.a, ts: this.#stamp() })
    }
    this.#bullets = stepBullets(this.#bullets, dt)
    const hit = alive ? findHit(p, this.id, this.#bullets) : -1
    if (hit >= 0) {
      const by = this.#bullets[hit]!.owner
      this.#bullets.splice(hit, 1)
      this.send.sendEvent({ t: 'hit', by })
      if (--p.hp <= 0) {
        this.deaths++
        for (let k = 0; k < 3; k++) this.send.sendEvent({ t: 'kill', by, n: this.deaths })
        this.#deadFor = RESPAWN_DELAY // pos with hp 0 hides the plane meanwhile
        this.meta()
      }
    }
  }
}
