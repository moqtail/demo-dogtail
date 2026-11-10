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
import { cleanMeta, decode, encode, type EventMsg, type MetaMsg, type PosMsg } from './game'

export type NetCallbacks = {
  onPos: (player: string, m: PosMsg) => void
  onEvent: (player: string, m: EventMsg) => void
  onMeta: (player: string, m: MetaMsg) => void
}

// shortcut: Safari has only the newer datagrams.createWritable(), not the .writable moqtail calls;
// drop this once moqtail falls back to createWritable() itself.
type Duplex = { writable?: WritableStream; createWritable?: () => WritableStream }
globalThis.WebTransport = class extends WebTransport {
  constructor(url: string | URL, options?: WebTransportOptions) {
    super(url, options)
    const d = this.datagrams as unknown as Duplex
    if (!d.writable && d.createWritable) Object.defineProperty(d, 'writable', { value: d.createWritable() })
  }
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
export async function connect(relayUrl: string, room: string, me: string, certHash: string, cb: NetCallbacks) {
  const transportOptions: WebTransportOptions = certHash
    ? {
        serverCertificateHashes: [
          { algorithm: 'sha-256', value: Uint8Array.from(certHash.match(/../g)!, (h) => parseInt(h, 16)) },
        ],
      }
    : {}
  const client = await MOQtailClient.new({ url: relayUrl, transportOptions, enableDatagrams: true })
  const roomNs = `dogfight/${room}`
  const myNs = Tuple.fromUtf8Path(`${roomNs}/${me}`)

  await client.publishNamespace(myNs)
  const sendPosObj = await openTrack(client, myNs, 'pos', 0)
  const sendEventObj = await openTrack(client, myNs, 'events', 1)
  const sendMetaObj = await openTrack(client, myNs, 'meta', 2)

  // Every peer track under the room prefix, now and later, arrives here as a relay-pushed PUBLISH.
  client.onPeerPublish = (msg, stream) => {
    const player = msg.fullTrackName.namespace.toUtf8Path().split('/').filter(Boolean).pop()!
    const track = new TextDecoder().decode(msg.fullTrackName.name)
    const onObject = (obj: MoqtObject) => {
      if (!obj.payload) return
      try {
        if (track === 'pos') cb.onPos(player, decode<PosMsg>(obj.payload))
        else if (track === 'events') cb.onEvent(player, decode<EventMsg>(obj.payload))
        else if (track === 'meta') cb.onMeta(player, cleanMeta(decode<Partial<MetaMsg>>(obj.payload)))
      } catch (err) {
        console.warn('dogfight: bad object', player, track, err) // one bad datagram must not stop the rest
      }
    }
    client.subscribeToTrackDatagrams(msg.trackAlias, onObject)
    // Objects on streams too, in case a publisher sends them that way.
    void (async () => {
      for await (const obj of stream as unknown as AsyncIterable<MoqtObject>) onObject(obj)
    })().catch((err) => console.warn('dogfight: stream ended', player, track, err))
  }
  const { response } = await client.subscribeTracks(Tuple.fromUtf8Path(roomNs))
  if (response instanceof RequestError) throw new Error('relay rejected SUBSCRIBE_TRACKS')

  // One group per message on every track: each snapshot, event and meta stands alone, so a
  // subscriber that joins late, or a stream the relay stops, loses at most that one message.
  let posGroup = 0n
  let eventGroup = 0n
  let metaGroup = 0n
  return {
    sendPos: (m: PosMsg) => sendPosObj(posGroup++, 0n, encode(m)),
    sendEvent: (m: EventMsg) => sendEventObj(eventGroup++, 0n, encode(m)),
    sendMeta: (m: MetaMsg) => sendMetaObj(metaGroup++, 0n, encode(m)),
  }
}
