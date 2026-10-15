// WebXR AR (Android Chrome + ARCore): 6-DoF tracking and real ground detection via hit-testing.
// iOS Safari has no WebXR AR - callers fall back to the GPS/compass overlay.

import * as THREE from 'three';

export async function xrSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); }
  catch { return false; }
}

/**
 * Wraps an immersive-ar session on a three.js renderer.
 * - ground: robust estimate of the floor/road height (y, metres) from hit tests on surfaces facing up
 * - groundLocked: true once enough consistent hits were seen
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
    this.samples = [];
    this.onSelect = null;   // (raycaster) => void, screen taps not on HUD elements
    this.onEnd = null;
    this.reticle = makeReticle();
    this.reticle.visible = false;
    scene.add(this.reticle);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._n = new THREE.Vector3();
  }

  async start() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'anchors', 'light-estimation'],
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

    const viewer = await session.requestReferenceSpace('viewer');
    // Two rays: straight ahead (screen centre) and down-forward (catches the ground near your feet when holding the phone upright).
    this.hitSources = [];
    for (const dir of [{ x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: -0.35 }, { x: 0, y: -1, z: -1.2 }]) {
      try { this.hitSources.push(await session.requestHitTestSource({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { ...dir, w: 0 }) })); }
      catch (e) { console.warn('[Saathi] hit-test source', e); }
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
      if (e.target.closest('button, a, .map-frame, .card-dark, input')) e.preventDefault();
    });

    session.addEventListener('end', () => {
      this.session = null;
      this.renderer.xr.enabled = false;
      this.onEnd?.();
    });
    return this;
  }

  /** Call each frame from renderer.setAnimationLoop(time, frame). */
  updateGround(frame, cameraY) {
    if (!frame || !this.hitSources?.length) return;
    let best = null;
    for (const src of this.hitSources) {
      for (const hit of frame.getHitTestResults(src)) {
        const pose = hit.getPose(this.refSpace);
        if (!pose) continue;
        this._m.fromArray(pose.transform.matrix);
        this._m.decompose(this._p, this._q, new THREE.Vector3());
        this._n.set(0, 1, 0).applyQuaternion(this._q);   // hit pose y-axis = surface normal
        const below = cameraY - this._p.y;
        if (this._n.y < 0.85 || below < 0.4 || below > 2.6) continue; // walls, tables, ceilings
        if (!best || this._p.y < best.y) best = this._p.clone();      // lowest up-facing surface = ground
        break;
      }
    }
    if (!best) return;
    this.reticle.position.copy(best);
    this.reticle.visible = !this.groundLocked;
    this.samples.push(best.y);
    if (this.samples.length > 40) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.ground = this.ground == null ? median : this.ground + (median - this.ground) * 0.1;
    if (!this.groundLocked && this.samples.length >= 8) {
      const spread = sorted[Math.floor(sorted.length * 0.8)] - sorted[Math.floor(sorted.length * 0.2)];
      if (spread < 0.15) { this.groundLocked = true; this.reticle.visible = false; }
    }
  }

  end() { this.session?.end(); }
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
