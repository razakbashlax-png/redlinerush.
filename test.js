"use strict";
/* End-to-end test: starts the server, connects several WebSocket clients, checks rooms, presence sync,
   start/roster, 8-player cap, quick-race latency matching and reconnect. Run: npm test (Node 22+ for global WebSocket) */
const { spawn } = require("child_process"), assert = require("assert");
const PORT = 18080 + (process.pid % 500), URL = "ws://127.0.0.1:" + PORT + "/ws";
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(name) {
  const c = { name, msgs: [], id: null, hi: null }; c.ws = new WebSocket(URL);
  c.open = new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = rej; });
  c.ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === "w") c.id = m.id; if (m.t === "hi") c.hi = m; };
  c.send = o => c.ws.send(JSON.stringify(o));
  c.wait = async (f, ms = 4000) => { const t = Date.now(); for (;;) { const m = c.msgs.find(f); if (m) return m; if (Date.now() - t > ms) throw new Error(name + " timed out waiting"); await sleep(20); } };
  return c;
}
(async () => {
  const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT }, stdio: "inherit" });
  try {
    await sleep(500);
    const h = await fetch("http://127.0.0.1:" + PORT + "/health"); assert.equal(await h.text(), "ok");

    // 1. create + join + presence + go
    const A = client("A"), B = client("B"); await A.open; await B.open;
    A.send({ t: "create", n: "Alice", tr: "lekki" }); const hiA = await A.wait(m => m.t === "hi");
    assert.equal(hiA.code.length, 5); assert.equal(hiA.quick, false);
    B.send({ t: "join", code: hiA.code.toLowerCase(), n: "Bob" }); const hiB = await B.wait(m => m.t === "hi");
    assert.equal(hiB.code, hiA.code); assert.equal(Object.keys(hiB.peers).length, 2);
    await A.wait(m => m.t === "j" && m.id === B.id);
    A.send({ t: "p", d: { n: "Alice", car: 3, x: 10.5, z: -4, h: 1.2, vf: 40, lap: 0, idx: 7, evil: "x" } });
    const s = await B.wait(m => m.t === "s" && m.p[A.id]); assert.equal(s.p[A.id].x, 10.5); assert.equal(s.p[A.id].evil, undefined);
    B.send({ t: "p", d: { n: "Bob<script>", bm: [1, 2, 3, 4, 5, 6, A.id] } });
    const s2 = await A.wait(m => m.t === "s" && m.p[B.id] && m.p[B.id].n); assert.equal(s2.p[B.id].n, "Bobscript"); assert.equal(s2.p[B.id].bm[6], A.id);
    assert(!A.msgs.some(m => m.t === "s" && m.p[A.id]), "no echo to sender");
    A.send({ t: "go", tr: "lekki" }); const g = await B.wait(m => m.t === "go");
    assert.deepEqual(g.ids, [A.id, B.id].sort()); assert.equal(g.tr, "lekki"); assert.equal(g.n, 1);
    console.log("ok  create/join/presence/go");

    // 2. unknown room, 8-player cap
    const X = client("X"); await X.open; X.send({ t: "join", code: "ZZZZZ", n: "X" }); await X.wait(m => m.t === "err");
    const R = client("R0"); await R.open; R.send({ t: "create", n: "R0" }); const hiR = await R.wait(m => m.t === "hi");
    const crowd = []; for (let i = 1; i < 8; i++) { const c = client("R" + i); await c.open; c.send({ t: "join", code: hiR.code, n: "R" + i }); await c.wait(m => m.t === "hi"); crowd.push(c); }
    const ninth = client("R8"); await ninth.open; ninth.send({ t: "join", code: hiR.code, n: "R8" }); const e9 = await ninth.wait(m => m.t === "err"); assert(/full/i.test(e9.m));
    console.log("ok  8-player cap, 9th rejected");

    // 3. quick race: similar latency pairs up, far-away latency does not
    const Q1 = client("Q1"), Q2 = client("Q2"), Q3 = client("Q3"); await Q1.open; await Q2.open; await Q3.open;
    Q1.send({ t: "quick", n: "Q1", rtt: 40, tz: "Africa/Lagos", tr: "ikeja" }); const q1 = await Q1.wait(m => m.t === "hi");
    Q2.send({ t: "quick", n: "Q2", rtt: 55, tz: "Africa/Lagos" }); const q2 = await Q2.wait(m => m.t === "hi"); assert.equal(q2.code, q1.code); assert.equal(q2.track, "ikeja");
    Q3.send({ t: "quick", n: "Q3", rtt: 420, tz: "Asia/Tokyo" }); const q3 = await Q3.wait(m => m.t === "hi"); assert.notEqual(q3.code, q1.code);
    console.log("ok  quick race matches by latency");
    const cd = await Q1.wait(m => m.t === "cd" && m.s != null, 3000); assert(cd.s <= 10);
    Q1.send({ t: "p", d: { n: "Q1" } }); Q2.send({ t: "p", d: { n: "Q2" } });
    await sleep(100);
    const go = await Q1.wait(m => m.t === "go", 14000); assert.deepEqual(go.ids, [Q1.id, Q2.id].sort());
    console.log("ok  quick room auto-starts after countdown");

    // 4. reconnect within grace period
    const tok = hiA.token, aid = A.id; A.ws.close(); await sleep(300);
    const A2 = client("A2"); await A2.open; A2.send({ t: "rejoin", id: aid, token: tok }); const re = await A2.wait(m => m.t === "hi"); assert.equal(re.re, 1); assert.equal(re.id, aid);
    const bad = client("bad"); await bad.open; bad.send({ t: "rejoin", id: aid, token: "nope" }); await bad.wait(m => m.t === "err");
    console.log("ok  reconnect with token (and bad token refused)");
    console.log("ALL TESTS PASSED");
  } catch (e) { console.error("FAILED:", e); process.exitCode = 1; }
  srv.kill(); setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
