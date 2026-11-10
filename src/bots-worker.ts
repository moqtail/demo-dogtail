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
 * Load-test bots, run by bots.html (dev server only: /bots.html?room=<room>&n=<count>). Each bot is a
 * full player on its own connection: pos at 10 Hz, meta every 2 s, about one shot a second, and its own
 * hit detection so real players can shoot it down.
 */

import {
  COLORS,
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

// In a worker, so the bots keep full speed while their tab is in the background (browsers throttle
// timers in background tabs, not in workers). The page sends { room, n, relay, certHash } to start them.
let room = ''
const clock = syncClock()
const stamp = () => (clock.offset === undefined ? undefined : Date.now() + clock.offset)
let connected = 0
let failed = 0
let lastError = ''
let received = 0

async function bot(i: number, relay: string, certHash: string) {
  const me = Math.random().toString(16).slice(2, 8)
  let plane: Plane = spawn()
  let bullets: Bullet[] = []
  let shield = SPAWN_SHIELD
  let deaths = 0
  let turn = 0
  const seen = new Map<string, number>() // other players, by last pos, for the room's size
  const net = await connect(relay, room, me, certHash, {
    onPos: (id) => {
      received++
      seen.set(id, Date.now())
    },
    onMeta: () => void received++,
    onEvent: (id, m) => {
      received++
      if (m.t === 'shot')
        bullets.push(...stepBullets([{ ...m, age: 0, owner: id }], shotLag(m.ts, Date.now(), clock.offset)))
    },
  })
  connected++
  const meta = () =>
    net.sendMeta({
      name: `bot-${i}`,
      color: COLORS[i % COLORS.length]!,
      pilot: PILOTS[i % PILOTS.length]!,
      kills: 0,
      deaths,
    })
  meta()
  setInterval(meta, 2000)
  if (i % 2) {
    // Every other bot flies with a picture: a gradient in its color's hue, enough to see it drawn.
    const rgba = new Uint8ClampedArray(PIC * PIC * 4).map((_, k) => {
      const [x, y, c] = [(k >> 2) % PIC, Math.floor((k >> 2) / PIC), k % 4]
      return c === 3 ? 255 : [x * 12, y * 12, (i * 40) % 256][c]!
    })
    const pic = packPic(rgba)
    setInterval(() => net.sendEvent({ t: 'pic', d: pic }), 3000)
  }
  setInterval(() => {
    const dt = 0.1
    if (Math.random() < 0.05) turn = Math.floor(Math.random() * 3) - 1 // now and then: left, straight or right
    stepPlane(plane, { left: turn < 0, right: turn > 0, boost: false }, dt)
    bullets = stepBullets(bullets, dt)
    shield -= dt
    plane.shielded = shield > 0
    const hit = findHit(plane, me, bullets)
    if (hit >= 0) {
      const by = bullets[hit]!.owner
      bullets.splice(hit, 1)
      net.sendEvent({ t: 'hit', by })
      if (--plane.hp <= 0) {
        deaths++
        for (let k = 0; k < 3; k++) net.sendEvent({ t: 'kill', by, n: deaths })
        const now = Date.now()
        for (const [id, t] of seen) if (now - t > 3000) seen.delete(id)
        plane = spawn(maxHpFor(seen.size + 1))
        shield = SPAWN_SHIELD
        meta()
      }
    }
    if (Math.random() < 0.1) net.sendEvent({ t: 'shot', x: plane.x, y: plane.y, a: plane.a, ts: stamp() })
    net.sendPos({ ...plane, ts: stamp() })
  }, 100)
}

onmessage = (e: MessageEvent<{ room: string; n: number; relay: string; certHash: string }>) => {
  room = e.data.room
  // Staggered joins, 5 a second, so the relay isn't hit by every PUBLISH at once.
  for (let i = 1; i <= e.data.n; i++)
    setTimeout(
      () =>
        bot(i, e.data.relay, e.data.certHash).catch((err) => {
          failed++
          lastError = String(err)
        }),
      i * 200,
    )
}

setInterval(() => postMessage({ connected, failed, received, lastError }), 1000)
