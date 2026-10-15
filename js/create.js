// QR maker for shop owners: pick the shop (Google Places search, Maps link or coordinates) → QR + printable poster.

import { CONFIG } from './config.js';
import { parseGoogleMaps, isShortMapsLink, buildNavUrl, isValid } from './place.js';
import { loadGoogleMaps, NavMap } from './map.js';

const $ = id => document.getElementById(id);
const place = { name: '', lat: NaN, lng: NaN, placeId: '', offer: '', tagline: '' };
let pickMap = null;

// Default site address = the folder this page is served from.
$('base').value = new URL('./', location.href).href.replace(/create\.html.*$/, '');

function status(msg, kind = '') {
  $('status').textContent = msg;
  $('status').className = 'status ' + kind;
}

async function setLocation(lat, lng, name, placeId) {
  Object.assign(place, { lat, lng });
  if (placeId !== undefined) place.placeId = placeId || '';
  if (name && !$('name').value) $('name').value = name;
  status(`Location set: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, 'ok');
  if (!pickMap) pickMap = await new NavMap($('pick-map')).init(place, place);
  pickMap.hideUser?.();
  pickMap.follow = false;
  if (pickMap.kind === 'google') { pickMap.destMarker.position = place; pickMap.map.setCenter(place); pickMap.map.setZoom(18); }
  else if (pickMap.kind === 'leaflet') { pickMap.destMarker.setLatLng([lat, lng]); pickMap.map.setView([lat, lng], 18); }
  render();
}

// Google Places search box
(async () => {
  if (!(await loadGoogleMaps())) { $('search-wrap').hidden = true; $('or-line').hidden = true; return; }
  try {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
    const ac = new PlaceAutocompleteElement({ includedRegionCodes: [CONFIG.region.toLowerCase()] });
    $('search-host').appendChild(ac);
    const onPick = async pred => {
      const p = pred.toPlace ? pred.toPlace() : pred;
      await p.fetchFields({ fields: ['displayName', 'location', 'id', 'formattedAddress'] });
      $('name').value = p.displayName || $('name').value;
      setLocation(p.location.lat(), p.location.lng(), p.displayName, p.id);
    };
    ac.addEventListener('gmp-select', e => onPick(e.placePrediction));
    ac.addEventListener('gmp-placeselect', e => onPick(e.place)); // older API versions
  } catch (e) {
    console.warn(e);
    $('search-wrap').hidden = true; $('or-line').hidden = true;
  }
})();

$('maps-input').addEventListener('input', () => {
  const t = $('maps-input').value;
  if (!t.trim()) return status('');
  if (isShortMapsLink(t)) return status('Short links can\'t be read here. Open the link, then copy the full address from the browser bar.', 'err');
  const g = parseGoogleMaps(t);
  if (g && isValid(g)) setLocation(g.lat, g.lng, g.name, g.placeId);
  else status('Couldn\'t find coordinates in that text.', 'err');
});

for (const id of ['name', 'offer', 'tagline', 'base']) $(id).addEventListener('input', render);

function navUrl() {
  place.name = $('name').value.trim();
  place.offer = $('offer').value.trim();
  place.tagline = $('tagline').value.trim();
  let base = $('base').value.trim() || location.href;
  if (!/^https?:\/\//.test(base)) base = 'https://' + base;
  return buildNavUrl(base, place);
}

function render() {
  const ready = isValid(place);
  $('dl-poster').disabled = $('dl-qr').disabled = !ready;
  const url = ready ? navUrl() : '';
  $('url-out').innerHTML = ready ? `<a href="${url}" target="_blank" rel="noopener">${url}</a>` : 'Fill in the shop location to create the link.';
  drawPoster(url);
}

function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

function drawQrAt(g, qr, x, y, size) {
  const n = qr.getModuleCount(), cell = size / n;
  g.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (qr.isDark(r, c)) g.fillRect(x + c * cell, y + r * cell, cell + 0.6, cell + 0.6);
}

function drawPoster(url) {
  const c = $('poster'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = '#f3f1ec'; g.fillRect(0, 0, W, H);
  // Header band
  g.fillStyle = '#262628'; roundRect(g, 60, 60, W - 120, 300, 50); g.fill();
  g.fillStyle = '#2bd96b'; g.beginPath(); g.arc(150, 150, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = '700 46px Inter, sans-serif'; g.textAlign = 'left'; g.fillText(CONFIG.brand, 190, 166);
  g.font = '700 84px Gelasio, Georgia, serif';
  g.fillText(fit(g, $('name').value.trim() || 'Your shop', W - 260), 130, 290);

  // QR
  g.fillStyle = '#fff'; roundRect(g, 200, 430, 800, 800, 50); g.fill();
  if (url) drawQrAt(g, qrMatrix(url), 260, 490, 680);
  else { g.fillStyle = '#ccc'; g.font = '500 40px Inter'; g.textAlign = 'center'; g.fillText('Set the location', W / 2, 840); }

  // Chevrons
  g.fillStyle = '#1fae5b';
  for (let i = 0; i < 3; i++) chevron(g, W / 2, 1335 - i * 38, 120 - i * 26, 0.85 - i * 0.2);

  g.textAlign = 'center'; g.fillStyle = '#262628';
  g.font = '700 64px Gelasio, Georgia, serif';
  g.fillText('Scan to walk here with AR', W / 2, 1460);
  g.font = '500 38px Inter, sans-serif'; g.fillStyle = '#6b6b70';
  g.fillText('Opens in your phone browser · no app needed', W / 2, 1520);
  const offer = $('offer').value.trim();
  if (offer) {
    g.font = '700 44px Inter, sans-serif';
    const tw = g.measureText(offer).width + 90;
    g.fillStyle = '#1fae5b'; roundRect(g, (W - tw) / 2, 1565, tw, 84, 42); g.fill();
    g.fillStyle = '#fff'; g.fillText(offer, W / 2, 1622);
  }
}

function chevron(g, cx, cy, w, alpha) {
  g.save(); g.globalAlpha = alpha; g.beginPath();
  g.moveTo(cx - w, cy + w * 0.4); g.lineTo(cx, cy - w * 0.15); g.lineTo(cx + w, cy + w * 0.4);
  g.lineTo(cx + w * 0.78, cy + w * 0.4); g.lineTo(cx, cy + w * 0.05); g.lineTo(cx - w * 0.78, cy + w * 0.4);
  g.closePath(); g.fill(); g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  while (text.length > 1 && g.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}

function download(canvas, name) {
  const a = document.createElement('a');
  a.download = name;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

$('dl-poster').onclick = () => download($('poster'), `saathi-${slug()}-poster.png`);
$('dl-qr').onclick = () => {
  const qr = qrMatrix(navUrl()), n = qr.getModuleCount(), size = 1024, pad = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size + pad * 2;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  drawQrAt(g, qr, pad, pad, size);
  download(c, `saathi-${slug()}-qr.png`);
};
const slug = () => ($('name').value.trim() || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

document.fonts?.ready.then(render);
render();
