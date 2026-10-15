// Indoor navigation model. A building file (buildings/<id>.json) describes:
//   floors:  [{ id, name, image, widthM, heightM, level }]        floor plan images and their real size in metres
//   nodes:   [{ id, floor, x, y, kind? }]                           walkable graph, metres from the plan's bottom-left
//                                                                    (x → right, y → up); kind: 'lift' | 'stairs'
//   edges:   [[nodeA, nodeB], ...]                                   walkable segments (both directions; lift/stairs
//                                                                    nodes on different floors connect floors)
//   places:  [{ id, name, node, category?, offer?, tagline? }]       destinations
//   anchors: [{ id, name, node, heading }]                           Saathi QR points. heading = plan bearing the person
//                                                                    faces while scanning (0 = up on the plan, 90 = right)
// QR for an anchor:  https://site/?b=<building id>&a=<anchor id>    (optional &to=<place id>)

export async function loadBuilding(idOrUrl) {
  if (idOrUrl.startsWith('local:')) { // unsaved building from the indoor editor's "Preview"
    const data = localStorage.getItem('saathi_building_' + idOrUrl.slice(6));
    if (!data) throw new Error('Preview expired - open it again from the editor');
    return new Building(JSON.parse(data), new URL(location.href));
  }
  const url = /^https?:|\.json$/.test(idOrUrl) ? idOrUrl : `buildings/${encodeURIComponent(idOrUrl)}.json`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Building "${idOrUrl}" not found`);
  return new Building(await res.json(), new URL(url, location.href));
}

export class Building {
  constructor(data, baseUrl) {
    this.data = data;
    this.id = data.id;
    this.name = data.name || 'Building';
    this.floors = data.floors || [];
    this.nodes = new Map((data.nodes || []).map(n => [n.id, n]));
    this.places = data.places || [];
    this.anchors = data.anchors || [];
    this.baseUrl = baseUrl;
    this.adj = new Map([...this.nodes.keys()].map(k => [k, []]));
    for (const [a, b] of data.edges || []) {
      const na = this.nodes.get(a), nb = this.nodes.get(b);
      if (!na || !nb) continue;
      const w = na.floor === nb.floor ? Math.hypot(na.x - nb.x, na.y - nb.y) : 15; // changing floors "costs" ~15 m
      this.adj.get(a).push({ to: b, w });
      this.adj.get(b).push({ to: a, w });
    }
  }

  /**
   * Destination at any spot on a floor plan: snaps to the nearest walkway, splitting that walkway with a temporary
   * node so the route ends exactly there. Returns the temporary place (id '_pin').
   */
  pinPlace(floorId, x, y, name = 'Selected spot') {
    this._removePin();
    let best = null;
    for (const [a, list] of this.adj) {
      const na = this.nodes.get(a);
      if (na.floor !== floorId) continue;
      for (const { to } of list) {
        const nb = this.nodes.get(to);
        if (nb.floor !== floorId || a > to) continue; // each edge once
        const dx = nb.x - na.x, dy = nb.y - na.y, l2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - na.x) * dx + (y - na.y) * dy) / l2));
        const px = na.x + dx * t, py = na.y + dy * t, d = Math.hypot(x - px, y - py);
        if (!best || d < best.d) best = { d, px, py, a, b: to };
      }
    }
    if (!best) return null;
    const pin = { id: '_pin', floor: floorId, x: +best.px.toFixed(2), y: +best.py.toFixed(2) };
    this.nodes.set(pin.id, pin);
    const link = (u, v) => {
      const w = Math.hypot(this.nodes.get(u).x - this.nodes.get(v).x, this.nodes.get(u).y - this.nodes.get(v).y);
      this.adj.get(u).push({ to: v, w });
    };
    this.adj.set(pin.id, []);
    for (const end of [best.a, best.b]) { link(pin.id, end); link(end, pin.id); }
    const place = { id: '_pin', name, node: pin.id, category: 'Dropped pin' };
    this.places.push(place);
    return place;
  }

  _removePin() {
    if (!this.nodes.has('_pin')) return;
    this.nodes.delete('_pin');
    this.adj.delete('_pin');
    for (const list of this.adj.values()) for (let i = list.length - 1; i >= 0; i--) if (list[i].to === '_pin') list.splice(i, 1);
    this.places = this.places.filter(p => p.id !== '_pin');
  }

  floor(id) { return this.floors.find(f => f.id === id) || this.floors[0]; }
  imageUrl(floor) { return new URL(floor.image, this.baseUrl).href; }
  anchor(id) { return this.anchors.find(a => a.id === id); }
  place(id) { return this.places.find(p => p.id === id); }

  /** Dijkstra over the walk graph. Returns node objects from `from` to `to`, or null. */
  shortestPath(from, to) {
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
    const open = [from];
    while (open.length) {
      open.sort((a, b) => dist.get(a) - dist.get(b));
      const u = open.shift();
      if (u === to) break;
      if (done.has(u)) continue;
      done.add(u);
      for (const { to: v, w } of this.adj.get(u) || []) {
        const d = dist.get(u) + w;
        if (d < (dist.get(v) ?? Infinity)) { dist.set(v, d); prev.set(v, u); open.push(v); }
      }
    }
    if (!dist.has(to)) return null;
    const ids = [to];
    while (ids[0] !== from) ids.unshift(prev.get(ids[0]));
    return ids.map(id => this.nodes.get(id));
  }

  /**
   * Route from an anchor to a place, split into legs per floor:
   *   [{ floor, points:[{x,y}], steps:[{ along, maneuver, instruction }], endsWith: 'arrive'|'lift'|'stairs', nextFloor }]
   */
  route(anchorId, placeId) {
    const a = this.anchor(anchorId), p = this.place(placeId);
    if (!a || !p) return null;
    const nodes = this.shortestPath(a.node, p.node);
    if (!nodes) return null;
    const legs = [];
    let cur = { floor: nodes[0].floor, nodes: [nodes[0]] };
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i].floor !== cur.floor) {
        const via = nodes[i - 1].kind || 'lift';
        legs.push({ ...cur, endsWith: via, nextFloor: nodes[i].floor });
        cur = { floor: nodes[i].floor, nodes: [nodes[i]] };
      } else cur.nodes.push(nodes[i]);
    }
    legs.push({ ...cur, endsWith: 'arrive' });
    return legs.map(l => this._leg(l, p));
  }

  _leg(l, dest) {
    const points = l.nodes.map(n => ({ x: n.x, y: n.y }));
    const steps = [];
    let along = 0;
    for (let i = 1; i < points.length - 1; i++) {
      along += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      const b1 = bearing(points[i - 1], points[i]), b2 = bearing(points[i], points[i + 1]);
      const turn = ((b2 - b1 + 540) % 360) - 180;
      if (Math.abs(turn) < 30) continue;
      const maneuver = Math.abs(turn) > 150 ? 'UTURN_LEFT'
        : turn > 0 ? (turn < 60 ? 'TURN_SLIGHT_RIGHT' : 'TURN_RIGHT') : (turn > -60 ? 'TURN_SLIGHT_LEFT' : 'TURN_LEFT');
      const landmark = this._landmarkNear(l.nodes[i], dest);
      steps.push({ along, maneuver, street: landmark ? `at ${landmark}` : '', instruction: '' });
    }
    const total = points.reduce((s, p, i) => i ? s + Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0, 0);
    if (l.endsWith !== 'arrive') {
      const nf = this.floor(l.nextFloor);
      steps.push({ along: total, maneuver: 'STRAIGHT', street: `${l.endsWith === 'stairs' ? 'Stairs' : 'Lift'} to ${nf?.name || l.nextFloor}`, instruction: '' });
    }
    return { floor: l.floor, points, steps, length: total, endsWith: l.endsWith, nextFloor: l.nextFloor };
  }

  _landmarkNear(node, dest) {
    let best = null, bd = 6;
    for (const p of this.places) {
      if (p.id === dest.id) continue;
      const n = this.nodes.get(p.node);
      if (!n || n.floor !== node.floor) continue;
      const d = Math.hypot(n.x - node.x, n.y - node.y);
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  }
}

function bearing(a, b) { return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360; }
