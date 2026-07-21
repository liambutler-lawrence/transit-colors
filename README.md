# Transit Colors

Static POC that colors streets by distance to the nearest open transit station. The map supports the Mexico City and New York City metropolitan areas.

## Stack

- Map renderer: MapLibre GL JS
- Basemap: OpenFreeMap
- Source data: OpenStreetMap via Overpass API
- Hosting target: GitHub Pages

## Local Development

Generate data for either metro area:

```sh
npm run build:data:cdmx
npm run build:data:nyc
```

Run both builders with `npm run build:data`.

Serve the static site:

```sh
npm run dev
```

Open `http://localhost:5173`.

## CDMX Data Notes

The data script fetches CDMX roads and station-like transit features from Overpass once, then writes static GeoJSON into `data/`.

Raw station candidates currently include:

- `railway=station`
- `railway=halt`
- `railway=tram_stop`
- `public_transport=station`
- BRT `public_transport=platform` / `stop_position` records
- `amenity=bus_station`
- BRT `highway=bus_stop` records

The builder then keeps rapid-transit systems only:

- Metro
- BRT, including Metrobús, Mexibús, and BRT-style Trolebús corridors
- Tren Ligero
- Cablebús and Mexicable
- Tren Suburbano
- Tren Interurbano / El Insurgente
- Monorail records

Generic local bus terminals, route bases, airport/long-distance bus terminals, and CETRAM-only records are excluded unless their network/operator identifies one of the rapid-transit systems above.

Stations are fetched from OpenStreetMap records inside the Ciudad de México and Estado de México administrative areas. Street data is then fetched from the minimum bbox around the kept stations, padded by 5km.

BRT stops can also inherit network metadata from matching OSM route relations when the stop/platform element itself is missing `network` or `operator` tags.

Stations are classified as open or future/planned before street distances are calculated. The gradient uses open stations only. Future/planned stations are kept in `data/cdmx-stations.geojson` for optional display behind the Future toggle.

Future/planned status is based on:

- OSM lifecycle tags such as `proposed=yes`, `proposed:*`, `railway=proposed`, or `railway=construction`
- OSM `opening_date` values later than the generation date
- Narrow network-level overrides for known not-yet-open systems whose OSM tags are incomplete, currently Mexicable Línea 3 and Tren Ligero Texcoco-La Paz

Street color is computed from the nearest selected open-station mode and clamped to
`0-5000m`. Per-mode distances live in the compact companion file
`data/cdmx-street-mode-distances.json`, allowing the map gradient to update without
reloading the street geometry. Enabling the top-level Future control also includes
future/planned stations from the currently selected modes in the gradient.

## NYC Metro Data Notes

The NYC builder combines current static GTFS station data for:

- MTA New York City Subway and Staten Island Railway
- Long Island Rail Road
- Metro-North Railroad
- NJ Transit commuter rail and light rail
- PATH

The committed dataset is clipped to the regional transit footprint from `40.0-41.9° N` and `74.8-71.8° W`, which includes the outer commuter-rail branches while excluding NJ Transit service outside the NYC region.

Unlike the precomputed CDMX street file, NYC street distances are evaluated in the browser against OpenFreeMap's OpenStreetMap vector roads using MapLibre's `distance` expression. This keeps the NYC addition small while preserving the same `0-5000m` color scale. The metadata displays `Live` for street totals and proximity counts because those roads are loaded as viewport-based vector tiles rather than a fixed GeoJSON collection.

Downloaded GTFS archives are cached in `data/.gtfs-cache/`. Set `REFRESH_GTFS_CACHE=1` to force a refresh.

## Deployment

GitHub Pages is currently configured for branch-based publishing from `main` at `/`.

GitHub Actions Pages deployment was tested again on July 2, 2026 after the `candlefinance` org role changed from admin to member, but GitHub still rejected the workflow job before runner startup with: `The job was not started because your account is locked due to a billing issue.`
