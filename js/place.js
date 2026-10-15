// Destination encoded in the QR URL, and parsing of Google Maps links / coordinates.
//
// QR URL format (kept short so the QR stays easy to scan):
//   https://your-site/?d=28.632650,77.218350&n=Rahman%20Stores&p=ChIJ...&o=10%25%20Off
//     d = destination "lat,lng" (required unless p is given)
//     n = shop name        p = Google place id (optional)
//     o = offer text       t = tagline (optional)
//   Also accepted: ?q=<full Google Maps URL>

const DATA_COORDS = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/;
const PARAM_COORDS = /[?&](?:q|query|destination|ll|center|daddr)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i;
const AT_COORDS = /@(-?\d+\.\d+),(-?\d+\.\d+)/;
const PLAIN_COORDS = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;
const PLACE_NAME = /\/maps\/place\/([^/@?]+)/i;

export const isValid = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);

/** Reads the destination from the page URL. Returns null if there is none. */
export function placeFromUrl(href = location.href) {
  const u = new URL(href);
  const q = u.searchParams;
  const place = { name: q.get('n') || '', placeId: q.get('p') || '', offer: q.get('o') || '', tagline: q.get('t') || '' };
  const d = q.get('d');
  if (d) {
    const m = d.match(PLAIN_COORDS);
    if (m) Object.assign(place, { lat: +m[1], lng: +m[2] });
  }
  if (!isValid(place) && q.get('q')) {
    const g = parseGoogleMaps(q.get('q'));
    if (g) Object.assign(place, { lat: g.lat, lng: g.lng, name: place.name || g.name, placeId: place.placeId || g.placeId });
  }
  if (!isValid(place) && !place.placeId) return null;
  place.name ||= 'Destination';
  return place;
}

/**
 * Extracts {lat,lng,name,placeId} from a full Google Maps URL or plain "lat, lng" text.
 * Short links (maps.app.goo.gl) can't be expanded in the browser (CORS) - open them and copy the full URL.
 */
export function parseGoogleMaps(text) {
  if (!text) return null;
  text = text.trim();
  const plain = text.match(PLAIN_COORDS);
  if (plain) return { lat: +plain[1], lng: +plain[2], name: '', placeId: '' };

  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* keep raw */ }
  const out = { name: '', placeId: '' };
  const nm = text.match(PLACE_NAME);
  if (nm) { try { out.name = decodeURIComponent(nm[1].replace(/\+/g, ' ')); } catch { out.name = nm[1].replace(/\+/g, ' '); } }

  for (const [rx, src] of [[DATA_COORDS, decoded], [PARAM_COORDS, text], [AT_COORDS, decoded]]) {
    const m = src.match(rx);
    if (m) { out.lat = +m[1]; out.lng = +m[2]; if (isValid(out)) break; }
  }
  try {
    const u = new URL(text);
    out.placeId = u.searchParams.get('query_place_id') || u.searchParams.get('destination_place_id') || '';
    const qp = u.searchParams.get('q') || u.searchParams.get('query') || '';
    if (qp.startsWith('place_id:')) out.placeId = qp.slice(9);
    else if (!out.name && qp && !PLAIN_COORDS.test(qp)) out.name = qp;
  } catch { /* not a URL */ }
  return isValid(out) || out.placeId ? out : null;
}

export const isShortMapsLink = t => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test((t || '').trim());

/** Builds the URL that goes into the QR code. */
export function buildNavUrl(base, place) {
  const u = new URL(base);
  u.search = '';
  if (isValid(place)) u.searchParams.set('d', `${place.lat.toFixed(6)},${place.lng.toFixed(6)}`);
  if (place.name) u.searchParams.set('n', place.name);
  if (place.placeId) u.searchParams.set('p', place.placeId);
  if (place.offer) u.searchParams.set('o', place.offer);
  if (place.tagline) u.searchParams.set('t', place.tagline.length > 40 ? place.tagline.slice(0, 39).trim() + '…' : place.tagline);
  return u.toString();
}

/** Universal Maps URL that starts Google Maps walking navigation to the place. */
export function googleMapsNavUrl(place, mode = 'walking') {
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  if (place.placeId) {
    u.searchParams.set('destination', place.name || `${place.lat},${place.lng}`);
    u.searchParams.set('destination_place_id', place.placeId);
  } else {
    u.searchParams.set('destination', `${place.lat},${place.lng}`);
  }
  u.searchParams.set('travelmode', mode);
  u.searchParams.set('dir_action', 'navigate');
  return u.toString();
}
