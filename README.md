# Dogfight

A multiplayer top-down plane shooter that runs entirely over a MOQtail relay. There is no game server.

Play at **https://dogfight.zafergurel.com**: pick a name, a color and a room, and send the invite link to friends. It runs over the public relay `relay.moqtail.dev`; nothing to install, and phones and tablets get on-screen buttons.

Built with [MOQtail](https://github.com/moqtail/moqtail), a Media over QUIC (MoQ) library and relay.

## Develop

```bash
npm install
npm run dev        # http://localhost:5174, uses relay.moqtail.dev
npm test
npm run build      # static site in dist/
npm run deploy     # build and upload to Cloudflare Workers (dogfight.zafergurel.com), see wrangler.jsonc
```

Query params: `?room=<name>` (default `lobby`), `?relay=<moqt:// or https:// url>`, `?debug` (opens the network stats panel).

### LAN play with your own relay

To play on a local network without the public relay, run the MOQtail relay on this machine with a self-signed certificate that devices trust by hash:

```bash
scripts/make-cert.sh   # cert for this machine's LAN IP, valid 13 days
# in a moqtail checkout:
cargo run -p relay -- --port 4433 --cert-file <dogfight>/cert/cert.pem --key-file <dogfight>/cert/key.pem
npm run dev            # now https, and the page uses the relay on this machine
```

Every player opens `https://<your-ip>:5174` and clicks through the certificate warning once (Advanced → Proceed). Vite puts the certificate's SHA-256 hash into the page, which passes it to WebTransport as `serverCertificateHashes`. Browsers accept that only for ECDSA certificates valid for 14 days or less, so rerun `make-cert.sh` when it expires and restart the relay and Vite. Safari needs iOS/macOS 26.4 or later.

## Controls

Keyboard: **A/D** or **←/→** turn, **W/↑** boost, **Space** fire. Mouse: the plane steers toward the cursor, and holding the left button fires; pressing a turn key hands control back to the keyboard until the mouse moves again.

On small screens (phones), where the whole arena would shrink planes to a few pixels, the view zooms to full size and follows your plane; arrows at the screen edge point to players out of view. Computers and tablets show the whole arena.

**Leave** (top right) goes back to the join screen to change room, name or color; on the iPhone Home Screen app there is no back button otherwise.

Full screen: the ⛶ button (top right) or **F**; phones lock to landscape where the browser allows. On iPhone, Safari has no fullscreen for pages: use Share → Add to Home Screen (keep "Open as Web App" on) and open the game from that icon; it runs without Safari's bars.

Touch: ◀ ▶ turn and ▲ boost bottom left, FIRE bottom right.

A player whose tab is in the background (or whose game has stopped drawing for half a second) shows faded and marked "(away)": the game is paused there, so the plane can't move or be hit. Coming back gives the 1.5 s spawn shield and ignores shots fired meanwhile.

After spawning, a plane blinks for 1.5 s and can't be hit; firing ends that early.

Network stats: **S**, Settings → Network, or `?debug`. They come from moqtail-ts client events: objects and bytes sent per track (`datagramsent`), and per player the one-way delay, jitter, loss and objects per second (`datagramreceived`, with `peerpublish` naming each track). The relay round trip is timed once, on the join request.

Sounds: a quiet chirp when you fire, a short blip when your plane is hit, a falling crash when it is shot down. Each can be turned off under ⚙ Settings (top right); the choice is remembered per browser.

## How it uses MoQ

All objects travel as **datagrams**; the tracks are still announced with `PUBLISH`. Safari stops granting credit for server-opened streams after a few dozen ([WebKit bug 319818](https://bugs.webkit.org/show_bug.cgi?id=319818)), so a stream per message cut iPads off within seconds. Datagrams can be lost: `pos` and `meta` repeat anyway, and a kill is sent three times with a death number that receivers count once.

- Each player owns the namespace `dogfight/<room>/<playerId>` (`PUBLISH_NAMESPACE`) and `PUBLISH`es three tracks in it:
  - `pos`: 20 snapshots/s, **one group per snapshot**. Each snapshot is self-contained, so the relay and late joiners can skip straight to the latest group.
  - `meta`: name, color and score, **one group per update**. Sent on join, on each score change and every 2 s, so players who join later learn who everyone is without the relay having to replay old groups. Names and colors from peers are cleaned before they are shown.
  - `events`: shots, hits and kills, **one group per event**. Events are independent, so a late joiner or a stream the relay stops loses at most one event. An earlier version used one group per life, but then a single stopped stream dropped every shot for the rest of that life.
- Every player sends one `SUBSCRIBE_TRACKS` on `dogfight/<room>`. The relay pushes a `PUBLISH` for every other player's tracks, both existing ones and ones published later. That handles discovery and subscribing in a single request.
- A player whose `pos` has been silent for 3 s is dropped.
- Other planes are drawn where their last snapshot predicts they are now, eased toward that point so they glide instead of jumping every 50 ms.
- A shot-down plane keeps sending `pos` with `hp` 0 for the 2 s respawn delay; that tells peers to hide it.
- Shots carry the time they were fired on a shared clock: each device reads `time.akamai.com` a few times at start and once a minute, and keeps the offset from the quickest round trip. Receivers fast-forward a bullet by its travel time (at most 0.3 s), so it appears where the shooter fired it. Without that clock, shots go out unstamped and are not adjusted.
- Whoever gets hit decides the hit: each client simulates every bullet and reports hits on its _own_ plane in its own `events` track. Each client only writes its own tracks, so no referee is needed.

## Plan (iterative)

1. **Playable core**: fly, shoot, hit, respawn, kill count. Random name, fixed room, no polish.
2. **Feel**: smooth remote planes, respawn delay, explosions. Tuning speeds and turn rate waits for playtesting.
3. **Game shell**: join screen with name and color, rooms by link, scoreboard, `meta` track.
4. **Extras, if they turn out to matter:** datagrams for `pos`, mobile controls, sound.
