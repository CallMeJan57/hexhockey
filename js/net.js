// Verbindung zwischen den Handys über WebRTC (PeerJS). Der öffentliche PeerJS-Server vermittelt nur den
// Verbindungsaufbau; danach gehen die Daten direkt von Handy zu Handy (im selben WLAN am schnellsten).
// Peer kommt als globale Variable aus dem <script>-Tag in index.html.
import { NET } from './config.js';

const PING_EVERY = 1500;
const TIMEOUT = 7000;

export function randomCode() {
  let s = '';
  for (let i = 0; i < NET.codeLength; i++) s += NET.codeAlphabet[Math.floor(Math.random() * NET.codeAlphabet.length)];
  return s;
}

export function normalizeCode(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, NET.codeLength);
}

// Host: öffnet einen Raum. Handler: join(id, msg), message(id, msg), leave(id)
export class Host {
  constructor(handlers) {
    this.handlers = handlers;
    this.conns = new Map();   // id → { conn, lastSeen }
    this.peer = null;
    this.code = null;
    this.pinger = setInterval(() => this.heartbeat(), PING_EVERY);
  }

  async open() {
    if (typeof Peer === 'undefined') throw new Error('PeerJS nicht geladen');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      try {
        this.peer = await openPeer(NET.idPrefix + code);
        this.code = code;
        this.peer.on('connection', conn => this.accept(conn));
        this.peer.on('disconnected', () => { if (!this.closed) this.peer.reconnect(); });
        return code;
      } catch (err) {
        if (err.type !== 'unavailable-id') throw err;
      }
    }
    throw new Error('Kein freier Raumcode gefunden');
  }

  accept(conn) {
    conn.on('data', msg => {
      const entry = this.conns.get(conn.peer);
      if (msg.t === 'hello' && !entry) {
        this.conns.set(conn.peer, { conn, lastSeen: performance.now() });
        this.handlers.join?.(conn.peer, msg);
        return;
      }
      if (!entry) return;
      entry.lastSeen = performance.now();
      if (msg.t !== 'ping') this.handlers.message?.(conn.peer, msg);
    });
    conn.on('close', () => this.drop(conn.peer));
    conn.on('error', () => this.drop(conn.peer));
  }

  drop(id) {
    const entry = this.conns.get(id);
    if (!entry) return;
    this.conns.delete(id);
    try { entry.conn.close(); } catch { /* schon zu */ }
    this.handlers.leave?.(id);
  }

  heartbeat() {
    const now = performance.now();
    for (const [id, entry] of this.conns) {
      if (now - entry.lastSeen > TIMEOUT) this.drop(id);
      else this.send(id, { t: 'ping' });
    }
  }

  send(id, msg) {
    const entry = this.conns.get(id);
    if (entry?.conn.open) entry.conn.send(msg);
  }

  broadcast(msg) {
    for (const id of this.conns.keys()) this.send(id, msg);
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    this.broadcast({ t: 'closed' });
    setTimeout(() => this.peer?.destroy(), 200);
  }
}

// Mitspieler: tritt einem Raum bei. Handler: message(msg), close(reason)
export class Client {
  constructor(handlers) {
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;
    this.lastSeen = performance.now();
  }

  async join(code, name) {
    if (typeof Peer === 'undefined') throw new Error('PeerJS nicht geladen');
    this.peer = await openPeer();
    this.id = this.peer.id;
    await new Promise((resolve, reject) => {
      const conn = this.peer.connect(NET.idPrefix + code, { reliable: true, serialization: 'json' });
      const fail = err => reject(err);
      this.peer.once('error', fail);
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      conn.on('open', () => {
        clearTimeout(timer);
        this.peer.off('error', fail);
        this.conn = conn;
        conn.send({ t: 'hello', name });
        resolve();
      });
    });
    this.conn.on('data', msg => {
      this.lastSeen = performance.now();
      if (msg.t === 'closed') this.finish('Der Host hat den Raum geschlossen.');
      else if (msg.t !== 'ping') this.handlers.message?.(msg);
    });
    this.conn.on('close', () => this.finish('Verbindung zum Host verloren.'));
    this.pinger = setInterval(() => {
      if (performance.now() - this.lastSeen > TIMEOUT) this.finish('Verbindung zum Host verloren.');
      else this.send({ t: 'ping' });
    }, PING_EVERY);
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  finish(reason) {
    if (this.done) return;
    this.done = true;
    clearInterval(this.pinger);
    this.handlers.close?.(reason);
    this.peer?.destroy();
  }

  close() {
    this.done = true;
    clearInterval(this.pinger);
    this.peer?.destroy();
  }
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const onError = err => { peer.destroy(); reject(err); };
    peer.once('open', () => { peer.off('error', onError); resolve(peer); });
    peer.once('error', onError);
  });
}
