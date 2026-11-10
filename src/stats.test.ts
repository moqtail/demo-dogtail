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

import { describe, expect, it } from 'vitest'
import { Jitter, Rate, TrackStats } from './stats'

describe('network stats', () => {
  it('counts objects, bytes and groups skipped', () => {
    const t = new TrackStats()
    for (const g of [10n, 11n, 14n]) t.add(g, 100) // joined at 10; 12 and 13 lost
    expect([t.objects, t.bytes, t.lost]).toEqual([3, 300, 2])
    expect(t.loss).toBeCloseTo(0.4)
  })

  it('takes back a loss when the object arrives late', () => {
    const t = new TrackStats()
    for (const g of [0n, 2n, 1n]) t.add(g, 1)
    expect(t.lost).toBe(0)
  })

  it('measures jitter from changes in transit time, not the transit time itself', () => {
    const steady = new Jitter()
    for (const transit of [5000, 5000, 5000]) steady.add(transit)
    expect(steady.value).toBe(0)
    const jumpy = new Jitter()
    jumpy.add(5000)
    jumpy.add(5016)
    expect(jumpy.value).toBe(1) // 16 ms change, averaged over 16
  })

  it('turns a counter into a per-second rate', () => {
    const r = new Rate()
    r.sample(0, 1000)
    expect(r.sample(20, 2000)).toBe(20)
    expect(r.sample(30, 2500)).toBe(20)
  })
})
