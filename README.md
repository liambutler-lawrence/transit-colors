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
npm run build:data:cdmx
```

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
- `amenity=bus_station`

The builder then keeps rapid-transit systems only:

- Metro
- Metrobús and Mexibús
- Tren Ligero
- Cablebús and Mexicable
- Tren Suburbano
- Tren Interurbano / El Insurgente
- Trolebús station-like records
- Monorail records

Generic local bus terminals, route bases, airport/long-distance bus terminals, and CETRAM-only records are excluded unless their network/operator identifies one of the rapid-transit systems above.

Stations are classified as open or future/planned before street distances are calculated. The gradient uses open stations only. Future/planned stations are kept in `data/cdmx-stations.geojson` for optional display behind the Future toggle.

Future/planned status is based on:

- OSM lifecycle tags such as `proposed=yes`, `proposed:*`, `railway=proposed`, or `railway=construction`
- OSM `opening_date` values later than the generation date
- Narrow network-level overrides for known not-yet-open systems whose OSM tags are incomplete, currently Mexicable Línea 3 and Tren Ligero Texcoco-La Paz

Street color is computed from the nearest open station and clamped to `0-5000m`.

## Deployment

GitHub Pages is configured to deploy from GitHub Actions using `.github/workflows/pages.yml`. Every push to `main` uploads the static site and publishes it without an application build step.
