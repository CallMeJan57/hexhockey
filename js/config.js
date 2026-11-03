// Alle Spielkonstanten an einer Stelle. Einheiten: Spielfeld-Einheiten (Inkreisradius = 10) und Sekunden.

export const PLAYER_COLORS = [
  { name: 'Rot', hex: 0xff4d5e, css: '#ff4d5e' },
  { name: 'Blau', hex: 0x3fa9ff, css: '#3fa9ff' },
  { name: 'Grün', hex: 0x3ee07a, css: '#3ee07a' },
  { name: 'Gelb', hex: 0xffd23f, css: '#ffd23f' },
  { name: 'Lila', hex: 0xb26bff, css: '#b26bff' },
  { name: 'Orange', hex: 0xff8a3d, css: '#ff8a3d' },
];

export const MAX_PLAYERS = PLAYER_COLORS.length;

export const TABLE = {
  goalWidth: 4.8,
  puckRadius: 0.55,
  malletRadius: 0.95,
  postRadius: 0.34,     // so dick wie die Pfosten aussehen
  railHeight: 0.6,
  railThickness: 0.5,
};

export const PHYSICS = {
  step: 1 / 240,
  malletMaxSpeed: 33,   // Schläger folgen dem Finger, aber nicht schneller als das
  puckMaxSpeed: 35,
  puckMinSpeed: 2.5,
  puckFriction: 0.22,
  wallRestitution: 0.9,
  malletRestitution: 0.95,
  serveSpeed: 7.8,
  serveDelay: 1.4,
  startDelay: 3.2,
  stuckTime: 5,       // so lange darf ein Puck in einem kleinen Bereich hängen …
  stuckRadius: 3,     // … dann kommt er neu in die Mitte
};

export const AI_LEVELS = {
  1: { label: 'leicht', speed: 0.32, reaction: 0.28, error: 1.4 },
  2: { label: 'mittel', speed: 0.46, reaction: 0.14, error: 0.7 },
  3: { label: 'schwer', speed: 0.62, reaction: 0.05, error: 0.25 },
};

export const NET = {
  idPrefix: 'hexhockey-v1-',
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  codeLength: 5,
  stateRate: 30,   // Zustands-Pakete pro Sekunde vom Host
  inputRate: 45,   // Finger-Positionen pro Sekunde von jedem Handy
};

// Der Finger verdeckt sonst den Schläger: Schläger sitzt etwas „über“ dem Finger
export const TOUCH_OFFSET = 1.1;
