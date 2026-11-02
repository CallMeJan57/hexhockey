// 3D-Darstellung mit Three.js. Zeichnet einen „View“ – die Simulation auf dem Host oder deren Abbild auf
// den anderen Handys: { arena, players: [{ name, colorIndex, alive, lives, mallet, edge }], pucks: [...] }.
// Der Tisch wird neu gebaut, sobald sich view.arena ändert (z. B. wenn das Feld nach einem Ausscheiden schrumpft).
import * as THREE from 'three';
import { PLAYER_COLORS, TABLE } from './config.js';

const CAMERA_TILT = 0.32;   // 0 = genau von oben
const GOAL_DEPTH = 1.5;     // Tiefe des Torkastens hinter der Torlinie
const SINK = 0.3;           // so tief liegt der Boden des Torkastens

export class Renderer {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090f);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);

    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x10131c, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(6, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 60 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.mats = {
      body: new THREE.MeshStandardMaterial({ color: 0x0c111b, roughness: 0.8 }),
      surface: new THREE.MeshStandardMaterial({ map: holeTexture(), roughness: 0.32, metalness: 0.08 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x1d2536, metalness: 0.55, roughness: 0.3 }),
      line: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }),
    };
    this.netTexture = netTexture();

    // Mittelkreis bleibt immer gleich
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.09, 72).rotateX(-Math.PI / 2), this.mats.line);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24).rotateX(-Math.PI / 2), this.mats.line);
    ring.position.y = dot.position.y = 0.012;
    this.scene.add(ring, dot);

    this.raycaster = new THREE.Raycaster();
    this.tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.table = null;
    this.builtArena = null;
    this.dynamic = new THREE.Group();   // Schläger + Pucks
    this.scene.add(this.dynamic);
    this.playerMats = [];
    this.particles = [];
    this.flash = [];
    this.shake = 0;
    this.viewDir = new THREE.Vector2(0, 1);
    this.fitRadius = 14;
    this.fitTarget = 14;

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Neues Spiel. myIndex: eigener Spieler (sein Tor liegt unten), -1 = Zuschauer
  setup(view, myIndex = -1, { labels = true } = {}) {
    for (const p of this.particles) { this.scene.remove(p.points); disposeTree(p.points, true); }
    this.particles = [];
    disposeTree(this.dynamic, true);
    this.dynamic.clear();
    for (const set of this.playerMats) for (const m of Object.values(set)) m.dispose();

    this.myIndex = myIndex;
    this.playerMats = view.players.map(p => playerMaterials(PLAYER_COLORS[p.colorIndex].hex, this.netTexture));
    this.flash = view.players.map(() => 0);
    this.mallets = view.players.map(p => {
      const m = mallet(PLAYER_COLORS[p.colorIndex].hex);
      this.dynamic.add(m);
      return m;
    });
    this.puckMeshes = view.pucks.map(() => {
      const pm = puck();
      this.dynamic.add(pm);
      return pm;
    });
    this.setupLabels(view, labels);
    this.buildTable(view);

    const me = view.players[myIndex];
    const n = me?.edge ? me.edge.n : { x: 0, y: 1 };
    this.viewDir.set(n.x, n.y);
    this.fitRadius = this.fitTarget;
    this.resize();
  }

  buildTable(view) {
    if (this.table) { this.scene.remove(this.table); disposeTree(this.table, false); }
    const arena = this.builtArena = view.arena;
    const g = this.table = new THREE.Group();
    this.scene.add(g);
    const shape = new THREE.Shape(arena.verts.map(v => new THREE.Vector2(v.x, -v.y)));

    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false }).rotateX(-Math.PI / 2), this.mats.body);
    body.position.y = -1.2;
    const surface = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), this.mats.surface);
    surface.position.y = 0.001;
    surface.receiveShadow = true;
    g.add(body, surface);

    for (const e of arena.edges) {
      if (e.goal) g.add(this.goal(e, this.playerMats[e.owner]));
      else g.add(rail(e.a, e.b, e.n, this.mats.rail));
    }
    // Stöße zwischen zwei Banden abdecken (Torpfosten haben eigene Säulen)
    const T = TABLE.railThickness, H = TABLE.railHeight;
    for (const v of arena.verts) {
      if (arena.posts.includes(v)) continue;
      const len = Math.hypot(v.x, v.y) || 1;
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.75, T * 0.75, H, 20), this.mats.rail);
      joint.position.set(v.x + v.x / len * T * 0.45, H / 2, v.y + v.y / len * T * 0.45);
      joint.castShadow = true;
      g.add(joint);
    }

    // Spielerzonen (Tortenstücke) mit Rand
    for (const e of arena.edges) {
      if (!e.goal) continue;
      const mats = this.playerMats[e.owner];
      let poly = clipHalfPlane(arena.verts, e.n, e.c - e.zoneDepth);
      for (const m of e.planes) poly = clipHalfPlane(poly, { x: -m.x, y: -m.y }, 0);
      if (poly.length < 3) continue;
      const zone = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(poly.map(v => new THREE.Vector2(v.x, -v.y)))).rotateX(-Math.PI / 2),
        mats.zone,
      );
      zone.position.y = 0.006;
      g.add(zone);
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length];
        const onRail = arena.edges.some(k => Math.abs(k.c - (p.x * k.n.x + p.y * k.n.y)) < 1e-5 && Math.abs(k.c - (q.x * k.n.x + q.y * k.n.y)) < 1e-5);
        if (!onRail) g.add(strip(p, q, 0.06, mats.zoneLine, 0.014));
      });
    }

    this.fitTarget = arena.extent + GOAL_DEPTH + 1.2;
  }

  // Torkasten: leuchtende Pfosten, versenkter Boden, Seitenwände mit Leuchtkante, Netz an der Rückwand
  goal(e, mats) {
    const T = TABLE.railThickness, H = TABLE.railHeight, w = e.half * 2;
    const g = new THREE.Group();
    g.position.set(e.mid.x, 0, e.mid.y);
    g.rotation.y = Math.atan2(-e.t.y, e.t.x);   // lokal: x entlang der Torlinie, -z nach außen
    const add = (geo, mat, x, y, z, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      g.add(m);
      return m;
    };
    const wallH = H + SINK, wallY = (H - SINK) / 2, sideX = e.half + T * 0.35;

    add(new THREE.BoxGeometry(w + T, 0.05, GOAL_DEPTH), mats.floor, 0, -SINK, -GOAL_DEPTH / 2, false);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(T * 0.7, wallH, GOAL_DEPTH), this.mats.rail, s * sideX, wallY, -GOAL_DEPTH / 2);
      add(new THREE.BoxGeometry(0.09, 0.07, GOAL_DEPTH), mats.neon, s * sideX, H + 0.03, -GOAL_DEPTH / 2, false);
      // Pfosten mit runder Kappe
      add(new THREE.CylinderGeometry(0.24, 0.24, H + 0.1, 20), mats.post, s * e.half, (H + 0.1) / 2, 0);
      add(new THREE.SphereGeometry(0.24, 20, 10), mats.post, s * e.half, H + 0.1, 0);
    }
    add(new THREE.BoxGeometry(w + T * 1.4, wallH, T * 0.7), this.mats.rail, 0, wallY, -GOAL_DEPTH - T * 0.35);
    add(new THREE.BoxGeometry(w + T * 1.4, 0.07, 0.09), mats.neon, 0, H + 0.03, -GOAL_DEPTH - T * 0.35, false);
    const net = add(new THREE.PlaneGeometry(w, wallH - 0.05), mats.net, 0, wallY, -GOAL_DEPTH + 0.01, false);
    net.renderOrder = 1;
    add(new THREE.BoxGeometry(w, 0.01, 0.14), mats.neon, 0, 0.016, 0, false);   // Torlinie
    return g;
  }

  setupLabels(view, show) {
    this.labelsEl.innerHTML = '';
    this.labels = view.players.map(p => {
      const el = document.createElement('div');
      el.className = 'label';
      el.style.setProperty('--c', PLAYER_COLORS[p.colorIndex].css);
      el.hidden = true;
      this.labelsEl.append(el);
      return { el, key: '', show };
    });
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.placeCamera();
  }

  placeCamera() {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(this.fitRadius / tan, this.fitRadius / (tan * this.camera.aspect));
    const dir = new THREE.Vector3(this.viewDir.x * CAMERA_TILT, 1, this.viewDir.y * CAMERA_TILT).normalize();
    this.basePos = dir.multiplyScalar(dist);
    this.camera.position.copy(this.basePos);
    this.camera.up.set(-this.viewDir.x, 0, -this.viewDir.y);   // eigene Seite unten
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  // Bildschirmpunkt → Punkt auf dem Tisch (Spielfeld-Koordinaten)
  pickTable(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.tablePlane, hit)) return null;
    return { x: hit.x, y: hit.z };
  }

  // Richtung „auf dem Bildschirm nach oben“ in Spielfeld-Koordinaten
  screenUp() {
    return { x: -this.viewDir.x, y: -this.viewDir.y };
  }

  goalEffect(victimIndex, x, y) {
    this.flash[victimIndex] = 1;
    this.shake = 0.35;
    this.burst(x, y, this.playerMats[victimIndex].neon.color.getHex());
  }

  burst(x, y, color) {
    const n = 70, pos = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
      pos.set([x, 0.3, y], i * 3);
      const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 7;
      vel.push([Math.cos(a) * s, 3 + Math.random() * 6, Math.sin(a) * s]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      color, size: 0.28, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(points);
    this.particles.push({ points, vel, life: 1.2 });
  }

  update(view, dt, overrides = {}) {
    if (view.arena !== this.builtArena) this.buildTable(view);

    view.players.forEach((p, i) => {
      const m = this.mallets[i];
      m.visible = p.alive;
      const pos = i === overrides.ownIndex && overrides.ownMallet ? overrides.ownMallet : p.mallet;
      m.position.set(pos.x, 0, pos.y);
      this.flash[i] = Math.max(0, this.flash[i] - dt * 1.5);
      const mats = this.playerMats[i];
      mats.floor.emissiveIntensity = 0.3 + this.flash[i] * 2.5;
      mats.neon.emissiveIntensity = 1.2 + this.flash[i] * 4;
    });
    view.pucks.forEach((pk, i) => {
      const pm = this.puckMeshes[i];
      if (pk.active) {
        pm.visible = true;
        pm.position.set(pk.x, 0, pk.y);
        pm.scale.setScalar(1);
      } else if (pk.timer < 0.6) {
        // Neuer Puck fällt in der Mitte auf den Tisch
        pm.visible = true;
        pm.position.set(0, pk.timer * 8, 0);
        pm.scale.setScalar(1 - pk.timer * 0.6);
      } else {
        pm.visible = false;
      }
      const c = pk.lastTouch >= 0 ? PLAYER_COLORS[view.players[pk.lastTouch].colorIndex].hex : 0xe8f4ff;
      pm.userData.ring.material.color.setHex(c);
    });

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      const arr = p.points.geometry.attributes.position.array;
      p.vel.forEach((v, k) => {
        v[1] -= 18 * dt;
        arr[k * 3] += v[0] * dt; arr[k * 3 + 1] = Math.max(0.05, arr[k * 3 + 1] + v[1] * dt); arr[k * 3 + 2] += v[2] * dt;
      });
      p.points.geometry.attributes.position.needsUpdate = true;
      p.points.material.opacity = Math.max(0, p.life / 1.2);
      if (p.life <= 0) { this.scene.remove(p.points); disposeTree(p.points, true); this.particles.splice(i, 1); }
    }

    // Kamera folgt dem eigenen Tor und zoomt mit, wenn das Feld schrumpft
    const me = view.players[this.myIndex];
    if (me?.edge) {
      const k = 1 - Math.exp(-dt * 6);
      this.viewDir.lerp(new THREE.Vector2(me.edge.n.x, me.edge.n.y), k).normalize();
    }
    this.fitRadius += (this.fitTarget - this.fitRadius) * (1 - Math.exp(-dt * 3));
    this.placeCamera();
    this.shake = Math.max(0, this.shake - dt);
    if (this.shake > 0) {
      const s = this.shake * 0.8;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }

    this.updateLabels(view);
    this.renderer.render(this.scene, this.camera);
  }

  updateLabels(view) {
    const v = new THREE.Vector3();
    view.players.forEach((p, i) => {
      const lab = this.labels[i];
      lab.el.hidden = !lab.show || !p.edge;
      if (lab.el.hidden) return;
      const e = p.edge, off = GOAL_DEPTH + TABLE.railThickness + 0.9;
      v.set(e.mid.x + e.n.x * off, 0, e.mid.y + e.n.y * off).project(this.camera);
      // Im Hochformat liegen seitliche Schilder sonst halb außerhalb des Bildschirms
      const half = lab.el.offsetWidth / 2 + 6, halfH = lab.el.offsetHeight / 2 + 6;
      const x = Math.min(innerWidth - half, Math.max(half, (v.x + 1) / 2 * innerWidth));
      const y = Math.min(innerHeight - halfH, Math.max(halfH, (1 - v.y) / 2 * innerHeight));
      lab.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      const key = `${p.name}|${p.lives}`;
      if (key === lab.key) return;
      lab.key = key;
      const lives = Number.isFinite(p.lives) ? '●'.repeat(Math.max(0, p.lives)) : '';
      lab.el.innerHTML = '<b></b><span></span>';
      lab.el.querySelector('b').textContent = p.name;
      lab.el.querySelector('span').textContent = lives;
    });
  }
}

function playerMaterials(color, netMap) {
  return {
    post: new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3 }),
    neon: new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x0b0f18, emissive: color, emissiveIntensity: 0.3, roughness: 0.6 }),
    net: new THREE.MeshBasicMaterial({ color, map: netMap, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    zone: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, depthWrite: false }),
    zoneLine: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 }),
  };
}

function rail(a, b, n, material) {
  const T = TABLE.railThickness, H = TABLE.railHeight;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, H, T), material);
  m.position.set((a.x + b.x) / 2 + n.x * T / 2, H / 2, (a.y + b.y) / 2 + n.y * T / 2);
  m.rotation.y = Math.atan2(-(b.y - a.y), b.x - a.x);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function strip(a, b, width, material, y) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.01, width), material);
  m.position.set((a.x + b.x) / 2, y, (a.y + b.y) / 2);
  m.rotation.y = Math.atan2(-(b.y - a.y), b.x - a.x);
  return m;
}

function mallet(color) {
  const R = TABLE.malletRadius;
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2, emissive: color, emissiveIntensity: 0.15 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.02, 0.3, 40), mat);
  base.position.y = 0.15;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.8, 0.07, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.2 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.31;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.4, R * 0.5, 0.55, 28), mat);
  handle.position.y = 0.58;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(R * 0.45, 28, 16), mat);
  knob.position.y = 0.88;
  knob.scale.y = 0.7;
  for (const m of [base, handle, knob]) { m.castShadow = true; g.add(m); }
  g.add(ring);
  return g;
}

function puck() {
  const r = TABLE.puckRadius;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.2, 40), new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.4 }));
  body.position.y = 0.1;
  body.castShadow = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.5, r * 0.85, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8f4ff }));
  ring.position.y = 0.205;
  g.add(body, ring);
  g.userData.ring = ring;
  return g;
}

function holeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#132238';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(160,200,255,0.16)';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.beginPath();
      ctx.arc(x * 32 + 16, y * 32 + 16, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.25, 0.25);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function netTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  for (let x = -64; x < 320; x += 16) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 64, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 64, 0); ctx.lineTo(x, 64); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Teil des Vielecks mit p·n >= c (Sutherland-Hodgman für eine Halbebene)
function clipHalfPlane(poly, n, c) {
  const out = [], dot = p => p.x * n.x + p.y * n.y;
  const cut = (a, b) => {
    const t = (c - dot(a)) / (dot(b) - dot(a));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  poly.forEach((cur, i) => {
    const prev = poly[(i + poly.length - 1) % poly.length];
    const cIn = dot(cur) >= c, pIn = dot(prev) >= c;
    if (cIn) { if (!pIn) out.push(cut(prev, cur)); out.push(cur); }
    else if (pIn) out.push(cut(prev, cur));
  });
  return out;
}

// Gibt Geometrien frei; Materialien nur mit withMaterials (die Tisch-Materialien werden wiederverwendet)
function disposeTree(obj, withMaterials) {
  obj.traverse(o => {
    o.geometry?.dispose();
    if (!withMaterials) return;
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose();
  });
}
