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
  body { margin: 0; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0d1117; color: #c9d1d9; }
  header { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; border-bottom: 1px solid #21262d; }
  header h1 { font-size: 18px; margin: 0; letter-spacing: 1px; }
  button { font: inherit; cursor: pointer; border: 1px solid #30363d; background: #21262d;
    color: #c9d1d9; padding: 6px 12px; border-radius: 6px; }
  button:hover { background: #30363d; }
  button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  button.danger { background: #6e2222; border-color: #b62324; color: #fff; }
  main { padding: 24px 28px; max-width: 1280px; margin: 0 auto; }
  select, input { font: inherit; background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; }
  /* Checkboxes must NOT inherit the text-input box styling above (padding/border
     would bloat them) nor the .authstep flex-stretch below — keep them small and
     left of their label. */
  input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin: 0;
    padding: 0; border: 0; background: none; border-radius: 0; accent-color: #2ea043; cursor: pointer; }
  /* A checkbox + its label on one line. Do NOT use the generic .row here: its
     flex-wrap:wrap drops a long label onto its own line (and away from the box).
     The box stays fixed at the left; the label takes the remaining width and wraps
     its own text. */
  .checkline { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; cursor: pointer; }
  .checkline > span { flex: 1 1 auto; min-width: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  /* The rows are deliberately no-wrap (name/actions stay on one line), so the table
     has a hard min-width. Scroll it INSIDE this wrapper at every width so an
     overflowing table never makes the whole page body scroll horizontally. */
  .table-wrap { overflow-x: auto; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .pill { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .running { background: #133a1b; color: #56d364; }
  .exited { background: #21262d; color: #8b949e; }
  .failed { background: #4a1d1d; color: #ff7b72; }
  .booting { background: #3a2d12; color: #d29922; }
  /* interaction-state pills (shown while running) */
  .ready { background: #133a1b; color: #56d364; }
  .thinking { background: #3a2d12; color: #d29922; }
  .completed { background: #12253a; color: #58a6ff; }
  /* far-left process-status dot */
  .dotcell { width: 16px; padding-right: 0; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; }
  .dot-running { background: #2ea043; }
  .dot-booting, .dot-terminating { background: #d29922; }
  .dot-failed { background: #f85149; }
  .dot-exited { background: transparent; border: 1px solid #6e7681; }
  .toktag { color: #8b949e; font-size: 12px; margin-left: 6px; }
  /* Keep rows from wrapping: name on one line, long dir paths ellipsize (full path
     in the title tooltip + Details), and the action buttons stay on a single
     right-aligned line in a shrink-to-fit column. */
  .nmcell { white-space: nowrap; }
  .dpath { display: block; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.actions { width: 1%; }
  /* Buttons go in an inner flex row so the <td> stays a real table-cell and
     contributes its full width to the table — an overflowing row then scrolls
     inside .table-wrap instead of the buttons overlapping the neighbouring
     columns. Do NOT make the <td> itself display:flex (that drops it out of the
     table layout, so it no longer reserves width) and do NOT add .row here (its
     flex-wrap:wrap would stack the buttons into a squished vertical column). */
  .actbtns { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; justify-content: flex-end; }
  .actbtns > * { flex: 0 0 auto; white-space: nowrap; }
  .actbtns button { padding: 5px 9px; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
  .kv dt { color: #8b949e; }
  .kv dd { margin: 0; color: #c9d1d9; word-break: break-word; }
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
    table { white-space: nowrap; } /* single-line rows; .table-wrap handles the scroll */
  }
  /* ---- add-directory file browser ---- */
  .fs-list { border: 1px solid #21262d; border-radius: 6px; max-height: 42vh; overflow: auto; }
  .fs-entry { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-bottom: 1px solid #161b22; }
  .fs-entry:last-child { border-bottom: 0; }
  .fs-entry.nav { cursor: pointer; }
  .fs-entry.nav:hover { background: #161b22; }
  .fs-entry .ico { color: #8b949e; flex: 0 0 auto; }
  .fs-entry .tag { margin-left: auto; font-size: 11px; color: #8b949e; }
  #addName { flex: 1 1 240px; }
  .local { font-size: 11px; color: #8b949e; padding: 1px 7px; border: 1px solid #30363d;
    border-radius: 10px; margin-left: 6px; }
  /* ---- claude account auth banner + login modal ---- */
  #authBanner { margin: 0 0 12px; }
  #authBanner.warn { background: #3a2d12; color: #d29922; border: 1px solid #9e6a03;
    border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  #authBanner.ok { color: #8b949e; font-size: 12px; padding: 2px 0;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  #authBanner .spacer { flex: 1 1 auto; }
  .authstep { margin: 0 0 18px; }
  .authstep h3 { font-size: 13px; margin: 0 0 8px; color: #8b949e; font-weight: 600; }
  .authstep .row { gap: 8px; }
  .authstep input:not([type="checkbox"]) { flex: 1 1 240px; }
  a.authurl { color: #58a6ff; word-break: break-all; }
  .authstatus { min-height: 20px; margin-top: 6px; color: #8b949e; }
  .authstatus.err { color: #ff7b72; }
  .authstatus.ok { color: #56d364; }
  /* ---- claude plan-usage panel ---- */
  #usagePanel { margin: 0 0 14px; border: 1px solid #21262d; border-radius: 8px;
    padding: 10px 14px; background: #0f141b; }
  #usagePanel .uhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 6px;
    cursor: pointer; user-select: none; }
  #usagePanel .uhead .caret { color: #8b949e; flex: 0 0 auto; }
  #usagePanel .utitle { color: #8b949e; font-weight: 600; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
  #usagePanel .unote { color: #8b949e; font-size: 11px; }
  #usagePanel .unote.stale { color: #d29922; }
  .usage-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; }
  .usage-row .usage-label { flex: 0 0 132px; color: #c9d1d9; }
  .usagebar { flex: 1 1 120px; background: #21262d; border-radius: 6px; height: 8px; overflow: hidden; }
  .usagefill { height: 100%; width: 0; border-radius: 6px; background: #2ea043; transition: width .4s ease; }
  .usagefill.warn { background: #d29922; }
  .usagefill.crit { background: #f85149; }
  .usage-pct { flex: 0 0 auto; min-width: 42px; text-align: right; color: #c9d1d9; font-variant-numeric: tabular-nums; }
  .usage-reset { flex: 0 0 130px; text-align: right; color: #8b949e; font-size: 12px; }
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
  .diff-dir { margin-bottom: 18px; }
  .diff-dir-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin: 4px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #21262d; }
  .diff-dir-path { color: #d2a8ff; font-weight: 600; word-break: break-all; }
  .diff-dir-head .branch { font-size: 12px; }
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
    <div id="usagePanel" class="hidden"></div>
    <div class="row">
      <select id="preset"></select>
      <button class="primary" onclick="startSession()">Start session</button>
      <span class="muted" id="startErr"></span>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr><th></th><th>Session</th><th>Directory</th><th>Status</th><th>Started</th><th></th></tr>
        </thead>
        <tbody id="sessions"></tbody>
      </table>
    </div>

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

    <div id="detailsModal" class="backdrop hidden" role="dialog" aria-modal="true"
         aria-labelledby="detailsTitle" tabindex="-1" onclick="detailsBackdrop(event)">
      <div class="dialog" onclick="event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="detailsTitle">Details</h2>
          <span class="spacer"></span>
          <button onclick="closeDetails()" aria-label="Close details">✕</button>
        </div>
        <div class="dialog-body"><dl class="kv" id="detailsBody"></dl></div>
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

    <div id="commitModal" class="backdrop hidden" role="dialog" aria-modal="true"
         aria-labelledby="commitTitle" tabindex="-1" onclick="commitBackdrop(event)">
      <div class="dialog" onclick="event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="commitTitle">Commit &amp; Push</h2>
          <span class="spacer"></span>
          <button onclick="closeCommit()" aria-label="Close">✕</button>
        </div>
        <div class="dialog-body">
          <div class="authstep">
            <div class="meta" id="commitBranchNote" style="margin-bottom:8px"></div>
            <h3>Commit message</h3>
            <textarea id="commitMsg" rows="4" placeholder="Subject line&#10;&#10;Optional body"
                      autocomplete="off" style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
            <div class="meta" id="commitSuggestNote" style="display:none;margin-top:4px"></div>
            <h3 style="margin-top:12px">YubiKey PIN</h3>
            <input id="commitPin" type="password" placeholder="OpenPGP card PIN"
                   autocomplete="off" style="width:100%;box-sizing:border-box" />
            <label id="commitPushRow" class="checkline" style="margin-top:10px">
              <input id="commitPush" type="checkbox" /> <span class="muted">Push after committing</span>
            </label>
            <label id="commitAllRow" class="checkline" style="margin-top:10px;display:none">
              <input id="commitAll" type="checkbox" /> <span class="muted" id="commitAllLabel">Apply to all directories in this preset</span>
            </label>
            <div class="row" style="margin-top:12px">
              <button class="primary" id="commitSubmit" onclick="submitCommit()">Commit &amp; Push</button>
            </div>
            <div class="authstatus" id="commitState"></div>
          </div>
        </div>
      </div>
    </div>

    <div id="messageModal" class="backdrop hidden" role="dialog" aria-modal="true"
         aria-labelledby="messageTitle" tabindex="-1" onclick="messageBackdrop(event)">
      <div class="dialog" onclick="event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="messageTitle">Send message</h2>
          <span class="spacer"></span>
          <button onclick="closeMessage()" aria-label="Close">✕</button>
        </div>
        <div class="dialog-body">
          <div class="authstep">
            <div class="meta" style="margin-bottom:8px">Typed into the session's Claude Code prompt and submitted (Enter). For a full back-and-forth, drive the session from Remote Control on claude.ai.</div>
            <h3>Message</h3>
            <textarea id="messageText" rows="4" placeholder="Type a message to the session…"
                      autocomplete="off" style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
            <div class="row" style="margin-top:12px">
              <button class="primary" id="messageSend" onclick="submitMessage()">Send</button>
              <span class="muted">Ctrl+Enter to send</span>
            </div>
            <div class="authstatus" id="messageState"></div>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
let es = null;
let pwRequired = true; // set from /api/auth-mode on load; false = passwordless
let usagePoll = null;          // interval re-fetching the cached usage snapshot
let usageTick = null;          // 1s interval re-rendering reset countdowns locally
let usageResetEls = [];        // [{ el, resetsAt }] countdown spans the tick updates
let usageCollapsed = loadUsageCollapsed(); // panel collapse state; survives the 20s re-render + reloads

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
  stopUsage();
  closeLog();
  closeDiff();
  closeCommit();
  closeDetails();
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
  loadPresets();
  refresh();
  checkAuth();
  startUsage();
}

async function loadPresets() {
  const r = await api("/api/presets");
  if (!r.ok) return;
  const { presets } = await r.json();
  const sel = document.getElementById("preset");
  sel.innerHTML = "";
  if (!presets || !presets.length) {
    const o = document.createElement("option");
    o.textContent = "(no presets — set programs.vibe.presets)";
    o.disabled = true;
    sel.appendChild(o);
    return;
  }
  for (const p of presets) {
    const o = document.createElement("option");
    o.value = p.name;
    const dirs = p.directories || [];
    const extra = dirs.length > 1 ? "  (+" + (dirs.length - 1) + " dir" + (dirs.length > 2 ? "s" : "") + ")" : "";
    o.textContent = p.name + "  —  " + (dirs[0] || "?") + extra + (p.branch ? "  [" + p.branch + "]" : "");
    sel.appendChild(o);
  }
}

async function startSession() {
  const preset = document.getElementById("preset").value;
  if (!preset) return;
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ preset }) });
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
  if (s.status === "running" || s.status === "terminating" || s.status === "booting") return "  (" + fmtDur(Date.now() - s.startedAt) + ")";
  if (s.exitedAt) return "  (ran " + fmtDur(s.exitedAt - s.startedAt) + ")";
  return "";
}

function fmtTokens(n) {
  if (typeof n !== "number" || !(n > 0)) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
  return String(n);
}

// process status → far-left dot class; whitelist so only known classes are emitted.
const DOT_CLASSES = { running: 1, booting: 1, terminating: 1, failed: 1, exited: 1 };
const STATE_CLASSES = { ready: 1, thinking: 1, completed: 1 };

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
  const data = await r.json();
  const sessions = data.sessions || [];
  // Each session carries its own canCommit/canPush/commitBranch (per its preset).
  const tb = document.getElementById("sessions");
  tb.innerHTML = "";
  if (!sessions.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="muted">No sessions yet.</td>';
    tb.appendChild(tr);
  }
  for (const s of sessions) {
    const tr = document.createElement("tr");
    const code = (s.exitCode === undefined || s.exitCode === null) ? "" : " (" + s.exitCode + ")";
    // Far-left dot = process status; the Status cell = interaction state while
    // running (ready/thinking/completed), else the process status word.
    const dotClass = "dot-" + (DOT_CLASSES[s.status] ? s.status : "exited");
    const running = s.status === "running";
    const state = running && STATE_CLASSES[s.state] ? s.state : null;
    const pillClass = state ? state : s.status;
    const pillText = state ? state : (s.status + code);
    const tok = fmtTokens(s.tokens);
    const tokTag = tok ? '<span class="toktag">' + tok + ' tok</span>' : '';
    tr.innerHTML =
      '<td class="dotcell"><span class="dot ' + dotClass + '" title="' + s.status + '"></span></td>' +
      '<td class="nmcell"></td>' +
      '<td class="muted dircell"></td>' +
      '<td><span class="pill ' + pillClass + '">' + pillText + '</span>' + tokTag + '</td>' +
      '<td class="muted">' + fmtTime(s.startedAt) + uptimeStr(s) + '</td>' +
      '<td class="actions"><div class="actbtns"></div></td>';
    // CRITICAL: s.path is attacker-influenced for external (self-registered)
    // sessions, so set it via textContent / the .title property — never interpolate
    // it into innerHTML. The span ellipsizes long paths; the title shows the full one.
    const dpath = document.createElement("span");
    dpath.className = "dpath";
    dpath.textContent = s.path;
    dpath.title = s.path;
    tr.querySelector(".dircell").appendChild(dpath);
    const nm = tr.querySelector(".nmcell");
    nm.appendChild(document.createTextNode(s.name + " "));
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "⧉";
    copyBtn.title = "Copy session name";
    copyBtn.setAttribute("aria-label", "Copy session name " + s.name);
    copyBtn.onclick = () => copyText(s.name, copyBtn);
    nm.appendChild(copyBtn);
    if (s.external) {
      const tag = document.createElement("span");
      tag.className = "local";
      tag.textContent = "local";
      tag.title = "Started by hand on the server; managed from its own terminal / claude.ai";
      nm.appendChild(tag);
    }
    const actions = tr.querySelector(".actbtns");
    if (safeLoginUrl(s.loginUrl)) {
      const a = document.createElement("a");
      a.href = s.loginUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "loginlink";
      a.textContent = "🔑 Log in";
      actions.appendChild(a);
    }
    // External sessions have no server-captured log (output is in the user's
    // terminal) and aren't killed from here — show only Diff for them.
    if (!s.external) {
      const logsBtn = document.createElement("button");
      logsBtn.textContent = "Logs";
      logsBtn.onclick = () => openLog(s);
      actions.appendChild(logsBtn);
    }
    const diffBtn = document.createElement("button");
    diffBtn.textContent = "Diff";
    diffBtn.setAttribute("aria-label", "View git diff for " + s.name);
    diffBtn.onclick = () => openDiff(s);
    actions.appendChild(diffBtn);
    const detBtn = document.createElement("button");
    detBtn.textContent = "Details";
    detBtn.setAttribute("aria-label", "Session details for " + s.name);
    detBtn.onclick = () => openDetails(s);
    actions.appendChild(detBtn);
    // Type a message into the session's prompt — only for running, server-owned PTY
    // sessions (the server re-checks; the route is the real gate).
    if (s.canInput) {
      const msgBtn = document.createElement("button");
      msgBtn.textContent = "Message";
      msgBtn.setAttribute("aria-label", "Send a message to " + s.name);
      msgBtn.onclick = () => openMessage(s);
      actions.appendChild(msgBtn);
    }
    // Commit & Push — only on running, server-owned sessions, only when the
    // feature is enabled and commit isn't touch-gated (server re-checks anyway).
    if (s.canCommit && s.status === "running" && !s.external) {
      const cpBtn = document.createElement("button");
      cpBtn.className = "primary";
      cpBtn.textContent = s.canPush ? "Commit & Push" : "Commit";
      cpBtn.setAttribute("aria-label", "Commit" + (s.canPush ? " and push" : "") + " " + s.name);
      cpBtn.onclick = () => openCommit(s);
      actions.appendChild(cpBtn);
    }
    if (s.status === "running" && !s.external) {
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
    // Steady state for the server is "logged in", so this is the only way to
    // switch/refresh the account from the UI. The server logs the current account
    // out before starting the login, so it always presents a fresh OAuth link to
    // sign in as a different account (an already-signed-in claude auth login
    // otherwise exits with no URL).
    const sp = document.createElement("span"); sp.className = "spacer"; b.appendChild(sp);
    const relog = document.createElement("button");
    relog.textContent = "Log in as a different account";
    relog.setAttribute("aria-label", "Log in to Claude as a different account");
    relog.onclick = openAuth;
    b.appendChild(relog);
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
      // Each running claude reads its credentials at startup, so a login taken
      // now reaches only NEWLY spawned sessions — surface that so a switched
      // account doesn't look like it "didn't take effect".
      setAuthStatusMsg("ok", "Logged in! Restart any running sessions to use this account.");
      stopAuthPoll();
      await checkAuth();
      setTimeout(() => { closeAuth(); refresh(); }, 1600);
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

// ===== claude plan-usage panel =====
// The server caches/throttles the actual endpoint; the browser just polls that
// cache (cheap) and ticks the reset countdowns locally each second.

function usageFillClass(pct) {
  if (pct >= 90) return "usagefill crit";
  if (pct >= 75) return "usagefill warn";
  return "usagefill";
}

function fmtUntil(ms) {
  const d = ms - Date.now();
  if (!(d > 0)) return "resets now";
  const s = Math.floor(d / 1000);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days) return "resets in " + days + "d " + h + "h";
  if (h) return "resets in " + h + "h " + m + "m";
  if (m) return "resets in " + m + "m";
  return "resets in <1m";
}

function fmtAgo(ms) {
  if (typeof ms !== "number") return "just now";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}

function loadUsageCollapsed() {
  try { return localStorage.getItem("vibe.usageCollapsed") === "1"; } catch (_) { return false; }
}

function saveUsageCollapsed(v) {
  try { localStorage.setItem("vibe.usageCollapsed", v ? "1" : "0"); } catch (_) { /* private mode, etc. */ }
}

function applyUsageCollapsed(body, caret) {
  if (usageCollapsed) { body.classList.add("hidden"); caret.textContent = "▸"; }
  else { body.classList.remove("hidden"); caret.textContent = "▾"; }
}

function renderUsage(state) {
  const panel = document.getElementById("usagePanel");
  usageResetEls = [];
  if (!state || !state.enabled) { panel.className = "hidden"; panel.innerHTML = ""; return; }
  panel.className = "";
  panel.innerHTML = "";

  const head = document.createElement("div");
  head.className = "uhead";
  const caret = document.createElement("span");
  caret.className = "caret";
  head.appendChild(caret);
  const title = document.createElement("span");
  title.className = "utitle";
  title.textContent = "Claude usage" + (state.subscriptionType ? " · " + state.subscriptionType : "");
  head.appendChild(title);
  const note = document.createElement("span");
  note.className = "unote" + (state.stale ? " stale" : "");
  const wins = (state.snapshot && state.snapshot.windows) || [];
  if (state.stale) note.textContent = (state.error || "showing last known") + " · " + fmtAgo(state.fetchedAt);
  else if (!state.available && state.error) note.textContent = state.error;
  else if (state.fetchedAt) note.textContent = "updated " + fmtAgo(state.fetchedAt);
  head.appendChild(note);
  panel.appendChild(head);

  // Body holds the bars; the head toggles it. Collapse state lives in the module
  // var (this whole panel is rebuilt every poll, so a DOM-only toggle would reset).
  const body = document.createElement("div");
  body.className = "ubody";
  panel.appendChild(body);
  head.onclick = () => {
    usageCollapsed = !usageCollapsed;
    saveUsageCollapsed(usageCollapsed);
    applyUsageCollapsed(body, caret);
  };
  applyUsageCollapsed(body, caret);

  if (!wins.length) {
    if (state.available || !state.error) {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = "No usage data yet.";
      body.appendChild(p);
    }
    return;
  }

  for (const w of wins) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const label = document.createElement("span");
    label.className = "usage-label";
    label.textContent = w.label;
    const bar = document.createElement("div");
    bar.className = "usagebar";
    const fill = document.createElement("div");
    const pct = Math.max(0, Math.min(100, Number(w.utilization) || 0));
    fill.className = usageFillClass(pct);
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    const pctEl = document.createElement("span");
    pctEl.className = "usage-pct";
    pctEl.textContent = Math.round(pct) + "%";
    const reset = document.createElement("span");
    reset.className = "usage-reset";
    if (typeof w.resetsAt === "number") {
      reset.textContent = fmtUntil(w.resetsAt);
      usageResetEls.push({ el: reset, resetsAt: w.resetsAt });
    }
    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(pctEl);
    row.appendChild(reset);
    body.appendChild(row);
  }
}

function tickUsage() {
  for (const r of usageResetEls) r.el.textContent = fmtUntil(r.resetsAt);
}

async function checkUsage() {
  try {
    const r = await api("/api/usage");
    if (r.status === 401) return logout();
    if (!r.ok) return;
    const state = await r.json();
    renderUsage(state);
    if (state && state.enabled === false) stopUsage(); // disabled server-side — stop polling
  } catch (e) { /* transient; the next tick retries */ }
}

function startUsage() {
  checkUsage();
  if (!usagePoll) {
    usagePoll = setInterval(() => {
      if (!document.getElementById("app").classList.contains("hidden")) checkUsage();
    }, 20000);
  }
  if (!usageTick) usageTick = setInterval(tickUsage, 1000);
}

function stopUsage() {
  if (usagePoll) { clearInterval(usagePoll); usagePoll = null; }
  if (usageTick) { clearInterval(usageTick); usageTick = null; }
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
  meta.appendChild(document.createTextNode(" · "));
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = "live session log";
  meta.appendChild(note);
  const pre = document.getElementById("log");
  pre.textContent = "Connecting…";
  es = new EventSource("/api/sessions/" + s.id + "/logs");
  es.onopen = () => { if (pre.textContent === "Connecting…") pre.textContent = "Connected — waiting for output…"; };
  // Each event is a full snapshot of the session log (Claude's complete JSONL
  // transcript when available, otherwise the rendered terminal screen) — REPLACE the
  // view, don't append. Only re-pin to the bottom if the user was already there, so
  // scrolling up to read earlier output isn't yanked back down on every snapshot.
  es.onmessage = (ev) => {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = ev.data;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
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

// ===== details modal =====
let detailsLastFocus = null;

// Append a key/value row. Values go through textContent (s.path/command are
// attacker-influenced for external sessions — never innerHTML).
function detailRow(dl, label, value, mono) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (mono) {
    const c = document.createElement("code");
    c.textContent = value;
    dd.appendChild(c);
  } else {
    dd.textContent = value;
  }
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function openDetails(s) {
  detailsLastFocus = document.activeElement;
  const modal = document.getElementById("detailsModal");
  document.getElementById("detailsTitle").textContent = "Details — " + s.name;
  const dl = document.getElementById("detailsBody");
  dl.innerHTML = "";
  if (s.preset) detailRow(dl, "Preset", s.preset);
  const code = (s.exitCode === undefined || s.exitCode === null) ? "" : " (exit " + s.exitCode + ")";
  detailRow(dl, "Status", s.status + code);
  detailRow(dl, "State", s.status === "running" ? (s.state || "ready") : "—");
  const tok = fmtTokens(s.tokens);
  detailRow(dl, "Tokens", tok ? tok + " tok" : "—");
  if (s.model) detailRow(dl, "Model", s.model);
  if (s.effort) detailRow(dl, "Effort", s.effort);
  detailRow(dl, "Directory", s.path, true);
  const extra = (s.directories || []).filter((d) => d !== s.path);
  for (const d of extra) detailRow(dl, "+ dir", d, true);
  if (s.commitBranch) detailRow(dl, "Branch", s.commitBranch);
  detailRow(dl, "Created", new Date(s.startedAt).toLocaleString());
  detailRow(dl, "PID", String(s.pid));
  if (s.command) detailRow(dl, "Command", s.command, true);
  modal.classList.remove("hidden");
  modal.focus();
}

function closeDetails() {
  const modal = document.getElementById("detailsModal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  if (detailsLastFocus && detailsLastFocus.focus) detailsLastFocus.focus();
  detailsLastFocus = null;
}

function detailsBackdrop(ev) { if (ev.target && ev.target.id === "detailsModal") closeDetails(); }

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

  const dirs = (data && Array.isArray(data.dirs)) ? data.dirs : [];
  // A hard server error with no per-directory results at all.
  if (data && data.error && !dirs.length) { setDiffState("error", data.error); return; }
  if (!dirs.length) { setDiffState("", "No changes."); return; }

  // One directory on a branch → show the branch in the modal header (the common
  // case). With several dirs, each section carries its own path + branch label.
  if (dirs.length === 1 && dirs[0].isRepo && dirs[0].branch) {
    branchEl.appendChild(document.createTextNode("on "));
    const code = document.createElement("code");
    code.textContent = dirs[0].branch;
    branchEl.appendChild(code);
  }

  if (data.truncated) {
    const banner = document.createElement("div");
    banner.className = "diff-banner";
    banner.textContent = "Diff was truncated by the server (output too large). " +
      "Showing the first portion only.";
    body.appendChild(banner);
  }

  // Label each directory only when the session spans more than one.
  const multi = dirs.length > 1;
  for (const d of dirs) body.appendChild(renderDiffDir(d, multi));
}

// Render one directory's diff as a section: an optional path header (+ its branch),
// then either its file cards or a single state line (no-changes / not-a-repo / error).
function renderDiffDir(d, withHeader) {
  const section = document.createElement("div");
  section.className = "diff-dir";

  if (withHeader) {
    const head = document.createElement("div");
    head.className = "diff-dir-head";
    const p = document.createElement("code");
    p.className = "diff-dir-path";
    p.textContent = d.path;             // textContent: path is config-derived but never trusted as HTML
    head.appendChild(p);
    if (d.isRepo && d.branch) {
      const b = document.createElement("span");
      b.className = "branch";
      b.appendChild(document.createTextNode("on "));
      const code = document.createElement("code");
      code.textContent = d.branch;
      b.appendChild(code);
      head.appendChild(b);
    }
    section.appendChild(head);
  }

  const stateLine = (cls, msg) => {
    const el = document.createElement("div");
    el.className = "diff-state" + (cls ? " " + cls : "");
    el.textContent = msg;
    section.appendChild(el);
  };

  if (d.error) { stateLine("error", d.error); return section; }
  if (!d.isRepo) { stateLine("", "Not a git repository."); return section; }
  if (d.empty || !d.diff || !d.diff.trim()) { stateLine("", "No changes."); return section; }

  const files = parseDiff(d.diff);
  if (!files.length) {
    // No recognizable file headers — render the raw text safely via textContent.
    const pre = document.createElement("pre");
    pre.className = "diff-lines";
    const line = document.createElement("code");
    line.className = "dl ctx";
    line.textContent = d.diff;
    pre.appendChild(line);
    section.appendChild(pre);
    return section;
  }
  for (const f of files) section.appendChild(renderFile(f));
  return section;
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

// ===== commit & push modal =====
let commitSession = null;   // the session whose commit modal is open
let commitLastFocus = null; // element to restore focus to on close
let messageSession = null;  // the session whose send-message modal is open
let messageLastFocus = null;

function openCommit(s) {
  commitSession = s;
  commitLastFocus = document.activeElement;
  const canPush = !!s.canPush; // per-preset (carried on the session)
  const modal = document.getElementById("commitModal");
  document.getElementById("commitTitle").textContent = (canPush ? "Commit & Push" : "Commit") + " — " + s.name;
  const note = document.getElementById("commitBranchNote");
  if (s.commitBranch) {
    // textContent — commitBranch is server config, but render it safely anyway.
    note.textContent = "Commits go to branch \\"" + s.commitBranch + "\\" (created if it doesn't exist).";
    note.style.display = "";
  } else {
    note.textContent = "";
    note.style.display = "none";
  }
  document.getElementById("commitMsg").value = "";
  document.getElementById("commitPin").value = "";
  const pushRow = document.getElementById("commitPushRow");
  pushRow.style.display = canPush ? "" : "none";
  document.getElementById("commitPush").checked = canPush;
  // "Apply to all directories" — only shown when the preset spans more than one.
  // Default ON: committing a multi-dir session is meant to cover every directory;
  // the user can uncheck to limit it to the session's working dir.
  const dirs = s.directories || [];
  const multi = dirs.length > 1;
  document.getElementById("commitAllRow").style.display = multi ? "" : "none";
  document.getElementById("commitAll").checked = multi;
  document.getElementById("commitAllLabel").textContent = "Apply to all " + dirs.length + " directories in this preset";
  const sNote = document.getElementById("commitSuggestNote");
  sNote.style.display = "none";
  sNote.textContent = "";
  const submit = document.getElementById("commitSubmit");
  submit.textContent = canPush ? "Commit & Push" : "Commit";
  // Re-arm in case a previous submit left it disabled after a stale response.
  submit.disabled = false;
  setCommitStatusMsg("", "");
  modal.classList.remove("hidden");
  modal.focus();
  document.getElementById("commitMsg").focus();
  // Offer a suggested message (gcommit scratchpad, else a generated draft). Async:
  // fills only if the field is still empty and this same modal is still open.
  fillSuggestedMessage(s);
}

// Fetch a suggested commit message and pre-fill the (still-empty) textarea. Never
// clobbers what the user typed while the request was in flight, and bails if the
// modal closed or switched sessions.
async function fillSuggestedMessage(s) {
  const id = s.id;
  const ta = document.getElementById("commitMsg");
  const note = document.getElementById("commitSuggestNote");
  note.textContent = "Looking for a suggested message…";
  note.style.display = "";
  let d = null;
  try {
    const r = await api("/api/sessions/" + id + "/suggest-message");
    if (!commitSession || commitSession.id !== id) return;
    if (!r.ok) { note.style.display = "none"; return; }
    d = await r.json().catch(() => null);
  } catch (e) {
    if (commitSession && commitSession.id === id) note.style.display = "none";
    return;
  }
  if (!commitSession || commitSession.id !== id) return;
  if (ta.value.trim()) { note.style.display = "none"; return; }
  if (d && d.message) {
    ta.value = d.message;
    note.textContent = d.source === "scratchpad"
      ? "Pre-filled from GIT_COMMIT_MSG — review and edit before committing."
      : "Drafted from your changes — review and edit before committing.";
    note.style.display = "";
  } else {
    note.style.display = "none";
  }
}

function closeCommit() {
  const modal = document.getElementById("commitModal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  commitSession = null;
  // Never leave the typed PIN sitting in the DOM after the modal closes.
  document.getElementById("commitPin").value = "";
  document.getElementById("commitMsg").value = "";
  const note = document.getElementById("commitSuggestNote");
  note.style.display = "none";
  note.textContent = "";
  if (commitLastFocus && commitLastFocus.focus) commitLastFocus.focus();
  commitLastFocus = null;
}

function commitBackdrop(ev) { if (ev.target && ev.target.id === "commitModal") closeCommit(); }

function setCommitStatusMsg(cls, msg) {
  const el = document.getElementById("commitState");
  el.className = "authstatus" + (cls ? " " + cls : "");
  el.textContent = msg || "";
}

async function submitCommit() {
  if (!commitSession) return;
  const id = commitSession.id;
  // A late response must not touch the DOM / log out if the modal was closed or
  // a different session opened while the request was in flight.
  const stale = () => !commitSession || commitSession.id !== id;
  const msg = document.getElementById("commitMsg").value;
  if (!msg.trim()) { setCommitStatusMsg("err", "Enter a commit message."); return; }
  const pin = document.getElementById("commitPin").value;
  if (!pin) { setCommitStatusMsg("err", "Enter your card PIN."); return; }
  const push = !!commitSession.canPush && document.getElementById("commitPush").checked;
  const applyAll = (commitSession.directories || []).length > 1 && document.getElementById("commitAll").checked;
  const btn = document.getElementById("commitSubmit");
  btn.disabled = true;
  const verb = push ? "Committing & pushing" : "Committing";
  setCommitStatusMsg("", verb + (applyAll ? " all directories" : "") + "… (touch your key if it blinks)");
  try {
    const r = await api("/api/sessions/" + id + "/commit-push", {
      method: "POST",
      body: JSON.stringify({ message: msg, pin: pin, push: push, applyAll: applyAll })
    });
    if (stale()) return;
    if (r.status === 401) { closeCommit(); return logout(); }
    const d = await r.json().catch(() => ({}));
    if (stale()) return;
    if (r.ok && d.ok) {
      document.getElementById("commitPin").value = ""; // clear the PIN on success
      const done = (d.results || []).filter((x) => x.committed);
      let m;
      if (done.length > 1) {
        m = "Committed in " + done.length + " directories";
      } else {
        m = "Committed";
        if (done[0] && done[0].sha) m += " " + done[0].sha;
      }
      if (d.pushed) m += " and pushed";
      setCommitStatusMsg("ok", m + ".");
      setTimeout(() => { closeCommit(); refresh(); }, 1400);
    } else if (d.committed) {
      // A commit landed but a later step failed (a push, or a subsequent
      // directory) — keep the modal open with the detail, noting any dirs that
      // did commit before the failure.
      document.getElementById("commitPin").value = "";
      const n = (d.results || []).filter((x) => x.committed).length;
      const prefix = n > 1 ? "Committed in " + n + " directories, then a later step failed: " : "";
      setCommitStatusMsg("err", prefix + (d.error || "Committed, but a later step failed."));
    } else {
      setCommitStatusMsg("err", d.error || ("Commit failed (HTTP " + r.status + ")."));
    }
  } catch (e) {
    if (!stale()) setCommitStatusMsg("err", "Network error.");
  } finally {
    if (!stale()) btn.disabled = false;
  }
}

// ===== send-message modal =====
function openMessage(s) {
  messageSession = s;
  messageLastFocus = document.activeElement;
  const modal = document.getElementById("messageModal");
  document.getElementById("messageTitle").textContent = "Send message — " + s.name;
  const ta = document.getElementById("messageText");
  ta.value = "";
  document.getElementById("messageSend").disabled = false;
  setMessageStatusMsg("", "");
  modal.classList.remove("hidden");
  modal.focus();
  ta.focus();
}

function closeMessage() {
  const modal = document.getElementById("messageModal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  messageSession = null;
  document.getElementById("messageText").value = "";
  if (messageLastFocus && messageLastFocus.focus) messageLastFocus.focus();
  messageLastFocus = null;
}

function messageBackdrop(ev) { if (ev.target && ev.target.id === "messageModal") closeMessage(); }

function setMessageStatusMsg(cls, msg) {
  const el = document.getElementById("messageState");
  el.className = "authstatus" + (cls ? " " + cls : "");
  el.textContent = msg || "";
}

async function submitMessage() {
  if (!messageSession) return;
  const id = messageSession.id;
  // A late response must not touch the DOM / log out if the modal was closed or a
  // different session opened while the request was in flight.
  const stale = () => !messageSession || messageSession.id !== id;
  const ta = document.getElementById("messageText");
  const text = ta.value;
  if (!text.trim()) { setMessageStatusMsg("err", "Type a message first."); return; }
  const btn = document.getElementById("messageSend");
  btn.disabled = true;
  setMessageStatusMsg("", "Sending…");
  try {
    const r = await api("/api/sessions/" + id + "/message", {
      method: "POST",
      body: JSON.stringify({ message: text })
    });
    if (stale()) return;
    if (r.status === 401) { closeMessage(); return logout(); }
    const d = await r.json().catch(() => ({}));
    if (stale()) return;
    if (r.ok && d.ok) {
      ta.value = "";           // keep the modal open so you can send another
      setMessageStatusMsg("ok", "Sent.");
      ta.focus();
    } else {
      setMessageStatusMsg("err", d.error || ("Failed to send (HTTP " + r.status + ")."));
    }
  } catch (e) {
    if (!stale()) setMessageStatusMsg("err", "Network error.");
  } finally {
    if (!stale()) btn.disabled = false;
  }
}

document.getElementById("pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

document.getElementById("messageText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitMessage(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("authModal").classList.contains("hidden")) { closeAuth(); return; }
  if (!document.getElementById("messageModal").classList.contains("hidden")) { closeMessage(); return; }
  if (!document.getElementById("commitModal").classList.contains("hidden")) { closeCommit(); return; }
  if (!document.getElementById("detailsModal").classList.contains("hidden")) { closeDetails(); return; }
  if (!document.getElementById("diffModal").classList.contains("hidden")) closeDiff();
});

setInterval(() => {
  // Don't rebuild the session table while a modal is open — it would detach the
  // row's buttons (breaking focus-restore on close) and churn the page behind the
  // modal. The next tick after closing refreshes.
  if (document.getElementById("app").classList.contains("hidden")) return;
  if (!document.getElementById("diffModal").classList.contains("hidden")) return;
  if (!document.getElementById("authModal").classList.contains("hidden")) return;
  if (!document.getElementById("commitModal").classList.contains("hidden")) return;
  if (!document.getElementById("detailsModal").classList.contains("hidden")) return;
  if (!document.getElementById("messageModal").classList.contains("hidden")) return;
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
