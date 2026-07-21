# Transit Colors

Static POC that overlays CDMX streets with a color gradient based on distance to the nearest open transit station.

## Stack

- Map renderer: MapLibre GL JS
- Basemap: OpenFreeMap
- Source data: OpenStreetMap via Overpass API
- Hosting target: GitHub Pages

## Local Development

Generate CDMX data:

```sh
brew install tippecanoe
npm install
npm run build:data:cdmx
```

`build:data:cdmx` refreshes the source GeoJSON and then creates the browser-facing
PMTiles archive. To rebuild only the archive from existing source data, run
`npm run build:tiles:cdmx`. Pinned browser libraries and the local OpenFreeMap
style snapshot can be refreshed with `npm run build:vendor`.

Serve the static site:

```sh
npm run dev
```

Open `http://localhost:5173`.

## Data Notes

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
`0-5000m`. The source per-mode distances live in
`data/cdmx-street-mode-distances.json`; the browser reads those values from
`data/cdmx-streets.pmtiles` in 50m display increments. The archive uses a road-class
zoom hierarchy so overview maps load major roads first and add local streets as the
user zooms in.

## Performance

The original page blocked on 111MB of JSON, expanded seven distance arrays into
420,348 street features on the main thread, and rescanned every feature after each
mode filter change, making both startup and repeated filtering scale with the full
citywide dataset.

The optimized path:

- requests only visible byte ranges from a PMTiles vector archive;
- precomputes all 128 station-mode count combinations for constant-time filter counts;
- initializes the transit overlay as soon as the map style shell is ready, then adds
  the full basemap progressively;
- serves pinned MapLibre/PMTiles assets locally and uses a range- and gzip-capable
  development server;
- shows an accessible loading badge and map spinner until the relevant street tiles
  have rendered on initial load and area changes.

Cold-cache headless Chrome checks with software WebGL on July 21, 2026 completed in:

- initial interactive street render: 518-627ms end to end;
- station-mode filter update: 19-71ms;
- uncached zoom/area update: 18-69ms.

## Deployment

GitHub Pages is currently configured for branch-based publishing from `main` at `/`.

GitHub Actions Pages deployment was tested again on July 2, 2026 after the `candlefinance` org role changed from admin to member, but GitHub still rejected the workflow job before runner startup with: `The job was not started because your account is locked due to a billing issue.`
