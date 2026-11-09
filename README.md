# Dogfight

A multiplayer top-down plane shooter that runs entirely over a MOQtail relay. There is no game server.

## Play

```bash
apps/dogfight/scripts/make-cert.sh          # self-signed cert for this machine's LAN IP, valid 13 days
cargo run -p relay -- --port 4433 --cert-file apps/dogfight/cert/cert.pem --key-file apps/dogfight/cert/key.pem
npm --prefix apps/dogfight run dev
```

Every player, on this machine or another device on the LAN, opens `https://<your-ip>:5174`. The browser warns about the page's self-signed certificate once; choose Advanced → Proceed. Nothing needs to be installed on any device. Optional query params: `?room=<name>` (default `lobby`), `?relay=<url>` (default: the host that served the page, port 4433).

Controls: keyboard as below. On a touchscreen, on-screen buttons appear: ◀ ▶ bottom left for your left thumb, FIRE bottom right for your right.

How the connection works: Vite injects the SHA-256 hash of the certificate into the page, and the page passes it to WebTransport as `serverCertificateHashes`, so the relay is trusted by hash rather than by a certificate authority. Chrome only accepts this for ECDSA certificates valid for 14 days or less, so rerun `make-cert.sh` when it expires and restart the relay and Vite.

Keyboard: **A/D** or **←/→** turn, **W/↑** boost, **Space** fire. Mouse: the plane steers toward the cursor, and holding the left button fires; pressing a turn key hands control back to the keyboard until the mouse moves again.

Sounds: a quiet chirp when you fire, a short blip when your plane is hit, a falling crash when it is shot down. Each can be turned off under ⚙ Settings (top right); the choice is remembered per browser.

## How it uses MoQ

- Each player owns the namespace `dogfight/<room>/<playerId>` (`PUBLISH_NAMESPACE`) and `PUBLISH`es two tracks in it:
  - `pos`: 20 snapshots/s, **one group per snapshot**. Each snapshot is self-contained, so the relay and late joiners can skip straight to the latest group.
  - `events`: shots, hits and kills, **one group per event**. Events are independent, so a late joiner or a stream the relay stops loses at most one event. An earlier version used one group per life, but then a single stopped stream dropped every shot for the rest of that life.
- Every player sends one `SUBSCRIBE_TRACKS` on `dogfight/<room>`. The relay pushes a `PUBLISH` for every other player's tracks, both existing ones and ones published later. That handles discovery and subscribing in a single request.
- A player whose `pos` has been silent for 3 s is dropped.
- Other planes are drawn where their last snapshot predicts they are now, eased toward that point so they glide instead of jumping every 50 ms.
- A shot-down plane keeps sending `pos` with `hp` 0 for the 2 s respawn delay; that tells peers to hide it.
- Whoever gets hit decides the hit: each client simulates every bullet and reports hits on its _own_ plane in its own `events` track. Each client only writes its own tracks, so no referee is needed.

## Plan (iterative)

1. **Playable core**: fly, shoot, hit, respawn, kill count. Random name, fixed room, no polish.
2. **Feel** (this iteration): smooth remote planes, respawn delay, explosions. Tuning speeds and turn rate waits for playtesting.
3. **Game shell:** join screen with name and colour, rooms by link, scoreboard, `meta` track for names.
4. **Extras, if they turn out to matter:** datagrams for `pos`, mobile controls, sound.
