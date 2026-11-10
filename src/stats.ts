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

/** Network statistics: pure counters, fed from moqtail-ts client events in main.ts. */

/** Objects and bytes on one track, and objects lost going by group numbers (one object per group). */
export class TrackStats {
  objects = 0
  bytes = 0
  lost = 0
  #next: bigint | undefined

  add(group: bigint, bytes: number): void {
    this.objects++
    this.bytes += bytes
    if (this.#next === undefined || group >= this.#next) {
      if (this.#next !== undefined) this.lost += Number(group - this.#next) // skipped groups
      this.#next = group + 1n
    } else if (this.lost > 0) this.lost-- // a late arrival, counted lost before
  }

  /** Lost objects as a share of all expected ones, 0..1. */
  get loss(): number {
    const expected = this.objects + this.lost
    return expected ? this.lost / expected : 0
  }
}

/**
 * Interarrival jitter in ms, as RTP computes it: a running average of how much the transit time
 * (arrival minus send time) changes between packets. A constant clock offset cancels out.
 */
export class Jitter {
  value = 0
  #prev: number | undefined

  add(transit: number): void {
    if (this.#prev !== undefined) this.value += (Math.abs(transit - this.#prev) - this.value) / 16
    this.#prev = transit
  }
}

/** Per-second rate of a growing counter, sampled about once a second. */
export class Rate {
  value = 0
  #last: { count: number; at: number } | undefined

  sample(count: number, at: number): number {
    if (this.#last && at > this.#last.at) this.value = ((count - this.#last.count) * 1000) / (at - this.#last.at)
    this.#last = { count, at }
    return this.value
  }
}
