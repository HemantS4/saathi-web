// Saathi web: QR (or a searched destination) → AR walking navigation using camera + GPS + compass.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { placeFromUrl, googleMapsNavUrl, isValid, parseGoogleMaps, isShortMapsLink, buildNavUrl } from './place.js';
import { suggest, resolve, reverseGeocode, recents, addRecent, quietPosition } from './search.js';
import { Path, toLocal, fromLocal, haversine, bearing, angleDiff, formatDistance, formatDuration } from './geo.js';
import { computeRoute, shortManeuver, maneuverIconPath } from './routing.js';
import { Sensors, SimSensors, Pedometer, startCamera, requestPermissions, isMobile } from './sensors.js';
import { XRSession, xrSupported } from './xr.js';
import { Aligner } from './align.js';
import { loadBuilding } from './indoor.js';
import { ARScene } from './ar.js';
import { NavMap, loadPlaceDetails } from './map.js';

const $ = id => document.getElementById(id);
const QS = new URLSearchParams(location.search);
const SIM = QS.has('sim');
// Indoor links come from Saathi point QR codes: ?b=<building>&a=<anchor>[&to=<place>]
const INDOOR_LINK = QS.has('b');
let place = INDOOR_LINK ? null : placeFromUrl();

const S = {
  sensors: null, ar: null, map: null, stream: null, wakeLock: null,
  path: null, maneuvers: [], along: 0, seg: 0, duration: 0,
  announced: -1, offRouteSince: 0, rerouting: false, running: false,
  tripPoints: 0, voice: localStorage.getItem('saathi_voice') !== 'off',
  mapExpanded: false, mapManual: false, last: 0, arrived: false,
  eyeHeight: +localStorage.getItem('saathi_eye') || CONFIG.eyeHeight,
};

// ───────────── Screens ─────────────

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function loading(title, detail = '') {
  $('loading-title').textContent = title;
  $('loading-detail').textContent = detail;
  show('loading');
}

function fail(message, title = 'Oops!') {
  $('error').querySelector('h2').textContent = title;
  $('retry-btn').textContent = 'Try again';
  $('retry-btn').onclick = () => location.reload();
  $('retry-btn').hidden = false;
  $('error-text').textContent = message;
  if (place && (isValid(place) || place.placeId)) $('error-gmaps').href = googleMapsNavUrl(place);
  else $('error-gmaps').hidden = true;
  show('error');
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, ms);
}

function say(text, interrupt = true) {
  if (!S.voice || !('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = CONFIG.language;
  u.rate = 0.98;
  speechSynthesis.speak(u);
}

// ───────────── Landing ─────────────

async function initLanding() {
  $('brand-name').textContent = CONFIG.brand;
  if (INDOOR_LINK && !S.building && !S.leftBuilding) { await initIndoor(); return; }
  if (!place) { showSearch(); return; }
  resetLandingCard();
  document.title = `${place.name} – ${CONFIG.brand}`;
  $('place-name').textContent = place.name;
  $('place-initials').textContent = initials(place.name);
  $('place-sub').textContent = place.tagline || '';
  if (place.offer) { $('place-offer').textContent = place.offer; $('place-offer').hidden = false; }
  show('landing');

  if (place.indoor) {
    // Indoors: floor plan instead of a street map; start point comes from the scanned Saathi point.
    $('gmaps-btn').hidden = $('share-btn').hidden = true;
    $('rescan-landing').hidden = false;
    $('place-meta').innerHTML = S.anchor ? `Starting from <b>${escapeHtml(S.anchor.name)}</b>` : 'Scan a Saathi point QR first';
    $('place-meta').hidden = false;
    $('start-btn').disabled = !S.anchor;
    const floor = S.building.floor(place.floor);
    const dest = { lat: place.y, lng: place.x, name: place.name };
    const startNode = S.anchor && S.building.nodes.get(S.anchor.node);
    $('landing-map').hidden = true;
    $('landing-plan').hidden = false;
    const firstPlan = !S.landingPlan;
    S.landingPlan ||= new NavMap($('landing-plan'));
    await S.landingPlan.initIndoor(S.building, floor, startNode ? { lat: startNode.y, lng: startNode.x } : dest, dest);
    S.landingPlan.setDest(dest);
    if (!startNode || startNode.floor !== place.floor) S.landingPlan.hideUser();
    S.landingPlan.follow = false;
    S.landingPlan.invalidate();
    if (firstPlan) S.landingPlan.onTap(pos => pickOnMap(pos, place.floor)); // tap anywhere → navigate there
    return;
  }
  $('gmaps-btn').hidden = $('share-btn').hidden = false;
  $('rescan-landing').hidden = true;
  $('start-btn').disabled = false;
  $('gmaps-btn').href = googleMapsNavUrl(place);

  if (!isMobile && !SIM) {
    $('desktop-note').hidden = false;
    drawQr($('desktop-qr'), shareUrl());
    $('sim-btn').onclick = () => { const u = new URL(location.href); u.searchParams.set('sim', '1'); location.href = u; };
  }

  // Google Places: real photo, rating, opening status, address (and location for place-id-only links).
  const shown = place;
  const details = await loadPlaceDetails(place);
  if (shown !== place) return; // destination changed while loading
  if (details) {
    if (!isValid(place) && details.location) Object.assign(place, details.location);
    if (place.name === 'Destination' && details.name) { place.name = details.name; $('place-name').textContent = details.name; }
    if (!place.tagline && details.address) $('place-sub').textContent = details.address.split(',').slice(0, 2).join(',');
    const bits = [];
    if (details.rating) bits.push(`<span class="star">★</span> ${details.rating.toFixed(1)} <span class="muted">(${details.ratingCount})</span>`);
    if (details.openNow === true) bits.push('<span class="open">Open now</span>');
    if (details.openNow === false) bits.push('<span class="closed">Closed now</span>');
    if (bits.length) { $('place-meta').innerHTML = bits.join(' · '); $('place-meta').hidden = false; }
    if (details.photoUrl) {
      const img = $('place-img');
      img.onload = () => { img.hidden = false; if (details.photoCredit) { $('place-credit').textContent = 'Photo: ' + details.photoCredit; $('place-credit').hidden = false; } };
      img.src = details.photoUrl;
    }
  }
  if (!isValid(place)) { fail("Couldn't find this place's location."); return; }

  $('landing-map').hidden = false;
  $('landing-plan').hidden = true;
  if (!S.landingMap) {
    S.landingMap = await new NavMap($('landing-map')).init(place, place);
    S.landingMap.hideUser?.();
    S.landingMap.follow = false;
    S.landingMap.onTap(pos => pickOnMap(pos, null)); // tap anywhere → navigate there
  }
  S.landingMap.invalidate();
  S.landingMap.setDest(place, 17);

  // Distance from here (only if location was already allowed, so we don't prompt on page load).
  const here = await quietPosition();
  if (here && shown === place) {
    S.landingMap.showUserAt(here);
    const d = haversine(here, place);
    $('place-sub').textContent = [place.tagline || $('place-sub').textContent, `${formatDistance(d)} away`].filter(Boolean).join(' · ');
    if (d > 5000) {
      $('far-note').textContent = `This is ${formatDistance(d)} away, a long walk. You can still use AR, or open Google Maps for other ways to get there.`;
      $('far-note').hidden = false;
    }
  }
}

function resetLandingCard() {
  $('place-img').hidden = true;
  $('place-img').removeAttribute('src');
  $('place-credit').hidden = true;
  $('place-meta').hidden = true;
  $('place-offer').hidden = true;
  $('far-note').hidden = true;
  $('desktop-note').hidden = true;
}

/** Link to this destination without simulator flags (for sharing / QR). */
function shareUrl() {
  return buildNavUrl(new URL('./', location.href).href, place);
}

// ───────────── Where to? ─────────────
// One screen for everything: outdoor search (any place), the scanned building's shops/rooms when you're inside one,
// recents, and "tap any spot" on either the street map or the building's floor plan.

let searchSeq = 0, searchTimer = 0;

/** Outdoor destination: drops any building context from the link. */
function choosePlace(p) {
  place = { name: p.name || 'Destination', lat: p.lat, lng: p.lng, placeId: p.placeId || '', offer: p.offer || '', tagline: p.tagline || '' };
  document.body.classList.remove('indoor');
  addRecent(place);
  const u = new URL(shareUrl());
  if (SIM) u.searchParams.set('sim', '1');
  history.pushState(null, '', u);
  initLanding();
}

/** Indoor destination (a listed place or a pinned spot) inside the scanned building. */
function chooseIndoor(p) {
  place = indoorPlace(p);
  document.body.classList.add('indoor');
  const u = new URL('./', location.href);
  u.searchParams.set('b', QS.get('b') || S.building.id);
  if (S.anchor) u.searchParams.set('a', S.anchor.id);
  u.searchParams.set('to', p.id === '_pin' ? `@${place.floor},${place.x},${place.y}` : p.id);
  if (SIM) u.searchParams.set('sim', '1');
  history.pushState(null, '', u);
  initLanding();
}

async function showSearch() {
  const b = S.building;
  document.title = `Where to? – ${CONFIG.brand}`;
  show('search');
  $('search-title').textContent = 'Where to?';
  $('search-input').placeholder = b ? `Search ${b.name} or anywhere else` : 'Search a place, or paste a Google Maps link';
  $('search-status').textContent = '';
  $('pin-card').hidden = true;
  $('indoor-wrap').hidden = !b;
  $('map-tabs').hidden = !b;
  if (b) {
    $('indoor-title').textContent = S.anchor ? `Inside ${b.name} · you're at ${S.anchor.name}` : `Inside ${b.name}`;
    $('plan-floor').innerHTML = b.floors.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    const here = S.anchor && b.nodes.get(S.anchor.node);
    if (here) $('plan-floor').value = here.floor;
  }
  renderIndoorResults();
  renderRecents();
  setTimeout(() => $('search-input').focus(), 50);
  await setMapTab(b ? (S.mapTab || 'plan') : 'street');
}

async function setMapTab(tab) {
  S.mapTab = tab;
  for (const t of document.querySelectorAll('#map-tabs [data-map]')) t.classList.toggle('on', t.dataset.map === tab);
  $('search-map').hidden = tab !== 'street';
  $('plan-map').hidden = tab !== 'plan';
  $('plan-floor').hidden = tab !== 'plan';
  $('map-tip').textContent = tab === 'plan' ? 'Or tap any spot on the floor plan' : 'Or tap the map to drop a pin';
  $('pin-card').hidden = true;
  if (tab === 'plan') return showPlanMap();

  S.near ??= await quietPosition();
  if (!S.searchMap) {
    const start = S.near || recents()[0] || { lat: 22.5, lng: 79.0 }; // centre of India when we know nothing
    S.searchMap = await new NavMap($('search-map')).init(start, start);
    S.searchMap.follow = false;
    S.searchMap.setDest(null);
    if (S.near) S.searchMap.showUserAt(S.near); else S.searchMap.hideUser();
    S.searchMap.setView(start, S.near || recents()[0] ? 15 : 4);
    S.searchMap.onTap(dropPin);
  } else S.searchMap.invalidate();
}

async function showPlanMap() {
  const b = S.building, floor = b.floor($('plan-floor').value);
  const here = S.anchor && b.nodes.get(S.anchor.node);
  const centre = { lat: floor.heightM / 2, lng: floor.widthM / 2 };
  const start = here && here.floor === floor.id ? { lat: here.y, lng: here.x } : centre;
  const first = !S.planMap;
  S.planMap ||= new NavMap($('plan-map'));
  await S.planMap.initIndoor(b, floor, start, centre);
  S.planMap.follow = false;
  S.planMap.setDest(null);
  if (here && here.floor === floor.id) S.planMap.showUserAt(start); else S.planMap.hideUser();
  S.planMap.invalidate();
  if (first) S.planMap.onTap(pos => dropIndoorPin(pos));
}

function dropIndoorPin(pos) {
  const b = S.building, floorId = $('plan-floor').value;
  const p = b.pinPlace(floorId, pos.lng, pos.lat, `Spot on ${b.floor(floorId).name}`);
  if (!p) return;
  const n = b.nodes.get(p.node);
  S.planMap.setDest({ lat: n.y, lng: n.x });
  S.pin = { indoor: p };
  $('pin-card').hidden = false;
  $('pin-name').textContent = p.name;
  $('pin-sub').textContent = 'Nearest walkway point';
}

async function dropPin(pos) {
  S.searchMap.setDest(pos);
  $('pin-card').hidden = false;
  $('pin-name').textContent = 'Dropped pin';
  $('pin-sub').textContent = 'Finding address…';
  S.pin = { lat: pos.lat, lng: pos.lng, name: 'Dropped pin', tagline: '' };
  const seq = ++searchSeq;
  const r = await reverseGeocode(pos);
  if (seq !== searchSeq && S.pin?.lat !== pos.lat) return;
  Object.assign(S.pin, r);
  $('pin-name').textContent = r.name;
  $('pin-sub').textContent = r.tagline || `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
}

/** Opens the search screen with a pin already dropped where a map was tapped. */
async function pickOnMap(pos, indoor) {
  stopNav();
  await showSearch();
  if (indoor && S.building) {
    await setMapTab('plan');
    $('plan-floor').value = indoor;
    await showPlanMap();
    dropIndoorPin(pos);
  } else {
    await setMapTab('street');
    S.searchMap.setView(pos, 17);
    dropPin(pos);
  }
  $('pin-card').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function onSearchInput() {
  renderIndoorResults();
  const text = $('search-input').value;
  $('search-clear').hidden = !text;
  clearTimeout(searchTimer);
  const status = $('search-status');
  status.className = 'search-status';

  if (!text.trim()) { status.textContent = ''; $('search-results').innerHTML = ''; renderRecents(); return; }
  $('recent-wrap').hidden = true;

  if (isShortMapsLink(text)) {
    status.textContent = "Short Google Maps links can't be read here. Open the link, then copy the full address from the browser bar.";
    status.className = 'search-status err';
    $('search-results').innerHTML = '';
    return;
  }
  const g = parseGoogleMaps(text);
  if (g && isValid(g)) {
    status.textContent = '';
    renderResults([{ title: g.name || 'Location from link', subtitle: `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}`, lat: g.lat, lng: g.lng, placeId: g.placeId }]);
    return;
  }

  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    status.textContent = 'Searching…';
    try {
      const list = await suggest(text, S.near);
      if (seq !== searchSeq) return;
      status.textContent = list.length ? '' : 'No places found. Try another name, or drop a pin on the map.';
      renderResults(list);
    } catch (e) {
      if (seq !== searchSeq) return;
      status.textContent = "Search isn't available right now. Check your connection, or drop a pin on the map.";
      status.className = 'search-status err';
    }
  }, 280);
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 22s-7-7.6-7-12.5a7 7 0 0 1 14 0C19 14.4 12 22 12 22zm0-9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.4 2-1 1.7L11 13V7h2z"/></svg>';
const SHOP_SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h16l1 5a3 3 0 0 1-5 2 3 3 0 0 1-4 0 3 3 0 0 1-4 0 3 3 0 0 1-5-2zm1 8.5V20h14v-7.5a4.6 4.6 0 0 1-3 .3V18H8v-5.2a4.6 4.6 0 0 1-3-.3z"/></svg>';

function renderResults(list) {
  const ul = $('search-results');
  ul.innerHTML = '';
  for (const s of list) ul.appendChild(resultItem(s, PIN_SVG, async () => {
    $('search-status').textContent = 'Opening…';
    try { choosePlace(await resolve(s)); $('search-status').textContent = ''; }
    catch { $('search-status').textContent = "Couldn't open that place. Try another."; }
  }));
}

function renderRecents() {
  const list = recents();
  $('recent-wrap').hidden = !list.length || !!$('search-input').value;
  const ul = $('recent-list');
  ul.innerHTML = '';
  for (const r of list) {
    const d = S.near ? haversine(S.near, r) : undefined;
    ul.appendChild(resultItem({ title: r.name, subtitle: r.tagline, distance: d }, CLOCK_SVG, () => choosePlace(r)));
  }
}

function resultItem(s, icon, onPick) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="ico">${icon}</span><span class="txt"><b></b><small></small></span>` +
    (Number.isFinite(s.distance) ? `<span class="dist">${formatDistance(s.distance)}</span>` : '');
  li.querySelector('b').textContent = s.title;
  li.querySelector('small').textContent = s.subtitle || '';
  li.onclick = onPick;
  return li;
}

// ───────────── Indoor ─────────────

async function initIndoor() {
  loading('Loading the building map…');
  try {
    S.building = await loadBuilding(QS.get('b'));
  } catch (e) {
    fail("Couldn't load this building's map. Check your internet connection, or ask staff for help.");
    return;
  }
  const b = S.building;
  S.anchor = b.anchor(QS.get('a')) || null;
  // Destination: from the QR (?to=), a pinned spot (?to=@floor,x,y), or carried over from before a floor change.
  const to = QS.get('to') || pendingAfterFloorChange(b);
  let p = null;
  if (to?.startsWith('@')) {
    const [f, x, y] = to.slice(1).split(',');
    p = b.pinPlace(f, +x, +y, `Spot on ${b.floor(f).name}`);
  } else if (to) p = b.place(to);
  if (p) { place = indoorPlace(p); document.body.classList.add('indoor'); initLanding(); return; }
  showSearch();
}

/**
 * After "take the lift, then scan the Saathi point there", continue to the same destination - but only if this scan is
 * on a different floor and within 15 minutes. Otherwise every later visit would jump straight back to an old trip.
 */
function pendingAfterFloorChange(b) {
  const key = 'saathi_indoor_' + b.id;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(key)); } catch { /* old format */ }
  sessionStorage.removeItem(key);
  if (!pending?.to || Date.now() - pending.at > 15 * 60 * 1000) return null;
  const here = S.anchor && b.nodes.get(S.anchor.node);
  return here && here.floor !== pending.fromFloor ? pending.to : null;
}

function indoorPlace(p) {
  const node = S.building.nodes.get(p.node);
  const floor = S.building.floor(node?.floor);
  return {
    id: p.id, name: p.name, offer: p.offer || '', indoor: true,
    tagline: [p.tagline || p.category, floor?.name].filter(Boolean).join(' · '),
    x: node?.x, y: node?.y, floor: node?.floor,
  };
}

function renderIndoorResults() {
  const b = S.building, ul = $('indoor-results');
  ul.innerHTML = '';
  if (!b) return;
  const q = $('search-input').value.trim().toLowerCase();
  const here = S.anchor && b.nodes.get(S.anchor.node);
  const list = b.places
    .filter(p => p.id !== '_pin')
    .filter(p => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q))
    .map(p => {
      const n = b.nodes.get(p.node);
      const route = here && b.shortestPath(S.anchor.node, p.node);
      let dist;
      if (route) dist = route.reduce((s, n2, i) => i && n2.floor === route[i - 1].floor ? s + Math.hypot(n2.x - route[i - 1].x, n2.y - route[i - 1].y) : s, 0);
      return { p, dist, floor: b.floor(n?.floor)?.name };
    })
    .sort((a, c) => (a.dist ?? 1e9) - (c.dist ?? 1e9))
    .slice(0, q ? 20 : 6);
  for (const { p, dist, floor } of list)
    ul.appendChild(resultItem({ title: p.name, subtitle: [p.category, floor].filter(Boolean).join(' · '), distance: dist }, SHOP_SVG, () => chooseIndoor(p)));
  $('indoor-wrap').hidden = !list.length && !!q;
}

/** Tap on the big map while navigating → offer to go there instead. */
function offerSpot(pos, floor) {
  S.spot = { pos, floor };
  $('spot-card').hidden = false;
  clearTimeout(S.spotTimer);
  S.spotTimer = setTimeout(() => $('spot-card').hidden = true, 6000);
}

/** Forget the scanned building (back to outdoor-only search). */
function leaveBuilding() {
  if (S.building) sessionStorage.removeItem('saathi_indoor_' + S.building.id);
  S.leftBuilding = true;
  S.building = null; S.anchor = null; S.planMap = null;
  document.body.classList.remove('indoor');
  $('plan-map').innerHTML = '';
  const u = new URL('./', location.href);
  if (SIM) u.searchParams.set('sim', '1');
  history.replaceState(null, '', u);
  showSearch();
}

/** In-app scanner for Saathi point QRs (to re-locate indoors or after changing floors). */
async function scanSaathiPoint() {
  stopNav();
  const sheet = $('scan-sheet'), video = $('scan-video');
  sheet.hidden = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch {
    $('scan-hint').textContent = 'Camera unavailable. Scan the QR with your phone camera app instead.';
    return;
  }
  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!detector && !window.jsQR) {
    await new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
  }
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
  S.scanning = true;
  const close = () => { S.scanning = false; stream?.getTracks().forEach(t => t.stop()); sheet.hidden = true; };
  $('scan-close').onclick = close;
  while (S.scanning) {
    await new Promise(r => setTimeout(r, 200));
    if (!video.videoWidth) continue;
    let text = null;
    try {
      if (detector) text = (await detector.detect(video))[0]?.rawValue;
      else if (window.jsQR) {
        canvas.width = 480; canvas.height = Math.round(480 * video.videoHeight / video.videoWidth);
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        text = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
      }
    } catch { /* keep trying */ }
    if (!text) continue;
    try {
      const u = new URL(text);
      if (!u.searchParams.get('b')) { $('scan-hint').textContent = "That's not a Saathi point. Look for the green Saathi QR."; continue; }
      close();
      if (place?.id && !u.searchParams.get('to')) u.searchParams.set('to', place.id);
      location.href = u.toString(); // reload at the new point; the destination carries over
      return;
    } catch { $('scan-hint').textContent = "That QR isn't a Saathi point."; }
  }
}

// ───────────── Share ─────────────

function openShare() {
  $('share-name').textContent = place.name;
  drawQr($('share-qr'), shareUrl());
  $('share-sheet').hidden = false;
}

function initials(name) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '★';
}

function drawQr(canvas, text) {
  if (!window.qrcode) return;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), g = canvas.getContext('2d'), cell = canvas.width / (n + 4);
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + 2) * cell, (r + 2) * cell, cell + 0.5, cell + 0.5);
}

// ───────────── Start ─────────────
//
// Four ways to run, picked automatically:
//   outdoor + WebXR   (Android Chrome): ARCore tracking, real ground detection, GPS/compass only for registration
//   outdoor overlay   (iPhone / no WebXR): camera video + compass + GPS, ground assumed at eye height
//   indoor  + WebXR   : starts at the scanned Saathi point, tracking does the rest
//   indoor  overlay   : starts at the Saathi point, counts steps along the route

async function start() {
  // Anything that needs the tap's "user activation" must happen before slow awaits:
  // iOS motion permission and the WebXR session request.
  const perms = await requestPermissions();
  S.mode = place?.indoor ? 'indoor' : 'outdoor';
  S.useXR = !SIM && CONFIG.useWebXR !== false && await xrSupported();

  if (!S.ar) S.ar = new ARScene($('ar'));
  S.tripPoints = 0;
  S.arrived = false;
  S.yawFix = 0;
  S.autoYaw = 0;
  // Start the compass BEFORE WebXR: Chrome often stops orientation events during an AR session, so the
  // last reading from just before is what registers the trail to the street.
  if (S.mode === 'outdoor') {
    S.sensors = SIM ? new SimSensors(fromLocal(place, { x: -140, y: -190 })) : new Sensors();
    S.sensors.startOrientation();
  }

  if (S.useXR) {
    show('nav');
    $('nav').classList.add('xr');
    status('Starting AR…');
    try {
      S.xr = await new XRSession(S.ar.renderer, S.ar.scene, $('nav')).start();
    } catch (e) {
      console.warn('[Saathi] WebXR failed, using camera overlay', e);
      S.useXR = false;
      $('nav').classList.remove('xr');
    }
  }
  if (S.useXR) {
    S.xr.onSelect = rc => { if (S.ar.tapRay(rc)) collect(1); };
    S.xr.onEnd = () => { if (S.running && !S.arrived) { stopNav(); show('landing'); } };
    S.aligner = new Aligner();
  } else if (!SIM) {
    loading('Allow camera access', `${CONFIG.brand} shows the way through your camera.`);
    try { S.stream = await startCamera($('camera')); }
    catch (e) { console.warn(e); S.noCamera = true; }
  }
  $('nav').classList.toggle('sim', SIM);

  try {
    if (S.mode === 'indoor') await startIndoor();
    else await startOutdoor();
  } catch (e) {
    console.error(e);
    S.xr?.end();
    fail(e.userMessage || "Couldn't start navigation. Check your internet connection and try again.");
    return;
  }

  setVoiceButton();
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  say(`Follow the green trail to ${place.name}. ${formatDistance(S.path.length).replace(' m', ' metres')}.`);
  if (S.noCamera) toast('Camera unavailable - showing directions only', 4000);
  else if (!SIM && !perms.motion) toast('Motion sensors blocked - arrows may be less accurate', 4000);
  else if (SIM) toast('Simulator: drag to look around · W/S speed · M map', 5000);

  updatePoints(0);
  S.running = true;
  S.last = performance.now();
  if (S.useXR) S.ar.renderer.setAnimationLoop((t, frame) => xrLoop(t, frame));
  else requestAnimationFrame(loop);
}

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

async function startOutdoor() {
  if (S.useXR) status('Finding your location…', 'Keep the camera pointed at the street.');
  else loading('Finding your location…', 'Step outside if you are indoors.');
  try {
    await withTimeout(S.sensors.startGPS(), 30000);
  } catch (e) {
    throw userError(e?.code === 1
      ? 'Location permission was denied. Allow location for this site in your browser settings and try again.'
      : "Couldn't get your location. Make sure GPS is on, step outside, and try again.");
  }
  S.sensors.startOrientation();

  if (S.useXR) status('Finding the walking route…');
  else loading('Finding the walking route…');
  await buildRoute(S.sensors.position);

  if (S.useXR) {
    // Every GPS fix nudges the registration; between fixes ARCore tracking keeps the trail still.
    S.sensors.onPosition = (pos, acc) => {
      if (S.aligner?.ready) S.aligner.gps(S.ar.camera, toLocal(S.path.origin, pos), acc);
    };
  }
  await openNav(S.sensors.position);
}

async function startIndoor() {
  const b = S.building;
  const anchor = S.anchor;
  if (!anchor) throw userError('Scan a Saathi point QR inside the building to start indoor navigation.');
  S.legs = b.route(anchor.id, place.id);
  if (!S.legs?.length) throw userError(`No walking route from ${anchor.name} to ${place.name}.`);
  S.legIndex = 0;
  useLeg(0);

  if (!S.useXR) {
    // Overlay mode: compass for direction (corrected to the plan by the Saathi point), steps for distance.
    S.sensors = SIM ? new SimSensors({ lat: 0, lng: 0 }) : new Sensors();
    S.sensors.startOrientation();
    S.headingOffset = SIM ? 0 : null; // the simulator already reports plan headings
    S.stepAlong = 0;
    S.ped = new Pedometer(() => { S.stepAlong = Math.min(S.path.length, S.stepAlong + CONFIG.stepLength); });
    S.ped.start();
  }
  const start = S.path.pts[0];
  await openNav({ lat: start.y, lng: start.x });
}

function useLeg(i) {
  const leg = S.legs[i];
  S.leg = leg;
  S.path = Path.fromLocal(leg.points);
  S.maneuvers = leg.steps.map(s => ({ ...s }));
  S.routePoints = leg.points.map(p => ({ lat: p.y, lng: p.x }));
  S.along = 0; S.seg = 0; S.announced = -1;
  const isLast = i === S.legs.length - 1;
  const end = leg.points[leg.points.length - 1];
  S.ar.pinScale = 0.45; // indoor ceilings: a short pin
  S.ar.setRoute(S.path, S.maneuvers, end, isLast ? place.name : (leg.endsWith === 'stairs' ? 'Stairs' : 'Lift'));
}

async function openNav(startLL) {
  show('nav');
  $('dest-name').textContent = place.name;
  const destLL = S.mode === 'indoor'
    ? (() => { const p = S.leg.points[S.leg.points.length - 1]; return { lat: p.y, lng: p.x, name: place.name }; })()
    : place;
  // Separate map instances for streets and floor plans (a Leaflet map can't switch coordinate systems).
  const indoor = S.mode === 'indoor';
  $('nav-map').hidden = indoor;
  $('nav-plan').hidden = !indoor;
  if (indoor) {
    const first = !S.navPlan;
    S.navPlan ||= new NavMap($('nav-plan'));
    await S.navPlan.initIndoor(S.building, S.building.floor(S.leg.floor), startLL, destLL);
    if (first) {
      S.navPlan.onFollowChange = f => $('map-recenter').hidden = f;
      S.navPlan.onTap(pos => { if (S.mapExpanded) offerSpot(pos, S.leg.floor); });
    }
    S.map = S.navPlan;
  } else {
    if (!S.navStreet) {
      S.navStreet = await new NavMap($('nav-map')).init(startLL, destLL);
      S.navStreet.onFollowChange = f => $('map-recenter').hidden = f;
      S.navStreet.onTap(pos => { if (S.mapExpanded) offerSpot(pos, null); });
    }
    S.map = S.navStreet;
  }
  S.map.invalidate();
  S.map.setDest(destLL);
  S.map.setRoute(S.routePoints);
  S.map.follow = true;
  if (S.useXR) status('Point your camera at the ground', 'Move the phone slowly until the green ring appears on the floor.', true);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function buildRoute(origin) {
  const r = await computeRoute(origin, place);
  const pts = [origin, ...r.points];
  if (haversine(pts[pts.length - 1], place) > 3) pts.push({ lat: place.lat, lng: place.lng });
  S.routePoints = pts;
  S.path = new Path(origin, pts);
  let hint = 0;
  S.maneuvers = r.steps.map(s => {
    const pr = S.path.project(toLocal(origin, s.start), hint);
    hint = pr.seg;
    return { ...s, along: pr.along };
  });
  S.duration = r.duration;
  S.along = 0;
  S.seg = 0;
  S.announced = -1;
  S.ar.pinScale = 1;
  S.ar.setRoute(S.path, S.maneuvers, toLocal(origin, place), place.name);
  if (S.map) S.map.setRoute(pts);
  if (S.aligner?.ready) S.aligner.ready = false; // re-register against the new route origin
  if (r.source === 'straight') toast("Couldn't load street directions - showing the direct way", 4000);
}

/** In-AR status card (WebXR mode has no separate loading screen: the camera is already running). */
function status(title, detail = '', ground = false) {
  const el = $('xr-status');
  if (!title) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('ground', ground);
  el.querySelector('b').textContent = title;
  el.querySelector('small').textContent = detail;
}

// ───────────── Frame loops ─────────────

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();

/** WebXR frame: tracking pose from ARCore, ground from hit tests, registration from GPS/compass or the Saathi point. */
function xrLoop(now, frame) {
  if (!S.running) return;
  const dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  const cam = S.ar.camera;
  const xr = S.xr;
  xr.updateGround(frame, cam.position.y);
  const ground = xr.ground ?? (S.ar.renderer.xr.getReferenceSpace() && cam.position.y > 0.8 ? 0 : cam.position.y - CONFIG.eyeHeight);

  // Register the route once we know where we are and which way we face.
  const al = S.aligner;
  if (!al.ready && frame) {
    if (S.mode === 'indoor') al.init(cam, S.path.pts[0], S.anchor.heading);
    else if (S.sensors.position && S.sensors.hasOrientation) al.init(cam, toLocal(S.path.origin, S.sensors.position), S.sensors.heading);
    else if (S.sensors.position && (S.xrWaitStart ??= now) && now - S.xrWaitStart > 3000) {
      // No compass: start facing along the route and let the walking direction correct it.
      al.init(cam, toLocal(S.path.origin, S.sensors.position), bearingAlong(S.path, 0));
      toast('No compass - walk a few steps along the trail to align it', 4000);
    }
  }
  if (S.mode === 'outdoor' && al.ready && S.sensors.hasOrientation) al.compass(cam, S.sensors.heading, 0.004);

  if (!xr.groundLocked) {
    status('Point your camera at the ground', 'Move the phone slowly until the green ring appears on the floor.', true);
  } else if (!$('xr-status').hidden && $('xr-status').classList.contains('ground')) {
    status('');
    toast('Ground found ✓', 1500);
  }

  if (al.ready) {
    al.apply(S.ar.world, ground);
    S.ar.world.visible = xr.groundLocked || now - (S.xrGroundWait ??= now) > 6000;
    const user = al.userLocal(cam);
    const pr = S.path.project(user, S.seg);
    S.seg = pr.seg;
    S.along = pr.along;
    if (pr.lateral < 15) {
      // You're walking the route, so the road direction you just covered tells us the true heading,
      // and your position belongs on the route line (GPS drifts sideways by several metres).
      al.walkAlong(cam, bearingAlong(S.path, Math.max(0, pr.along - 3)));
      al.pinTo(cam, S.path.at(pr.along).p, 0.015);
    }
    const got = S.ar.update(dt, user, pr.along, null);
    if (got) collect(got);
    const heading = (Aligner.yawOf(cam) + al.theta + 360) % 360;
    const pitch = Math.asin(Math.max(-1, Math.min(1, tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion).y))) * 180 / Math.PI;
    afterFrame(pr, user, heading, pitch, now);
  } else S.ar.world.visible = false;

  S.ar.render();
}

/** Overlay frame (no WebXR): camera video + compass + GPS (outdoor) or steps (indoor). */
function loop(now) {
  if (!S.running) return;
  const dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  const sn = S.sensors;
  const path = S.path;
  let user, pr;

  if (S.mode === 'indoor') {
    // Plan heading = compass + offset learnt at the Saathi point (you face the QR's direction when you start).
    if (S.headingOffset == null && sn.hasOrientation) S.headingOffset = angleDiff(sn.heading, S.anchor.heading);
    if (SIM) { // walk along the route and face along it
      S.stepAlong = Math.min(path.length, S.stepAlong + sn.speed * dt);
      sn._walkHeading = bearingAlong(path, S.stepAlong);
      sn.step(dt, null);
    }
    user = path.at(S.stepAlong).p;
    pr = { along: S.stepAlong, lateral: 0, seg: 0 };
  } else {
    if (SIM) {
      const ahead = path.at(S.along + 6).p;
      sn.step(dt, path.length - S.along > 1 ? fromLocal(path.origin, ahead) : null);
    }
    const local = toLocal(path.origin, sn.position);
    pr = path.project(local, S.seg);
    // Keep the trail under the user's feet when GPS wanders a little off the road.
    const snap = path.at(pr.along).p;
    const k = pr.lateral < 20 ? 0.9 : 0;
    user = { x: local.x + (snap.x - local.x) * k, y: local.y + (snap.y - local.y) * k };
  }
  S.seg = pr.seg;
  S.along = pr.along;

  // Orientation: sensors if available, else GPS course / route direction.
  let q = sn.quaternion, heading = sn.heading, pitch = sn.pitch;
  if (S.mode === 'outdoor' && sn.hasOrientation && !SIM && sn.gpsHeading != null && pr.lateral < 12 && !S.yawLocked) {
    // Walking along the route: people mostly hold the phone pointing where they walk, so a steady difference between
    // the compass and the road's direction is compass error. Learn it slowly.
    const obs = angleDiff(sn.heading, bearingAlong(path, pr.along));
    if (Math.abs(obs) < 50) S.autoYaw += angleDiff(S.autoYaw, obs) * 0.01;
  }
  const corr = (S.mode === 'indoor' ? (S.headingOffset ?? 0) : S.autoYaw) + S.yawFix;
  if (sn.hasOrientation && (corr !== 0 || S.mode === 'indoor') && (S.mode !== 'indoor' || S.headingOffset != null)) {
    heading = (sn.heading + corr + 360) % 360;
    q = tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -corr * THREE.MathUtils.DEG2RAD).multiply(sn.quaternion);
  } else if (!sn.hasOrientation) {
    heading = sn.gpsHeading ?? bearingAlong(path, pr.along);
    pitch = -5;
    tmpE.set(pitch * THREE.MathUtils.DEG2RAD, -heading * THREE.MathUtils.DEG2RAD, 0, 'YXZ');
    q = tmpQ.setFromEuler(tmpE);
  }

  const got = S.ar.update(dt, user, pr.along, q, -S.eyeHeight);
  if (got) collect(got);
  S.ar.render();
  afterFrame(pr, user, heading, pitch, now);
  if (S.running) requestAnimationFrame(loop);
}

/** Shared per-frame logic: HUD, map, arrival, re-routing, floor changes. */
function afterFrame(pr, user, heading, pitch, now) {
  updateHud(pr, user, heading, pitch);
  const mapPos = S.mode === 'indoor' ? { lat: user.y, lng: user.x } : fromLocal(S.path.origin, user);
  S.map?.update(mapPos, heading);
  updateTiltMap(pitch);

  const remaining = Math.max(0, S.path.length - pr.along);
  if (S.mode === 'indoor') {
    if (remaining < CONFIG.indoorArrivalRadius && !S.arrived) {
      if (S.legIndex < S.legs.length - 1) changeFloor();
      else arrive();
    }
    return;
  }
  if (!S.arrived && (remaining < CONFIG.arrivalRadius || haversine(S.sensors.position, place) < CONFIG.arrivalRadius)) {
    arrive();
    return;
  }
  // Re-route after being clearly off the path for a while (only with a decent GPS fix).
  if (pr.lateral > CONFIG.offRouteDistance && S.sensors.accuracy < 25) {
    S.offRouteSince ||= now;
    if (now - S.offRouteSince > 8000 && !S.rerouting) reroute();
  } else S.offRouteSince = 0;
}

function changeFloor() {
  const leg = S.leg, next = S.building.floor(leg.nextFloor);
  const how = leg.endsWith === 'stairs' ? 'stairs' : 'lift';
  S.arrived = true; // pause arrival checks
  // Remember the trip so scanning the Saathi point on the next floor continues it.
  const to = place.id === '_pin' ? `@${place.floor},${place.x},${place.y}` : place.id;
  sessionStorage.setItem('saathi_indoor_' + S.building.id, JSON.stringify({ to, fromFloor: leg.floor, at: Date.now() }));
  say(`Take the ${how} to ${next?.name || 'the next floor'}. Then scan the Saathi point there.`);
  fail(`Take the ${how} to ${next?.name || 'the next floor'}.\n\nThen scan the Saathi point QR you see there and navigation to ${place.name} continues.`, 'Next floor');
  $('retry-btn').textContent = 'Scan the Saathi point';
  $('retry-btn').onclick = () => scanSaathiPoint();
  $('error-gmaps').hidden = true;
  stopNav();
}

function bearingAlong(path, along) {
  const a = path.at(along).p, b = path.at(along + 5).p;
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

function updateHud(pr, user, heading, pitch) {
  const along = pr.along;
  const next = S.maneuvers.findIndex(m => m.along > along + (S.mode === 'indoor' ? 1 : 3) && m.maneuver !== 'DEPART');
  const remaining = Math.max(0, S.path.length - along);
  let title, dist, street = '', icon = 'STRAIGHT';
  if (next >= 0 && S.maneuvers[next].maneuver !== 'ARRIVE') {
    const m = S.maneuvers[next];
    title = shortManeuver(m.maneuver);
    dist = m.along - along;
    street = m.street || '';
    icon = m.maneuver;
    const announceAt = S.mode === 'indoor' ? 8 : 35;
    if (dist < announceAt && S.announced !== next) {
      S.announced = next;
      say(`In ${Math.max(S.mode === 'indoor' ? 2 : 5, Math.round(dist / 5) * 5)} metres, ${m.instruction || title} ${street}`);
    }
  } else {
    title = 'Go straight';
    dist = remaining;
    street = place.name;
  }
  $('turn-title').textContent = title;
  $('turn-dist').innerHTML = `${formatDistance(dist)} <small>${escapeHtml(street)}</small>`;
  if (S.icon !== icon) { S.icon = icon; $('turn-icon').innerHTML = `<path d="${maneuverIconPath(icon)}"/>`; }
  $('remaining').textContent = `${formatDistance(remaining)} · ${formatDuration(remaining / 1.3)}`;

  const a = $('accuracy');
  if (S.useXR) {
    const ok = S.xr?.groundLocked;
    a.className = 'pill ' + (ok ? 'good' : '');
    a.querySelector('b').textContent = ok ? 'AR · ground locked' : 'AR · finding ground';
  } else if (S.mode === 'indoor') {
    a.className = 'pill';
    a.querySelector('b').textContent = `Indoor · ${S.ped?.steps || 0} steps`;
  } else {
    const acc = S.sensors.accuracy;
    a.className = 'pill ' + (acc <= 8 ? 'good' : acc > 25 ? 'bad' : '');
    a.querySelector('b').textContent = SIM ? 'Simulated' : `GPS ±${Math.round(acc)} m`;
  }

  // Big turn arrow when the trail is out of view (wrong way / side street).
  const hint = $('turn-hint');
  const oriented = S.useXR ? S.aligner?.ready : S.sensors?.hasOrientation;
  if (oriented && pitch > -45) {
    const t = S.path.at(along + (S.mode === 'indoor' ? 4 : 10)).p;
    const b = (Math.atan2(t.x - user.x, t.y - user.y) * 180 / Math.PI + 360) % 360;
    const delta = angleDiff(heading, b);
    if (Math.abs(delta) > 55) {
      hint.hidden = false;
      hint.querySelector('svg').style.transform = `rotate(${delta}deg)`;
      hint.querySelector('span').textContent = Math.abs(delta) > 140 ? 'Turn around' : delta > 0 ? 'Turn right' : 'Turn left';
    } else hint.hidden = true;
  } else hint.hidden = true;
}

function updateTiltMap(pitch) {
  // Like Google Live View: phone down → map, phone up → AR.
  // In WebXR you look down to find the ground, so wait for the ground lock and need a steeper tilt.
  if (S.useXR && !S.xr?.groundLocked) return;
  const open = S.useXR ? -68 : -50, close = S.useXR ? -40 : -30;
  if (S.mapManual) {
    if ((S.mapExpanded && pitch < open) || (!S.mapExpanded && pitch > close)) S.mapManual = false;
    return;
  }
  if (!S.mapExpanded && pitch < open) setMapExpanded(true);
  else if (S.mapExpanded && pitch > close) setMapExpanded(false);
}

function setMapExpanded(on) {
  S.mapExpanded = on;
  const f = $('map-frame');
  f.classList.toggle('expanded', on);
  f.classList.toggle('compact', !on);
  $('turn-hint').hidden = true;
  setTimeout(() => S.map?.invalidate(), 380);
}

async function reroute() {
  S.rerouting = true;
  toast('Re-routing…');
  try { await buildRoute(S.sensors.position); }
  catch { toast("Couldn't re-route - keep following the trail"); }
  S.offRouteSince = 0;
  S.rerouting = false;
}

function collect(n) {
  S.tripPoints += n * CONFIG.coinValue;
  updatePoints(n * CONFIG.coinValue);
  buzz(40);
  ping();
}

function updatePoints(added) {
  const p = $('points');
  p.querySelector('b').textContent = S.tripPoints;
  if (added) { p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); toast(`+${added} points`, 900); }
}

let audioCtx;
function ping() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.setValueAtTime(988, audioCtx.currentTime);
    o.frequency.setValueAtTime(1319, audioCtx.currentTime + 0.07);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch { /* no audio */ }
}

// ───────────── Arrival ─────────────

function arrive() {
  S.arrived = true;
  S.running = false;
  const total = (+localStorage.getItem('saathi_points') || 0) + S.tripPoints;
  localStorage.setItem('saathi_points', total);
  $('arrived-name').textContent = place.name + '!';
  $('arrived-points-lead').textContent = S.tripPoints ? "Congrats! You've collected" : 'Your Saathi wallet';
  $('arrived-points').textContent = `${S.tripPoints || total} points!`;
  $('arrived-offer').hidden = !place.offer;
  $('offer-text').textContent = place.offer;
  $('offer-shop').textContent = `At ${place.name}!`;
  $('redeem-code').textContent = '#' + Math.random().toString(36).slice(2, 6).toUpperCase() + ' · ' +
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  show('arrived');
  buzz([60, 60, 120]);
  say(`You've reached ${place.name}!` + (place.offer ? ` You get ${place.offer} here.` : ''));
}

function stopNav() {
  S.running = false;
  S.ar?.renderer.setAnimationLoop(null);
  if (S.xr?.session) { S.xr.onEnd = null; S.xr.end(); }
  S.xr = null;
  $('nav').classList.remove('xr');
  S.ped?.stop();
  S.ped = null;
  S.sensors?.stop();
  S.stream?.getTracks().forEach(t => t.stop());
  S.stream = null;
  S.wakeLock?.release?.();
  speechSynthesis?.cancel?.();
}

// ───────────── Wiring ─────────────

function setVoiceButton() { $('voice-btn').classList.toggle('off', !S.voice); }

$('start-btn').onclick = () => start();
$('change-btn').onclick = () => { stopNav(); $('search-input').value = ''; onSearchInput(); showSearch(); };
$('search-input').addEventListener('input', onSearchInput);
$('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('search-results').querySelector('li')?.click(); });
$('search-clear').onclick = () => { $('search-input').value = ''; onSearchInput(); $('search-input').focus(); };
$('pin-go').onclick = () => { if (S.pin?.indoor) chooseIndoor(S.pin.indoor); else if (S.pin) choosePlace(S.pin); };
for (const t of document.querySelectorAll('#map-tabs [data-map]')) t.onclick = () => setMapTab(t.dataset.map);
$('plan-floor').onchange = () => { $('pin-card').hidden = true; showPlanMap(); };
$('leave-building').onclick = () => leaveBuilding();

// Manual alignment: drag sideways to rotate the trail onto the road (works in WebXR and the overlay).
$('align-btn').onclick = () => { $('align-layer').hidden = false; S.aligning = true; };
$('align-done').onclick = () => { $('align-layer').hidden = true; S.aligning = false; toast('Trail aligned ✓', 1200); };
{
  let lastX = null;
  const layer = $('align-layer');
  layer.addEventListener('pointerdown', e => { if (e.target.closest('.align-card')) return; lastX = e.clientX; layer.setPointerCapture(e.pointerId); });
  layer.addEventListener('pointermove', e => {
    if (lastX == null) return;
    const deg = (e.clientX - lastX) * 0.15; // drag right → trail swings right
    lastX = e.clientX;
    if (S.useXR) S.aligner?.rotate(-deg);
    else { S.yawFix -= deg; S.yawLocked = true; }
  });
  layer.addEventListener('pointerup', () => lastX = null);
  layer.addEventListener('pointercancel', () => lastX = null);
}
$('spot-go').onclick = () => { $('spot-card').hidden = true; if (S.spot) pickOnMap(S.spot.pos, S.spot.floor); };
$('spot-cancel').onclick = () => $('spot-card').hidden = true;
$('share-btn').onclick = () => openShare();
$('share-close').onclick = () => $('share-sheet').hidden = true;
$('share-sheet').onclick = e => { if (e.target.id === 'share-sheet') $('share-sheet').hidden = true; };
$('share-link').onclick = async () => {
  const url = shareUrl();
  try {
    if (navigator.share) await navigator.share({ title: place.name, text: `Walk to ${place.name} with AR directions`, url });
    else { await navigator.clipboard.writeText(url); $('share-link').textContent = 'Link copied!'; setTimeout(() => $('share-link').textContent = 'Share link', 1600); }
  } catch { /* user cancelled */ }
};
$('share-dl').onclick = () => {
  const a = document.createElement('a');
  a.download = `saathi-${place.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-qr.png`;
  a.href = $('share-qr').toDataURL('image/png');
  a.click();
};
addEventListener('popstate', () => { stopNav(); location.reload(); });
$('rescan-btn').onclick = () => scanSaathiPoint();
$('rescan-landing').onclick = () => scanSaathiPoint();
$('height-up').onclick = () => setEyeHeight(S.eyeHeight + 0.1);
$('height-down').onclick = () => setEyeHeight(S.eyeHeight - 0.1);

$('done-btn').onclick = () => { stopNav(); if (place?.indoor) sessionStorage.removeItem('saathi_indoor_' + S.building?.id); show('landing'); };
$('exit-btn').onclick = () => { stopNav(); show('landing'); };
$('voice-btn').onclick = () => {
  S.voice = !S.voice;
  localStorage.setItem('saathi_voice', S.voice ? 'on' : 'off');
  setVoiceButton();
  if (!S.voice) speechSynthesis?.cancel?.(); else say('Voice guidance on');
};
$('map-toggle').onclick = () => { S.mapManual = true; setMapExpanded(!S.mapExpanded); };
$('map-recenter').onclick = () => S.map?.recenter();
$('ar').addEventListener('click', e => { if (S.ar?.tap(e.clientX, e.clientY)) collect(1); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.running) {
    try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }
});

/** Overlay mode can't see the ground, so let people nudge the trail onto it (remembered per phone). */
function setEyeHeight(h) {
  S.eyeHeight = Math.max(0.6, Math.min(2.2, Math.round(h * 10) / 10));
  try { localStorage.setItem('saathi_eye', S.eyeHeight); } catch { /* blocked */ }
  toast(`Trail height: phone ${S.eyeHeight.toFixed(1)} m above the ground`, 1200);
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

if (SIM) window.__saathi = { S, dropPin, dropIndoorPin, choosePlace, chooseIndoor, pickOnMap, setMapTab }; // simulator debugging hooks
initLanding();

// Vibration only after a real tap (browsers block it otherwise).
function buzz(pattern) {
  if (navigator.userActivation?.hasBeenActive !== false) try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
