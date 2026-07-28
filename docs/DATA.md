# Data sources and rebuilds

The committed `data/` directory makes local development and deployment deterministic.
Rebuild data only when intentionally refreshing a source snapshot.

## Sources

- OpenStreetMap contributors through the Overpass API
- Mexico City open-data GTFS
- MTA, NJ Transit, and PATH static GTFS feeds
- MARTA static GTFS
- OASA / STASY static GTFS
- LTA DataMall-derived Singapore rail data and station codes
- Official AIFA and Servicio de Transportes Eléctricos station references
- Natural Earth 1:10m land polygons
- Natural Earth 1:10m North America roads supplement

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

## Singapore, Atlanta, and Athens

```sh
npm run build:data:additional
```

The shared builder streams large GTFS stop-time tables, filters to rail routes, and
creates line-specific platform nodes with explicit paid-area transfers. Individual
refresh commands are also available as `build:data:singapore`, `build:data:atlanta`, and
`build:data:athens`.

Singapore's current snapshot is corrected against LTA's station-code topology because
its derived GTFS omits interchange calls from trip sequences. It includes the Circle
Line Stage 6 stations opened on 12 July 2026 and uses LTA's published operating span and
frequency guidance. The smaller shape-bearing snapshot supplies physical centerlines for
older segments; newer sections explicitly retain straight fallback geometry.

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

`npm run build:data` refreshes all five metro areas, schedules, and track geometry in
the required order.

## Circumference routes

After station, schedule, and track snapshots are current, run:

```sh
npm run build:data:circumference
```

This writes the complete display networks and offline-proven maximum-area routes for all
loop-forming areas, including every distinct weekly segment-level service topology
derived from the published route-direction schedule windows. Express stop-to-stop
service is normalized across the physical track segments it traverses. The exact
optimizer reuses a superset certificate whenever its winner remains valid and solves
only the reduced topologies that need a different winner. It may take several minutes
for NYC. That cost is intentionally paid only during a data refresh; the browser loads
the committed results directly.

MARTA Rail is a branched cross without a geographically meaningful closed passenger
route. Its full network is still published and rendered in Circumference Lab with an
explicit no-loop result.

## North American controlled-access highways

Download and extract Natural Earth 5.1.1's North America roads supplement and 1:10m land
shapefile. The committed OSM precision override can be regenerated from an ignored
Overpass response before rebuilding the continental result:

```sh
npm run build:data:highway-interchanges
```

Then run:

```sh
npm run build:data:highways -- \
  /path/to/ne_10m_roads_north_america.shp \
  data/north-america-highway-circumference.json \
  /path/to/ne_10m_land.shp \
  data/highway-interchanges/norwalk-i95-us7.json
```

The build retains divided `Freeway` and `Tollway` centerlines. At a precision
interchange it requires OSM `motorway`, `oneway=yes`, and at least two lanes for each
mainline carriageway, averages the paired sides every 25 meters, and admits only
signal-free `motorway_link` paths that join two eligible mainlines. Ramp connectors and
mainlines stay distinct. Only identical explicit node IDs create a junction, so a bridge
or other grade-separated geometric crossing cannot become an intersection. The builder
also repairs short dangling source seams and nine sub-3 km international file-boundary
seams, then keeps the largest contiguous North American component.

It removes terminal branches, compresses degree-two corridors, decomposes the graph into
vertex-biconnected blocks, and proves the maximum-area embedded outer boundary. The
committed file contains the complete thin display network, segmented thick winning
route, source attributes, and WGS84 land-contained and coastward areas. The browser
lazy-loads this larger snapshot only after the highway criterion is selected.

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
