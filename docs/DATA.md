# Data sources and rebuilds

The committed `data/` directory makes local development and deployment deterministic.
Rebuild data only when intentionally refreshing a source snapshot.

## Sources

- OpenStreetMap contributors through the Overpass API
- Mexico City open-data GTFS
- MTA, NJ Transit, and PATH static GTFS feeds
- Official AIFA and Servicio de Transportes Eléctricos station references
- Natural Earth 1:10m land polygons

Review each source's terms before redistributing a new snapshot. Preserve the in-app
attribution whenever adding a source.

## CDMX

Install Tippecanoe, then run:

```sh
npm run build:data:cdmx
```

The builder classifies rapid-transit station candidates, excludes generic bus terminals,
separates open and future stations, scores street access, and creates the browser-facing
PMTiles archive.

To rebuild only derived files from checked-in source GeoJSON:

```sh
npm run build:data:cdmx:derived
```

## NYC

```sh
npm run build:data:nyc
```

The builder combines subway, PATH, commuter rail, light rail, and regional GTFS feeds
inside the configured metropolitan bounds.

## Schedules

```sh
npm run build:data:schedules
```

Schedule files compress published departures into recurring weekday service windows and
headway estimates. Set `REFRESH_GTFS_CACHE=1` to replace downloaded GTFS caches.

## Track geometry

After the schedule and station snapshots are current, run:

```sh
npm run build:data:tracks
```

The builder reads official GTFS trip shapes from the local feed cache, extracts
station-to-station observations, resamples them to a common interval, and averages
distinct directions or track sides. Centerlines retain exact platform coordinates as
their endpoints and fall back to a straight edge when no reliable shape section exists.

`npm run build:data` refreshes both metro areas, schedules, and track geometry in the
required order.

## Circumference routes

After station, schedule, and track snapshots are current, run:

```sh
npm run build:data:circumference
```

This writes the complete display networks and offline-proven maximum-area routes for
both areas, including every distinct weekly service topology derived from the published
schedule windows. The exact optimizer reuses a superset certificate whenever its winner
remains valid and solves only the reduced topologies that need a different winner. It
may take several minutes for NYC. That cost is intentionally paid only during a data
refresh; the browser loads the committed results directly.

## Landmasses

After downloading and extracting Natural Earth 5.1.1 `ne_10m_land.shp`:

```sh
npm run build:data:landmasses -- /path/to/ne_10m_land.shp
```

The result includes the masks and measured areas used by Circumference Lab. Landmass
totals and clipped route coverage use WGS84 ellipsoidal area; the clipping workspace
uses a local equal-area transform rather than Web Mercator.

## Validation

After any data refresh:

```sh
npm test
npm run build
git diff --stat data
```

Inspect unexpectedly large changes, station-count changes, source metadata, and route
invariant failures before committing the snapshot. Never commit `.gtfs-cache` or
`.overpass-cache`.
