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

// Audio worklets for voice chat (voice.ts). They run on the audio thread, so they stay tiny.

/** Hands the microphone's samples to the page, 128 at a time. Outputs silence. */
class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice())
    return true
  }
}
registerProcessor('voice-capture', VoiceCapture)

/**
 * Plays one talker's decoded samples through a ring buffer. It waits for START samples before playing
 * (a small jitter buffer, so frames that arrive a little late don't cut out), and after running dry it
 * waits for START again.
 */
const SIZE = 48000 // 1 s at 48 kHz; more than that queued is dropped, so the delay can't grow
const START = 2880 // 60 ms
class VoicePlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(SIZE)
    this.read = 0
    this.write = 0
    this.playing = false
    this.port.onmessage = (e) => {
      for (const v of e.data) {
        if (this.write - this.read >= SIZE) return
        this.buf[this.write++ % SIZE] = v
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    const queued = this.write - this.read
    if (!this.playing && queued >= START) this.playing = true
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.read < this.write) out[i] = this.buf[this.read++ % SIZE]
      else {
        out[i] = 0
        this.playing = false
      }
    }
    return true
  }
}
registerProcessor('voice-player', VoicePlayer)
