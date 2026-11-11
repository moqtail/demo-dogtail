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
 * Bots, run by bots.html (dev server only: /bots.html?room=<room>&n=<count>[&brain]). Each bot is a
 * full player on its own connection: pos at 10 Hz, meta every 2 s, and its own hit detection so real
 * players can shoot it down. Load-test bots wander and fire about once a second; with `brain`, they
 * are aces flown by the network trained in train/ (brain.json).
 */

import {
  ARMOR,
  COLORS,
  FIRE_COOLDOWN,
  PICKUP_RADIUS,
  powerUpsAt,
  predict,
  RAPID,
  RESPAWN_DELAY,
  wrapDist,
  PIC,
  packPic,
  PILOTS,
  maxHpFor,
  SPAWN_SHIELD,
  findHit,
  shotLag,
  spawn,
  stepBullets,
  stepPlane,
  type Bullet,
  type Plane,
} from './game'
import { connect, syncClock } from './net'
import { controls, decide, observe, type Brain } from './brain'
import trained from './brain.json'

// In a worker, so the bots keep full speed while their tab is in the background (browsers throttle
// timers in background tabs, not in workers). The page sends { room, n, relay, certHash } to start them.
let room = ''
const clock = syncClock()
const stamp = () => (clock.offset === undefined ? undefined : Date.now() + clock.offset)
let connected = 0
let failed = 0
let lastError = ''
let received = 0

async function bot(i: number, relay: string, certHash: string, brain: Brain | undefined) {
  const me = Math.random().toString(16).slice(2, 8)
  let plane: Plane = spawn()
  let bullets: Bullet[] = []
  let [shield, armor, rapid, cooldown, deadFor, deaths, turn, kills] = [SPAWN_SHIELD, 0, 0, 0, 0, 0, 0, 0]
  const killsSeen = new Set<string>() // a kill is sent three times; count it once, as main.ts does
  const peers = new Map<string, { p: Plane; seen: number }>() // other players' last pos
  const grabbed = new Set<string>()
  const net = await connect(relay, room, me, certHash, {
    onPos: (id, p) => {
      received++
      peers.set(id, { p, seen: Date.now() })
    },
    onMeta: () => void received++,
    onEvent: (id, m) => {
      received++
      if (m.t === 'shot')
        bullets.push(...stepBullets([{ ...m, age: 0, owner: id }], shotLag(m.ts, Date.now(), clock.offset)))
      if (m.t === 'grab') grabbed.add(m.k)
      if (m.t === 'kill' && m.by === me && !killsSeen.has(`${id}:${m.n}`)) {
        killsSeen.add(`${id}:${m.n}`)
        kills++
        meta()
      }
    },
  })
  connected++
  const meta = () =>
    net.sendMeta({
      name: brain ? `ace-${i}` : `bot-${i}`,
      color: COLORS[i % COLORS.length]!,
      pilot: brain ? '🤖' : PILOTS[i % PILOTS.length]!,
      kills,
      deaths,
    })
  meta()
  setInterval(meta, 2000)
  if (i % 2 && !brain) {
    // Every other load-test bot flies with a picture: a gradient in its color's hue, enough to see it drawn.
    const rgba = new Uint8ClampedArray(PIC * PIC * 4).map((_, k) => {
      const [x, y, c] = [(k >> 2) % PIC, Math.floor((k >> 2) / PIC), k % 4]
      return c === 3 ? 255 : [x * 12, y * 12, (i * 40) % 256][c]!
    })
    const pic = packPic(rgba)
    setInterval(() => net.sendEvent({ t: 'pic', d: pic }), 3000)
  }

  // Every 100 ms: decide, then three 1/30 s frames in main.ts's order, as in training (train/sim.py).
  setInterval(() => {
    const now = Date.now()
    for (const [id, { seen }] of peers) if (now - seen > 3000) peers.delete(id)
    const drops = powerUpsAt(room, now + (clock.offset ?? 0)).filter((d) => !grabbed.has(d.key))
    let act: { turn: number; boost: boolean; fire: boolean }
    if (brain) {
      const others = [...peers.values()]
        .filter(({ p }) => p.hp > 0)
        .map(({ p, seen }) => predict(p, (now - seen) / 1000))
      const view = { me: { ...plane, armor, rapid, cooldown, deadFor }, others, bullets, drops }
      act = controls(decide(brain, observe(view)))
    } else {
      if (Math.random() < 0.05) turn = Math.floor(Math.random() * 3) - 1 // now and then: left, straight or right
      act = { turn, boost: false, fire: Math.random() < 0.1 }
    }
    const dt = 0.1 / 3
    for (let f = 0; f < 3; f++) {
      if (deadFor > 0 && (deadFor -= dt) <= 0) {
        plane = spawn(
          maxHpFor(peers.size + 1),
          [...peers.values()].map(({ p }) => p),
        )
        shield = SPAWN_SHIELD
      }
      const alive = deadFor <= 0
      shield -= dt
      armor -= dt
      rapid -= dt
      plane.shielded = shield > 0 || armor > 0
      const got = alive
        ? drops.find((d) => !grabbed.has(d.key) && wrapDist(plane.x, plane.y, d.x, d.y) < PICKUP_RADIUS)
        : undefined
      if (got) {
        grabbed.add(got.key)
        for (let k = 0; k < 2; k++) net.sendEvent({ t: 'grab', k: got.key })
        if (got.kind === 'shield') armor = ARMOR
        else if (got.kind === 'rapid') rapid = RAPID
        else plane.hp = Math.min(plane.hp + 1, maxHpFor(peers.size + 1) + 1)
      }
      if (alive) stepPlane(plane, { left: act.turn < 0, right: act.turn > 0, boost: act.boost }, dt)
      cooldown -= dt
      if (alive && act.fire && cooldown <= 0) {
        cooldown = rapid > 0 ? FIRE_COOLDOWN / 2 : FIRE_COOLDOWN
        shield = 0
        net.sendEvent({ t: 'shot', x: plane.x, y: plane.y, a: plane.a, ts: stamp() })
      }
      bullets = stepBullets(bullets, dt)
      const hit = alive ? findHit(plane, me, bullets) : -1
      if (hit >= 0) {
        const by = bullets[hit]!.owner
        bullets.splice(hit, 1)
        net.sendEvent({ t: 'hit', by })
        if (--plane.hp <= 0) {
          deaths++
          for (let k = 0; k < 3; k++) net.sendEvent({ t: 'kill', by, n: deaths })
          deadFor = RESPAWN_DELAY // pos with hp 0 hides the plane meanwhile
          meta()
        }
      }
    }
    net.sendPos({ ...plane, ts: stamp() })
  }, 100)
}

onmessage = (e: MessageEvent<{ room: string; n: number; relay: string; certHash: string; brain: boolean }>) => {
  room = e.data.room
  // Staggered joins, 5 a second, so the relay isn't hit by every PUBLISH at once.
  for (let i = 1; i <= e.data.n; i++)
    setTimeout(
      () =>
        bot(i, e.data.relay, e.data.certHash, e.data.brain ? (trained as Brain) : undefined).catch((err) => {
          failed++
          lastError = String(err)
        }),
      i * 200,
    )
}

setInterval(() => postMessage({ connected, failed, received, lastError }), 1000)
