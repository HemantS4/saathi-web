// Keeps route content (local metres: x = east/right-on-plan, y = north/up-on-plan) registered to the WebXR world.
//
//   XR point = R(theta) · (x, 0, -y) + t
//
// theta comes from the compass (outdoors) or the QR point's facing direction (indoors), then is corrected from the
// direction you actually walk along the route. t pins your GPS / QR position onto your tracked XR position.
//
// Corrections only change the *target* transform. What's drawn eases towards it at a slow, capped rate, and heading
// changes pivot around you, so the trail never jumps or swings away. Between corrections WebXR tracking (plus a ground
// anchor in app.js) keeps it fixed to the street.

import * as THREE from 'three';
import { angleDiff } from './geo.js';

const D2R = Math.PI / 180;
const MAX_TURN = 8;     // deg/s the drawn trail may rotate while catching up with a correction
const MAX_SLIDE = 0.5;  // m/s it may slide

export class Aligner {
  constructor() {
    this.theta = 0;                  // target heading offset (deg)
    this.t = new THREE.Vector3();    // target translation
    this.shownTheta = 0;             // what's drawn
    this.shownT = new THREE.Vector3();
    this.ready = false;
    this.headingLocked = false;
    this._track = [];
  }

  /** XR camera yaw, degrees clockwise from the XR -Z axis. */
  static yawOf(camera) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return (Math.atan2(f.x, -f.z) / D2R + 360) % 360;
  }

  /** Initial fix: the user stands at `local`, the camera points at `heading` (plan/compass degrees). Snaps instantly. */
  init(camera, local, heading) {
    this.theta = heading - Aligner.yawOf(camera);
    this.ready = true;
    this._pin(camera.position, local, 1);
    this.shownTheta = this.theta;
    this.shownT.copy(this.t);
    this._track = [];
    this._walk = null;
    this._learned = false;
    this.headingLocked = false;
  }

  /** Change the heading while keeping the user at the same spot on the route (rotate around the user, not the origin). */
  _setTheta(camera, theta) {
    const here = this._userLocalAt(camera, this.theta, this.t);
    this.theta = theta;
    this._pin(camera.position, here, 1);
  }

  /** Compass reading while in XR (if the browser still delivers it). Very slow blend: compasses are noisy. */
  compass(camera, heading, weight = 0.004) {
    if (!this.ready || this.headingLocked || this._learned || !Number.isFinite(heading)) return;
    const want = heading - Aligner.yawOf(camera);
    this._setTheta(camera, this.theta + angleDiff(this.theta, want) * weight);
  }

  /** New GPS fix (local metres + accuracy). Small nudge only: tracking is far more precise than GPS between fixes. */
  gps(camera, local, accuracy) {
    if (!this.ready) return;
    const k = Math.min(0.08, Math.max(0.01, 1.5 / Math.max(5, accuracy)));
    this._pin(camera.position, local, k);
  }

  /**
   * Learns the heading from the road itself: after walking a few metres while on the route, the direction you moved in
   * XR must be the route's bearing there. Ignores big disagreements (crossing the street, side steps).
   */
  walkAlong(camera, routeBearing) {
    if (!this.ready || this.headingLocked) return;
    const p = { x: camera.position.x, z: camera.position.z };
    if (!this._walk) { this._walk = p; return; }
    const dx = p.x - this._walk.x, dz = p.z - this._walk.z;
    if (Math.hypot(dx, dz) < 4) return;
    this._walk = p;
    const moveYaw = Math.atan2(dx, -dz) / D2R;
    const err = angleDiff(this.theta, routeBearing - moveYaw);
    if (Math.abs(err) < 70) {
      this._setTheta(camera, this.theta + err * (this._learned ? 0.3 : 0.85));
      this._learned = true;
    }
  }

  /** Keeps the trail starting at your feet: slowly slides the route so your position lies on it. */
  pinTo(camera, local, k = 0.01) { if (this.ready) this._pin(camera.position, local, k); }

  /** Manual alignment (drag to rotate the trail). Applied immediately and locks out automatic heading changes. */
  rotate(camera, deg) {
    this._setTheta(camera, this.theta + deg);
    this.shownTheta = this.theta;
    this.shownT.copy(this.t);
    this.headingLocked = true;
  }

  reanchor(camera, local, heading) { this.init(camera, local, heading); }

  /** Eases the drawn transform towards the target. Call once per frame. */
  step(dt) {
    if (!this.ready) return;
    const dTheta = angleDiff(this.shownTheta, this.theta);
    const turn = Math.sign(dTheta) * Math.min(Math.abs(dTheta), Math.max(MAX_TURN * dt, Math.abs(dTheta) * 0.02));
    this.shownTheta += turn;
    const gap = this.t.clone().sub(this.shownT);
    const len = gap.length();
    if (len > 1e-4) this.shownT.add(gap.multiplyScalar(Math.min(1, Math.max(MAX_SLIDE * dt, len * 0.02) / len)));
  }

  _pin(camPos, local, k) {
    const want = new THREE.Vector3(camPos.x, 0, camPos.z).sub(rot(this.theta, local.x, local.y));
    if (k >= 1) this.t.copy(want);
    else this.t.lerp(want, k);
  }

  _userLocalAt(camera, theta, t) {
    const r = -theta * D2R;
    const px = camera.position.x - t.x, pz = camera.position.z - t.z;
    const x = px * Math.cos(r) + pz * Math.sin(r), z = -px * Math.sin(r) + pz * Math.cos(r);
    return { x, y: -z };
  }

  /** Where the camera is in route metres, according to what's currently drawn. */
  userLocal(camera) { return this._userLocalAt(camera, this.shownTheta, this.shownT); }

  /** Applies the drawn transform to the content group (y = ground height). */
  apply(group, groundY) {
    group.rotation.set(0, this.shownTheta * D2R, 0);
    group.position.set(this.shownT.x, groundY, this.shownT.z);
  }
}

// rotation about +Y by theta (three.js convention), applied to (x, 0, -y)
function rot(theta, x, y) {
  const r = theta * D2R;
  return new THREE.Vector3(x * Math.cos(r) + (-y) * Math.sin(r), 0, -x * Math.sin(r) + (-y) * Math.cos(r));
}
