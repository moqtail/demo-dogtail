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
  PILOTS,
  FIRE_COOLDOWN,
  H,
  maxHpFor,
  RESPAWN_DELAY,
  SPAWN_SHIELD,
  W,
  ease,
  findHit,
  predict,
  shotLag,
  spawn,
  stepBullets,
  stepPlane,
  type Bullet,
  type EventMsg,
  isAce,
  type MetaMsg,
  type PosMsg,
  type WireMsg,
  type Plane,
  type PowerUp,
  PIC,
  packPic,
  unpackPic,
  viewScale,
  ARMOR,
  PICKUP_RADIUS,
  RAPID,
  POWER_ICON,
  powerUpsAt,
  REACTIONS,
  wrapDist,
} from './game'
import { BOOM_LIFE, drawFrame, type Boom, type View } from './draw'
import { startAnalytics } from './analytics'
import { connect, syncClock, type Senders } from './net'
import { Ace } from './ace'
import type { Brain } from './brain'
import { watchStats } from './netstats'
import { play, setSound, soundOn, type SoundName } from './sound'

declare const __CERT_HASH__: string // injected by vite.config.ts

const params = new URLSearchParams(location.search)
// With a LAN cert (npm run dev after make-cert.sh) the relay runs on this machine; otherwise the public one.
// The join screen can change it (see the Relay field).
const DEFAULT_RELAY = __CERT_HASH__ ? `moqt://${location.hostname}:4433` : 'moqt://relay.n1.fra.moqtail.dev'
const me = Math.random().toString(16).slice(2, 8)
const analytics = startAnalytics(me) // at page load, so visits that never join count too
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
  if (e.code === 'KeyM' && !e.repeat) minimap.flip()
  if (e.code === 'KeyE' && !e.repeat) showReactions.flip()
  if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomBy(1.1)
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomBy(1 / 1.1)
  if (e.code === 'Digit0' && !e.repeat) zoomBy(0)
  const r = /^Digit([1-4])$/.exec(e.code)
  if (r && !e.repeat) react(REACTIONS[Number(r[1]) - 1]!)
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
const onSettings = (e: Event) => (e.target as Element).closest('#tools, #join, #reactions') !== null
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
/** The last reaction per player (`me` included), shown over their plane for REACT_SHOW ms. */
const reactions = new Map<string, { e: string; at: number }>()
let lastReact = 0
/** Power-ups on the map now; keys of ones someone grabbed; and how long yours last (s). */
let drops: PowerUp[] = []
const grabbed = new Set<string>()
let armorFor = 0 // 🛡️: can't be hit; unlike the spawn shield, firing keeps it
let rapidFor = 0 // ⚡: fires twice as fast

// Kill feed: the last few kills, top left, each fading after FEED_SHOW ms.
const feedList = document.getElementById('feed')!
const FEED_SHOW = 5000
const who = (id: string) => {
  const m = id === me ? { name: 'you', color: myColor, pilot: myPilot } : metas.get(id)
  const span = document.createElement('span')
  span.textContent = `${m?.pilot ? m.pilot + ' ' : ''}${m?.name ?? id}`
  span.style.color = m?.color ?? '#9ca3af'
  return span
}
function feed(killer: string, victim: string) {
  const li = document.createElement('li')
  li.append(who(killer), ' ✈︎💥 ', who(victim))
  feedList.prepend(li)
  while (feedList.children.length > 5) feedList.lastElementChild!.remove()
  setTimeout(() => li.remove(), FEED_SHOW)
}
let scoreChanged = false // sends meta from the frame loop, so callbacks never run before `net` exists
let killedBy = ''
let deadFor = 0 // seconds until respawn; > 0 while shot down
/** `net` is the last snapshot, `shown` the eased plane that is drawn. */
const peers = new Map<string, { net: Plane; shown: Plane; seen: number }>()
/** Explosion effects: a big one when a plane is shot down, a small one on a hit. */
let booms: Boom[] = []
const boom = (p: Plane, big: boolean) => booms.push({ x: p.x, y: p.y, age: 0, big })
/** Picture pilots of other players: what they sent, and it drawn on a small canvas. */
const picData = new Map<string, string>()
const pics = new Map<string, HTMLCanvasElement>()
function picCanvas(d: string) {
  const c = Object.assign(document.createElement('canvas'), { width: PIC, height: PIC })
  c.getContext('2d')!.putImageData(new ImageData(unpackPic(d)!, PIC, PIC), 0, 0)
  return c
}
// Settings → Players: other players' pictures can be hidden (their plane then has an empty cockpit).
const picsBox = document.getElementById('show-pics') as HTMLInputElement
try {
  picsBox.checked = localStorage.getItem('dogtail.pics') !== 'off'
} catch {
  // Storage blocked: shown.
}
picsBox.addEventListener('change', () => {
  try {
    localStorage.setItem('dogtail.pics', picsBox.checked ? 'on' : 'off')
  } catch {
    // Storage blocked: lasts until reload.
  }
})
let joined = false // set once connected: before that there is no `net` to send on

/** An on/off setting with a top-right button, remembered on this device; on unless turned off. */
function setting(key: string, buttonId: string, onChange: (on: boolean) => void = () => {}) {
  const button = document.getElementById(buttonId)!
  let on = true
  try {
    on = localStorage.getItem(key) !== 'off'
  } catch {
    // Storage blocked: on.
  }
  const show = () => {
    button.setAttribute('aria-pressed', String(on))
    onChange(on)
  }
  const flip = () => {
    on = !on
    show()
    try {
      localStorage.setItem(key, on ? 'on' : 'off')
    } catch {
      // Storage blocked: lasts until reload.
    }
  }
  button.addEventListener('click', () => {
    button.blur() // or Space, the fire key, would press it again
    flip()
  })
  show()
  return {
    button,
    flip,
    get on() {
      return on
    },
  }
}

// Minimap (zoomed only): the whole arena at the bottom centre, toggled with 🗺 or M.
const minimap = setting('dogtail.map', 'map')
// Reactions: 😀 or E hides the reaction buttons and everyone's reactions.
const reactBar = document.getElementById('reactions')!
const showReactions = setting('dogtail.reactions', 'react-toggle', (on) => (reactBar.hidden = !on || !joined))

// Screens big enough show the whole arena; on a phone that would shrink a plane to a few pixels, so
// there the view starts at full size. Either way the player can zoom (wheel, pinch, +/-; 0 resets),
// remembered on this device. Zoomed in, the view follows your plane, with arrows pointing at players
// off screen and the minimap.
const ZOOM_KEY = 'dogtail.zoom'
let zoom = 1
try {
  zoom = Number(localStorage.getItem(ZOOM_KEY)) || 1
} catch {
  // Storage blocked: the default.
}
let view: View = { s: 1, w: W, h: H }
let cam = { x: W / 2, y: H / 2 } // arena point at the centre of the view
function fit() {
  const v = viewScale(Math.min(innerWidth / W, innerHeight / H), zoom)
  zoom = v.zoom
  view = { s: v.s, w: Math.min(W, innerWidth / v.s), h: Math.min(H, innerHeight / v.s) }
  minimap.button.hidden = view.w >= W && view.h >= H // the minimap only exists while zoomed in
  canvas.width = view.w * v.s
  canvas.height = view.h * v.s
}
function zoomBy(factor: number) {
  zoom = factor ? zoom * factor : 1 // 0: back to the default
  fit()
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom))
  } catch {
    // Storage blocked: lasts until reload.
  }
}
// Mouse wheel, and trackpad pinch, which browsers send as a wheel with ctrlKey (page zoom, otherwise).
addEventListener(
  'wheel',
  (e) => {
    if (onSettings(e)) return
    e.preventDefault()
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))
  },
  { passive: false },
)
// Safari on a Mac sends a trackpad pinch as gesture events. On iPhone and iPad they also fire for any
// two fingers, such as a thumb on ◀ and one on FIRE, so there only the pinch below counts.
let gestureScale = 1
const gesture = (e: Event & { scale?: number }) => {
  e.preventDefault() // no page zoom
  if (navigator.maxTouchPoints > 0 || e.scale === undefined) return
  zoomBy(e.scale / gestureScale)
  gestureScale = e.scale
}
addEventListener('gesturestart', (e) => (gesture(e), (gestureScale = 1)))
addEventListener('gesturechange', gesture)
// Touch: two fingers pinching on the game itself (not on the buttons).
const pinch = new Map<number, { x: number; y: number }>()
const spread = () => {
  const [a, b] = [...pinch.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') pinch.set(e.pointerId, { x: e.clientX, y: e.clientY })
})
canvas.addEventListener('pointermove', (e) => {
  if (!pinch.has(e.pointerId)) return
  const before = spread()
  pinch.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinch.size === 2 && before > 0) zoomBy(spread() / before)
})
for (const ev of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(ev, (e) => pinch.delete(e.pointerId))
addEventListener('resize', fit)
fit()

// Join screen: name, color and room, remembered on this device. The room goes into the URL so the
// address bar is the invite link.
const joinForm = document.getElementById('join') as HTMLFormElement
const PROFILE_KEY = 'dogtail.profile'
let saved: { name?: string; color?: string; pilot?: string; pic?: string; room?: string; relay?: string } = {}
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
const startPilot = PILOTS.includes(saved.pilot!)
  ? saved.pilot!
  : PILOTS[1 + Math.floor(Math.random() * (PILOTS.length - 1))]!
for (const e of PILOTS) {
  const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'pilot', value: e })
  radio.dataset.e = e || '✈'
  radio.setAttribute('aria-label', e ? `pilot ${e}` : 'no pilot')
  radio.checked = e === startPilot
  document.getElementById('pilots')!.append(radio)
}
// Picture pilot: 📷 opens the file picker (on a phone: take a photo or choose one). The picture is
// cropped to a square, shrunk to PIC×PIC and kept on this device; tapping it again picks another.
let myPicData = unpackPic(saved.pic) ? saved.pic : undefined
const picRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'pilot', value: 'pic' })
picRadio.setAttribute('aria-label', 'your picture as pilot')
const showPicRadio = () => {
  picRadio.dataset.e = myPicData ? '' : '📷'
  picRadio.style.backgroundImage = myPicData ? `url(${picCanvas(myPicData).toDataURL()})` : ''
}
showPicRadio()
picRadio.checked = saved.pilot === 'pic' && myPicData !== undefined
document.getElementById('pilots')!.append(picRadio)
const picFile = document.getElementById('pic-file') as HTMLInputElement
let picWasChecked = false
picRadio.addEventListener('pointerdown', () => (picWasChecked = picRadio.checked))
picRadio.addEventListener('click', () => {
  if (!myPicData || picWasChecked) picFile.click()
})
picFile.addEventListener('change', async () => {
  const file = picFile.files?.[0]
  picFile.value = '' // so choosing the same file again still fires
  if (!file) return
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = Object.assign(document.createElement('canvas'), { width: PIC, height: PIC })
    const g = c.getContext('2d')!
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PIC, PIC)
    myPicData = packPic(g.getImageData(0, 0, PIC, PIC).data)
    picRadio.checked = true
    showPicRadio()
  } catch {
    document.getElementById('notice')!.textContent = 'That picture could not be read. Try another one.'
  } finally {
    URL.revokeObjectURL(url)
  }
})
const field = (n: string) => joinForm.elements.namedItem(n) as HTMLInputElement
field('name').value = saved.name ?? ''
// Room: the link's, else the one this device last joined, else a fresh random one, so a first game
// doesn't land in a room strangers on the public relay also default to.
const ROOM_CAP = 50
const BIRDS = ['falcon', 'hawk', 'eagle', 'raven', 'kestrel', 'osprey', 'condor', 'swift', 'merlin', 'harrier']
const randomRoom = () => `${BIRDS[Math.floor(Math.random() * BIRDS.length)]}-${100 + Math.floor(Math.random() * 900)}`
const defaultRoom = typeof saved.room === 'string' && saved.room.trim() ? saved.room.trim() : randomRoom()
field('room').value = params.get('room') ?? defaultRoom
// Relay: the link's, else the one this device last used, else the default. Shown folded unless changed.
const relayValue = () => field('relay').value.trim() || DEFAULT_RELAY
field('relay').value = params.get('relay') ?? saved.relay ?? DEFAULT_RELAY
field('relay').placeholder = DEFAULT_RELAY
;(document.getElementById('relay-box') as HTMLDetailsElement).open = relayValue() !== DEFAULT_RELAY
// The invite link carries the room, and the relay when it isn't the default, so friends land together.
const roomUrl = () => {
  const u = new URL(location.href)
  u.searchParams.set('room', field('room').value.trim() || defaultRoom)
  if (relayValue() === DEFAULT_RELAY) u.searchParams.delete('relay')
  else u.searchParams.set('relay', relayValue())
  u.searchParams.delete('full')
  return u.href
}
const showInvite = () => (document.getElementById('invite')!.textContent = `Invite others: ${roomUrl()}`)
const fullRoom = params.get('full')
if (fullRoom)
  document.getElementById('notice')!.textContent = `Room ${fullRoom} is full (${ROOM_CAP} players). Here is a new one.`
field('room').addEventListener('input', showInvite)
field('relay').addEventListener('input', showInvite)
showInvite()
hud.textContent = ''
await new Promise<void>((resolve) =>
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault()
    resolve()
  }),
)
const room = field('room').value.trim() || defaultRoom
const relay = relayValue()
const myName = field('name').value.trim().slice(0, 16)
const myColor = (joinForm.elements.namedItem('color') as RadioNodeList).value || startColor
const pilotChoice = (joinForm.elements.namedItem('pilot') as RadioNodeList).value
const myPic = pilotChoice === 'pic' ? myPicData : undefined
const myPicImg = myPic ? picCanvas(myPic) : undefined
const myPilot = pilotChoice === 'pic' ? '' : pilotChoice // the emoji in meta; a picture goes as its own message
try {
  localStorage.setItem(
    PROFILE_KEY,
    JSON.stringify({
      name: myName,
      color: myColor,
      pilot: pilotChoice,
      pic: myPicData,
      room,
      relay: relay === DEFAULT_RELAY ? undefined : relay,
    }),
  )
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

// Messages from other players, from the network or from aces hosted in this tab, go to the game here
// and to every ace in this tab but their sender.
function receive(from: string, w: WireMsg) {
  for (const [id, a] of aces) if (id !== from) a.hear(from, w)
  if (from === me) return // our own, passed on to our aces only
  if (w.t === 'pos') onPos(from, w.p)
  else if (w.t === 'meta') onMeta(from, w.m)
  else onEvent(from, w)
}
function onPos(id: string, p: PosMsg) {
  stats?.onPos(id, p.ts)
  const peer = peers.get(id)
  if (peer) Object.assign(peer, { net: p, seen: performance.now() })
  else peers.set(id, { net: p, shown: { ...p }, seen: performance.now() })
}
function onEvent(id: string, m: EventMsg) {
  if (m.t === 'kill') {
    const key = `${id}:${m.n}`
    if (killsSeen.has(key)) return // a repeat of a kill already counted
    killsSeen.add(key)
    feed(m.by, id)
  }
  if (m.t === 'react') return void reactions.set(id, { e: m.e, at: performance.now() })
  if (m.t === 'grab') return void grabbed.add(m.k)
  if (m.t === 'pic') {
    if (picData.get(id) !== m.d) (picData.set(id, m.d), pics.set(id, picCanvas(m.d)))
    return
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
}
function onMeta(id: string, m: MetaMsg) {
  metas.set(id, m)
}

const conn = await connect(
  relay,
  room,
  me,
  __CERT_HASH__,
  {
    onPos: (id, p) => receive(id, { t: 'pos', p }),
    onMeta: (id, m) => receive(id, { t: 'meta', m }),
    onEvent: receive,
  },
  (client) => (stats = watchStats(client, clock, (id) => metas.get(id)?.name ?? id, statsPanel)),
).catch((err) => {
  hud.textContent = `Could not connect to ${relay}: ${err}`
  throw err
})
/** Sends on a player's track and hands the message to this tab's aces and game, which the relay won't. */
const tellAll = (id: string, out: Senders): Senders => ({
  sendPos: (p) => (out.sendPos(p), receive(id, { t: 'pos', p })),
  sendEvent: (m) => (out.sendEvent(m), receive(id, m)),
  sendMeta: (m) => (out.sendMeta(m), receive(id, { t: 'meta', m })),
})
const net = { ...tellAll(me, conn), joinRtt: conn.joinRtt }

stats?.setRtt(net.joinRtt)

const device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop'
analytics.track('join', { room, device })
// Leaving: closing the tab, Leave (which reloads) or switching away on a phone all fire pagehide.
addEventListener('pagehide', () =>
  analytics.track('leave', { room, seconds: Math.round((Date.now() - joinedAt) / 1000), kills, deaths }),
)
setInterval(() => analytics.track('room_size', { room, players: peers.size + 1 }), 60_000)
spawnedAt = performance.now() // the first pulse plays once you're in, not behind the join screen

// Aces: while fewer than ROOM_FILL people are in the room, pilots trained with reinforcement learning
// (brain.ts, train/) fill it. The active player with the lowest id hosts them in their tab, each on its
// own track over this connection; when that player leaves or goes away, the next one takes over with
// new aces. Ace ids start with "z", which a player's hex id never does.
const ROOM_FILL = 4
const aces = new Map<string, Ace>()
let brain: Brain | undefined
let aceCount = 0
let hosting = false // one change at a time: loading the weights and publishing a track take a moment
setInterval(async () => {
  if (hosting) return
  const people = [...peers].filter(([id]) => !isAce(id))
  const active = [...people.filter(([, p]) => !p.net.away).map(([id]) => id)]
  if (!document.hidden && performance.now() - last < AWAY_AFTER) active.push(me)
  const want = active.length && active.sort()[0] === me ? Math.max(0, ROOM_FILL - people.length - 1) : 0
  hosting = true
  try {
    if (aces.size > want) {
      const [id] = [...aces.keys()].slice(-1)
      aces.delete(id!) // it goes quiet; other players drop it after 3 s
      peers.delete(id!)
      metas.delete(id!)
    } else if (aces.size < want) {
      brain ??= (await import('./brain.json')).default as Brain // only a hosting tab downloads the weights
      const id = `z${me}${aceCount++}`
      const used = new Set([myColor, ...[...metas.values()].map((m) => m.color)])
      const color = COLORS.find((c) => !used.has(c)) ?? COLORS[aceCount % COLORS.length]!
      const ace = new Ace(
        id,
        { name: `ace-${aceCount}`, color, pilot: '🤖' },
        room,
        brain,
        tellAll(id, await conn.player(id)),
        clock,
      )
      aces.set(id, ace)
    }
  } finally {
    hosting = false
  }
}, 1000)
setInterval(() => aces.forEach((a) => a.tick()), 100)
setInterval(() => aces.forEach((a) => a.meta()), 2000)

// A room holds ROOM_CAP players. Once the others have shown up (pos is 10 Hz), a newcomer to a full
// room goes back to the join screen with a fresh room. Only newcomers check, so nobody is kicked;
// two joining at once may both stay, which is fine.
setTimeout(() => {
  if (peers.size + 1 > ROOM_CAP)
    (analytics.track('room_full', { room }), location.replace(`?room=${randomRoom()}&full=${encodeURIComponent(room)}`))
}, 1500)

// Meta goes out on join, on every score change and every 2 s: the repeats reach players who join
// later without relying on the relay to replay an old group.
const sendMeta = () => net.sendMeta({ name: myName, color: myColor, pilot: myPilot, kills, deaths })
sendMeta()
setInterval(sendMeta, 2000)
// Your picture: every 3 s, for the same reason. About 800 bytes, one datagram.
if (myPic) {
  const sendPic = () => net.sendEvent({ t: 'pic', d: myPic })
  sendPic()
  setInterval(sendPic, 3000)
}

// Scoreboard, best first. 4 Hz is plenty for text and keeps DOM work out of the frame loop.
const scores = document.getElementById('scores')!
setInterval(() => {
  const all = [
    { name: `${myName} (you)`, color: myColor, kills, deaths, you: true },
    ...[...peers.keys()].map((id) => ({
      ...(metas.get(id) ?? { name: id, color: '#9ca3af', pilot: '', kills: 0, deaths: 0 }),
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

// Reactions: keys 1–4 or the buttons; at most one a second, so nobody can flood the room.
function react(e: string) {
  const now = performance.now()
  if (!joined || !showReactions.on || now - lastReact < 1000) return
  lastReact = now
  reactions.set(me, { e, at: now })
  net.sendEvent({ t: 'react', e })
}
joined = true
reactBar.hidden = !showReactions.on
for (const [i, e] of REACTIONS.entries()) {
  const b = Object.assign(document.createElement('button'), { textContent: e, title: `${e} (${i + 1})` })
  b.addEventListener('click', () => (b.blur(), react(e)))
  reactBar.append(b)
}

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
  armorFor -= dt
  rapidFor -= dt
  plane.shielded = shieldFor > 0 || armorFor > 0

  // Power-ups: everyone derives the same drops from the shared clock; the first to touch one tells the rest.
  // shortcut: two players touching the same drop within one network delay both get it; fine for a game.
  drops = powerUpsAt(room, Date.now() + (clock.offset ?? 0)).filter((d) => !grabbed.has(d.key))
  const got = alive ? drops.find((d) => wrapDist(plane.x, plane.y, d.x, d.y) < PICKUP_RADIUS) : undefined
  if (got) {
    grabbed.add(got.key)
    for (let i = 0; i < 2; i++) net.sendEvent({ t: 'grab', k: got.key }) // twice: datagrams can be lost
    if (got.kind === 'shield') armorFor = ARMOR
    else if (got.kind === 'rapid') rapidFor = RAPID
    else plane.hp = Math.min(plane.hp + 1, maxHpFor(peers.size + 1) + 1) // can go one over full
    play('hit')
  }

  const zoomed = view.w < W || view.h < H
  if (!zoomed) cam = { x: W / 2, y: H / 2 }
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
  // Zoomed in, the camera follows your plane (and stays put while you are shot down). Set after the
  // plane moves, so it is drawn dead centre: set before, frame-time jitter would make it tremble.
  if (zoomed && alive) cam = { x: plane.x, y: plane.y }
  cooldown -= dt
  if (alive && (keys.has('Space') || mouseFiring) && cooldown <= 0) {
    cooldown = rapidFor > 0 ? FIRE_COOLDOWN / 2 : FIRE_COOLDOWN
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
      feed(by, me)
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
      picData.delete(id)
      pics.delete(id)
      stats?.forget(id)
    } else ease(peer.shown, predict(peer.net, (now - peer.seen) / 1000), dt)
  }
  if (scoreChanged) {
    scoreChanged = false
    sendMeta()
  }
  for (const b of booms) b.age += dt
  booms = booms.filter((b) => b.age < BOOM_LIFE)

  drawFrame(ctx, {
    view,
    cam,
    bullets,
    drops,
    booms,
    peers,
    metas,
    reactions: showReactions.on ? reactions : undefined,
    pics: picsBox.checked ? pics : undefined,
    me: { id: me, plane, alive, color: myColor, pilot: myPilot, pic: myPicImg, spawnedAt },
    showMap: minimap.on,
  })

  const powers = [
    armorFor > 0 ? ` · ${POWER_ICON.shield} ${Math.ceil(armorFor)}` : '',
    rapidFor > 0 ? ` · ${POWER_ICON.rapid} ${Math.ceil(rapidFor)}` : '',
  ].join('')
  const status = alive
    ? `HP ${plane.hp}/${maxHpFor(peers.size + 1)}${powers}`
    : `shot down by ${killedBy} · respawning in ${Math.ceil(deadFor)}`
  hud.textContent = `room ${room} · ${status} · players ${peers.size + 1}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
