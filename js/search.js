// Destination search for "navigate anywhere": Google Places autocomplete when a key is set, otherwise Photon
// (free OpenStreetMap geocoder). Plus reverse geocoding for dropped pins and a small recents list.

import { CONFIG } from './config.js';
import { loadGoogleMaps } from './map.js';
import { haversine } from './geo.js';

const PHOTON = 'https://photon.komoot.io';
let googleToken = null;

/**
 * Suggestions for the text typed so far.
 * Returns [{ title, subtitle, placeId?, lat?, lng?, distance? }]. Google results resolve coordinates lazily (resolve()).
 */
export async function suggest(text, near) {
  text = text.trim();
  if (text.length < 2) return [];
  if (await loadGoogleMaps()) {
    try { return await googleSuggest(text, near); }
    catch (e) { console.warn('[Saathi] Google autocomplete failed, using OSM', e); }
  }
  return photonSuggest(text, near);
}

async function googleSuggest(text, near) {
  const { AutocompleteSessionToken, AutocompleteSuggestion } = await google.maps.importLibrary('places');
  googleToken ||= new AutocompleteSessionToken();
  const req = { input: text, sessionToken: googleToken, language: CONFIG.language };
  if (near) { req.origin = near; req.locationBias = { center: near, radius: 30000 }; }
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
  return suggestions.filter(s => s.placePrediction).map(s => {
    const p = s.placePrediction;
    return {
      title: p.mainText?.toString() || p.text.toString(),
      subtitle: p.secondaryText?.toString() || '',
      placeId: p.placeId,
      distance: p.distanceMeters,
      _prediction: p,
    };
  });
}

async function photonSuggest(text, near) {
  const u = new URL(PHOTON + '/api/');
  u.searchParams.set('q', text);
  u.searchParams.set('limit', '7');
  if (near) { u.searchParams.set('lat', near.lat); u.searchParams.set('lon', near.lng); }
  const res = await fetch(u);
  if (!res.ok) throw new Error('Search failed');
  const j = await res.json();
  const seen = new Set();
  return j.features.map(f => {
    const p = f.properties;
    const lat = f.geometry.coordinates[1], lng = f.geometry.coordinates[0];
    const title = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Place';
    const subtitle = [p.street && p.name ? p.street : null, p.district || p.locality, p.city, p.state, p.country]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== title).join(', ');
    return { title, subtitle, lat, lng, distance: near ? haversine(near, { lat, lng }) : undefined };
  }).filter(r => { // OSM often has the same place as a node and a building outline
    const k = r.title + '|' + r.subtitle;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Turns a suggestion into a full destination {name, lat, lng, placeId, tagline}. */
export async function resolve(s) {
  if (Number.isFinite(s.lat)) return { name: s.title, lat: s.lat, lng: s.lng, placeId: s.placeId || '', tagline: s.subtitle };
  const place = s._prediction.toPlace();
  await place.fetchFields({ fields: ['displayName', 'location', 'id', 'formattedAddress'] });
  googleToken = null; // a session ends when a place is picked
  return {
    name: place.displayName || s.title,
    lat: place.location.lat(),
    lng: place.location.lng(),
    placeId: place.id,
    tagline: s.subtitle || shortAddress(place.formattedAddress),
  };
}

/** Name for a dropped pin. */
export async function reverseGeocode(pos) {
  if (await loadGoogleMaps()) {
    try {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ location: pos, language: CONFIG.language });
      if (results?.[0]) {
        const r = results[0];
        const route = r.address_components.find(c => c.types.includes('route'))?.long_name;
        return { name: route || shortAddress(r.formatted_address), tagline: shortAddress(r.formatted_address) };
      }
    } catch { /* Geocoding API not enabled - fall through */ }
  }
  try {
    const res = await fetch(`${PHOTON}/reverse?lat=${pos.lat}&lon=${pos.lng}`);
    const p = (await res.json()).features?.[0]?.properties;
    if (p) {
      const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.district || p.city;
      return { name: name || 'Dropped pin', tagline: [p.street, p.district, p.city].filter(Boolean).filter(v => v !== name).join(', ') };
    }
  } catch { /* offline */ }
  return { name: 'Dropped pin', tagline: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` };
}

function shortAddress(a) { return (a || '').split(',').slice(0, 2).join(',').trim(); }

// ───────────── Recents ─────────────

const KEY = 'saathi_recent';
export function recents() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
export function addRecent(p) {
  const list = recents().filter(r => !(Math.abs(r.lat - p.lat) < 1e-5 && Math.abs(r.lng - p.lng) < 1e-5));
  list.unshift({ name: p.name, lat: p.lat, lng: p.lng, placeId: p.placeId || '', tagline: p.tagline || '' });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8))); } catch { /* storage full/blocked */ }
}

/** Current position without prompting: only if location permission was already granted. */
export async function quietPosition() {
  try {
    const st = await navigator.permissions?.query({ name: 'geolocation' });
    if (st?.state !== 'granted') return null;
    return await new Promise(res => navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { maximumAge: 60000, timeout: 8000 }));
  } catch { return null; }
}
