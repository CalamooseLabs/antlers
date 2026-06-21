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
  /* ---- claude account auth banner + login modal ---- */
  #authBanner { margin: 0 0 12px; }
  #authBanner.warn { background: #3a2d12; color: #d29922; border: 1px solid #9e6a03;
    border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  #authBanner.ok { color: #8b949e; font-size: 12px; padding: 2px 0; }
  #authBanner .spacer { flex: 1 1 auto; }
  .authstep { margin: 0 0 18px; }
  .authstep h3 { font-size: 13px; margin: 0 0 8px; color: #8b949e; font-weight: 600; }
  .authstep .row { gap: 8px; }
  .authstep input { flex: 1 1 240px; }
  a.authurl { color: #58a6ff; word-break: break-all; }
  .authstatus { min-height: 20px; margin-top: 6px; color: #8b949e; }
  .authstatus.err { color: #ff7b72; }
  .authstatus.ok { color: #56d364; }
  #login { max-width: 360px; margin: 12vh auto; text-align: center; }
  #login h1 { letter-spacing: 2px; }
  #login .row { justify-content: center; margin-top: 14px; }
  .err { color: #ff7b72; min-height: 20px; margin-top: 10px; }
  pre#log { background: #010409; border: 1px solid #21262d; border-radius: 6px;
    padding: 12px; height: 380px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; margin-top: 12px; }
  .muted { color: #8b949e; }
  /* !important so this utility always wins over later class rules (e.g. .backdrop's
     display:flex) — otherwise "backdrop hidden" would still render visible. */
  .hidden { display: none !important; }
  /* ---- diff modal ---- */
  .backdrop { position: fixed; inset: 0; background: rgba(1,4,9,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
  .dialog { background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
    width: 900px; max-width: 100%; height: 85vh; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden; }
  .dialog-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 12px 16px; border-bottom: 1px solid #21262d; background: #161b22; }
  .dialog-head h2 { font-size: 15px; margin: 0; letter-spacing: .5px; flex: 0 0 auto; }
  .dialog-head .spacer { flex: 1 1 auto; }
  .dialog-head .branch { color: #8b949e; font-size: 12px; }
  .dialog-head .branch code { color: #c9d1d9; }
  .dialog-body { flex: 1 1 auto; overflow: auto; padding: 12px 16px; }
  .diff-banner { background: #3a2d12; color: #d29922; border: 1px solid #9e6a03;
    border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 12px; }
  .diff-state { color: #8b949e; text-align: center; padding: 40px 0; }
  .diff-state.error { color: #ff7b72; }
  .diff-file { border: 1px solid #21262d; border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
  .diff-file-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: #161b22; padding: 8px 10px; cursor: pointer; user-select: none; }
  .diff-file-head:hover { background: #1c2230; }
  .diff-file-head .caret { color: #8b949e; width: 12px; flex: 0 0 auto; }
  .diff-file-head .fpath { word-break: break-all; }
  .diff-file-head .fspacer { flex: 1 1 auto; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; flex: 0 0 auto; }
  .badge.added { background: #133a1b; color: #56d364; }
  .badge.modified { background: #21262d; color: #8b949e; }
  .badge.deleted { background: #4a1d1d; color: #ff7b72; }
  .badge.renamed { background: #1a2c4a; color: #58a6ff; }
  .badge.binary { background: #21262d; color: #8b949e; }
  .stat-add { color: #56d364; font-size: 12px; }
  .stat-del { color: #ff7b72; font-size: 12px; }
  .diff-lines { margin: 0; overflow-x: auto; background: #0d1117; }
  .dl { display: block; white-space: pre; padding: 0 10px; min-width: 100%;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .dl.add { background: rgba(46,160,67,0.18); color: #c9d1d9; }
  .dl.del { background: rgba(248,81,73,0.18); color: #c9d1d9; }
  .dl.hunk { background: #161b22; color: #58a6ff; }
  .dl.meta { color: #8b949e; }
  .dl.ctx { color: #c9d1d9; }
  @media (max-width: 640px) {
    .backdrop { padding: 0; }
    .dialog { width: 100vw; max-width: 100vw; height: 92vh; max-height: 92vh;
      border-radius: 0; border-left: 0; border-right: 0; }
    .dialog-head { padding: 10px 12px; }
    .dialog-body { padding: 10px 12px; }
  }
</style>
</head>
<body>
<div id="login" class="hidden">
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
    <button id="signout" onclick="logout()">Sign out</button>
  </header>
  <main>
    <div id="authBanner" class="hidden"></div>
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

    <div id="diffModal" class="backdrop hidden" role="dialog" aria-modal="true"
         aria-labelledby="diffTitle" tabindex="-1" onclick="diffBackdrop(event)">
      <div class="dialog" onclick="event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="diffTitle">Diff</h2>
          <span class="branch" id="diffBranch"></span>
          <span class="spacer"></span>
          <button onclick="loadDiff()" id="diffRefresh">Refresh</button>
          <button onclick="closeDiff()" aria-label="Close diff">✕</button>
        </div>
        <div class="dialog-body" id="diffBody"></div>
      </div>
    </div>

    <div id="authModal" class="backdrop hidden" role="dialog" aria-modal="true"
         aria-labelledby="authTitle" tabindex="-1" onclick="authBackdrop(event)">
      <div class="dialog" onclick="event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="authTitle">Log in to Claude</h2>
          <span class="spacer"></span>
          <button onclick="closeAuth()" aria-label="Close login">✕</button>
        </div>
        <div class="dialog-body" id="authBody"></div>
      </div>
    </div>
  </main>
</div>

<script>
let es = null;
let pwRequired = true; // set from /api/auth-mode on load; false = passwordless

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
  closeDiff();
  document.getElementById("app").classList.add("hidden");
  // Passwordless mode has nothing to sign out to — re-run the boot decision,
  // which signs back in automatically. (The Sign out button is hidden there.)
  if (pwRequired) document.getElementById("login").classList.remove("hidden");
  else boot();
}

function show() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  // No password means there's nothing meaningful to sign out from.
  document.getElementById("signout").style.display = pwRequired ? "" : "none";
  loadDirs();
  refresh();
  checkAuth();
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
    /^https:\\/\\/(claude\\.com|claude\\.ai|console\\.anthropic\\.com|auth\\.anthropic\\.com|login\\.anthropic\\.com)\\//.test(u);
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
    const diffBtn = document.createElement("button");
    diffBtn.textContent = "Diff";
    diffBtn.setAttribute("aria-label", "View git diff for " + s.name);
    diffBtn.onclick = () => openDiff(s);
    actions.appendChild(diffBtn);
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

// ===== claude account auth (so spawned sessions are authenticated) =====
let authPoll = null; // interval running while the login modal is open

function renderAuthBanner(status) {
  const b = document.getElementById("authBanner");
  b.className = "";
  b.innerHTML = "";
  if (!status) { b.className = "hidden"; return; }
  if (status.loggedIn) {
    b.className = "ok";
    let txt = "Claude: logged in";
    if (status.email) txt += " as " + status.email;
    if (status.subscriptionType) txt += " (" + status.subscriptionType + ")";
    b.appendChild(document.createTextNode(txt));
  } else {
    b.className = "warn";
    const msg = document.createElement("span");
    msg.textContent = "⚠ The Claude account is not logged in — sessions can't run until you authenticate.";
    b.appendChild(msg);
    const sp = document.createElement("span"); sp.className = "spacer"; b.appendChild(sp);
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "Log in to Claude";
    btn.onclick = openAuth;
    b.appendChild(btn);
  }
}

async function checkAuth() {
  try {
    const r = await api("/api/claude-auth");
    if (!r.ok) return null;
    const d = await r.json();
    renderAuthBanner(d.status);
    return d;
  } catch (e) { return null; }
}

function setAuthStatusMsg(cls, msg) {
  const el = document.getElementById("authState");
  if (!el) return;
  el.className = "authstatus" + (cls ? " " + cls : "");
  el.textContent = msg;
}

function renderAuthModal(login) {
  const body = document.getElementById("authBody");
  body.innerHTML = "";

  const s1 = document.createElement("div");
  s1.className = "authstep";
  const h1 = document.createElement("h3");
  h1.textContent = "1. Open this link, sign in, then copy the code";
  s1.appendChild(h1);
  if (login && login.url) {
    const row = document.createElement("div"); row.className = "row";
    const a = document.createElement("a");
    a.className = "authurl"; a.href = login.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "Open the Claude sign-in page";
    row.appendChild(a);
    const copy = document.createElement("button");
    copy.textContent = "Copy link";
    copy.onclick = () => copyText(login.url, copy);
    row.appendChild(copy);
    s1.appendChild(row);
  } else {
    const p = document.createElement("div"); p.className = "muted";
    p.textContent = "Starting login…";
    s1.appendChild(p);
  }
  body.appendChild(s1);

  const s2 = document.createElement("div");
  s2.className = "authstep";
  const h2 = document.createElement("h3");
  h2.textContent = "2. Paste the code here";
  s2.appendChild(h2);
  const row2 = document.createElement("div"); row2.className = "row";
  const input = document.createElement("input");
  input.id = "authCode"; input.placeholder = "authorization code"; input.autocomplete = "off";
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submitCode(); });
  row2.appendChild(input);
  const submit = document.createElement("button");
  submit.className = "primary"; submit.textContent = "Submit"; submit.id = "authSubmit";
  submit.onclick = submitCode;
  row2.appendChild(submit);
  s2.appendChild(row2);
  const st = document.createElement("div");
  st.id = "authState"; st.className = "authstatus";
  s2.appendChild(st);
  body.appendChild(s2);

  if (login && login.phase === "exchanging") setAuthStatusMsg("", "Exchanging code…");
  else if (login && login.phase === "error" && login.error) setAuthStatusMsg("err", login.error);
}

async function openAuth() {
  const modal = document.getElementById("authModal");
  modal.classList.remove("hidden");
  modal.focus();
  renderAuthModal(null);
  try {
    const r = await api("/api/claude-auth/login", { method: "POST" });
    if (r.ok) {
      const login = await r.json();
      renderAuthModal(login);
      if (login.url) { const i = document.getElementById("authCode"); if (i) i.focus(); }
    } else {
      setAuthStatusMsg("err", "Could not start login.");
    }
  } catch (e) { setAuthStatusMsg("err", "Could not start login."); }
  if (authPoll) clearInterval(authPoll);
  authPoll = setInterval(pollAuth, 1500);
}

async function pollAuth() {
  if (document.getElementById("authModal").classList.contains("hidden")) { stopAuthPoll(); return; }
  const d = await checkAuth();
  if (!d) return;
  const login = d.login || {};
  // Fill in the URL once it appears, without clobbering a code being typed.
  if (login.url && !document.querySelector("#authBody a.authurl")) renderAuthModal(login);
  if (d.status && d.status.loggedIn) {
    setAuthStatusMsg("ok", "Logged in! You can close this.");
    stopAuthPoll();
    setTimeout(closeAuth, 1200);
  } else if (login.phase === "error" && login.error) {
    setAuthStatusMsg("err", login.error);
  }
}

function stopAuthPoll() { if (authPoll) { clearInterval(authPoll); authPoll = null; } }

async function submitCode() {
  const input = document.getElementById("authCode");
  if (!input) return;
  const code = input.value.trim();
  if (!code) { setAuthStatusMsg("err", "Enter the code first."); return; }
  const btn = document.getElementById("authSubmit");
  if (btn) btn.disabled = true;
  setAuthStatusMsg("", "Submitting code…");
  try {
    const r = await api("/api/claude-auth/code", { method: "POST", body: JSON.stringify({ code: code }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      setAuthStatusMsg("ok", "Logged in!");
      stopAuthPoll();
      await checkAuth();
      setTimeout(() => { closeAuth(); refresh(); }, 1000);
    } else {
      setAuthStatusMsg("err", (d && d.error) ? d.error : "Login failed — try again.");
    }
  } catch (e) {
    setAuthStatusMsg("err", "Network error submitting code.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closeAuth() {
  stopAuthPoll();
  const modal = document.getElementById("authModal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  document.getElementById("authBody").innerHTML = "";
  // Abort an unfinished login so a stale PTY process doesn't linger (a completed
  // login is already done — this just clears its state).
  api("/api/claude-auth/login", { method: "DELETE" }).catch(() => {});
  checkAuth();
}

function authBackdrop(ev) {
  if (ev.target && ev.target.id === "authModal") closeAuth();
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

// ===== diff modal =====
let diffSession = null;       // the session whose diff is open
let diffLastFocus = null;     // element to restore focus to on close

function openDiff(s) {
  diffSession = s;
  diffLastFocus = document.activeElement;
  const modal = document.getElementById("diffModal");
  document.getElementById("diffTitle").textContent = "Diff — " + s.name;
  document.getElementById("diffBranch").textContent = "";
  modal.classList.remove("hidden");
  modal.focus();
  loadDiff();
}

function closeDiff() {
  const modal = document.getElementById("diffModal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  diffSession = null;
  document.getElementById("diffBody").innerHTML = "";
  document.getElementById("diffBranch").textContent = "";
  if (diffLastFocus && diffLastFocus.focus) diffLastFocus.focus();
  diffLastFocus = null;
}

function diffBackdrop(ev) {
  // Close only when the click is on the backdrop itself, not a bubbled child.
  if (ev.target && ev.target.id === "diffModal") closeDiff();
}

function setDiffState(cls, msg) {
  const body = document.getElementById("diffBody");
  body.innerHTML = "";
  const d = document.createElement("div");
  d.className = "diff-state" + (cls ? " " + cls : "");
  d.textContent = msg;
  body.appendChild(d);
}

async function loadDiff() {
  if (!diffSession) return;
  const id = diffSession.id;
  // A request is stale once the modal was closed or a different session opened
  // while it was in flight; stale results must not touch the DOM or log out.
  const stale = () => !diffSession || diffSession.id !== id;
  const btn = document.getElementById("diffRefresh");
  btn.disabled = true;
  setDiffState("", "Loading diff…");
  try {
    const r = await api("/api/sessions/" + id + "/diff");
    if (stale()) return;
    if (r.status === 401) { closeDiff(); return logout(); }
    if (!r.ok) { setDiffState("error", "Failed to load diff (HTTP " + r.status + ")"); return; }
    const data = await r.json();
    if (stale()) return;
    renderDiff(data);
  } catch (e) {
    if (!stale()) setDiffState("error", "Network error loading diff.");
  } finally {
    if (!stale()) btn.disabled = false;
  }
}

function renderDiff(data) {
  const body = document.getElementById("diffBody");
  body.innerHTML = "";

  const branchEl = document.getElementById("diffBranch");
  branchEl.textContent = "";
  if (data && data.isRepo && data.branch) {
    branchEl.appendChild(document.createTextNode("on "));
    const code = document.createElement("code");
    code.textContent = data.branch;
    branchEl.appendChild(code);
  }

  if (!data || data.error) {
    setDiffState("error", (data && data.error) ? data.error : "Unknown error.");
    return;
  }
  if (!data.isRepo) { setDiffState("", "Not a git repository."); return; }
  if (data.empty || !data.diff || !data.diff.trim()) { setDiffState("", "No changes."); return; }

  if (data.truncated) {
    const banner = document.createElement("div");
    banner.className = "diff-banner";
    banner.textContent = "Diff was truncated by the server (output too large). " +
      "Showing the first portion only.";
    body.appendChild(banner);
  }

  const files = parseDiff(data.diff);
  if (!files.length) {
    // No recognizable file headers — render the raw text safely via textContent.
    const pre = document.createElement("pre");
    pre.className = "diff-lines";
    const line = document.createElement("code");
    line.className = "dl ctx";
    line.textContent = data.diff;
    pre.appendChild(line);
    body.appendChild(pre);
    return;
  }
  for (const f of files) body.appendChild(renderFile(f));
}

// Parse unified git-diff text into files -> lines. Tracks in-hunk state so a
// content line like a deleted SQL comment ("-- foo" -> diff line "--- foo") is
// classified as a deletion, not mistaken for a "---" file header.
//   file: { path, oldPath, status, binary, adds, dels, inHunk, lines }
//   line.type in "add" | "del" | "hunk" | "ctx" | "meta"
function parseDiff(text) {
  const files = [];
  let cur = null;
  const lines = text.split("\\n");
  const push = (type, t) => { if (cur) cur.lines.push({ type: type, text: t }); };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (ln.indexOf("diff --git ") === 0) {
      cur = { path: "", oldPath: "", status: "modified", binary: false,
              adds: 0, dels: 0, inHunk: false, lines: [] };
      files.push(cur);
      const m = ln.match(/^diff --git a\\/(.*) b\\/(.*)$/);
      if (m) { cur.oldPath = m[1]; cur.path = m[2]; }
      push("meta", ln);
      continue;
    }
    if (!cur) continue; // preamble before the first header (shouldn't happen)

    if (ln.indexOf("@@") === 0) { cur.inHunk = true; push("hunk", ln); continue; }

    if (cur.inHunk) {
      // Inside a hunk body: classify strictly by the leading marker char.
      const c = ln.charAt(0);
      if (c === "+") { cur.adds++; push("add", ln); }
      else if (c === "-") { cur.dels++; push("del", ln); }
      else if (ln.indexOf("\\\\ No newline") === 0) push("meta", ln);
      else push("ctx", ln);
      continue;
    }

    // Pre-hunk header lines.
    if (ln.indexOf("new file") === 0) { cur.status = "added"; push("meta", ln); continue; }
    if (ln.indexOf("deleted file") === 0) { cur.status = "deleted"; push("meta", ln); continue; }
    if (ln.indexOf("rename from ") === 0) {
      cur.status = "renamed"; cur.oldPath = ln.slice("rename from ".length); push("meta", ln); continue;
    }
    if (ln.indexOf("rename to ") === 0) {
      cur.status = "renamed"; cur.path = ln.slice("rename to ".length); push("meta", ln); continue;
    }
    if (ln.indexOf("Binary files ") === 0) { cur.binary = true; push("meta", ln); continue; }
    if (ln.indexOf("--- ") === 0) {
      const p = ln.slice(4);
      if (!cur.oldPath && p !== "/dev/null") cur.oldPath = p.replace(/^a\\//, "");
      push("meta", ln); continue;
    }
    if (ln.indexOf("+++ ") === 0) {
      const p = ln.slice(4);
      if (!cur.path && p !== "/dev/null") cur.path = p.replace(/^b\\//, "");
      push("meta", ln); continue;
    }
    // index / old mode / new mode / similarity / copy from|to / etc.
    push("meta", ln);
  }
  return files;
}

function renderFile(f) {
  const wrap = document.createElement("div");
  wrap.className = "diff-file";

  const head = document.createElement("div");
  head.className = "diff-file-head";

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  head.appendChild(caret);

  const path = document.createElement("span");
  path.className = "fpath";
  if (f.status === "renamed" && f.oldPath && f.oldPath !== f.path) {
    path.textContent = f.oldPath + " → " + f.path;
  } else {
    path.textContent = f.path || f.oldPath || "(unknown)";
  }
  head.appendChild(path);

  const badge = document.createElement("span");
  const st = f.binary ? "binary" : f.status;
  badge.className = "badge " + st;
  badge.textContent = st;
  head.appendChild(badge);

  const spacer = document.createElement("span");
  spacer.className = "fspacer";
  head.appendChild(spacer);

  if (!f.binary) {
    const add = document.createElement("span");
    add.className = "stat-add";
    add.textContent = "+" + f.adds;
    head.appendChild(add);
    const del = document.createElement("span");
    del.className = "stat-del";
    del.textContent = "-" + f.dels;
    head.appendChild(del);
  }

  const pre = document.createElement("pre");
  pre.className = "diff-lines";

  if (f.binary) {
    const line = document.createElement("code");
    line.className = "dl meta";
    line.textContent = "Binary file not shown.";
    pre.appendChild(line);
  } else {
    for (const l of f.lines) {
      const line = document.createElement("code");
      line.className = "dl " + l.type;
      // CRITICAL: textContent only — diff text/filenames are attacker-influenced.
      line.textContent = l.text.length ? l.text : " ";
      pre.appendChild(line);
    }
  }

  head.onclick = () => {
    const hidden = pre.classList.toggle("hidden");
    caret.textContent = hidden ? "▸" : "▾";
  };

  wrap.appendChild(head);
  wrap.appendChild(pre);
  return wrap;
}

document.getElementById("pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("authModal").classList.contains("hidden")) { closeAuth(); return; }
  if (!document.getElementById("diffModal").classList.contains("hidden")) closeDiff();
});

setInterval(() => {
  // Don't rebuild the session table while a modal is open — it would detach the
  // row's buttons (breaking focus-restore on close) and churn the page behind the
  // modal. The next tick after closing refreshes.
  if (document.getElementById("app").classList.contains("hidden")) return;
  if (!document.getElementById("diffModal").classList.contains("hidden")) return;
  if (!document.getElementById("authModal").classList.contains("hidden")) return;
  refresh();
}, 3000);

// Refresh the Claude-auth banner periodically (a process spawn, so kept slow). The
// login modal does its own faster polling while open.
setInterval(() => {
  if (document.getElementById("app").classList.contains("hidden")) return;
  if (!document.getElementById("authModal").classList.contains("hidden")) return;
  checkAuth();
}, 30000);

// Decide which view to show: already authed → app; passwordless → auto sign-in;
// otherwise reveal the login form.
async function boot() {
  const r = await api("/api/me");
  if (r.ok) return show();
  try {
    const m = await api("/api/auth-mode");
    if (m.ok) pwRequired = (await m.json()).passwordRequired !== false;
  } catch (e) { /* default to requiring a password if the probe fails */ }
  if (!pwRequired) {
    const lr = await api("/api/login", { method: "POST", body: JSON.stringify({}) });
    if (lr.ok) return show();
  }
  document.getElementById("login").classList.remove("hidden");
}
boot();
</script>
</body>
</html>`;
