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

export type Plane = { x: number; y: number; a: number; hp: number }
export type Bullet = { x: number; y: number; a: number; age: number; owner: string }
/** `target` is a heading (rad) to steer toward, e.g. from the mouse; it is used when no turn key is held. */
export type Input = { left: boolean; right: boolean; boost: boolean; target?: number }

/** Messages carried on the wire; `pos` track objects are PosMsg, `events` objects are EventMsg. */
export type PosMsg = Plane
export type EventMsg =
  { t: 'shot'; x: number; y: number; a: number } | { t: 'hit'; by: string } | { t: 'kill'; by: string }

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

/** Index of the first bullet not fired by `self` that hits `p`, or -1. */
export function findHit(p: Plane, self: string, bullets: Bullet[]): number {
  return bullets.findIndex((b) => b.owner !== self && wrapDist(p.x, p.y, b.x, b.y) < HIT_RADIUS)
}

const enc = new TextEncoder()
const dec = new TextDecoder()
export const encode = (m: PosMsg | EventMsg): Uint8Array => enc.encode(JSON.stringify(m))
export const decode = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T
