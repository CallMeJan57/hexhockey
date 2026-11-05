// Spielsimulation – läuft nur auf dem Host-Handy. Andere Handys bekommen Schnappschüsse (snapshot()).
import { PHYSICS, TABLE } from './config.js';
import { MORPH_TIME, alongEdge, buildArena, depthFrom, evenLayout, fromEdge, lerpAngle } from './arena.js';

const R = TABLE.malletRadius;
const r = TABLE.puckRadius;

export function homePosition(edge) {
  return fromEdge(edge, 0, 1.8);
}

// Schiebt einen Punkt in die Zone eines Spielers: innerhalb aller Banden, im eigenen Tortenstück,
// nicht weiter als zoneDepth von der eigenen Torlinie
export function clampToZone(arena, edge, p) {
  for (let k = 0; k < 4; k++) {
    for (const e of arena.edges) {
      const d = depthFrom(e, p.x, p.y);
      if (d < R) { p.x -= e.n.x * (R - d); p.y -= e.n.y * (R - d); }
    }
    const d = depthFrom(edge, p.x, p.y);
    if (d > edge.zoneDepth) { p.x += edge.n.x * (d - edge.zoneDepth); p.y += edge.n.y * (d - edge.zoneDepth); }
    for (const m of edge.planes) {
      const v = p.x * m.x + p.y * m.y;
      if (v > 0) { p.x -= m.x * v; p.y -= m.y * v; }
    }
  }
  return p;
}

export class Simulation {
  // players: [{ name, colorIndex, bot, level }], settings: { mode, lives, minutes, pucks, startDelay? }
  // mode 'lives': jedes Gegentor kostet ein Leben, der Letzte gewinnt.
  // mode 'time': niemand scheidet aus; Punkte = Tore − Gegentore, nach Ablauf der Zeit gewinnt der Beste.
  constructor(players, settings, events = {}) {
    this.events = events;
    this.players = players.map((p, i) => ({
      ...p, index: i, edge: null,
      lives: settings.lives, goals: 0, conceded: 0, alive: true,
      mallet: { x: 0, y: 0, vx: 0, vy: 0 },
      target: null,                    // { x, y, speed } – wohin der Schläger will
      ai: { timer: 0, target: null },
    }));
    this.layout = evenLayout(this.players.map(p => p.index));
    this.setArena(buildArena(this.layout));
    for (const p of this.players) Object.assign(p.mallet, homePosition(p.edge));
    this.pucks = Array.from({ length: settings.pucks }, (_, i) => ({
      id: i, x: 0, y: 0, vx: 0, vy: 0, active: false, lastTouch: -1,
      timer: (settings.startDelay ?? PHYSICS.startDelay) + i * 0.9,
    }));
    this.morph = null;
    this.timed = settings.mode === 'time';
    this.duration = (settings.minutes ?? 3) * 60;
    this.clock = -(settings.startDelay ?? PHYSICS.startDelay);   // negativ = Countdown vor dem Anpfiff
    this.overtime = false;
    this.acc = 0;
    this.over = false;
    this.winner = null;
    this.ranking = [];   // ausgeschiedene Spieler, zuerst ausgeschieden zuerst
  }

  setArena(arena) {
    this.arena = arena;
    for (const p of this.players) p.edge = p.alive ? arena.goalEdges.get(p.index) ?? null : null;
  }

  advance(dt) {
    if (this.over) return;
    this.acc += dt;
    const h = PHYSICS.step;
    let n = 0;
    while (this.acc >= h && n < 60) { this.step(h); this.acc -= h; n++; }
    if (n >= 60) this.acc = 0;
  }

  get timeLeft() {
    return Math.max(0, this.duration - Math.max(0, this.clock));
  }

  step(h) {
    if (this.timed) this.tickClock(h);
    if (this.over) return;
    if (this.morph) this.stepMorph(h);
    for (const p of this.players) if (p.alive) this.moveMallet(p, h);
    this.separateMallets();
    for (const pk of this.pucks) this.updatePuck(pk, h);
    this.collidePucks();
    this.keepPucksSolid();
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
      if (pk.timer <= 0 && !this.morph) this.serve(pk);
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

    for (const post of this.arena.posts) {
      const dx = pk.x - post.x, dy = pk.y - post.y, minD = r + TABLE.postRadius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
      pk.x = post.x + nx * minD; pk.y = post.y + ny * minD;
      const vn = pk.vx * nx + pk.vy * ny;
      if (vn < 0) {
        pk.vx -= (1 + PHYSICS.wallRestitution) * vn * nx;
        pk.vy -= (1 + PHYSICS.wallRestitution) * vn * ny;
        this.events.wall?.(-vn);
      }
    }

    // Schon hinter einer Torlinie? Dann gelten nur noch die Pfosten, bis der Puck ganz drin ist.
    for (const e of this.arena.edges) {
      if (!e.goal) continue;
      const d = depthFrom(e, pk.x, pk.y);
      if (d < 0 && Math.abs(alongEdge(e, pk.x, pk.y)) < e.half + r) {
        if (d < -r * 1.1) this.goal(e, pk);
        return;
      }
    }

    for (const e of this.arena.edges) {
      const d = depthFrom(e, pk.x, pk.y);
      if (d >= r) continue;
      if (e.goal && Math.abs(alongEdge(e, pk.x, pk.y)) < e.half) continue;   // Tormund
      pk.x -= e.n.x * (r - d); pk.y -= e.n.y * (r - d);
      const vn = pk.vx * e.n.x + pk.vy * e.n.y;
      if (vn > 0) {
        pk.vx -= (1 + PHYSICS.wallRestitution) * vn * e.n.x;
        pk.vy -= (1 + PHYSICS.wallRestitution) * vn * e.n.y;
        this.events.wall?.(vn);
      }
    }

    // Hängt der Puck fest (Ecke, Bande, zwischen zwei Schlägern)? Nach stuckTime neu in die Mitte.
    if (!pk.anchor || Math.hypot(pk.x - pk.anchor.x, pk.y - pk.anchor.y) > PHYSICS.stuckRadius) {
      pk.anchor = { x: pk.x, y: pk.y };
      pk.stuck = 0;
    } else if ((pk.stuck += h) > PHYSICS.stuckTime) {
      this.events.rescue?.(pk.x, pk.y);
      pk.active = false;
      pk.timer = 0.7;   // fällt gleich wieder in der Mitte herunter
      return;
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

  // Der Puck ist fest: Drückt ein Schläger ihn gegen die Bande, weicht der Schläger zurück statt den Puck zu schlucken
  keepPucksSolid() {
    const minD = r + R;
    for (const pk of this.pucks) {
      if (!pk.active) continue;
      for (const p of this.players) {
        if (!p.alive) continue;
        const m = p.mallet;
        let dx = m.x - pk.x, dy = m.y - pk.y, d = Math.hypot(dx, dy);
        if (d >= minD) continue;
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
        m.x = pk.x + nx * minD; m.y = pk.y + ny * minD;
        clampToZone(this.arena, p.edge, m);
        dx = pk.x - m.x; dy = pk.y - m.y; d = Math.hypot(dx, dy);
        if (d < minD && d > 1e-6) { pk.x = m.x + dx / d * minD; pk.y = m.y + dy / d * minD; }
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
    pk.anchor = null;
    this.events.serve?.();
  }

  goal(edge, pk) {
    pk.active = false;
    pk.timer = PHYSICS.serveDelay;
    const victim = this.players[edge.owner];
    victim.conceded++;
    const scorer = pk.lastTouch >= 0 && pk.lastTouch !== victim.index ? this.players[pk.lastTouch] : null;
    if (scorer) scorer.goals++;
    this.events.goal?.(victim.index, scorer ? scorer.index : -1, pk.x, pk.y);
    if (this.timed) {
      if (this.overtime) this.decideOnTime();
      return;
    }
    victim.lives--;
    if (victim.lives > 0) return;

    victim.alive = false;
    this.ranking.push(victim.index);
    this.events.eliminated?.(victim.index);
    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive[0] ?? null;
      if (this.winner) this.ranking.push(this.winner.index);
      this.events.win?.(this.winner ? this.winner.index : -1);
      return;
    }

    // Sein Tor verschwindet, die übrigen rücken zusammen. Solange ruhen alle Pucks.
    if (this.morph) this.finishMorph();
    const owners = this.layout.map(g => g.owner).filter(o => o !== victim.index);
    this.morph = { from: this.layout.map(g => ({ ...g })), to: evenLayout(owners, this.layout), owner: victim.index, t: 0 };
    for (const p of this.pucks) { p.active = false; p.timer = PHYSICS.serveDelay; }
  }

  tickClock(h) {
    this.clock += h;
    if (this.clock < this.duration || this.overtime) return;
    if (!this.decideOnTime()) {
      this.overtime = true;   // Gleichstand an der Spitze: weiter, bis einer allein vorne liegt
      this.events.overtime?.();
    }
  }

  // Zeitmodus: steht ein alleiniger Sieger fest, ist das Spiel vorbei
  decideOnTime() {
    const order = standings(this.players);
    const [a, b] = order;
    if (b && points(a) === points(b) && a.goals === b.goals) return false;
    this.over = true;
    this.winner = a;
    this.ranking = order.map(p => p.index).reverse();
    this.events.win?.(a.index);
    return true;
  }

  stepMorph(h) {
    const m = this.morph;
    m.t = Math.min(1, m.t + h / MORPH_TIME);
    if (m.t >= 1) { this.finishMorph(); return; }
    const s = m.t * m.t * (3 - 2 * m.t);
    const goals = m.from.map(g => {
      if (g.owner === m.owner) return { ...g, closing: true, s, half: g.half * (1 - s) };
      const to = m.to.find(x => x.owner === g.owner);
      return { ...g, angle: lerpAngle(g.angle, to.angle, s), radius: g.radius + (to.radius - g.radius) * s };
    });
    // Das verschwindende Tor wandert in die Mitte zwischen seine Nachbarn
    const i = goals.findIndex(g => g.closing), n = goals.length;
    const prev = goals[(i - 1 + n) % n].angle;
    let next = goals[(i + 1) % n].angle;
    while (next <= prev) next += Math.PI * 2;
    goals[i].angle = lerpAngle(m.from[i].angle, (prev + next) / 2, s);
    this.layout = goals;
    this.setArena(buildArena(goals));
  }

  finishMorph() {
    this.layout = this.morph.to;
    this.morph = null;
    this.setArena(buildArena(this.layout));
  }

  // Kompakter Zustand für die anderen Handys
  snapshot() {
    const q = v => Math.round(v * 100) / 100;
    return {
      m: this.players.map(p => [q(p.mallet.x), q(p.mallet.y)]),
      p: this.pucks.map(pk => [pk.active ? 1 : 0, q(pk.x), q(pk.y), q(pk.vx), q(pk.vy), q(pk.timer), pk.lastTouch]),
      l: this.players.map(p => p.lives),
      k: this.players.map(p => [p.goals, p.conceded]),
      ...(this.timed && { c: Math.round(this.timeLeft * 10) / 10, o: this.overtime ? 1 : 0 }),
      g: this.layout.map(g => [g.owner, Math.round(g.angle * 1e4) / 1e4, q(g.half), q(g.radius), g.closing ? Math.round(g.s * 1e3) / 1e3 : -1]),
    };
  }
}

// Zeitmodus-Wertung: Punkte = Tore − Gegentore, bei Gleichstand zählen mehr Tore
export const points = p => p.goals - p.conceded;
export const standings = players => players.slice().sort((a, b) => points(b) - points(a) || b.goals - a.goals);

// Gegenstück zu snapshot().g auf den Mitspieler-Handys
export function layoutFromSnapshot(g) {
  return g.map(([owner, angle, half, radius, s]) => ({ owner, angle, half, radius, closing: s >= 0, s: Math.max(0, s) }));
}
