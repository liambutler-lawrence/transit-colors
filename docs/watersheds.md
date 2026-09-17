# North America watersheds

Open `?product=watersheds` (optionally `&watershed-level=4`, `6`, or `8`). Choose a
boundary level, toggle basin colors or hillshade, and click a polygon to inspect its
area and drainage attributes. Colors distinguish polygons; they do not encode a measured
quantity. Outlines include coasts. Selection works with colors disabled. The detail
level is retained in shareable URLs.

## Data and methodology

The app ships **HydroBASINS v1c standard polygons** at Pfafstetter levels 4, 6, and 8,
combining the North/Central America (`na`), Arctic North America (`ar`), and Greenland
(`gr`) archives. This includes Alaska and Caribbean islands. Boundary tiles are loaded
on demand, only for the selected level and viewport.

HydroBASINS delineates drainage units from HydroSHEDS flow-direction grids, derived from
hydrologically conditioned elevation data. It subdivides drainage networks into
tributary catchments and intervening areas, with special treatment for islands, inland
sinks, and grouped coastal catchments. This release reuses that published delineation
rather than deriving new watersheds in the browser.

The source grid is **15 arc-seconds (approximately 500 m at the equator)**; north of
60°N the underlying elevation model is coarser. Higher Pfafstetter levels yield smaller
catchments, not a finer DEM. These are regional hydrology boundaries, not parcel-scale
or engineering delineations. Some polygons within lakes follow modeled drainage rather
than physical divides. A downstream ID may represent a virtual connection at an inland
sink; inspect the drainage label.

Mapzen/Tilezen Terrarium terrain tiles provide optional hillshade. They are a separate
visual context layer, not the DEM used to generate these boundaries. No elevation API
key is needed. If terrain requests fail, the boundary layer remains usable. Map labels
come from the existing OpenFreeMap basemap.

## Rebuild

Install `tippecanoe`, `curl`, and Python 3 with `pyshp==2.3.1`, then run:

```sh
python3 scripts/build-watersheds.py
```

`WATERSHED_CACHE` optionally overrides `/tmp/transit-watersheds`. The builder downloads
official archives, retains original IDs and area values, checks ID uniqueness, and
generates zoom 0–9 PMTiles with shared-border simplification. Feature and tile-size
limits are disabled to avoid silently dropping basins.
`data/north-america-watersheds-summary.json` records original archive URLs, SHA-256
checksums, feature counts, coverage areas, and output sizes. Geometry is simplified and
quantized for display; reported areas are source attributes, not measurements from the
simplified map polygons.

## Sources, license, and attribution

- [HydroBASINS official downloads and license information](https://www.hydrosheds.org/products/hydrobasins).
- [HydroBASINS technical documentation v1c](https://data.hydrosheds.org/file/technical-documentation/HydroBASINS_TechDoc_v1c.pdf).
- Lehner, B., Grill, G. (2013). Global river hydrography and network routing: baseline
  data and new approaches to study the world's large river systems. _Hydrological
  Processes_, 27(15), 2171–2186. [DOI](https://doi.org/10.1002/hyp.9740).
- HydroBASINS is © WWF and distributed under the HydroSHEDS license, linked from the
  product page. That data license applies to the derived boundary tiles; the
  repository's MIT license applies to code, not source datasets.
- [Terrain tiles on AWS](https://registry.opendata.aws/terrain-tiles/) and
  [terrain source attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Verification

`npm run check` validates the app and checks shipped tiles for all levels, continental
coverage, region metadata, schema-valid drainage attributes, and consistent total area
through the hierarchy. Browser checks additionally cover direct links, level switching,
selection, colors-off hit testing, terrain visibility, switching to other products, and
compact controls.
