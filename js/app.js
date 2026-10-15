// Saathi web: QR (or a searched destination) → AR walking navigation using camera + GPS + compass.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { placeFromUrl, googleMapsNavUrl, isValid, parseGoogleMaps, isShortMapsLink, buildNavUrl } from './place.js';
import { suggest, resolve, reverseGeocode, recents, addRecent, quietPosition } from './search.js';
import { Path, toLocal, fromLocal, haversine, bearing, angleDiff, formatDistance, formatDuration } from './geo.js';
import { computeRoute, shortManeuver, maneuverIconPath } from './routing.js';
import { Sensors, SimSensors, startCamera, requestPermissions, isMobile } from './sensors.js';
import { ARScene } from './ar.js';
import { NavMap, loadPlaceDetails } from './map.js';

const $ = id => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');
let place = placeFromUrl();

const S = {
  sensors: null, ar: null, map: null, stream: null, wakeLock: null,
  path: null, maneuvers: [], along: 0, seg: 0, duration: 0,
  announced: -1, offRouteSince: 0, rerouting: false, running: false,
  tripPoints: 0, voice: localStorage.getItem('saathi_voice') !== 'off',
  mapExpanded: false, mapManual: false, last: 0, arrived: false,
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

function fail(message) {
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
  if (!place) { showSearch(); return; }
  resetLandingCard();
  document.title = `${place.name} – ${CONFIG.brand}`;
  $('place-name').textContent = place.name;
  $('place-initials').textContent = initials(place.name);
  $('place-sub').textContent = place.tagline || '';
  if (place.offer) { $('place-offer').textContent = place.offer; $('place-offer').hidden = false; }
  $('gmaps-btn').href = googleMapsNavUrl(place);
  show('landing');

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

  if (!S.landingMap) {
    S.landingMap = await new NavMap($('landing-map')).init(place, place);
    S.landingMap.hideUser?.();
    S.landingMap.follow = false;
  }
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

/** Makes `p` the destination, updates the address bar (so it can be bookmarked/shared) and shows its card. */
function choosePlace(p) {
  place = { name: p.name || 'Destination', lat: p.lat, lng: p.lng, placeId: p.placeId || '', offer: p.offer || '', tagline: p.tagline || '' };
  addRecent(place);
  const u = new URL(shareUrl());
  if (SIM) u.searchParams.set('sim', '1');
  history.pushState(null, '', u);
  initLanding();
}

// ───────────── Where to? ─────────────

let searchSeq = 0, searchTimer = 0;

async function showSearch() {
  document.title = `Where to? – ${CONFIG.brand}`;
  show('search');
  renderRecents();
  const input = $('search-input');
  setTimeout(() => input.focus(), 50);

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

function onSearchInput() {
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

async function start() {
  // iOS needs the motion permission request to be the first thing in the tap handler.
  const perms = await requestPermissions();
  loading('Allow camera & location', 'Saathi needs them to show the way.');

  S.sensors = SIM ? new SimSensors(fromLocal(place, { x: -140, y: -190 })) : new Sensors();
  $('nav').classList.toggle('sim', SIM);

  if (!SIM) {
    try { S.stream = await startCamera($('camera')); }
    catch (e) { console.warn(e); S.noCamera = true; }
  }

  loading('Finding your location…', 'Step outside if you are indoors.');
  try {
    await withTimeout(S.sensors.startGPS(), 30000);
  } catch (e) {
    fail(e?.code === 1
      ? 'Location permission was denied. Allow location for this site in your browser settings and try again.'
      : "Couldn't get your location. Make sure GPS is on, step outside, and try again.");
    return;
  }
  S.sensors.startOrientation();

  loading('Finding the walking route…');
  if (!S.ar) S.ar = new ARScene($('ar'));
  try { await buildRoute(S.sensors.position); }
  catch (e) { console.error(e); fail("Couldn't plan a route to the shop. Check your internet connection."); return; }

  show('nav');
  $('dest-name').textContent = place.name;
  setVoiceButton();
  if (!S.map) {
    S.map = await new NavMap($('nav-map')).init(S.sensors.position, place);
    S.map.onFollowChange = f => $('map-recenter').hidden = f;
  }
  S.map.setDest(place);
  S.map.setRoute(S.routePoints);
  S.map.follow = true;

  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  say(`Follow the green trail to ${place.name}. ${formatDistance(S.path.length).replace(' m', ' metres')}.`);
  if (S.noCamera) toast('Camera unavailable - showing directions only', 4000);
  else if (!SIM && !perms.motion) toast('Motion sensors blocked - arrows may be less accurate', 4000);
  else if (SIM) toast('Simulator: drag to look around · W/S speed · M map', 5000);

  S.arrived = false;
  S.tripPoints = 0;
  updatePoints(0);
  S.running = true;
  S.last = performance.now();
  requestAnimationFrame(loop);
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
  S.ar.setRoute(S.path, S.maneuvers, toLocal(origin, place), place.name);
  if (S.map) S.map.setRoute(pts);
  if (r.source === 'straight') toast("Couldn't load street directions - showing the direct way", 4000);
}

// ───────────── Frame loop ─────────────

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

function loop(now) {
  if (!S.running) return;
  const dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  const sn = S.sensors;
  const path = S.path;

  if (SIM) {
    const ahead = path.at(S.along + 6).p;
    sn.step(dt, path.length - S.along > 1 ? fromLocal(path.origin, ahead) : null);
  }

  const local = toLocal(path.origin, sn.position);
  const pr = path.project(local, S.seg);
  S.seg = pr.seg;
  S.along = pr.along;

  // Keep the trail under the user's feet when GPS wanders a little off the road.
  const snap = path.at(pr.along).p;
  const k = pr.lateral < 15 ? 0.75 : 0;
  const user = { x: local.x + (snap.x - local.x) * k, y: local.y + (snap.y - local.y) * k };

  // Orientation: sensors if available, else GPS course / route direction.
  let q = sn.quaternion, heading = sn.heading, pitch = sn.pitch;
  if (!sn.hasOrientation) {
    heading = sn.gpsHeading ?? bearingAlong(path, pr.along);
    pitch = -5;
    tmpE.set(pitch * THREE.MathUtils.DEG2RAD, -heading * THREE.MathUtils.DEG2RAD, 0, 'YXZ');
    q = tmpQ.setFromEuler(tmpE);
  }

  const got = S.ar.update(dt, user, pr.along, q);
  if (got) collect(got);
  S.ar.render();

  updateHud(pr, heading, pitch);
  S.map?.update(fromLocal(path.origin, user), heading);
  updateTiltMap(pitch);

  const remaining = Math.max(0, path.length - pr.along);
  if (!S.arrived && (remaining < CONFIG.arrivalRadius || haversine(sn.position, place) < CONFIG.arrivalRadius)) {
    arrive();
    return;
  }

  // Re-route after being clearly off the path for a while (only with a decent GPS fix).
  if (pr.lateral > CONFIG.offRouteDistance && sn.accuracy < 25) {
    S.offRouteSince ||= now;
    if (now - S.offRouteSince > 8000 && !S.rerouting) reroute();
  } else S.offRouteSince = 0;

  requestAnimationFrame(loop);
}

function bearingAlong(path, along) {
  const a = path.at(along).p, b = path.at(along + 5).p;
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

function updateHud(pr, heading, pitch) {
  const along = pr.along;
  const next = S.maneuvers.findIndex(m => m.along > along + 3 && m.maneuver !== 'DEPART');
  const remaining = Math.max(0, S.path.length - along);
  let title, dist, street = '', icon = 'STRAIGHT';
  if (next >= 0 && S.maneuvers[next].maneuver !== 'ARRIVE') {
    const m = S.maneuvers[next];
    title = shortManeuver(m.maneuver);
    dist = m.along - along;
    street = m.street || '';
    icon = m.maneuver;
    if (dist < 35 && S.announced !== next) {
      S.announced = next;
      say(`In ${Math.max(5, Math.round(dist / 5) * 5)} metres, ${m.instruction || title}`);
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

  const acc = S.sensors.accuracy;
  const a = $('accuracy');
  a.className = 'pill ' + (acc <= 8 ? 'good' : acc > 25 ? 'bad' : '');
  a.querySelector('b').textContent = SIM ? 'Simulated' : `GPS ±${Math.round(acc)} m`;

  // Big turn arrow when the trail is out of view (wrong way / side street).
  const hint = $('turn-hint');
  if (S.sensors.hasOrientation && pitch > -45) {
    const target = fromLocal(S.path.origin, S.path.at(along + 10).p);
    const delta = angleDiff(heading, bearing(S.sensors.position, target));
    if (Math.abs(delta) > 55) {
      hint.hidden = false;
      hint.querySelector('svg').style.transform = `rotate(${delta}deg)`;
      hint.querySelector('span').textContent = Math.abs(delta) > 140 ? 'Turn around' : delta > 0 ? 'Turn right' : 'Turn left';
    } else hint.hidden = true;
  } else hint.hidden = true;
}

function updateTiltMap(pitch) {
  // Like Google Live View: phone down → map, phone up → AR.
  if (S.mapManual) {
    if ((S.mapExpanded && pitch < -50) || (!S.mapExpanded && pitch > -30)) S.mapManual = false;
    return;
  }
  if (!S.mapExpanded && pitch < -50) setMapExpanded(true);
  else if (S.mapExpanded && pitch > -30) setMapExpanded(false);
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
$('pin-go').onclick = () => S.pin && choosePlace(S.pin);
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
addEventListener('popstate', () => { stopNav(); place = placeFromUrl(); initLanding(); });
$('retry-btn').onclick = () => location.reload();
$('done-btn').onclick = () => { stopNav(); show('landing'); };
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

function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

if (SIM) window.__saathi = { S, dropPin, choosePlace }; // simulator debugging hooks
initLanding();

// Vibration only after a real tap (browsers block it otherwise).
function buzz(pattern) {
  if (navigator.userActivation?.hasBeenActive !== false) try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
