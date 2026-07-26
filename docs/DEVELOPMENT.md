# Development

## Requirements

- Node.js 22.13 or newer
- npm 10.9 or newer
- Tippecanoe only when rebuilding CDMX PMTiles

Use the repository's `.nvmrc` when working with nvm:

```sh
nvm use
npm ci
```

`npm ci` is preferred because `package-lock.json` is the reproducible dependency record.

## Daily workflow

Start the Vite development server:

```sh
npm run dev
```

Useful checks can also be run independently:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run every required check with `npm run check`.

## Engineering standards

- TypeScript is compiled with strict null checks, exact optional properties, unchecked
  indexed-access protection, and unused-code checks.
- ESLint uses the type-aware `strictTypeChecked` and `stylisticTypeChecked` rule sets.
- Type assertions and non-null assertions are prohibited. Narrow values or validate them
  instead.
- Untrusted JSON and MapLibre feature properties are parsed with Zod before use.
- Prettier owns code formatting.
- Code files may not exceed 1,000 lines. Prefer focused modules around 250 lines when a
  clean boundary exists.
- Avoid checking secrets, tokens, downloaded caches, `dist/`, or `node_modules/` into
  the repository.

The latest stable TypeScript supported by the current stable type-aware ESLint parser is
used. Upgrade TypeScript and `typescript-eslint` together after their peer ranges
overlap.

## Tests

The test suite uses Node's test runner through `tsx` so it exercises the TypeScript
source directly:

```sh
npm test
```

Tests cover street segmentation and access scoring, schedule-aware routing, CDMX data
classification, and circumference route invariants against the committed datasets.

When fixing a defect, add a regression test near the affected module. Tests may use
plain JavaScript fixtures, but production boundaries must still validate unknown data.

## Production preview

```sh
npm run build
npm run preview
```

The generated site is written to `dist/`. Vite also copies the committed data and
OpenFreeMap style snapshots into that directory.

## Updating dependencies

Update dependencies in a dedicated change:

```sh
npm outdated
npm update
npm audit
npm run check
```

Review major-version migration notes before updating. Never bypass peer-dependency
errors with `--force`; resolve the compatibility range instead.
