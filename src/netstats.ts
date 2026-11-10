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

import type { MOQtailClient } from 'moqtail/client'
import type { ClockSync } from './game'
import { Jitter, Rate, TrackStats } from './stats'

type PeerStats = { tracks: Map<string, TrackStats>; jitter: Jitter; delay?: number; rate: Rate }

const getOr = <K, V>(m: Map<K, V>, k: K, make: () => V) => m.get(k) ?? (m.set(k, make()), m.get(k)!)
const total = (m: Map<string, TrackStats>, f: (t: TrackStats) => number) =>
  [...m.values()].reduce((a, t) => a + f(t), 0)

/** Right-aligned in `width` characters, so columns stay put as numbers grow and shrink. */
const col = (v: string | number, width: number) => String(v).padStart(width)

/**
 * Network stats from the client's events: objects and bytes sent per track (`datagramsent`), objects,
 * loss, one-way delay and jitter per player (`datagramreceived`, with `peerpublish` naming each alias),
 * and the round trip to the relay, timed on the PUBLISH_NAMESPACE request at join. Shown in `panel`.
 * shortcut: rtt is measured once, at join; a periodic TRACK_STATUS probe made relay.moqtail.dev close
 * the session, so measure it again once there is a request that is safe to repeat.
 */
export function watchStats(
  client: MOQtailClient,
  clock: ClockSync,
  nameOf: (id: string) => string,
  panel: HTMLElement,
) {
  const text = new TextDecoder()
  const sent = new Map<string, TrackStats>()
  const sentRate = new Rate()
  const sentBytes = new Rate()
  const peers = new Map<string, PeerStats>()
  const aliases = new Map<bigint, { player: string; track: string }>()
  let rtt: number | undefined

  const ownTrack = (alias: bigint) => {
    for (const t of client.trackSources.values())
      if (t.trackAlias === alias) return { name: text.decode(t.fullTrackName.name), ftn: t.fullTrackName }
  }
  const peer = (id: string) =>
    getOr<string, PeerStats>(peers, id, () => ({ tracks: new Map(), jitter: new Jitter(), rate: new Rate() }))

  client.on('peerpublish', (msg) => {
    const player = msg.fullTrackName.namespace.toUtf8Path().split('/').filter(Boolean).pop()!
    aliases.set(msg.trackAlias, { player, track: text.decode(msg.fullTrackName.name) })
  })
  client.on('datagramsent', (d) => {
    const name = ownTrack(d.trackAlias)?.name ?? `alias ${d.trackAlias}`
    getOr(sent, name, () => new TrackStats()).add(d.groupId, d.payload?.byteLength ?? 0)
  })
  client.on('datagramreceived', (d) => {
    const from = aliases.get(d.trackAlias)
    if (!from) return
    getOr(peer(from.player).tracks, from.track, () => new TrackStats()).add(d.groupId, d.payload?.byteLength ?? 0)
  })

  // Twice a second: rates, then the panel. Rates over 1 s windows read steadier, so sample on every other tick.
  let tick = 0
  setInterval(() => {
    if (panel.hidden) return
    const now = performance.now()
    if (tick++ % 2 === 0) {
      sentRate.sample(
        total(sent, (t) => t.objects),
        now,
      )
      sentBytes.sample(
        total(sent, (t) => t.bytes),
        now,
      )
      for (const p of peers.values())
        p.rate.sample(
          total(p.tracks, (t) => t.objects),
          now,
        )
    }
    const sync = clock.best
    const lines = [
      `relay rtt ${col(rtt === undefined ? '…' : Math.round(rtt), 4)} ms (at join) · clock ` +
        (sync ? `${col(Math.round(sync.offset), 6)} ms` : 'not synced'),
      `sent ${col(sentRate.value.toFixed(1), 5)} obj/s · ${col((sentBytes.value / 1024).toFixed(1), 5)} KB/s · ` +
        [...sent].map(([n, t]) => `${n} ${col(t.objects, 6)}`).join(' '),
      ...[...peers].map(([id, p]) => {
        const lost = total(p.tracks, (t) => t.lost)
        const expected = total(p.tracks, (t) => t.objects) + lost
        return (
          `${nameOf(id).padEnd(10).slice(0, 10)} ` +
          `delay ${col(p.delay === undefined ? '…' : Math.round(p.delay), 4)} ms · ` +
          `jitter ${col(p.jitter.value.toFixed(1), 5)} ms · ` +
          `loss ${col(expected ? ((lost / expected) * 100).toFixed(1) : '0.0', 5)}% · ` +
          `${col(p.rate.value.toFixed(1), 5)} obj/s`
        )
      }),
    ]
    panel.textContent = lines.join('\n')
  }, 500)

  return {
    /** Round trip to the relay in ms, timed by net.ts on a request at join. */
    setRtt(ms: number) {
      rtt = ms
    },
    /** A pos arrived from `id`, sent at `ts` on the shared clock: feeds delay and jitter. */
    onPos(id: string, ts: number | undefined) {
      if (ts === undefined) return
      const now = Date.now()
      const p = peer(id)
      p.jitter.add(now - ts) // a constant clock offset cancels in jitter
      if (clock.offset !== undefined) p.delay = now + clock.offset - ts
    },
    forget(id: string) {
      peers.delete(id)
      for (const [alias, a] of aliases) if (a.player === id) aliases.delete(alias)
    },
  }
}
