# Transit Colors

Transit Colors is an interactive map for exploring transit access in Mexico City, New
York City, Singapore, Atlanta, and Athens. It includes:

- street-level distance to selected transit modes;
- schedule-adjusted travel time to a selected station; and
- a Circumference Lab that finds large closed metro or divided-highway loops and
  measures the land they enclose.

Circumference routes follow averaged centerlines from official GTFS track shapes by
default where shape data is published, with an option to compare straight
platform-to-platform geometry. The map also shows every eligible metro line and
line-specific platform in its official agency color. All five networks and their
selected boundaries stay visible together. The shared weekday/time setting filters each
city's operating lines and selects the proven maximum-area boundary for that service
period. Atlanta correctly reports that its branched rail network has no closed loop,
rather than manufacturing one from concurrent services.

The controlled-access criterion displays the contiguous North American divided freeway
and tollway network. Mainlines and direct ramp-only interchange connectors are distinct
graph and display features. Natural Earth's generalized centerlines provide continental
coverage; OSM precision patches average the paired carriageways and attach ramps only at
shared physical nodes in detailed interchanges. An offline planar graph proof highlights
the largest simple circle, while WGS84 land clipping reports both contained land and the
remaining North American mainland area out to the coast.

The sidebar follows the same product → mode → results → selected item hierarchy for both
experiences. Circumference result cards show each city's route and landmass split and
can focus the camera without filtering the map. In the heatmap, moving the map to a
supported metro area automatically brings its local transit data into the results. Any
visible street, station, line, platform, or transfer can be inspected directly without
first changing a city mode. At regional and world scale the map renders as an
interactive globe, transitioning continuously to the familiar flat-map view at street
scale.

The public site is deployed at
[liambutler-lawrence.github.io/transit-colors](https://liambutler-lawrence.github.io/transit-colors/).

## Technology

- TypeScript with strict compiler and type-aware ESLint rules
- Zod validation for network and map-feature boundaries
- Vite
- MapLibre GL JS globe rendering and PMTiles
- GeographicLib WGS84 ellipsoidal distance and area calculations
- OpenFreeMap, OpenStreetMap, official GTFS feeds, and Natural Earth data

The application is entirely static. Runtime data is committed under `data/`; no
application server or secret is required to view the map.

## Quick start

Install Node.js 22.13 or newer, then run:

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. The checked-in datasets are enough for ordinary
application work.

Before opening a pull request:

```sh
npm run check
```

This verifies formatting, lint rules, strict types, tests, and the production build.

## Documentation

- [Development](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data sources and rebuilds](docs/DATA.md)
- [Deployment and rollback](docs/DEPLOYMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Project status

Transit Colors is an exploratory visualization, not a journey planner. Travel times use
published schedule windows, estimated ride speeds, and an 80 m/min walking assumption.
They do not include live disruptions, traffic, holiday exceptions, or accessibility
constraints.

## License

The source code is available under the [MIT License](LICENSE). Third-party transit,
street, map, and geographic data remain subject to their respective source licenses and
attribution requirements.
