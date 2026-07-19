// A tiny RFC 6455 WebSocket *client* over Deno.connectTls/connect.
//
// Why not the built-in `WebSocket`? The UniFi Protect subscribe endpoints
// (/v1/subscribe/events, /v1/subscribe/devices) authenticate with an `X-API-KEY`
// REQUEST HEADER, and the WHATWG `WebSocket` constructor cannot set request headers.
// Doing the handshake by hand over a raw TLS socket lets us send that header — and,
// because it goes through Deno's TLS stack, the compiled binary's baked
// `--unsafely-ignore-certificate-errors` covers the console's self-signed cert here
// too (the same way it does for `fetch`).
//
// Scope: enough of the protocol to consume a server->client JSON event stream —
// text/binary (incl. fragmentation), ping->pong, and close. Client frames we send
// (pong/close) are masked as the spec requires. ZERO external imports.

import { log } from "./util.ts";

export interface WsHandlers {
  onOpen?: () => void;
  /** Text messages (and binary decoded as UTF-8 when no onBinary is given). */
  onMessage: (data: string) => void;
  onBinary?: (data: Uint8Array) => void;
  onClose?: (code: number, reason: string) => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Refuse a single frame or reassembled message larger than this. The peer is the trusted
// local console, but a malformed/huge length field (or an endless run of un-FINed
// continuations) would otherwise grow allocation without bound until the process dies.
const MAX_MESSAGE = 8 * 1024 * 1024;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfDoubleCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let off = 0;
  while (off < data.length) {
    off += await conn.write(data.subarray(off));
  }
}

// Build a masked client frame (FIN=1, single frame).
function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  let header: number[];
  if (len < 126) header = [0x80 | opcode, 0x80 | len];
  else if (len < 65536) header = [0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff];
  else {
    header = [0x80 | opcode, 0x80 | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const out = new Uint8Array(header.length + 4 + len);
  out.set(header, 0);
  out.set(mask, header.length);
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

/**
 * Connect, run the handshake with the given extra headers, and pump frames until the
 * socket closes or `signal` aborts. Returns when the connection ends; the caller owns
 * reconnection. Never throws for a normal close — errors are logged and end the pump.
 */
export async function connectWs(
  urlStr: string,
  headers: Record<string, string>,
  handlers: WsHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(urlStr);
  const secure = url.protocol === "wss:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;

  let conn: Deno.Conn;
  try {
    conn = secure
      ? await Deno.connectTls({ hostname: url.hostname, port })
      : await Deno.connect({ hostname: url.hostname, port });
  } catch (e) {
    handlers.onClose?.(1006, `connect failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  let closed = false;
  const closeConn = () => {
    if (closed) return;
    closed = true;
    try {
      conn.close();
    } catch { /* already gone */ }
  };
  if (signal) {
    if (signal.aborted) return closeConn();
    signal.addEventListener("abort", closeConn, { once: true });
  }

  // Sec-WebSocket-Key must be STANDARD (padded) base64 of a 16-byte nonce. A strict
  // proxy (the console's nginx) 400s on base64url — Deno's own upgrade server is lenient,
  // which is why the unit test passed but the real console rejected the handshake.
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const req = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...extra,
    "",
    "",
  ].join("\r\n");

  const readBuf = new Uint8Array(64 * 1024);
  let buf: Uint8Array = new Uint8Array(0);

  // ---- handshake ----
  try {
    await writeAll(conn, enc.encode(req));
    while (true) {
      const idx = indexOfDoubleCRLF(buf);
      if (idx >= 0) {
        const statusLine = dec.decode(buf.slice(0, buf.indexOf(13))).trim();
        // Compare the status-code token (second whitespace field) rather than a " 101 "
        // substring, so a legal response with no reason phrase ("HTTP/1.1 101") still passes.
        const statusCode = statusLine.split(/\s+/)[1];
        if (statusCode !== "101") {
          closeConn();
          handlers.onClose?.(1002, `handshake failed: ${statusLine}`);
          return;
        }
        buf = buf.slice(idx + 4);
        break;
      }
      const n = await conn.read(readBuf);
      if (n === null) {
        closeConn();
        handlers.onClose?.(1006, "closed during handshake");
        return;
      }
      buf = concat(buf, readBuf.subarray(0, n));
    }
  } catch (e) {
    closeConn();
    handlers.onClose?.(1006, `handshake error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  handlers.onOpen?.();

  // ---- frame pump ----
  let fragOpcode = 0;
  let fragParts: Uint8Array[] = [];
  let fragTotal = 0;
  let closeCode = 1006;
  let closeReason = "";

  const deliver = (opcode: number, payload: Uint8Array) => {
    if (opcode === 1) handlers.onMessage(dec.decode(payload));
    else if (opcode === 2) {
      if (handlers.onBinary) handlers.onBinary(payload);
      else handlers.onMessage(dec.decode(payload));
    }
  };

  // Parse as many complete frames as `buf` holds; returns the unconsumed remainder.
  const parseAll = (): boolean => {
    while (true) {
      if (buf.length < 2) return true;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return true;
        len = (buf[2] << 8) | buf[3];
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return true;
        len = 0;
        for (let i = 0; i < 8; i++) len = len * 256 + buf[2 + i];
        off = 10;
      }
      if (len > MAX_MESSAGE) {
        closeCode = 1009;
        closeReason = "frame too large";
        return false;
      }
      let mask: Uint8Array | null = null;
      if (masked) {
        if (buf.length < off + 4) return true;
        mask = buf.slice(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return true;
      const payload = buf.slice(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + len);

      if (opcode === 0x8) {
        // close
        if (payload.length >= 2) {
          closeCode = (payload[0] << 8) | payload[1];
          closeReason = dec.decode(payload.slice(2));
        }
        return false; // stop
      } else if (opcode === 0x9) {
        // ping -> pong (best-effort)
        writeAll(conn, frame(0xa, payload)).catch(() => {});
      } else if (opcode === 0xa) {
        // pong; ignore
      } else if (opcode === 0x0) {
        fragTotal += payload.length;
        if (fragTotal > MAX_MESSAGE) {
          closeCode = 1009;
          closeReason = "message too large";
          return false;
        }
        fragParts.push(payload);
        if (fin) {
          const all = new Uint8Array(fragTotal);
          let o = 0;
          for (const p of fragParts) {
            all.set(p, o);
            o += p.length;
          }
          deliver(fragOpcode, all);
          fragParts = [];
          fragOpcode = 0;
          fragTotal = 0;
        }
      } else {
        // text (1) or binary (2)
        if (fin) {
          deliver(opcode, payload);
        } else {
          fragOpcode = opcode;
          fragParts = [payload];
          fragTotal = payload.length;
        }
      }
    }
  };

  try {
    if (!parseAll()) {
      closeConn();
      handlers.onClose?.(closeCode, closeReason);
      return;
    }
    while (!closed) {
      const n = await conn.read(readBuf);
      if (n === null) break;
      buf = concat(buf, readBuf.subarray(0, n));
      if (!parseAll()) break;
    }
  } catch (e) {
    if (!closed) log("debug", "ws read ended", { err: e instanceof Error ? e.message : String(e) });
  }
  closeConn();
  handlers.onClose?.(closeCode, closeReason);
}
