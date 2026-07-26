# Transit Colors

Transit Colors is an interactive map for exploring transit access in Mexico City and the
New York City region. It includes:

- street-level distance to selected transit modes;
- schedule-adjusted travel time to a selected station; and
- a Circumference Lab that finds large, closed metro loops and measures the land they
  enclose, then renders each selected line in its official agency color.

The public site is deployed at
[liambutler-lawrence.github.io/transit-colors](https://liambutler-lawrence.github.io/transit-colors/).

## Technology

- TypeScript with strict compiler and type-aware ESLint rules
- Zod validation for network and map-feature boundaries
- Vite
- MapLibre GL JS and PMTiles
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
