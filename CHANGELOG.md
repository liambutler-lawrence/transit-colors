# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

- Refresh the Circumference distance-gradient image from its rendered canvas so the
  Gradient layer toggle controls visible map pixels.
- Accept unavailable NYC street histogram and street-count metadata without blocking
  Street Gradient or Circumference initialization.

### Changed

- Migrated browser and algorithm code to strict TypeScript.
- Added Zod validation at network and renderer boundaries.
- Added strict, type-aware ESLint and Prettier configuration.
- Split oversized application, routing, circumference, and data-builder modules.
- Preserved official GTFS track-centerline routing, straight-edge comparison, and
  complete eligible-line overlays during the TypeScript migration.
- Added reproducible Vite builds, CI, GitHub Pages deployment, and open-source
  contributor documentation.
