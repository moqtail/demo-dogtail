// Copyright 2026 The MOQtail Authors
// SPDX-License-Identifier: Apache-2.0
//
// Load test: runs bots.html in headless Chrome (no background-tab throttling) against the dev server,
// and prints what the bots see every 2 s. Ctrl-C stops them.
//   npm run dev                          # in another terminal
//   npm run bots -- <room> <count> [dev server url]
import { chromium } from 'playwright-core'

const [room, n = '10', base = 'http://localhost:5174'] = process.argv.slice(2)
if (!room) {
  console.error('usage: npm run bots -- <room> <count> [dev server url]')
  process.exit(1)
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(`${base}/bots.html?room=${encodeURIComponent(room)}&n=${n}`)
const timer = setInterval(async () => console.log(await page.textContent('#out')), 2000)
process.on('SIGINT', async () => {
  clearInterval(timer)
  await browser.close()
  process.exit(0)
})
