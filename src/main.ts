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
  maxHpFor,
  RESPAWN_DELAY,
  SPAWN_SHIELD,
  W,
  ease,
  findHit,
  predict,
  edgePoint,
  wrapDelta,
  shotLag,
  spawn,
  stepBullets,
  stepPlane,
  type Bullet,
  type MetaMsg,
  type Plane,
} from './game'
import { startAnalytics } from './analytics'
import { connect, syncClock } from './net'
import { watchStats } from './netstats'
import { play, setSound, soundOn, type SoundName } from './sound'

declare const __CERT_HASH__: string // injected by vite.config.ts

const params = new URLSearchParams(location.search)
// With a LAN cert (npm run dev after make-cert.sh) the relay runs on this machine; otherwise the public one.
const relay = params.get('relay') ?? (__CERT_HASH__ ? `moqt://${location.hostname}:4433` : 'moqt://relay.moqtail.dev')
const me = Math.random().toString(16).slice(2, 8)
const debug = params.has('debug') // ?debug: network stats shown from the start
const clock = syncClock() // starts now, so it is ready by the time the player has joined

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
  if (e.code === 'KeyF' && !e.repeat) toggleFullscreen()
})
addEventListener('keyup', (e) => keys.delete(e.code))

// Mouse: the plane steers toward the cursor (arena coordinates).
/** Cursor as a fraction of the canvas; turned into arena coordinates each frame, as the camera moves. */
let mouse: { fx: number; fy: number } | null = null
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return
  const r = canvas.getBoundingClientRect()
  mouse = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }
})
// Settings pane: one checkbox per sound. Clicks on it, or on the join screen, are not game input.
const onSettings = (e: Event) => (e.target as Element).closest('#tools, #join') !== null
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

// Fullscreen: the ⛶ button or F. Safari on iPhone has no fullscreen for pages, so the button hides
// there; adding the game to the Home Screen opens it without browser bars instead (manifest.webmanifest).
const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
const fsButton = document.getElementById('fullscreen')!
fsButton.hidden = !root.requestFullscreen && !root.webkitRequestFullscreen
fsButton.addEventListener('click', () => {
  fsButton.blur() // or Space, the fire key, would press it again
  toggleFullscreen()
})
function toggleFullscreen() {
  try {
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
    } else if (root.requestFullscreen) {
      // Phones play in landscape: lock it where the browser allows (Android); elsewhere this just fails.
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      void root
        .requestFullscreen()
        .then(() => orientation.lock?.('landscape'))
        .catch(() => {})
    } else root.webkitRequestFullscreen?.()
  } catch {
    // Refused (e.g. not from a user gesture): stay windowed.
  }
}

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
let spawnedAt = performance.now() // for the you-are-here pulse
let shieldFor = SPAWN_SHIELD
let bullets: Bullet[] = []
let cooldown = 0
let kills = 0
let deaths = 0
const metas = new Map<string, MetaMsg>()
const killsSeen = new Set<string>()
let scoreChanged = false // sends meta from the frame loop, so callbacks never run before `net` exists
let killedBy = ''
let deadFor = 0 // seconds until respawn; > 0 while shot down
/** `net` is the last snapshot, `shown` the eased plane that is drawn. */
const peers = new Map<string, { net: Plane; shown: Plane; seen: number }>()
/** Explosion effects: a big one when a plane is shot down, a small one on a hit. */
let booms: { x: number; y: number; age: number; big: boolean }[] = []
const boom = (p: Plane, big: boolean) => booms.push({ x: p.x, y: p.y, age: 0, big })

// Join screen: name, color and room, remembered on this device. The room goes into the URL so the
// address bar is the invite link.
const joinForm = document.getElementById('join') as HTMLFormElement
const PROFILE_KEY = 'dogfight.profile'
let saved: { name?: string; color?: string; room?: string } = {}
try {
  saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}')
} catch {
  // Storage blocked or corrupt: start blank.
}
const startColor = COLORS.includes(saved.color!) ? saved.color! : COLORS[Math.floor(Math.random() * COLORS.length)]!
for (const c of COLORS) {
  const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'color', value: c })
  radio.style.setProperty('--c', c)
  radio.setAttribute('aria-label', `color ${COLORS.indexOf(c) + 1}`)
  radio.checked = c === startColor
  document.getElementById('colors')!.append(radio)
}
const field = (n: string) => joinForm.elements.namedItem(n) as HTMLInputElement
field('name').value = saved.name ?? ''
// Room: the link's, else the one this device last joined, else a fresh random one, so a first game
// doesn't land in a room strangers on the public relay also default to.
const ROOM_CAP = 50
const BIRDS = ['falcon', 'hawk', 'eagle', 'raven', 'kestrel', 'osprey', 'condor', 'swift', 'merlin', 'harrier']
const randomRoom = () => `${BIRDS[Math.floor(Math.random() * BIRDS.length)]}-${100 + Math.floor(Math.random() * 900)}`
const defaultRoom = typeof saved.room === 'string' && saved.room.trim() ? saved.room.trim() : randomRoom()
field('room').value = params.get('room') ?? defaultRoom
const roomUrl = () => {
  const u = new URL(location.href)
  u.searchParams.set('room', field('room').value.trim() || defaultRoom)
  u.searchParams.delete('full')
  return u.href
}
const showInvite = () => (document.getElementById('invite')!.textContent = `Invite others: ${roomUrl()}`)
const fullRoom = params.get('full')
if (fullRoom)
  document.getElementById('notice')!.textContent = `Room ${fullRoom} is full (${ROOM_CAP} players). Here is a new one.`
field('room').addEventListener('input', showInvite)
showInvite()
hud.textContent = ''
await new Promise<void>((resolve) =>
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault()
    resolve()
  }),
)
const room = field('room').value.trim() || defaultRoom
const myName = field('name').value.trim().slice(0, 16)
const myColor = (joinForm.elements.namedItem('color') as RadioNodeList).value || startColor
try {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: myName, color: myColor, room }))
} catch {
  // Storage blocked: asked again next time.
}
history.replaceState(null, '', roomUrl())
joinForm.hidden = true
// Leave: back to the join screen (a web app on the Home Screen has no back button). Reloading
// disconnects, and the join screen comes back with this room, name and color filled in.
const leave = document.getElementById('leave')!
leave.hidden = false
leave.addEventListener('click', () => location.reload())
const analytics = startAnalytics(me)
const joinedAt = Date.now()
hud.textContent = 'Connecting…'

// Network stats panel: ?debug, the S key or Settings → Network.
const statsPanel = document.getElementById('stats')!
const statsBox = document.getElementById('show-stats') as HTMLInputElement
const showStats = (on: boolean) => {
  statsPanel.hidden = !on
  statsBox.checked = on
}
showStats(debug)
statsBox.addEventListener('change', () => showStats(statsBox.checked))
addEventListener('keydown', (e) => {
  if (e.code === 'KeyS' && !e.repeat && !(e.target instanceof HTMLInputElement)) showStats(!statsBox.checked)
})
let stats: ReturnType<typeof watchStats> | undefined

const net = await connect(
  relay,
  room,
  me,
  __CERT_HASH__,
  {
    onPos: (id, p) => {
      stats?.onPos(id, p.ts)
      const peer = peers.get(id)
      if (peer) Object.assign(peer, { net: p, seen: performance.now() })
      else peers.set(id, { net: p, shown: { ...p }, seen: performance.now() })
    },
    onEvent: (id, m) => {
      if (m.t === 'kill') {
        const key = `${id}:${m.n}`
        if (killsSeen.has(key)) return // a repeat of a kill already counted
        killsSeen.add(key)
      }
      if (m.t === 'shot')
        bullets.push(
          ...stepBullets([{ x: m.x, y: m.y, a: m.a, age: 0, owner: id }], shotLag(m.ts, Date.now(), clock.offset)),
        )
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
  },
  (client) => (stats = watchStats(client, clock, (id) => metas.get(id)?.name ?? id, statsPanel)),
).catch((err) => {
  hud.textContent = `Could not connect to ${relay}: ${err}`
  throw err
})

stats?.setRtt(net.joinRtt)

const device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop'
analytics.track('join', { room, device })
// Leaving: closing the tab, Leave (which reloads) or switching away on a phone all fire pagehide.
addEventListener('pagehide', () =>
  analytics.track('leave', { room, seconds: Math.round((Date.now() - joinedAt) / 1000), kills, deaths }),
)
setInterval(() => analytics.track('room_size', { room, players: peers.size + 1 }), 60_000)
spawnedAt = performance.now() // the first pulse plays once you're in, not behind the join screen

// A room holds ROOM_CAP players. Once the others have shown up (pos is 10 Hz), a newcomer to a full
// room goes back to the join screen with a fresh room. Only newcomers check, so nobody is kicked;
// two joining at once may both stay, which is fine.
setTimeout(() => {
  if (peers.size + 1 > ROOM_CAP)
    (analytics.track('room_full', { room }), location.replace(`?room=${randomRoom()}&full=${encodeURIComponent(room)}`))
}, 1500)

// Screens big enough show the whole arena. On a phone that would shrink a plane to a few pixels, so
// there the view zooms to full size and follows your plane, with arrows pointing at players off screen.
const ZOOM_BELOW = 0.6 // arena scale under which the view zooms in
let view = { s: 1, w: W, h: H } // canvas px per arena unit, and the arena units in view
let cam = { x: W / 2, y: H / 2 } // arena point at the centre of the view
function fit() {
  const fitScale = Math.min(innerWidth / W, innerHeight / H)
  const s = fitScale >= ZOOM_BELOW ? fitScale : 1
  view = { s, w: Math.min(W, innerWidth / s), h: Math.min(H, innerHeight / s) }
  canvas.width = view.w * s
  canvas.height = view.h * s
}
addEventListener('resize', fit)
fit()

function drawPlane(p: Plane, color: string, label: string) {
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
  ctx.moveTo(16, 0)
  ctx.lineTo(-10, -10)
  ctx.lineTo(-5, 0)
  ctx.lineTo(-10, 10)
  ctx.fill()
  ctx.restore()
}

/** Everything in the arena, in arena coordinates. */
function drawScene() {
  ctx.fillStyle = '#0b1020'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#334155' // the seam where the arena wraps
  ctx.lineWidth = 2 / view.s
  ctx.strokeRect(0, 0, W, H)
  ctx.font = '12px system-ui'
  ctx.fillStyle = '#fbbf24'
  for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 2, 4, 4)
  for (const [id, peer] of peers) {
    const m = metas.get(id)
    const label = `${m?.name ?? id}${peer.shown.away ? ' (away)' : ''}`
    if (peer.shown.hp > 0) drawPlane(peer.shown, m?.color ?? '#9ca3af', label)
  }
  if (deadFor <= 0) {
    drawPlane(plane, myColor, 'you')
    drawPulse()
  }
  for (const b of booms) drawBoom(b)
}

/**
 * For 2 s after you appear, rings in your color shrink onto your plane, so you can find yourself in a
 * crowd. Only you see them.
 */
function drawPulse() {
  const t = (performance.now() - spawnedAt) / 2000
  if (t >= 1) return
  ctx.strokeStyle = myColor
  ctx.lineWidth = 3 / view.s
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
function drawArrows() {
  ctx.setTransform(view.s, 0, 0, view.s, (view.w / 2) * view.s, (view.h / 2) * view.s) // origin at centre
  for (const [id, peer] of peers) {
    if (peer.shown.hp <= 0) continue
    const dx = wrapDelta(cam.x, peer.shown.x, W)
    const dy = wrapDelta(cam.y, peer.shown.y, H)
    const at = edgePoint(dx, dy, view.w / 2, view.h / 2, 16)
    if (!at) continue
    ctx.save()
    ctx.translate(at.x, at.y)
    ctx.rotate(Math.atan2(dy, dx))
    ctx.globalAlpha = peer.shown.away ? 0.3 : 0.9
    ctx.fillStyle = metas.get(id)?.color ?? '#9ca3af'
    ctx.beginPath()
    ctx.moveTo(10, 0)
    ctx.lineTo(-6, -7)
    ctx.lineTo(-6, 7)
    ctx.fill()
    ctx.restore()
  }
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
  const all = [
    { name: `${myName} (you)`, color: myColor, kills, deaths, you: true },
    ...[...peers.keys()].map((id) => ({
      ...(metas.get(id) ?? { name: id, color: '#9ca3af', kills: 0, deaths: 0 }),
      you: false,
    })),
  ].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  // Top 10, plus your own row (with your rank) when you are further down.
  const mine = all.findIndex((r) => r.you)
  const shown = all.slice(0, 10).map((r, i) => ({ ...r, rank: i + 1 }))
  if (mine >= 10) shown.push({ ...all[mine]!, rank: mine + 1 })
  scores.replaceChildren(
    ...shown.map((r) => {
      const li = document.createElement('li')
      const name = Object.assign(document.createElement('span'), { textContent: `${r.rank}. ${r.name}` })
      name.style.color = r.color
      li.append(name, Object.assign(document.createElement('span'), { textContent: `${r.kills} / ${r.deaths}` }))
      return li
    }),
  )
}, 250)

// A background tab pauses the frame loop, so the plane stops and can't be hit there. Peers are told
// (`away` in pos) and draw it faded; the frame loop handles the return. Keys released while hidden
// would otherwise stay held.
const AWAY_AFTER = 500 // ms without a frame
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return
  keys.clear()
  mouseFiring = false
  for (const b of document.querySelectorAll('#touch .held')) b.classList.remove('held')
})

// 10 Hz on a timer (prediction and easing hide the gaps), not in the frame loop: background tabs pause rAF but still run timers
// (throttled to ~1 Hz), which keeps an idle player under the 3 s drop timeout.
setInterval(() => {
  const offset = clock.offset
  const away = document.hidden || performance.now() - last > AWAY_AFTER
  net.sendPos({ ...plane, away, ts: offset === undefined ? undefined : Date.now() + offset })
}, 100)

let last = performance.now()
function frame(now: number) {
  if (now - last > AWAY_AFTER) {
    // Back from away: drop shots that arrived meanwhile, so none hits retroactively, and shield.
    bullets = bullets.filter((b) => b.owner === me)
    shieldFor = SPAWN_SHIELD
  }
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  if (deadFor > 0 && (deadFor -= dt) <= 0) {
    const live = [...peers.values()].map((p) => p.shown).filter((p) => p.hp > 0)
    plane = spawn(maxHpFor(peers.size + 1), live) // health follows the room's size; spot away from others
    spawnedAt = now
    shieldFor = SPAWN_SHIELD
  }
  const alive = deadFor <= 0
  shieldFor -= dt
  plane.shielded = shieldFor > 0

  // Zoomed in, the camera follows your plane (and stays put while you are shot down).
  const zoomed = view.w < W || view.h < H
  if (!zoomed) cam = { x: W / 2, y: H / 2 }
  else if (alive) cam = { x: plane.x, y: plane.y }
  const mx = cam.x + ((mouse?.fx ?? 0.5) - 0.5) * view.w
  const my = cam.y + ((mouse?.fy ?? 0.5) - 0.5) * view.h

  if (alive)
    stepPlane(
      plane,
      {
        left: keys.has('KeyA') || keys.has('ArrowLeft'),
        right: keys.has('KeyD') || keys.has('ArrowRight'),
        boost: keys.has('KeyW') || keys.has('ArrowUp'),
        // Ignored with the cursor right on the plane, where the heading to it would jitter.
        target:
          mouse && Math.hypot(mx - plane.x, my - plane.y) > 20 ? Math.atan2(my - plane.y, mx - plane.x) : undefined,
      },
      dt,
    )
  cooldown -= dt
  if (alive && (keys.has('Space') || mouseFiring) && cooldown <= 0) {
    cooldown = FIRE_COOLDOWN
    shieldFor = 0 // firing gives up the spawn shield, so it can't be used to attack safely
    const shot = { x: plane.x, y: plane.y, a: plane.a }
    bullets.push({ ...shot, age: 0, owner: me })
    const offset = clock.offset
    net.sendEvent({ t: 'shot', ...shot, ts: offset === undefined ? undefined : Date.now() + offset })
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
      deaths++
      // Sent three times: datagrams can be lost, and receivers count each death number once.
      for (let i = 0; i < 3; i++) net.sendEvent({ t: 'kill', by, n: deaths })
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
      stats?.forget(id)
    } else ease(peer.shown, predict(peer.net, (now - peer.seen) / 1000), dt)
  }
  if (scoreChanged) {
    scoreChanged = false
    sendMeta()
  }
  for (const b of booms) b.age += dt
  booms = booms.filter((b) => b.age < BOOM_LIFE)

  // The arena wraps, so the scene is drawn 3×3 times around the camera; the canvas shows what's in view.
  ctx.setTransform(view.s, 0, 0, view.s, (view.w / 2 - cam.x) * view.s, (view.h / 2 - cam.y) * view.s)
  for (const ox of [-W, 0, W])
    for (const oy of [-H, 0, H]) {
      ctx.save()
      ctx.translate(ox, oy)
      drawScene()
      ctx.restore()
    }
  if (zoomed) drawArrows()

  const status = alive
    ? `HP ${plane.hp}/${maxHpFor(peers.size + 1)}`
    : `shot down by ${killedBy} · respawning in ${Math.ceil(deadFor)}`
  hud.textContent = `room ${room} · ${status} · players ${peers.size + 1}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
