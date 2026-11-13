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
  allies,
  RoundKills,
  type Team,
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

/**
 * How good an ace is: the same network, weakened at play time (train/evaluate.py measures each against
 * the rule-based pilot it trained with, and must use the same numbers).
 *   noise: px of error on where it sees other planes; every: decides every `every` x 100 ms, holding
 *   its last action in between; temp: above 1, worse actions come up more often.
 */
export const LEVELS = {
  easy: { noise: 80, every: 4, temp: 3 }, // kills per death vs the rule-based pilot: 0.45
  moderate: { noise: 40, every: 3, temp: 2 }, // 0.93
  hard: { noise: 6, every: 1, temp: 1 }, // 3.14
}
export type Level = keyof typeof LEVELS

/** Gaussian noise (Box-Muller). */
const gauss = (sd: number) => sd * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

export class Ace {
  plane: Plane = spawn()
  kills = 0
  deaths = 0
  /** Its side in a team room; the hosting tab sets it. */
  team: Team = ''
  #roundKills = new RoundKills()
  #teams = new Map<string, Team | undefined>()
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
  #ticks = 0
  #act = { turn: 0, boost: false, fire: false } // held between decisions

  constructor(
    readonly id: string,
    readonly look: Omit<MetaMsg, 'kills' | 'deaths'>,
    readonly room: string,
    readonly brain: Brain | undefined,
    readonly send: Senders,
    readonly clock: ClockSync,
    readonly level: Level = 'hard',
  ) {
    this.meta()
  }

  /** Moves to the other side to even them out; its kills this round stay behind, as a person's do. */
  switchTo(team: Team) {
    this.team = team
    this.#roundKills.kills = 0
    this.meta()
  }

  meta() {
    const { round, kills: rk } = this.#roundKills.at(this.#now())
    this.send.sendMeta({ ...this.look, kills: this.kills, deaths: this.deaths, team: this.team, round, rk })
  }

  #now = () => Date.now() + (this.clock.offset ?? 0)
  #ally = (id: string) => allies(this.team, this.#teams.get(id))

  #stamp = () => (this.clock.offset === undefined ? undefined : Date.now() + this.clock.offset)

  /** A message from another player, from the network or from this tab. */
  hear(from: string, w: WireMsg) {
    if (w.t === 'pos') this.#peers.set(from, { p: w.p, seen: Date.now() })
    else if (w.t === 'meta') this.#teams.set(from, w.m.team)
    else if (w.t === 'shot')
      this.#bullets.push(...stepBullets([{ ...w, age: 0, owner: from }], shotLag(w.ts, Date.now(), this.clock.offset)))
    else if (w.t === 'grab') this.#grabbed.add(w.k)
    else if (w.t === 'kill' && w.by === this.id && !this.#killsSeen.has(`${from}:${w.n}`)) {
      this.#killsSeen.add(`${from}:${w.n}`) // a kill is sent three times; count it once
      this.kills++
      this.#roundKills.at(this.#now()).kills++
      this.meta()
    }
  }

  /** Every 100 ms: decide, then three 1/30 s frames in main.ts's order, as in training (train/sim.py). */
  tick() {
    const now = Date.now()
    for (const [id, { seen }] of this.#peers) if (now - seen > 3000) this.#peers.delete(id)
    const drops = powerUpsAt(this.room, now + (this.clock.offset ?? 0)).filter((d) => !this.#grabbed.has(d.key))
    const { noise, every, temp } = LEVELS[this.level]
    let act = this.#act
    if (this.brain && this.#ticks++ % every === 0) {
      // Teammates are left out: it neither chases them nor dodges their bullets.
      const others = [...this.#peers]
        .filter(([id, { p }]) => p.hp > 0 && !p.away && !this.#ally(id))
        .map(([, peer]) => peer)
        .map(({ p, seen }) => predict(p, (now - seen) / 1000))
        .map((p) => ({ ...p, x: p.x + gauss(noise), y: p.y + gauss(noise) }))
      const me = {
        ...this.plane,
        armor: this.#armor,
        rapid: this.#rapid,
        cooldown: this.#cooldown,
        deadFor: this.#deadFor,
      }
      const bullets = this.#bullets.filter((b) => !this.#ally(b.owner))
      act = this.#act = controls(decide(this.brain, observe({ me, others, bullets, drops }), Math.random, temp))
    } else if (!this.brain) {
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
    const hit = alive ? findHit(p, this.id, this.#bullets, this.#ally) : -1
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
