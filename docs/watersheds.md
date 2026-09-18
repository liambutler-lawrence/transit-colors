# North America primary watersheds

Open `?product=watersheds`. Each polygon joins the catchments belonging to one complete
drainage system. The Mississippi, Missouri, Ohio, and their tributaries share one
polygon; tributary boundaries are removed. Click a basin to inspect its area, the number
of joined catchments, and its terminal stream. **View terminal outlet** takes you to the
orange outlet marker. Selection also works with colors off.

## Scope and accuracy

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

Each main basin has exactly one terminal **modeled** outlet. This is a D8 network: real
deltas and bifurcations can have multiple physical mouths. Inland sinks are retained as
separate gray drainage systems, with no claimed ocean exit. Terminal types are checked
against the matching full-resolution flow-direction raster; ambiguous results remain
gray and explicitly unverified.

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
terminal cell within land is an inland sink. Conflicting, cross-block, long, or
unresolved traces remain unverified. This classification does not alter boundaries.

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
composite exclusion, source-lattice validation, and ocean/inland/ambiguous D8 cases
without network access. `npm run check` additionally verifies the shipped archive,
checks that five Mississippi tributary locations share one primary basin, separates
neighboring major systems, identifies the Great Salt Lake inland sink, and compares 64
full-detail tile boundary points with their pre-tiling source coordinates. Those sampled
comparisons validate display fidelity, not absolute terrain accuracy.

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
