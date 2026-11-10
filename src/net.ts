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

import { LiveTrackSource, MOQtailClient } from 'moqtail/client'
import { FullTrackName, Location, MoqtObject, ObjectForwardingPreference, RequestError, Tuple } from 'moqtail/model'
import {
  ClockSync,
  cleanEvent,
  cleanMeta,
  cleanPos,
  clockSample,
  decode,
  encode,
  type EventMsg,
  type MetaMsg,
  type PosMsg,
  type WireMsg,
} from './game'

export type NetCallbacks = {
  onPos: (player: string, m: PosMsg) => void
  onEvent: (player: string, m: EventMsg) => void
  onMeta: (player: string, m: MetaMsg) => void
}

/**
 * One outgoing track. PUBLISH announces it (that is how peers discover it), and its objects go out as
 * datagrams, not streams: Safari stops granting credit for server-opened streams after a few dozen
 * (WebKit bug 319818), which would cut an iPad off from everyone within seconds. Datagrams can be lost;
 * pos and meta repeat anyway, and main.ts repeats kills.
 */
async function openTrack(client: MOQtailClient, ns: Tuple, name: string, priority: number) {
  const ftn = FullTrackName.tryNew(ns, name)
  const stream = new ReadableStream<MoqtObject>() // only backs the PUBLISH; objects go as datagrams
  client.addOrUpdateTrack({
    fullTrackName: ftn,
    trackSource: { live: new LiveTrackSource(stream) },
    publisherPriority: priority,
  })
  const res = await client.publish(ftn, true, client.trackSources.get(ftn.toString())!.trackAlias!)
  if (res instanceof RequestError) throw new Error(`relay rejected ${name}: ${res.reasonPhrase?.phrase}`)
  const sender = client.createDatagramSender(client.trackSources.get(ftn.toString())!.trackAlias!)
  return (group: bigint, object: bigint, payload: Uint8Array) =>
    void sender.write(
      MoqtObject.newWithPayload(
        ftn,
        new Location(group, object),
        priority,
        ObjectForwardingPreference.Datagram,
        null,
        null,
        payload,
      ),
    )
}

/** `certHash` (hex SHA-256 of the relay cert) pins a self-signed relay cert; empty uses normal CA checks. */
export async function connect(
  relayUrl: string,
  room: string,
  me: string,
  certHash: string,
  cb: NetCallbacks,
  onClient?: (client: MOQtailClient) => void,
) {
  const transportOptions: WebTransportOptions = certHash
    ? {
        serverCertificateHashes: [
          { algorithm: 'sha-256', value: Uint8Array.from(certHash.match(/../g)!, (h) => parseInt(h, 16)) },
        ],
      }
    : {}
  const client = new MOQtailClient({ url: relayUrl, transportOptions, enableDatagrams: true })
  onClient?.(client) // listeners go on before init(), so stats see the whole session
  await client.init()
  const roomNs = `dogtail/${room}`
  const myNs = Tuple.fromUtf8Path(`${roomNs}/${me}`)

  const t0 = performance.now()
  await client.publishNamespace(myNs)
  const joinRtt = performance.now() - t0 // one request, one round trip to the relay
  const sendObj = await openTrack(client, myNs, 'game', 0)

  // Every peer track under the room prefix, now and later, arrives here as a relay-pushed PUBLISH.
  client.on('peerpublish', (msg, stream) => {
    const player = msg.fullTrackName.namespace.toUtf8Path().split('/').filter(Boolean).pop()!
    const track = new TextDecoder().decode(msg.fullTrackName.name)
    if (track !== 'game') return // e.g. a player on an older version, which had three tracks
    const onObject = (obj: MoqtObject) => {
      if (!obj.payload) return
      try {
        const w = decode<WireMsg>(obj.payload)
        // Everything from other players is checked here, before the game sees it.
        if (w.t === 'pos') {
          const p = cleanPos(w.p)
          if (p) cb.onPos(player, p)
        } else if (w.t === 'meta') cb.onMeta(player, cleanMeta(w.m ?? {}))
        else {
          const ev = cleanEvent(w)
          if (ev) cb.onEvent(player, ev)
        }
      } catch (err) {
        console.warn('dogtail: bad object', player, err) // one bad datagram must not stop the rest
      }
    }
    client.subscribeToTrackDatagrams(msg.trackAlias, onObject)
    // Objects on streams too, in case a publisher sends them that way.
    void (async () => {
      for await (const obj of stream as unknown as AsyncIterable<MoqtObject>) onObject(obj)
    })().catch((err) => console.warn('dogtail: stream ended', player, track, err))
  })
  const { response } = await client.subscribeTracks(Tuple.fromUtf8Path(roomNs))
  if (response instanceof RequestError) throw new Error('relay rejected SUBSCRIBE_TRACKS')

  // One group per message: each stands alone, and the group numbers let receivers count losses.
  let group = 0n
  const send = (w: WireMsg) => sendObj(group++, 0n, encode(w))
  return {
    joinRtt,
    sendPos: (p: PosMsg) => send({ t: 'pos', p }),
    sendEvent: (m: EventMsg) => send(m),
    sendMeta: (m: MetaMsg) => send({ t: 'meta', m }),
  }
}

/**
 * Our clock's offset from a shared reference, so shot times mean the same on every device: a few
 * quick reads of Akamai's time server at start, then one a minute; the fastest round trip wins.
 * shortcut: depends on time.akamai.com; if it can't be reached, shots go out unstamped and are not
 * fast-forwarded.
 */
export function syncClock(): ClockSync {
  const clock = new ClockSync()
  const read = async () => {
    try {
      const t1 = Date.now()
      const res = await fetch('https://time.akamai.com/?iso&ms', { cache: 'no-store' })
      const server = Date.parse(await res.text())
      const t4 = Date.now()
      clock.add(clockSample(t1, server, server, t4)) // a bad reply parses to NaN and is ignored
    } catch {
      // Offline or blocked: keep what we have.
    }
  }
  void (async () => {
    for (let i = 0; i < 5; i++) await read()
  })()
  setInterval(read, 60_000)
  return clock
}
