// Tests for src/control/ws.ts, the hand-rolled WebSocket client, against the handwritten server in
// control.cloud.fakes.mjs: the upgrade (headers, subprotocols, accept check, refusals as error
// codes with no query string in the message), masking, text and binary both ways, fragmented and
// 64-bit-length messages, the size cap, ping/pong, the close handshake from either side, a dropped
// connection, and messages the server sends before anyone listens.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./remote.fakes.mjs";
import { serverFrame, wsServe } from "./control.cloud.fakes.mjs";

const M = await load("src/control/ws.ts");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("upgrade carries headers and subprotocols; text and binary both ways; client frames are masked", async () => {
  const srv = await wsServe({
    protocol: (offered) => offered.find((p) => p === "X-Exit-Control"),
    ws(conn) {
      conn.onMessage((m) => {
        if (m.op === 1) conn.text(`echo:${m.data}`);
        else conn.binary(Buffer.concat([Buffer.from([0xff]), m.data]));
      });
    },
  });
  const ws = await M.connectWs(`${srv.wsUrl}/pty/abc/connect?x=1`, { headers: { Authorization: "Bearer dummy-key", "X-Org": "org-1" }, protocols: ["X-Exit-Control"] });
  assert.equal(ws.protocol, "X-Exit-Control");
  const up = srv.requests.find((r) => r.method === "UPGRADE");
  assert.equal(up.path, "/pty/abc/connect");
  assert.equal(up.query.x, "1");
  assert.equal(up.headers.authorization, "Bearer dummy-key");
  assert.equal(up.headers["x-org"], "org-1");
  assert.equal(up.headers["sec-websocket-version"], "13");
  const got = [];
  ws.onMessage((m) => got.push(m));
  ws.send("hi ✓");
  ws.send(new Uint8Array([1, 2, 3]));
  const big = "x".repeat(70_000); // 16-bit and 64-bit length forms
  ws.send(big);
  await wait(150);
  assert.equal(got[0], "echo:hi ✓");
  assert.deepEqual([...got[1]], [0xff, 1, 2, 3]);
  assert.equal(got[2], `echo:${big}`);
  assert.ok(srv.conns[0].frames.every((f) => f.masked), "every client frame is masked");
  ws.close();
  await wait(50);
  assert.deepEqual(srv.conns[0].closed, { code: 1000, reason: "" });
  await srv.close();
});

test("refused upgrades become error codes without the query string; a bad accept or protocol is refused", async () => {
  const srv = await wsServe({ reject: (req, url) => (url.pathname === "/auth" ? 401 : url.pathname === "/gone" ? 404 : url.pathname === "/boom" ? 502 : 0) });
  await assert.rejects(M.connectWs(`${srv.wsUrl}/auth?token=secret-token-value`), (e) => e.code === "auth" && !/secret-token-value|token=/.test(e.message));
  await assert.rejects(M.connectWs(`${srv.wsUrl}/gone`), (e) => e.code === "gone");
  await assert.rejects(M.connectWs(`${srv.wsUrl}/boom`), (e) => e.code === "unreachable");
  await srv.close();

  const bad = await wsServe({ accept: "not-the-right-accept" });
  await assert.rejects(M.connectWs(bad.wsUrl), /Sec-WebSocket-Accept/);
  await bad.close();

  const sneaky = await wsServe({ protocol: () => "something-else" });
  await assert.rejects(M.connectWs(sneaky.wsUrl, { protocols: ["mine"] }), /subprotocol/);
  await sneaky.close();

  await assert.rejects(M.connectWs("ws://127.0.0.1:1/x", { timeoutMs: 2000 }), (e) => e.code === "unreachable");
  await assert.rejects(M.connectWs("http://127.0.0.1:1/x"), /not a WebSocket URL/);
});

test("an upgrade that never answers times out", async () => {
  const { createServer } = await import("node:net");
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  await assert.rejects(M.connectWs(`ws://127.0.0.1:${hang.address().port}/`, { timeoutMs: 200 }), (e) => e.code === "timeout");
  hang.close();
});

test("server speaks first: the message waits for the first listener; fragments are joined; ping gets a pong", async () => {
  const srv = await wsServe({
    ws(conn) {
      conn.text(JSON.stringify({ type: "control", status: "connected" }));
      conn.raw(serverFrame(2, Buffer.from("par"), { fin: false }));
      conn.raw(serverFrame(9, Buffer.from("are-you-there")));
      conn.raw(serverFrame(0, Buffer.from("ts"), { fin: true }));
    },
  });
  const ws = await M.connectWs(srv.wsUrl);
  await wait(80);
  const got = [];
  ws.onMessage((m) => got.push(typeof m === "string" ? m : Buffer.from(m).toString()));
  await wait(50);
  assert.deepEqual(got, ['{"type":"control","status":"connected"}', "parts"]);
  assert.equal(srv.conns[0].pong, "are-you-there");
  ws.close();
  await srv.close();
});

test("a server that sends and closes at once: the messages still reach the first listener, before the close", async () => {
  const srv = await wsServe({
    ws(conn) {
      conn.binary(Buffer.from("replayed-1"));
      conn.binary(Buffer.from("replayed-2"));
      conn.close(1000);
    },
  });
  const ws = await M.connectWs(srv.wsUrl);
  await wait(80);
  const seen = [];
  ws.onMessage((m) => seen.push(Buffer.from(m).toString()));
  ws.onClose((code) => seen.push(`close ${code}`));
  await wait(50);
  assert.deepEqual(seen, ["replayed-1", "replayed-2", "close 1000"]);
  await srv.close();
});

test("an idle connection pings the server on its own, and stops once closed", async () => {
  const srv = await wsServe({ ws() {} });
  const ws = await M.connectWs(srv.wsUrl, { pingMs: 40 });
  await wait(150);
  const pings = srv.conns[0].frames.filter((f) => f.op === 9);
  assert.ok(pings.length >= 2, `pings: ${pings.length}`);
  assert.ok(pings.every((f) => f.masked !== false), "client frames stay masked");
  ws.close();
  await wait(60);
  const after = srv.conns[0].frames.filter((f) => f.op === 9).length;
  await wait(120);
  assert.equal(srv.conns[0].frames.filter((f) => f.op === 9).length, after, "no pings after close");
  await srv.close();
});

test("the server's close (with a JSON reason) is answered and reported once; a drop is 1006", async () => {
  const srv = await wsServe({
    ws(conn) {
      setTimeout(() => conn.close(1011, JSON.stringify({ exitCode: 3, exitReason: "non-zero exit" })), 30);
    },
  });
  const ws = await M.connectWs(srv.wsUrl);
  const closes = [];
  ws.onClose((code, reason) => closes.push([code, reason]));
  await wait(150);
  assert.deepEqual(closes, [[1011, '{"exitCode":3,"exitReason":"non-zero exit"}']]);
  assert.equal(ws.closed, true);
  // Echoed back with the same code.
  assert.equal(srv.conns[0].frames.find((f) => f.op === 8).payload.readUInt16BE(0), 1011);
  // A listener added after the close still hears it.
  const late = await new Promise((r) => ws.onClose((c) => r(c)));
  assert.equal(late, 1011);
  await srv.close();

  const drop = await wsServe({ ws: (conn) => setTimeout(() => conn.socket.destroy(), 30) });
  const ws2 = await M.connectWs(drop.wsUrl);
  const code = await new Promise((r) => ws2.onClose((c) => r(c)));
  assert.equal(code, 1006);
  await drop.close();
});

test("oversized and masked server frames are protocol errors", async () => {
  const srv = await wsServe({
    ws(conn, req, url) {
      if (url.pathname === "/big") conn.binary(Buffer.alloc(2048));
      else conn.raw(serverFrame(1, Buffer.from("x"), { mask: true }));
    },
  });
  const big = await M.connectWs(`${srv.wsUrl}/big`, { maxMessageBytes: 1024 });
  assert.equal(await new Promise((r) => big.onClose((c) => r(c))), 1009);
  const masked = await M.connectWs(`${srv.wsUrl}/masked`);
  assert.equal(await new Promise((r) => masked.onClose((c) => r(c))), 1002);
  await srv.close();
});
