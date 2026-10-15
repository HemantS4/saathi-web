// AR overlay rendered with three.js on top of the camera video.
// World frame: x = East, y = Up, z = -North (metres). The user stands at the origin; route content
// lives in `world`, which is shifted by the user's position every frame.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { formatDistance } from './geo.js';

const GREEN = 0x2bd96b;

export class ARScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(63, 1, 0.1, 400);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 10, 4);
    this.scene.add(sun);

    this.chevronGeo = chevronGeometry();
    this.chevrons = [];
    this.coins = [];
    this.arrows = [];
    this.coinGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.05, 40);
    this.coinMats = coinMaterials();
    this.arrowGeo = arrowGeometry();
    this.arrowMat = new THREE.MeshStandardMaterial({ color: GREEN, emissive: 0x0d6b33, roughness: 0.4, side: THREE.DoubleSide });
    this.raycaster = new THREE.Raycaster();
    this.pin = makePin();
    this.world.add(this.pin.group);
    this.pin.group.visible = false;
    this.path = null;
    this.user = { x: 0, y: 0 };
    this.along = 0;
    this.time = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Phone back cameras are ~65-70° horizontally in landscape; in portrait that becomes the vertical FOV.
    this.camera.fov = w < h ? 63 : 42;
    this.camera.updateProjectionMatrix();
  }

  /** path: geo.Path in local metres; steps: [{alongIndex, maneuver}] with .along precomputed. */
  setRoute(path, maneuvers, destLocal, destName) {
    this.clear();
    this.path = path;
    // Coins along the route
    for (let d = 8; d < path.length - CONFIG.arrivalRadius * 0.6; d += CONFIG.coinSpacing) {
      const { p, dir } = path.at(d);
      const coin = new THREE.Mesh(this.coinGeo, this.coinMats);
      coin.rotation.x = Math.PI / 2;
      const holder = new THREE.Group();
      holder.add(coin);
      holder.position.set(p.x, -CONFIG.eyeHeight + 1.05, -p.y);
      holder.rotation.y = Math.atan2(dir.x, dir.y);
      holder.userData = { along: d, collected: false, phase: Math.random() * 6, t: -1, local: p };
      this.world.add(holder);
      this.coins.push(holder);
    }
    // Arrows at turns
    for (const m of maneuvers) {
      if (['DEPART', 'STRAIGHT', 'ARRIVE'].includes(m.maneuver)) continue;
      const at = path.at(m.along).p, ahead = path.at(m.along + 6).p;
      const dx = ahead.x - at.x, dy = ahead.y - at.y;
      if (Math.hypot(dx, dy) < 0.5) continue;
      const a = new THREE.Mesh(this.arrowGeo, this.arrowMat);
      a.position.set(at.x, -CONFIG.eyeHeight + 1.9, -at.y);
      a.rotation.y = -Math.atan2(dx, dy); // geometry points north (-z); yaw by the outgoing bearing
      a.userData.baseY = a.position.y;
      this.world.add(a);
      this.arrows.push(a);
    }
    this.dest = destLocal;
    this.pin.setLabel(destName, 0);
    this.pin.group.visible = true;
  }

  clear() {
    for (const c of this.coins) this.world.remove(c);
    for (const a of this.arrows) this.world.remove(a);
    this.coins = [];
    this.arrows = [];
    for (const c of this.chevrons) c.visible = false;
    this.pin.group.visible = false;
    this.path = null;
  }

  /** Returns number of coins collected this frame. */
  update(dt, userLocal, along, quaternion) {
    this.time += dt;
    this.user = userLocal;
    this.along = along;
    this.camera.quaternion.copy(quaternion);
    this.world.position.set(-userLocal.x, 0, userLocal.y);
    if (!this.path) return 0;

    this.updateTrail();
    let collected = 0;
    for (const c of this.coins) {
      const u = c.userData;
      const coin = c.children[0];
      if (u.t >= 0) { // collect animation
        u.t += dt / 0.5;
        c.position.y += dt * 2.5;
        c.scale.setScalar(Math.max(0.001, 1.3 - u.t));
        coin.rotation.z += dt * 20;
        if (u.t >= 1) c.visible = false;
        continue;
      }
      coin.rotation.z += dt * 3;
      c.position.y = -CONFIG.eyeHeight + 1.05 + Math.sin(this.time * 2 + u.phase) * 0.08;
      const d = Math.hypot(u.local.x - userLocal.x, u.local.y - userLocal.y);
      c.visible = d < 70;
      // Walking past it on the route counts too (GPS rarely puts you exactly on top of it).
      if (!u.collected && (d < CONFIG.coinCollectRadius || (along > u.along + 2 && along - u.along < 25 && d < CONFIG.coinCollectRadius * 2))) {
        u.collected = true; u.t = 0; collected++;
      }
    }
    for (const a of this.arrows) a.position.y = a.userData.baseY + Math.sin(this.time * 2) * 0.12;
    this.updatePin();
    return collected;
  }

  updateTrail() {
    const spacing = CONFIG.chevronSpacing;
    const start = Math.max(spacing, Math.ceil((this.along - 2) / spacing) * spacing);
    const end = Math.min(this.path.length - 2, this.along + CONFIG.trailAhead);
    let i = 0;
    for (let d = start; d <= end; d += spacing, i++) {
      let m = this.chevrons[i];
      if (!m) {
        m = new THREE.Mesh(this.chevronGeo, new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        m.renderOrder = 1;
        this.world.add(m);
        this.chevrons.push(m);
      }
      const { p } = this.path.at(d);
      const a = this.path.at(Math.max(0, d - 1)).p, b = this.path.at(Math.min(this.path.length, d + 1)).p;
      m.position.set(p.x, -CONFIG.eyeHeight + 0.03, -p.y);
      m.rotation.set(-Math.PI / 2, 0, Math.atan2(-(b.x - a.x), b.y - a.y));
      const rel = d - this.along;
      const fade = Math.min(1, (rel + 2) / 3) * Math.min(1, (CONFIG.trailAhead - rel) / 12);
      const phase = ((d - this.time * 6) % 9 + 9) % 9 / 9;
      const pulse = Math.pow(1 - phase, 3);
      m.material.opacity = Math.max(0, fade) * (0.55 + 0.45 * pulse);
      m.material.color.setHex(GREEN).lerp(new THREE.Color(0xffffff), pulse * 0.4);
      m.scale.setScalar(1.15 * (1 + pulse * 0.1));
      m.visible = true;
    }
    for (; i < this.chevrons.length; i++) this.chevrons[i].visible = false;
  }

  updatePin() {
    if (!this.dest) return;
    const dx = this.dest.x - this.user.x, dy = this.dest.y - this.user.y;
    const d = Math.hypot(dx, dy);
    // Far away: pull the pin in to 60 m and scale it up so it stays visible over the rooftops.
    const show = Math.min(d, 60), k = d > 0 ? show / d : 0;
    const scale = Math.max(1, show / 25); // roughly constant on-screen size once it's parked at 60 m
    this.pin.group.position.set(this.user.x + dx * k, -CONFIG.eyeHeight, -(this.user.y + dy * k));
    this.pin.group.scale.setScalar(scale);
    this.pin.head.rotation.y += 0.03;
    this.pin.label.quaternion.copy(this.camera.quaternion);
    if (Math.abs(d - this.pin.shownDist) > 5) this.pin.setLabel(this.pin.name, d);
  }

  /** Tap to collect a coin. Returns true if one was hit. */
  tap(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.coins.filter(c => c.visible && !c.userData.collected), true);
    if (!hits.length) return false;
    let h = hits[0].object;
    while (h.parent && !this.coins.includes(h)) h = h.parent;
    if (h.userData.collected) return false;
    h.userData.collected = true;
    h.userData.t = 0;
    return true;
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

// ───────────── Geometry & materials ─────────────

function chevronGeometry() {
  // Flat "^" pointing +y in shape space (becomes forward after rotation).
  const w = 1.0, d = 0.42, arm = 0.14, ax = arm * (w / 2 / d) * 1.6;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -d / 2); s.lineTo(-w / 2 + ax, -d / 2); s.lineTo(0, d / 2 - arm);
  s.lineTo(w / 2 - ax, -d / 2); s.lineTo(w / 2, -d / 2); s.lineTo(0, d / 2); s.closePath();
  return new THREE.ShapeGeometry(s);
}

function arrowGeometry() {
  const s = new THREE.Shape();
  const L = 1.2, W = 0.8, sw = 0.16, hs = 0.05;
  s.moveTo(-sw, -L / 2); s.lineTo(sw, -L / 2); s.lineTo(sw, hs); s.lineTo(W / 2, hs);
  s.lineTo(0, L / 2); s.lineTo(-W / 2, hs); s.lineTo(-sw, hs); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: false });
  g.translate(0, 0, -0.05);
  g.rotateX(-Math.PI / 2); // lie flat, pointing -z
  g.rotateX(Math.PI / 5);  // tilt up towards the viewer
  return g;
}

function coinMaterials() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(100, 90, 20, 128, 128, 128);
  grad.addColorStop(0, '#ffe58a'); grad.addColorStop(0.7, '#f5b400'); grad.addColorStop(1, '#c98a00');
  g.fillStyle = grad; g.beginPath(); g.arc(128, 128, 128, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#b07800'; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 104, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#a86f00'; g.font = 'bold 150px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('₹', 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Cylinder cap UVs are turned 90° relative to how the coin stands up; counter-rotate the artwork.
  tex.center.set(0.5, 0.5);
  tex.rotation = Math.PI / 2;
  const face =new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.35, emissive: 0x553300, emissiveIntensity: 0.6 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xd99a00, metalness: 0.5, roughness: 0.3, emissive: 0x442800 });
  return [rim, face, face];
}

function makePin() {
  const group = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  beam.position.y = 2;
  group.add(beam);
  const head = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xe8453c, emissive: 0x6b1410, roughness: 0.4 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), red);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.39, 0.7, 24), red);
  cone.rotation.x = Math.PI; cone.position.y = -0.45;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  dot.position.z = 0.33;
  head.add(ball, cone, dot);
  head.position.y = 4.6;
  group.add(head);

  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 160;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  label.position.y = 5.9;
  label.renderOrder = 5;
  group.add(label);

  const pin = {
    group, head, label, name: '', shownDist: -999,
    setLabel(name, dist) {
      pin.name = name; pin.shownDist = dist;
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, 512, 160);
      g.fillStyle = 'rgba(40,40,44,0.88)';
      roundRect(g, 8, 8, 496, 144, 40); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.font = '600 54px Gelasio, Georgia, serif';
      g.fillText(fit(g, name, 460), 256, 76);
      g.font = '500 38px Inter, system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillText(dist > 0 ? formatDistance(dist) : '', 256, 128);
      tex.needsUpdate = true;
    },
  };
  return pin;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  while (text.length > 1 && g.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}
