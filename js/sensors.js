// Phone sensors: back camera, GPS, and device orientation → a camera quaternion in a world frame
// where three.js x = East, y = Up, -z = North. Plus a desktop simulator (?sim=1).

import * as THREE from 'three';
import { PositionFilter, angleDiff, bearing } from './geo.js';

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out of the back of the device
const yAxis = new THREE.Vector3(0, 1, 0);

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIOS;

/** Must be called from a user gesture (button tap) on iOS. */
export async function requestPermissions() {
  const result = { motion: true };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { result.motion = (await DeviceOrientationEvent.requestPermission()) === 'granted'; }
    catch { result.motion = false; }
  }
  return result;
}

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
}

export class Sensors {
  constructor() {
    this.position = null;        // filtered {lat,lng}
    this.accuracy = Infinity;
    this.quaternion = new THREE.Quaternion();
    this.hasOrientation = false;
    this.heading = 0;            // where the camera points, deg clockwise from north
    this.pitch = 0;              // deg above horizon (negative = looking down)
    this.compassAccuracy = null;
    this.onPosition = null;
    this._filter = new PositionFilter();
    this._raw = new THREE.Quaternion();
    this._offset = 0;            // iOS: true heading - relative heading (smoothed)
    this._offsetInit = false;
    this._absolute = false;
  }

  startGPS() {
    if (!('geolocation' in navigator)) throw new Error('This browser has no GPS access.');
    return new Promise((resolve, reject) => {
      let first = true;
      this._watch = navigator.geolocation.watchPosition(pos => {
        const c = pos.coords;
        this.position = this._filter.push(c.latitude, c.longitude, c.accuracy, pos.timestamp);
        this.accuracy = c.accuracy;
        this.gpsHeading = Number.isFinite(c.heading) && c.speed > 0.8 ? c.heading : null;
        this.onPosition?.(this.position, c.accuracy);
        if (first) { first = false; resolve(this.position); }
      }, err => { if (first) reject(err); else console.warn('[Saathi] GPS', err); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    });
  }

  startOrientation() {
    const handler = e => this._onOrientation(e);
    if ('ondeviceorientationabsolute' in window) {
      this._absolute = true;
      window.addEventListener('deviceorientationabsolute', handler, true);
    } else {
      window.addEventListener('deviceorientation', handler, true);
    }
  }

  _onOrientation(e) {
    if (e.alpha == null || e.beta == null) return;
    const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * THREE.MathUtils.DEG2RAD;
    euler.set(e.beta * THREE.MathUtils.DEG2RAD, e.alpha * THREE.MathUtils.DEG2RAD, -e.gamma * THREE.MathUtils.DEG2RAD, 'YXZ');
    this._raw.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -orient));

    let q = this._raw;
    if (!this._absolute) {
      // iOS: alpha is relative; rotate the whole frame so the camera heading matches the compass.
      const rel = headingOf(this._raw);
      if (Number.isFinite(e.webkitCompassHeading)) {
        this.compassAccuracy = e.webkitCompassAccuracy;
        const want = angleDiff(rel, e.webkitCompassHeading);
        if (!this._offsetInit) { this._offset = want; this._offsetInit = true; }
        else this._offset += angleDiff(this._offset, want) * 0.05;
      }
      q = new THREE.Quaternion().setFromAxisAngle(yAxis, -this._offset * THREE.MathUtils.DEG2RAD).multiply(this._raw);
    }

    // Light smoothing against hand jitter.
    if (!this.hasOrientation) this.quaternion.copy(q);
    else this.quaternion.slerp(q, 0.35);
    this.hasOrientation = true;
    this.heading = headingOf(this.quaternion);
    this.pitch = pitchOf(this.quaternion);
  }

  stop() {
    if (this._watch != null) navigator.geolocation.clearWatch(this._watch);
  }
}

const fwd = new THREE.Vector3();
export function headingOf(q) {
  fwd.set(0, 0, -1).applyQuaternion(q);
  if (Math.hypot(fwd.x, fwd.z) < 0.05) fwd.set(0, 1, 0).applyQuaternion(q); // looking straight down: use top edge
  return (Math.atan2(fwd.x, -fwd.z) * THREE.MathUtils.RAD2DEG + 360) % 360;
}
export function pitchOf(q) {
  fwd.set(0, 0, -1).applyQuaternion(q);
  return Math.asin(Math.max(-1, Math.min(1, fwd.y))) * THREE.MathUtils.RAD2DEG;
}

/**
 * Desktop simulator: walks along the route at ~1.4 m/s. Drag to look around, W/S to walk faster/slower,
 * M to tilt the phone down (map view).
 */
export class SimSensors extends Sensors {
  constructor(start) {
    super();
    this.position = { ...start };
    this.accuracy = 5;
    this.hasOrientation = true;
    this.speed = 1.4;
    this._yawOffset = 0;
    this._pitch = -8;
    this._target = null;
    let dragging = false, lx = 0, ly = 0;
    addEventListener('pointerdown', e => { dragging = e.target.tagName === 'CANVAS' || e.target.id === 'camera'; lx = e.clientX; ly = e.clientY; });
    addEventListener('pointerup', () => dragging = false);
    addEventListener('pointermove', e => {
      if (!dragging) return;
      this._yawOffset += (e.clientX - lx) * 0.25;
      this._pitch = Math.max(-85, Math.min(30, this._pitch - (e.clientY - ly) * 0.25));
      lx = e.clientX; ly = e.clientY;
    });
    addEventListener('keydown', e => {
      if (e.key === 'w') this.speed = Math.min(12, this.speed * 1.6);
      if (e.key === 's') this.speed = Math.max(0, this.speed / 1.6);
      if (e.key === 'm') this._pitch = this._pitch < -50 ? -8 : -70;
    });
  }
  startGPS() { this.onPosition?.(this.position, this.accuracy); return Promise.resolve(this.position); }
  startOrientation() {}

  /** Called every frame by the app with the next point to walk towards. */
  step(dt, target) {
    if (target) {
      const b = bearing(this.position, target);
      const R = 6378137, d = this.speed * dt;
      const rad = b * Math.PI / 180;
      this.position = {
        lat: this.position.lat + (d * Math.cos(rad) / R) * 180 / Math.PI,
        lng: this.position.lng + (d * Math.sin(rad) / (R * Math.cos(this.position.lat * Math.PI / 180))) * 180 / Math.PI,
      };
      this._walkHeading = this._walkHeading == null ? b : this._walkHeading + angleDiff(this._walkHeading, b) * Math.min(1, dt * 3);
      this.onPosition?.(this.position, this.accuracy);
    }
    this.heading = ((this._walkHeading ?? 0) + this._yawOffset + 360) % 360;
    this.pitch = this._pitch;
    euler.set(this.pitch * THREE.MathUtils.DEG2RAD, -this.heading * THREE.MathUtils.DEG2RAD, 0, 'YXZ');
    this.quaternion.setFromEuler(euler);
  }
}
