// Copyright 2026 The MOQtail Authors
// SPDX-License-Identifier: Apache-2.0
//
// Load test: runs bots.html in headless Chrome (no background-tab throttling) against the dev server,
// and prints what the bots see every 2 s. Ctrl-C stops them.
//   npm run dev                          # in another terminal
//   npm run bots -- <room> <count> [dev server url]
import { existsSync } from 'fs'
import { chromium } from 'playwright-core'

// With a LAN cert the dev server is https (and the bots use the relay on this machine).
const https = existsSync(new URL('../cert/cert.pem', import.meta.url))
const [room, n = '10', base = `${https ? 'https' : 'http'}://localhost:5174`] = process.argv.slice(2)
if (!room) {
  console.error('usage: npm run bots -- <room> <count> [dev server url]')
  process.exit(1)
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ ignoreHTTPSErrors: true }) // the dev server's self-signed cert
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(`${base}/bots.html?room=${encodeURIComponent(room)}&n=${n}`)
const timer = setInterval(async () => console.log(await page.textContent('#out')), 2000)
process.on('SIGINT', async () => {
  clearInterval(timer)
  await browser.close()
  process.exit(0)
})
