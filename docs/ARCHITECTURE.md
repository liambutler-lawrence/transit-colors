# Architecture

Transit Colors is a browser-only Vite application. The repository contains the
application, deterministic derived datasets, and scripts that refresh those datasets.

## Runtime flow

1. `src/app.ts` loads the map lifecycle.
2. `src/app/context.ts` creates MapLibre, DOM references, shared state, and formatting
   helpers.
3. `src/app/map-lifecycle.ts` validates fetched JSON, installs map sources and layers,
   and connects browser events.
4. `src/app/access-controls.ts` manages station filters, street colors, statistics,
   loading state, and destination options.
5. `src/app/feature-details.ts` manages selections and schedule-aware route details.
6. `src/app/circumference-ui.ts` renders loop candidates and landmass coverage.
7. `src/app/highway-circumference-ui.ts` lazy-loads and renders the continental highway
   criterion.
8. `src/app/circumference-layers.ts` owns the complete-line, selected-route, transfer,
   station, and label layer definitions.
9. `src/app/timezone-skew-ui.ts` triangulates land-clipped time-zone polygons for a
   longitude-continuous, projection-aware custom WebGL layer and manages map inspection.
10. `src/app/land-use-ui.ts` streams Jersey City parcel, zoning, redevelopment-plan, and
    historic-district vector tiles and manages category filtering and inspection.

The application modules form a one-way dependency graph from shared context to features
to lifecycle orchestration. Cross-feature refresh requests use browser events instead of
circular module imports.

The sidebar is ordered product → mode → results → selected item. Display controls sit
immediately below the product because they affect every later section for that product.
Circumference result cards own their city-specific focus and route-variant controls. The
city selector remains an internal event bridge rather than a user-facing mode.

## Domain boundaries

`src/domain.ts` defines Zod schemas and inferred types for:

- coordinates and transit modes;
- station and street GeoJSON;
- schedule graphs;
- metadata; and
- circumference landmasses.

`src/parse.ts` is the network boundary. MapLibre feature properties are independently
validated because renderer output is external runtime data. Code does not cast values
into trusted types.

## Routing

`src/routing/access.ts` contains geometry, street splitting, spatial indexing, and
nearest-station scoring. `src/routing/transit.ts` contains estimated and
schedule-attached transit graph traversal. `src/routing.ts` is the stable public
re-export.

## Circumference calculation

`src/geodesy.ts` contains projection-independent WGS84 ellipsoidal distance and area
primitives. `src/circumference/graph.ts` contains the transit graph and delegates its
measurements to those primitives. `src/circumference/cycles.ts` generates diverse
manual-override candidates. Candidate ranking and network construction live in
`src/circumference/candidates.ts`.

`scripts/exact-circumference-solver.mjs` proves the automatic winner offline. It
contracts published free-transfer complexes, removes the graph 2-core's impossible
branches, compresses degree-two corridors, rejects crossing edges, and solves a
connected simple-cycle MILP at a feedback vertex set that intersects every possible
cycle. The maximum is defined on straight platform edges so track-shape tunnel curves
cannot change route topology. Track mode then recalculates displayed geometry, length,
and enclosed area from averaged official GTFS centerlines.

The data build records the source GTFS route-direction edge for every displayed track
segment, including express edges normalized over their physical local-station chain. It
then enumerates every distinct segment-level topology produced by the weekly GTFS
frequency windows. A reduced topology inherits a larger-network certificate when that
winner remains feasible; otherwise the MILP proves a new winner. Those schedule winners
are stored with the normal candidate bank, so changing weekday or time in the browser
only filters line appearances and selects a pre-certified path.

Landmass intersections are performed in a local WGS84 equal-area workspace for robust
polygon topology, transformed back to longitude/latitude, and measured on the WGS84
ellipsoid. The MapLibre camera is independent of these calculations: it renders a freely
rotatable globe at low zoom and transitions to its flat close-zoom view without changing
any stored route metrics.

The checked-in `data/*-circumference.json` files contain the proven winner, diverse
manual alternatives, and the complete eligible network. The browser validates and
renders these files; it never runs the combinatorial search during page load or a
schedule change.

The highway criterion uses a separate compact runtime schema in
`src/highway-circumference.ts`. Its offline builder operates on a network-wide
OpenStreetMap divided-road graph. It pairs lane-qualified one-way carriageways into a
sampled centerline, classifies direct motorway-link paths as connector edges, and
inserts their endpoints into the mainline geometry. Reciprocal collector-road
alternatives are consolidated to the pair with the shortest mean directional ramp
distance only when both directions share a source junction and directed segment and
connect the same mainline legs. Shared collector stems for distinct turns remain
separate; proximity alone never merges connections. Ramp samples use the closest point
on a tangent-aligned opposing segment and its WGS84 geodesic midpoint, as mainlines do.
The shorter of the two oriented paths supplies the samples; endpoints are never warped
to create correspondence and the midpoints are not smoothed afterward. Where ramp joins
are staggered, the path extends along its actual source mainline carriageway through
explicit OSM nodes, from the earlier split to the later merge. Only then are the shared
centerline endpoints attached to the mainline graph. Geometry crossings never create
graph nodes; topology comes from explicit shared source nodes. The continental stages
are largest-component selection, 2-core pruning, degree-two compression, a detailed
northeastern perimeter cycle, and independent detailed node-disjoint ears for
southeastern Massachusetts and the southern/western perimeter. The northeastern cycle is
explicitly anchored through Highway 407, Ottawa, Québec, and coastal New England. Every
ear uses explicit source junctions. A small hook where two consecutive averaged edges
overshoot their shared junction is clipped only between those adjacent tails; any
nonlocal geometric crossing forbids the responsible corridor and triggers another
routing attempt. The accepted boundary is a simple cycle in both graph topology and
rendered geometry.

The circumference map keeps one independent route state and gradient image source per
metro area. It merges all complete networks and selected boundaries into one GeoJSON
source, rendered in official line colors, so changing the focused area never removes the
other cities. Each result card changes the camera and its own route selection without
filtering map content. Clicking a visible circumference segment first activates its city
state and then displays that segment in the shared selected-item section.

Each gradient image uses bounds derived from its selected route rather than a city box.
The unsigned route-distance field radiates across land on both sides of the boundary,
fades to full transparency at 10 km, and includes an additional transparent texture
margin, so the finite raster has no visible rectangular edge. An area-level nearby-land
mask—independent from the landmasses used in the result statistics—and the detailed
basemap water layer terminate the field at coastlines before that maximum distance.

Highways use a separate gradient source and a complete interior polygon fill. Their
outside-only fade width is `10 km × log10(1 + enclosed area in km²)`, about 67.9 km for
the current continental circle; the legend reports that distance. Gradient pixels and
coast masks use Web Mercator coordinates with local ground-distance scaling. A cached
segment index preserves every boundary bend, and the highway texture is cropped and
redrawn after map movement or resize to retain detail at close zooms.

The heatmap eagerly loads and caches all five station datasets together. Its station
source and road scorer retain every metro as the camera moves; there is no zoom
threshold or camera-triggered metro load. Selecting a sidebar card changes the camera
target and local destination/schedule context, while preserving global mode/future
filters. Clicking a station in another metro selects its destination context directly.
Routing graphs stay local to the selected metro; the station lookup covers the entire
atlas.

Heatmap cards are ranked once by the union of 5 km catchments around all open stations,
the full range before the default distance scale's darkest red. Overlapping catchments
and co-located platforms count once. `src/transit-coverage.ts` integrates exposed circle
arcs in each metro's local WGS84 distance plane, matching the road scorer's distance
metric. The geographic area includes water, is independent of road widths and zoom, and
remains fixed when filters or the optional destination/time scale change.

## Static data

Small GeoJSON and JSON datasets are read directly. All five heatmaps use the basemap's
OpenFreeMap vector tiles. `src/transit-road-tiles.ts` splits transportation lines at
shared junctions and into short scoring segments inside those tiles, preserving their
original road properties and all non-road layers. Each tile receives transit access
scores before MapLibre renders it. Heatmap mode changes only the native road layers'
colors, including casings and pedestrian streets; their geometry, zoom limits, filters,
widths, opacity and draw order remain shared with the ordinary map. Each metro retains
its own local distance projection, even when a world tile spans several metros. Station
filter changes version tile URLs and cancel stale requests; selecting a metro does not.
Camera movement uses MapLibre's native tile loading without a separate street overlay or
idle-time refresh. The historical CDMX street PMTiles archive remains available for
offline data workflows.

The clock-skew dataset is committed as land-clipped MultiPolygons. The browser uses a
projection-aware custom WebGL fill rather than precomputed color bands, allowing the
red-white-blue value to vary continuously with longitude inside each official UTC-offset
zone. A transparent MapLibre fill layer remains available for hit testing, while a line
layer draws the zone boundaries.

The Jersey City land-use archive is a single PMTiles source with parcel, zoning, and
historic-district layers. `src/land-use.ts` owns the runtime schema, category palette,
and deterministic parcel classifier shared by the builder, tests, and browser. The
browser only filters and summarizes visible tiles; source joins and classification run
offline.

Downloaded GTFS and Overpass responses are caches, not source artifacts, and are
excluded from version control and production builds.

## Build and deployment boundary

`vite.config.ts` exports an explicit runtime-data allowlist. The production build copies
only those browser-facing datasets and the two reviewed basemap styles; source GeoJSON,
derived analysis tables, and download caches stay outside the artifact. A post-build
check verifies the allowlist and rejects any individual static file above the hosting
limit.

GitHub Actions builds and validates the artifact once. The deploy job downloads that
exact artifact, hashes and uploads each file to Vercel's content-addressed file API, and
creates a prebuilt Build Output v3 deployment. The deployment entry point rejects local
runs, pull requests, non-`main` refs, other repositories, missing secrets, and
credentials that do not match the configured project and team.
