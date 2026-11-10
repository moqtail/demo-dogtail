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

/** Drawing the game on the canvas: reads the state it is given, changes nothing. */

import { edgePoint, H, POWER_ICON, W, wrapDelta, type Bullet, type MetaMsg, type Plane, type PowerUp } from './game'

/** Canvas px per arena unit, and the arena units in view. */
export type View = { s: number; w: number; h: number }
/** An explosion: a big one when a plane is shot down, a small one on a hit. */
export type Boom = { x: number; y: number; age: number; big: boolean }
export const BOOM_LIFE = 0.6 // s
export const REACT_SHOW = 2000 // ms a reaction stays over its plane

/** What one frame shows; main.ts builds it from the game state. */
export type Scene = {
  view: View
  /** Arena point at the centre of the view. */
  cam: { x: number; y: number }
  bullets: Bullet[]
  drops: PowerUp[]
  booms: Boom[]
  peers: Map<string, { shown: Plane }>
  metas: Map<string, MetaMsg>
  /** The last reaction per player, or undefined while reactions are turned off. */
  reactions: Map<string, { e: string; at: number }> | undefined
  /** Players' picture pilots, or undefined while they are turned off. */
  pics: Map<string, CanvasImageSource> | undefined
  me: {
    id: string
    plane: Plane
    alive: boolean
    color: string
    pilot: string
    pic: CanvasImageSource | undefined
    spawnedAt: number
  }
  showMap: boolean
}

const GREY = '#9ca3af' // a player whose meta hasn't arrived yet

export function drawFrame(ctx: CanvasRenderingContext2D, sc: Scene) {
  const { view, cam } = sc
  // The arena wraps, so the scene is drawn 3×3 times around the camera; the canvas shows what's in view.
  ctx.setTransform(view.s, 0, 0, view.s, (view.w / 2 - cam.x) * view.s, (view.h / 2 - cam.y) * view.s)
  for (const ox of [-W, 0, W])
    for (const oy of [-H, 0, H]) {
      ctx.save()
      ctx.translate(ox, oy)
      drawScene(ctx, sc)
      ctx.restore()
    }
  const zoomed = view.w < W || view.h < H
  if (zoomed) drawArrows(ctx, sc)
  if (zoomed && sc.showMap) drawMap(ctx, sc)
}

/** Everything in the arena, in arena coordinates. */
function drawScene(ctx: CanvasRenderingContext2D, sc: Scene) {
  ctx.fillStyle = '#0b1020'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#334155' // the seam where the arena wraps
  ctx.lineWidth = 2 / sc.view.s
  ctx.strokeRect(0, 0, W, H)
  ctx.fillStyle = '#fbbf24'
  for (const b of sc.bullets) ctx.fillRect(b.x - 2, b.y - 2, 4, 4)
  drawDrops(ctx, sc.drops)
  ctx.font = '12px system-ui'
  for (const [id, peer] of sc.peers) {
    const m = sc.metas.get(id)
    const label = `${m?.name ?? id}${peer.shown.away ? ' (away)' : ''}`
    if (peer.shown.hp > 0)
      drawPlane(ctx, sc, peer.shown, m?.color ?? GREY, label, sc.pics?.get(id) ?? m?.pilot ?? '', id)
  }
  if (sc.me.alive) {
    drawPlane(ctx, sc, sc.me.plane, sc.me.color, 'you', sc.me.pic ?? sc.me.pilot, sc.me.id)
    drawPulse(ctx, sc)
  }
  for (const b of sc.booms) drawBoom(ctx, b)
}

// A jet, nose along +x: swept wings and twin tail fins, mirrored about the fuselage.
const JET_TOP = [
  [18, 0],
  [8, -2.5],
  [0, -3],
  [-6, -13],
  [-10, -13],
  [-7, -3],
  [-12, -3],
  [-15, -8],
  [-17, -8],
  [-16, -2],
]
const JET = [...JET_TOP, ...JET_TOP.map(([x, y]) => [x!, -y!]).reverse()]

function drawPlane(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  p: Plane,
  color: string,
  label: string,
  /** An emoji, a picture, or '' for an empty cockpit. */
  pilot: string | CanvasImageSource,
  id: string,
) {
  const r = sc.reactions?.get(id)
  if (r && performance.now() - r.at < REACT_SHOW) {
    // Above the name, rising a little as it fades.
    const t = (performance.now() - r.at) / REACT_SHOW
    ctx.save()
    ctx.globalAlpha = 1 - t * t
    ctx.font = '26px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText(r.e, p.x, p.y - 34 - t * 12)
    ctx.restore()
  }
  ctx.save()
  if (p.away)
    ctx.globalAlpha = 0.3 // its player is in another tab
  else if (p.shielded && performance.now() % 300 < 150) ctx.globalAlpha = 0.3 // blinks while it can't be hit
  ctx.translate(p.x, p.y)
  ctx.fillStyle = '#e5e7eb'
  ctx.fillText(`${label} ${'♥'.repeat(p.hp)}`, -20, -22)
  ctx.rotate(p.a)
  ctx.fillStyle = color
  ctx.beginPath()
  for (const [x, y] of JET) ctx.lineTo(x!, y!)
  ctx.fill()
  if (pilot) {
    // Upright in the cockpit, whichever way the jet points.
    ctx.translate(5, 0)
    ctx.rotate(-p.a)
    if (typeof pilot === 'string') {
      ctx.font = '13px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(pilot, 0, 0)
    } else {
      ctx.beginPath()
      ctx.arc(0, 0, 8, 0, Math.PI * 2)
      ctx.clip() // a round cockpit
      ctx.drawImage(pilot, -8, -8, 16, 16)
    }
  }
  ctx.restore()
}

/** Power-ups: an icon in a softly pulsing ring. */
function drawDrops(ctx: CanvasRenderingContext2D, drops: PowerUp[]) {
  const pulse = 1 + Math.sin(performance.now() / 200) * 0.1
  ctx.save()
  ctx.font = '18px system-ui'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = '#fbbf24'
  ctx.lineWidth = 2
  for (const d of drops) {
    ctx.beginPath()
    ctx.arc(d.x, d.y, 16 * pulse, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillText(POWER_ICON[d.kind], d.x, d.y + 1)
  }
  ctx.restore()
}

/**
 * For 2 s after you appear, rings in your color shrink onto your plane, so you can find yourself in a
 * crowd. Only you see them.
 */
function drawPulse(ctx: CanvasRenderingContext2D, sc: Scene) {
  const { plane, color, spawnedAt } = sc.me
  const t = (performance.now() - spawnedAt) / 2000
  if (t >= 1) return
  ctx.strokeStyle = color
  ctx.lineWidth = 3 / sc.view.s
  for (const phase of [0, 0.5]) {
    const k = (t * 2 + phase) % 1 // two rings, half a cycle apart
    ctx.globalAlpha = (1 - t) * k
    ctx.beginPath()
    ctx.arc(plane.x, plane.y, 20 + 100 * (1 - k), 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Zoomed in: a small arrow at the screen edge toward each player out of view, in their color. */
function drawArrows(ctx: CanvasRenderingContext2D, sc: Scene) {
  const { view, cam } = sc
  ctx.setTransform(view.s, 0, 0, view.s, (view.w / 2) * view.s, (view.h / 2) * view.s) // origin at centre
  for (const [id, peer] of sc.peers) {
    if (peer.shown.hp <= 0) continue
    const dx = wrapDelta(cam.x, peer.shown.x, W)
    const dy = wrapDelta(cam.y, peer.shown.y, H)
    const at = edgePoint(dx, dy, view.w / 2, view.h / 2, 16)
    if (!at) continue
    ctx.save()
    ctx.translate(at.x, at.y)
    ctx.rotate(Math.atan2(dy, dx))
    ctx.globalAlpha = peer.shown.away ? 0.3 : 0.9
    ctx.fillStyle = sc.metas.get(id)?.color ?? GREY
    ctx.beginPath()
    ctx.moveTo(10, 0)
    ctx.lineTo(-6, -7)
    ctx.lineTo(-6, 7)
    ctx.fill()
    ctx.restore()
  }
}

/** Zoomed in: the whole arena at the bottom centre, between the touch controls. */
function drawMap(ctx: CanvasRenderingContext2D, sc: Scene) {
  const { view, cam } = sc
  const mw = 120
  const k = mw / W
  const mh = H * k
  ctx.setTransform(1, 0, 0, 1, (ctx.canvas.width - mw) / 2, ctx.canvas.height - mh - 16)
  ctx.fillStyle = '#11182799'
  ctx.strokeStyle = '#475569'
  ctx.lineWidth = 1
  ctx.fillRect(0, 0, mw, mh)
  ctx.strokeRect(0, 0, mw, mh)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, mw, mh)
  ctx.clip()
  // What's on screen; it wraps across the edges like the arena does.
  ctx.strokeStyle = '#94a3b8'
  for (const ox of [-W, 0, W])
    for (const oy of [-H, 0, H])
      ctx.strokeRect((cam.x - view.w / 2 + ox) * k, (cam.y - view.h / 2 + oy) * k, view.w * k, view.h * k)
  ctx.restore()
  const dot = (p: Plane, color: string, r: number) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p.x * k, p.y * k, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#fbbf24'
  for (const d of sc.drops) ctx.fillRect(d.x * k - 1.5, d.y * k - 1.5, 3, 3)
  for (const [id, peer] of sc.peers) {
    if (peer.shown.hp <= 0) continue
    ctx.globalAlpha = peer.shown.away ? 0.3 : 1
    dot(peer.shown, sc.metas.get(id)?.color ?? GREY, 2)
  }
  ctx.globalAlpha = 1
  if (sc.me.alive) {
    dot(sc.me.plane, '#f9fafb', 4.5) // a white ring around your color, so you stand out
    dot(sc.me.plane, sc.me.color, 3)
  }
}

/** An expanding, fading fireball with a ring around it. */
function drawBoom(ctx: CanvasRenderingContext2D, b: Boom) {
  const t = b.age / BOOM_LIFE
  const r = (b.big ? 45 : 14) * Math.sqrt(t)
  ctx.globalAlpha = 1 - t
  ctx.fillStyle = t < 0.3 ? '#fde68a' : '#f97316'
  ctx.beginPath()
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#fbbf24'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(b.x, b.y, r * 1.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
}
