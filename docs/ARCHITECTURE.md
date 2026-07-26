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

The application modules form a one-way dependency graph from shared context to features
to lifecycle orchestration. Cross-feature refresh requests use browser events instead of
circular module imports.

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

`src/circumference/graph.ts` contains graph and spherical geometry primitives.
`src/circumference/cycles.ts` generates candidate cycles. Candidate ranking and route
construction live in `src/circumference/candidates.ts`.

The calculation removes non-cyclic branches and route shortcuts, generates several
families of valid simple cycles, rejects self-intersections and repeated stations, and
ranks the remaining loops by geodesic enclosed area.

## Static data

Small GeoJSON and JSON datasets are read directly. CDMX streets are distributed as
PMTiles so the browser requests only visible ranges. NYC roads are derived from visible
OpenFreeMap road features at runtime.

Downloaded GTFS and Overpass responses are caches, not source artifacts, and are
excluded from version control and production builds.
