// Geometrie des Spielfelds. Die Tore liegen gleichmäßig auf einem Kreis; die Banden verbinden die Torpfosten
// direkt miteinander (keine Ecken). Nur bei 2 Spielern wäre das ein schmaler Schlauch – dort bekommt die
// Bande einen Knick nach außen (MIN_CORNER).
// Koordinaten (x, y) liegen in der Tischebene; y zeigt auf dem Bildschirm nach unten (Three.js: z).
import { TABLE } from './config.js';

const TAU = Math.PI * 2;
const MIN_CORNER = 6;          // so weit muss eine Bande mindestens von der Mitte entfernt sein
const ZONE_GAP = 1.5;          // so nah an die Mitte darf ein Schläger
export const MORPH_TIME = 1.6; // Sekunden, die das Feld nach einem Ausscheiden zum Zusammenziehen braucht

// Abstand Mitte → Torlinie: weniger Spieler, kleineres Feld
export function apothemFor(count) {
  return Math.max(8.5, 7 + 0.5 * count);
}

// Tore gleichmäßig verteilt. Mit prev wird so gedreht, dass sich jedes Tor möglichst wenig bewegt.
export function evenLayout(owners, prev = null) {
  const step = TAU / owners.length;
  let offset = Math.PI / 2;   // erstes Tor unten
  if (prev) {
    let s = 0, c = 0;
    owners.forEach((owner, k) => {
      const old = prev.find(g => g.owner === owner);
      if (!old) return;
      s += Math.sin(old.angle - k * step);
      c += Math.cos(old.angle - k * step);
    });
    if (s || c) offset = Math.atan2(s, c);
  }
  const radius = apothemFor(owners.length);
  return owners.map((owner, k) => ({ owner, angle: offset + k * step, half: TABLE.goalWidth / 2, radius }));
}

// goals: [{ owner, angle, half, radius, closing?, s? }] in Winkelreihenfolge. closing = Tor eines
// ausgeschiedenen Spielers, das gerade verschwindet (s: 0 → 1).
export function buildArena(goals) {
  const n = goals.length;
  const posts = goals.map(g => goalPosts(g.angle, g.radius, g.half));
  goals.forEach((g, i) => {
    if (!g.closing) return;
    // Verschwindendes Tor wandert auf die Linie zwischen den Nachbarn
    const prev = posts[(i - 1 + n) % n], next = posts[(i + 1) % n];
    const line = Math.max(MIN_CORNER, lineRadius(prev.b, next.a, g.angle));
    posts[i] = goalPosts(g.angle, g.radius + (line - g.radius) * g.s, g.half);
  });

  const edges = [], verts = [], posts2 = [];
  const pushEdge = (P, Q, props = {}) => {
    const dx = Q.x - P.x, dy = Q.y - P.y, len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const t = { x: dx / len, y: dy / len };
    const nn = { x: t.y, y: -t.x };   // zeigt nach außen
    edges.push({
      a: P, b: Q, t, n: nn, c: nn.x * P.x + nn.y * P.y,
      mid: { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 }, half: len / 2,
      goal: false, owner: -1, ...props,
    });
  };

  goals.forEach((g, i) => {
    const p = posts[i], q = posts[(i + 1) % n];
    verts.push(p.a, p.b);
    if (!g.closing) posts2.push(p.a, p.b);
    pushEdge(p.a, p.b, g.closing ? {} : { goal: true, owner: g.owner, angle: g.angle });
    let next = goals[(i + 1) % n].angle;
    while (next <= g.angle) next += TAU;
    const mid = (g.angle + next) / 2;
    if (lineRadius(p.b, q.a, mid) < MIN_CORNER) {
      const v = { x: Math.cos(mid) * MIN_CORNER, y: Math.sin(mid) * MIN_CORNER };
      verts.push(v);
      pushEdge(p.b, v);
      pushEdge(v, q.a);
    } else {
      pushEdge(p.b, q.a);
    }
  });

  // Spielerzonen: Tortenstück zwischen den Winkelhalbierenden zu den Nachbartoren
  const goalEdges = new Map();
  const open = edges.filter(e => e.goal);
  open.forEach((e, k) => {
    e.zoneDepth = e.c - ZONE_GAP;
    e.planes = open.length < 2 ? [] : [
      bisectorPlane(e, open[(k - 1 + open.length) % open.length]),
      bisectorPlane(e, open[(k + 1) % open.length]),
    ];
    goalEdges.set(e.owner, e);
  });

  return {
    goals, edges, verts, posts: posts2, goalEdges,
    extent: Math.max(...verts.map(v => Math.hypot(v.x, v.y))),
  };
}

function goalPosts(angle, radius, half) {
  const n = { x: Math.cos(angle), y: Math.sin(angle) }, t = { x: -n.y, y: n.x };
  return {
    a: { x: n.x * radius - t.x * half, y: n.y * radius - t.y * half },
    b: { x: n.x * radius + t.x * half, y: n.y * radius + t.y * half },
  };
}

// Abstand von der Mitte, in dem die Gerade P→Q den Strahl im Winkel angle schneidet
function lineRadius(P, Q, angle) {
  const dx = Q.x - P.x, dy = Q.y - P.y, len = Math.hypot(dx, dy) || 1;
  const nx = dy / len, ny = -dx / len;
  const denom = nx * Math.cos(angle) + ny * Math.sin(angle);
  if (denom <= 1e-6) return Infinity;
  return (nx * P.x + ny * P.y) / denom;
}

// Halbebene durch die Mitte: p·m <= 0 ist die Seite von e
function bisectorPlane(e, other) {
  const bx = e.n.x + other.n.x, by = e.n.y + other.n.y, len = Math.hypot(bx, by);
  const dir = len < 1e-6 ? { x: -e.n.y, y: e.n.x } : { x: bx / len, y: by / len };
  let m = { x: -dir.y, y: dir.x };
  if (m.x * e.n.x + m.y * e.n.y > 0) m = { x: -m.x, y: -m.y };
  return m;
}

// Abstand eines Punkts von einer Kante nach innen (negativ = dahinter)
export const depthFrom = (edge, x, y) => edge.c - (x * edge.n.x + y * edge.n.y);

// Position entlang einer Kante, 0 = Mitte (beim Tor: Tormitte)
export const alongEdge = (edge, x, y) => (x - edge.mid.x) * edge.t.x + (y - edge.mid.y) * edge.t.y;

// Umkehrung: Punkt aus (entlang, Tiefe) relativ zu einer Kante
export function fromEdge(edge, u, depth) {
  return {
    x: edge.mid.x + edge.t.x * u - edge.n.x * depth,
    y: edge.mid.y + edge.t.y * u - edge.n.y * depth,
  };
}

export function lerpAngle(a, b, s) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * s;
}
