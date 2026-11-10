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
  cleanMeta,
  decode,
  ease,
  encode,
  findHit,
  predict,
  stepBullets,
  stepPlane,
  turnToward,
  wrapDist,
  type Bullet,
  type EventMsg,
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
  })

  it('cleans peer meta before it is shown', () => {
    expect(cleanMeta({ name: '  a very long name indeed  ', color: 'url(x)', kills: -1, deaths: 2 })).toEqual({
      name: 'a very long name',
      color: '#9ca3af',
      kills: 0,
      deaths: 2,
    })
    expect(cleanMeta({}).name).toBe('?')
  })

  it('round-trips wire messages', () => {
    const m: EventMsg = { t: 'kill', by: 'abc', n: 1 }
    expect(decode<EventMsg>(encode(m))).toEqual(m)
  })
})
