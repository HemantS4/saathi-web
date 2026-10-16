// WebXR AR (Android Chrome + ARCore): 6-DoF tracking and real ground detection via hit-testing.
// iOS Safari has no WebXR AR - callers fall back to the GPS/compass overlay.
//
// Two frames are in play. The *XR frame* is the session's reference space: what ARCore reports. The *content frame*
// is the XR frame as it was when the route was placed. ARCore keeps refining its map, which shows up as a ground
// anchor moving in the XR frame. That movement is `anchorDelta()`, and content = delta · (content-frame coordinates).
// Everything this file measures (ground height, terrain) is stored in the content frame, so it stays consistent with
// the route however ARCore corrects itself.

import * as THREE from 'three';

const NEAR = 3;            // m: hits closer than this (horizontally) measure the ground under your feet
const MIN_BELOW = 0.3;     // m: an up-facing surface must be at least this far below the phone to be the ground...
const MAX_BELOW = 2.6;     // ...and no further (a floor below a balcony, the bottom of a stairwell)
const UP = 0.9;            // cos(25°): steeper surfaces are ramps, walls or noise
const SAMPLE_AGE = 3000;   // ms of ground samples kept
const STALE = 1500;        // ms without near hits before the ground follows the phone height instead
const REANCHOR = 12;       // m: walk this far from the anchor and a new one is dropped at your feet

export async function xrSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); }
  catch { return false; }
}

/**
 * Wraps an immersive-ar session on a three.js renderer.
 * - pose: this frame's viewer pose (three.js only copies it into the camera during render(), a frame late)
 * - ground: robust floor/road height (y, metres, content frame) under the user
 * - groundLocked: true once enough consistent hits were seen
 * - terrain: ground heights seen around you, so the trail follows slopes and steps instead of one flat level
 * - reticle: ring drawn where the ground was last found (shown while scanning)
 */
export class XRSession {
  constructor(renderer, scene, overlayRoot) {
    this.renderer = renderer;
    this.scene = scene;
    this.overlayRoot = overlayRoot;
    this.session = null;
    this.ground = null;
    this.groundLocked = false;
    this.terrain = new Terrain();
    this.pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), emulated: false };
    this.onSelect = null;   // (raycaster) => void, screen taps not on HUD elements
    this.onEnd = null;
    this.reticle = makeReticle();
    this.reticle.visible = false;
    scene.add(this.reticle);

    this._samples = [];     // { y, t } ground heights under the user
    this._eye = [];         // phone height above that ground, for when the camera isn't looking at it
    this._lastNear = -Infinity;
    this._planeSeen = new WeakMap();
    this.anchor = null;
    this._pending = null;
    this._anchorsOk = true;
    this._base = new THREE.Matrix4();   // correction accumulated from earlier anchors
    this._delta = new THREE.Matrix4();  // last good total correction (held while the anchor isn't tracked)
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._n = new THREE.Vector3();
  }

  async start() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'anchors', 'plane-detection', 'light-estimation'],
      domOverlay: { root: this.overlayRoot },
    });
    this.session = session;
    this.renderer.xr.enabled = true;
    // local-floor gives y = 0 at the floor when the device knows it; we refine with hit tests either way.
    let refType = 'local-floor';
    try { await session.requestReferenceSpace('local-floor'); } catch { refType = 'local'; }
    this.renderer.xr.setReferenceSpaceType(refType);
    await this.renderer.xr.setSession(session);
    this.refSpace = this.renderer.xr.getReferenceSpace();
    const features = session.enabledFeatures;
    if (features && !features.includes('anchors')) this._anchorsOk = false;

    const viewer = await session.requestReferenceSpace('viewer');
    // Three rays: screen centre (the road ahead when the phone is upright, your feet when it points down) and two
    // down-forward rays that find the ground near your feet while you hold the phone upright.
    // Planes only: ARCore feature points have no reliable surface normal, so they can't tell a floor from a wall.
    this.hitSources = [];
    for (const dir of [{ x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: -0.35 }, { x: 0, y: -1, z: -1.2 }]) {
      const offsetRay = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { ...dir, w: 0 });
      try { this.hitSources.push(await session.requestHitTestSource({ space: viewer, offsetRay, entityTypes: ['plane'] })); }
      catch {
        try { this.hitSources.push(await session.requestHitTestSource({ space: viewer, offsetRay })); }
        catch (e) { console.warn('[Saathi] hit-test source', e); }
      }
    }

    // Taps that aren't on the HUD arrive as XR "select" events.
    const ctrl = this.renderer.xr.getController(0);
    this.scene.add(ctrl);
    ctrl.addEventListener('select', () => {
      if (!this.onSelect) return;
      const rc = new THREE.Raycaster();
      const m = new THREE.Matrix4().identity().extractRotation(ctrl.matrixWorld);
      rc.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
      rc.ray.direction.set(0, 0, -1).applyMatrix4(m);
      this.onSelect(rc);
    });
    // Let the HUD (buttons, map) receive touches without also firing select.
    this.overlayRoot.addEventListener('beforexrselect', e => {
      if (e.target.closest('button, a, .map-frame, .card-dark, input, .align-layer')) e.preventDefault();
    });

    session.addEventListener('end', () => {
      this.session = null;
      this.renderer.xr.enabled = false;
      this.onEnd?.();
    });
    return this;
  }

  /** The viewer pose for this frame (XR frame), or null if ARCore has no pose at all. */
  viewerPose(frame) {
    const vp = frame?.getViewerPose(this.refSpace);
    if (!vp) return null;
    this._m.fromArray(vp.transform.matrix).decompose(this.pose.position, this.pose.quaternion, this._s);
    // emulatedPosition: tracking is lost and only rotation is real; positions are frozen guesses.
    this.pose.emulated = !!vp.emulatedPosition;
    return this.pose;
  }

  /**
   * Call each frame. toContent: inverse of anchorDelta() (XR frame → content frame). cam, quat: phone position and
   * orientation, content frame. Finds the ground under the user from hit tests (and detected planes), and records the
   * terrain around them.
   */
  updateGround(frame, toContent, cam, quat, now) {
    if (!frame) return;
    // Which way the phone faces, flattened. With the phone tilted down, the down-forward rays land *behind* it; on
    // stairs or a slope that's a different height from where you're stepping, so those hits only feed the terrain.
    const fwd = this._n.set(0, 0, -1).applyQuaternion(quat);
    const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1;
    let nearest = null, nearestD = Infinity;
    for (const src of this.hitSources || []) {
      for (const hit of frame.getHitTestResults(src)) {
        const pose = hit.getPose(this.refSpace);
        if (!pose) continue;
        this._m.fromArray(pose.transform.matrix).premultiply(toContent);
        this._m.decompose(this._p, this._q, this._s);
        this._n.set(0, 1, 0).applyQuaternion(this._q);   // hit pose y-axis = surface normal
        if (this._n.y < UP) continue;                     // walls, ramps, noise
        const d = Math.hypot(this._p.x - cam.x, this._p.z - cam.z);
        if (!this._plausible(this._p.y, cam.y, d)) continue;
        this.terrain.add(this._p.x, this._p.y, this._p.z, now);
        const ahead = ((this._p.x - cam.x) * fx + (this._p.z - cam.z) * fz) / fl;
        if (ahead > -0.15 && d < nearestD) { nearestD = d; nearest = this._p.clone(); }
        break;                                            // first (closest along the ray) valid hit per ray
      }
    }
    this._planes(frame, toContent, cam, now);

    if (nearest) {
      this.reticle.position.copy(nearest).applyMatrix4(this._m.copy(toContent).invert()); // reticle lives in the XR frame
      this.reticle.visible = !this.groundLocked;
      if (nearestD < NEAR || !this.groundLocked) {
        this._samples.push({ y: nearest.y, t: now });
        this._eye.push({ y: cam.y - nearest.y, t: now });
        this._lastNear = now;
      }
    }
    prune(this._samples, now - SAMPLE_AGE, 40);
    prune(this._eye, now - 20000, 60);
    this.terrain.prune(cam.x, cam.z, now);
    if (this.ground != null) this.terrain.fit(cam.x, cam.z, this.ground, now);

    const dt = Math.min(0.1, (now - (this._t ?? now)) / 1000);
    this._t = now;
    if (this._samples.length && now - this._lastNear < STALE) {
      const ys = this._samples.map(s => s.y).sort((a, b) => a - b);
      const median = ys[ys.length >> 1];
      if (this.ground == null) this.ground = median;
      // A clear step (kerb, stair, escalator landing) is taken quickly; noise is smoothed.
      const k = Math.abs(median - this.ground) > 0.12 ? 1 - Math.exp(-dt / 0.15) : 1 - Math.exp(-dt / 0.4);
      this.ground += (median - this.ground) * k;
      if (!this.groundLocked && ys.length >= 10) {
        const spread = ys[Math.floor(ys.length * 0.8)] - ys[Math.floor(ys.length * 0.2)];
        if (spread < 0.08) { this.groundLocked = true; this.reticle.visible = false; }
      }
    } else if (this.groundLocked && this._eye.length >= 5) {
      // Looking ahead, not down: assume the phone is still held at the height it was, so the ground follows you
      // up a slope or a flight of stairs. Terrain hits ahead of you take over again as soon as they arrive.
      const eyes = this._eye.map(s => s.y).sort((a, b) => a - b);
      const want = cam.y - eyes[eyes.length >> 1];
      const fromTerrain = this.terrain.heightAt(cam.x, cam.z, NaN, 1.5);
      const target = Number.isFinite(fromTerrain) ? fromTerrain : want;
      this.ground += (target - this.ground) * (1 - Math.exp(-dt / 0.5));
    }
  }

  /** Ground height at a content-frame point: nearby terrain, else the ground under the user. */
  groundAt(x, z) {
    return this.ground == null ? null : this.terrain.heightAt(x, z, this.ground);
  }

  /** Is an up-facing surface at height y, d metres from the user, the walkable ground (not a bench, car or table)? */
  _plausible(y, camY, d) {
    const below = camY - y;
    if (this.ground == null || !this.groundLocked) return below > MIN_BELOW && below < MAX_BELOW;
    // Allow for slopes (up to ~10%) that grow with distance, and for the user having changed level (stairs, lifts):
    // compare against both the tracked ground and where the ground would be given how high the phone is held.
    const tol = 0.2 + 0.1 * d;
    if (Math.abs(y - this.ground) <= tol) return true;
    if (this._eye.length >= 5 && d < NEAR) {
      const eyes = this._eye.map(s => s.y).sort((a, b) => a - b);
      return Math.abs(camY - eyes[eyes.length >> 1] - y) <= 0.25;
    }
    return false;
  }

  /** Detected horizontal planes (where Chrome supports plane-detection) fill in the terrain ahead of the hit rays. */
  _planes(frame, toContent, cam, now) {
    const planes = frame.detectedPlanes;
    if (!planes || this.ground == null) return;
    for (const plane of planes) {
      if (plane.orientation && plane.orientation !== 'horizontal') continue;
      if (this._planeSeen.get(plane) === plane.lastChangedTime) continue;
      this._planeSeen.set(plane, plane.lastChangedTime);
      const pose = frame.getPose(plane.planeSpace, this.refSpace);
      if (!pose) continue;
      this._m.fromArray(pose.transform.matrix).premultiply(toContent);
      this._m.decompose(this._p, this._q, this._s);
      if (this._n.set(0, 1, 0).applyQuaternion(this._q).y < UP) continue;
      const poly = plane.polygon || [];
      const step = Math.max(1, Math.floor(poly.length / 12));
      for (let i = 0; i < poly.length; i += step) {
        const v = this._p.set(poly[i].x, poly[i].y, poly[i].z).applyMatrix4(this._m);
        const d = Math.hypot(v.x - cam.x, v.z - cam.z);
        if (d < 40 && this._plausible(v.y, cam.y, d)) this.terrain.add(v.x, v.y, v.z, now);
      }
    }
  }

  /**
   * Keeps the content pinned to a real anchor on the ground near the user. ARCore refines its map as you walk and an
   * anchor moves with those corrections, so content attached to it stays glued to the street. Anchors only stay
   * accurate near where they were made, so a new one is dropped at your feet every REANCHOR metres.
   * feet: the ground under the user, content frame. delta: the current anchorDelta().
   */
  maintainAnchor(frame, feet, delta) {
    if (!this._anchorsOk || !this.groundLocked || this._pending || !frame?.createAnchor) return;
    if (this.anchor && Math.hypot(feet.x - this._anchorAt.x, feet.z - this._anchorAt.z) < REANCHOR) return;
    const at = feet.clone();
    const xrPos = feet.clone().applyMatrix4(delta);
    this._pending = true;
    frame.createAnchor(new XRRigidTransform({ x: xrPos.x, y: xrPos.y, z: xrPos.z, w: 1 }), this.refSpace)
      .then(a => { this._pending = { anchor: a, at }; })
      .catch(e => { console.warn('[Saathi] anchor unavailable', e); this._anchorsOk = false; this._pending = null; });
  }

  /**
   * Total correction ARCore has applied since the content was placed (XR frame ← content frame). Hand-over between
   * anchors keeps it continuous, and it's held at its last value while the anchor is not being tracked, so the
   * content never snaps back.
   */
  anchorDelta(frame, out) {
    const p = this._pending;
    if (p?.anchor && frame?.trackedAnchors?.has(p.anchor)) {
      const pose = frame.getPose(p.anchor.anchorSpace, this.refSpace);
      if (pose) {
        // Freeze the correction so far, then measure further movement against the new anchor.
        this._base.copy(this._delta);
        this.anchor?.delete?.();
        this.anchor = p.anchor;
        this._anchorAt = p.at;
        this._m0inv = new THREE.Matrix4().fromArray(pose.transform.matrix).invert();
        this._pending = null;
      }
    }
    if (this.anchor && frame?.trackedAnchors?.has(this.anchor)) {
      const pose = frame.getPose(this.anchor.anchorSpace, this.refSpace);
      if (pose) this._delta.fromArray(pose.transform.matrix).multiply(this._m0inv).multiply(this._base);
    }
    return out.copy(this._delta);
  }

  end() { this.session?.end(); }
}

/**
 * Ground heights on a 1 m grid (content frame). Each cell keeps a median of recent hits; lookups blend the cells
 * within a few metres, so a slope or a step is followed but one stray hit can't make a chevron float.
 */
export class Terrain {
  constructor(cell = 1) {
    this.cell = cell;
    this.cells = new Map();
    this._pruned = 0;
    this._fitAt = -Infinity;
    this.slope = null;      // { x0, z0, h0, gx, gz }: plane fitted to the ground around you, for beyond the hits
  }

  add(x, y, z, t = 0) {
    const ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell), key = ix + ',' + iz;
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, c = { ix, iz, ys: [], h: y, t });
    c.ys.push(y);
    if (c.ys.length > 9) c.ys.shift();
    const s = [...c.ys].sort((a, b) => a - b);
    c.h = s[s.length >> 1];
    c.t = t;
  }

  /**
   * Fits a plane to the cells within 25 m of (x, z): the general slope of the street, used further ahead than the
   * hit tests reach. Anchored at `h0` (the ground under the user) so it only contributes the gradient.
   */
  fit(x, z, h0, now) {
    if (now - this._fitAt < 250) return;
    this._fitAt = now;
    // Weighted least squares for h - h0 = gx·dx + gz·dz.
    let sxx = 0, sxz = 0, szz = 0, sxh = 0, szh = 0, n = 0;
    for (const c of this.cells.values()) {
      const dx = (c.ix + 0.5) * this.cell - x, dz = (c.iz + 0.5) * this.cell - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 625 || d2 < 1) continue;
      const w = 1 / (1 + d2 / 100), dh = c.h - h0;
      sxx += w * dx * dx; sxz += w * dx * dz; szz += w * dz * dz; sxh += w * dx * dh; szh += w * dz * dh; n++;
    }
    const det = sxx * szz - sxz * sxz;
    if (n < 6 || det < 1e-3) { this.slope = null; return; }
    const lim = 0.15; // steeper than this isn't a street; don't extrapolate wildly
    const gx = Math.max(-lim, Math.min(lim, (sxh * szz - szh * sxz) / det));
    const gz = Math.max(-lim, Math.min(lim, (szh * sxx - sxh * sxz) / det));
    this.slope = { x0: x, z0: z, h0, gx, gz };
  }

  /** Where the fitted slope puts the ground at (x, z), or `fallback` without a fit. */
  _planeAt(x, z, fallback) {
    const s = this.slope;
    // Relative to the current ground under the user, so the plane never contradicts it.
    return fallback + s.gx * (x - s.x0) + s.gz * (z - s.z0);
  }

  /**
   * Inverse-distance blend of known cells within `radius` metres, with the fitted slope as a weak extra sample so the
   * height fades smoothly into the extrapolation where the hits run out; `fallback` if there's nothing at all.
   */
  heightAt(x, z, fallback, radius = 3) {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let sw = 0, sh = 0;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const c = this.cells.get((cx + i) + ',' + (cz + j));
        if (!c) continue;
        const dx = (c.ix + 0.5) * this.cell - x, dz = (c.iz + 0.5) * this.cell - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        const w = 1 / (d2 + 0.25);
        sw += w; sh += w * c.h;
      }
    }
    if (this.slope && Number.isFinite(fallback)) { const w0 = 0.08; sw += w0; sh += w0 * this._planeAt(x, z, fallback); }
    return sw > 0 ? sh / sw : fallback;
  }

  /** Forgets cells far behind you (and, every few seconds, ones not seen for a long time). */
  prune(x, z, now) {
    if (now - this._pruned < 2000) return;
    this._pruned = now;
    for (const [k, c] of this.cells) {
      const d = Math.hypot((c.ix + 0.5) * this.cell - x, (c.iz + 0.5) * this.cell - z);
      if (d > 80 || now - c.t > 120000) this.cells.delete(k);
    }
  }
}

function prune(list, before, max) {
  while (list.length && (list[0].t < before || list.length > max)) list.shift();
}

function makeReticle() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2bd96b, transparent: true, opacity: 0.9, depthTest: false }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.04, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  g.add(ring, dot);
  g.renderOrder = 10;
  return g;
}
