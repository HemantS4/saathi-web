// ─────────────────────────────────────────────────────────────────────────────
//  Saathi web navigation - settings. Edit these before deploying.
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  // Google Maps Platform browser key with: Maps JavaScript API, Routes API, Places API (New).
  // Restrict it to your site's domain (HTTP referrer) in Google Cloud Console.
  // Leave empty to run on free OpenStreetMap routing + map instead.
  googleMapsApiKey: '',

  // Map ID for vector maps (needed for the map to rotate with your heading). 'DEMO_MAP_ID' works for testing;
  // create your own in Cloud Console ▸ Map Management for production.
  googleMapId: 'DEMO_MAP_ID',

  language: 'en-IN',
  region: 'IN',
  brand: 'Saathi',

  // Navigation tuning (metres)
  arrivalRadius: 15,
  offRouteDistance: 30,
  coinSpacing: 20,
  coinCollectRadius: 8,     // browser GPS is noisy, so be generous
  coinValue: 10,
  trailAhead: 45,
  chevronSpacing: 2.5,
  eyeHeight: 1.5,

  // Free fallback walking router (OSRM, OpenStreetMap data) used when Google isn't configured or fails.
  osrmFootUrl: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
};
