// The single-page UI, inlined as a string so it is robust under `deno compile` (no
// asset files to locate at runtime). Dark, camera-first.
//
// NOTE: this is a TEMPLATE LITERAL. Keep the markup + client JS free of backticks and
// of the dollar-brace sequence — the client code therefore builds DOM imperatively
// (createElement) and concatenates strings with `+`, never with template strings.
//
// Two modes, chosen from the `?cameras=` query:
//   - focus:     one or more named cameras -> full-screen multiview, audio on, NO chrome,
//                minimal gaps (the security / baby-monitor wall).
//   - dashboard: no `cameras=` -> grid of ALL cameras; drag to reorder, resize (span),
//                scroll, layout persisted; click a tile to enlarge with an event timeline.

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Protect Monitor</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #08090a; --panel: #121316; --panel2: #1a1c20; --border: #24262b;
    --text: #e7e9ee; --dim: #8b8f99; --accent: #3b82f6; --motion: #ef4444; --ok: #22c55e;
    --gap: 8px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    overflow: hidden; }
  button { font: inherit; cursor: pointer; color: var(--text); background: var(--panel2);
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; }
  button:hover { background: #23262c; }
  #app { display: flex; flex-direction: column; height: 100vh; }

  /* header (dashboard only) */
  header { display: flex; align-items: center; gap: 12px; padding: 8px 14px;
    border-bottom: 1px solid var(--border); background: var(--panel); flex: 0 0 auto; }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .3px; }
  header .spacer { flex: 1 1 auto; }
  header .muted { color: var(--dim); font-size: 12px; }

  /* grids */
  .scroll { flex: 1 1 auto; overflow: auto; padding: var(--gap); }
  .grid { display: grid; gap: var(--gap);
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); align-content: start; }
  .grid.focus { padding: 0; gap: 2px; height: 100vh; }

  /* tiles */
  .tile { position: relative; background: #000; border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden; aspect-ratio: 16 / 9; min-height: 0; }
  .grid.focus .tile { border-radius: 0; border: none; aspect-ratio: auto; height: 100%; }
  .tile.dragging { opacity: .4; }
  .tile.dragover { outline: 2px dashed var(--accent); outline-offset: -2px; }
  .tile video, .tile img { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
  .tile .label { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px;
    background: rgba(0,0,0,.55); font-size: 12px; max-width: 70%; overflow: hidden;
    white-space: nowrap; text-overflow: ellipsis; }
  .grid.focus .tile .label { opacity: 0; transition: opacity .2s; }
  .grid.focus .tile:hover .label { opacity: 1; }
  .tile .badges { position: absolute; right: 8px; top: 8px; display: flex; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(0,0,0,.4); }
  .dot.motion { background: var(--motion); }
  .dot.offline { background: var(--dim); }
  .tile .ctl { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 6px; opacity: 0; transition: opacity .15s; }
  .tile:hover .ctl { opacity: 1; }
  .tile .ctl button { padding: 3px 8px; font-size: 12px; border-radius: 6px; }
  .tile .status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--dim); font-size: 13px; pointer-events: none; text-align: center; padding: 8px; }

  /* enlarge modal */
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.9); display: flex; flex-direction: column; z-index: 50; }
  .modal .bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
  .modal .bar h2 { font-size: 15px; margin: 0; }
  .modal .stage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; }
  .modal .stage video, .modal .stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .modal .stage video { width: 100%; height: 100%; object-fit: contain; }
  /* ---- timeline panel (its own area under the video; the video shrinks to fit) ---- */
  .tl-panel { flex: 0 0 auto; background: var(--panel); border-top: 1px solid var(--border);
    padding: 6px 12px 10px; display: flex; flex-direction: column; gap: 6px; }
  .tl-controls { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12px; }
  .tl-controls button { padding: 2px 9px; font-size: 13px; line-height: 1.2; border-radius: 6px; }
  .tl-controls .zoomlbl { min-width: 66px; text-align: center; }
  .tl-controls .evinfo { margin: 0; }
  .filmstrip { position: relative; height: 58px; display: none; }
  .filmstrip.on { display: block; }
  .filmstrip .fs { position: absolute; top: 0; height: 100%; overflow: hidden; background: #111;
    border-right: 1px solid #000; cursor: pointer; }
  .filmstrip .fs img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .timeline { position: relative; height: 52px; background: var(--panel2); border: 1px solid var(--border);
    border-radius: 6px; overflow: hidden; touch-action: none; }
  .timeline .track { position: relative; height: 100%; width: 100%; }
  .timeline.scrub .track { cursor: crosshair; }
  .timeline.panning .track { cursor: grabbing; }
  .timeline .grid { position: absolute; top: 0; bottom: 0; width: 1px; background: #2a2d33; }
  .timeline .grid span { position: absolute; top: 2px; left: 3px; font-size: 10px; color: var(--dim); white-space: nowrap; }
  .timeline .ev { position: absolute; bottom: 0; height: 16px; width: 3px; border-radius: 2px;
    background: var(--accent); cursor: pointer; }
  .timeline .ev.motion { background: var(--motion); }
  .timeline .ev.selected { outline: 2px solid #fff; }
  .timeline .liveedge { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ok); }
  .timeline .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff;
    box-shadow: 0 0 5px rgba(255,255,255,.9); pointer-events: none; z-index: 4; }
  .frame-preview { position: absolute; bottom: calc(100% + 6px); width: 176px; background: #000;
    border: 1px solid var(--border); border-radius: 6px; padding: 3px; z-index: 6; display: none; pointer-events: none; }
  .frame-preview img { width: 100%; display: block; border-radius: 4px; background: #111; min-height: 62px; }
  .frame-preview .fp-time { font-size: 10px; color: var(--dim); text-align: center; padding: 2px 0 0; }
  .evinfo { color: var(--dim); font-size: 12px; margin-top: 4px; min-height: 16px; }

  .gesture { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 60;
    background: var(--accent); color: #fff; padding: 8px 16px; border-radius: 999px; cursor: pointer;
    box-shadow: 0 4px 20px rgba(0,0,0,.5); font-size: 13px; }
  .center { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dim); }

  /* login */
  .login { max-width: 320px; margin: 14vh auto; background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 22px; }
  .login h1 { font-size: 17px; margin: 0 0 14px; }
  .login input { width: 100%; padding: 9px 11px; margin-bottom: 12px; background: var(--bg);
    color: var(--text); border: 1px solid var(--border); border-radius: 8px; }
  .login .err { color: var(--motion); font-size: 12px; min-height: 16px; }
</style>
</head>
<body>
<div id="app"><div class="center">Loading cameras…</div></div>
<script>
(function () {
  "use strict";
  var qp = new URLSearchParams(location.search);
  var camerasParam = (qp.get("cameras") || "").trim();
  var startMuted = qp.get("muted") === "1";
  var app = document.getElementById("app");

  var S = {
    cameras: [], byId: {}, defaults: { defaultQuality: "medium", focusQuality: "high" },
    players: {}, events: {}, tiles: {}, needGesture: false, modal: null, focus: false
  };

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null) e.setAttribute(k, v);
    }
    if (kids) for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }
  function api(path) {
    return fetch(path, { credentials: "same-origin" }).then(function (r) {
      if (r.status === 401) { location.href = "/login"; throw new Error("unauth"); }
      if (!r.ok) throw new Error(path + " -> " + r.status);
      return r.json();
    });
  }
  function wsUrl(path) {
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + path;
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ---------- live MSE player (audio on) with snapshot fallback ----------
  function Player(mount, id, quality) {
    this.mount = mount; this.id = id; this.quality = quality;
    this.stopped = false; this.ws = null; this.ms = null; this.sb = null;
    this.queue = []; this.video = null; this.img = null; this.snapTimer = 0; this.retry = 1000;
    this.watchdog = 0; this.lastTime = 0; this.lastProgress = 0;
  }
  Player.prototype.start = function () {
    if (this.stopped) return;
    this.cleanupMedia();
    var self = this;
    var v = el("video", { autoplay: "", playsinline: "", muted: startMuted ? "" : null });
    v.muted = startMuted || S.needGesture;
    v.addEventListener("error", function () { self.fail(); });
    this.video = v; this.mount.appendChild(v);
    this.lastTime = 0; this.lastProgress = Date.now();
    try {
      this.ms = new MediaSource();
      v.src = URL.createObjectURL(this.ms);
      this.ms.addEventListener("sourceopen", function () { self.openWs(); }, { once: true });
    } catch (e) { this.toSnapshot(); }
  };
  // Tear down media and reconnect with backoff — used when the pipeline errors (decode
  // failure, corrupt fragment, stall) rather than a clean WS close.
  Player.prototype.fail = function () {
    if (this.stopped) return;
    this.cleanupMedia();
    var self = this;
    setTimeout(function () { if (!self.stopped) self.start(); }, this.retry);
    this.retry = Math.min(this.retry * 2, 10000);
  };
  Player.prototype.openWs = function () {
    var self = this;
    var ws = new WebSocket(wsUrl("/ws/live/" + encodeURIComponent(this.id) + "/" + this.quality));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === "init") self.initSb(m.mime);
        else if (m.type === "error") self.toSnapshot();
      } else { self.queue.push(ev.data); self.flush(); }
    };
    ws.onclose = function () { self.onClose(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };
  Player.prototype.initSb = function (mime) {
    if (!("MediaSource" in window) || !MediaSource.isTypeSupported(mime)) { this.toSnapshot(); return; }
    var self = this;
    try {
      this.sb = this.ms.addSourceBuffer(mime);
      this.sb.mode = "sequence";
      this.sb.addEventListener("updateend", function () { self.flush(); self.trim(); });
      this.sb.addEventListener("error", function () { self.fail(); });
    } catch (e) { this.toSnapshot(); return; }
    this.retry = 1000; // healthy reconnect — reset the backoff
    // Stall watchdog: if playback stops advancing for 15s, rebuild (covers a decode stall,
    // e.g. a codec/track mismatch, that doesn't surface as an error event).
    this.watchdog = setInterval(function () {
      if (self.stopped || !self.video) return;
      var t = self.video.currentTime;
      if (t > self.lastTime + 0.01) { self.lastTime = t; self.lastProgress = Date.now(); }
      else if (self.video.buffered.length && Date.now() - self.lastProgress > 15000) { self.fail(); }
    }, 5000);
    this.lastProgress = Date.now();
    this.flush(); this.tryPlay();
  };
  Player.prototype.flush = function () {
    if (!this.sb || this.sb.updating || this.queue.length === 0) return;
    try { this.sb.appendBuffer(this.queue.shift()); }
    catch (e) {
      if (e && e.name === "QuotaExceededError") this.trim(true);
      else this.fail(); // corrupt/undecodable data -> reconnect for a fresh init segment
    }
  };
  Player.prototype.trim = function (force) {
    if (!this.sb || this.sb.updating) return;
    try {
      var b = this.video.buffered;
      if (!b.length) return;
      var end = b.end(b.length - 1), start = b.start(0), keep = force ? 12 : 45;
      if (end - start > keep) this.sb.remove(start, end - keep);
      if (end - this.video.currentTime > 3) this.video.currentTime = end - 0.4;
    } catch (e) {}
  };
  Player.prototype.tryPlay = function () {
    var v = this.video;
    v.muted = startMuted || S.needGesture;
    var p = v.play();
    if (p && p.catch) p.catch(function () {
      v.muted = true; S.needGesture = true; showGesture(); v.play().catch(function () {});
    });
  };
  Player.prototype.onClose = function () {
    if (this.stopped) return;
    var self = this;
    setTimeout(function () { if (!self.stopped) self.start(); }, this.retry);
    this.retry = Math.min(this.retry * 2, 10000);
  };
  Player.prototype.toSnapshot = function () {
    this.cleanupMedia();
    var img = el("img", { alt: "" });
    this.img = img; this.mount.appendChild(img);
    var self = this;
    var tick = function () { if (!self.stopped) img.src = "/snapshot/" + encodeURIComponent(self.id) + "?highQuality=false&t=" + Date.now(); };
    tick();
    this.snapTimer = setInterval(tick, 4000);
  };
  Player.prototype.cleanupMedia = function () {
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.snapTimer) { clearInterval(this.snapTimer); this.snapTimer = 0; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = 0; }
    if (this.video) { try { URL.revokeObjectURL(this.video.src); } catch (e) {} this.video.remove(); this.video = null; }
    if (this.img) { this.img.remove(); this.img = null; }
    this.ms = null; this.sb = null; this.queue = [];
  };
  Player.prototype.stop = function () { this.stopped = true; this.cleanupMedia(); };

  function showGesture() {
    if (document.querySelector(".gesture")) return;
    var g = el("div", { class: "gesture", text: "🔊 Tap to enable audio" });
    g.addEventListener("click", enableAudio);
    document.body.appendChild(g);
    document.addEventListener("click", enableAudio, { once: true });
  }
  function enableAudio() {
    S.needGesture = false;
    startMuted = false; // an explicit "enable audio" overrides ?muted=1
    var g = document.querySelector(".gesture"); if (g) g.remove();
    for (var id in S.players) {
      var pl = S.players[id]; if (pl && pl.video) { pl.video.muted = false; pl.video.play().catch(function () {}); }
    }
    if (S.modal && S.modal.player && S.modal.player.video) { S.modal.player.video.muted = false; }
  }

  // ---------- tiles ----------
  function buildTile(cam, quality, opts) {
    var mount = el("div", { class: "tile-media" });
    mount.style.width = "100%"; mount.style.height = "100%";
    var status = el("div", { class: "status", text: cam.state === "CONNECTED" ? "" : "connecting…" });
    var motionDot = el("div", { class: "dot", style: "display:none" });
    var offlineDot = el("div", { class: "dot offline", style: "display:none" });
    var badges = el("div", { class: "badges" }, [motionDot, offlineDot]);
    var label = el("div", { class: "label", text: cam.name });
    var tile = el("div", { class: "tile", "data-id": cam.id }, [mount, status, badges, label]);
    if (offlineDot && cam.state !== "CONNECTED") offlineDot.style.display = "block";

    if (!S.focus) {
      var sizeBtn = el("button", { text: "⤢", title: "resize" });
      sizeBtn.addEventListener("click", function (e) { e.stopPropagation(); cycleSize(cam.id); });
      var ctl = el("div", { class: "ctl" }, [sizeBtn]);
      tile.appendChild(ctl);
      tile.addEventListener("click", function () { openModal(cam); });
      tile.setAttribute("draggable", "true");
      wireDrag(tile, cam.id);
    }

    var player = new Player(mount, cam.id, quality);
    player.start();
    S.players[cam.id] = player;
    S.tiles[cam.id] = { tile: tile, motionDot: motionDot, offlineDot: offlineDot, status: status };
    return tile;
  }

  // ---------- layout persistence (dashboard) ----------
  var LKEY = "upm.layout.v1";
  function loadLayout() { try { return JSON.parse(localStorage.getItem(LKEY)) || {}; } catch (e) { return {}; } }
  function saveLayout(l) { try { localStorage.setItem(LKEY, JSON.stringify(l)); } catch (e) {} }
  function orderedCameras() {
    var l = loadLayout(); var order = l.order || [];
    var pos = {}; order.forEach(function (id, i) { pos[id] = i; });
    return S.cameras.slice().sort(function (a, b) {
      var pa = pos[a.id] == null ? 1e9 : pos[a.id], pb = pos[b.id] == null ? 1e9 : pos[b.id];
      return pa - pb;
    });
  }
  function applySize(tile, id) {
    var l = loadLayout(); var span = (l.size && l.size[id]) || 1;
    tile.style.gridColumn = "span " + span;
  }
  function cycleSize(id) {
    var l = loadLayout(); l.size = l.size || {};
    l.size[id] = ((l.size[id] || 1) % 3) + 1;
    saveLayout(l);
    var t = S.tiles[id]; if (t) t.tile.style.gridColumn = "span " + l.size[id];
  }
  var dragId = null;
  function wireDrag(tile, id) {
    tile.addEventListener("dragstart", function (e) { dragId = id; tile.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    tile.addEventListener("dragend", function () { dragId = null; tile.classList.remove("dragging"); });
    tile.addEventListener("dragover", function (e) { e.preventDefault(); tile.classList.add("dragover"); });
    tile.addEventListener("dragleave", function () { tile.classList.remove("dragover"); });
    tile.addEventListener("drop", function (e) {
      e.preventDefault(); tile.classList.remove("dragover");
      if (!dragId || dragId === id) return;
      var order = orderedCameras().map(function (c) { return c.id; });
      order.splice(order.indexOf(dragId), 1);
      order.splice(order.indexOf(id), 0, dragId);
      var l = loadLayout(); l.order = order; saveLayout(l);
      render();
    });
  }

  // ---------- recorded playback (chained short MP4 clips over the internal API) ----------
  var MIN_SPAN = 60 * 1000, MAX_SPAN = 14 * 24 * 3600 * 1000, FILM_N = 12, filmTimer = 0;

  function throttle(fn, ms) {
    var last = 0, timer = 0, lastArgs, lastThis;
    return function () {
      var nowT = Date.now(); lastArgs = arguments; lastThis = this;
      if (nowT - last >= ms) { last = nowT; fn.apply(lastThis, lastArgs); }
      else { clearTimeout(timer); timer = setTimeout(function () { last = Date.now(); fn.apply(lastThis, lastArgs); }, ms - (nowT - last)); }
    };
  }
  function fmtDateTime(ms) {
    return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtSpan(ms) {
    if (ms >= 86400000) return (Math.round(ms / 86400000 * 10) / 10) + "d";
    if (ms >= 3600000) return (Math.round(ms / 3600000 * 10) / 10) + "h";
    if (ms >= 60000) return Math.round(ms / 60000) + "m";
    return Math.round(ms / 1000) + "s";
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function axisLabel(t, span) {
    var d = new Date(t), hh = pad2(d.getHours()), mm = pad2(d.getMinutes());
    if (span <= 10 * 60000) return hh + ":" + mm + ":" + pad2(d.getSeconds());
    if (span <= 3 * 3600000) return hh + ":" + mm;
    if (span <= 2 * 86400000) return (d.getMonth() + 1) + "/" + d.getDate() + " " + hh + ":" + mm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hh + ":00";
  }
  function gridStep(span) {
    var target = span / 6;
    var steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000,
      3600000, 7200000, 10800000, 21600000, 43200000, 86400000, 2 * 86400000, 7 * 86400000];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= target) return steps[i];
    return steps[steps.length - 1];
  }

  // A Playback session: chains short exported MP4 clips (the export endpoint isn't
  // byte-range seekable). advance() is BOUNDED — never past the present, and an error/gap is
  // debounced with a consecutive-error cap (+ a per-seek token so a stale error can't advance
  // a newer clip) so a missing segment can't machine-gun heavy console exports forward.
  function Playback(stage, id, coverage, channel, maxClipMs) {
    this.stage = stage; this.id = id; this.coverage = coverage; this.channel = channel;
    this.CLIP_MS = Math.max(5000, Math.min(30000, maxClipMs || 30000));
    this.stopped = false; this.video = null; this.clipStart = 0; this.onPlayhead = null; this.onGap = null;
    this.seekTok = 0; this.errCount = 0;
  }
  Playback.prototype.start = function () {
    var v = el("video", { controls: "", autoplay: "", playsinline: "" });
    this.video = v; this.stage.appendChild(v);
    var self = this;
    v.addEventListener("ended", function () { self.errCount = 0; self.advance(); });
    v.addEventListener("error", function () { self.onError(); });
    v.addEventListener("timeupdate", function () {
      if (self.video && self.video.currentTime > 0.15) self.errCount = 0; // real progress resets the gap counter
      if (self.onPlayhead) self.onPlayhead(self.now());
    });
  };
  Playback.prototype.ceiling = function () {
    var now = Date.now();
    return this.coverage.recordingEnd != null ? Math.min(this.coverage.recordingEnd, now) : now;
  };
  Playback.prototype.clampT = function (T) {
    if (this.coverage.recordingStart != null) T = Math.max(T, this.coverage.recordingStart);
    return Math.round(Math.min(T, this.ceiling()));
  };
  Playback.prototype.seek = function (T) {
    if (this.stopped || !this.video) return;
    T = this.clampT(T);
    this.clipStart = T; this.seekTok++;
    this.video.src = "/api/clip/" + encodeURIComponent(this.id) + "?start=" + T + "&end=" + (T + this.CLIP_MS) + "&channel=" + this.channel;
    this.video.play().catch(function () {});
    if (this.onPlayhead) this.onPlayhead(T);
  };
  Playback.prototype.advance = function () {
    if (this.stopped) return;
    var next = this.clipStart + this.CLIP_MS;
    if (next >= this.ceiling() - 1000) return; // reached the present / live edge — stop
    this.seek(next);
  };
  Playback.prototype.onError = function () {
    if (this.stopped) return;
    var self = this, tok = this.seekTok;
    setTimeout(function () {
      if (self.stopped || self.seekTok !== tok) return; // a newer seek superseded this clip
      self.errCount++;
      if (self.errCount >= 4) { if (self.onGap) self.onGap(); return; } // give up scanning; surface "no footage"
      self.advance();
    }, 800);
  };
  Playback.prototype.now = function () { return this.clipStart + (this.video ? this.video.currentTime * 1000 : 0); };
  Playback.prototype.stop = function () {
    this.stopped = true;
    if (this.video) { try { this.video.pause(); } catch (e) {} this.video.remove(); this.video = null; }
  };

  // ---------- enlarge modal (live feed + recorded scrubber under it) ----------
  function openModal(cam) {
    closeModal();
    // Stop the underlying tile's live player — the modal covers it (a second stream is waste).
    var tilePlayer = S.players[cam.id];
    if (tilePlayer) tilePlayer.stop();

    var stage = el("div", { class: "stage" });
    var backBtn = el("button", { text: "← Back", title: "back to all cameras" });
    backBtn.addEventListener("click", closeModal);
    var title = el("h2", { text: cam.name });
    var modeBtn = el("button", { text: "▷ Playback", style: "display:none" });
    var muteBtn = el("button", { text: "🔊 Audio" });
    var bar = el("div", { class: "bar" }, [backBtn, title, el("div", { class: "spacer", style: "flex:1" }), modeBtn, muteBtn]);

    var zoomOut = el("button", { text: "−", title: "zoom out" });
    var zoomIn = el("button", { text: "+", title: "zoom in" });
    var zoomLbl = el("span", { class: "zoomlbl", text: "6h" });
    var nowBtn = el("button", { text: "⟲ Now", title: "jump to live" });
    var info = el("div", { class: "evinfo", text: "Live — motion / smart-detect events are marked below." });
    var controls = el("div", { class: "tl-controls" }, [zoomOut, zoomIn, zoomLbl, nowBtn, el("div", { class: "spacer", style: "flex:1" }), info]);
    var filmstrip = el("div", { class: "filmstrip" });
    var track = el("div", { class: "track" });
    var timeline = el("div", { class: "timeline scrub" }, [track]);
    var panel = el("div", { class: "tl-panel" }, [controls, filmstrip, timeline]);

    var modal = el("div", { class: "modal" }, [bar, stage, panel]);
    document.body.appendChild(modal);

    var player = new Player(stage, cam.id, S.defaults.focusQuality);
    player.start();

    S.modal = {
      cam: cam, player: player, playback: null, node: modal, stage: stage, timeline: timeline, track: track,
      filmstrip: filmstrip, info: info, muteBtn: muteBtn, modeBtn: modeBtn, zoomLbl: zoomLbl,
      coverage: null, channel: 0, maxClipMs: 30000, mode: "live", spanMs: 6 * 3600000, visEnd: Date.now(), follow: true,
    };

    muteBtn.addEventListener("click", function () {
      var m = S.modal; if (!m) return;
      var v = m.mode === "playback" && m.playback ? m.playback.video : (m.player && m.player.video);
      if (v) { v.muted = !v.muted; muteBtn.textContent = v.muted ? "🔇 Muted" : "🔊 Audio"; }
    });
    zoomOut.addEventListener("click", function () { zoomBtn(1.6); });
    zoomIn.addEventListener("click", function () { zoomBtn(1 / 1.6); });
    nowBtn.addEventListener("click", goLive);

    wireScrubber();
    renderTimeline();

    // Feature-detect recorded playback (404 when recordings are disabled -> stay live-only).
    api("/api/recordings/coverage").then(function (data) {
      if (!S.modal || S.modal.cam.id !== cam.id) return;
      var cov = data.coverage && data.coverage[cam.id];
      if (!cov || (cov.recordingStart == null && cov.recordingEnd == null)) return;
      S.modal.coverage = cov;
      S.modal.channel = typeof data.channel === "number" ? data.channel : 0;
      S.modal.maxClipMs = typeof data.maxClipMs === "number" ? data.maxClipMs : 30000;
      modeBtn.style.display = "";
      filmstrip.classList.add("on");
      info.textContent = "Live — scrub the timeline/filmstrip or click an event to view recorded footage.";
      modeBtn.addEventListener("click", function () {
        if (S.modal.mode === "live") {
          var end = S.modal.coverage.recordingEnd != null ? S.modal.coverage.recordingEnd : Date.now();
          enterPlayback(end - 5 * 60000);
        } else exitToLive();
      });
      renderTimeline();
      refreshFilmstrip();
    }).catch(function () { /* recordings disabled */ });
  }

  function enterPlayback(T) {
    var m = S.modal; if (!m || !m.coverage) return;
    if (m.player) m.player.stop();
    var pb = new Playback(m.stage, m.cam.id, m.coverage, m.channel, m.maxClipMs);
    pb.onPlayhead = function (t) {
      var mm = S.modal; if (!mm) return;
      var pct = ((t - (mm.visEnd - mm.spanMs)) / mm.spanMs) * 100;
      if (pct < 5 || pct > 95) { mm.visEnd = t + mm.spanMs / 2; clampView(); renderTimeline(); }
      else movePlayhead(pct);
      mm.info.textContent = "▷ " + fmtDateTime(t);
    };
    pb.onGap = function () { if (S.modal === m) m.info.textContent = "No recorded footage around here — try elsewhere on the timeline."; };
    pb.start();
    m.playback = pb; m.mode = "playback"; m.follow = false;
    m.modeBtn.textContent = "● Live"; m.muteBtn.textContent = "🔊 Audio";
    m.visEnd = T + m.spanMs / 2; clampView();
    pb.seek(T);
    renderTimeline();
  }
  function exitToLive() {
    var m = S.modal; if (!m) return;
    if (m.playback) { m.playback.stop(); m.playback = null; }
    m.mode = "live"; m.follow = true; m.visEnd = Date.now();
    m.modeBtn.textContent = "▷ Playback";
    m.player = new Player(m.stage, m.cam.id, S.defaults.focusQuality); m.player.start();
    m.muteBtn.textContent = startMuted ? "🔇 Muted" : "🔊 Audio";
    m.info.textContent = "Live — scrub the timeline/filmstrip or click an event to view recorded footage.";
    renderTimeline();
  }

  // ---- zoom / pan / follow ----
  function clampView() {
    var m = S.modal, now = Date.now();
    if (m.visEnd > now) m.visEnd = now;
    if (m.coverage && m.coverage.recordingStart != null) {
      var oldestEnd = m.coverage.recordingStart + m.spanMs;
      if (oldestEnd <= now && m.visEnd < oldestEnd) m.visEnd = oldestEnd;
    }
  }
  function zoomAt(centerT, factor) {
    var m = S.modal; if (!m) return;
    var newSpan = Math.max(MIN_SPAN, Math.min(MAX_SPAN, m.spanMs * factor));
    var frac = Math.max(0, Math.min(1, (centerT - (m.visEnd - m.spanMs)) / m.spanMs));
    m.spanMs = newSpan; m.visEnd = (centerT - frac * newSpan) + newSpan; m.follow = false;
    clampView(); renderTimeline();
  }
  function zoomBtn(factor) {
    var m = S.modal;
    var centerT = m.mode === "playback" && m.playback ? m.playback.now() : m.visEnd - m.spanMs / 2;
    zoomAt(centerT, factor);
  }
  function goLive() {
    var m = S.modal; if (!m) return;
    m.follow = true; m.visEnd = Date.now();
    if (m.mode === "playback" && m.playback) {
      var end = m.coverage && m.coverage.recordingEnd != null ? m.coverage.recordingEnd : Date.now();
      m.playback.seek(end - m.playback.CLIP_MS);
    }
    clampView(); renderTimeline();
  }

  function movePlayhead(pct) {
    var track = S.modal.track;
    var ph = track.querySelector(".playhead");
    if (!ph) { ph = el("div", { class: "playhead" }); track.appendChild(ph); }
    ph.style.left = Math.max(0, Math.min(100, pct)) + "%";
  }
  function xToTime(clientX) {
    var m = S.modal, rect = m.track.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    var T = (m.visEnd - m.spanMs) + frac * m.spanMs;
    if (m.coverage) {
      if (m.coverage.recordingStart != null) T = Math.max(T, m.coverage.recordingStart);
      if (m.coverage.recordingEnd != null) T = Math.min(T, Math.min(m.coverage.recordingEnd, Date.now()));
    }
    return Math.round(T);
  }
  function seekOrEnter(T) {
    var m = S.modal; if (!m || !m.coverage) return;
    if (m.mode !== "playback") enterPlayback(T); else m.playback.seek(T);
  }

  function wireScrubber() {
    var m = S.modal, tl = m.timeline, track = m.track;
    var preview = null, hideTimer = 0, dragging = false, downX = 0, downVisEnd = 0, moved = false, pid = null;

    function showPreview(clientX) {
      if (!m.coverage) return;
      var T = xToTime(clientX);
      if (!preview) { preview = el("div", { class: "frame-preview" }, [el("img", { alt: "" }), el("div", { class: "fp-time" })]); tl.appendChild(preview); }
      preview.querySelector("img").src = "/api/frame/" + encodeURIComponent(m.cam.id) + "?ts=" + T + "&w=320";
      preview.querySelector(".fp-time").textContent = fmtDateTime(T);
      preview.style.display = "block";
      var rect = tl.getBoundingClientRect();
      preview.style.left = Math.max(4, Math.min(rect.width - 182, clientX - rect.left - 88)) + "px";
    }
    var showPreviewT = throttle(function (clientX) { if (!S.modal || S.modal !== m) return; showPreview(clientX); }, 140);

    track.addEventListener("pointerdown", function (e) {
      if (e.target.classList && e.target.classList.contains("ev")) return;
      dragging = true; moved = false; downX = e.clientX; downVisEnd = m.visEnd; pid = e.pointerId;
      try { track.setPointerCapture(e.pointerId); } catch (x) {}
    });
    track.addEventListener("pointermove", function (e) {
      if (dragging) {
        var rect = tl.getBoundingClientRect(), dx = e.clientX - downX;
        if (Math.abs(dx) > 3) { moved = true; tl.classList.add("panning"); if (preview) preview.style.display = "none"; }
        m.visEnd = downVisEnd - (dx / rect.width) * m.spanMs; m.follow = false; clampView(); renderTimeline();
      } else showPreviewT(e.clientX);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false; tl.classList.remove("panning");
      try { track.releasePointerCapture(pid); } catch (x) {}
      if (!moved && m.coverage) seekOrEnter(xToTime(e.clientX));
    }
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", function () { dragging = false; tl.classList.remove("panning"); });
    track.addEventListener("mouseleave", function () {
      hideTimer = setTimeout(function () { if (S.modal === m && preview) preview.style.display = "none"; }, 200);
    });
    tl.addEventListener("wheel", function (e) {
      if (!m.coverage) return;
      e.preventDefault();
      zoomAt(xToTime(e.clientX), e.deltaY < 0 ? 1 / 1.3 : 1.3);
    }, { passive: false });
  }

  // Filmstrip: thumbnails across the visible window so you can scan for something at a glance.
  // Debounced so a zoom/pan drag doesn't flood the internal API with frame requests.
  function scheduleFilmstrip() {
    clearTimeout(filmTimer);
    filmTimer = setTimeout(function () { if (S.modal && S.modal.coverage) refreshFilmstrip(); }, 350);
  }
  function refreshFilmstrip() {
    var m = S.modal; if (!m || !m.coverage) return;
    var fs = m.filmstrip, visStart = m.visEnd - m.spanMs, now = Date.now();
    while (fs.firstChild) fs.removeChild(fs.firstChild);
    for (var i = 0; i < FILM_N; i++) {
      var t = Math.round(visStart + (i + 0.5) / FILM_N * m.spanMs);
      if ((m.coverage.recordingStart != null && t < m.coverage.recordingStart) || t > now) continue;
      var cell = el("div", { class: "fs", style: "left:" + (i / FILM_N * 100) + "%; width:" + (100 / FILM_N) + "%" });
      cell.appendChild(el("img", { alt: "", src: "/api/frame/" + encodeURIComponent(m.cam.id) + "?ts=" + t + "&w=160" }));
      (function (tt) { cell.addEventListener("click", function () { seekOrEnter(tt); }); })(t);
      fs.appendChild(cell);
    }
  }

  function closeModal() {
    if (!S.modal) return;
    var camId = S.modal.cam.id;
    clearTimeout(filmTimer);
    if (S.modal.playback) S.modal.playback.stop();
    if (S.modal.player) S.modal.player.stop();
    S.modal.node.remove();
    S.modal = null;
    var t = S.tiles[camId];
    if (t) {
      var mount = t.tile.querySelector(".tile-media");
      if (mount) { var p = new Player(mount, camId, S.defaults.defaultQuality); p.start(); S.players[camId] = p; }
    }
  }

  function renderTimeline() {
    if (!S.modal) return;
    var m = S.modal, track = m.track, now = Date.now();
    if (m.mode === "live" && m.follow) m.visEnd = now;
    var visEnd = m.visEnd, span = m.spanMs, visStart = visEnd - span;
    while (track.firstChild) track.removeChild(track.firstChild);

    if (now >= visStart && now <= visEnd) {
      track.appendChild(el("div", { class: "liveedge", style: "left:" + ((now - visStart) / span) * 100 + "%" }));
    }
    var step = gridStep(span);
    for (var t = Math.ceil(visStart / step) * step; t <= visEnd; t += step) {
      var pct = ((t - visStart) / span) * 100;
      track.appendChild(el("div", { class: "grid", style: "left:" + pct + "%" }, [el("span", { text: axisLabel(t, span) })]));
    }
    var evs = S.events[m.cam.id] || [];
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (ev.start < visStart || ev.start > visEnd) continue;
      var lp = ((ev.start - visStart) / span) * 100;
      var motion = ev.kind === "motion" || ev.kind.indexOf("smartDetect") === 0;
      var mark = el("div", { class: "ev" + (motion ? " motion" : ""), style: "left:" + lp + "%", title: ev.kind + " " + fmtTime(ev.start) });
      (function (ev, mark) {
        mark.addEventListener("click", function (e) {
          e.stopPropagation();
          var sel = track.querySelector(".ev.selected"); if (sel) sel.classList.remove("selected");
          mark.classList.add("selected");
          var dur = ev.end ? (Math.round((ev.end - ev.start) / 1000) + "s") : "ongoing";
          m.info.textContent = ev.kind + " at " + fmtTime(ev.start) + " (" + dur + ")";
          seekOrEnter(ev.start);
        });
      })(ev, mark);
      track.appendChild(mark);
    }
    if (m.mode === "playback" && m.playback) {
      var pct2 = ((m.playback.now() - visStart) / span) * 100;
      if (pct2 >= 0 && pct2 <= 100) movePlayhead(pct2);
    }
    m.zoomLbl.textContent = fmtSpan(span);
    scheduleFilmstrip();
  }

  // ---------- events websocket ----------
  function connectEvents() {
    var ws = new WebSocket(wsUrl("/ws/events"));
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "snapshot") { m.events.forEach(ingestEvent); }
      else if (m.type === "event") { ingestEvent(m.event); refreshTileMotion(m.event.cameraId); if (S.modal && S.modal.cam.id === m.event.cameraId) renderTimeline(); }
      else if (m.type === "device") { applyDevice(m.cameraId, m.patch); }
    };
    ws.onclose = function () { setTimeout(connectEvents, 3000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function ingestEvent(ev) {
    var arr = S.events[ev.cameraId] || (S.events[ev.cameraId] = []);
    var idx = -1; for (var i = 0; i < arr.length; i++) if (arr[i].id === ev.id) { idx = i; break; }
    if (idx >= 0) arr[idx] = ev; else arr.push(ev);
    if (arr.length > 300) arr.shift();
  }
  function refreshTileMotion(id) {
    var t = S.tiles[id]; if (!t) return;
    var arr = S.events[id] || [];
    var active = false, cutoff = Date.now() - 60000;
    // Don't assume arr is time-sorted (snapshot seeds newest-first; updates keep their
    // slot) — scan the whole (capped) array.
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (e.start >= cutoff && e.end == null && (e.kind === "motion" || e.kind.indexOf("smartDetect") === 0)) { active = true; break; }
    }
    t.motionDot.className = "dot motion";
    t.motionDot.style.display = active ? "block" : "none";
  }
  function applyDevice(id, patch) {
    var t = S.tiles[id]; if (!t) return;
    if (patch.state) t.offlineDot.style.display = patch.state === "CONNECTED" ? "none" : "block";
    if (typeof patch.isMotionDetected === "boolean") {
      t.motionDot.className = "dot motion"; // without the class the dot is transparent
      t.motionDot.style.display = patch.isMotionDetected ? "block" : "none";
    }
  }

  // ---------- rendering ----------
  function stopAllPlayers() {
    for (var id in S.players) S.players[id].stop();
    S.players = {}; S.tiles = {};
  }
  function selectFocus(param) {
    if (!param) return null;
    var wanted = param.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    var sel = S.cameras.filter(function (c) {
      return wanted.indexOf((c.name || "").toLowerCase()) >= 0 || wanted.indexOf(c.id.toLowerCase()) >= 0;
    });
    return sel.length ? sel : null;
  }
  function render() {
    stopAllPlayers();
    while (app.firstChild) app.removeChild(app.firstChild);

    var focusSel = selectFocus(camerasParam);
    S.focus = !!focusSel;

    if (S.focus) {
      var n = focusSel.length;
      var cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      var grid = el("div", { class: "grid focus" });
      grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
      grid.style.gridAutoRows = "1fr";
      var q = n === 1 ? S.defaults.focusQuality : S.defaults.defaultQuality;
      focusSel.forEach(function (cam) { grid.appendChild(buildTile(cam, q, {})); });
      app.appendChild(grid);
      return;
    }

    var muteAll = el("button", { text: "🔊 Enable audio" });
    muteAll.addEventListener("click", enableAudio);
    var reset = el("button", { text: "Reset layout" });
    reset.addEventListener("click", function () { saveLayout({}); render(); });
    var head = el("header", null, [
      el("h1", { text: "Protect Monitor" }),
      el("span", { class: "muted", text: S.cameras.length + " cameras" }),
      el("div", { class: "spacer" }),
      muteAll, reset
    ]);
    if (S.auth) {
      var out = el("button", { text: "Log out" });
      out.addEventListener("click", function () {
        fetch("/api/logout", { method: "POST", credentials: "same-origin" }).then(function () { location.href = "/login"; });
      });
      head.appendChild(out);
    }
    var grid2 = el("div", { class: "grid" });
    var scroll = el("div", { class: "scroll" }, [grid2]);
    orderedCameras().forEach(function (cam) {
      var tile = buildTile(cam, S.defaults.defaultQuality, {});
      applySize(tile, cam.id);
      grid2.appendChild(tile);
    });
    app.appendChild(head);
    app.appendChild(scroll);
  }

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  setInterval(function () { for (var id in S.tiles) refreshTileMotion(id); }, 15000);

  api("/api/cameras").then(function (data) {
    S.cameras = data.cameras || [];
    S.defaults = data.defaults || S.defaults;
    S.auth = !!data.auth;
    S.cameras.forEach(function (c) { S.byId[c.id] = c; });
    if (S.cameras.length === 0) { app.innerHTML = ""; app.appendChild(el("div", { class: "center", text: "No cameras found (check the API key / console URL)." })); return; }
    render();
    connectEvents();
  }).catch(function (e) {
    app.innerHTML = "";
    app.appendChild(el("div", { class: "center", text: "Failed to load cameras: " + e.message }));
  });
})();
</script>
</body>
</html>`;

export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Protect Monitor — sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #08090a; color: #e7e9ee;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .login { max-width: 320px; margin: 16vh auto; background: #121316; border: 1px solid #24262b;
    border-radius: 12px; padding: 22px; }
  .login h1 { font-size: 17px; margin: 0 0 14px; }
  .login input { width: 100%; padding: 9px 11px; margin-bottom: 12px; background: #08090a;
    color: #e7e9ee; border: 1px solid #24262b; border-radius: 8px; }
  .login button { width: 100%; padding: 9px; background: #3b82f6; color: #fff; border: 0;
    border-radius: 8px; font: inherit; cursor: pointer; }
  .err { color: #ef4444; font-size: 12px; min-height: 16px; margin-bottom: 8px; }
</style>
</head>
<body>
<form class="login" id="f">
  <h1>Protect Monitor</h1>
  <div class="err" id="err"></div>
  <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
</form>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault();
  fetch("/api/login", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value })
  }).then(function (r) {
    if (r.ok) location.href = "/";
    else document.getElementById("err").textContent = "Invalid password";
  }).catch(function () { document.getElementById("err").textContent = "Network error"; });
});
</script>
</body>
</html>`;
