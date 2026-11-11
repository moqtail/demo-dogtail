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

import { Ace } from './ace'
import { type Brain } from './brain'
import trained from './brain.json'
import { COLORS, PIC, packPic, PILOTS, type WireMsg } from './game'
import { connect, syncClock } from './net'

// In a worker, so the bots keep full speed while their tab is in the background (browsers throttle
// timers in background tabs, not in workers). The page sends { room, n, relay, certHash, brain } to start them.
let room = ''
const clock = syncClock()
let connected = 0
let failed = 0
let lastError = ''
let received = 0

async function bot(i: number, relay: string, certHash: string, brain: Brain | undefined) {
  const me = Math.random().toString(16).slice(2, 8)
  let ace: Ace | undefined
  const hear = (id: string, w: WireMsg) => {
    received++
    ace?.hear(id, w)
  }
  const net = await connect(relay, room, me, certHash, {
    onPos: (id, p) => hear(id, { t: 'pos', p }),
    onMeta: (id, m) => hear(id, { t: 'meta', m }),
    onEvent: hear,
  })
  connected++
  const look = brain
    ? { name: `ace-${i}`, color: COLORS[i % COLORS.length]!, pilot: '🤖' }
    : { name: `bot-${i}`, color: COLORS[i % COLORS.length]!, pilot: PILOTS[i % PILOTS.length]! }
  const a = (ace = new Ace(me, look, room, brain, net, clock))
  setInterval(() => a.meta(), 2000)
  setInterval(() => a.tick(), 100)
  if (i % 2 && !brain) {
    // Every other load-test bot flies with a picture: a gradient in its color's hue, enough to see it drawn.
    const rgba = new Uint8ClampedArray(PIC * PIC * 4).map((_, k) => {
      const [x, y, c] = [(k >> 2) % PIC, Math.floor((k >> 2) / PIC), k % 4]
      return c === 3 ? 255 : [x * 12, y * 12, (i * 40) % 256][c]!
    })
    const pic = packPic(rgba)
    setInterval(() => net.sendEvent({ t: 'pic', d: pic }), 3000)
  }
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
