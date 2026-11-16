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
/// <reference types="vite/client" />

/**
 * The game's text in many languages. English is built in; the others are in locales/<code>.json and
 * load only when picked. The language is the browser's, unless one was picked in Settings, which is
 * remembered on the device; anything missing falls back to English.
 */

export const en = {
  connecting: 'Connecting…',
  killFeed: 'Kill feed',
  reactions: 'Reactions',
  reactionsKey: 'Reactions (E)',
  leave: 'Leave',
  leaveTitle: 'Leave the game',
  minimap: 'Minimap',
  minimapKey: 'Minimap (M)',
  fullscreen: 'Full screen',
  fullscreenKey: 'Full screen (F)',
  settings: 'Settings',
  sounds: 'Sounds',
  soundFire: 'Firing',
  soundHit: 'Getting hit',
  soundDeath: 'Shot down',
  network: 'Network',
  showStats: 'Show stats (S)',
  aces: 'Aces',
  fillRooms: 'Fill quiet rooms',
  off: 'Off',
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
  players: 'Players',
  showPics: 'Show their pictures',
  language: 'Language',
  scoreboard: 'Scoreboard',
  teamScores: 'Team scores this round',
  yourName: 'Your name',
  color: 'Color',
  pilot: 'Pilot',
  team: 'Team',
  room: 'Room',
  advanced: 'Advanced',
  relayUrl: 'MoQ relay address',
  relayHint: 'A MoQ relay address, such as {example}',
  join: 'Join',
  poweredBy: 'Powered by',
  steering: 'Steering: drag toward where to fly, past the ring to boost',
  drift: 'Drift',
  fire: 'Fire',
  fireButton: 'FIRE',
  colorN: 'color {n}',
  pilotE: 'pilot {e}',
  noPilot: 'no pilot',
  yourPicture: 'your picture as pilot',
  picError: 'That picture could not be read. Try another one.',
  auto: 'Auto',
  solo: 'Solo',
  red: 'Red',
  blue: 'Blue',
  invite: 'Invite others: {url}',
  roomFull: 'Room {room} is full ({n} players). Here is a new one.',
  streak: '{n} in a row!',
  couldNotConnect: 'Could not connect to {relay}: {err}',
  more: '+{n} more',
  you: 'you',
  youSuffix: '{name} (you)',
  draw: 'Draw, {a}–{b}',
  wins: '{team} win {a}–{b}!',
  switchSides: 'Switch sides (T): only while shot down',
  joinSmaller: 'Join the smaller side (T)',
  switchHint: 'switch sides when shot down',
  shotDownBy: 'shot down by {name} · respawning in {s}',
  hudRoom: 'room {room}',
  hudPlayers: 'players {n}',
  feedback: 'Send feedback',
}
export type Key = keyof typeof en

/** Every language offered, by its own name. */
export const LANGS = {
  en: 'English',
  ar: 'العربية',
  bg: 'Български',
  cs: 'Čeština',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  es: 'Español',
  fa: 'فارسی',
  fr: 'Français',
  he: 'עברית',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sv: 'Svenska',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  zh: '中文',
} as const
export type Lang = keyof typeof LANGS
const RTL: Lang[] = ['ar', 'fa', 'he']
const STORAGE_KEY = 'dogtail.lang'

const files = import.meta.glob<Partial<Record<Key, string>>>('./locales/*.json', { import: 'default' })
let lang: Lang = 'en'
let strings: Partial<Record<Key, string>> = {}

/** The first of the browser's languages offered here, by its main part ("pt-BR" is "pt"), else English. */
export function pick(wanted: readonly string[]): Lang {
  for (const w of wanted) {
    const code = w.toLowerCase().split('-')[0]!
    if (code in LANGS) return code as Lang
  }
  return 'en'
}

/** `key` in the current language, with {name} placeholders filled from `vars`. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return (strings[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? `{${v}}`))
}

export const currentLang = () => lang

/** Loads `to` (the saved or browser language by default), sets the page's direction and fills its text. */
export async function setLang(to?: Lang) {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
    if (to) localStorage.setItem(STORAGE_KEY, to)
  } catch {
    // Storage blocked: the language lasts until reload.
  }
  lang = to ?? (saved && saved in LANGS ? (saved as Lang) : pick(navigator.languages ?? [navigator.language]))
  strings = lang === 'en' ? {} : ((await files[`./locales/${lang}.json`]?.().catch(() => undefined)) ?? {})
  document.documentElement.lang = lang
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr'
  translatePage()
  dispatchEvent(new Event('langchange')) // for text the page builds itself
}

/** Fills elements marked data-i18n (text), data-i18n-title and data-i18n-aria (aria-label). */
export function translatePage(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key)
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]'))
    el.title = t(el.dataset.i18nTitle as Key, { example: 'moqt://relay.moqtail.dev' })
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]'))
    el.setAttribute('aria-label', t(el.dataset.i18nAria as Key))
}
