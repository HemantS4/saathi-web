// Map panel: Google Maps (vector, rotates with heading) when a key is configured, otherwise Leaflet + OpenStreetMap.

import { CONFIG } from './config.js';

let googleReady = null;

export function loadGoogleMaps() {
  if (!CONFIG.googleMapsApiKey) return Promise.resolve(false);
  if (googleReady) return googleReady;
  googleReady = new Promise(resolve => {
    window.__saathiMapsReady = () => resolve(true);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CONFIG.googleMapsApiKey)}` +
      `&v=weekly&loading=async&callback=__saathiMapsReady&language=${CONFIG.language}&region=${CONFIG.region}`;
    s.async = true;
    s.onerror = () => resolve(false);
    window.gm_authFailure = () => { console.warn('[Saathi] Google Maps key rejected'); resolve(false); };
    document.head.appendChild(s);
  });
  return googleReady;
}

let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return leafletReady;
}

const userArrowHtml = () => {
  const el = document.createElement('div');
  el.className = 'map-user';
  el.innerHTML = '<div class="map-user-halo"></div><svg viewBox="0 0 40 40" class="map-user-arrow"><path d="M20 3 L34 35 L20 27 L6 35 Z"/></svg>';
  return el;
};
const destPinHtml = label => {
  const el = document.createElement('div');
  el.className = 'map-dest';
  el.innerHTML = `<svg viewBox="0 0 40 52"><path d="M20 51 C20 51 3 30 3 19 A17 17 0 1 1 37 19 C37 30 20 51 20 51 Z"/><circle cx="20" cy="19" r="7" fill="#fff"/></svg>`;
  el.title = label || '';
  return el;
};

export class NavMap {
  constructor(container) {
    this.el = container;
    this.kind = null;
    this.follow = true;
    this.headingUp = true;
  }

  async init(center, dest) {
    if (await loadGoogleMaps()) {
      try { await this._initGoogle(center, dest); return this; }
      catch (e) { console.warn('[Saathi] Google map failed, using OSM', e); }
    }
    await this._initLeaflet(center, dest);
    return this;
  }

  async _initGoogle(center, dest) {
    const { Map, Polyline, RenderingType } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    this.kind = 'google';
    this.map = new Map(this.el, {
      center, zoom: 18, mapId: CONFIG.googleMapId, renderingType: RenderingType.VECTOR,
      disableDefaultUI: true, gestureHandling: 'greedy', clickableIcons: false, heading: 0, tilt: 0,
    });
    this.casing = new Polyline({ map: this.map, strokeColor: '#ffffff', strokeWeight: 11, strokeOpacity: 1, zIndex: 1 });
    this.line = new Polyline({ map: this.map, strokeColor: '#1fae5b', strokeWeight: 6, strokeOpacity: 1, zIndex: 2 });
    this.userMarker = new AdvancedMarkerElement({ map: this.map, position: center, content: userArrowHtml(), zIndex: 10 });
    this.destMarker = new AdvancedMarkerElement({ map: this.map, position: dest, content: destPinHtml(dest.name), zIndex: 5 });
    this.map.addListener('dragstart', () => { this.follow = false; this.onFollowChange?.(false); });
  }

  async _initLeaflet(center, dest) {
    const L = await loadLeaflet();
    this.kind = 'leaflet';
    this.map = L.map(this.el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 18);
    this.map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(this.map);
    this.casing = L.polyline([], { color: '#fff', weight: 11, opacity: 1 }).addTo(this.map);
    this.line = L.polyline([], { color: '#1fae5b', weight: 6, opacity: 1 }).addTo(this.map);
    const icon = el => L.divIcon({ html: el.outerHTML, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
    this.userMarker = L.marker([center.lat, center.lng], { icon: icon(userArrowHtml()), zIndexOffset: 1000 }).addTo(this.map);
    this.destMarker = L.marker([dest.lat, dest.lng], {
      icon: L.divIcon({ html: destPinHtml(dest.name).outerHTML, className: '', iconSize: [34, 44], iconAnchor: [17, 44] }),
    }).addTo(this.map);
    this.map.on('dragstart', () => { this.follow = false; this.onFollowChange?.(false); });
  }

  /**
   * Floor plan instead of a street map. Plan metres are used as {lat: y, lng: x} in Leaflet's flat CRS, so every
   * other method (setRoute, update, setDest…) works unchanged with indoor coordinates.
   */
  async initIndoor(building, floor, start, dest) {
    const L = await loadLeaflet();
    this.kind = 'leaflet';
    this.indoor = true;
    const bounds = [[0, 0], [floor.heightM, floor.widthM]];
    if (!this.map) {
      this.map = L.map(this.el, { crs: L.CRS.Simple, zoomControl: false, attributionControl: false, minZoom: -2, maxZoom: 5, zoomSnap: 0.25 });
      this.casing = L.polyline([], { color: '#fff', weight: 11, opacity: 1 }).addTo(this.map);
      this.line = L.polyline([], { color: '#1fae5b', weight: 6, opacity: 1 }).addTo(this.map);
      const icon = el => L.divIcon({ html: el.outerHTML, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
      this.userMarker = L.marker([start.lat, start.lng], { icon: icon(userArrowHtml()), zIndexOffset: 1000 }).addTo(this.map);
      this.destMarker = L.marker([dest.lat, dest.lng], {
        icon: L.divIcon({ html: destPinHtml(dest.name).outerHTML, className: '', iconSize: [34, 44], iconAnchor: [17, 44] }),
      }).addTo(this.map);
      this.map.on('dragstart', () => { this.follow = false; this.onFollowChange?.(false); });
    }
    this.plan?.remove();
    this.plan = L.imageOverlay(building.imageUrl(floor), bounds).addTo(this.map);
    this.plan.bringToBack();
    this.map.invalidateSize(); // the container may have just been un-hidden
    this.map.fitBounds(bounds, { padding: [8, 8] });
    return this;
  }

  setRoute(points) {
    if (this.kind === 'google') { this.casing.setPath(points); this.line.setPath(points); }
    else if (this.kind === 'leaflet') {
      const ll = points.map(p => [p.lat, p.lng]);
      this.casing.setLatLngs(ll); this.line.setLatLngs(ll);
    }
  }

  fit(points) {
    if (!points?.length) return;
    if (this.kind === 'google') {
      const b = new google.maps.LatLngBounds();
      points.forEach(p => b.extend(p));
      this.map.setHeading(0);
      this.map.fitBounds(b, 50);
    } else if (this.kind === 'leaflet') {
      this.map.fitBounds(points.map(p => [p.lat, p.lng]), { padding: [40, 40] });
    }
  }

  recenter() { this.follow = true; this.onFollowChange?.(true); }

  /** cb({lat,lng}) when the map is tapped. */
  onTap(cb) {
    if (this.kind === 'google') this.map.addListener('click', e => cb({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
    else if (this.kind === 'leaflet') this.map.on('click', e => cb({ lat: e.latlng.lat, lng: e.latlng.lng }));
  }

  setDest(pos, zoom) {
    if (this.kind === 'google') {
      this.destMarker.position = pos;
      this.destMarker.map = pos ? this.map : null;
      if (pos) { this.map.panTo(pos); if (zoom) this.map.setZoom(zoom); }
    } else if (this.kind === 'leaflet') {
      if (pos) {
        this.destMarker.setLatLng([pos.lat, pos.lng]).addTo(this.map);
        this.map.setView([pos.lat, pos.lng], zoom || this.map.getZoom());
      } else this.destMarker.remove();
    }
  }

  showUserAt(pos) {
    if (!pos) return;
    if (this.kind === 'google') { this.userMarker.position = pos; this.userMarker.map = this.map; }
    else if (this.kind === 'leaflet') this.userMarker.setLatLng([pos.lat, pos.lng]).addTo(this.map);
  }

  setView(pos, zoom) {
    if (this.kind === 'google') { this.map.setCenter(pos); this.map.setZoom(zoom); }
    else if (this.kind === 'leaflet') this.map.setView([pos.lat, pos.lng], zoom);
  }

  hideUser() {
    if (this.kind === 'google') this.userMarker.map = null;
    else if (this.kind === 'leaflet') this.userMarker.remove();
  }

  /** Called every frame-ish with the user's position and camera heading. */
  update(pos, heading) {
    if (!this.map || !pos) return;
    const now = performance.now();
    if (now - (this._last || 0) < 120) return; // ~8 fps is plenty for the map
    this._last = now;
    if (this.kind === 'google') {
      this.userMarker.position = pos;
      const mapHeading = this.follow && this.headingUp ? heading : 0;
      if (this.follow) this.map.moveCamera({ center: pos, heading: mapHeading, zoom: this.map.getZoom() < 16 ? 18 : this.map.getZoom() });
      setRotation(this.userMarker.content, heading - (this.map.getHeading() || 0));
    } else if (this.kind === 'leaflet') {
      this.userMarker.setLatLng([pos.lat, pos.lng]);
      if (this.follow) this.map.setView([pos.lat, pos.lng], this.map.getZoom(), { animate: false });
      setRotation(this.userMarker.getElement()?.querySelector('.map-user'), heading);
    }
  }

  invalidate() { if (this.kind === 'leaflet') this.map.invalidateSize(); }
}

function setRotation(el, deg) {
  const arrow = el?.querySelector?.('.map-user-arrow');
  if (arrow) arrow.style.transform = `rotate(${deg}deg)`;
}

/** Google Places details for the landing card (photo, rating, open now, address). null if unavailable. */
export async function loadPlaceDetails(place) {
  if (!place.placeId || !(await loadGoogleMaps())) return null;
  try {
    const { Place } = await google.maps.importLibrary('places');
    const p = new Place({ id: place.placeId, requestedLanguage: CONFIG.language });
    await p.fetchFields({ fields: ['displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'photos', 'regularOpeningHours', 'utcOffsetMinutes'] });
    let openNow = null;
    try { openNow = await p.isOpen(); } catch { /* hours unknown */ }
    const photo = p.photos?.[0];
    return {
      name: p.displayName,
      address: p.formattedAddress,
      location: p.location ? { lat: p.location.lat(), lng: p.location.lng() } : null,
      rating: p.rating, ratingCount: p.userRatingCount, openNow,
      photoUrl: photo ? photo.getURI({ maxWidth: 900 }) : null,
      photoCredit: photo?.authorAttributions?.[0]?.displayName || null,
    };
  } catch (e) {
    console.warn('[Saathi] Place details failed', e);
    return null;
  }
}
