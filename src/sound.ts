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

/** Synthesized sound effects: no audio files to ship. */

const audio = new AudioContext()
// Browsers start audio suspended until the user interacts with the page.
for (const ev of ['keydown', 'pointerdown'] as const) addEventListener(ev, () => void audio.resume(), { once: true })

/** A tone sliding from `from` Hz to `to` Hz over `seconds`, fading out. */
function sweep(type: OscillatorType, from: number, to: number, seconds: number, volume: number) {
  const t = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(from, t)
  osc.frequency.exponentialRampToValueAtTime(to, t + seconds)
  gain.gain.setValueAtTime(volume, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + seconds)
  osc.connect(gain).connect(audio.destination)
  osc.start(t)
  osc.stop(t + seconds)
}

export type SoundName = 'fire' | 'hit' | 'death'

/** Which sounds are on, remembered per browser. */
export const soundOn: Record<SoundName, boolean> = { fire: true, hit: true, death: true }
const STORAGE_KEY = 'dogfight.sounds'
try {
  Object.assign(soundOn, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
} catch {
  // Storage blocked or corrupt: keep the defaults.
}
export function setSound(name: SoundName, on: boolean) {
  soundOn[name] = on
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(soundOn))
  } catch {
    // Storage blocked: the setting lasts until reload.
  }
}

const effects: Record<SoundName, () => void> = {
  // Quiet short chirp: fired often, so it must not wear on the ear.
  fire: () => sweep('triangle', 1200, 600, 0.06, 0.05),
  // Short sharp blip: your plane took a hit.
  hit: () => sweep('square', 880, 440, 0.12, 0.15),
  // Long falling crash: your plane was shot down.
  death: () => {
    sweep('sawtooth', 400, 40, 0.9, 0.25)
    sweep('square', 120, 30, 0.9, 0.15)
  },
}

export function play(name: SoundName) {
  if (soundOn[name]) effects[name]()
}
