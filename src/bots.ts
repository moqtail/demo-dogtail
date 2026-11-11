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

/** Load-test page: runs the bots in a worker (bots-worker.ts) and shows what they see. */

declare const __CERT_HASH__: string // injected by vite.config.ts
const params = new URLSearchParams(location.search)
const room = params.get('room')
const n = Math.min(Number(params.get('n') ?? 10), 100)
const out = document.getElementById('out')!
if (!room) out.textContent = 'Add ?room=<room>&n=<count> to the URL.'
else {
  const worker = new Worker(new URL('./bots-worker.ts', import.meta.url), { type: 'module' })
  // Same relay as the game: the one on this machine when there is a LAN cert, else the public one.
  const relay =
    params.get('relay') ?? (__CERT_HASH__ ? `moqt://${location.hostname}:4433` : 'moqt://relay.n1.fra.moqtail.dev')
  worker.postMessage({ room, n, relay, certHash: __CERT_HASH__, brain: params.has('brain') })
  let last = 0
  worker.onmessage = (e: MessageEvent<{ connected: number; failed: number; received: number; lastError: string }>) => {
    const { connected, failed, received, lastError } = e.data
    out.textContent =
      `room ${room} · bots ${connected}/${n} connected` +
      (failed ? ` · ${failed} failed (${lastError})` : '') +
      ` · received ${received - last} obj/s in total (${connected ? Math.round((received - last) / connected) : 0} per bot)`
    last = received
  }
}
