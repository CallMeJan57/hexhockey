// KI-Gegner: verteidigt das eigene Tor und schlägt Pucks weg, die in die eigene Zone kommen.
import { AI_LEVELS, TABLE } from './config.js';
import { alongEdge, depthFrom, fromEdge } from './arena.js';

export function aiTarget(p, sim, dt) {
  const level = AI_LEVELS[p.level] ?? AI_LEVELS[2];
  p.ai.timer -= dt;
  if (p.ai.timer <= 0 || !p.ai.target) {
    p.ai.timer = level.reaction * (0.7 + Math.random() * 0.6);
    p.ai.target = chooseTarget(p, sim, level);
  }
  return { ...p.ai.target, speed: level.speed };
}

function chooseTarget(p, sim, level) {
  const e = p.edge, D = e.zoneDepth, m = p.mallet;
  const noise = () => (Math.random() - 0.5) * level.error;

  let best = null, bestScore = Infinity;
  for (const pk of sim.pucks) {
    if (!pk.active) continue;
    const d = depthFrom(e, pk.x, pk.y);
    const vn = pk.vx * e.n.x + pk.vy * e.n.y;   // > 0: kommt auf mein Tor zu
    let score = d - (vn > 0 ? vn * 0.4 : 0);
    if (vn <= 0 && d > D + 2) score += 20;
    if (score < bestScore) { bestScore = score; best = pk; }
  }
  if (!best) return fromEdge(e, 0, 2);

  const d = depthFrom(e, best.x, best.y);
  const u = alongEdge(e, best.x, best.y);
  const vn = best.vx * e.n.x + best.vy * e.n.y;

  if (d < D + 0.5) {
    const md = depthFrom(e, m.x, m.y);
    if (md < d - 0.3) {
      // Schläger steht zwischen Puck und Tor: durch den Puck hindurchschlagen
      const dx = best.x - m.x, dy = best.y - m.y, len = Math.hypot(dx, dy) || 1;
      return { x: best.x + (dx / len) * 1.4 + noise() * 0.3, y: best.y + (dy / len) * 1.4 + noise() * 0.3 };
    }
    // Erst hinter den Puck kommen
    return fromEdge(e, u * 0.8 + noise(), Math.max(TABLE.malletRadius, d - 2));
  }
  if (vn > 0.5) {
    const defD = Math.min(2.2, D);
    const time = (d - defD) / vn;
    const vu = best.vx * e.t.x + best.vy * e.t.y;
    const lim = e.half + 0.6;
    const pu = Math.max(-lim, Math.min(lim, u + vu * time));
    return fromEdge(e, pu + noise(), defD);
  }
  return fromEdge(e, Math.max(-e.half, Math.min(e.half, u * 0.4)), 2);
}
