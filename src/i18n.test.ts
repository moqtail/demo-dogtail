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
import { en, LANGS, pick } from './i18n'

const files = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' })
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('languages', () => {
  it('has a file for every language offered, and none other', () => {
    const codes = Object.keys(files).map((f) => f.match(/(\w+)\.json$/)![1])
    expect(codes.sort()).toEqual(
      Object.keys(LANGS)
        .filter((l) => l !== 'en')
        .sort(),
    )
  })

  it.each(Object.entries(files))('%s has every string, with the same placeholders', (_, strings) => {
    expect(Object.keys(strings).sort()).toEqual(Object.keys(en).sort())
    for (const [k, v] of Object.entries(en)) expect([k, holes(strings[k]!)]).toEqual([k, holes(v)])
  })

  it("picks the browser's language by its main part, else English", () => {
    expect(pick(['pt-BR', 'en'])).toBe('pt')
    expect(pick(['xx', 'tr-TR'])).toBe('tr')
    expect(pick(['xx'])).toBe('en')
    expect(pick([])).toBe('en')
  })
})
