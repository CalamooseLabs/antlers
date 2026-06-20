// vibe-server — the web service behind `services.vibe`.
//
// ZERO external imports — required for the offline FOD build (see ../../package.nix).
// Uses only `Deno.*` and Web platform globals (crypto.subtle, btoa/atob,
// TextEncoder/Decoder). Adding any `jsr:` / `npm:` / `https:` / `@std/*` import
// makes the deno-cache FOD output non-empty and breaks the sandboxed build.
//
// What it does: a shared-password login (signed cookie) gates a small web UI
// that lists a predefined set of directories (from /etc/vibe/config.json),
// spawns `vibe` sessions in them (each launched in Claude Code Remote Control
// mode so it is driven from claude.ai / mobile), lists/kills those sessions, and
// streams each session's captured output to the browser read-only over SSE.

interface DirConfig {
  name: string;
  path: string;
}

interface ServerConfig {
  port: number;
  hostname: string;
  stateDir: string;
  passwordFile: string;
  directories: DirConfig[];
  sessionCommand: string[];
}

const DEFAULTS: ServerConfig = {
  port: 8420,
  hostname: "0.0.0.0",
  stateDir: "/var/lib/vibe",
  passwordFile: "/run/secrets/vibe-password",
  directories: [],
  sessionCommand: ["vibe", "--remote-control", "@NAME@"],
};

const COOKIE = "vibe_session";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Cap retained sessions so a long-running daemon doesn't grow the in-memory map
// or the on-disk log pile without bound; oldest terminated sessions are evicted.
const MAX_SESSIONS = 100;

function isError(e: unknown): e is Error {
  return e instanceof Error;
}

// ---- config -------------------------------------------------------------

async function loadConfig(): Promise<ServerConfig> {
  const path = Deno.env.get("VIBE_CONFIG") ?? "/etc/vibe/config.json";
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    console.error("vibe-server: failed to load config:", isError(e) ? e.message : String(e));
    Deno.exit(1);
  }
}

// ---- crypto: HMAC-signed session cookie + constant-time password check --

let hmacKey: CryptoKey;

// Web Crypto wants ArrayBuffer-backed views; normalise to satisfy the strict
// `BufferSource` (vs `Uint8Array<ArrayBufferLike>`) typings of recent TS libs.
const buf = (u: Uint8Array): BufferSource => u as BufferSource;

async function getSecret(stateDir: string): Promise<Uint8Array> {
  const path = `${stateDir}/cookie.secret`;
  try {
    return await Deno.readFile(path);
  } catch {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeFile(path, secret, { mode: 0o600 });
    return secret;
  }
}

async function initKey(secret: Uint8Array): Promise<void> {
  hmacKey = await crypto.subtle.importKey(
    "raw",
    buf(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64url(s: string): Uint8Array {
  let t = s.replaceAll("-", "+").replaceAll("_", "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function makeToken(): Promise<string> {
  const payload = JSON.stringify({
    iat: Date.now(),
    n: b64url(crypto.getRandomValues(new Uint8Array(8))),
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, buf(payloadBytes)));
  return `${b64url(payloadBytes)}.${b64url(sig)}`;
}

async function verifyToken(token: string): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  try {
    const payloadBytes = unb64url(token.slice(0, dot));
    const sig = unb64url(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", hmacKey, buf(sig), buf(payloadBytes));
    if (!ok) return false;
    const { iat } = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof iat === "number" && Date.now() - iat <= TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(new TextEncoder().encode(s))));
}

function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function checkPassword(submitted: string, passwordFile: string): Promise<boolean> {
  let expected: string;
  try {
    expected = (await Deno.readTextFile(passwordFile)).trim();
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  // Compare SHA-256 digests so the comparison is fixed-length and constant-time.
  return ctEq(await sha256(submitted), await sha256(expected));
}

// ---- cookies ------------------------------------------------------------

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v; // tolerate malformed percent-encoding rather than throwing
      }
    }
  }
  return out;
}

function setCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
    Math.floor(TOKEN_TTL_MS / 1000)
  }`;
}

function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function isAuthed(req: Request): Promise<boolean> {
  const token = parseCookies(req.headers.get("cookie"))[COOKIE];
  return token ? await verifyToken(token) : false;
}

// ---- sessions -----------------------------------------------------------

type Status = "running" | "exited" | "failed";

interface SessionInfo {
  id: string;
  dir: string;
  path: string;
  name: string;
  pid: number;
  status: Status;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
}

interface Session {
  info: SessionInfo;
  child: Deno.ChildProcess;
  logPath: string;
}

const sessions = new Map<string, Session>();

function substitute(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) => {
    let r = part;
    for (const [k, v] of Object.entries(vars)) r = r.replaceAll(`@${k}@`, v);
    return r;
  });
}

// Evict oldest terminated sessions (and delete their logs) once over the cap.
// Running sessions are never evicted.
async function pruneSessions(): Promise<void> {
  if (sessions.size < MAX_SESSIONS) return;
  const terminal = [...sessions.values()]
    .filter((s) => s.info.status !== "running")
    .sort((a, b) => (a.info.exitedAt ?? a.info.startedAt) - (b.info.exitedAt ?? b.info.startedAt));
  for (const s of terminal) {
    if (sessions.size < MAX_SESSIONS) break;
    sessions.delete(s.info.id);
    try {
      await Deno.remove(s.logPath);
    } catch { /* ignore */ }
  }
}

async function spawnSession(config: ServerConfig, dirName: string): Promise<SessionInfo> {
  const dir = config.directories.find((d) => d.name === dirName);
  if (!dir) throw new Error(`Unknown directory: ${dirName}`);
  await pruneSessions();

  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const name = `${dir.name}-${id.slice(0, 4)}`;
  const logDir = `${config.stateDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });
  const logPath = `${logDir}/${id}.log`;
  const log = await Deno.open(logPath, { create: true, write: true, append: true });

  const resolved = substitute(config.sessionCommand, { DIR: dir.path, NAME: name });
  const [bin, ...args] = resolved;

  // Launch via setsid so the session leads its own process group. Under the
  // systemd unit the Deno process's children are not group leaders, so setsid
  // execs (no fork) and child.pid == the new pgid, letting kill(-pid) reap the
  // whole tree. The Anthropic credentials reach claude via the inherited env
  // (ANTHROPIC_API_KEY / CLAUDE_CONFIG_DIR / HOME set on the unit) — never as a
  // CLI arg, so they don't leak into /proc/<pid>/cmdline or the captured log.
  const cmd = new Deno.Command("setsid", {
    args: [bin, ...args],
    cwd: dir.path,
    env: { ...Deno.env.toObject() },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = cmd.spawn();
  } catch (e) {
    try {
      log.close();
    } catch { /* ignore */ }
    throw new Error(`Failed to launch session: ${isError(e) ? e.message : String(e)}`);
  }

  const info: SessionInfo = {
    id,
    dir: dir.name,
    path: dir.path,
    name,
    pid: child.pid,
    status: "running",
    startedAt: Date.now(),
  };

  const enc = new TextEncoder();
  await log.write(enc.encode(`# vibe session ${name}\n# dir: ${dir.path}\n# cmd: ${resolved.join(" ")}\n\n`));

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      try {
        await log.write(chunk);
      } catch { /* log closed */ }
    }
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);

  child.status.then((st) => {
    // A non-zero exit within the first couple of seconds almost always means the
    // session never really started (bad cwd, missing creds, etc.).
    info.status = Date.now() - info.startedAt < 2000 && st.code !== 0 ? "failed" : "exited";
    info.exitedAt = Date.now();
    info.exitCode = st.code;
  }).catch(() => {
    info.status = "failed";
    info.exitedAt = Date.now();
  });
  pumps.then(() => {
    try {
      log.close();
    } catch { /* ignore */ }
  });

  sessions.set(id, { info, child, logPath });
  return info;
}

function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.info.status !== "running") {
    sessions.delete(id);
    return true;
  }
  const term = (sig: Deno.Signal) => {
    try {
      Deno.kill(-s.info.pid, sig); // process group
    } catch {
      try {
        Deno.kill(s.info.pid, sig);
      } catch { /* already gone */ }
    }
  };
  term("SIGTERM");
  setTimeout(() => {
    if (s.info.status === "running") term("SIGKILL");
  }, 5000);
  return true;
}

// ---- SSE log streaming --------------------------------------------------

function sseChunk(text: string): string {
  // One SSE event whose data is (possibly multi-line) text, blank-line terminated.
  return text.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

function streamLog(logPath: string): Response {
  let file: Deno.FsFile | null = null;
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ka: ReturnType<typeof setInterval> | undefined;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const cleanup = () => {
    if (timer !== undefined) clearInterval(timer);
    if (ka !== undefined) clearInterval(ka);
    try {
      file?.close();
    } catch { /* ignore */ }
    file = null;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let draining = false;
      const drain = async () => {
        if (draining) return; // serialize: never overlap reads on the shared fd/offset
        draining = true;
        try {
          if (!file) {
            try {
              file = await Deno.open(logPath, { read: true });
            } catch {
              return; // not created yet
            }
          }
          await file.seek(offset, Deno.SeekMode.Start);
          const buf = new Uint8Array(65536);
          while (true) {
            const n = await file.read(buf);
            if (n === null) break;
            offset += n;
            // stream:true buffers partial multi-byte UTF-8 split across reads so
            // it isn't emitted as replacement characters.
            const text = dec.decode(buf.subarray(0, n), { stream: true });
            if (text) controller.enqueue(enc.encode(sseChunk(text)));
          }
        } catch { /* transient read error / stream closed */ } finally {
          draining = false;
        }
      };
      await drain();
      timer = setInterval(drain, 700);
      ka = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

// ---- HTTP helpers -------------------------------------------------------

function json(obj: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function htmlResponse(): Response {
  return new Response(INDEX_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---- router -------------------------------------------------------------

async function handler(req: Request, config: ServerConfig): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/" && method === "GET") return htmlResponse();

  if (path === "/api/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const ok = typeof body?.password === "string" &&
      await checkPassword(body.password, config.passwordFile);
    if (!ok) return json({ error: "Invalid password" }, 401);
    return json({ ok: true }, 200, { "set-cookie": setCookie(await makeToken()) });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  // Everything below requires authentication.
  if (!await isAuthed(req)) return json({ error: "Unauthorized" }, 401);

  if (path === "/api/me" && method === "GET") return json({ ok: true });

  if (path === "/api/directories" && method === "GET") {
    return json({ directories: config.directories.map((d) => ({ name: d.name, path: d.path })) });
  }

  if (path === "/api/sessions" && method === "GET") {
    return json({ sessions: [...sessions.values()].map((s) => s.info) });
  }

  if (path === "/api/sessions" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.dir !== "string") return json({ error: "Missing 'dir'" }, 400);
    try {
      return json({ session: await spawnSession(config, body.dir) }, 201);
    } catch (e) {
      return json({ error: isError(e) ? e.message : String(e) }, 400);
    }
  }

  const del = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
  if (del && method === "DELETE") {
    const ok = killSession(del[1]);
    return json({ ok }, ok ? 200 : 404);
  }

  const logs = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/logs$/);
  if (logs && method === "GET") {
    const s = sessions.get(logs[1]);
    if (!s) return json({ error: "Not found" }, 404);
    return streamLog(s.logPath);
  }

  return json({ error: "Not found" }, 404);
}

// ---- frontend (inlined; no asset files -> robust under `deno compile`) ---

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vibe</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0d1117; color: #c9d1d9; }
  header { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; border-bottom: 1px solid #21262d; }
  header h1 { font-size: 18px; margin: 0; letter-spacing: 1px; }
  button { font: inherit; cursor: pointer; border: 1px solid #30363d; background: #21262d;
    color: #c9d1d9; padding: 6px 12px; border-radius: 6px; }
  button:hover { background: #30363d; }
  button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  button.danger { background: #6e2222; border-color: #b62324; color: #fff; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  select, input { font: inherit; background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .pill { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .running { background: #133a1b; color: #56d364; }
  .exited { background: #21262d; color: #8b949e; }
  .failed { background: #4a1d1d; color: #ff7b72; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  #login { max-width: 360px; margin: 12vh auto; text-align: center; }
  #login h1 { letter-spacing: 2px; }
  #login .row { justify-content: center; margin-top: 14px; }
  .err { color: #ff7b72; min-height: 20px; margin-top: 10px; }
  pre#log { background: #010409; border: 1px solid #21262d; border-radius: 6px;
    padding: 12px; height: 380px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; margin-top: 12px; }
  .muted { color: #8b949e; }
  .hidden { display: none; }
</style>
</head>
<body>
<div id="login">
  <h1>vibe</h1>
  <p class="muted">Sign in to manage Claude Code sessions.</p>
  <div class="row">
    <input id="pw" type="password" placeholder="password" autofocus />
    <button class="primary" onclick="login()">Sign in</button>
  </div>
  <div class="err" id="loginErr"></div>
</div>

<div id="app" class="hidden">
  <header>
    <h1>vibe</h1>
    <button onclick="logout()">Sign out</button>
  </header>
  <main>
    <div class="row">
      <select id="dir"></select>
      <button class="primary" onclick="startSession()">Start session</button>
      <span class="muted" id="startErr"></span>
    </div>

    <table>
      <thead>
        <tr><th>Session</th><th>Directory</th><th>Status</th><th>Started</th><th></th></tr>
      </thead>
      <tbody id="sessions"></tbody>
    </table>

    <div id="logView" class="hidden">
      <div class="row" style="margin-top:20px">
        <strong id="logTitle"></strong>
        <button onclick="closeLog()">Close logs</button>
      </div>
      <pre id="log"></pre>
    </div>
  </main>
</div>

<script>
let es = null;

async function api(path, opts) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  return r;
}

async function login() {
  const pw = document.getElementById("pw").value;
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw }) });
  if (r.ok) { show(); }
  else { document.getElementById("loginErr").textContent = "Invalid password"; }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  closeLog();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.remove("hidden");
}

function show() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  loadDirs();
  refresh();
}

async function loadDirs() {
  const r = await api("/api/directories");
  if (!r.ok) return;
  const { directories } = await r.json();
  const sel = document.getElementById("dir");
  sel.innerHTML = "";
  if (!directories.length) {
    const o = document.createElement("option");
    o.textContent = "(no directories configured)";
    o.disabled = true;
    sel.appendChild(o);
    return;
  }
  for (const d of directories) {
    const o = document.createElement("option");
    o.value = d.name;
    o.textContent = d.name + "  —  " + d.path;
    sel.appendChild(o);
  }
}

async function startSession() {
  const dir = document.getElementById("dir").value;
  if (!dir) return;
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ dir }) });
  const err = document.getElementById("startErr");
  if (!r.ok) { const b = await r.json().catch(() => ({})); err.textContent = b.error || "Failed to start"; }
  else { err.textContent = ""; refresh(); }
}

async function killSession(id) {
  await api("/api/sessions/" + id, { method: "DELETE" });
  refresh();
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

async function refresh() {
  const r = await api("/api/sessions");
  if (r.status === 401) { return logout(); }
  if (!r.ok) return;
  const { sessions } = await r.json();
  const tb = document.getElementById("sessions");
  tb.innerHTML = "";
  if (!sessions.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="muted">No sessions yet.</td>';
    tb.appendChild(tr);
  }
  for (const s of sessions) {
    const tr = document.createElement("tr");
    const code = (s.exitCode === undefined || s.exitCode === null) ? "" : " (" + s.exitCode + ")";
    tr.innerHTML =
      '<td>' + s.name + '</td>' +
      '<td class="muted">' + s.path + '</td>' +
      '<td><span class="pill ' + s.status + '">' + s.status + code + '</span></td>' +
      '<td class="muted">' + fmtTime(s.startedAt) + '</td>' +
      '<td class="row"></td>';
    const actions = tr.lastElementChild;
    const logsBtn = document.createElement("button");
    logsBtn.textContent = "Logs";
    logsBtn.onclick = () => openLog(s.id, s.name);
    actions.appendChild(logsBtn);
    if (s.status === "running") {
      const killBtn = document.createElement("button");
      killBtn.className = "danger";
      killBtn.textContent = "Kill";
      killBtn.onclick = () => killSession(s.id);
      actions.appendChild(killBtn);
    }
    tb.appendChild(tr);
  }
}

function openLog(id, name) {
  closeLog();
  document.getElementById("logView").classList.remove("hidden");
  document.getElementById("logTitle").textContent = "Logs — " + name;
  const pre = document.getElementById("log");
  pre.textContent = "";
  es = new EventSource("/api/sessions/" + id + "/logs");
  es.onmessage = (ev) => {
    pre.textContent += ev.data + "\\n";
    pre.scrollTop = pre.scrollHeight;
  };
  es.onerror = () => { /* keep trying; EventSource auto-reconnects */ };
}

function closeLog() {
  if (es) { es.close(); es = null; }
  document.getElementById("logView").classList.add("hidden");
}

document.getElementById("pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

setInterval(() => {
  if (!document.getElementById("app").classList.contains("hidden")) refresh();
}, 3000);

// Decide which view to show on load.
(async () => {
  const r = await api("/api/me");
  if (r.ok) show();
})();
</script>
</body>
</html>`;

// ---- main ---------------------------------------------------------------

async function main() {
  const config = await loadConfig();
  await Deno.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  await initKey(await getSecret(config.stateDir));

  console.log(`vibe-server listening on ${config.hostname}:${config.port}`);
  console.log(
    `directories: ${config.directories.map((d) => d.name).join(", ") || "(none configured)"}`,
  );

  Deno.serve(
    { port: config.port, hostname: config.hostname },
    async (req) => {
      try {
        return await handler(req, config);
      } catch (e) {
        console.error("vibe-server: request error:", isError(e) ? e.message : String(e));
        return json({ error: "Internal error" }, 500);
      }
    },
  );
}

if (import.meta.main) {
  main();
}
