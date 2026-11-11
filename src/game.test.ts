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

import { describe, expect, it } from 'vitest'
import {
  BULLET_LIFE,
  H,
  W,
  cleanEvent,
  cleanMeta,
  cleanPos,
  viewScale,
  packPic,
  unpackPic,
  PIC,
  powerUpsAt,
  POWER_SLOT,
  POWER_LIFE,
  POWER_PER_SLOT,
  decode,
  ease,
  encode,
  findHit,
  ClockSync,
  clockSample,
  edgePoint,
  maxHpFor,
  predict,
  spawn,
  shotLag,
  stepBullets,
  stepPlane,
  turnToward,
  wrapDist,
  allies,
  smallerTeam,
  teamScores,
  RoundKills,
  ROUND_MS,
  type MetaMsg,
  type Bullet,
  type EventMsg,
  type WireMsg,
} from './game'

describe('game rules', () => {
  it('wraps a plane across the arena edge', () => {
    const p = { x: W - 1, y: 10, a: 0, hp: 3 }
    stepPlane(p, { left: false, right: false, boost: false }, 0.1)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x).toBeLessThan(20)
  })

  it('turns toward a target the short way, at most TURN per second', () => {
    // From just below +π to just above -π is a small left-to-right step, not a full spin.
    const a = turnToward(Math.PI - 0.1, -Math.PI + 0.1, 1)
    expect(a).toBeCloseTo(Math.PI + 0.1)
    expect(turnToward(0, Math.PI / 2, 0.1)).toBeCloseTo(0.3)
  })

  it('lets turn keys override the steering target', () => {
    const p = { x: 100, y: 100, a: 0, hp: 3 }
    stepPlane(p, { left: true, right: false, boost: false, target: 1 }, 0.1)
    expect(p.a).toBeCloseTo(-0.3)
  })

  it('measures distance across the wrap', () => {
    expect(wrapDist(1, 1, W - 1, H - 1)).toBeCloseTo(Math.hypot(2, 2))
  })

  it('hits only with bullets fired by someone else', () => {
    const p = { x: 100, y: 100, a: 0, hp: 3 }
    const own: Bullet = { x: 100, y: 100, a: 0, age: 0, owner: 'me' }
    const enemy: Bullet = { x: 105, y: 100, a: 0, age: 0, owner: 'them' }
    expect(findHit(p, 'me', [own])).toBe(-1)
    expect(findHit(p, 'me', [own, enemy])).toBe(1)
    expect(findHit({ ...p, shielded: true }, 'me', [own, enemy])).toBe(-1)
    expect(findHit(p, 'me', [own, enemy], (id) => id === 'them')).toBe(-1) // a teammate's bullet passes through
  })

  it('plays teams: allies, the smaller side, and round scores', () => {
    expect(allies('dogs', 'dogs')).toBe(true)
    expect(allies('dogs', 'cats')).toBe(false)
    expect(allies('', '')).toBe(false) // players without a team fight everyone
    expect(smallerTeam([])).toBe('dogs')
    expect(smallerTeam(['dogs', '', 'cats', 'dogs'])).toBe('cats')
    const meta = (team: MetaMsg['team'], round: number, rk: number): MetaMsg => ({
      ...{ name: 'p', color: '', pilot: '', kills: 0, deaths: 0 },
      ...{ team, round, rk },
    })
    // Only this round's kills count, and only for players on a side.
    expect(
      teamScores([meta('dogs', 7, 3), meta('dogs', 7, 2), meta('cats', 7, 4), meta('cats', 6, 9), meta('', 7, 5)], 7),
    ).toEqual({ dogs: 5, cats: 4 })
    const rk = new RoundKills()
    rk.at(ROUND_MS * 7 + 1).kills++
    expect(rk.at(ROUND_MS * 7 + 2)).toMatchObject({ round: 7, kills: 1 })
    expect(rk.at(ROUND_MS * 8)).toMatchObject({ round: 8, kills: 0 }) // a new round starts from 0
  })

  it('expires bullets', () => {
    const b: Bullet = { x: 0, y: 0, a: 0, age: BULLET_LIFE - 0.01, owner: 'x' }
    expect(stepBullets([b], 0.02)).toHaveLength(0)
  })

  it('eases a remote plane across the wrap, not the long way round', () => {
    const shown = { x: W - 5, y: 10, a: 0, hp: 3 }
    ease(shown, { x: 5, y: 10, a: 0, hp: 2 }, 0.1)
    expect(shown.x > W - 5 || shown.x < 5).toBe(true)
    expect(shown.hp).toBe(2)
  })

  it('jumps instead of easing after a respawn', () => {
    const shown = { x: 100, y: 100, a: 0, hp: 0 }
    ease(shown, { x: 900, y: 600, a: 1, hp: 3 }, 0.016)
    expect(shown).toEqual({ x: 900, y: 600, a: 1, hp: 3 })
  })

  it('predicts along the heading, capped for stale snapshots', () => {
    expect(predict({ x: 100, y: 100, a: 0, hp: 3 }, 0.1).x).toBeCloseTo(118)
    expect(predict({ x: 100, y: 100, a: 0, hp: 3 }, 5).x).toBeCloseTo(145)
    expect(predict({ x: 100, y: 100, a: 0, hp: 3, away: true }, 0.1).x).toBe(100) // paused: stays put
  })

  it('cleans peer meta before it is shown', () => {
    expect(
      cleanMeta({ name: '  a very long name indeed  ', color: 'url(x)', pilot: '<img>', kills: -1, deaths: 2 }),
    ).toEqual({
      name: 'a very long name',
      color: '#9ca3af',
      pilot: '',
      kills: 0,
      deaths: 2,
      team: '',
      round: 0,
      rk: 0,
    })
    expect(cleanMeta({ team: 'cats', round: 3, rk: 2 })).toMatchObject({ team: 'cats', round: 3, rk: 2 })
    expect(cleanMeta({ team: 'wolves' as never }).team).toBe('')
    expect(cleanMeta({}).name).toBe('?')
    expect(cleanMeta({ pilot: '🦆' }).pilot).toBe('🦆')
  })

  it('works out a clock offset from one exchange', () => {
    // Other clock is 5000 ms ahead; 40 ms each way; the other side holds the reply for 10 ms.
    expect(clockSample(0, 5040, 5050, 90)).toEqual({ offset: 5000, rtt: 80 })
    // A time server stamps once.
    expect(clockSample(0, 5040, 5040, 80)).toEqual({ offset: 5000, rtt: 80 })
  })

  it('trusts the exchange with the shortest round trip', () => {
    const sync = new ClockSync()
    expect(sync.offset).toBeUndefined()
    sync.add({ offset: 5100, rtt: 300 }) // queued: skewed
    sync.add({ offset: 5000, rtt: 80 })
    sync.add({ offset: NaN, rtt: 10 }) // garbage: ignored
    expect(sync.offset).toBe(5000)
  })

  it('fast-forwards remote shots by their travel time, within bounds', () => {
    // Reference clock is 5000 ms ahead of ours: fired at reference 6000 = our 1000, seen at our 1100.
    expect(shotLag(6000, 1100, 5000)).toBeCloseTo(0.1)
    expect(shotLag(6000, 900, 5000)).toBe(0)
    expect(shotLag(6000, 9000, 5000)).toBe(0.3)
    expect(shotLag(6000, 1100, undefined)).toBe(0) // offset not known yet
    expect(shotLag(undefined, 1100, 5000)).toBe(0)
  })

  it('points at off-screen players from the edge of the view', () => {
    expect(edgePoint(10, 10, 100, 50, 5)).toBeUndefined()
    expect(edgePoint(400, 0, 100, 50, 5)).toEqual({ x: 95, y: 0 })
    const p = edgePoint(-300, 300, 100, 50, 5)!
    expect(p.y).toBeCloseTo(45) // the nearer edge (top/bottom) clamps first
    expect(p.x).toBeCloseTo(-45)
  })

  it('gives one more life for every 10 players beyond 10', () => {
    expect([1, 10, 11, 20, 21, 50].map(maxHpFor)).toEqual([3, 3, 4, 4, 5, 7])
  })

  it('spawns away from other planes', () => {
    const crowd = [
      { x: 100, y: 100 },
      { x: 140, y: 90 },
      { x: 80, y: 130 },
    ]
    for (let i = 0; i < 20; i++) {
      const p = spawn(3, crowd)
      // 12 tries all landing within 200 of the crowd is vanishingly unlikely (each ~8%).
      expect(Math.min(...crowd.map((o) => wrapDist(p.x, p.y, o.x, o.y)))).toBeGreaterThan(200)
    }
  })

  it('round-trips wire messages', () => {
    const m: EventMsg = { t: 'kill', by: 'abc', n: 1 }
    expect(decode<EventMsg>(encode(m))).toEqual(m)
    const pos: WireMsg = { t: 'pos', p: { x: 1, y: 2, a: 0, hp: 3 } }
    expect(decode<WireMsg>(encode(pos))).toEqual(pos)
  })

  it('derives the same power-ups for everyone in a room, from the time alone', () => {
    const t = 1_800_000_123_456
    const a = powerUpsAt('falcon-1', t)
    expect(a).toEqual(powerUpsAt('falcon-1', t + 1)) // same slot, same drops
    expect(a).toHaveLength((POWER_LIFE / POWER_SLOT) * POWER_PER_SLOT)
    expect(a.map((p) => p.key)).not.toEqual(powerUpsAt('falcon-1', t + POWER_SLOT).map((p) => p.key)) // the oldest expires
    expect(powerUpsAt('hawk-2', t)[0]).not.toEqual(a[0]) // other rooms differ
    for (const p of a) expect(p.x >= 0 && p.x < 1600 && p.y >= 0 && p.y < 1000).toBe(true)
  })

  it('checks every message from other players before it is used', () => {
    expect(cleanPos({ x: 1700, y: -10, a: 1, hp: 3, away: 'yes' })).toEqual({
      x: 100,
      y: 990,
      a: 1,
      hp: 3,
      shielded: false,
      away: false,
      ts: undefined,
    })
    expect(cleanPos({ x: NaN, y: 0, a: 0, hp: 3 })).toBeUndefined()
    expect(cleanPos({ x: 0, y: 0, a: 0, hp: 1e9 })!.hp).toBe(20)
    expect(cleanPos(null)).toBeUndefined()

    expect(cleanEvent({ t: 'shot', x: 10, y: 20, a: 0.5, ts: 7 })).toEqual({ t: 'shot', x: 10, y: 20, a: 0.5, ts: 7 })
    expect(cleanEvent({ t: 'shot', x: '10', y: 20, a: 0.5 })).toBeUndefined()
    expect(cleanEvent({ t: 'hit', by: 'abc123' })).toEqual({ t: 'hit', by: 'abc123' })
    expect(cleanEvent({ t: 'hit', by: 'x'.repeat(100) })).toBeUndefined()
    expect(cleanEvent({ t: 'kill', by: 'abc123', n: 2 })).toEqual({ t: 'kill', by: 'abc123', n: 2 })
    expect(cleanEvent({ t: 'kill', by: 'abc123', n: 0 })).toBeUndefined()
    expect(cleanEvent({ t: 'react', e: '🔥' })).toEqual({ t: 'react', e: '🔥' })
    expect(cleanEvent({ t: 'react', e: '<b>hi</b>' })).toBeUndefined()
    expect(cleanEvent({ t: 'grab', k: '225000015:1' })).toEqual({ t: 'grab', k: '225000015:1' })
    expect(cleanEvent({ t: 'grab', k: 'anything' })).toBeUndefined()
    expect(cleanEvent({ t: 'nope' })).toBeUndefined()
  })

  it('zooms between the whole arena and 1.5x, never so far out that planes are specks', () => {
    expect(viewScale(0.8, 1)).toEqual({ s: 0.8, zoom: 1 }) // a computer: the whole arena by default
    expect(viewScale(0.8, 1.5).s).toBeCloseTo(1.2)
    expect(viewScale(0.8, 0.5)).toEqual({ s: 0.8, zoom: 1 }) // can't zoom out past the whole arena
    expect(viewScale(0.8, 9)).toEqual({ s: 1.5, zoom: 1.5 / 0.8 })
    expect(viewScale(0.36, 1).s).toBe(1) // a phone: full size by default
    expect(viewScale(0.36, 0.1).s).toBe(0.6) // and out only to ZOOM_BELOW
    expect(viewScale(2, 1).s).toBe(2) // a screen bigger than the arena
  })

  it('packs a picture into one datagram and back, keeping 4 bits a channel', () => {
    const rgba = new Uint8ClampedArray(PIC * PIC * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256))
    const d = packPic(rgba)
    expect(d).toHaveLength(800)
    const back = unpackPic(d)!
    for (let i = 0; i < rgba.length; i++) expect(back[i]).toBe(i % 4 === 3 ? 255 : (rgba[i]! >> 4) * 17)
    expect(cleanEvent({ t: 'pic', d })).toEqual({ t: 'pic', d })
    expect(cleanEvent({ t: 'pic', d: d.slice(1) })).toBeUndefined() // wrong size
    expect(cleanEvent({ t: 'pic', d: '<' + d.slice(1) })).toBeUndefined() // not base64
    expect(cleanEvent({ t: 'pic', d: 'data:image/jpeg;base64,AAAA' })).toBeUndefined()
  })
})
