// Geo helpers. Local frame: metres East (x) / North (y) around an origin (equirectangular, fine for walks < 10 km).

const R = 6378137;
const D2R = Math.PI / 180;

export function toLocal(origin, p) {
  return {
    x: (p.lng - origin.lng) * D2R * Math.cos(origin.lat * D2R) * R,
    y: (p.lat - origin.lat) * D2R * R,
  };
}

export function fromLocal(origin, v) {
  return {
    lat: origin.lat + (v.y / R) / D2R,
    lng: origin.lng + (v.x / (R * Math.cos(origin.lat * D2R))) / D2R,
  };
}

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b, degrees clockwise from north. */
export function bearing(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R, dl = (b.lng - a.lng) * D2R;
  const y = Math.sin(dl) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

export const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;

/** Google encoded polyline (precision 5) → [{lat,lng}]. */
export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return pts;
}

/**
 * A polyline in local metres with cumulative distances, projection and sampling.
 */
export class Path {
  constructor(origin, latlngs) {
    this.origin = origin;
    this.pts = latlngs.map(p => toLocal(origin, p));
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + dist(this.pts[i - 1], this.pts[i]));
    this.length = this.cum[this.cum.length - 1] || 0;
  }

  /** Point and unit direction at distance d along the path. */
  at(d) {
    const { pts, cum } = this;
    if (pts.length === 1) return { p: { ...pts[0] }, dir: { x: 0, y: 1 } };
    d = Math.max(0, Math.min(this.length, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1e-6, t = (d - cum[i - 1]) / seg;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    return { p: { x: a.x + dx * t, y: a.y + dy * t }, dir: { x: dx / len, y: dy / len } };
  }

  /** Closest point to local p: { along, lateral, seg }. Searches from hint segment first. */
  project(p, hint = 0, window = 80) {
    const best = this._project(p, Math.max(0, hint - 5), Math.min(this.pts.length - 1, hint + window));
    if (best.lateral < 30) return best;
    return this._project(p, 0, this.pts.length - 1);
  }

  _project(p, from, to) {
    let best = { along: 0, lateral: Infinity, seg: from };
    for (let i = from; i < to; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const lat = Math.hypot(p.x - qx, p.y - qy);
      if (lat < best.lateral) best = { along: this.cum[i] + Math.sqrt(l2) * t, lateral: lat, seg: i };
    }
    return best;
  }
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export function formatDistance(m) {
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  if (m >= 100) return Math.round(m / 10) * 10 + ' m';
  return Math.max(0, Math.round(m)) + ' m';
}

export function formatDuration(s) {
  const mins = Math.max(1, Math.round(s / 60));
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

/**
 * Smooths noisy GPS fixes: accuracy-weighted blend, plus outlier rejection for jumps that imply
 * walking faster than ~4 m/s.
 */
export class PositionFilter {
  constructor() { this.pos = null; this.acc = Infinity; this.t = 0; }

  push(lat, lng, accuracy, time) {
    const p = { lat, lng };
    if (!this.pos) { this.pos = p; this.acc = accuracy; this.t = time; return this.pos; }
    const dt = Math.max(0.2, (time - this.t) / 1000);
    const jump = haversine(this.pos, p);
    if (jump > 4 * dt + accuracy * 1.5 && accuracy > 15) return this.pos; // implausible jump on a poor fix
    // Kalman-like gain: trust the new fix more when it's accurate relative to our estimate.
    const est = this.acc + 1.4 * dt; // uncertainty grows while walking
    const k = est * est / (est * est + accuracy * accuracy);
    this.pos = { lat: this.pos.lat + (lat - this.pos.lat) * k, lng: this.pos.lng + (lng - this.pos.lng) * k };
    this.acc = Math.sqrt((1 - k) * est * est);
    this.t = time;
    return this.pos;
  }
}
