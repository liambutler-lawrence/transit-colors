# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Color watersheds by their receiving sea or ocean, with a named legend and
  receiving-body details.

- Added a North America Watersheds mode with optional terrain shading, basin colors, and
  basin inspection.

- Added a Jersey City Land Use mode that distinguishes vacant industrial land, active
  industry, auto-oriented retail, modern and historic mixed use, non-retail towers,
  housing, civic land, and other parcels, with zoning and historic overlays.

### Fixed

- Connect all 32 reviewed Greenbrier-area source polygons to the Mississippi basin using
  WVDEP mapped underground routes and documented regional drainage, removing the
  remaining internal unresolved divisions.

- Dissolved watershed polygons sharing the exact same terminal node across North
  America. The eleven Baja source basins now form four basins; internal outlines and
  overlapping upstream-area totals no longer inflate the displayed groups. Basin details
  now identify the terminal node, and the marker is explained as a modeled endpoint
  rather than a lake’s deepest point.

- Joined the two Culverson Creek surface basins to the Mississippi using documented
  underground drainage, removing their internal outlines. Surface sinks without reviewed
  connections now say “Underground drainage unresolved” instead of claiming no ocean
  outlet.

- Refresh the Circumference distance-gradient image from its rendered canvas so the
  Gradient layer toggle controls visible map pixels.
- Accept unavailable NYC street histogram and street-count metadata without blocking
  Street Gradient or Circumference initialization.

### Changed

- Replaced watershed sub-basins with whole drainage systems using HydroSHEDS v2’s
  roughly 30 m source grid. Tributaries sharing a terminal outlet are dissolved, outlet
  locations can be inspected, and ambiguous coastal units are left uncolored. Source
  resolution is distinguished from an unverified 100 m accuracy target.

- Moved production delivery to a checked, GitHub-Actions-only Vercel deployment for
  `maps.liambutlerlawrence.com`, with digest-based uploads for large map archives.
- Restricted production artifacts to reviewed runtime data instead of copying raw data
  sources and download caches.
- Migrated browser and algorithm code to strict TypeScript.
- Added Zod validation at network and renderer boundaries.
- Added strict, type-aware ESLint and Prettier configuration.
- Split oversized application, routing, circumference, and data-builder modules.
- Preserved official GTFS track-centerline routing, straight-edge comparison, and
  complete eligible-line overlays during the TypeScript migration.
- Added reproducible Vite builds, CI, GitHub Pages deployment, and open-source
  contributor documentation.
