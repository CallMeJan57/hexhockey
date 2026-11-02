// Geometrie des Spielfelds: ein regelmäßiges Vieleck, jede Seite ist Bande oder Tor eines Spielers.
// Koordinaten (x, y) liegen in der Tischebene; y zeigt auf dem Bildschirm nach unten (Three.js: z).
import { TABLE, zoneDepthFor } from './config.js';

export function createArena(playerCount) {
  let owners;
  if (playerCount === 2) owners = [0, -1, 1, -1];
  else if (playerCount === 3) owners = [0, -1, 1, -1, 2, -1];
  else owners = Array.from({ length: playerCount }, (_, i) => i);

  const sides = owners.length;
  const A = TABLE.apothem;
  const sideLen = 2 * A * Math.tan(Math.PI / sides);
  const goalWidth = Math.min(TABLE.goalWidth, sideLen * 0.5);

  const edges = owners.map((owner, i) => {
    // Seite 0 liegt unten (zur Kamera hin), danach im Uhrzeigersinn auf dem Bildschirm
    const phi = Math.PI / 2 + (i * 2 * Math.PI) / sides;
    const n = { x: Math.cos(phi), y: Math.sin(phi) };      // zeigt nach außen
    const t = { x: -Math.sin(phi), y: Math.cos(phi) };     // entlang der Seite
    const mid = { x: n.x * A, y: n.y * A };
    return {
      index: i, owner, n, t, mid,
      a: { x: mid.x - t.x * sideLen / 2, y: mid.y - t.y * sideLen / 2 },
      b: { x: mid.x + t.x * sideLen / 2, y: mid.y + t.y * sideLen / 2 },
      goalOpen: owner >= 0,
      goalHalf: goalWidth / 2,
    };
  });

  return {
    sides, edges, sideLen, goalWidth,
    apothem: A,
    circumradius: A / Math.cos(Math.PI / sides),
    zoneDepth: zoneDepthFor(playerCount),
  };
}

// Abstand eines Punkts von der Bande nach innen (negativ = hinter der Linie)
export const depthFrom = (edge, x, y) => TABLE.apothem - (x * edge.n.x + y * edge.n.y);

// Position entlang der Seite, 0 = Tormitte
export const alongEdge = (edge, x, y) => x * edge.t.x + y * edge.t.y;

// Umkehrung: Punkt aus (entlang, Tiefe) relativ zu einer Seite
export function fromEdge(edge, u, depth) {
  const k = TABLE.apothem - depth;
  return { x: edge.t.x * u + edge.n.x * k, y: edge.t.y * u + edge.n.y * k };
}
