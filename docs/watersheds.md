# Worldwide primary watersheds

Open `?product=watersheds`. Catchments are grouped by modeled terminal outlet, with
reviewed groundwater connections and confirmed closed-lake systems joined. The
Mississippi, Missouri, Ohio, and their tributaries share one polygon; tributary
boundaries are removed. Click a basin to inspect its area, the number of joined
catchments, and its terminal stream. **View terminal outlet** takes you to the orange
outlet marker. Selection also works with colors off.

## North America: scope and accuracy

The source is **HydroSHEDS v2.0**, using its North America BAS beta catchment polygons
and RIV network. It derives drainage from hydrologically conditioned terrain on a **1
arc-second grid (approximately 30 m north–south)**. This replaces the former 15
arc-second HydroBASINS sub-basin hierarchy. Coverage includes North and Central America,
the Caribbean, Alaska, and Arctic Canada. Greenland is outside the v2 North America
release and is not filled using a different, coarser source.

**A 30 m source grid does not establish a 100 m positional error bound.** No such
accuracy guarantee is made. DEM errors, conditioning, flat terrain, lakes, glaciers,
culverts, and human alterations can move a modeled divide beyond 100 m. The BAS product
is beta. A guarantee at every point would require independent validation and local
corrections; hillshade cannot establish that guarantee.

Each displayed ocean-draining basin has one terminal **modeled** outlet. This is a D8
network: real deltas and bifurcations can have multiple physical mouths. Surface sinks
are retained in gray as **underground drainage unresolved**, not as confirmed endorheic
basins. A zero in a surface flow-direction raster does not prove that water cannot reach
the ocean. This conservative label also applies to genuinely closed basins until their
status is separately verified. Documented groundwater connections can join surface
basins to a downstream ocean-draining system.

HydroSHEDS aggregates some coastal catchments of at most 1 km² into composite units with
`STRM_ID = -1`. They do not establish a unique outlet. These units are omitted from the
colored watershed layer, leaving uncolored coastal gaps. They must not be represented as
valid primary watersheds. Completing them requires additional flow-grid delineation.
There is no minimum area filter on valid routed basins.

## Processing and reproducibility

Python dependencies: `numpy==2.4.3`, `pyogrio==0.12.1`, `pyarrow==23.0.1`,
`shapely==2.1.2`, and `rasterio==1.4.4`. Install `tippecanoe` for vector tiling. Source
archives and SHA-256 checksums are recorded in
`data/north-america-watersheds-summary.json`. Download and unpack the official BAS and
RIV FileGDBs into these directories beneath `WATERSHED_V2_CACHE` (default `/tmp`):

- `watersheds-v2-bas/north-america_BAS_1s_v2r0.gdb`
- `watersheds-v2-riv/north-america_RIV_1s_v2r0.gdb`

```sh
python scripts/prepare-watersheds.py
python scripts/build-primary-watersheds.py
python scripts/classify-watershed-outlets.py
python scripts/resolve-watershed-outlets.py
```

The builder joins `BAS.STRM_ID` to `RIV.STRM_ID`, groups by `RIV.MAIN_BAS`, checks that
each group has exactly one terminal stream, and follows **every** downstream chain to
that terminal. It verifies that downstream edges stay in the same main basin, and that
every routed catchment contributes exactly once.

Source polygon coordinates are snapped to their existing one-second lattice to remove
floating-point noise. Invalid polygon topology is repaired before a geometric union
removes internal catchment edges. Removing exactly collinear vertices does not change
boundary shape. Processing uses restartable SQLite intermediates outside the repository.
Changing the source or processing algorithm requires deleting those intermediates before
rebuilding.

The terminal classifier reads the matching DIR raster in native blocks and follows D8
directions locally near each vector endpoint. Flow into sea/nodata is coastal; a
terminal cell within land is a modeled surface sink (the intermediate cache calls this
`inland`; the shipped tiles use `unresolved_sink`). Conflicting, cross-block, long, or
unresolved traces remain unverified. That classification alone does not alter boundaries
or establish groundwater routing.

### Shared terminal nodes

`MAIN_BAS` alone is insufficient: different terminal river reaches can have different
basin IDs but end at the same `NODE_ID_DOWN`. The tiler groups by that verified node ID,
requires exact coordinate and drainage-class agreement, and dissolves each group on the
original lattice. It never groups nearby points or merely matching rounded coordinates.
The smallest source basin ID identifies the combined basin; source catchment counts are
summed once. The UI shows the terminal node ID and number of joined source basins.

There are 2,034 shared terminal-node groups in this release, all surface sinks. Their
upstream reach-area fields can overlap, so combined areas are recalculated from the
disjoint polygons in EPSG:6933 instead of summing those fields. The outlet marker
denotes a modeled endpoint, not a surveyed lake-bottom minimum.

In the Baja regression area, source groups `[92273, 92400, 92434]`,
`[92242, 92408, 92399]`, `[92450, 92412]`, and `[92352, 92568, 92477]` become four
basins at four terminal nodes. Their former internal outlines disappear. This fixes
grouping, without asserting that the surface sinks have no underground drainage.

### Reviewed groundwater connections

`data/north-america-watersheds-corrections.json` records source basin IDs, the expected
modeled sink coordinates, the downstream basin, evidence, and regression points.
`watershed_corrections.py` checks those identities, rejects duplicate/chained
assignments and overlapping polygons, then unions the source polygons into the receiving
basin on the original integer lattice. Shared boundaries and holes are removed, all
catchments are counted once, and the receiving ocean outlet is retained. Corrections
always start from the unmodified source GeoJSON; they are not cumulative between builds.

The West Virginia review now connects **32 source polygons at 17 modeled sinks**
(including the original Culverson correction) to Mississippi basin **72911**. Fifteen
sink groups are supported by matched paths in WVDEP's public
[WV Sunken Streams dataset](https://tagis.dep.wv.gov/arcgis/rest/services/WRPA_Web_GIS/Groundwater/MapServer/3).
These include Culverson, Buckeye, Sinking/Hughart, The Hole, Milligan/Davis Spring, and
Scott Hollow/Second Creek connections. Two further sink groups (three source polygons
near Lewisburg) use documented regional drainage in the
[2014 Milligan Creek/Davis Spring plan](https://dep.wv.gov/WWE/Programs/nonptsource/WBP/Documents/WP/MilliganCreek_WBP.pdf),
pp. 2–4, and Jones (1997), pp. 90–91, checked against official HUC12/HUC8 polygons. All
three lie wholly within the Greenbrier watershed; their modeled sink points lie within
the Milligan Creek–Greenbrier River unit. A small eastern part of 86641 crosses the
local HUC12 divide but remains in Greenbrier drainage. The regional records do **not**
claim an individual dye trace from each modeled sink cell.

Run `scripts/review-wv-watersheds.py` before tiling to reproduce the reviewed crosswalk.
It uses explicit reviewed terminal-node and trace-ID lists, checks each trace endpoint
against original basin geometry, follows chained groundwater paths, and validates
regional containment. Vendored WVDEP snapshots and SHA-256 hashes preserve the evidence.
It never assigns arbitrary sinks to their nearest river. Surface catchments can span
several intermediate groundwater routes; all reviewed routes reach the same ultimate
Mississippi outlet. The Scott Hollow route is also supported by the
[USGS 2023 Monroe County study](https://pubs.usgs.gov/publication/sir20235121/full).

The added area is calculated from disjoint polygons in EPSG:6933 rather than the
source's overlapping upstream totals. All 216 reviewed catchments are retained. These
edits establish primary-basin membership, not surveyed groundwater divides.

Shared-node grouping reduces 108,641 source basins to 105,575 terminal groups. The WV
connections join 17 groups to the Mississippi, yielding **105,558 displayed basins**,
preserving all 11,558,529 routed catchments. There are 103,348 modeled ocean-draining
basins and 2,210 unresolved surface sinks. Higher-resolution topography cannot by itself
resolve karst drainage.

Mapzen/Tilezen Terrarium tiles provide optional hillshade. They are a separate visual
reference, not the DEM used to delineate these basins. Failure of terrain requests does
not disable boundaries. Labels come from the existing OpenFreeMap basemap.

## Attribution

- [HydroSHEDS v2](https://www.hydrosheds.org/hydrosheds-v2) and
  [technical documentation](https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v2_0_0.pdf).
- Lehner, B., Roth, A., Huber, M., Anand, M., and Thieme, M. (2022).
  [A sharper look at the world’s rivers and catchments](https://doi.org/10.1029/2022EO220167).
- WWF / DLR / HydroSHEDS. The v2 data and derived tiles are licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the repository's MIT
  license applies to code.
- [Terrain source attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Vector tile precision

After the processing scripts finish, run `python scripts/tile-primary-watersheds.py`.
The full-detail tiles use zoom 10 with a 16,384-unit extent and **no line simplification
at maximum zoom**. This gives a maximum coordinate rounding distance of about 1.7 m in
Web Mercator (smaller ground distances away from the equator). Higher map zooms reuse
that geometry. Low-zoom overview tiles are simplified for readability; zoom in to
inspect divides. Feature-count and tile-size limits are disabled, and tiny polygons are
retained at full detail.

This tile-encoding bound is relative to the source geometry, not to the actual terrain.
The manifest records the grid, encoding settings, routing checks, counts, classification
results, source hashes, and final tile archive hash.

## Verification

`python scripts/primary-watersheds.test.py` exercises tributary dissolution, coastal
composite exclusion, source-lattice validation, and ocean/inland/ambiguous D8 cases and
groundwater union/area conservation and exact-node grouping without network access.
`npm run check` additionally verifies all eleven Baja source polygons map to four unique
terminal nodes, verifies the shipped archive, checks that five Mississippi tributary
locations share one primary basin, separates neighboring major systems, keeps unreviewed
sinks unresolved, verifies all 32 reviewed WV source polygons now select the Mississippi
outlet with no separate sink features, and compares 64 full-detail tile boundary points
with their pre-tiling source coordinates. Those sampled comparisons validate display
fidelity, not absolute terrain accuracy.

## Static hosting

The logical PMTiles archive is split into immutable files of at most 95 MiB to meet
GitHub and hosting file limits. Each filename includes the archive digest. The summary
manifest lists the parts in byte order, their sizes and hashes, and the combined archive
hash. The browser translates each PMTiles byte-range request into requests for the
required part or parts; it does not download the whole archive. The split changes
storage only, without dropping basins or changing geometry.

Tests verify reads crossing part boundaries, cancellation, truncated responses, all part
hashes, and the hash of the reassembled archive. The production build includes only the
current manifest’s parts.

### Receiving-body colors

`north-america-watersheds-exit-bodies.json` assigns every verified ocean-draining
primary basin a named receiving sea or ocean. The fill and selected-basin details use
the same lookup; neighboring basins remain distinct even when colors match. This
separate lookup avoids rebuilding or simplifying the detailed boundaries for a
cartographic change. Unknown and unresolved drainage stays gray.

Run `scripts/build-watershed-exit-bodies.py` with the watershed Python environment and
cached verified outlets to regenerate it. The script uses the vendored Natural Earth
1:10m marine areas from release v5.1.2 (public domain), selecting the smallest covering
marine polygon, or the nearest polygon for generalized coastline gaps. Explicit rollups
group smaller bays, estuaries and channels into regional receiving bodies. Hudson Bay
includes James Bay, Foxe Basin and Hudson Strait; Gulf of St. Lawrence includes the St.
Lawrence estuary. These are generalized cartographic categories, not surveyed marine
limits or changes to hydrologic routing.

## Worldwide extension: GRIT v1.0

Outside the existing HydroSHEDS North America layer, the map uses the Africa, Asia,
Europe, South America, Siberia, and South Pacific regions of
[GRIT v1.0](https://zenodo.org/records/17435232) (Wortmann et al., 2025,
[paper](https://doi.org/10.1029/2024WR038308)). Its terrain input is 30 m FABDEM, but
the published vector catchments are simplified. Neither that pixel size nor our tile
quantization establishes a 100 m positional-accuracy guarantee. Greenland's ice sheet
and Antarctica are outside the source's coverage.

We **do not dissolve by GRIT's connected component ID**: components can span multiple
river mouths and seas through canals and natural bifurcations. Instead,
`scripts/grit_routing.py` follows the source's `is_mainstem` branch at each bifurcation
(width, then stable ID, break ties), resolves a terminal node, and unions the associated
segment catchments. Each secondary outlet retains its own local contributing catchments.
This is a main-route partition, not a claim that all water follows only one physical
route. Cycles fail the build rather than being assigned invented outlets. Source
terminal types without a coastal/sink classification stay unverified.

Additional source sink polygons without a river-network outlet appear as gray surface
depressions with no fabricated outlet marker. They are not assumed to be endorheic.
Composite coastal polygons below GRIT's 50 km² stream-initiation threshold are omitted
because they can encompass multiple outlets. A source coastal endpoint assigned to the
Caspian Sea is labeled as a closed inland receiving body, not an ocean outlet.
Generalized Natural Earth marine areas supply receiving-body colors; they do not
determine divides.

The North American archive, groundwater corrections, terminal-node joins, and
receiving-body assignments remain independently versioned and unchanged.

### Rebuild the global extension

1. Install `numpy pyarrow pyogrio shapely pyproj rasterio` in a temporary Python
   environment and install `tippecanoe`.
2. Download `data/sources/grit-v1-files.json` into `/tmp/grit` (or `GRIT_CACHE`). Every
   archive has a pinned URL, size, and publisher-provided MD5 checksum.
3. Run `python scripts/global-watersheds.test.py` and
   `python scripts/build-global-watersheds.py`. Optional region arguments build regional
   checkpoints only. Remove `basins-*.json` checkpoints when changing routing or
   classification rules.
4. The script builds zoom 0–10 tiles with extent 16,384 at zoom 10, no additional
   maximum-zoom simplification, and immutable parts smaller than 100 MiB.
5. Run `npm run check` to verify routing fixtures, shipped tiles, and production asset
   integrity.

GRIT-derived `global-primary-watersheds-*.bin` files are **CC BY-NC 4.0**, not MIT. They
adapt the source by main-route grouping, dissolving, receiving-body labeling,
reprojection, and tiling. See `data/sources/GRIT-LICENSE.md`. Code retains the
repository's MIT license; source datasets retain their respective licenses.

`data/global-watersheds-outlet-reviews.json` records the Haringvliet terminal-type
review: GRIT calls that terminal node an inlet despite its having no downstream segment.
Rijkswaterstaat documents Rhine–Meuse discharge through those sluices to the North Sea.
This changes only its receiving-body classification, with the source node coordinate
checked; it does not alter routing or basin geometry.
