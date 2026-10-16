# Saathi web: walk anywhere with AR directions

No app to install. Open the site (or scan a QR) on a phone, pick **any destination**, and the browser uses the **camera**, **GPS** and
**compass** to draw a green AR trail, ₹ coins and a destination pin on the street, with a Google map and turn-by-turn directions.

```
QR code  ──►  https://your-site/?d=28.632650,77.218350&n=Rahman+Stores&p=<place id>&o=10%25+Off
              │  d = shop location (lat,lng from Google Maps)   n = name   p = Google place id   o = offer
              ▼
        index.html  →  landing card (photo, rating, offer)  →  "Start AR navigation"
                     →  camera + GPS + compass  →  walking route  →  AR trail, coins, map  →  arrival + offer
```

## Pages
| Page | For | What it does |
|---|---|---|
| `index.html` | everyone | **No destination in the link → "Where to?"**: search any place (Google Places, or free OpenStreetMap search), paste a Google Maps link or coordinates, drop a pin on the map, or pick a recent. **With a destination** → landing card, AR navigation, tilt-down map, voice, arrival screen. "Change destination" and a **Share / QR** button for any place. |
| `indoor.html` | building managers | Indoor map editor: floor plans, walkways, destinations, lifts, Saathi point QR posters |
| `create.html` | shop owners | Search the shop on Google Maps (or paste a Maps link / coordinates), add an offer, then download the QR or a printable poster |

## Navigate anywhere
- Open `https://<your-site>/` with no parameters to get the **Where to?** screen. Results are biased to where you are once location is allowed.
- **Any spot is reachable**: tap anywhere on the street map, on the landing card map, or on the expanded map while navigating ("Go to this spot instead?").
- After scanning a Saathi point, the same screen shows that building's shops **and** outdoor search, with **Floor plan / Street map** tabs. Tap any spot on a floor plan to go there (it snaps to the nearest walkway). **Leave building** returns to outdoor-only.
- Every destination gets its own link (the address bar updates), so it can be bookmarked, shared, or turned into a QR from the share button.
- The walk always starts from your current GPS position. Destinations more than 5 km away show a note offering Google Maps for other ways to get there.
- Search: Google Places Autocomplete with a key (enable **Geocoding API** too for dropped-pin addresses), otherwise Photon (komoot) on OpenStreetMap data.

## Put it online (it must be HTTPS)
Camera, GPS and compass only work on `https://` pages. Any static host works. For example:

- **GitHub Pages**: push the `saathi-web` folder to a repo, then Settings ▸ Pages ▸ deploy from branch. You get `https://<you>.github.io/<repo>/`.
- **Netlify Drop**: drag the `saathi-web` folder onto https://app.netlify.com/drop.
- **Vercel / Cloudflare Pages**: import the folder as a static site with no build step.

Then open `https://<your-site>/create.html`, make the QR, and test it on your phone before printing.

## Google Maps (recommended)
Edit `js/config.js` and set `googleMapsApiKey`. In Google Cloud Console:
1. Create or select a project and enable billing.
2. Enable **Maps JavaScript API**, **Routes API** and **Places API (New)**.
3. Create an API key and **restrict it**: application restriction = *Websites* with `https://<your-site>/*`
   (plus `http://localhost:5173/*` for testing). API restriction = the three APIs above.
4. Optional: create a vector **Map ID** (Map Management) and set `googleMapId`. `DEMO_MAP_ID` is fine for testing.

With the key you get Google walking directions with street names, the Google map rotating with your heading, place search on the
QR maker, and the shop's real photo, rating and opening hours. **Without a key** everything still works on free OpenStreetMap
routing (OSRM) and map tiles.

## Ground detection (WebXR)
On **Android Chrome** (ARCore phones) navigation runs as a **WebXR AR session**:
- The camera **finds the real ground**: point the phone at the floor or road until the green ring settles, and the chevrons
  and coins sit on it.
- ARCore **tracks the phone's movement**, so the trail stays locked in place between GPS fixes instead of drifting.
- GPS + compass only register the route to the world, refined by the direction you actually walk.
- **The trail follows the real ground**, not one flat level: every ground hit (and every horizontal plane, where Chrome
  offers plane detection) goes into a 1 m height grid around you, and a fitted slope carries it further ahead. Chevrons,
  coins, turn arrows and the pin sit on that surface, so slopes, kerbs and stairs are followed. Benches, car bonnets and
  tables are ignored (they're too high above the ground you're walking on).
- The ground under you is measured from hits just in front of the phone, and follows the phone's height when you look
  ahead instead of down, so walking up a hill or a flight of stairs keeps it right.
- A **ground anchor** is dropped near you every 12 m. ARCore's map corrections move the anchor, and the trail moves with it.
  If tracking is lost, everything holds still ("AR tracking paused") until ARCore recovers.

**Lining the trail up with the road.** The app reads the compass before AR starts. Then, once you have walked about 4 m along the route, it uses the road direction you just covered to correct the trail's rotation, and keeps your position snapped onto the route line. If it still looks off, tap **Align** and drag sideways until the trail lies on the road.

**iPhone Safari has no WebXR**, so it uses the camera overlay with the ground assumed at phone height. Use the ▲▼ *trail*
buttons on the right to nudge the trail onto the ground (remembered per phone). Turn WebXR off with `useWebXR: false`
in `js/config.js`.

## Indoor navigation
GPS doesn't work inside buildings, so indoors uses **Saathi points**: QR codes on the walls at known spots.
1. Open **`indoor.html`** (the indoor map editor):
   - add a floor plan image and set its scale (click two points a known distance apart)
   - draw walkways along the corridors
   - mark destinations, lifts/stairs (connect them across floors) and Saathi points, including which way people face when they scan
2. **Download building file** → put it in `buildings/<id>.json` on your site. Floor images are embedded in it.
3. **Download Saathi point QRs** → print and stick them up (entrances, lift lobbies, big junctions).
4. A visitor scans a Saathi point → picks a shop or room → follows the green trail:
   - **Android (WebXR)**: tracking from the scanned spot, accurate to about a metre indoors
   - **iPhone**: compass + step counting along the route. Re-scan any Saathi point (the scan button) to correct
   - **Changing floors**: "Take the lift to First floor", then scan the point there and it continues automatically

Try the demo: `/?b=demo-mall&a=A1&sim=1` (entrance) → pick *Cinema* to see a floor change, then open `/?b=demo-mall&a=A3&sim=1`.
Saathi point link format: `?b=<building id>&a=<point id>[&to=<place id>]`.

## How the AR works
- **Position**: `navigator.geolocation.watchPosition` with high accuracy, smoothed by an accuracy-weighted filter and gently snapped
  onto the route so the trail stays under your feet.
- **Direction**: device orientation sensors. Android Chrome uses `deviceorientationabsolute` (true north); iOS Safari uses
  `webkitCompassHeading` and asks for motion permission on the Start tap.
- **Rendering**: three.js over the live camera `<video>`. Chevrons on the ground, coins at waist height, turn arrows at corners,
  and a shop pin that parks at 60 m so it stays visible above rooftops.
- When the trail is out of view, a big arrow says *Turn left / right / around*.
- **Tilt the phone down** to open the big map; raise it to go back to AR (like Google Live View). Tap the map to toggle.
- If you're 30 m or more off the route for 8 s with a good GPS fix, it re-routes. Arrival triggers within 15 m.

Accuracy is phone GPS, about ±5–15 m in the open and worse in narrow lanes. That's why coins have a generous pickup radius and the big
turn arrow backs up the trail. If directions look rotated, calibrate the compass (move the phone in a figure 8).

## Try it locally
```bash
node serve.mjs
```
Then open http://localhost:5173/create.html. On a desktop, add `&sim=1` to a navigation link to use the **simulator**: it walks the
route by itself. Drag to look around, **W/S** to change speed, **M** to tilt to the map.
To test on a phone without deploying, use an HTTPS tunnel (for example `cloudflared tunnel --url http://localhost:5173`).

## Files
```
index.html, create.html, css/style.css
js/config.js    settings: Google key, language, tuning
js/app.js       flow, frame loop, HUD, voice, arrival
js/sensors.js   camera, GPS, compass → camera orientation; step counter; desktop simulator
js/xr.js        WebXR session, hit-test ground detection
js/align.js     registers route coordinates to the WebXR world (GPS/compass/walk direction or Saathi point)
js/indoor.js    building file model, shortest path, per-floor legs
js/indoor-editor.js  indoor map editor
buildings/      building files + floor plans (demo mall included)
js/ar.js        three.js scene: trail, coins, arrows, shop pin
js/routing.js   Google Routes API → OSRM → straight line
js/map.js       Google Maps JS (vector, heading-up) or Leaflet/OSM; Places details
js/search.js    destination search (Google / Photon), reverse geocoding, recents
js/place.js     QR URL format, Google Maps link parsing, "Open in Google Maps" links
js/geo.js       geo math, polyline decoding, route projection, GPS filter
js/create.js    QR maker
serve.mjs       zero-dependency local server
```
