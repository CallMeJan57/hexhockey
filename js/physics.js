// Spielsimulation – läuft nur auf dem Host-Handy. Andere Handys bekommen Schnappschüsse (snapshot()).
import { PHYSICS, TABLE } from './config.js';
import { depthFrom, fromEdge } from './arena.js';

const R = TABLE.malletRadius;
const r = TABLE.puckRadius;

export function homePosition(edge) {
  return fromEdge(edge, 0, 1.8);
}

// Schiebt einen Punkt in die Zone eines Spielers: innerhalb aller Banden, nicht tiefer als zoneDepth
export function clampToZone(arena, edge, p) {
  for (let k = 0; k < 3; k++) {
    for (const e of arena.edges) {
      const d = depthFrom(e, p.x, p.y);
      if (d < R) { p.x -= e.n.x * (R - d); p.y -= e.n.y * (R - d); }
    }
    const d = depthFrom(edge, p.x, p.y);
    if (d > arena.zoneDepth) { p.x += edge.n.x * (d - arena.zoneDepth); p.y += edge.n.y * (d - arena.zoneDepth); }
  }
  return p;
}

export class Simulation {
  // players: [{ name, colorIndex, bot, level }], settings: { lives, pucks }
  constructor(arena, players, settings, events = {}) {
    this.arena = arena;
    this.events = events;
    this.players = players.map((p, i) => {
      const edge = arena.edges.find(e => e.owner === i);
      const home = homePosition(edge);
      return {
        ...p, index: i, edge,
        lives: settings.lives, goals: 0, alive: true,
        mallet: { x: home.x, y: home.y, vx: 0, vy: 0 },
        target: null,                    // { x, y, speed } – wohin der Schläger will
        ai: { timer: 0, target: null },
      };
    });
    this.pucks = Array.from({ length: settings.pucks }, (_, i) => ({
      id: i, x: 0, y: 0, vx: 0, vy: 0, active: false, lastTouch: -1,
      timer: (settings.startDelay ?? PHYSICS.startDelay) + i * 0.9,
    }));
    this.acc = 0;
    this.over = false;
    this.winner = null;
    this.ranking = [];   // ausgeschiedene Spieler, zuerst ausgeschieden zuerst
  }

  advance(dt) {
    if (this.over) return;
    this.acc += dt;
    const h = PHYSICS.step;
    let n = 0;
    while (this.acc >= h && n < 60) { this.step(h); this.acc -= h; n++; }
    if (n >= 60) this.acc = 0;
  }

  step(h) {
    for (const p of this.players) if (p.alive) this.moveMallet(p, h);
    this.separateMallets();
    for (const pk of this.pucks) this.updatePuck(pk, h);
    this.collidePucks();
  }

  moveMallet(p, h) {
    const m = p.mallet, px = m.x, py = m.y, t = p.target;
    if (t) {
      const dx = t.x - m.x, dy = t.y - m.y, dist = Math.hypot(dx, dy);
      const maxStep = PHYSICS.malletMaxSpeed * (t.speed ?? 1) * h;
      const k = dist > maxStep ? maxStep / dist : 1;
      m.x += dx * k; m.y += dy * k;
    }
    clampToZone(this.arena, p.edge, m);
    m.vx = (m.x - px) / h;
    m.vy = (m.y - py) / h;
  }

  separateMallets() {
    const alive = this.players.filter(p => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i].mallet, b = alive[j].mallet;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d >= 2 * R || d === 0) continue;
        const push = (2 * R - d) / 2, nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        clampToZone(this.arena, alive[i].edge, a);
        clampToZone(this.arena, alive[j].edge, b);
      }
    }
  }

  updatePuck(pk, h) {
    if (!pk.active) {
      pk.timer -= h;
      if (pk.timer <= 0) this.serve(pk);
      return;
    }
    const f = Math.max(0, 1 - PHYSICS.puckFriction * h);
    pk.vx *= f; pk.vy *= f;
    pk.x += pk.vx * h; pk.y += pk.vy * h;

    for (const p of this.players) {
      if (!p.alive) continue;
      const m = p.mallet;
      const dx = pk.x - m.x, dy = pk.y - m.y, minD = r + R;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
      pk.x = m.x + nx * minD; pk.y = m.y + ny * minD;
      const rvn = (pk.vx - m.vx) * nx + (pk.vy - m.vy) * ny;
      if (rvn < 0) {
        pk.vx -= (1 + PHYSICS.malletRestitution) * rvn * nx;
        pk.vy -= (1 + PHYSICS.malletRestitution) * rvn * ny;
        pk.lastTouch = p.index;
        if (-rvn > 1) this.events.hit?.(-rvn, p.index);
      }
    }

    for (const e of this.arena.edges) {
      if (!e.goalOpen) continue;
      for (const s of [-1, 1]) {
        const px = e.mid.x + e.t.x * e.goalHalf * s, py = e.mid.y + e.t.y * e.goalHalf * s;
        const dx = pk.x - px, dy = pk.y - py, minD = r + TABLE.postRadius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
        pk.x = px + nx * minD; pk.y = py + ny * minD;
        const vn = pk.vx * nx + pk.vy * ny;
        if (vn < 0) {
          pk.vx -= (1 + PHYSICS.wallRestitution) * vn * nx;
          pk.vy -= (1 + PHYSICS.wallRestitution) * vn * ny;
          this.events.wall?.(-vn);
        }
      }
    }

    for (const e of this.arena.edges) {
      const d = depthFrom(e, pk.x, pk.y);
      if (d >= r) continue;
      const u = pk.x * e.t.x + pk.y * e.t.y;
      const inMouth = e.goalOpen && (Math.abs(u) < e.goalHalf || (d < 0 && Math.abs(u) < e.goalHalf + r));
      if (inMouth) {
        if (d < -r * 1.1) { this.goal(e, pk); return; }
        continue;
      }
      pk.x -= e.n.x * (r - d); pk.y -= e.n.y * (r - d);
      const vn = pk.vx * e.n.x + pk.vy * e.n.y;
      if (vn > 0) {
        pk.vx -= (1 + PHYSICS.wallRestitution) * vn * e.n.x;
        pk.vy -= (1 + PHYSICS.wallRestitution) * vn * e.n.y;
        this.events.wall?.(vn);
      }
    }

    const s = Math.hypot(pk.vx, pk.vy);
    if (s > PHYSICS.puckMaxSpeed) {
      pk.vx *= PHYSICS.puckMaxSpeed / s; pk.vy *= PHYSICS.puckMaxSpeed / s;
    } else if (s < PHYSICS.puckMinSpeed) {
      // Kein Puck darf in der Mitte liegen bleiben, wo ihn niemand erreicht
      if (s < 1e-4) { const a = Math.random() * Math.PI * 2; pk.vx = Math.cos(a); pk.vy = Math.sin(a); }
      const k = PHYSICS.puckMinSpeed / Math.hypot(pk.vx, pk.vy);
      pk.vx *= k; pk.vy *= k;
    }
  }

  collidePucks() {
    const act = this.pucks.filter(p => p.active);
    for (let i = 0; i < act.length; i++) {
      for (let j = i + 1; j < act.length; j++) {
        const a = act[i], b = act[j];
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
        if (d >= 2 * r || d === 0) continue;
        const nx = dx / d, ny = dy / d, push = (2 * r - d) / 2;
        a.x += nx * push; a.y += ny * push; b.x -= nx * push; b.y -= ny * push;
        const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (vn < 0) {
          a.vx -= vn * nx; a.vy -= vn * ny; b.vx += vn * nx; b.vy += vn * ny;
          this.events.wall?.(-vn);
        }
      }
    }
  }

  serve(pk) {
    const alive = this.players.filter(p => p.alive);
    const target = alive[Math.floor(Math.random() * alive.length)];
    const ang = Math.atan2(target.edge.mid.y, target.edge.mid.x) + (Math.random() - 0.5) * 0.7;
    pk.x = (Math.random() - 0.5) * 0.6;
    pk.y = (Math.random() - 0.5) * 0.6;
    for (const o of this.pucks) {
      if (o !== pk && o.active && Math.hypot(o.x - pk.x, o.y - pk.y) < 2.5 * r) { pk.x += 3 * r; }
    }
    pk.vx = Math.cos(ang) * PHYSICS.serveSpeed;
    pk.vy = Math.sin(ang) * PHYSICS.serveSpeed;
    pk.active = true;
    pk.lastTouch = -1;
    this.events.serve?.();
  }

  goal(edge, pk) {
    pk.active = false;
    pk.timer = PHYSICS.serveDelay;
    const victim = this.players[edge.owner];
    victim.lives--;
    const scorer = pk.lastTouch >= 0 && pk.lastTouch !== victim.index ? this.players[pk.lastTouch] : null;
    if (scorer) scorer.goals++;
    this.events.goal?.(victim.index, scorer ? scorer.index : -1, pk.x, pk.y);
    if (victim.lives > 0) return;

    victim.alive = false;
    edge.goalOpen = false;
    this.ranking.push(victim.index);
    this.events.eliminated?.(victim.index);
    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive[0] ?? null;
      if (this.winner) this.ranking.push(this.winner.index);
      this.events.win?.(this.winner ? this.winner.index : -1);
    }
  }

  // Kompakter Zustand für die anderen Handys
  snapshot() {
    const q = v => Math.round(v * 100) / 100;
    return {
      m: this.players.map(p => [q(p.mallet.x), q(p.mallet.y)]),
      p: this.pucks.map(pk => [pk.active ? 1 : 0, q(pk.x), q(pk.y), q(pk.vx), q(pk.vy), q(pk.timer), pk.lastTouch]),
      l: this.players.map(p => p.lives),
    };
  }
}
