// Indoor map editor: floor plans, walkway graph, destinations, lifts and Saathi points → buildings/<id>.json + QR posters.

const $ = id => document.getElementById(id);
const cv = $('cv'), g = cv.getContext('2d');

let B = blank();                  // building data (same schema the app reads)
let floorIdx = 0;
const images = new Map();         // floor id → HTMLImageElement
let tool = 'walk', lastNode = null, scalePts = null, drag = null;
let view = { s: 1, x: 0, y: 0 };  // canvas px = image px * s + offset
let liftPick = null;

function blank() { return { id: 'my-building', name: 'My Building', floors: [], nodes: [], edges: [], places: [], anchors: [] }; }
const floor = () => B.floors[floorIdx];
const uid = p => p + Math.random().toString(36).slice(2, 7);

// ───────────── Coordinates ─────────────
// Plan metres: x right, y up from the image's bottom-left. mpp = metres per image pixel.
const mpp = f => f.widthM / (images.get(f.id)?.naturalWidth || 1);
function toMetres(px, py) {
  const f = floor(), img = images.get(f.id), k = mpp(f);
  return { x: px * k, y: (img.naturalHeight - py) * k };
}
function toImage(m) { const f = floor(), img = images.get(f.id), k = mpp(f); return { x: m.x / k, y: img.naturalHeight - m.y / k }; }
const toCanvas = p => ({ x: p.x * view.s + view.x, y: p.y * view.s + view.y });
const fromCanvas = (cx, cy) => ({ x: (cx - view.x) / view.s, y: (cy - view.y) / view.s });

// ───────────── Rendering ─────────────
function resize() {
  const r = cv.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  draw();
}
function fit() {
  const f = floor(); const img = f && images.get(f.id);
  if (!img) return;
  const r = cv.getBoundingClientRect();
  view.s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) * 0.95;
  view.x = (r.width - img.naturalWidth * view.s) / 2;
  view.y = (r.height - img.naturalHeight * view.s) / 2;
}

function draw() {
  g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const f = floor(), img = f && images.get(f.id);
  $('empty').hidden = !!img;
  if (!img) return;
  const o = toCanvas({ x: 0, y: 0 });
  g.drawImage(img, o.x, o.y, img.naturalWidth * view.s, img.naturalHeight * view.s);
  const nodes = B.nodes.filter(n => n.floor === f.id);
  const P = n => toCanvas(toImage(n));
  // edges
  g.lineCap = 'round';
  for (const [a, b] of B.edges) {
    const na = node(a), nb = node(b);
    if (!na || !nb || na.floor !== f.id || nb.floor !== f.id) continue;
    const pa = P(na), pb = P(nb);
    g.strokeStyle = '#ffffff'; g.lineWidth = 9; line(pa, pb);
    g.strokeStyle = '#1fae5b'; g.lineWidth = 5; line(pa, pb);
  }
  // nodes
  for (const n of nodes) {
    const p = P(n);
    const pl = B.places.find(x => x.node === n.id), an = B.anchors.find(x => x.node === n.id);
    g.fillStyle = n.kind ? '#3b6fd8' : pl ? '#e8453c' : '#1fae5b';
    g.beginPath(); g.arc(p.x, p.y, n === lastNode ? 9 : (pl || n.kind ? 8 : 5), 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    if (an) { // Saathi point: square + facing arrow
      g.save(); g.translate(p.x, p.y);
      g.strokeStyle = '#111'; g.lineWidth = 3; g.strokeRect(-11, -11, 22, 22);
      g.rotate(an.heading * Math.PI / 180);
      g.fillStyle = '#111'; g.beginPath(); g.moveTo(0, -30); g.lineTo(7, -18); g.lineTo(-7, -18); g.closePath(); g.fill();
      g.fillRect(-1.5, -18, 3, 7);
      g.restore();
    }
    const label = pl?.name || an?.name || (n.kind ? n.kind : '');
    if (label) {
      g.font = '600 12px Inter, sans-serif'; g.textAlign = 'center';
      const w = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(p.x - w / 2, p.y + 11, w, 17);
      g.fillStyle = '#222'; g.fillText(label, p.x, p.y + 24);
    }
  }
  if (scalePts) for (const sp of scalePts) { const p = toCanvas(sp); g.fillStyle = '#f5b400'; g.beginPath(); g.arc(p.x, p.y, 7, 0, 7); g.fill(); }
  renderList();
}
const line = (a, b) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };
const node = id => B.nodes.find(n => n.id === id);

// ───────────── Interaction ─────────────
function hitNode(cx, cy) {
  const f = floor(); let best = null, bd = 14;
  for (const n of B.nodes) {
    if (n.floor !== f.id) continue;
    const p = toCanvas(toImage(n)), d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
function addNode(cx, cy, kind) {
  const ip = fromCanvas(cx, cy), m = toMetres(ip.x, ip.y);
  const n = { id: uid('n'), floor: floor().id, x: +m.x.toFixed(2), y: +m.y.toFixed(2) };
  if (kind) n.kind = kind;
  B.nodes.push(n);
  return n;
}
function link(a, b) {
  if (!a || !b || a === b) return;
  if (!B.edges.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id))) B.edges.push([a.id, b.id]);
}

cv.addEventListener('pointerdown', e => {
  const f = floor(); if (!f || !images.get(f.id)) return;
  const r = cv.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
  if (e.button === 1 || e.button === 2 || e.altKey) { drag = { pan: true, x: cx, y: cy, vx: view.x, vy: view.y }; return; }
  if (scalePts) return scaleClick(cx, cy);
  const hit = hitNode(cx, cy);
  if (tool === 'walk') {
    const n = hit || addNode(cx, cy);
    if (lastNode && lastNode.floor === n.floor) link(lastNode, n);
    lastNode = n;
  } else if (tool === 'move') {
    if (hit) drag = { node: hit };
  } else if (tool === 'erase') {
    if (hit) eraseNode(hit);
  } else if (tool === 'place') {
    const n = hit || addNode(cx, cy);
    editPlace(n);
  } else if (tool === 'anchor') {
    const n = hit || addNode(cx, cy);
    editAnchor(n);
  } else if (tool === 'lift') {
    const n = hit || addNode(cx, cy, 'lift');
    n.kind ||= 'lift';
    const kind = prompt('Lift or stairs?', n.kind) || n.kind;
    n.kind = /stair/i.test(kind) ? 'stairs' : 'lift';
    if (liftPick && liftPick.floor !== n.floor) {
      link(liftPick, n);
      hint(`Linked ${floorName(liftPick.floor)} ↔ ${floorName(n.floor)}.`);
      liftPick = null;
    } else {
      liftPick = n;
      hint('Now switch to the other floor and click the same lift there to connect the floors.');
    }
  }
  draw();
});
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  const r = cv.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
  if (drag.pan) { view.x = drag.vx + cx - drag.x; view.y = drag.vy + cy - drag.y; }
  else if (drag.node) { const ip = fromCanvas(cx, cy), m = toMetres(ip.x, ip.y); drag.node.x = +m.x.toFixed(2); drag.node.y = +m.y.toFixed(2); }
  draw();
});
addEventListener('pointerup', () => drag = null);
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * 0.0015), before = fromCanvas(cx, cy);
  view.s = Math.max(0.05, Math.min(8, view.s * k));
  view.x = cx - before.x * view.s; view.y = cy - before.y * view.s;
  draw();
}, { passive: false });
addEventListener('keydown', e => { if (e.key === 'Escape') { lastNode = null; scalePts = null; liftPick = null; draw(); } });

function eraseNode(n) {
  B.nodes = B.nodes.filter(x => x !== n);
  B.edges = B.edges.filter(([a, b]) => a !== n.id && b !== n.id);
  B.places = B.places.filter(p => p.node !== n.id);
  B.anchors = B.anchors.filter(a => a.node !== n.id);
  if (lastNode === n) lastNode = null;
}

function editPlace(n) {
  const p = B.places.find(x => x.node === n.id);
  const name = prompt('Destination name (shop, room, toilet…)', p?.name || '');
  if (name === null) return;
  if (!name.trim()) { B.places = B.places.filter(x => x !== p); return; }
  const category = prompt('Category (optional)', p?.category || '') ?? '';
  const offer = prompt('Offer for Saathi visitors (optional)', p?.offer || '') ?? '';
  const data = { id: p?.id || slug(name) + '-' + uid(''), name: name.trim(), node: n.id, category: category.trim(), offer: offer.trim() };
  if (p) Object.assign(p, data); else B.places.push(data);
  if (!B.edges.some(([a, b]) => a === n.id || b === n.id)) hint('Tip: connect this destination to a walkway (Walkway tool) so routes can reach it.');
}

function editAnchor(n) {
  const a = B.anchors.find(x => x.node === n.id);
  const name = prompt('Saathi point name (where the QR is stuck, e.g. "Main entrance")', a?.name || '');
  if (name === null) return;
  if (!name.trim()) { B.anchors = B.anchors.filter(x => x !== a); return; }
  const h = prompt('Which way does a person FACE while scanning it?\n0 = up on the plan, 90 = right, 180 = down, 270 = left', a?.heading ?? 0);
  const data = { id: a?.id || 'A' + (B.anchors.length + 1), name: name.trim(), node: n.id, heading: ((+h || 0) % 360 + 360) % 360 };
  if (a) Object.assign(a, data); else B.anchors.push(data);
}

// ───────────── Floors & scale ─────────────
function floorName(id) { return B.floors.find(f => f.id === id)?.name || id; }
function refreshFloors() {
  $('floor-sel').innerHTML = B.floors.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join('') || '<option>No floors yet</option>';
  $('floor-sel').value = floorIdx;
  const f = floor();
  $('floor-name').value = f?.name || '';
  $('scale-info').textContent = f && images.get(f.id) ? `Plan size: ${f.widthM.toFixed(1)} × ${f.heightM.toFixed(1)} m` : '';
}
$('floor-add').onclick = () => {
  const n = B.floors.length;
  B.floors.push({ id: n ? String(n) : 'G', name: n ? `Floor ${n}` : 'Ground floor', level: n, image: '', widthM: 50, heightM: 30 });
  floorIdx = n; lastNode = null; refreshFloors(); draw();
  hint('Choose the floor plan image for this floor.');
};
$('floor-sel').onchange = () => { floorIdx = +$('floor-sel').value; lastNode = null; refreshFloors(); fit(); draw(); };
$('floor-name').oninput = () => { if (floor()) { floor().name = $('floor-name').value; refreshFloors(); } };
$('floor-img').onchange = () => {
  const file = $('floor-img').files[0]; if (!file) return;
  if (!floor()) $('floor-add').click();
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const f = floor();
      images.set(f.id, img);
      f.image = reader.result; // embedded so the building file is self-contained
      f.heightM = f.widthM * img.naturalHeight / img.naturalWidth;
      fit(); refreshFloors(); draw();
      hint('Now set the scale: click "Set scale", then two points a known distance apart (e.g. the ends of a 10 m corridor).');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};
$('scale-btn').onclick = () => { scalePts = []; hint('Click the first point…'); };
function scaleClick(cx, cy) {
  scalePts.push(fromCanvas(cx, cy));
  if (scalePts.length < 2) { hint('Click the second point…'); draw(); return; }
  const [a, b] = scalePts, px = Math.hypot(b.x - a.x, b.y - a.y);
  const m = parseFloat(prompt('Real distance between the two points, in metres', '10'));
  scalePts = null;
  if (!(m > 0) || px < 2) { draw(); return; }
  const f = floor(), img = images.get(f.id);
  const oldK = mpp(f), newK = m / px;
  // keep existing nodes on the same image pixels
  for (const n of B.nodes.filter(n => n.floor === f.id)) { n.x = +(n.x / oldK * newK).toFixed(2); n.y = +(n.y / oldK * newK).toFixed(2); }
  f.widthM = img.naturalWidth * newK; f.heightM = img.naturalHeight * newK;
  refreshFloors(); draw();
  hint('Scale set. Now draw walkways along corridors: click to add points, they join up as you go. Esc starts a new line.');
}

// ───────────── Tools UI ─────────────
const HINTS = {
  walk: 'Click along corridors to draw walkways. Click an existing point to join. Esc = start a new line. Alt/right-drag = pan, wheel = zoom.',
  place: 'Click a point on a walkway to make it a destination (shop door, toilet, desk…).',
  anchor: 'Click where a Saathi point QR will be stuck. You\'ll set which way people face when scanning.',
  lift: 'Click the lift/stairs on this floor, then the same lift on another floor to connect floors.',
  move: 'Drag points to adjust them.',
  erase: 'Click a point to delete it and its walkways.',
};
for (const b of document.querySelectorAll('.tool')) b.onclick = () => {
  document.querySelectorAll('.tool').forEach(x => x.classList.toggle('on', x === b));
  tool = b.dataset.tool; lastNode = null; hint(HINTS[tool]); draw();
};
function hint(t) { $('hint').textContent = t; }

function renderList() {
  const rows = [
    ...B.anchors.map(a => `<div><span>▣ ${esc(a.name)}</span><small>${esc(floorName(node(a.node)?.floor))} · faces ${a.heading}°</small></div>`),
    ...B.places.map(p => `<div><span>📍 ${esc(p.name)}</span><small>${esc(floorName(node(p.node)?.floor))}</small></div>`),
  ];
  $('list').innerHTML = rows.join('') || '<small>No destinations or Saathi points yet.</small>';
}

// ───────────── Load / save ─────────────
$('b-name').oninput = () => B.name = $('b-name').value;
$('b-id').oninput = () => B.id = slug($('b-id').value) || 'building';

async function loadData(data, base) {
  B = data; floorIdx = 0; images.clear(); lastNode = null;
  $('b-name').value = B.name; $('b-id').value = B.id;
  await Promise.all(B.floors.map(f => new Promise(res => {
    // Absolute image URLs so "Preview" works no matter which page loads the building.
    if (!/^data:|^https?:/.test(f.image)) f.image = new URL(f.image, base).href;
    const img = new Image();
    img.onload = () => { images.set(f.id, img); res(); };
    img.onerror = res;
    img.src = /^data:|^https?:/.test(f.image) ? f.image : new URL(f.image, base).href;
  })));
  refreshFloors(); fit(); draw();
}
$('load-demo').onclick = async () => {
  const url = new URL('buildings/demo-mall.json', location.href);
  await loadData(await (await fetch(url)).json(), url);
  hint('Demo mall loaded. Try the tools, then "Preview in simulator".');
};
$('import').onchange = async () => {
  const f = $('import').files[0]; if (!f) return;
  try { await loadData(JSON.parse(await f.text()), location.href); } catch { alert('That file is not a Saathi building file.'); }
};

function problems() {
  const out = [];
  if (!B.floors.length) out.push('Add at least one floor.');
  if (!B.anchors.length) out.push('Add at least one Saathi point.');
  if (!B.places.length) out.push('Add at least one destination.');
  return out;
}
function download(name, blob) { const a = document.createElement('a'); a.download = name; a.href = URL.createObjectURL(blob); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
$('export').onclick = () => {
  const p = problems(); if (p.length) return alert(p.join('\n'));
  download(`${B.id}.json`, new Blob([JSON.stringify(B)], { type: 'application/json' }));
};
$('preview').onclick = () => {
  const p = problems(); if (p.length) return alert(p.join('\n'));
  try { localStorage.setItem('saathi_building_' + B.id, JSON.stringify(B)); }
  catch { return alert('Floor images are too large to preview locally. Export the file and put it in buildings/ instead.'); }
  const a = B.anchors[0];
  open(`index.html?b=local:${encodeURIComponent(B.id)}&a=${encodeURIComponent(a.id)}&sim=1`, '_blank');
};

// ───────────── Saathi point posters ─────────────
$('base').value = new URL('./', location.href).href;
$('posters').onclick = () => {
  const p = problems(); if (p.length) return alert(p.join('\n'));
  let base = $('base').value.trim() || location.href;
  if (!/^https?:\/\//.test(base)) base = 'https://' + base;
  for (const a of B.anchors) {
    const u = new URL(base); u.search = ''; u.searchParams.set('b', B.id); u.searchParams.set('a', a.id);
    poster(a, u.toString()).toBlob(blob => download(`saathi-point-${B.id}-${a.id}.png`, blob));
  }
};
function poster(a, url) {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 1300;
  const x = c.getContext('2d');
  x.fillStyle = '#1fae5b'; x.fillRect(0, 0, 1000, 1300);
  x.fillStyle = '#fff'; roundRect(x, 50, 50, 900, 1200, 50); x.fill();
  x.fillStyle = '#262628'; x.textAlign = 'center';
  x.font = '700 54px Gelasio, Georgia, serif'; x.fillText('Saathi point', 500, 150);
  x.font = '500 34px Inter, sans-serif'; x.fillStyle = '#6b6b70'; x.fillText(`${B.name} · ${a.name}`, 500, 205);
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  const n = qr.getModuleCount(), size = 700, cell = size / n;
  x.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) x.fillRect(150 + col * cell, 260 + r * cell, cell + 0.6, cell + 0.6);
  x.fillStyle = '#262628'; x.font = '700 46px Gelasio, Georgia, serif';
  x.fillText('Scan to find your way inside', 500, 1060);
  x.font = '500 30px Inter, sans-serif'; x.fillStyle = '#6b6b70';
  x.fillText('Opens in your phone browser · no app needed', 500, 1110);
  x.fillText('Stand facing this sign while you scan', 500, 1160);
  return c;
}
function roundRect(x, l, t, w, h, r) { x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); }

const slug = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

addEventListener('resize', () => { resize(); });
refreshFloors(); hint(HINTS.walk); resize();
