// 3D-Darstellung mit Three.js. Zeichnet einen „View“ – die Simulation auf dem Host oder deren Abbild auf
// den anderen Handys: { arena, players: [{ name, colorIndex, alive, lives, mallet, edge }], pucks: [...] }.
import * as THREE from 'three';
import { PLAYER_COLORS, TABLE } from './config.js';

const UP = new THREE.Vector3(0, 1, 0);
const CAMERA_TILT = 0.32;   // 0 = genau von oben

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

    this.raycaster = new THREE.Raycaster();
    this.tablePlane = new THREE.Plane(UP, 0);
    this.group = null;
    this.particles = [];
    this.shake = 0;
    this.viewDir = new THREE.Vector2(0, 1);
    this.fitRadius = 14;

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Baut das Spielfeld für einen View. myIndex: eigener Spieler (sein Tor liegt unten), -1 = Zuschauer
  setup(view, myIndex = -1, { labels = true } = {}) {
    if (this.group) { this.scene.remove(this.group); disposeTree(this.group); }
    for (const p of this.particles) { this.scene.remove(p.points); disposeTree(p.points); }
    this.particles = [];
    const g = this.group = new THREE.Group();
    this.scene.add(g);
    const arena = view.arena;
    const verts = arena.edges.map(e => e.a);

    // Tischkörper + Oberfläche mit Luftlöchern
    const shape = new THREE.Shape(verts.map(v => new THREE.Vector2(v.x, -v.y)));
    const body = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false }).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0c111b, roughness: 0.8 }),
    );
    body.position.y = -1.2;
    g.add(body);
    const surface = new THREE.Mesh(
      new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: holeTexture(), roughness: 0.32, metalness: 0.08 }),
    );
    surface.position.y = 0.001;
    surface.receiveShadow = true;
    g.add(surface);

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.09, 72).rotateX(-Math.PI / 2), lineMat);
    ring.position.y = 0.012;
    g.add(ring);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24).rotateX(-Math.PI / 2), lineMat);
    dot.position.y = 0.012;
    g.add(dot);

    const T = TABLE.railThickness, H = TABLE.railHeight;
    const railMat = new THREE.MeshStandardMaterial({ color: 0x1d2536, metalness: 0.55, roughness: 0.3 });
    const gateMat = new THREE.MeshStandardMaterial({ color: 0x3a4152, metalness: 0.3, roughness: 0.5 });

    this.edgeViews = arena.edges.map(e => {
      const ev = { edge: e, flash: 0, gate: null, gateY: 0 };
      const color = e.owner >= 0 ? PLAYER_COLORS[view.players[e.owner].colorIndex] : null;

      if (color) {
        // Spielzone leicht eingefärbt, mit Grenzlinie
        const c = arena.apothem - arena.zoneDepth;
        const zonePoly = clipHalfPlane(verts, e.n, c);
        ev.zoneMat = new THREE.MeshBasicMaterial({ color: color.hex, transparent: true, opacity: 0.1, depthWrite: false });
        const zone = new THREE.Mesh(
          new THREE.ShapeGeometry(new THREE.Shape(zonePoly.map(v => new THREE.Vector2(v.x, -v.y)))).rotateX(-Math.PI / 2),
          ev.zoneMat,
        );
        zone.position.y = 0.006;
        g.add(zone);
        const onLine = zonePoly.filter(v => Math.abs(v.x * e.n.x + v.y * e.n.y - c) < 1e-6);
        if (onLine.length === 2) {
          ev.lineMat = new THREE.MeshBasicMaterial({ color: color.hex, transparent: true, opacity: 0.45 });
          g.add(strip(onLine[0], onLine[1], 0.06, ev.lineMat, 0.014));
        }

        const gh = e.goalHalf;
        const g1 = { x: e.mid.x - e.t.x * gh, y: e.mid.y - e.t.y * gh };
        const g2 = { x: e.mid.x + e.t.x * gh, y: e.mid.y + e.t.y * gh };
        g.add(rail(e.a, g1, e.n, railMat));
        g.add(rail(g2, e.b, e.n, railMat));

        ev.goalMat = new THREE.MeshStandardMaterial({ color: color.hex, emissive: color.hex, emissiveIntensity: 0.7 });
        g.add(strip(g1, g2, 0.14, ev.goalMat, 0.015));
        for (const gp of [g1, g2]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(TABLE.postRadius, TABLE.postRadius, H + 0.15, 16), ev.goalMat);
          post.position.set(gp.x, (H + 0.15) / 2, gp.y);
          post.castShadow = true;
          g.add(post);
        }
        // Torkasten hinter der Lücke
        const depth = 1.8;
        const pocket = new THREE.Mesh(
          new THREE.BoxGeometry(gh * 2, 0.05, depth),
          new THREE.MeshStandardMaterial({ color: color.hex, emissive: color.hex, emissiveIntensity: 0.35 }),
        );
        pocket.position.set(e.mid.x + e.n.x * depth / 2, -0.35, e.mid.y + e.n.y * depth / 2);
        pocket.rotation.y = Math.atan2(-e.t.y, e.t.x);
        g.add(pocket);
        const back = rail(
          { x: g1.x + e.n.x * depth, y: g1.y + e.n.y * depth },
          { x: g2.x + e.n.x * depth, y: g2.y + e.n.y * depth }, e.n, railMat);
        back.position.y -= 0.3;
        g.add(back);

        // Wand, die das Tor schließt, wenn der Spieler raus ist
        ev.gate = rail(g1, g2, e.n, gateMat);
        ev.gate.visible = false;
        g.add(ev.gate);
      } else {
        g.add(rail(e.a, e.b, e.n, railMat));
      }
      return ev;
    });

    for (const v of verts) {
      const len = Math.hypot(v.x, v.y);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.8, T * 0.8, H + 0.1, 20), railMat);
      post.position.set(v.x + v.x / len * T * 0.5, (H + 0.1) / 2, v.y + v.y / len * T * 0.5);
      post.castShadow = true;
      g.add(post);
    }

    this.mallets = view.players.map(p => {
      const m = mallet(PLAYER_COLORS[p.colorIndex].hex);
      g.add(m);
      return m;
    });
    this.puckMeshes = view.pucks.map(() => {
      const pm = puck();
      g.add(pm);
      return pm;
    });

    this.setupLabels(view, labels);

    // Kamera hinter das eigene Tor drehen
    const me = view.players[myIndex];
    const n = me ? me.edge.n : { x: 0, y: 1 };
    this.viewDir.set(n.x, n.y);
    this.fitRadius = arena.circumradius + 1.6;
    this.resize();
  }

  setupLabels(view, show) {
    this.labelsEl.innerHTML = '';
    this.labels = view.players.map(p => {
      const el = document.createElement('div');
      el.className = 'label';
      el.style.setProperty('--c', PLAYER_COLORS[p.colorIndex].css);
      el.hidden = !show;
      this.labelsEl.append(el);
      return { el, key: '' };
    });
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
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
    const ev = this.edgeViews.find(v => v.edge.owner === victimIndex);
    if (ev) ev.flash = 1;
    this.shake = 0.35;
    this.burst(x, y, PLAYER_COLORS[this.colorOf(victimIndex)].hex);
  }

  colorOf(index) {
    return this.colorIndexes?.[index] ?? index;
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
    this.colorIndexes = view.players.map(p => p.colorIndex);
    view.players.forEach((p, i) => {
      const m = this.mallets[i];
      m.visible = p.alive;
      const pos = i === overrides.ownIndex && overrides.ownMallet ? overrides.ownMallet : p.mallet;
      m.position.set(pos.x, 0, pos.y);
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

    for (const ev of this.edgeViews) {
      if (!ev.gate) continue;
      const owner = view.players[ev.edge.owner];
      ev.flash = Math.max(0, ev.flash - dt * 1.5);
      ev.goalMat.emissiveIntensity = owner.alive ? 0.7 + ev.flash * 4 : 0.05;
      if (!owner.alive) {
        ev.gate.visible = true;
        ev.gateY = Math.min(1, ev.gateY + dt * 2.5);
        ev.gate.position.y = TABLE.railHeight / 2 - (1 - ev.gateY) * TABLE.railHeight;
        ev.zoneMat.opacity = 0.03;
        if (ev.lineMat) ev.lineMat.opacity = 0.12;
      }
    }

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
      if (p.life <= 0) { this.scene.remove(p.points); disposeTree(p.points); this.particles.splice(i, 1); }
    }

    this.shake = Math.max(0, this.shake - dt);
    this.camera.position.copy(this.basePos);
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
      if (lab.el.hidden) return;
      const e = p.edge, off = TABLE.railThickness + 1.3;
      v.set(e.mid.x + e.n.x * off, 0, e.mid.y + e.n.y * off).project(this.camera);
      // Im Hochformat liegen seitliche Schilder sonst halb außerhalb des Bildschirms
      const half = lab.el.offsetWidth / 2 + 6;
      const x = Math.min(innerWidth - half, Math.max(half, (v.x + 1) / 2 * innerWidth));
      lab.el.style.transform = `translate(${x}px, ${(1 - v.y) / 2 * innerHeight}px) translate(-50%, -50%)`;
      const key = `${p.name}|${p.lives}|${p.alive}`;
      if (key === lab.key) return;
      lab.key = key;
      lab.el.classList.toggle('out', !p.alive);
      const lives = Number.isFinite(p.lives) ? '●'.repeat(Math.max(0, p.lives)) : '';
      lab.el.innerHTML = `<b></b><span>${p.alive ? lives : 'raus'}</span>`;
      lab.el.querySelector('b').textContent = p.name;
    });
  }
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

function disposeTree(obj) {
  obj.traverse(o => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose(); m.dispose(); }
  });
}
