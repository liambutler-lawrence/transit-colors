# Transit Colors

Static POC that overlays CDMX streets with a color gradient based on distance to the nearest transit station.

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

Street color is computed from the nearest station and clamped to `0-10000m`.

## Deployment

GitHub Pages is configured to publish from the `main` branch at `/`. Every push to `main` publishes the static site without a build step.
