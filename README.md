# Transit Colors

Static POC for the Mexico City and New York City metropolitan areas. It overlays streets with:

- A color gradient based on distance to the nearest selected transit modes in either metro area.
- Schedule-adjusted travel time to a selected station in either metro area, including the access walk, expected boarding wait, and estimated ride through the transit network.

Choose a destination from the panel or click an open station on the map. Set a weekday and departure time to apply published service windows and headways. Select “Nearest station only” to return to the distance view.

The destination view's time scale is configurable. Set the green-to-yellow transition in minutes; the orange and red transitions follow at 2× and 4× that value.

The control panel occupies its own responsive pane instead of covering the map. It
can be collapsed into a narrow desktop rail or a compact mobile bar; mobile starts
collapsed so the map retains nearly the full screen until controls are needed.

## Stack

- Map renderer: MapLibre GL JS
- Basemap: OpenFreeMap
- Source data: OpenStreetMap via Overpass API and the official SEMOVI GTFS feed
- Hosting target: GitHub Pages

## Local Development

Generate data for either metro area:

```sh
brew install tippecanoe
npm install
npm run build:data:cdmx
npm run build:data:nyc
```

`build:data:cdmx` refreshes the source GeoJSON and then creates the browser-facing
PMTiles archive. To rebuild only the archive from existing source data, run
`npm run build:tiles:cdmx`. Pinned browser libraries and the local OpenFreeMap
style snapshot can be refreshed with `npm run build:vendor`.

Refresh schedule data from the official SEMOVI GTFS feed after generating stations:

```sh
npm run build:data:schedules
```

Run both area builders and refresh the CDMX schedule snapshot with `npm run build:data`.

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
`0-5000m`. The source per-mode distances live in
`data/cdmx-street-mode-distances.json`; the browser reads those values from
`data/cdmx-streets.pmtiles` in 50m display increments. The archive uses a road-class
zoom hierarchy so overview maps load major roads first and add local streets as the
user zooms in. Enabling the top-level Future control also includes future/planned
stations from the currently selected modes in the gradient.

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

- CDMX initial interactive street render: 624-735ms across three final runs;
- NYC direct initial load: 314ms;
- station-mode filter update: 65ms;
- CDMX → NYC area switch: 229ms;
- NYC → CDMX area switch, including fresh street-tile ranges: 524ms;
- destination selection and schedule-aware recolor: 39ms.

Destination graph construction and its schedule/options setup run during idle time
after the initial map becomes interactive, keeping that optional work off the
startup critical path.

## NYC Metro Data Notes

The NYC builder combines current static GTFS station data for:

- MTA New York City Subway and Staten Island Railway
- Long Island Rail Road
- Metro-North Railroad
- NJ Transit commuter rail and light rail
- PATH

The committed dataset is clipped to the regional transit footprint from `40.0-41.9° N` and `74.8-71.8° W`, which includes the outer commuter-rail branches while excluding NJ Transit service outside the NYC region.

Unlike the precomputed CDMX street file, the browser collects the currently loaded OpenFreeMap roads for NYC and builds a viewport-based GeoJSON overlay. Each road receives its nearest selected station and distance, so the same visible `0-5000m` gradient, street details, destination routing, and in-view counts work in both metro areas. Panning or zooming refreshes the road overlay from the loaded vector tiles.

`data/nyc-schedules.json` is generated with the station snapshot from the MTA, NJ Transit, and PATH static GTFS feeds. It compresses published departures into recurring weekday service windows and headway estimates for 945 of the 947 current station records. The remaining records use the labeled four-minute boarding-wait estimate.

Downloaded GTFS archives are cached in `data/.gtfs-cache/`. Set `REFRESH_GTFS_CACHE=1` to force a refresh.

`data/cdmx-street-access.json` stores the nearest-station index for every street. It is generated alongside the other data by `npm run build:data:cdmx`; `npm run build:data:access` can regenerate only this sidecar from the checked-in station and street files.

`data/cdmx-schedules.json` is generated from the [official CDMX GTFS dataset](https://datos.cdmx.gob.mx/tr/dataset/gtfs). The checked-in snapshot was matched to 765 of 1,001 open OSM station records. It covers Metro, Metrobús, Tren Ligero, Cablebús, Tren Suburbano, Tren Interurbano, and the elevated Trolebús corridors present in that feed. Unmatched records, including systems outside the feed, use a clearly labeled four-minute boarding-wait estimate.

For a selected weekday and time, the app uses the GTFS frequency windows at each matched stop. During service, expected wait is half the published headway; outside service, the calculation waits until the next weekly service window. Overnight times above 24:00 are supported. Because the current feed's absolute calendar end dates are stale for most services, the builder deliberately uses its recurring weekday flags and does not claim date-specific exceptions.

Destination travel times remain schedule-adjusted estimates, not exact journey-planner or live-routing results. The ride and transfer portion comes from a lightweight graph built from route metadata, station mode, nearby transfers, and average speeds. The schedule changes the initial boarding wait; transfer waits, real-time disruptions, traffic, and holiday exceptions are not modeled. The street access walk uses the nearest-station distance at 80 m/min.

## Deployment

GitHub Pages is currently configured for branch-based publishing from `main` at `/`.

GitHub Actions Pages deployment was tested again on July 2, 2026 after the `candlefinance` org role changed from admin to member, but GitHub still rejected the workflow job before runner startup with: `The job was not started because your account is locked due to a billing issue.`
