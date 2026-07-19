// Self-contained overlay pages, inlined as strings so they are robust under
// `deno compile` (no asset files to locate at runtime). ZERO external imports.
//
// SAFETY NOTES:
//  - These are TS template literals: the page JS must NOT contain backticks or
//    "${" (string concatenation only) or TS would interpolate it.
//  - Every player-controlled string (nicknames, quest names, location, trainer
//    names) is rendered client-side via textContent (never innerHTML), and
//    server-side (renderStatusPage) through escapeHtml — that is the XSS gate.
//  - Overlay pages have a TRANSPARENT background (OBS browser sources) and are
//    served with Cache-Control: no-store (see router.ts).
//  - CSS animations per the plan: HP bars tween on change, faint = grayscale +
//    cross fade-in, toasts slide/fade, new headstones rise from the ground.

import type { GameView, PublicState } from "./state.ts";
import { escapeHtml } from "./util.ts";

const BASE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: transparent; overflow: hidden;
  font: 14px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif; color: #fff; }
.wrap { transition: opacity 1s ease, filter 1s ease; }
body.stale .wrap { opacity: .35; filter: saturate(.3); }
`;

// Shared page JS: element helper, the SSE connection (state/status/game), and
// the sprite <img> builder (404 → the caller's error handler falls back to text).
const SHARED_JS = `
function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
function connect(handlers) {
  var es = new EventSource('/events');
  if (handlers.state) es.addEventListener('state', function (e) { handlers.state(JSON.parse(e.data)); });
  es.addEventListener('status', function (e) {
    var s = JSON.parse(e.data);
    document.body.classList.toggle('stale', !s.live);
  });
  if (handlers.game) es.addEventListener('game', function (e) { handlers.game(JSON.parse(e.data)); });
  return es;
}
function spriteImg(cls, species, dex) {
  var img = el('img', cls);
  img.alt = '';
  img.src = '/sprites/' + encodeURIComponent(String(species || '')) + '.png?dex=' + (dex > 0 ? Math.floor(dex) : 0);
  return img;
}
function shortSpecies(s) { return String(s || '').replace(/^.*:/, ''); }
`;

function page(title: string, css: string, body: string, js: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${BASE_CSS}${css}</style>
</head>
<body>
${body}
<script>${SHARED_JS}${js}</script>
</body>
</html>
`;
}

// ---- /overlay/party — 6 cards with sprite, name, Lv, animated HP bar, shiny ★ ----

const PARTY_CSS = `
.party { display: flex; gap: 10px; padding: 8px; }
.card { position: relative; width: 150px; padding: 8px 10px 10px;
  background: rgba(12,16,24,.85); border: 1px solid rgba(255,255,255,.14);
  border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.45); transition: opacity .4s; }
.card.empty { opacity: .22; }
.sprite-box { height: 64px; display: flex; align-items: center; justify-content: center; }
.sprite { image-rendering: pixelated; transform: scale(1.5); transition: filter .6s, opacity .6s; }
.sprite-fallback { font-size: 12px; color: #9aa4b2; text-align: center; }
.nm { display: flex; align-items: baseline; gap: 5px; margin-top: 4px; }
.nm-name { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.shiny { color: #ffd75e; text-shadow: 0 0 6px rgba(255,215,94,.8); }
.lvl { font-size: 11px; color: #9aa4b2; white-space: nowrap; }
.hp { height: 8px; margin-top: 6px; background: rgba(255,255,255,.15);
  border-radius: 4px; overflow: hidden; }
.hp-fill { height: 100%; width: 0%; background: #3ddc68; border-radius: 4px;
  transition: width .6s ease, background-color .6s ease; }
.hp-fill.mid { background: #e8c33a; }
.hp-fill.low { background: #e5484d; }
.card.fainted .sprite { filter: grayscale(1) brightness(.7); opacity: .55; }
.cross { position: absolute; top: 4px; right: 8px; font-size: 22px; color: #e5484d;
  opacity: 0; text-shadow: 0 1px 3px #000; pointer-events: none; }
.card.fainted .cross { opacity: 1; animation: crossIn .6s ease-out; }
@keyframes crossIn { from { opacity: 0; transform: translateY(-10px) scale(1.6); }
  to { opacity: 1; transform: none; } }
`;

const PARTY_JS = `
var partyRoot = document.getElementById('party');
var cards = [];
for (var i = 0; i < 6; i++) {
  var card = el('div', 'card empty');
  var cross = el('div', 'cross'); cross.textContent = '✝'; card.appendChild(cross);
  var sb = el('div', 'sprite-box'); card.appendChild(sb);
  var nm = el('div', 'nm');
  var nmName = el('span', 'nm-name');
  var star = el('span', 'shiny'); star.textContent = '★'; star.style.display = 'none';
  var lvl = el('span', 'lvl');
  nm.appendChild(nmName); nm.appendChild(star); nm.appendChild(lvl); card.appendChild(nm);
  var hp = el('div', 'hp');
  var fill = el('div', 'hp-fill'); hp.appendChild(fill); card.appendChild(hp);
  partyRoot.appendChild(card);
  cards.push({ root: card, sb: sb, nmName: nmName, star: star, lvl: lvl, fill: fill, key: null });
}
function setSprite(c, m) {
  var key = m.species + '|' + (m.uuid || '');
  if (c.key === key) return;
  c.key = key;
  c.sb.textContent = '';
  var img = spriteImg('sprite', m.species, m.dex);
  (function (box, member) {
    img.addEventListener('error', function () {
      var t = el('div', 'sprite-fallback');
      t.textContent = shortSpecies(member.species);
      box.textContent = '';
      box.appendChild(t);
    });
  })(c.sb, m);
  c.sb.appendChild(img);
}
function render(s) {
  var bySlot = {};
  var i, m;
  for (i = 0; i < s.party.length; i++) {
    m = s.party[i];
    var slot = (m.slot >= 0 && m.slot < 6) ? m.slot : i;
    if (!(slot in bySlot)) bySlot[slot] = m;
  }
  for (i = 0; i < 6; i++) {
    var c = cards[i];
    m = bySlot[i];
    if (!m) {
      c.root.className = 'card empty'; c.key = null; c.sb.textContent = '';
      c.nmName.textContent = ''; c.lvl.textContent = '';
      c.star.style.display = 'none'; c.fill.style.width = '0%';
      continue;
    }
    c.root.className = 'card' + (m.fainted ? ' fainted' : '');
    setSprite(c, m);
    c.nmName.textContent = m.name || shortSpecies(m.species);
    c.star.style.display = m.shiny ? '' : 'none';
    c.lvl.textContent = 'Lv ' + m.level;
    var pct = m.maxHp > 0 ? Math.max(0, Math.min(100, 100 * m.hp / m.maxHp)) : 0;
    if (m.fainted) pct = 0;
    c.fill.style.width = pct + '%';
    c.fill.className = 'hp-fill' + (pct <= 25 ? ' low' : (pct <= 50 ? ' mid' : ''));
  }
}
connect({ state: render });
`;

export const PARTY_HTML = page(
  "party — cobblemon-overlay",
  PARTY_CSS,
  `<div class="wrap"><div class="party" id="party"></div></div>`,
  PARTY_JS,
);

// ---- /overlay/cemetery — the death counter as a graveyard ----
// Headstone per lost Pokémon (name + Lv + mini sprite + cause), grouped by
// attempt plaques, running totals in the header; ?compact=1 = counter only.

const CEMETERY_CSS = `
.cem-header { display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  width: max-content; background: rgba(12,16,24,.85);
  border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,.45); }
.hstone { font-size: 32px; color: #c9d4e0; text-shadow: 0 2px 4px #000; }
.count { font-size: 32px; font-weight: 800; margin-right: 8px; }
.clbl { font-size: 11px; letter-spacing: 3px; color: #9aa4b2; }
.sub { font-size: 12px; color: #9aa4b2; margin-top: 2px; }
.yard { display: flex; flex-direction: column; gap: 14px; padding: 14px 4px; }
body.compact .yard { display: none; }
.plaque { display: inline-block; font-size: 11px; letter-spacing: 2px; color: #d9c896;
  background: rgba(46,38,20,.9); border: 1px solid rgba(217,200,150,.4);
  border-radius: 4px; padding: 2px 10px; margin-bottom: 8px; }
.stones { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.grave { animation: rise .9s cubic-bezier(.18,.9,.24,1.06) both; }
body.noanim .grave { animation: none; }
@keyframes rise { from { transform: translateY(34px); opacity: 0; }
  60% { opacity: 1; } to { transform: none; opacity: 1; } }
.stone { position: relative; width: 96px; padding: 22px 6px 10px; text-align: center;
  color: #1c232b; background: linear-gradient(#93a1af, #5d6873);
  border-radius: 48px 48px 6px 6px;
  box-shadow: inset 0 -6px 10px rgba(0,0,0,.28), 0 2px 5px rgba(0,0,0,.55); }
.gcross { position: absolute; top: 5px; left: 0; right: 0; font-size: 13px; color: #2b333c; }
.gsprite { image-rendering: pixelated; height: 40px; }
.gname { font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.glvl { font-size: 10px; color: #2b333c; }
.mound { height: 6px; margin: 2px -2px 0; background: linear-gradient(#3a4c31, #26331f);
  border-radius: 3px; }
`;

const CEMETERY_JS = `
if (/(^|[?&])compact=1/.test(location.search)) document.body.classList.add('compact');
var rendered = 0;
var firstRender = true;
function stonesFor(attempt) {
  var id = 'attempt-' + attempt;
  var sec = document.getElementById(id);
  if (!sec) {
    sec = el('div', 'attempt-sec');
    sec.id = id;
    var pl = el('div', 'plaque');
    pl.textContent = 'Attempt ' + attempt;
    sec.appendChild(pl);
    sec.appendChild(el('div', 'stones'));
    document.getElementById('yard').appendChild(sec);
  }
  return sec.getElementsByClassName('stones')[0];
}
var causeLabels = { faint: 'fainted', sacrifice: 'sacrificed', duplicate_release: 'released' };
function addStone(m) {
  var g = el('div', 'grave');
  var stone = el('div', 'stone');
  var cr = el('div', 'gcross'); cr.textContent = '✝'; stone.appendChild(cr);
  var img = spriteImg('gsprite', m.species, m.dex);
  img.addEventListener('error', function () { img.remove(); });
  stone.appendChild(img);
  var nm = el('div', 'gname'); nm.textContent = m.name || shortSpecies(m.species);
  stone.appendChild(nm);
  var lv = el('div', 'glvl');
  lv.textContent = 'Lv ' + m.level + ' · ' + (causeLabels[m.cause] || m.cause);
  stone.appendChild(lv);
  g.appendChild(stone);
  g.appendChild(el('div', 'mound'));
  stonesFor(m.attempt).appendChild(g);
}
function render(s) {
  document.getElementById('total').textContent = s.campaign.total;
  document.getElementById('wo').textContent = s.campaign.whiteouts;
  document.getElementById('att').textContent = 'Attempt ' + s.attempt;
  if (s.memorial.length < rendered) {
    document.getElementById('yard').textContent = '';
    rendered = 0;
  }
  if (firstRender) document.body.classList.add('noanim');
  for (var i = rendered; i < s.memorial.length; i++) addStone(s.memorial[i]);
  rendered = s.memorial.length;
  if (firstRender) {
    firstRender = false;
    setTimeout(function () { document.body.classList.remove('noanim'); }, 300);
  }
}
connect({ state: render });
`;

export const CEMETERY_HTML = page(
  "cemetery — cobblemon-overlay",
  CEMETERY_CSS,
  `<div class="wrap">
  <div class="cem-header">
    <div class="hstone">✝</div>
    <div>
      <div><span class="count" id="total">0</span><span class="clbl">FALLEN</span></div>
      <div class="sub"><span id="wo">0</span> whiteouts · <span id="att">Attempt 1</span></div>
    </div>
  </div>
  <div class="yard" id="yard"></div>
</div>`,
  CEMETERY_JS,
);

// ---- /overlay/badges — badge count + current level cap ----

const BADGES_CSS = `
.brow { display: flex; align-items: center; gap: 16px; padding: 12px 18px;
  width: max-content; background: rgba(12,16,24,.85);
  border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,.45); }
.bcell { display: flex; align-items: center; gap: 10px; }
.bico { font-size: 26px; color: #ffd75e; text-shadow: 0 1px 4px #000; }
.big { font-size: 30px; font-weight: 800; line-height: 1; }
.blbl { font-size: 10px; letter-spacing: 3px; color: #9aa4b2; margin-top: 2px; }
.bsep { width: 1px; height: 36px; background: rgba(255,255,255,.18); }
@keyframes pulse { 0% { transform: scale(1); } 40% { transform: scale(1.4); color: #ffd75e; }
  100% { transform: scale(1); } }
.big.pulse { animation: pulse .7s ease; }
`;

const BADGES_JS = `
var lastB = null, lastC = null;
function pulse(elm) { elm.classList.remove('pulse'); void elm.offsetWidth; elm.classList.add('pulse'); }
function render(s) {
  var b = document.getElementById('badges');
  var c = document.getElementById('cap');
  var nb = s.progress.badges, nc = s.progress.levelCap;
  b.textContent = nb;
  c.textContent = nc > 0 ? nc : '–';
  if (lastB !== null && nb !== lastB) pulse(b);
  if (lastC !== null && nc !== lastC) pulse(c);
  lastB = nb; lastC = nc;
}
connect({ state: render });
`;

export const BADGES_HTML = page(
  "badges — cobblemon-overlay",
  BADGES_CSS,
  `<div class="wrap"><div class="brow">
  <div class="bcell"><div class="bico">◈</div>
    <div><div class="big" id="badges">0</div><div class="blbl">BADGES</div></div></div>
  <div class="bsep"></div>
  <div class="bcell"><div><div class="big" id="cap">–</div><div class="blbl">LEVEL CAP</div></div></div>
</div></div>`,
  BADGES_JS,
);

// ---- /overlay/toasts — ~6s animated event cards ----
// loss = red, capture = green, badge = gold, whiteout = full-width slam,
// new-attempt = banner. Driven ONLY by live `game` events (no replay on
// connect, so an OBS refresh never re-fires old toasts).

const TOASTS_CSS = `
.stack { display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
  padding: 10px; width: 100%; }
.toast { display: flex; align-items: center; gap: 12px; max-width: 440px;
  background: rgba(13,17,23,.92); border-left: 6px solid #58a6ff; border-radius: 8px;
  padding: 10px 16px; box-shadow: 0 4px 14px rgba(0,0,0,.5);
  animation: slideIn .45s cubic-bezier(.2,.9,.25,1.15) both; }
.toast.leaving { animation: fadeOut .5s ease both; }
@keyframes slideIn { from { transform: translateX(120%); opacity: 0; }
  to { transform: none; opacity: 1; } }
@keyframes fadeOut { to { transform: translateX(40%); opacity: 0; } }
.tx { min-width: 0; }
.title { font-weight: 700; font-size: 16px; }
.sub { font-size: 12px; color: #9aa4b2; }
.tsprite { image-rendering: pixelated; height: 44px; flex: 0 0 auto; }
.toast.loss { border-left-color: #e5484d; }
.toast.capture { border-left-color: #3ddc68; }
.toast.badge { border-left-color: #ffd75e; }
.toast.cap { border-left-color: #58a6ff; }
.toast.whiteout { width: 100%; max-width: none; justify-content: center;
  border: 2px solid #e5484d; background: rgba(64,12,16,.95);
  font-size: 26px; letter-spacing: 4px;
  animation: slam .5s cubic-bezier(.2,1.4,.3,1) both; }
.toast.whiteout .title { font-size: 26px; }
@keyframes slam { from { transform: scale(2.2); opacity: 0; }
  to { transform: scale(1); opacity: 1; } }
.toast.attempt { width: 100%; max-width: none; justify-content: center;
  border-left-color: #b18cff; background: rgba(38,23,64,.95);
  letter-spacing: 2px; }
.toast.attempt .title { font-size: 20px; }
`;

const TOASTS_JS = `
var stack = document.getElementById('stack');
var causeLabels = { faint: 'fainted', sacrifice: 'was sacrificed', duplicate_release: 'was released (duplicate)' };
function makeToast(cls) {
  var t = el('div', 'toast ' + cls);
  stack.appendChild(t);
  while (stack.children.length > 6) stack.removeChild(stack.firstChild);
  setTimeout(function () {
    t.classList.add('leaving');
    setTimeout(function () { t.remove(); }, 600);
  }, 5500);
  return t;
}
function lines(t, title, sub) {
  var box = el('div', 'tx');
  var a = el('div', 'title');
  a.textContent = title;
  box.appendChild(a);
  if (sub) { var b = el('div', 'sub'); b.textContent = sub; box.appendChild(b); }
  t.appendChild(box);
}
function withSprite(t, p) {
  var img = spriteImg('tsprite', p.species, p.dex);
  img.addEventListener('error', function () { img.remove(); });
  t.appendChild(img);
}
function onGame(ev) {
  var p = ev.pokemon || {};
  var nm = p.name || shortSpecies(p.species || '?');
  if (ev.event === 'pokemon_lost') {
    var t1 = makeToast('loss');
    withSprite(t1, p);
    lines(t1, nm + ' has fallen', 'Lv ' + (p.level || '?') + ' · ' + (causeLabels[ev.cause] || ev.cause));
  } else if (ev.event === 'capture') {
    var t2 = makeToast('capture');
    withSprite(t2, p);
    lines(t2, 'Caught ' + nm + '!', 'Lv ' + (p.level || '?') + (p.shiny ? ' · ★ SHINY' : ''));
  } else if (ev.event === 'badge') {
    lines(makeToast('badge'), 'Badge earned!',
      ev.badges !== undefined ? String(ev.badges) + ' badges' : String(ev.badgeId || ''));
  } else if (ev.event === 'level_cap') {
    lines(makeToast('cap'), 'Level cap: ' + ev.cap, '');
  } else if (ev.event === 'whiteout') {
    lines(makeToast('whiteout'), 'WHITEOUT', '');
  } else if (ev.event === 'new_attempt') {
    lines(makeToast('attempt'), 'ATTEMPT ' + ev.attempt, '');
  }
}
connect({ game: onGame });
`;

export const TOASTS_HTML = page(
  "toasts — cobblemon-overlay",
  TOASTS_CSS,
  `<div class="wrap"><div class="stack" id="stack"></div></div>`,
  TOASTS_JS,
);

// ---- / — tiny index of what's here ----

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>cobblemon-overlay</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 32px; background: #0d1117; color: #c9d1d9;
  font: 14px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
a { color: #58a6ff; }
h1 { font-size: 18px; letter-spacing: 1px; }
</style>
</head>
<body>
<h1>cobblemon-overlay</h1>
<p>OBS browser-source overlays for The Cobblemon Initiative.</p>
<ul>
<li><a href="/overlay/party">/overlay/party</a> — party bar (6 cards, sprites, HP)</li>
<li><a href="/overlay/cemetery">/overlay/cemetery</a> — the graveyard (<a href="/overlay/cemetery?compact=1">?compact=1</a> = counter only)</li>
<li><a href="/overlay/badges">/overlay/badges</a> — badges + level cap</li>
<li><a href="/overlay/toasts">/overlay/toasts</a> — live event toasts</li>
<li><a href="/status">/status</a> — debug view</li>
<li><a href="/api/state.json">/api/state.json</a> — raw state</li>
</ul>
</body>
</html>
`;

// ---- /status — server-rendered debug page (auto-refresh) ----

export interface StatusExtras {
  events: GameView[];
  spriteCount: number;
  tokenConfigured: boolean;
  staleAfterSec: number;
}

export function renderStatusPage(view: PublicState, extra: StatusExtras): string {
  const row = (k: string, v: string) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  const when = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : "never");

  const partyRows = view.party.map((m) =>
    `<tr><td>${m.slot}</td><td>${escapeHtml(m.name || m.species)}</td>` +
    `<td>${escapeHtml(m.species)}</td><td>${m.dex}</td><td>${m.level}</td>` +
    `<td>${m.hp}/${m.maxHp}</td><td>${m.fainted ? "✝" : ""}${m.shiny ? "★" : ""}</td></tr>`
  ).join("");

  const memorialRows = view.memorial.slice(-15).reverse().map((m) =>
    `<tr><td>${m.attempt}</td><td>${escapeHtml(m.name)}</td>` +
    `<td>${escapeHtml(m.species)}</td><td>${m.level}</td>` +
    `<td>${escapeHtml(m.cause)}</td><td>${escapeHtml(when(m.ts))}</td></tr>`
  ).join("");

  const eventRows = extra.events.slice(0, 20).map((e) =>
    `<li><code>${escapeHtml(JSON.stringify(e))}</code></li>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="5" />
<title>status — cobblemon-overlay</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
h1 { font-size: 16px; } h2 { font-size: 14px; margin-top: 24px; }
table { border-collapse: collapse; }
th, td { text-align: left; padding: 3px 12px 3px 0; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-weight: 600; }
.live { color: #56d364; } .stale { color: #ff7b72; }
code { color: #79c0ff; word-break: break-all; }
ul { padding-left: 18px; }
</style>
</head>
<body>
<h1>cobblemon-overlay ${
    view.live
      ? `<span class="live">LIVE</span>`
      : `<span class="stale">STALE</span>`
  }</h1>
<table>
${row("last ingest (server clock)", when(view.lastIngestAt))}
${row("stale after", `${extra.staleAfterSec}s`)}
${row("session", view.session ?? "none")}
${row("attempt", String(view.attempt))}
${row("player", view.player || "?")}
${row("location", view.location || "?")}
${
    row(
      "world",
      view.world ? `day ${view.world.day}, time ${view.world.timeOfDay}, ${view.world.playtimeTicks} ticks` : "?",
    )
  }
${
    row(
      "deaths (save)",
      `${view.deaths.total} total, ${view.deaths.whiteouts} whiteouts, ${view.deaths.sacrifices} sacrifices, ${view.deaths.duplicateReleases} dup releases`,
    )
  }
${
    row(
      "deaths (campaign)",
      `${view.campaign.total} total, ${view.campaign.whiteouts} whiteouts, ${view.campaign.sacrifices} sacrifices, ${view.campaign.duplicateReleases} dup releases`,
    )
  }
${
    row(
      "progress",
      `${view.progress.badges} badges, cap ${view.progress.levelCap} (next ${view.progress.nextLevelCap}), ${view.progress.trainersDefeated} trainers`,
    )
  }
${row("quest", view.quest ? `${view.quest.name} (${view.quest.stage})` : "none")}
${row("memorial entries", String(view.memorial.length))}
${row("sprites", String(extra.spriteCount))}
${row("ingest auth", extra.tokenConfigured ? "token" : "OPEN (no token)")}
</table>
<h2>party</h2>
<table><tr><th>slot</th><th>name</th><th>species</th><th>dex</th><th>lv</th><th>hp</th><th></th></tr>${partyRows}</table>
<h2>memorial (last 15)</h2>
<table><tr><th>attempt</th><th>name</th><th>species</th><th>lv</th><th>cause</th><th>when</th></tr>${memorialRows}</table>
<h2>recent events (newest first)</h2>
<ul>
${eventRows}
</ul>
</body>
</html>
`;
}
