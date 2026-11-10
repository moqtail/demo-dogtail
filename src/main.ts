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

import {
  COLORS,
  FIRE_COOLDOWN,
  H,
  MAX_HP,
  RESPAWN_DELAY,
  W,
  ease,
  findHit,
  predict,
  spawn,
  stepBullets,
  stepPlane,
  type Bullet,
  type MetaMsg,
  type Plane,
} from './game'
import { connect } from './net'
import { play, setSound, soundOn, type SoundName } from './sound'

declare const __CERT_HASH__: string // injected by vite.config.ts

const params = new URLSearchParams(location.search)
const relay = params.get('relay') ?? `moqt://${location.hostname}:4433`
const me = Math.random().toString(16).slice(2, 8)

const canvas = document.getElementById('game') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const hud = document.getElementById('hud')!

const TURN_KEYS = ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight']
const keys = new Set<string>()
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return // typing a name is not flying
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
// Settings pane: one checkbox per sound. Clicks on it, or on the join screen, are not game input.
const onSettings = (e: Event) => (e.target as Element).closest('#settings, #join') !== null
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

// Touch: on-screen buttons that hold down the matching key while pressed.
// Safari zooms on a quick double tap even with touch-action: none; cancelling the touch stops it.
// Pointer events still fire, so the buttons keep working.
document.getElementById('touch')!.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })
for (const btn of document.querySelectorAll<HTMLElement>('#touch [data-key]')) {
  const key = btn.dataset.key!
  btn.addEventListener('pointerdown', (e) => {
    btn.classList.add('held')
    keys.add(key)
    btn.setPointerCapture(e.pointerId) // keeps the press even if the thumb slides off the button
  })
  for (const ev of ['pointerup', 'pointercancel'] as const)
    btn.addEventListener(ev, () => {
      btn.classList.remove('held')
      keys.delete(key)
    })
}

let plane: Plane = spawn()
let bullets: Bullet[] = []
let cooldown = 0
let kills = 0
let deaths = 0
const metas = new Map<string, MetaMsg>()
let scoreChanged = false // sends meta from the frame loop, so callbacks never run before `net` exists
let killedBy = ''
let deadFor = 0 // seconds until respawn; > 0 while shot down
/** `net` is the last snapshot, `shown` the eased plane that is drawn. */
const peers = new Map<string, { net: Plane; shown: Plane; seen: number }>()
/** Explosion effects: a big one when a plane is shot down, a small one on a hit. */
let booms: { x: number; y: number; age: number; big: boolean }[] = []
const boom = (p: Plane, big: boolean) => booms.push({ x: p.x, y: p.y, age: 0, big })

// Join screen: name, colour and room, remembered on this device. The room goes into the URL so the
// address bar is the invite link.
const joinForm = document.getElementById('join') as HTMLFormElement
const PROFILE_KEY = 'dogfight.profile'
let saved: { name?: string; color?: string } = {}
try {
  saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}')
} catch {
  // Storage blocked or corrupt: start blank.
}
const startColor = COLORS.includes(saved.color!) ? saved.color! : COLORS[Math.floor(Math.random() * COLORS.length)]!
for (const c of COLORS) {
  const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'color', value: c })
  radio.style.setProperty('--c', c)
  radio.setAttribute('aria-label', `colour ${COLORS.indexOf(c) + 1}`)
  radio.checked = c === startColor
  document.getElementById('colors')!.append(radio)
}
const field = (n: string) => joinForm.elements.namedItem(n) as HTMLInputElement
field('name').value = saved.name ?? ''
field('room').value = params.get('room') ?? 'lobby'
const roomUrl = () => {
  const u = new URL(location.href)
  u.searchParams.set('room', field('room').value.trim() || 'lobby')
  return u.href
}
const showInvite = () => (document.getElementById('invite')!.textContent = `Invite others: ${roomUrl()}`)
field('room').addEventListener('input', showInvite)
showInvite()
hud.textContent = ''
await new Promise<void>((resolve) =>
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault()
    resolve()
  }),
)
const myName = field('name').value.trim().slice(0, 16)
const myColor = (joinForm.elements.namedItem('color') as RadioNodeList).value || startColor
try {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: myName, color: myColor }))
} catch {
  // Storage blocked: asked again next time.
}
history.replaceState(null, '', roomUrl())
const room = field('room').value.trim() || 'lobby'
joinForm.hidden = true
hud.textContent = 'Connecting…'

const net = await connect(relay, room, me, __CERT_HASH__, {
  onPos: (id, p) => {
    const peer = peers.get(id)
    if (peer) Object.assign(peer, { net: p, seen: performance.now() })
    else peers.set(id, { net: p, shown: { ...p }, seen: performance.now() })
  },
  onEvent: (id, m) => {
    if (m.t === 'shot') bullets.push({ x: m.x, y: m.y, a: m.a, age: 0, owner: id })
    else {
      const peer = peers.get(id)
      if (peer) boom(peer.shown, m.t === 'kill')
      if (m.t === 'kill' && m.by === me) {
        kills++
        scoreChanged = true
      }
    }
  },
  onMeta: (id, m) => metas.set(id, m),
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

/** Draws a plane, plus its copy on the far side while it crosses an edge, so the wrap is visible. */
function drawPlane(p: Plane, color: string, label: string) {
  const M = 40 // plane plus label
  for (const x of [p.x - W, p.x, p.x + W])
    for (const y of [p.y - H, p.y, p.y + H])
      if (x > -M && x < W + M && y > -M && y < H + M) drawPlaneAt({ ...p, x, y }, color, label)
}

function drawPlaneAt(p: Plane, color: string, label: string) {
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

const BOOM_LIFE = 0.6 // s
/** An expanding, fading fireball with a ring around it. */
function drawBoom(b: { x: number; y: number; age: number; big: boolean }) {
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

// Meta goes out on join, on every score change and every 2 s: the repeats reach players who join
// later without relying on the relay to replay an old group.
const sendMeta = () => net.sendMeta({ name: myName, color: myColor, kills, deaths })
sendMeta()
setInterval(sendMeta, 2000)

// Scoreboard, best first. 4 Hz is plenty for text and keeps DOM work out of the frame loop.
const scores = document.getElementById('scores')!
setInterval(() => {
  const rows = [
    { name: `${myName} (you)`, color: myColor, kills, deaths },
    ...[...peers.keys()].map((id) => metas.get(id) ?? { name: id, color: '#9ca3af', kills: 0, deaths: 0 }),
  ].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  scores.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li')
      const name = Object.assign(document.createElement('span'), { textContent: r.name })
      name.style.color = r.color
      li.append(name, Object.assign(document.createElement('span'), { textContent: `${r.kills} / ${r.deaths}` }))
      return li
    }),
  )
}, 250)

// 20 Hz on a timer, not in the frame loop: background tabs pause rAF but still run timers
// (throttled to ~1 Hz), which keeps an idle player under the 3 s drop timeout.
setInterval(() => net.sendPos(plane), 50)

let last = performance.now()
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  if (deadFor > 0 && (deadFor -= dt) <= 0) plane = spawn()
  const alive = deadFor <= 0

  if (alive)
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
  if (alive && (keys.has('Space') || mouseFiring) && cooldown <= 0) {
    cooldown = FIRE_COOLDOWN
    const shot = { x: plane.x, y: plane.y, a: plane.a }
    bullets.push({ ...shot, age: 0, owner: me })
    net.sendEvent({ t: 'shot', ...shot })
    play('fire')
  }
  bullets = stepBullets(bullets, dt)

  // Victim-side hit detection: only this client decides whether its own plane was hit.
  const hit = alive ? findHit(plane, me, bullets) : -1
  if (hit >= 0) {
    const by = bullets[hit]!.owner
    bullets.splice(hit, 1)
    plane.hp--
    net.sendEvent({ t: 'hit', by })
    if (plane.hp <= 0) {
      net.sendEvent({ t: 'kill', by })
      deaths++
      scoreChanged = true
      deadFor = RESPAWN_DELAY // keeps sending pos with hp 0, which tells peers to hide the plane
      killedBy = metas.get(by)?.name ?? by
      boom(plane, true)
      play('death')
    } else {
      boom(plane, false)
      play('hit')
    }
  }

  for (const [id, peer] of peers) {
    if (now - peer.seen > 3000) {
      peers.delete(id)
      metas.delete(id)
    } else ease(peer.shown, predict(peer.net, (now - peer.seen) / 1000), dt)
  }
  if (scoreChanged) {
    scoreChanged = false
    sendMeta()
  }
  for (const b of booms) b.age += dt
  booms = booms.filter((b) => b.age < BOOM_LIFE)

  ctx.fillStyle = '#0b1020'
  ctx.fillRect(0, 0, W, H)
  ctx.font = '12px system-ui'
  ctx.fillStyle = '#fbbf24'
  for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 2, 4, 4)
  for (const [id, peer] of peers) {
    const m = metas.get(id)
    if (peer.shown.hp > 0) drawPlane(peer.shown, m?.color ?? '#9ca3af', m?.name ?? id)
  }
  if (alive) drawPlane(plane, myColor, 'you')
  for (const b of booms) drawBoom(b)

  const status = alive ? `HP ${plane.hp}/${MAX_HP}` : `shot down by ${killedBy} · respawning in ${Math.ceil(deadFor)}`
  hud.textContent = `room ${room} · ${status} · players ${peers.size + 1}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
