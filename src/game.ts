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

/** Pure game rules: no DOM, no network, so they can be unit tested. */

export const W = 1600
export const H = 1000
export const SPEED = 180
export const BOOST = 320
export const TURN = 3 // rad/s
export const BULLET_SPEED = 520
export const BULLET_LIFE = 1.2 // s
export const FIRE_COOLDOWN = 0.2 // s
export const HIT_RADIUS = 14
export const MAX_HP = 3
export const SPAWN_SHIELD = 1.5 // s after spawning that a plane can't be hit, unless it fires
export const RESPAWN_DELAY = 2 // s; must stay under the 3 s silence after which peers drop a player

/**
 * `shielded`: just spawned and can't be hit; sent in `pos` so everyone sees it blink.
 * `away`: its player's tab is in the background, where the game is paused and can't be hit.
 */
export type Plane = { x: number; y: number; a: number; hp: number; shielded?: boolean; away?: boolean }
export type Bullet = { x: number; y: number; a: number; age: number; owner: string }
/** `target` is a heading (rad) to steer toward, e.g. from the mouse; it is used when no turn key is held. */
export type Input = { left: boolean; right: boolean; boost: boolean; target?: number }

/** Messages carried on the wire; `pos` track objects are PosMsg, `events` objects are EventMsg. */
/** `ts`: when sent, on the shared clock (net.ts syncClock), for delay and jitter stats; absent if not synced. */
export type PosMsg = Plane & { ts?: number }
export type EventMsg =
  /** `ts`: when fired, on the shared reference clock (net.ts syncClock); absent if not synced. */
  | { t: 'shot'; x: number; y: number; a: number; ts?: number }
  | { t: 'hit'; by: string }
  | { t: 'kill'; by: string; n: number }

/** Who a player is and their score, on the `meta` track. */
export type MetaMsg = { name: string; color: string; kills: number; deaths: number }
export const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#facc15', '#c084fc', '#fb923c', '#2dd4bf', '#f472b6']

/** A peer's meta as it may be shown: arbitrary bytes from the network become a short name and a palette colour. */
export function cleanMeta(m: Partial<MetaMsg>): MetaMsg {
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 16) : ''
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0)
  return {
    name: name || '?',
    color: COLORS.includes(m.color as string) ? (m.color as string) : '#9ca3af',
    kills: n(m.kills),
    deaths: n(m.deaths),
  }
}

export const wrap = (v: number, max: number) => ((v % max) + max) % max

export function spawn(): Plane {
  return { x: Math.random() * W, y: Math.random() * H, a: Math.random() * Math.PI * 2, hp: MAX_HP }
}

/** Heading `a` turned toward `target` by at most TURN * dt, the short way round. */
export function turnToward(a: number, target: number, dt: number): number {
  const diff = Math.atan2(Math.sin(target - a), Math.cos(target - a))
  const max = TURN * dt
  return a + Math.max(-max, Math.min(max, diff))
}

export function stepPlane(p: Plane, input: Input, dt: number): void {
  if (input.left || input.right || input.target === undefined)
    p.a += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * TURN * dt
  else p.a = turnToward(p.a, input.target, dt)
  const v = input.boost ? BOOST : SPEED
  p.x = wrap(p.x + Math.cos(p.a) * v * dt, W)
  p.y = wrap(p.y + Math.sin(p.a) * v * dt, H)
}

/** Signed shortest offset from `from` to `to` on a wrapping axis of length `max`. */
const wrapDelta = (from: number, to: number, max: number) => wrap(to - from + max / 2, max) - max / 2

/**
 * Where a remote plane probably is now: its last snapshot carried forward `age` seconds along its heading.
 * shortcut: assumes cruise speed (snapshots don't say if the plane is boosting), so a boosting plane lags
 * a little; add speed to PosMsg if that shows.
 */
export function predict(p: Plane, age: number): Plane {
  if (p.away) return p // paused in a background tab: not moving, and its updates come ~1/s
  const t = Math.min(age, 0.25) // past this the snapshot is too stale to extrapolate
  return { ...p, x: wrap(p.x + Math.cos(p.a) * SPEED * t, W), y: wrap(p.y + Math.sin(p.a) * SPEED * t, H) }
}

/** Moves the drawn plane `shown` part of the way to `target`, across the wrap, so remote planes glide. */
export function ease(shown: Plane, target: Plane, dt: number): void {
  const k = 1 - Math.exp(-dt * 12) // closes ~70% of the gap per 100 ms, whatever the frame rate
  const dx = wrapDelta(shown.x, target.x, W)
  const dy = wrapDelta(shown.y, target.y, H)
  if (Math.hypot(dx, dy) > 200)
    Object.assign(shown, target) // respawned: jump, don't fly across the map
  else {
    shown.x = wrap(shown.x + dx * k, W)
    shown.y = wrap(shown.y + dy * k, H)
    shown.a += Math.atan2(Math.sin(target.a - shown.a), Math.cos(target.a - shown.a)) * k
  }
  shown.hp = target.hp
  shown.shielded = target.shielded
  shown.away = target.away
}

/** Most a remote shot is fast-forwarded, so a badly set clock can't throw bullets across the map. */
export const MAX_LAG = 0.3 // s

/**
 * One NTP-style exchange, all in ms: we asked at t1 (our clock), the other side got it at t2 and
 * replied at t3 (its clock), the reply arrived at t4. Returns its clock minus ours, and the round trip.
 * A time server that only stamps once passes the same value as t2 and t3.
 */
export function clockSample(t1: number, t2: number, t3: number, t4: number): { offset: number; rtt: number } {
  return { offset: (t2 - t1 + (t3 - t4)) / 2, rtt: t4 - t1 - (t3 - t2) }
}

/** A clock offset, from the recent exchanges with the shortest round trip (least queuing skew). */
export class ClockSync {
  #samples: { offset: number; rtt: number }[] = []

  add(s: { offset: number; rtt: number }): void {
    if (!Number.isFinite(s.offset) || !(s.rtt >= 0)) return // garbage from the wire
    this.#samples.push(s)
    if (this.#samples.length > 50) this.#samples.shift()
  }

  /** The sample trusted: shortest round trip. */
  get best(): { offset: number; rtt: number } | undefined {
    let best: { offset: number; rtt: number } | undefined
    for (const s of this.#samples) if (!best || s.rtt < best.rtt) best = s
    return best
  }

  /** The other clock minus ours in ms, or undefined before the first exchange. */
  get offset(): number | undefined {
    return this.best?.offset
  }
}

/**
 * How long a shot took to arrive, in s: from its `ts` on the reference clock to now on ours, moved onto
 * the reference by `offset` (reference minus ours), clamped to 0..MAX_LAG. Remote bullets are advanced
 * by this so they line up with where the shooter fired them. 0 until our offset is known.
 */
export function shotLag(ts: number | undefined, now: number, offset: number | undefined): number {
  if (ts === undefined || offset === undefined) return 0
  const lag = (now - (ts - offset)) / 1000
  return Number.isFinite(lag) ? Math.min(Math.max(lag, 0), MAX_LAG) : 0
}

/** Advances bullets and drops the expired ones. */
export function stepBullets(bullets: Bullet[], dt: number): Bullet[] {
  for (const b of bullets) {
    b.x = wrap(b.x + Math.cos(b.a) * BULLET_SPEED * dt, W)
    b.y = wrap(b.y + Math.sin(b.a) * BULLET_SPEED * dt, H)
    b.age += dt
  }
  return bullets.filter((b) => b.age < BULLET_LIFE)
}

/** Shortest distance on the wrapping arena, so a plane at the edge is hittable from the other side. */
export function wrapDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy))
}

/** Index of the first bullet not fired by `self` that hits `p`, or -1. A shielded plane can't be hit. */
export function findHit(p: Plane, self: string, bullets: Bullet[]): number {
  if (p.shielded) return -1
  return bullets.findIndex((b) => b.owner !== self && wrapDist(p.x, p.y, b.x, b.y) < HIT_RADIUS)
}

const enc = new TextEncoder()
const dec = new TextDecoder()
export const encode = (m: PosMsg | EventMsg | MetaMsg): Uint8Array => enc.encode(JSON.stringify(m))
export const decode = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T
