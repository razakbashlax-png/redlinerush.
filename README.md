# Redline Rush: online multiplayer

```
index.html        the game (deploy to Vercel)        <- already upgraded, all cars/tracks/controls kept
server/server.js  WebSocket multiplayer server       <- deploy to Render / Railway / Fly (Vercel cannot host it)
server/test.js    automated tests (npm test)
render.yaml       one-click Render blueprint
```

Vercel only serves static files and cannot keep a WebSocket connection open, so the game
(Vercel) and the multiplayer server (Render) are deployed separately and talk over `wss://`.

## 1. Deploy the server (Render, free)
1. Push this whole folder to a GitHub repo.
2. https://render.com -> New -> **Blueprint** -> pick the repo (it reads `render.yaml`).
   Or New -> Web Service: Root Directory `server`, Build `npm install`, Start `node server.js`, Health Check `/health`.
3. Pick the region closest to your players (Frankfurt is closest for Nigeria/West Africa).
4. When it is live you get a URL like `https://redline-rush-server.onrender.com`.
   Open `/health` (should say `ok`). Your WebSocket address is the same host with `wss://`.

Free-tier note: Render free services sleep after ~15 min idle and take about 30-50 s to wake on the next
connection. For always-on play use the paid plan, or ping `/health` every 10 min with UptimeRobot.
Railway / Fly.io also work: `server/Dockerfile` is included, and the server reads `PORT` from the environment.

## 2. Point the game at the server
In `index.html` near the top, change:
```html
<script>window.RR_SERVER="wss://REPLACE-WITH-YOUR-SERVER.onrender.com";</script>
```
to your real address, e.g. `wss://redline-rush-server.onrender.com`. (For a quick test without editing, open
`https://your-game.vercel.app/?server=wss://redline-rush-server.onrender.com`.)

## 3. Deploy the game (Vercel)
Import the repo in Vercel, Framework preset **Other**, no build command, root directory `/`. (`.vercelignore`
keeps `server/` out of the site.) Open it on two phones (Android Chrome works) and test.

The server can also host the game itself: it serves `server/public/index.html` at `/`. Then no `RR_SERVER`
setting is needed (the page connects to the host it was loaded from).

## How to play online
Menu -> **Online**:
- **Quick Race**: matches you with drivers that have a similar ping to the server (same region) and the same
  time zone; it widens the search the longer you wait. When 2+ players are in, a 10 s countdown starts
  (3 s when 8 are in). The first player's selected map is used.
- **Create room**: gives a 5-letter code. Friends type it in the code box and press **Join room**.
  Anyone can press **Start for all** (needs 2+ players). The starter's selected map is used.
- Up to **8 players**. Each player's name, car, colour, position and lap are synced ~20 times per second;
  bombs/shields and results are shared; the HUD shows live positions and the result table lists everyone.
- Dropped connections (phone sleep, network switch) auto-reconnect for 15 s and keep your seat.

## Test locally
```
cd server && npm test          # Node 22+: starts a server and runs 2 to 9 simulated clients
cd server && node server.js    # http://localhost:8080 serves the game; open it on two devices on your Wi-Fi
```
On a LAN use `http://<your-computer-ip>:8080` from both phones. (HTTPS pages such as Vercel require `wss://`.)

## Protocol (JSON over WebSocket `/ws`)
client: `ping` `rtt` `quick` `create` `join` `rejoin` `p`(presence) `go` `leave`
server: `w` `pong` `hi` `j` `l` `s`(20 Hz state) `cd`(countdown) `go`(roster + map) `err`

## Limits
The server relays state but does not simulate physics (each client drives its own car), so a modified client
could cheat. Fine for friends/casual play. Inputs are validated and rate-limited; set `ALLOWED_ORIGINS` (comma
separated, e.g. `https://your-game.vercel.app`) on the server to only accept your site.
