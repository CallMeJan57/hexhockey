// Ablauf: Startseite → Raum (Lobby) → Spiel → Ende. Das Host-Handy rechnet die Physik und schickt
// Schnappschüsse; jedes Handy zeigt das Feld so gedreht, dass das eigene Tor unten liegt.
import { Renderer } from './render.js';
import { alongEdge, buildArena, depthFrom, evenLayout, fromEdge, zonePolygon } from './arena.js';
import { Simulation, clampToZone, homePosition, layoutFromSnapshot } from './physics.js';
import { aiTarget } from './ai.js';
import { Host, Client, normalizeCode } from './net.js';
import { sfx, unlockAudio } from './audio.js';
import { AI_LEVELS, MAX_PLAYERS, NET, PHYSICS, PLAYER_COLORS, TABLE, TOUCH_OFFSET } from './config.js';

const $ = sel => document.querySelector(sel);
const renderer = new Renderer($('#scene'), $('#labels'));

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`hexhockey.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`hexhockey.${key}`, JSON.stringify(value)); } catch { /* privater Modus */ }
  },
};

let role = null;          // 'host' | 'client' | null (Startseite)
let mode = 'menu';        // 'menu' | 'lobby' | 'play' | 'end'
let host = null, client = null;
let roomCode = '';
let lobby = { players: [], settings: store.get('settings', { lives: 5, pucks: 2 }) };
let sim = null;           // Host-Spiel oder Hintergrund-Demo
let view = null;          // was gezeichnet wird: sim oder das Abbild auf Mitspieler-Handys
let myIndex = -1;
let idToIndex = new Map();
const remoteTargets = new Map();
let evQueue = [];
let eliminated = [];
let lastStateSent = 0, lastInputSent = 0;
const finger = { target: null, pointerId: null, dirty: false };

// ---------- Bildschirme ----------

function show(screen) {
  for (const id of ['home', 'lobby', 'end']) $(`#${id}`).hidden = id !== screen;
  $('#gameUi').hidden = screen !== null;
  if (screen !== null) setPad(false);
  document.body.classList.toggle('playing', screen === null);
}

let bannerTimer = null;
function banner(text, color = '#fff', ms = 1600) {
  const el = $('#banner');
  el.textContent = text;
  el.style.color = color;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function startDemo() {
  const players = PLAYER_COLORS.map((c, i) => ({ name: c.name, colorIndex: i, bot: true, level: 2 }));
  sim = new Simulation(players, { lives: Infinity, pucks: 2, startDelay: 0.3 });
  view = sim;
  myIndex = -1;
  renderer.setup(view, -1, { labels: false });
}

function goHome(error = '') {
  host?.close();
  client?.close();
  host = client = null;
  role = null;
  mode = 'menu';
  roomCode = '';
  history.replaceState(null, '', location.pathname);
  startDemo();
  show('home');
  $('#homeError').textContent = error;
}

// ---------- Startseite ----------

$('#nameInput').value = store.get('name', '');
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('#codeInput').value = normalizeCode(urlRoom);

function playerName() {
  const name = $('#nameInput').value.trim().slice(0, 12) || 'Spieler';
  store.set('name', name);
  return name;
}

$('#codeInput').addEventListener('input', e => { e.target.value = normalizeCode(e.target.value); });
$('#createBtn').addEventListener('click', createRoom);
$('#joinBtn').addEventListener('click', () => joinRoom($('#codeInput').value));
$('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#codeInput').value); });

// ---------- Host ----------

function createRoom() {
  role = 'host';
  mode = 'lobby';
  lobby.players = [{ id: 'host', name: playerName(), colorIndex: 0, bot: false }];
  roomCode = '';
  show('lobby');
  renderLobby();
  host = new Host({ join: onJoin, message: onClientMessage, leave: onLeave });
  host.open().then(code => {
    roomCode = code;
    history.replaceState(null, '', `?room=${code}`);
    renderLobby();
  }).catch(err => {
    console.warn(err);
    $('#roomHint').textContent = 'Keine Verbindung zum Vermittlungs-Server – du kannst nur gegen KI spielen.';
  });
}

function freeColor() {
  const used = new Set(lobby.players.map(p => p.colorIndex));
  return PLAYER_COLORS.findIndex((_, i) => !used.has(i));
}

function onJoin(id, msg) {
  if (mode !== 'lobby') { host.send(id, { t: 'busy' }); setTimeout(() => host.drop(id), 300); return; }
  if (lobby.players.length >= MAX_PLAYERS) { host.send(id, { t: 'full' }); setTimeout(() => host.drop(id), 300); return; }
  const name = String(msg.name ?? '').trim().slice(0, 12) || 'Spieler';
  lobby.players.push({ id, name, colorIndex: freeColor(), bot: false });
  sfx.tick();
  broadcastLobby();
}

function onLeave(id) {
  if (mode === 'lobby') {
    lobby.players = lobby.players.filter(p => p.id !== id);
    broadcastLobby();
    return;
  }
  // Mitten im Spiel übernimmt die KI
  const idx = idToIndex.get(id);
  lobby.players = lobby.players.filter(p => p.id !== id);
  if (idx === undefined || !sim) return;
  const p = sim.players[idx];
  p.bot = true;
  p.level = 2;
  if (p.alive) banner(`${p.name} ist weg – KI übernimmt`, PLAYER_COLORS[p.colorIndex].css, 2200);
}

function onClientMessage(id, msg) {
  if (msg.t === 'in') {
    const idx = idToIndex.get(id);
    if (idx === undefined) return;
    remoteTargets.set(idx, msg.x == null ? null : { x: msg.x, y: msg.y });
  }
}

function broadcastLobby() {
  host?.broadcast({ t: 'lobby', code: roomCode, players: lobby.players, settings: lobby.settings });
  renderLobby();
}

$('#addBot').addEventListener('click', () => {
  if (lobby.players.length >= MAX_PLAYERS) return;
  const colorIndex = freeColor();
  lobby.players.push({ id: `bot-${Date.now()}`, name: `KI ${PLAYER_COLORS[colorIndex].name}`, colorIndex, bot: true, level: 2 });
  broadcastLobby();
});

for (const key of ['lives', 'pucks']) {
  $(`#${key}`).addEventListener('change', e => {
    lobby.settings[key] = Number(e.target.value);
    store.set('settings', lobby.settings);
    broadcastLobby();
  });
}

$('#startBtn').addEventListener('click', startGame);
$('#leaveLobby').addEventListener('click', () => goHome());

function startGame() {
  if (role !== 'host' || lobby.players.length < 2) return;
  const players = lobby.players.map(p => ({ name: p.name, colorIndex: p.colorIndex, bot: p.bot, level: p.level ?? 2 }));
  sim = new Simulation(players, lobby.settings, hostEvents);
  idToIndex = new Map(lobby.players.map((p, i) => [p.id, i]));
  remoteTargets.clear();
  evQueue = [];
  const pub = players.map(({ name, colorIndex }) => ({ name, colorIndex }));
  for (const [id, i] of idToIndex) {
    if (id !== 'host' && !lobby.players[i].bot) host.send(id, { t: 'start', players: pub, settings: lobby.settings, you: i });
  }
  enterGame(sim, 0);
}

// Spielereignisse: auf dem Host sofort abspielen und gesammelt an alle schicken
const emit = ev => { evQueue.push(ev); handleEvent(ev); };
const hostEvents = {
  hit: (s, i) => emit(['h', Math.round(s), i]),
  wall: s => emit(['w', Math.round(s)]),
  serve: () => emit(['s']),
  goal: (victim, scorer, x, y) => emit(['g', victim, scorer, Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
  eliminated: i => emit(['x', i]),
  win: i => emit(['v', i]),
};

// ---------- Mitspieler ----------

async function joinRoom(raw) {
  const code = normalizeCode(raw);
  if (code.length !== NET.codeLength) { $('#homeError').textContent = `Der Code hat ${NET.codeLength} Zeichen.`; return; }
  $('#homeError').textContent = 'Verbinde …';
  role = 'client';
  roomCode = code;
  client = new Client({ message: onHostMessage, close: reason => goHome(reason) });
  try {
    await client.join(code, playerName());
    $('#homeError').textContent = '';
  } catch (err) {
    console.warn(err);
    goHome(err?.type === 'peer-unavailable' ? `Raum ${code} nicht gefunden.` : 'Verbindung fehlgeschlagen.');
  }
}

function onHostMessage(msg) {
  switch (msg.t) {
    case 'lobby':
      lobby = { players: msg.players, settings: msg.settings };
      roomCode = msg.code || roomCode;
      if (mode !== 'lobby') {
        mode = 'lobby';
        startDemo();
        show('lobby');
      }
      renderLobby();
      break;
    case 'start':
      enterGame(makeReplica(msg), msg.you);
      break;
    case 's':
      if (mode === 'play' || mode === 'end') applySnapshot(msg);
      break;
    case 'busy':
      client.finish('Dort läuft gerade ein Spiel – warte bis zur nächsten Runde.');
      break;
    case 'full':
      client.finish('Der Raum ist voll (6 Spieler).');
      break;
  }
}

function makeReplica(msg) {
  const arena = buildArena(evenLayout(msg.players.map((_, i) => i)));
  const players = msg.players.map((p, i) => {
    const edge = arena.goalEdges.get(i);
    const h = homePosition(edge);
    return { ...p, index: i, edge, lives: msg.settings.lives, alive: true, mallet: { ...h }, net: { ...h } };
  });
  const pucks = Array.from({ length: msg.settings.pucks }, () => ({
    active: false, x: 0, y: 0, vx: 0, vy: 0, timer: PHYSICS.startDelay, lastTouch: -1, net: null, netTime: 0,
  }));
  return { arena, layoutKey: '', players, pucks };
}

function applySnapshot(s) {
  const now = performance.now();
  view.players.forEach((p, i) => {
    p.net = { x: s.m[i][0], y: s.m[i][1] };
    p.lives = s.l[i];
    p.alive = p.lives > 0;
  });
  // Feldform (ändert sich, wenn jemand ausscheidet)
  const key = JSON.stringify(s.g);
  if (key !== view.layoutKey) {
    view.layoutKey = key;
    view.arena = buildArena(layoutFromSnapshot(s.g));
  }
  for (const p of view.players) p.edge = p.alive ? view.arena.goalEdges.get(p.index) ?? null : null;
  view.pucks.forEach((pk, i) => {
    const [active, x, y, vx, vy, timer, lastTouch] = s.p[i];
    const jump = !pk.active || !pk.net || Math.hypot(x - pk.x, y - pk.y) > 3;
    pk.active = active === 1;
    pk.net = { x, y, vx, vy };
    pk.netTime = now;
    pk.timer = timer;
    pk.lastTouch = lastTouch;
    if (pk.active && jump) { pk.x = x; pk.y = y; }
  });
  for (const ev of s.ev ?? []) handleEvent(ev);
}

function updateReplica(dt) {
  const now = performance.now();
  const km = 1 - Math.exp(-dt * 22), kp = 1 - Math.exp(-dt * 30);
  for (const p of view.players) {
    p.mallet.x += (p.net.x - p.mallet.x) * km;
    p.mallet.y += (p.net.y - p.mallet.y) * km;
  }
  for (const pk of view.pucks) {
    if (!pk.active) { pk.timer -= dt; continue; }
    if (!pk.net) continue;
    const age = Math.min(now - pk.netTime, 120) / 1000;   // kurz in die Zukunft rechnen
    pk.x += (pk.net.x + pk.net.vx * age - pk.x) * kp;
    pk.y += (pk.net.y + pk.net.vy * age - pk.y) * kp;
  }
}

// Auf Mitspieler-Handys kommen Puck und Schläger getrennt geglättet an – damit der Puck nie im Schläger
// steckt, wird er für die Anzeige herausgeschoben (die echte Physik läuft auf dem Host)
function keepPucksOutside(overrides) {
  const minD = TABLE.puckRadius + TABLE.malletRadius;
  for (const pk of view.pucks) {
    if (!pk.active) continue;
    view.players.forEach((p, i) => {
      if (!p.alive) return;
      const m = i === overrides.ownIndex && overrides.ownMallet ? overrides.ownMallet : p.mallet;
      const dx = pk.x - m.x, dy = pk.y - m.y, d = Math.hypot(dx, dy);
      if (d >= minD || d < 1e-6) return;
      pk.x = m.x + dx / d * minD;
      pk.y = m.y + dy / d * minD;
    });
  }
}

// ---------- Spiel ----------

let countdown = [];
function enterGame(v, index) {
  view = v;
  myIndex = index;
  mode = 'play';
  eliminated = [];
  finger.target = null;
  finger.pointerId = null;
  renderer.setup(view, myIndex);
  show(null);
  setPad(IS_TOUCH);
  requestWakeLock();
  countdown.forEach(clearTimeout);
  const me = view.players[myIndex];
  banner('Dein Tor ist unten', PLAYER_COLORS[me.colorIndex].css, 1000);
  const steps = PHYSICS.startDelay;
  countdown = [3, 2, 1].map((n, i) => setTimeout(() => { banner(String(n), '#fff', 800); sfx.tick(); }, (steps - 3 + i) * 1000))
    .concat(setTimeout(() => banner('Los!', '#fff', 700), steps * 1000));
}

function handleEvent(ev) {
  if (sim && view === sim && myIndex === -1) return;   // Hintergrund-Demo bleibt stumm
  const name = i => view.players[i]?.name ?? '?';
  const color = i => PLAYER_COLORS[view.players[i]?.colorIndex ?? 0].css;
  switch (ev[0]) {
    case 'h': sfx.hit(ev[1]); break;
    case 'w': sfx.wall(ev[1]); break;
    case 's': sfx.serve(); break;
    case 'g': {
      const [, victim, scorer, x, y] = ev;
      sfx.goal();
      renderer.goalEffect(victim, x, y);
      if (victim === myIndex && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(250);
      const text = victim === myIndex ? 'Gegentor!' : scorer >= 0 ? `${name(scorer)} trifft ${name(victim)}` : `Tor gegen ${name(victim)}`;
      banner(text, color(victim));
      break;
    }
    case 'x':
      eliminated.push(ev[1]);
      sfx.out();
      banner(ev[1] === myIndex ? 'Du bist raus!' : `${name(ev[1])} ist raus!`, color(ev[1]), 2000);
      break;
    case 'v':
      sfx.win();
      setTimeout(() => showEnd(ev[1]), 1500);
      break;
  }
}

function showEnd(winner) {
  mode = 'end';
  const order = [winner, ...eliminated.slice().reverse()].filter(i => i >= 0);
  const list = $('#ranking');
  list.innerHTML = '';
  order.forEach((i, place) => {
    const p = view.players[i];
    const li = document.createElement('li');
    li.style.setProperty('--c', PLAYER_COLORS[p.colorIndex].css);
    li.innerHTML = '<span class="place"></span><span class="dot"></span><span class="name"></span>';
    li.querySelector('.place').textContent = `${place + 1}.`;
    li.querySelector('.name').textContent = p.name + (i === myIndex ? ' (du)' : '');
    list.append(li);
  });
  const w = view.players[winner];
  $('#winner').textContent = winner === myIndex ? 'Du gewinnst!' : `${w?.name ?? 'Niemand'} gewinnt!`;
  $('#winner').style.color = w ? PLAYER_COLORS[w.colorIndex].css : '#fff';
  $('#endHost').hidden = role !== 'host';
  $('#endClient').hidden = role === 'host';
  show('end');
}

$('#againBtn').addEventListener('click', startGame);
$('#toLobbyBtn').addEventListener('click', backToLobby);
$('#endLeaveBtn').addEventListener('click', () => goHome());
$('#quitBtn').addEventListener('click', () => {
  if (role === 'host') { if (confirm('Spiel für alle abbrechen?')) backToLobby(); }
  else if (confirm('Spiel verlassen?')) goHome();
});

function backToLobby() {
  mode = 'lobby';
  countdown.forEach(clearTimeout);
  // Wer während des Spiels gegangen ist, ist schon aus der Liste; KI-Ersatz gibt es nur im laufenden Spiel
  startDemo();
  show('lobby');
  broadcastLobby();
}

// ---------- Lobby-Anzeige ----------

function renderLobby() {
  const isHost = role === 'host';
  $('#roomCode').textContent = roomCode || '· · · · ·';
  const qr = $('#qr');
  qr.innerHTML = '';
  if (isHost && roomCode && typeof qrcode !== 'undefined') {
    const q = qrcode(0, 'M');
    q.addData(`${location.origin}${location.pathname}?room=${roomCode}`);
    q.make();
    qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  if (roomCode) {
    $('#roomHint').textContent = isHost
      ? 'Mitspieler öffnen das Spiel und geben den Code ein – oder scannen den QR-Code.'
      : 'Du bist im Raum. Warte, bis der Host startet.';
  } else if (isHost) {
    $('#roomHint').textContent = 'Raum wird geöffnet …';
  }

  const list = $('#playerList');
  list.innerHTML = '';
  lobby.players.forEach(p => {
    const li = document.createElement('li');
    li.style.setProperty('--c', PLAYER_COLORS[p.colorIndex].css);
    li.innerHTML = '<span class="dot"></span><span class="name"></span><span class="tag"></span>';
    li.querySelector('.name').textContent = p.name;
    const tag = li.querySelector('.tag');
    const me = (isHost && p.id === 'host') || (!isHost && client && p.id === client.id);
    if (p.bot && isHost) {
      const sel = document.createElement('select');
      for (const [lvl, l] of Object.entries(AI_LEVELS)) sel.add(new Option(`KI ${l.label}`, lvl, false, Number(lvl) === p.level));
      sel.addEventListener('change', () => { p.level = Number(sel.value); broadcastLobby(); });
      const rm = document.createElement('button');
      rm.className = 'icon';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'KI entfernen');
      rm.addEventListener('click', () => { lobby.players = lobby.players.filter(x => x !== p); broadcastLobby(); });
      tag.append(sel, rm);
    } else {
      tag.textContent = p.bot ? `KI ${AI_LEVELS[p.level]?.label ?? ''}` : p.id === 'host' ? (me ? 'Host · du' : 'Host') : me ? 'du' : '';
    }
    list.append(li);
  });
  for (let i = lobby.players.length; i < MAX_PLAYERS; i++) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'frei';
    list.append(li);
  }

  $('#hostControls').hidden = !isHost;
  $('#clientInfo').hidden = isHost;
  $('#lives').value = String(lobby.settings.lives);
  $('#pucks').value = String(lobby.settings.pucks);
  $('#addBot').disabled = lobby.players.length >= MAX_PLAYERS;
  $('#startBtn').disabled = lobby.players.length < 2;
  $('#startBtn').textContent = lobby.players.length < 2 ? 'Mindestens 2 Spieler' : `Spiel starten (${lobby.players.length})`;
  $('#clientInfo').textContent = `${lobby.settings.lives} Leben · ${lobby.settings.pucks} ${lobby.settings.pucks === 1 ? 'Puck' : 'Pucks'} – warte auf den Host …`;
}

// ---------- Finger / Maus ----------

const canvas = $('#scene');
function pointerTarget(e) {
  const p = renderer.pickTable(e.clientX, e.clientY);
  if (!p) return;
  if (e.pointerType !== 'mouse') {
    const up = renderer.screenUp();
    p.x += up.x * TOUCH_OFFSET;
    p.y += up.y * TOUCH_OFFSET;
  }
  finger.target = p;
  finger.dirty = true;
}
canvas.addEventListener('pointerdown', e => {
  if (mode !== 'play') return;
  finger.pointerId = e.pointerId;
  pointerTarget(e);
});
canvas.addEventListener('pointermove', e => {
  if (mode !== 'play') return;
  if (e.pointerType === 'mouse' || e.pointerId === finger.pointerId) pointerTarget(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, e => { if (e.pointerId === finger.pointerId) finger.pointerId = null; });
}
addEventListener('pointerdown', unlockAudio, { capture: true });
addEventListener('keydown', unlockAudio, { capture: true });

// ---------- Touch-Feld ----------
// Auf Handys liegt unter dem Spielfeld ein eigenes Feld zum Steuern. Es zeigt die eigene Zone als Karte:
// oben auf dem Feld = vorne in der Zone, unten = vor dem eigenen Tor.

const IS_TOUCH = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('pad');
const pad = { on: false, used: false, map: null, pointerId: null, canvas: $('#padCanvas') };

function setPad(on) {
  if (pad.on === on) return;
  pad.on = on;
  pad.map = null;
  $('#pad').hidden = !on;
  document.body.classList.toggle('with-pad', on);
}

function drawPad(me, ownMallet) {
  const c = pad.canvas, dpr = Math.min(devicePixelRatio, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const e = me.edge;
  const local = p => ({ u: alongEdge(e, p.x, p.y), d: depthFrom(e, p.x, p.y) });
  const zone = zonePolygon(view.arena, e).map(local);
  if (zone.length < 3) return;
  const umin = Math.min(...zone.map(p => p.u)), umax = Math.max(...zone.map(p => p.u));
  const dmax = Math.max(...zone.map(p => p.d));
  const margin = 12;
  const scale = Math.min((w - 2 * margin) / (umax - umin), (h - 2 * margin) / dmax);
  const ox = (w - (umax - umin) * scale) / 2, oy = (h - dmax * scale) / 2;
  pad.map = { edge: e, umax, dmax, scale, ox, oy };
  // u wächst auf dem Bildschirm nach links, deshalb gespiegelt
  const px = (u, d) => [ox + (umax - u) * scale, oy + (dmax - d) * scale];
  const color = PLAYER_COLORS[me.colorIndex].css;

  ctx.beginPath();
  zone.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...px(p.u, p.d)));
  ctx.closePath();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Eigenes Tor unten
  ctx.globalAlpha = 1;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(...px(e.half, 0));
  ctx.lineTo(...px(-e.half, 0));
  ctx.stroke();

  for (const pk of view.pucks) {
    if (!pk.active) continue;
    const q = local(pk);
    if (q.d > dmax + 1 || q.u < umin - 1 || q.u > umax + 1) continue;
    ctx.beginPath();
    ctx.arc(...px(q.u, q.d), TABLE.puckRadius * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#e8f4ff';
    ctx.fill();
  }
  const m = local(ownMallet);
  ctx.beginPath();
  ctx.arc(...px(m.u, m.d), TABLE.malletRadius * scale, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (!pad.used) {
    ctx.fillStyle = 'rgba(233,238,247,0.55)';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Hier wischen – dein Schläger folgt', w / 2, h - 14);
  }
}

function padTarget(e) {
  const m = pad.map;
  if (!m) return;
  const rect = pad.canvas.getBoundingClientRect();
  const u = m.umax - (e.clientX - rect.left - m.ox) / m.scale;
  const d = m.dmax - (e.clientY - rect.top - m.oy) / m.scale;
  finger.target = fromEdge(m.edge, u, d);
  finger.dirty = true;
}
pad.canvas.addEventListener('pointerdown', e => {
  if (mode !== 'play') return;
  pad.pointerId = e.pointerId;
  pad.used = true;
  pad.canvas.setPointerCapture?.(e.pointerId);
  padTarget(e);
});
pad.canvas.addEventListener('pointermove', e => {
  if (mode === 'play' && e.pointerId === pad.pointerId) padTarget(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  pad.canvas.addEventListener(type, e => { if (e.pointerId === pad.pointerId) pad.pointerId = null; });
}

// ---------- Display wach halten ----------

let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht unterstützt */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode === 'play' && !wakeLock) requestWakeLock();
  if (document.visibilityState === 'hidden') wakeLock = null;
});

// ---------- Hauptschleife ----------

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (view === sim && sim) {
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (p.bot) p.target = aiTarget(p, sim, dt);
      else if (p.index === myIndex) p.target = finger.target;
      else p.target = remoteTargets.get(p.index) ?? null;
    }
    sim.advance(dt);
    if (role === 'host' && (mode === 'play' || mode === 'end') && now - lastStateSent > 1000 / NET.stateRate) {
      lastStateSent = now;
      if (host?.conns.size) host.broadcast({ t: 's', ...sim.snapshot(), ev: evQueue });
      evQueue = [];
    }
  } else if (view) {
    updateReplica(dt);
    if (finger.dirty && now - lastInputSent > 1000 / NET.inputRate) {
      lastInputSent = now;
      finger.dirty = false;
      const q = v => Math.round(v * 100) / 100;
      client?.send({ t: 'in', x: q(finger.target.x), y: q(finger.target.y) });
    }
  }

  // Eigener Schläger auf Mitspieler-Handys sofort am Finger (die Physik kommt kurz danach vom Host)
  const overrides = {};
  const me = view?.players[myIndex];
  if (view !== sim && me?.edge && finger.target) {
    overrides.ownIndex = myIndex;
    overrides.ownMallet = clampToZone(view.arena, me.edge, { ...finger.target });
  }
  if (view && view !== sim) keepPucksOutside(overrides);
  if (pad.on) {
    if (me?.edge && mode === 'play') drawPad(me, overrides.ownMallet ?? me.mallet);
    else if (!me?.alive) setPad(false);   // ausgeschieden: ganzer Bildschirm fürs Zuschauen
  }
  if (view) renderer.update(view, dt, overrides);
  requestAnimationFrame(frame);
}

goHome();
if (urlRoom) $('#nameInput').focus();
requestAnimationFrame(frame);
