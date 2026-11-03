// 3D-Darstellung mit Three.js. Zeichnet einen „View“ – die Simulation auf dem Host oder deren Abbild auf
// den anderen Handys: { arena, players: [{ name, colorIndex, alive, lives, mallet, edge }], pucks: [...] }.
// Der Tisch wird neu gebaut, sobald sich view.arena ändert (z. B. wenn das Feld nach einem Ausscheiden schrumpft).
import * as THREE from 'three';
import { PLAYER_COLORS, TABLE } from './config.js';
import { zonePolygon } from './arena.js';

const CAMERA_TILT = 0.45;   // 0 = genau von oben
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
      body: new THREE.MeshStandardMaterial({ color: 0x182133, roughness: 0.7 }),
      surface: new THREE.MeshStandardMaterial({ map: holeTexture(), roughness: 0.32, metalness: 0.08 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x55657f, metalness: 0.45, roughness: 0.35, emissive: 0x16233a }),
      // Leuchtende Oberkante und Linie am Fuß der Banden, damit der Rand auch auf kleinen Bildschirmen klar ist
      railTop: new THREE.MeshBasicMaterial({ color: 0xbfe3ff }),
      edge: new THREE.MeshBasicMaterial({ color: 0x8cc4ff, transparent: true, opacity: 0.6 }),
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

    // Die Zeichenfläche ist nicht immer bildschirmfüllend (unten kann das Touch-Feld liegen)
    new ResizeObserver(() => this.resize()).observe(canvas);
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
      else g.add(rail(e.a, e.b, e.n, this.mats));
    }
    // Stöße zwischen zwei Banden abdecken (Torpfosten haben eigene Säulen)
    const T = TABLE.railThickness, H = TABLE.railHeight;
    for (const v of arena.verts) {
      if (arena.posts.includes(v)) continue;
      const len = Math.hypot(v.x, v.y) || 1;
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.75, T * 0.75, H, 20), this.mats.rail);
      joint.position.set(v.x + v.x / len * T * 0.45, H / 2, v.y + v.y / len * T * 0.45);
      joint.castShadow = true;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.3, T * 0.3, 0.04, 16), this.mats.railTop);
      cap.position.set(v.x, H + 0.02, v.y);
      g.add(joint, cap);
    }

    // Spielerzonen (Tortenstücke) mit Rand
    for (const e of arena.edges) {
      if (!e.goal) continue;
      const mats = this.playerMats[e.owner];
      const poly = zonePolygon(arena, e);
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

  // Tor im Stil der Schläger: glänzende Pfosten mit Leuchtring und Knauf, Querlatte, farbiger Torkasten
  // mit runden Leuchtkanten und Netz an der Rückwand
  goal(e, mats) {
    const T = TABLE.railThickness, H = TABLE.railHeight, w = e.half * 2, P = TABLE.postRadius;
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
    const wallH = H + SINK, wallY = (H - SINK) / 2, sideX = e.half + T * 0.35, backZ = -GOAL_DEPTH - T * 0.35;
    const postH = H + 0.75, barY = postH - 0.12, rim = 0.09;

    add(new THREE.BoxGeometry(w + T, 0.05, GOAL_DEPTH), mats.floor, 0, -SINK, -GOAL_DEPTH / 2, false);
    for (const s of [-1, 1]) {
      // Seitenwand mit runder Leuchtkante
      add(new THREE.BoxGeometry(T * 0.7, wallH, GOAL_DEPTH), mats.body, s * sideX, wallY, -GOAL_DEPTH / 2);
      add(new THREE.CylinderGeometry(rim, rim, GOAL_DEPTH, 12).rotateX(Math.PI / 2), mats.ring, s * sideX, H + 0.02, -GOAL_DEPTH / 2, false);
      // Pfosten wie ein kleiner Schläger: Sockel, Leuchtring, Säule, Knauf
      const x = s * e.half;
      add(new THREE.CylinderGeometry(P, P * 1.05, 0.3, 32), mats.body, x, 0.15, 0);
      add(new THREE.TorusGeometry(P * 0.8, 0.06, 10, 32).rotateX(Math.PI / 2), mats.ring, x, 0.31, 0, false);
      add(new THREE.CylinderGeometry(P * 0.55, P * 0.6, postH - 0.3, 24), mats.body, x, 0.3 + (postH - 0.3) / 2, 0);
      const knob = add(new THREE.SphereGeometry(P * 0.62, 24, 14), mats.body, x, postH, 0);
      knob.scale.y = 0.75;
    }
    // Querlatte zwischen den Pfosten
    add(new THREE.CylinderGeometry(0.13, 0.13, w, 20).rotateZ(Math.PI / 2), mats.body, 0, barY, 0);
    add(new THREE.TorusGeometry(0.15, 0.04, 8, 20).rotateY(Math.PI / 2), mats.ring, 0, barY, 0, false);
    // Rückwand mit Leuchtkante und Netz
    add(new THREE.BoxGeometry(w + T * 1.4, wallH, T * 0.7), mats.body, 0, wallY, backZ);
    add(new THREE.CylinderGeometry(rim, rim, w + T * 1.4, 12).rotateZ(Math.PI / 2), mats.ring, 0, H + 0.02, backZ, false);
    const net = add(new THREE.PlaneGeometry(w, wallH - 0.05), mats.net, 0, wallY, -GOAL_DEPTH + 0.01, false);
    net.renderOrder = 1;
    add(new THREE.BoxGeometry(w, 0.01, 0.14), mats.ring, 0, 0.016, 0, false);   // Torlinie
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
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
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
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
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
    this.burst(x, y, this.playerMats[victimIndex].floor.emissive.getHex());
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
      mats.floor.emissiveIntensity = 0.12 + this.flash[i] * 2.5;
      mats.ring.emissiveIntensity = 1.2 + this.flash[i] * 4;
      mats.body.emissiveIntensity = 0.15 + this.flash[i] * 1.5;
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
      const W = this.canvas.clientWidth, Hh = this.canvas.clientHeight;
      const x = Math.min(W - half, Math.max(half, (v.x + 1) / 2 * W));
      const y = Math.min(Hh - halfH, Math.max(halfH, (1 - v.y) / 2 * Hh));
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
    body: malletBody(color),
    ring: malletRing(color),
    floor: new THREE.MeshStandardMaterial({ color: 0x0b0f18, emissive: color, emissiveIntensity: 0.12, roughness: 0.6 }),
    net: new THREE.MeshBasicMaterial({ color, map: netMap, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    zone: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, depthWrite: false }),
    zoneLine: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 }),
  };
}

function rail(a, b, n, mats) {
  const T = TABLE.railThickness, H = TABLE.railHeight;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const g = new THREE.Group();
  g.position.set((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
  g.rotation.y = Math.atan2(-(b.y - a.y), b.x - a.x);
  // lokal: x entlang der Bande, -z nach außen (n)
  const box = new THREE.Mesh(new THREE.BoxGeometry(len, H, T), mats.rail);
  box.position.set(0, H / 2, -T / 2);
  box.castShadow = true;
  box.receiveShadow = true;
  const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, T * 0.3), mats.railTop);
  top.position.set(0, H + 0.02, -T * 0.3);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(len, 0.01, 0.1), mats.edge);
  foot.position.set(0, 0.013, 0.05);
  g.add(box, top, foot);
  return g;
}

function strip(a, b, width, material, y) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.01, width), material);
  m.position.set((a.x + b.x) / 2, y, (a.y + b.y) / 2);
  m.rotation.y = Math.atan2(-(b.y - a.y), b.x - a.x);
  return m;
}

// Gleiche Materialien für Schläger und Tore
const malletBody = color => new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2, emissive: color, emissiveIntensity: 0.15 });
const malletRing = color => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.2 });

function mallet(color) {
  const R = TABLE.malletRadius;
  const g = new THREE.Group();
  const mat = malletBody(color);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.02, 0.3, 40), mat);
  base.position.y = 0.15;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.8, 0.07, 10, 40), malletRing(color));
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

// Gibt Geometrien frei; Materialien nur mit withMaterials (die Tisch-Materialien werden wiederverwendet)
function disposeTree(obj, withMaterials) {
  obj.traverse(o => {
    o.geometry?.dispose();
    if (!withMaterials) return;
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose();
  });
}
