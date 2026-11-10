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

/** Messages a player sends; they all travel on one track, `game`, as WireMsg. */
/** `ts`: when sent, on the shared clock (net.ts syncClock), for delay and jitter stats; absent if not synced. */
export type PosMsg = Plane & { ts?: number }
export type EventMsg =
  /** `ts`: when fired, on the shared reference clock (net.ts syncClock); absent if not synced. */
  | { t: 'shot'; x: number; y: number; a: number; ts?: number }
  | { t: 'hit'; by: string }
  | { t: 'kill'; by: string; n: number }
  | { t: 'react'; e: string }
  | { t: 'grab'; k: string }
  /** Your own picture as pilot, from packPic; repeated every few seconds for players who join later. */
  | { t: 'pic'; d: string }

/** Who a player is and their score. */
export type MetaMsg = { name: string; color: string; pilot: string; kills: number; deaths: number }
export const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#facc15', '#c084fc', '#fb923c', '#2dd4bf', '#f472b6']
/** Who sits in the cockpit: '' is nobody, just the jet. */
export const PILOTS = ['', '🐸', '🦆', '🐱', '🦊', '🐼', '🤖', '💀']

/** A peer's meta as it may be shown: arbitrary bytes from the network become a short name, a palette color and a palette pilot. */
export function cleanMeta(m: Partial<MetaMsg>): MetaMsg {
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 16) : ''
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0)
  return {
    name: name || '?',
    color: COLORS.includes(m.color as string) ? (m.color as string) : '#9ca3af',
    pilot: PILOTS.includes(m.pilot as string) ? (m.pilot as string) : '',
    kills: n(m.kills),
    deaths: n(m.deaths),
  }
}

/** Quick reactions, keys 1–4: a fixed set, so nobody can show arbitrary text over other planes. */
export const REACTIONS = ['😂', '🔥', '👋', '💢']

export type PowerKind = 'shield' | 'rapid' | 'heart'
export type PowerUp = { key: string; x: number; y: number; kind: PowerKind }
export const POWER_ICON: Record<PowerKind, string> = { shield: '🛡️', rapid: '⚡', heart: '❤️' }
export const POWER_SLOT = 8000 // ms between drops
export const POWER_LIFE = 16000 // ms a drop stays if nobody grabs it
export const POWER_PER_SLOT = 2
export const PICKUP_RADIUS = 24

/** A small seeded random generator, so every player derives the same drops. */
function seeded(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The power-ups on the map at `now` (ms, shared clock), not counting grabbed ones. There is no server:
 * every player derives the same drops from the room name and the time, so only grabs go on the wire.
 */
export function powerUpsAt(room: string, now: number): PowerUp[] {
  const kinds: PowerKind[] = ['shield', 'rapid', 'heart']
  const out: PowerUp[] = []
  const last = Math.floor(now / POWER_SLOT)
  for (let k = last - Math.ceil(POWER_LIFE / POWER_SLOT) + 1; k <= last; k++)
    for (let i = 0; i < POWER_PER_SLOT; i++) {
      const r = seeded(`${room}/${k}/${i}`)
      out.push({ key: `${k}:${i}`, x: r() * W, y: r() * H, kind: kinds[Math.floor(r() * kinds.length)]! })
    }
  return out
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const playerId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 16

/** A peer's pos as it may be used, or undefined: positions wrapped into the arena, hp a small count. */
export function cleanPos(p: unknown): PosMsg | undefined {
  if (typeof p !== 'object' || p === null) return undefined
  const m = p as Record<string, unknown>
  if (!finite(m.x) || !finite(m.y) || !finite(m.a) || !Number.isInteger(m.hp)) return undefined
  return {
    x: wrap(m.x, W),
    y: wrap(m.y, H),
    a: m.a,
    hp: Math.min(Math.max(m.hp as number, 0), 20),
    shielded: m.shielded === true,
    away: m.away === true,
    ts: finite(m.ts) ? m.ts : undefined,
  }
}

/** A peer's event as it may be used, or undefined: every field checked, reactions from the palette. */
export function cleanEvent(e: unknown): EventMsg | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const m = e as Record<string, unknown>
  switch (m.t) {
    case 'shot':
      return finite(m.x) && finite(m.y) && finite(m.a)
        ? { t: 'shot', x: wrap(m.x, W), y: wrap(m.y, H), a: m.a, ts: finite(m.ts) ? m.ts : undefined }
        : undefined
    case 'hit':
      return playerId(m.by) ? { t: 'hit', by: m.by } : undefined
    case 'kill':
      return playerId(m.by) && Number.isInteger(m.n) && (m.n as number) > 0
        ? { t: 'kill', by: m.by, n: m.n as number }
        : undefined
    case 'react':
      return REACTIONS.includes(m.e as string) ? { t: 'react', e: m.e as string } : undefined
    case 'pic':
      return unpackPic(m.d) ? { t: 'pic', d: m.d as string } : undefined
    case 'grab':
      return typeof m.k === 'string' && /^-?\d+:\d+$/.test(m.k) ? { t: 'grab', k: m.k } : undefined
  }
  return undefined
}

/**
 * Picture pilots are PIC×PIC pixels at 4 bits a channel, base64'd: 800 characters, which fits in one
 * datagram. Raw pixels rather than a JPEG, so no image decoder ever parses another player's bytes.
 */
export const PIC = 20
const PIC_BYTES = (PIC * PIC * 3) / 2 // 12 bits a pixel
const PIC_CHARS = (PIC_BYTES / 3) * 4

/** RGBA pixels (PIC×PIC, as from getImageData) to a picture as sent. */
export function packPic(rgba: Uint8ClampedArray): string {
  const out = new Uint8Array(PIC_BYTES)
  for (let px = 0, o = 0; px < PIC * PIC; px += 2, o += 3) {
    const a = px * 4
    const b = a + 4
    out[o] = (rgba[a]! & 0xf0) | (rgba[a + 1]! >> 4)
    out[o + 1] = (rgba[a + 2]! & 0xf0) | (rgba[b]! >> 4)
    out[o + 2] = (rgba[b + 1]! & 0xf0) | (rgba[b + 2]! >> 4)
  }
  return btoa(String.fromCharCode(...out))
}

/** A picture as sent back to RGBA pixels, or undefined if it isn't one. */
export function unpackPic(d: unknown): Uint8ClampedArray<ArrayBuffer> | undefined {
  if (typeof d !== 'string' || d.length !== PIC_CHARS || !/^[A-Za-z0-9+/]+$/.test(d)) return undefined
  const bin = atob(d)
  const rgba = new Uint8ClampedArray(PIC * PIC * 4)
  for (let o = 0, px = 0; o < PIC_BYTES; o += 3, px += 2) {
    const n = [0, 1, 2].flatMap((i) => [bin.charCodeAt(o + i) >> 4, bin.charCodeAt(o + i) & 15])
    rgba.set([n[0]! * 17, n[1]! * 17, n[2]! * 17, 255, n[3]! * 17, n[4]! * 17, n[5]! * 17, 255], px * 4)
  }
  return rgba
}

export const ZOOM_BELOW = 0.6 // canvas px per arena unit under which planes get too small to play
export const ZOOM_MAX = 1.5

/**
 * The view's scale (canvas px per arena unit) on a screen that shows the whole arena at `fit`, with the
 * player's `zoom` (1 = default). Big screens default to the whole arena, small ones to full size; it
 * never goes below the whole arena or ZOOM_BELOW. Returns the zoom too, clamped to what was possible.
 */
export function viewScale(fit: number, zoom: number): { s: number; zoom: number } {
  const base = fit >= ZOOM_BELOW ? fit : 1
  const s = Math.min(Math.max(base * zoom, fit, ZOOM_BELOW), Math.max(ZOOM_MAX, fit))
  return { s, zoom: s / base }
}

export const wrap = (v: number, max: number) => ((v % max) + max) % max

/** Health for a room of `players`: MAX_HP up to 10, one more for every 10 beyond, as busy rooms mean more fire. */
export const maxHpFor = (players: number) => MAX_HP + Math.floor(Math.max(players - 1, 0) / 10)

/**
 * A fresh plane. With `others` (live planes), it takes the farthest from them of 12 random spots, so
 * a respawn in a crowded room doesn't land in the middle of a fight.
 */
export function spawn(hp = MAX_HP, others: { x: number; y: number }[] = []): Plane {
  const spot = () => ({ x: Math.random() * W, y: Math.random() * H })
  let best = spot()
  let bestGap = -1
  for (let i = 0; others.length && i < 12; i++) {
    const c = spot()
    const gap = Math.min(...others.map((o) => wrapDist(c.x, c.y, o.x, o.y)))
    if (gap > bestGap) [best, bestGap] = [c, gap]
  }
  return { ...best, a: Math.random() * Math.PI * 2, hp }
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
export const wrapDelta = (from: number, to: number, max: number) => wrap(to - from + max / 2, max) - max / 2

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

/**
 * Where to point at something off screen: `dx`,`dy` from the view's centre to it, the view's half
 * width and height, and a margin. Returns the point on the view's edge, from the centre, or undefined
 * when it is on screen.
 */
export function edgePoint(dx: number, dy: number, hw: number, hh: number, margin: number) {
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return undefined
  const t = Math.min((hw - margin) / Math.abs(dx || 1e-9), (hh - margin) / Math.abs(dy || 1e-9))
  return { x: dx * t, y: dy * t }
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
/**
 * One object on the `game` track. A single track per player keeps the relay to one stream per player
 * per subscriber (Safari stops granting credit for server-opened streams after about a hundred).
 */
export type WireMsg = { t: 'pos'; p: PosMsg } | { t: 'meta'; m: MetaMsg } | EventMsg

export const encode = (m: WireMsg): Uint8Array => enc.encode(JSON.stringify(m))
export const decode = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T
