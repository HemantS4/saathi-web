// Keeps route content (local metres: x = east/right-on-plan, y = north/up-on-plan) registered to the WebXR world.
//
//   XR point = R(theta) · (x, 0, -y) + t
//
// theta comes from the compass (outdoors) or the QR point's facing direction (indoors), refined by comparing the
// direction you actually walk in XR with the direction GPS says you walked. t is pinned so that your GPS / QR position
// lands on your tracked XR position; between GPS fixes WebXR tracking keeps everything rock-steady.

import * as THREE from 'three';
import { angleDiff } from './geo.js';

const D2R = Math.PI / 180;

export class Aligner {
  constructor() {
    this.theta = 0;          // degrees
    this.t = new THREE.Vector3();
    this.ready = false;
    this._track = [];        // [{xr:{x,z}, loc:{x,y}}] for heading refinement
  }

  /** XR camera yaw, degrees clockwise from the XR -Z axis. */
  static yawOf(camera) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return (Math.atan2(f.x, -f.z) / D2R + 360) % 360;
  }

  /** Initial fix: the user stands at `local`, the camera points at `heading` (plan/compass degrees). */
  init(camera, local, heading) {
    this.theta = heading - Aligner.yawOf(camera);
    this._pin(camera.position, local, 1);
    this.ready = true;
    this._track = [];
  }

  /** Compass reading while in XR (if the browser still delivers it). Slow blend: compasses are noisy. */
  compass(camera, heading, weight = 0.01) {
    if (!this.ready || !Number.isFinite(heading)) return;
    const want = heading - Aligner.yawOf(camera);
    this.theta += angleDiff(this.theta, want) * weight;
  }

  /** New GPS fix (local metres + accuracy). Nudges translation; learns heading from the walking direction. */
  gps(camera, local, accuracy) {
    if (!this.ready) return;
    const k = Math.min(0.35, Math.max(0.03, 4 / Math.max(4, accuracy)));
    this._pin(camera.position, local, k);

    if (accuracy > 15) return;
    this._track.push({ xr: { x: camera.position.x, z: camera.position.z }, loc: { ...local } });
    if (this._track.length > 30) this._track.shift();
    const a = this._track[0], b = this._track[this._track.length - 1];
    const dxr = Math.hypot(b.xr.x - a.xr.x, b.xr.z - a.xr.z), dloc = Math.hypot(b.loc.x - a.loc.x, b.loc.y - a.loc.y);
    if (dxr > 15 && dloc > 15 && Math.abs(dxr - dloc) < 0.4 * dxr) {
      const hXr = Math.atan2(b.xr.x - a.xr.x, -(b.xr.z - a.xr.z)) / D2R;   // XR yaw of the walk
      const hLoc = Math.atan2(b.loc.x - a.loc.x, b.loc.y - a.loc.y) / D2R; // compass bearing of the walk
      this.theta += angleDiff(this.theta, hLoc - hXr) * 0.25;
      this._track = this._track.slice(-5);
    }
  }

  /** Hard re-anchor (indoor QR re-scan). */
  reanchor(camera, local, heading) { this.init(camera, local, heading); }

  _pin(camPos, local, k) {
    const want = new THREE.Vector3(camPos.x, 0, camPos.z).sub(this._rot(local.x, local.y));
    if (!this.ready || k >= 1) this.t.copy(want);
    else this.t.lerp(want, k);
  }

  _rot(x, y) {
    const r = this.theta * D2R;
    // rotation about +Y by theta (three.js convention), applied to (x, 0, -y)
    return new THREE.Vector3(x * Math.cos(r) + (-y) * Math.sin(r), 0, -x * Math.sin(r) + (-y) * Math.cos(r));
  }

  /** Where the camera is, in local route metres. */
  userLocal(camera) {
    const r = -this.theta * D2R;
    const px = camera.position.x - this.t.x, pz = camera.position.z - this.t.z;
    const x = px * Math.cos(r) + pz * Math.sin(r), z = -px * Math.sin(r) + pz * Math.cos(r);
    return { x, y: -z };
  }

  /** Applies the transform to the content group (y = ground height). */
  apply(group, groundY) {
    group.rotation.set(0, this.theta * D2R, 0);
    group.position.set(this.t.x, groundY, this.t.z);
  }
}
