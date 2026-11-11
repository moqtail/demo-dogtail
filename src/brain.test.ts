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
import { controls, decide, forward, observe, type Brain, type View } from './brain'
import fixture from './brain.fixture.json'

// Made by train/make_fixture.py from train/env.py: the bot in the browser must see and think exactly
// as it did in training.
const cases = fixture.cases as { view: View; obs: number[] }[]
const brain = fixture.brain as Brain

describe('trained pilot', () => {
  it('sees a match the way training did', () => {
    expect(cases.length).toBeGreaterThan(20)
    for (const c of cases) {
      const got = observe(c.view)
      expect(got).toHaveLength(c.obs.length)
      got.forEach((v, i) => expect(v).toBeCloseTo(c.obs[i]!, 4))
    }
  })

  it('computes the network as PyTorch does', () => {
    fixture.logits.forEach((want, k) =>
      forward(brain, cases[k]!.obs).forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 4)),
    )
  })

  it('draws actions by the network odds and turns them into controls', () => {
    const obs = cases[0]!.obs
    expect(decide(brain, obs, () => 0)).toBe(0)
    expect(decide(brain, obs, () => 0.999999)).toBe(11)
    expect(decide(brain, obs, () => 0.49, 1e9)).toBe(5) // a huge temp: all 12 equally likely
    expect(controls(0)).toEqual({ turn: -1, boost: false, fire: false })
    expect(controls(11)).toEqual({ turn: 1, boost: true, fire: true })
    expect(controls(4)).toEqual({ turn: 0, boost: true, fire: false })
  })
})
