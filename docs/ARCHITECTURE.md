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
7. `src/app/circumference-layers.ts` owns the complete-line, selected-route, transfer,
   station, and label layer definitions.

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

The data build enumerates every distinct line topology produced by the weekly GTFS
frequency windows. A reduced topology inherits a larger-network certificate when that
winner remains feasible; otherwise the MILP proves a new winner. Those schedule winners
are stored with the normal candidate bank, so changing weekday or time in the browser
only filters lines and selects a pre-certified path.

Landmass intersections are performed in a local WGS84 equal-area workspace for robust
polygon topology, transformed back to longitude/latitude, and measured on the WGS84
ellipsoid. The MapLibre camera is independent of these calculations: it renders a freely
rotatable globe at low zoom and transitions to its flat close-zoom view without changing
any stored route metrics.

The checked-in `data/*-circumference.json` files contain the proven winner, diverse
manual alternatives, and the complete eligible network. The browser validates and
renders these files; it never runs the combinatorial search during page load or a
schedule change.

The circumference map keeps one independent route state and gradient image source per
metro area. It merges both complete networks and selected boundaries into one GeoJSON
source, rendered in official line colors, so changing the focused area never removes the
other city. Each result card changes the camera and its own route selection without
filtering map content. Clicking a visible circumference segment first activates its city
state and then displays that segment in the shared selected-item section.

Each gradient image uses bounds derived from its selected route rather than a city box.
The outward field fades to full transparency at 10 km and includes an additional
transparent texture margin, so the finite raster has no visible rectangular edge.
Touched-landmass masks and the detailed basemap water layer still terminate the field at
coastlines before that maximum distance.

The heatmap has one active local data area because street and schedule data are loaded
per region. A `moveend` listener activates the nearest supported metro at local zoom
without moving the camera, so ordinary map navigation replaces the old city mode switch.

## Static data

Small GeoJSON and JSON datasets are read directly. CDMX streets are distributed as
PMTiles so the browser requests only visible ranges. NYC roads are derived from visible
OpenFreeMap road features at runtime.

Downloaded GTFS and Overpass responses are caches, not source artifacts, and are
excluded from version control and production builds.
