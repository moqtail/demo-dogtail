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

Query params: `?room=<name>` (default: the room this device last joined, or a random one like `falcon-482` on a first visit), `?relay=<moqt:// or https:// url>`, `?debug` (opens the network stats panel).

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

The scoreboard (top right) shows the top 10 by kills / deaths, plus your own rank if you are further down. Planes have 3 hearts in a room of up to 10, and one more for every 10 players beyond that (7 at 50), as busier rooms mean more fire; the number is set at each spawn. A room holds 50 players; joining a full one sends you back to the join screen with a fresh room.

**Leave** (top right) goes back to the join screen to change room, name or color; on the iPhone Home Screen app there is no back button otherwise.

Full screen: the ⛶ button (top right) or **F**; phones lock to landscape where the browser allows. On iPhone, Safari has no fullscreen for pages: use Share → Add to Home Screen (keep "Open as Web App" on) and open the game from that icon; it runs without Safari's bars.

Touch: ◀ ▶ turn and ▲ boost bottom left, FIRE bottom right.

Small screens also get a minimap at the bottom centre (🗺 button or **M** to hide it).

Reactions: **1–4** or the buttons bottom right (beside FIRE on touch) pop 😂 🔥 👋 💢 over your plane, at most one a second; 😀 (top right) or **E** hides them, yours and everyone's. The kill feed (top left) shows the last few kills.

Power-ups drop every 8 s and last 16 s: 🛡️ 5 s of armour (firing keeps it), ⚡ 6 s of double fire rate, ❤️ one heart (up to one over full). There is no server: every player derives the same drops from the room name and the shared clock, and only grabs are sent, so two players touching one within a network delay may both get it.

A player whose tab is in the background (or whose game has stopped drawing for half a second) shows faded and marked "(away)": the game is paused there, so the plane can't move or be hit. Coming back gives the 1.5 s spawn shield and ignores shots fired meanwhile.

A respawn lands at the spot farthest from other planes (best of 12 random ones), and for 2 s rings in your color shrink onto your plane so you can find yourself in a crowd. After spawning, a plane blinks for 1.5 s and can't be hit; firing ends that early.

Network stats: **S**, Settings → Network, or `?debug`. They come from moqtail-ts client events: objects and bytes sent per track (`datagramsent`), and per player the one-way delay, jitter, loss and objects per second (`datagramreceived`, with `peerpublish` naming each track). The relay round trip is timed once, on the join request.

Sounds: a quiet chirp when you fire, a short blip when your plane is hit, a falling crash when it is shot down. Each can be turned off under ⚙ Settings (top right); the choice is remembered per browser.

## How it uses MoQ

All objects travel as **datagrams**; the tracks are still announced with `PUBLISH`. Safari stops granting credit for server-opened streams after a few dozen ([WebKit bug 319818](https://bugs.webkit.org/show_bug.cgi?id=319818)), so a stream per message cut iPads off within seconds. Datagrams can be lost: `pos` and `meta` repeat anyway, and a kill is sent three times with a death number that receivers count once.

- Each player owns the namespace `dogfight/<room>/<playerId>` (`PUBLISH_NAMESPACE`) and `PUBLISH`es **one track**, `game`, with **one group per message**. A message is one of:
  - `pos`: 10 snapshots/s. Each is self-contained; prediction and easing hide the gaps.
  - `meta`: name, color and score. Sent on join, on each score change and every 2 s, so players who join later learn who everyone is without the relay replaying old groups. Names and colors from peers are cleaned before they are shown.
  - `shot`, `hit`, `kill`: events, each standing alone.

  One track (not three) means the relay opens one stream per player for each subscriber, which keeps a full room of 50 under Safari's limit on server-opened streams. The group numbers let receivers count losses.

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

## Analytics

PostHog (`src/analytics.ts`) gets page views (its Web analytics dashboard), plus `join` (room, touch or desktop), `leave` (session seconds, kills, deaths), `room_full` and a once-a-minute `room_size`. It is cookieless, keyed by the random player id (names are not sent), loads in the background, and is off on localhost and LAN addresses so dev and bot runs don't count.

## Load test

`bots.html` (dev server only, not deployed) runs bots that each join as a full player on their own connection: pos at 10 Hz, meta every 2 s, about one shot a second, and their own hit detection, so you can shoot them down. Run them in headless Chrome, which doesn't throttle them like a background tab would:

```bash
npm run dev                         # in one terminal
npm run bots -- <room> <count>      # in another; Ctrl-C stops them
```

Then join `<room>` from the game with `?debug` to see delay, jitter and loss per player.
