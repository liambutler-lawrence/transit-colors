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

Station inputs currently include:

- `railway=station`
- `railway=halt`
- `railway=tram_stop`
- `public_transport=station`
- `amenity=bus_station`

Street color is computed from the nearest station and clamped to `0-10000m`.

## Deployment

The repo includes a GitHub Pages workflow at `.github/workflows/pages.yml`. When Pages is configured to deploy from GitHub Actions, every push to `main` publishes the static site.
