import { connectWs } from "../server/ws.ts";
import { assert } from "./assert.ts";

// Integration test over loopback: our hand-rolled client must complete the RFC 6455
// handshake against Deno's own upgradeWebSocket server and parse an unmasked text frame.
Deno.test("connectWs handshakes and receives a server text frame", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        socket.send(JSON.stringify({ hello: "world" }));
        setTimeout(() => socket.close(), 50);
      };
      return response;
    }
    return new Response("no");
  });
  const port = (server.addr as Deno.NetAddr).port;

  const received: string[] = [];
  await connectWs(
    "ws://127.0.0.1:" + port + "/subscribe",
    { "X-API-KEY": "test" },
    { onMessage: (m) => received.push(m) },
  );

  await server.shutdown();
  assert(received.length >= 1, "expected at least one message");
  assert(received[0].includes("world"), "message payload should round-trip");
});

// Regression: the Sec-WebSocket-Key must be STANDARD padded base64 (a strict proxy like
// the UniFi console's nginx 400s on base64url). Deno's own upgrade server is lenient, so
// this uses a raw socket to inspect the actual handshake bytes.
Deno.test("connectWs sends a standard-base64 Sec-WebSocket-Key (not base64url)", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  let seenKey = "";
  const serverDone = (async () => {
    const conn = await listener.accept();
    const buf = new Uint8Array(4096);
    const n = (await conn.read(buf)) ?? 0;
    const req = new TextDecoder().decode(buf.subarray(0, n));
    seenKey = (req.match(/sec-websocket-key:\s*(\S+)/i) ?? ["", ""])[1];
    await conn.write(new TextEncoder().encode("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
    const payload = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const frame = new Uint8Array(2 + payload.length);
    frame[0] = 0x81; // FIN + text
    frame[1] = payload.length;
    frame.set(payload, 2);
    await conn.write(frame);
    await conn.write(new Uint8Array([0x88, 0x00])); // close
    conn.close();
  })();

  const msgs: string[] = [];
  await connectWs("ws://127.0.0.1:" + port + "/x", {}, { onMessage: (m) => msgs.push(m) });
  await serverDone;
  listener.close();

  assert(/^[A-Za-z0-9+/]{22}==$/.test(seenKey), "Sec-WebSocket-Key must be standard padded base64, got: " + seenKey);
  assert(msgs.some((m) => m.includes("ok")), "should receive the server frame");
});
