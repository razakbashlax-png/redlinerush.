"use strict";
/* Redline Rush multiplayer server: zero dependencies (Node 18+).
   - WebSocket endpoint: /ws        - health check: /health        - stats: /stats
   - Also serves ./public/index.html at "/" so you can host game + server together. */
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const PORT = +process.env.PORT || 8080, MAX = 8, GRACE = 15000, TOL0 = 90;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

/* ---------- minimal RFC 6455 WebSocket ---------- */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
class WS {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.frag = null; this.open = true;
    this.onmsg = () => {}; this.onclose = () => {};
    sock.setNoDelay(true);
    sock.on("data", d => { this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 262144) return this.close(1009); this.parse(); });
    sock.on("close", () => this.end()); sock.on("error", () => this.end());
  }
  parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 128, op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      if (!masked) return this.close(1002);
      if (len > 65536) return this.close(1009);
      if (b.length < o + 4 + len) return;
      const m = b.subarray(o, o + 4), p = Buffer.from(b.subarray(o + 4, o + 4 + len));
      for (let i = 0; i < len; i++) p[i] ^= m[i & 3];
      this.buf = b.subarray(o + 4 + len);
      if (op === 8) { this.close(1000); return; }
      if (op === 9) { this.frame(10, p); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) this.frag = { op, parts: [p] };
      else if (op === 0 && this.frag) this.frag.parts.push(p);
      else continue;
      if (fin) { const f = this.frag; this.frag = null; if (f.op === 1) this.onmsg(Buffer.concat(f.parts).toString("utf8")); }
    }
  }
  frame(op, payload) {
    if (!this.open && op !== 8) return;
    const n = payload.length; let h;
    if (n < 126) h = Buffer.from([128 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.s.write(Buffer.concat([h, payload])); } catch (e) { this.end(); }
  }
  send(str) { if (!this.open || this.s.writableLength > 524288) return; this.frame(1, Buffer.from(str)); }
  ping() { this.frame(9, Buffer.alloc(0)); }
  close(code) { if (!this.open) return; const c = Buffer.alloc(2); c.writeUInt16BE(code || 1000); this.frame(8, c); this.open = false; try { this.s.end(); } catch (e) {} this.end(); }
  end() { if (this.dead) return; this.dead = true; this.open = false; try { this.s.destroy(); } catch (e) {} this.onclose(); }
}

/* ---------- http: static + health ---------- */
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (u === "/stats") { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); return res.end(JSON.stringify({ rooms: rooms.size, players: [...peers.values()].filter(p => p.ws).length })); }
  if (u === "/" || u === "/index.html") {
   const f = path.join(__dirname, "index.html");
     fs.readFile(f, (e, d) => { if (e) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("Redline Rush multiplayer server is running. Put the game's index.html in ./public to serve it from here."); } res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); res.end(d); });
    return;
  }
  res.writeHead(404); res.end("not found");
});
const perIp = new Map();
server.on("upgrade", (req, sock) => {
  const ip = (req.headers["x-forwarded-for"] || sock.remoteAddress || "").split(",")[0].trim();
  const key = req.headers["sec-websocket-key"], org = req.headers.origin;
  if (req.url.split("?")[0] !== "/ws" || !key || (ORIGINS.length && org && !ORIGINS.includes(org)) || (perIp.get(ip) || 0) >= 24) { sock.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return sock.destroy(); }
  const acc = crypto.createHash("sha1").update(key + GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const ws = new WS(sock), prev = ws.onclose; ws.onclose = () => { perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)); prev(); };
  connect(ws);
});

/* ---------- game state ---------- */
const rooms = new Map(), peers = new Map(); let pc = 0;
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => { for (;;) { let c = ""; for (let i = 0; i < 5; i++) c += ALPHA[crypto.randomInt(ALPHA.length)]; if (!rooms.has(c)) return c; } };
const KEYS = { n: "s", car: "n", col: "n", av: "a", x: "n", z: "n", h: "n", vf: "n", st: "n", nz: "n", lap: "n", idx: "n", fin: "n", sh: "n", wk: "n", nl: "n", bm: "b" };
function clean(d) {
  const o = {}; if (!d || typeof d !== "object") return o;
  for (const k in KEYS) {
    if (!(k in d)) continue; const v = d[k], t = KEYS[k];
    if (t === "s") o[k] = String(v).replace(/[<>&"'`\\]/g, "").trim().slice(0, 14) || "Driver";
    else if (t === "n") { if (typeof v === "number" && isFinite(v)) o[k] = Math.max(-1e7, Math.min(1e7, v)); }
    else if (t === "a") { if (Array.isArray(v) && v.length <= 12 && v.every(q => typeof q === "number" && isFinite(q))) o[k] = v; }
    else if (t === "b") { if (Array.isArray(v) && v.length === 7) o[k] = [+v[0] || 0, +v[1] || 0, +v[2] || 0, +v[3] || 0, +v[4] || 0, +v[5] || 0, String(v[6] || "").slice(0, 12)]; }
  }
  return o;
}
const cleanTrack = t => /^[a-z0-9]{2,20}$/.test(String(t || "")) ? String(t) : "";
function mkRoom(quick, track) { const r = { code: newCode(), quick, track: cleanTrack(track), peers: new Map(), goN: 0, locked: false, startAt: 0, lastGo: 0, waitSince: Date.now(), dirty: new Map() }; rooms.set(r.code, r); return r; }
const send = (p, o) => { if (p.ws && p.ws.open) p.ws.send(JSON.stringify(o)); };
function bc(r, o, ex) { const s = JSON.stringify(o); for (const p of r.peers.values()) if (p !== ex && p.ws && p.ws.open) p.ws.send(s); }
function checkStart(r) {
  if (!r.quick || r.locked) return; const n = r.peers.size;
  if (n >= 2) { const want = Date.now() + (n >= MAX ? 3000 : 10000); if (!r.startAt) r.startAt = want; else if (n >= MAX) r.startAt = Math.min(r.startAt, want); }
  else if (r.startAt) { r.startAt = 0; bc(r, { t: "cd", s: null }); }
}
function addTo(r, p, re) {
  if (p.room && p.room !== r) removeFrom(p);
  r.peers.set(p.id, p); p.room = r;
  const snap = {}; for (const q of r.peers.values()) snap[q.id] = q.p;
  send(p, { t: "hi", re: re ? 1 : 0, id: p.id, token: p.token, code: r.code, quick: r.quick, max: MAX, goN: r.goN, track: r.track, peers: snap });
  if (!re) bc(r, { t: "j", id: p.id }, p);
  checkStart(r);
}
function removeFrom(p) {
  const r = p.room; if (!r) return; r.peers.delete(p.id); r.dirty.delete(p.id); p.room = null; bc(r, { t: "l", id: p.id });
  if (!r.peers.size) rooms.delete(r.code); else checkStart(r);
}
function score(r, p) {
  let s = 0, n = 0; for (const q of r.peers.values()) { s += (q.rtt && p.rtt) ? Math.abs(q.rtt - p.rtt) : 35; n++; }
  const tz = [...r.peers.values()].some(q => q.tz && q.tz === p.tz);
  return (n ? s / n : 0) + (tz || !p.tz ? 0 : 40);
}
function quickJoin(p, track) {
  let best = null, bs = 1e9;
  for (const r of rooms.values()) { if (!r.quick || r.locked || r.peers.size >= MAX) continue; const sc = score(r, p); if (sc < bs) { bs = sc; best = r; } }
  if (best && bs <= TOL0) return addTo(best, p);
  addTo(mkRoom(true, track), p);
}
function doGo(r, tr) {
  const live = [...r.peers.values()].filter(p => p.ws && p.ws.open && p.p.n);
  if (live.length < 2) return false;
  if (cleanTrack(tr)) r.track = cleanTrack(tr);
  r.goN++; r.lastGo = Date.now(); if (r.quick) r.locked = true;
  bc(r, { t: "go", n: r.goN, ids: live.map(p => p.id).sort(), tr: r.track }); return true;
}

/* ---------- connection handling ---------- */
function connect(ws) {
  const c = { ws, peer: null, n: 0, t: Date.now() };
  c.peer = { id: "p" + (++pc).toString(36).padStart(4, "0"), token: crypto.randomBytes(8).toString("hex"), ws, p: {}, room: null, rtt: 0, tz: "", drop: 0 };
  peers.set(c.peer.id, c.peer);
  ws.onmsg = txt => {
    const now = Date.now(); if (now - c.t > 1000) { c.t = now; c.n = 0; } if (++c.n > 120 || txt.length > 4096) return;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m && typeof m === "object") handle(c, m);
  };
  ws.onclose = () => { const p = c.peer; if (p.ws === ws) { p.ws = null; p.drop = Date.now(); if (!p.room) peers.delete(p.id); } };
  send(c.peer, { t: "w", id: c.peer.id });
}
function handle(c, m) {
  let p = c.peer;
  switch (m.t) {
    case "ping": send(p, { t: "pong", ts: m.ts }); break;
    case "rtt": { const v = Math.max(0, Math.min(2000, +m.v || 0)); p.rtt = v; p.p.ping = Math.round(v); if (p.room) p.room.dirty.set(p.id, Object.assign(p.room.dirty.get(p.id) || {}, { ping: p.p.ping })); break; }
    case "rejoin": {
      const q = peers.get(String(m.id)); if (!q || q.token !== m.token || !q.room) { send(p, { t: "err", m: "Session expired. Please rejoin the room.", code: "expired" }); break; }
      if (q === p) break;
      peers.delete(p.id); if (q.ws && q.ws !== c.ws) { const old = q.ws; q.ws = null; try { old.close(1000); } catch (e) {} }
      c.peer = q; q.ws = c.ws; q.drop = 0; addTo(q.room, q, true); break;
    }
    case "quick": if (p.room) removeFrom(p); p.tz = String(m.tz || "").slice(0, 40); p.rtt = Math.max(0, Math.min(2000, +m.rtt || 0)); Object.assign(p.p, clean({ n: m.n })); quickJoin(p, m.tr); break;
    case "create": if (p.room) removeFrom(p); Object.assign(p.p, clean({ n: m.n })); p.tz = String(m.tz || "").slice(0, 40); p.rtt = Math.max(0, Math.min(2000, +m.rtt || 0)); addTo(mkRoom(false, m.tr), p); break;
    case "join": {
      const r = rooms.get(String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
      if (!r) return send(p, { t: "err", m: "Room not found. Check the code." });
      if (r.peers.size >= MAX && !r.peers.has(p.id)) return send(p, { t: "err", m: "Room is full (8/8)." });
      if (p.room) removeFrom(p); Object.assign(p.p, clean({ n: m.n })); p.tz = String(m.tz || "").slice(0, 40); p.rtt = Math.max(0, Math.min(2000, +m.rtt || 0)); addTo(r, p); break;
    }
    case "p": { if (!p.room) break; const d = clean(m.d); if (!Object.keys(d).length) break; Object.assign(p.p, d); p.room.dirty.set(p.id, Object.assign(p.room.dirty.get(p.id) || {}, d)); break; }
    case "go": { const r = p.room; if (!r || Date.now() - r.lastGo < 2500) break; if (!doGo(r, m.tr)) send(p, { t: "err", m: "Waiting for at least one more driver." }); break; }
    case "leave": if (p.room) removeFrom(p); break;
  }
}

/* ---------- timers ---------- */
setInterval(() => { // 20 Hz state fan-out
  for (const r of rooms.values()) {
    if (!r.dirty.size) continue;
    for (const p of r.peers.values()) {
      if (!p.ws || !p.ws.open) continue; let o = null;
      for (const [id, d] of r.dirty) if (id !== p.id) (o || (o = {}))[id] = d;
      if (o) p.ws.send(JSON.stringify({ t: "s", p: o }));
    }
    r.dirty.clear();
  }
}, 50);
setInterval(() => { // 1 Hz: countdowns, ghosts, lonely-room merging, keep-alive
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.quick && r.startAt && !r.locked) { bc(r, { t: "cd", s: Math.max(0, Math.ceil((r.startAt - now) / 1000)) }); if (now >= r.startAt) { r.startAt = 0; if (!doGo(r)) checkStart(r); } }
    for (const p of [...r.peers.values()]) if (!p.ws && now - p.drop > GRACE) { removeFrom(p); peers.delete(p.id); }
  }
  for (const r of [...rooms.values()]) {
    if (!rooms.has(r.code) || !r.quick || r.locked || r.peers.size !== 1) continue;
    const p = [...r.peers.values()][0], w = (now - r.waitSince) / 1000; if (w < 4) continue;
    const tol = Math.min(600, TOL0 + 25 * w); let best = null, bs = 1e9;
    for (const o of rooms.values()) { if (o === r || !o.quick || o.locked || o.peers.size >= MAX) continue; const sc = score(o, p); if (sc < bs) { bs = sc; best = o; } }
    if (best && bs <= tol) addTo(best, p);
  }
  for (const p of peers.values()) if (p.ws && p.ws.open && (now % 20000) < 1000) p.ws.ping();
}, 1000);

if (require.main === module) server.listen(PORT, () => console.log("Redline Rush server listening on :" + PORT));
module.exports = { server, rooms, peers };
