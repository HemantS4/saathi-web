// Walking route: Google Routes API first, free OSRM (OpenStreetMap) next, straight line last.
// Result: { points:[{lat,lng}], steps:[{start:{lat,lng}, maneuver, instruction, street, distance}], distance, duration, source }

import { CONFIG } from './config.js';
import { decodePolyline, haversine } from './geo.js';

export async function computeRoute(origin, dest) {
  if (CONFIG.googleMapsApiKey) {
    try { return await googleRoute(origin, dest); }
    catch (e) { console.warn('[Saathi] Google route failed, trying OSM', e); }
  }
  try { return await osrmRoute(origin, dest); }
  catch (e) { console.warn('[Saathi] OSM route failed, using straight line', e); }
  return straight(origin, dest);
}

async function googleRoute(origin, dest) {
  const wp = p => p.placeId ? { placeId: p.placeId } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': CONFIG.googleMapsApiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,' +
        'routes.legs.steps.distanceMeters,routes.legs.steps.startLocation,routes.legs.steps.navigationInstruction',
    },
    body: JSON.stringify({
      origin: wp(origin), destination: wp(dest), travelMode: 'WALK',
      languageCode: CONFIG.language, units: 'METRIC',
    }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}: ${await res.text()}`);
  const r = (await res.json()).routes?.[0];
  if (!r) throw new Error('no route');
  const steps = [];
  for (const leg of r.legs || []) for (const s of leg.steps || []) {
    const ins = s.navigationInstruction?.instructions || '';
    steps.push({
      start: { lat: s.startLocation.latLng.latitude, lng: s.startLocation.latLng.longitude },
      maneuver: s.navigationInstruction?.maneuver || 'STRAIGHT',
      instruction: ins,
      street: streetFrom(ins),
      distance: s.distanceMeters || 0,
    });
  }
  return {
    points: decodePolyline(r.polyline.encodedPolyline),
    steps,
    distance: r.distanceMeters,
    duration: parseFloat(r.duration) || r.distanceMeters / 1.3,
    source: 'google',
  };
}

async function osrmRoute(origin, dest) {
  const url = `${CONFIG.osrmFootUrl}${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=polyline&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('OSRM ' + res.status);
  const j = await res.json();
  const r = j.routes?.[0];
  if (!r) throw new Error('no route');
  const steps = [];
  for (const leg of r.legs) for (const s of leg.steps) {
    const m = s.maneuver;
    const code = osrmManeuver(m.type, m.modifier);
    steps.push({
      start: { lat: m.location[1], lng: m.location[0] },
      maneuver: code,
      instruction: osrmText(code, s.name),
      street: s.name || '',
      distance: s.distance,
    });
  }
  return { points: decodePolyline(r.geometry), steps, distance: r.distance, duration: r.distance / 1.3, source: 'osm' };
}

function straight(origin, dest) {
  const d = haversine(origin, dest);
  return {
    points: [origin, dest],
    steps: [{ start: origin, maneuver: 'DEPART', instruction: 'Head towards the shop', street: '', distance: d }],
    distance: d, duration: d / 1.3, source: 'straight',
  };
}

function osrmManeuver(type, mod = '') {
  if (type === 'depart') return 'DEPART';
  if (type === 'arrive') return 'ARRIVE';
  if (type.startsWith('roundabout') || type === 'rotary') return mod.includes('left') ? 'ROUNDABOUT_LEFT' : 'ROUNDABOUT_RIGHT';
  const map = {
    'left': 'TURN_LEFT', 'right': 'TURN_RIGHT', 'slight left': 'TURN_SLIGHT_LEFT', 'slight right': 'TURN_SLIGHT_RIGHT',
    'sharp left': 'TURN_SHARP_LEFT', 'sharp right': 'TURN_SHARP_RIGHT', 'uturn': 'UTURN_LEFT', 'straight': 'STRAIGHT',
  };
  if (type === 'fork') return mod.includes('left') ? 'FORK_LEFT' : 'FORK_RIGHT';
  return map[mod] || 'STRAIGHT';
}

function osrmText(code, street) {
  const t = shortManeuver(code);
  return street ? `${t} onto ${street}` : t;
}

const STREET_RX = /\b(?:onto|on|toward|towards)\s+(.+?)(?:\s*(?:\(|$|\bfor\b|\bthen\b|,))/i;
function streetFrom(ins) {
  const m = ins.match(STREET_RX);
  return m ? m[1].trim() : '';
}

export function shortManeuver(code) {
  return ({
    TURN_LEFT: 'Turn left', TURN_RIGHT: 'Turn right', TURN_SLIGHT_LEFT: 'Keep left', TURN_SLIGHT_RIGHT: 'Keep right',
    TURN_SHARP_LEFT: 'Sharp left', TURN_SHARP_RIGHT: 'Sharp right', UTURN_LEFT: 'Make a U-turn', UTURN_RIGHT: 'Make a U-turn',
    ROUNDABOUT_LEFT: 'At the roundabout', ROUNDABOUT_RIGHT: 'At the roundabout', FORK_LEFT: 'Take the left fork',
    FORK_RIGHT: 'Take the right fork', MERGE: 'Merge', ARRIVE: 'Arrive',
  })[code] || 'Go straight';
}

/** SVG path (48×48 box) for the instruction card icon. */
export function maneuverIconPath(code) {
  const P = {
    straight: 'M24 44 V10 M13 21 L24 8 L35 21',
    right: 'M16 44 V22 H36 M27 12 L38 22 L27 32',
    left: 'M32 44 V22 H12 M21 12 L10 22 L21 32',
    slightRight: 'M18 44 V28 L33 13 M22 11 H35 V24',
    slightLeft: 'M30 44 V28 L15 13 M26 11 H13 V24',
    sharpRight: 'M16 44 V14 L34 32 M34 20 V33 H21',
    sharpLeft: 'M32 44 V14 L14 32 M14 20 V33 H27',
    uturn: 'M32 44 V18 A9 9 0 0 0 14 18 V32 M7 25 L14 33 L21 25',
  };
  return ({
    TURN_RIGHT: P.right, ROUNDABOUT_RIGHT: P.right, FORK_RIGHT: P.slightRight, TURN_SLIGHT_RIGHT: P.slightRight,
    TURN_LEFT: P.left, ROUNDABOUT_LEFT: P.left, FORK_LEFT: P.slightLeft, TURN_SLIGHT_LEFT: P.slightLeft,
    TURN_SHARP_RIGHT: P.sharpRight, TURN_SHARP_LEFT: P.sharpLeft, UTURN_LEFT: P.uturn, UTURN_RIGHT: P.uturn,
  })[code] || P.straight;
}

/** Clockwise degrees for the instruction icon, 0 = straight ahead. */
export function maneuverAngle(code) {
  return ({
    TURN_LEFT: -90, TURN_RIGHT: 90, TURN_SLIGHT_LEFT: -45, TURN_SLIGHT_RIGHT: 45, TURN_SHARP_LEFT: -135,
    TURN_SHARP_RIGHT: 135, UTURN_LEFT: 180, UTURN_RIGHT: 180, ROUNDABOUT_LEFT: -90, ROUNDABOUT_RIGHT: 90,
    FORK_LEFT: -30, FORK_RIGHT: 30,
  })[code] || 0;
}
