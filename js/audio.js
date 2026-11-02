// Geräusche, synthetisch per WebAudio (keine Dateien). iPhone: erst nach einer Berührung freigeschaltet.
let ctx = null, master = null;
const last = {};

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone({ freq, type = 'sine', dur = 0.08, vol = 0.3, slide = 0, at = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function throttled(name, ms) {
  const now = performance.now();
  if (now - (last[name] ?? 0) < ms) return true;
  last[name] = now;
  return false;
}

export const sfx = {
  muted: false,
  hit(s) {
    if (this.muted || throttled('hit', 40)) return;
    tone({ freq: 320 + Math.min(s, 40) * 14, type: 'triangle', dur: 0.07, vol: Math.min(0.4, 0.08 + s * 0.012) });
  },
  wall(s) {
    if (this.muted || s < 1.5 || throttled('wall', 40)) return;
    tone({ freq: 170, type: 'square', dur: 0.04, vol: Math.min(0.12, s * 0.005) });
  },
  serve() {
    if (this.muted) return;
    tone({ freq: 660, type: 'sine', dur: 0.12, vol: 0.15 });
  },
  rescue() {
    if (this.muted) return;
    tone({ freq: 300, type: 'sine', dur: 0.25, vol: 0.15, slide: 2.5 });
  },
  goal() {
    if (this.muted) return;
    tone({ freq: 520, type: 'sawtooth', dur: 0.5, vol: 0.18, slide: 0.45 });
    tone({ freq: 260, type: 'square', dur: 0.35, vol: 0.08, at: 0.05 });
  },
  out() {
    if (this.muted) return;
    [400, 300, 200].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.22, vol: 0.2, at: i * 0.18 }));
  },
  win() {
    if (this.muted) return;
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.3, vol: 0.22, at: i * 0.13 }));
  },
  tick() {
    if (this.muted) return;
    tone({ freq: 880, type: 'sine', dur: 0.08, vol: 0.15 });
  },
};
