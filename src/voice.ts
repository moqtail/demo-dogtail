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

/**
 * Voice chat between teammates. Each player's voice is a `voice` track under
 * dogtail-voice/<room>/<team>/<player>, and each player subscribes to dogtail-voice/<room>/<own team>,
 * so the relay only sends teammates' voices; the game's dogtail/<room> subscription never sees them.
 * Speech goes as 20 ms Opus frames, one datagram each, one group per stretch of talking, and only while
 * the player talks: an open mic sends when it hears a voice, push-to-talk while V is held.
 */

import type { MOQtailClient } from 'moqtail/client'
import { Tuple } from 'moqtail/model'
import { rms, VoiceGate, type Team } from './game'
import { openTrack } from './net'
import { audio } from './sound'

export type VoiceMode = 'open' | 'ptt' | 'off'
const FRAME = 960 // samples: 20 ms at 48 kHz
// Timestamps (µs) carry the frame's place: group * STRETCH + object * STEP.
const STRETCH = 1_000_000_000n
const STEP = 20_000n
const OPUS = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 } as const

/** What this browser can do: hear needs AudioDecoder, talk needs AudioEncoder and a microphone. */
export const canHear = typeof AudioDecoder !== 'undefined'
export const canTalk = canHear && typeof AudioEncoder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

type Talker = { decoder: AudioDecoder; node: AudioWorkletNode; n: number }

export class Voice {
  mode: VoiceMode = 'open'
  muted = true // open mic: starts muted, so the microphone is only asked for when the player unmutes
  held = false // push-to-talk: V or the mic button held
  micDenied = false
  /** When each player's voice last arrived (performance.now() ms). */
  readonly heard = new Map<string, number>()
  /** Whether we are sending right now. */
  sending = false
  /** Players whose voice is dropped here. */
  readonly mutedPlayers = new Set<string>()

  #team: Team = ''
  #ns: Tuple | undefined
  #send: ((group: bigint, object: bigint, payload: Uint8Array) => void) | undefined
  #cancel: (() => Promise<void>) | undefined
  #talkers = new Map<string, Talker>()
  #worklet: Promise<void> | undefined
  #workletLoaded = false
  #ready: Promise<void> | undefined
  #mic: MediaStream | undefined
  #capture: AudioWorkletNode | undefined
  #source: MediaStreamAudioSourceNode | undefined
  #encoder: AudioEncoder | undefined
  #gate = new VoiceGate()
  #pcm: number[] = []
  #group = 0n
  #object = 0n
  #busy = Promise.resolve() // team changes, one at a time

  constructor(
    readonly client: MOQtailClient,
    readonly room: string,
    readonly me: string,
  ) {
    client.on('peerpublish', (msg) => {
      const path = msg.fullTrackName.namespace.toUtf8Path().split('/').filter(Boolean)
      if (new TextDecoder().decode(msg.fullTrackName.name) !== 'voice') return
      const [root, room, team, player] = path
      if (root !== 'dogtail-voice' || room !== this.room || !player) return
      client.subscribeToTrackDatagrams(msg.trackAlias, (obj) => {
        // Tracks pushed before a side switch can keep coming: only teammates are played.
        if (team !== this.#team || this.mode === 'off' || !obj.payload || this.mutedPlayers.has(player)) return
        this.#play(player, obj.payload)
      })
    })
  }

  /** Our side now ('' when not in a team fight, or voice is off): moves our track and subscription. */
  setTeam(team: Team) {
    const want: Team = this.mode === 'off' ? '' : team
    if (want === this.#team) return
    this.#team = want
    this.#busy = this.#busy.then(() => this.#move(want)).catch((err) => console.warn('dogtail: voice', err))
  }

  async #move(team: Team) {
    this.#send = undefined
    await this.#cancel?.()
    this.#cancel = undefined
    if (this.#ns) await this.client.unpublishNamespace(this.#ns)
    this.#ns = undefined
    for (const t of this.#talkers.values()) {
      t.node.disconnect()
      if (t.decoder.state !== 'closed') t.decoder.close()
    }
    this.#talkers.clear()
    if (!team) this.#stopMic() // nobody to talk to: the microphone (and its indicator) goes off
    if (!team || team !== this.#team) return
    this.#worklet ??= audio.audioWorklet.addModule('/voice-worklet.js').then(() => void (this.#workletLoaded = true))
    await this.#worklet
    const prefix = `dogtail-voice/${this.room}/${team}`
    this.#ns = Tuple.fromUtf8Path(`${prefix}/${this.me}`)
    await this.client.publishNamespace(this.#ns)
    this.#send = await openTrack(this.client, this.#ns, 'voice', 0)
    this.#cancel = (await this.client.subscribeTracks(Tuple.fromUtf8Path(prefix))).cancel
    if (this.#wantMic()) await this.#startMic()
  }

  /** Whether the player has asked to talk: unmuted, or holding push-to-talk. */
  #wantMic = () => canTalk && !this.micDenied && !!this.#send && (this.mode === 'ptt' ? this.held : !this.muted)

  /**
   * Called when the player unmutes or holds push-to-talk: the microphone (and the browser's permission
   * prompt) comes only then, never just for joining a team.
   */
  talk() {
    this.#busy = this.#busy.then(() => (this.#wantMic() ? this.#startMic() : undefined))
  }

  /** The microphone and encoder, once; asking for the microphone shows the browser's permission prompt. */
  #startMic() {
    this.#ready ??= (async () => {
      try {
        this.#mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        })
      } catch {
        this.micDenied = true // still hears teammates
        return
      }
      try {
        if (!(await AudioEncoder.isConfigSupported(OPUS)).supported) throw new Error('no Opus encoder')
        this.#encoder = this.#newEncoder()
        const capture = (this.#capture = new AudioWorkletNode(audio, 'voice-capture'))
        capture.port.onmessage = (e: MessageEvent<Float32Array>) => this.#captured(e.data)
        this.#source = audio.createMediaStreamSource(this.#mic) // Firefox throws if the mic runs at another rate
        this.#source.connect(capture).connect(audio.destination) // outputs silence; connected so it runs
      } catch (err) {
        console.warn('dogtail: voice cannot talk here', err)
        this.#stopMic()
        this.micDenied = true // shows 🚫; still hears teammates
      }
    })()
    return this.#ready
  }

  #newEncoder() {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        // Numbered when encoded, not here: output is asynchronous, and a new stretch may have begun since.
        const ts = BigInt(chunk.timestamp)
        this.#send?.(ts / STRETCH, (ts % STRETCH) / STEP, data)
      },
      error: (err) => console.warn('dogtail: voice encoder', err), // it closes; #captured makes a new one
    })
    encoder.configure(OPUS)
    return encoder
  }

  #stopMic() {
    for (const tr of this.#mic?.getTracks() ?? []) tr.stop()
    this.#source?.disconnect()
    this.#capture?.disconnect()
    if (this.#encoder?.state === 'configured') this.#encoder.close()
    ;[this.#mic, this.#source, this.#capture, this.#encoder, this.#ready] = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]
    this.#pcm = []
    this.sending = false
  }

  #captured(samples: Float32Array) {
    for (const v of samples) this.#pcm.push(v)
    while (this.#pcm.length >= FRAME) {
      const frame = Float32Array.from(this.#pcm.splice(0, FRAME))
      const voice = this.#gate.push(rms(frame), performance.now())
      const talk = !!this.#send && (this.mode === 'ptt' ? this.held : !this.muted && voice)
      if (talk && !this.sending) [this.#group, this.#object] = [this.#group + 1n, 0n] // a new stretch of talking
      this.sending = talk
      if (this.#encoder?.state === 'closed') this.#encoder = this.#newEncoder() // after an encoder error
      if (!talk || this.#encoder?.state !== 'configured') continue
      const data = new AudioData({
        format: 'f32',
        sampleRate: 48000,
        numberOfFrames: FRAME,
        numberOfChannels: 1,
        timestamp: Number(this.#group * STRETCH + this.#object++ * STEP),
        data: frame,
      })
      this.#encoder.encode(data)
      data.close()
    }
  }

  #play(player: string, payload: Uint8Array) {
    this.heard.set(player, performance.now())
    let t = this.#talkers.get(player)
    if (!t) {
      if (!this.#workletLoaded || !canHear) return
      const node = new AudioWorkletNode(audio, 'voice-player')
      node.connect(audio.destination)
      const decoder = new AudioDecoder({
        output: (d) => {
          const pcm = new Float32Array(d.numberOfFrames)
          d.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' })
          d.close()
          node.port.postMessage(pcm, [pcm.buffer])
        },
        error: (err) => {
          console.warn('dogtail: voice decoder', player, err)
          node.disconnect()
          // A failed decoder is closed: the next frame starts afresh (unless that already happened).
          if (this.#talkers.get(player)?.decoder === decoder) this.#talkers.delete(player)
        },
      })
      decoder.configure(OPUS)
      t = { decoder, node, n: 0 }
      this.#talkers.set(player, t)
    }
    t.decoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp: t.n++ * 20_000, // our own count: the sender's numbers are not trusted here
        data: payload,
      }),
    )
  }

  /**
   * Players talking right now (heard in the last 300 ms), us included while we send. Players quiet for
   * 30 s also give back their player and decoder here; a new one is made when they talk again.
   */
  talking(now = performance.now()) {
    for (const [id, at] of this.heard) {
      if (now - at < 30_000) continue
      this.heard.delete(id)
      const t = this.#talkers.get(id)
      if (!t) continue
      t.node.disconnect()
      if (t.decoder.state !== 'closed') t.decoder.close()
      this.#talkers.delete(id)
    }
    const ids = new Set([...this.heard].filter(([, at]) => now - at < 300).map(([id]) => id))
    if (this.sending) ids.add(this.me)
    return ids
  }
}
