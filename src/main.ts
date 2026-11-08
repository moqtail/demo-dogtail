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

import { FIRE_COOLDOWN, H, MAX_HP, W, findHit, spawn, stepBullets, stepPlane, type Bullet, type Plane } from './game'
import { connect } from './net'
import { play, setSound, soundOn, type SoundName } from './sound'

declare const __CERT_HASH__: string // injected by vite.config.ts

const params = new URLSearchParams(location.search)
const room = params.get('room') ?? 'lobby'
const relay = params.get('relay') ?? `moqt://${location.hostname}:4433`
const me = Math.random().toString(16).slice(2, 8)

const canvas = document.getElementById('game') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const hud = document.getElementById('hud')!

const TURN_KEYS = ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight']
const keys = new Set<string>()
addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (TURN_KEYS.includes(e.code)) mouse = null // keyboard takes over until the mouse moves again
  if (e.code === 'Space') e.preventDefault()
})
addEventListener('keyup', (e) => keys.delete(e.code))

// Mouse: the plane steers toward the cursor (arena coordinates).
let mouse: { x: number; y: number } | null = null
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return
  const r = canvas.getBoundingClientRect()
  mouse = { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
})
// Settings pane: one checkbox per sound. Clicks on it are not game input.
const onSettings = (e: Event) => (e.target as Element).closest('#settings') !== null
for (const box of document.querySelectorAll<HTMLInputElement>('#settings [data-sound]')) {
  const name = box.dataset.sound as SoundName
  box.checked = soundOn[name]
  box.addEventListener('change', () => setSound(name, box.checked))
}

// Hold the left mouse button to fire.
let mouseFiring = false
addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button === 0 && !onSettings(e)) mouseFiring = true
})
addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' && e.button === 0) mouseFiring = false
})
addEventListener('blur', () => (mouseFiring = false))

// Touch: hold the left third to turn left, the right third to turn right, the middle to fire.
const touches = new Map<number, string>()
const touchKey = (x: number) => (x < innerWidth / 3 ? 'KeyA' : x > (innerWidth * 2) / 3 ? 'KeyD' : 'Space')
const syncTouches = () => {
  for (const k of ['KeyA', 'KeyD', 'Space']) keys.delete(k)
  for (const k of touches.values()) keys.add(k)
}
addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || onSettings(e)) return
  touches.set(e.pointerId, touchKey(e.clientX))
  syncTouches()
})
addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return
  touches.set(e.pointerId, touchKey(e.clientX))
  syncTouches()
})
for (const ev of ['pointerup', 'pointercancel'] as const)
  addEventListener(ev, (e) => {
    if (touches.delete(e.pointerId)) syncTouches()
  })

let plane: Plane = spawn()
let bullets: Bullet[] = []
let cooldown = 0
let kills = 0
let deaths = 0
const peers = new Map<string, { p: Plane; seen: number }>()

const net = await connect(relay, room, me, __CERT_HASH__, {
  onPos: (id, p) => peers.set(id, { p, seen: performance.now() }),
  onEvent: (id, m) => {
    if (m.t === 'shot') bullets.push({ x: m.x, y: m.y, a: m.a, age: 0, owner: id })
    else if (m.t === 'kill' && m.by === me) kills++
  },
}).catch((err) => {
  hud.textContent = `Could not connect to ${relay}: ${err}`
  throw err
})

function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H)
  canvas.width = W * s
  canvas.height = H * s
  ctx.setTransform(s, 0, 0, s, 0, 0)
}
addEventListener('resize', fit)
fit()

function drawPlane(p: Plane, color: string, label: string) {
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.fillStyle = '#e5e7eb'
  ctx.fillText(`${label} ${'♥'.repeat(p.hp)}`, -20, -22)
  ctx.rotate(p.a)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(16, 0)
  ctx.lineTo(-10, -10)
  ctx.lineTo(-5, 0)
  ctx.lineTo(-10, 10)
  ctx.fill()
  ctx.restore()
}

// 20 Hz on a timer, not in the frame loop: background tabs pause rAF but still run timers
// (throttled to ~1 Hz), which keeps an idle player under the 3 s drop timeout.
setInterval(() => net.sendPos(plane), 50)

let last = performance.now()
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  stepPlane(
    plane,
    {
      left: keys.has('KeyA') || keys.has('ArrowLeft'),
      right: keys.has('KeyD') || keys.has('ArrowRight'),
      boost: keys.has('KeyW') || keys.has('ArrowUp'),
      // Ignored with the cursor right on the plane, where the heading to it would jitter.
      target:
        mouse && Math.hypot(mouse.x - plane.x, mouse.y - plane.y) > 20
          ? Math.atan2(mouse.y - plane.y, mouse.x - plane.x)
          : undefined,
    },
    dt,
  )
  cooldown -= dt
  if ((keys.has('Space') || mouseFiring) && cooldown <= 0) {
    cooldown = FIRE_COOLDOWN
    const shot = { x: plane.x, y: plane.y, a: plane.a }
    bullets.push({ ...shot, age: 0, owner: me })
    net.sendEvent({ t: 'shot', ...shot })
    play('fire')
  }
  bullets = stepBullets(bullets, dt)

  // Victim-side hit detection: only this client decides whether its own plane was hit.
  const hit = findHit(plane, me, bullets)
  if (hit >= 0) {
    const by = bullets[hit]!.owner
    bullets.splice(hit, 1)
    plane.hp--
    net.sendEvent({ t: 'hit', by })
    if (plane.hp <= 0) {
      net.sendEvent({ t: 'kill', by })
      deaths++
      plane = spawn()
      play('death')
    } else play('hit')
  }

  for (const [id, peer] of peers) if (now - peer.seen > 3000) peers.delete(id)

  ctx.fillStyle = '#0b1020'
  ctx.fillRect(0, 0, W, H)
  ctx.font = '12px system-ui'
  ctx.fillStyle = '#fbbf24'
  for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 2, 4, 4)
  for (const [id, peer] of peers) drawPlane(peer.p, '#f87171', id)
  drawPlane(plane, '#60a5fa', 'you')

  hud.textContent = `room ${room} · you ${me} · HP ${plane.hp}/${MAX_HP} · kills ${kills} · deaths ${deaths} · players ${peers.size + 1}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
