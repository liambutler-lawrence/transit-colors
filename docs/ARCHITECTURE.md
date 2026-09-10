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

The highway criterion uses schemas in `src/highway-circumference.ts`. The UI reads a
small summary containing labels, statistics, camera bounds, and gradient bounds. The
complete boundary and its interior are compiled to a separate PMTiles archive at zooms
0–14; the browser fetches only visible tiles instead of cloning the continental GeoJSON
to and from MapLibre workers. `build:tiles:highway-route` can rebuild these display
assets from the unchanged precise route JSON, and the full highway builder also
regenerates them. The gradient worker alone fetches and validates that precise JSON,
keeping large geometry parsing and indexing off the UI thread.

The offline builder operates on a network-wide OpenStreetMap divided-road graph. It
pairs lane-qualified one-way carriageways into a sampled centerline, classifies direct
motorway-link paths as connector edges, and inserts their endpoints into the mainline
geometry. Initial pairing searches within 160 metres. A missing run may continue an
established pair through a wider median only when the same opposing source chain is
confirmed at both ends. Every intervening sample must have a closest opposing tangent
within 2 kilometres, progress monotonically along that chain, and keep consecutive
midpoints within the normal sampling limit. Runs longer than 25 kilometres, unbounded
gaps, and changes of opposing chain remain unmatched; there is no straight-line gap
bridge. Mainline matching stops at the actual overlap of the carriageways: a nearest
projection past an opposing chain's terminal rejects that chain, rather than clamping to
its endpoint or using a farther interior vertex. Closest vertices at ordinary interior
bends remain valid. At a mainline merge, directional source junctions that attach to the
same branch terminal share one centerline vertex on the continuing midpoint line.
Existing endpoint keys carry that vertex across split centerline parts. Terminal
geometry is extended or trimmed in travel order; interior insertions are projected again
after the shared coordinate is chosen. A merge adjustment cannot collapse a short loop,
trim past a different junction, or add backward turns to an approach; those complex
attachments retain their individual source topology.

A one-lane merge can also leave an unrelated pair between the branch's return roadway
and the through road. The builder records each pair's complete source-chain intervals
and removes such a pair only when an explicit reciprocal merge covers one entire side
and the independently paired through mainline covers the other. Independent ramp
attachments, continuation parents, and other mainline junctions prevent removal.
Junctions and ramps are then rebuilt from the original averaged coordinates so the
removed pair's old junction insertions cannot remain as zigzags. Every removed pair must
still have the same supporting reciprocal movement between its surviving parent
mainlines; a failed proposal is retained and the remaining proposals are retried from
the original geometry.

Ramp attachments preserve an existing source-way projection within 160 metres. A farther
projection can use a nearby part of the same source corridor, identified by shared
source ways. An auxiliary carriageway omitted from the averaged part's source list must
reconnect to that same represented corridor in both travel directions within 2.5
kilometres before its ramp endpoint can attach. Dead ends, ambiguous branches,
coordinate-only crossings, and distant projections cannot supply that inference.
Reciprocal candidates must use opposing carriageways at both highway legs. Source chains
already paired into a mainline remain opposite even when they bend between staggered
ramp joins. Where that direct source relationship is unavailable, local travel tangents
must be opposed with the same minimum alignment (0.62) used for mainlines. Long source
chains can turn around a ring, so sharing a chain or a partner elsewhere does not alone
establish the local travel side. Reversing highway names alone is insufficient: an exit
and entrance using the same travel side cannot form a two-way connection, even when they
are the only available pair. This requirement applies before ranking both established
and inferred attachments; proximity cannot override it. Established reciprocal movements
retain their original attachments and directional paths. Inferred attachments can supply
an unmatched movement only when its new midpoint has neither backward turns nor
self-intersections; they cannot consume a direction from an existing pair or create a
duplicate of it. Reciprocal collector-road alternatives are consolidated to the pair
with the shortest mean directional ramp distance only when both directions share a
source junction and directed segment and connect the same mainline legs. Shared
collector stems for distinct turns remain separate; proximity alone never merges
connections. Ramp samples use the closest point on a tangent-aligned opposing segment
and its WGS84 geodesic midpoint, as mainlines do. The shorter of the two oriented paths
supplies the samples; endpoints are never warped to create correspondence and the
midpoints are not smoothed afterward. If successive projections skip a source bend,
nearby closest-tangent anchors bound a local, monotone Hermite interpolation of distance
along each source path. Denser samples then trace that bend before the geodesic
midpoints are computed. This does not normalize progress across the complete ramps or
round off their output coordinates. The continuation is rejected if it traverses a
reverse-facing loop or makes a sharper corner, including at its joins to the untouched
correspondence. If the resulting midpoint doubles back, the builder tries the ordered
closest-tangent correspondence used for mainline bends across both source paths. It
accepts this fallback only when the new midpoint stays between the source roads, removes
backward turns, improves the maximum turn, and has no self-intersection after endpoint
attachment. Where ramp joins are staggered, the path extends along its actual source
mainline carriageway through explicit OSM nodes, from the earlier split to the later
merge. Only then are the shared centerline endpoints attached to the mainline graph.
Geometry crossings never create graph nodes; topology comes from explicit shared source
nodes. The continental stages are largest-component selection, 2-core pruning,
degree-two compression, a detailed northeastern perimeter cycle, and independent
detailed node-disjoint ears for southeastern Massachusetts and the southern/western
perimeter. The northeastern cycle is explicitly anchored through Highway 407, Ottawa,
Québec, and coastal New England. Every ear uses explicit source junctions. A small hook
where two consecutive averaged edges overshoot their shared junction is clipped only
between those adjacent tails; any nonlocal geometric crossing forbids the responsible
corridor and triggers another routing attempt. The accepted boundary is a simple cycle
in both graph topology and rendered geometry.

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
segment index preserves every boundary bend, and the highway texture is cropped to a
padded viewport to retain detail at close zooms.

Metro and highway gradients render and encode PNGs in one lazy-loaded worker using
OffscreenCanvas. The worker retains route geometry and its distance index between
requests and skips pixels excluded by the coast/interior mask. Rendering yields in small
batches so obsolete requests can be cancelled. The UI holds one active job and one
latest replacement per source, waits 120 ms after movement, and pauses work and image
uploads during gestures. Four cached images per source cover small pans and return
visits when their coverage and projected resolution remain sufficient. Hidden sources
cancel pending work; route changes invalidate old images. Blob URLs replace synchronous
canvas-to-data-URL encoding, and the last good texture remains visible while new pixels
or the worker script load. Worker errors preserve the image and allow a later view to
retry without falling back to blocking main-thread rendering.

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
