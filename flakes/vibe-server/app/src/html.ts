// The single-page UI, inlined as a string so it is robust under `deno compile`
// (no asset files to locate at runtime). ZERO external imports.
//
// NOTE: this is a template literal — keep `\\n` escaped (it must reach the
// browser as `\n`) and do NOT introduce backticks or `${...}` in the markup.

export const INDEX_HTML = `<!DOCTYPE html>
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
  a.loginlink { color: #d29922; text-decoration: none; border: 1px solid #9e6a03;
    background: #3a2d12; padding: 5px 10px; border-radius: 6px; }
  a.loginlink:hover { background: #4d3b18; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: #161b22;
    border: 1px solid #30363d; border-radius: 12px; padding: 2px 4px 2px 10px; font-size: 12px; }
  .chip button { padding: 0 6px; border-radius: 10px; }
  .terminating { background: #3a2d12; color: #d29922; }
  .meta { color: #8b949e; font-size: 12px; margin: 8px 0 0; }
  .meta code { color: #c9d1d9; }
  .meta a { color: #58a6ff; }
  @media (max-width: 640px) {
    main { padding: 12px; }
    th, td { padding: 6px 6px; }
    table { display: block; overflow-x: auto; white-space: nowrap; }
  }
  .howto { color: #8b949e; margin: 8px 0 0; }
  .howto a { color: #58a6ff; }
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
    <div class="row" id="addrow" style="margin-top:10px">
      <input id="newdir" placeholder="new project name (a-z0-9-_)" />
      <button onclick="addDir()">Add directory</button>
      <span class="muted" id="dirErr"></span>
    </div>
    <div class="row" id="dirchips" style="margin-top:6px"></div>
    <p class="howto">
      Sessions run in Claude Code Remote Control mode — open
      <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">claude.ai/code</a>
      or the mobile app and pick the session name to drive it. If a row shows
      <strong>Log in</strong>, click it to authenticate first.
    </p>

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
      <div class="meta" id="logMeta"></div>
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
  else if (r.status === 429) { document.getElementById("loginErr").textContent = "Too many attempts — wait and retry."; }
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
  const { directories, canManage } = await r.json();
  const sel = document.getElementById("dir");
  sel.innerHTML = "";
  if (!directories.length) {
    const o = document.createElement("option");
    o.textContent = "(no directories configured)";
    o.disabled = true;
    sel.appendChild(o);
  } else {
    for (const d of directories) {
      const o = document.createElement("option");
      o.value = d.name;
      o.textContent = d.name + "  —  " + d.path;
      sel.appendChild(o);
    }
  }
  document.getElementById("addrow").style.display = canManage ? "" : "none";
  const chips = document.getElementById("dirchips");
  chips.innerHTML = "";
  for (const d of directories) {
    if (!d.removable) continue;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.appendChild(document.createTextNode(d.name));
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Unregister " + d.name + " (files are kept on disk)";
    x.onclick = () => removeDir(d.name);
    chip.appendChild(x);
    chips.appendChild(chip);
  }
}

async function addDir() {
  const input = document.getElementById("newdir");
  const name = input.value.trim();
  const err = document.getElementById("dirErr");
  if (!name) return;
  const r = await api("/api/directories", { method: "POST", body: JSON.stringify({ name }) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); err.textContent = b.error || "Failed to add"; return; }
  err.textContent = "";
  input.value = "";
  loadDirs();
}

async function removeDir(name) {
  await api("/api/directories/" + name, { method: "DELETE" });
  loadDirs();
}

async function startSession() {
  const dir = document.getElementById("dir").value;
  if (!dir) return;
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ dir }) });
  const err = document.getElementById("startErr");
  if (!r.ok) { const b = await r.json().catch(() => ({})); err.textContent = b.error || "Failed to start"; }
  else { err.textContent = ""; refresh(); }
}

async function killSession(id, name) {
  if (!confirm("Kill session " + name + "?")) return;
  await api("/api/sessions/" + id, { method: "DELETE" });
  refresh();
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + sec + "s";
  return sec + "s";
}

function uptimeStr(s) {
  if (s.status === "running" || s.status === "terminating") return "  (" + fmtDur(Date.now() - s.startedAt) + ")";
  if (s.exitedAt) return "  (ran " + fmtDur(s.exitedAt - s.startedAt) + ")";
  return "";
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    const old = btn.textContent; btn.textContent = "✓";
    setTimeout(() => { btn.textContent = old; }, 1000);
  } catch (e) { /* ignore */ }
}

// Only link auth URLs on known Anthropic/Claude hosts (defense-in-depth vs.
// anything odd appearing in session output).
function safeLoginUrl(u) {
  return typeof u === "string" &&
    /^https:\\/\\/(claude\\.ai|console\\.anthropic\\.com|auth\\.anthropic\\.com|login\\.anthropic\\.com)\\//.test(u);
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
      '<td class="nmcell"></td>' +
      '<td class="muted">' + s.path + '</td>' +
      '<td><span class="pill ' + s.status + '">' + s.status + code + '</span></td>' +
      '<td class="muted">' + fmtTime(s.startedAt) + uptimeStr(s) + '</td>' +
      '<td class="row actions"></td>';
    const nm = tr.querySelector(".nmcell");
    nm.appendChild(document.createTextNode(s.name + " "));
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "⧉";
    copyBtn.title = "Copy session name";
    copyBtn.setAttribute("aria-label", "Copy session name " + s.name);
    copyBtn.onclick = () => copyText(s.name, copyBtn);
    nm.appendChild(copyBtn);
    const actions = tr.querySelector(".actions");
    if (safeLoginUrl(s.loginUrl)) {
      const a = document.createElement("a");
      a.href = s.loginUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "loginlink";
      a.textContent = "🔑 Log in";
      actions.appendChild(a);
    }
    const logsBtn = document.createElement("button");
    logsBtn.textContent = "Logs";
    logsBtn.onclick = () => openLog(s);
    actions.appendChild(logsBtn);
    if (s.status === "running") {
      const killBtn = document.createElement("button");
      killBtn.className = "danger";
      killBtn.textContent = "Kill";
      killBtn.setAttribute("aria-label", "Kill session " + s.name);
      killBtn.onclick = () => killSession(s.id, s.name);
      actions.appendChild(killBtn);
    }
    tb.appendChild(tr);
  }
}

function openLog(s) {
  closeLog();
  document.getElementById("logView").classList.remove("hidden");
  document.getElementById("logTitle").textContent = "Logs — " + s.name;
  const meta = document.getElementById("logMeta");
  meta.innerHTML = "";
  meta.appendChild(document.createTextNode("pid " + s.pid + " · " + s.status));
  if (s.command) {
    meta.appendChild(document.createTextNode(" · "));
    const c = document.createElement("code");
    c.textContent = s.command;
    meta.appendChild(c);
  }
  meta.appendChild(document.createTextNode(" · "));
  const dl = document.createElement("a");
  dl.href = "/api/sessions/" + s.id + "/logs/download";
  dl.textContent = "Download";
  meta.appendChild(dl);
  const pre = document.getElementById("log");
  pre.textContent = "";
  es = new EventSource("/api/sessions/" + s.id + "/logs");
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
