# Data sources and rebuilds

The committed `data/` directory makes local development and deployment deterministic.
Rebuild data only when intentionally refreshing a source snapshot.

## Sources

- OpenStreetMap contributors through the Overpass API
- Mexico City open-data GTFS
- MTA, NJ Transit, and PATH static GTFS feeds
- MARTA static GTFS
- OASA / STASY static GTFS
- LTA DataMall-derived Singapore rail data and station codes
- Official AIFA and Servicio de Transportes Eléctricos station references
- Natural Earth 1:10m land polygons
- Natural Earth 1:10m North America roads supplement
- timezone-boundary-builder `timezones-now` boundaries derived from OpenStreetMap
- Jersey City Division of City Planning parcel, zoning, redevelopment-plan, and
  historic-district feature services

Review each source's terms before redistributing a new snapshot. Preserve the in-app
attribution whenever adding a source.

## CDMX

Install Tippecanoe, then run:

```sh
npm run build:data:cdmx
```

The builder classifies rapid-transit station candidates, excludes generic bus terminals,
separates open and future stations, scores street access, and creates the browser-facing
PMTiles archive.

To rebuild only derived files from checked-in source GeoJSON:

```sh
npm run build:data:cdmx:derived
```

## NYC

```sh
npm run build:data:nyc
```

The builder combines subway, PATH, commuter rail, light rail, and regional GTFS feeds
inside the configured metropolitan bounds.

## Singapore, Atlanta, and Athens

```sh
npm run build:data:additional
```

The shared builder streams large GTFS stop-time tables, filters to rail routes, and
creates line-specific platform nodes with explicit paid-area transfers. Individual
refresh commands are also available as `build:data:singapore`, `build:data:atlanta`, and
`build:data:athens`.

Singapore's current snapshot is corrected against LTA's station-code topology because
its derived GTFS omits interchange calls from trip sequences. It includes the Circle
Line Stage 6 stations opened on 12 July 2026 and uses LTA's published operating span and
frequency guidance. The smaller shape-bearing snapshot supplies physical centerlines for
older segments; newer sections explicitly retain straight fallback geometry.

## Schedules

```sh
npm run build:data:schedules
```

Schedule files compress published departures into recurring weekday service windows and
headway estimates. Set `REFRESH_GTFS_CACHE=1` to replace downloaded GTFS caches.

## Track geometry

After the schedule and station snapshots are current, run:

```sh
npm run build:data:tracks
```

The builder reads official GTFS trip shapes from the local feed cache, extracts
station-to-station observations, resamples them to a common interval, and averages
distinct directions or track sides. Centerlines retain exact platform coordinates as
their endpoints and fall back to a straight edge when no reliable shape section exists.

`npm run build:data` refreshes all five metro areas, schedules, track geometry, clock
skew, circumference results, and Jersey City land use in the required order.

## Jersey City land use

Install Tippecanoe, then run:

```sh
npm run build:data:land-use
```

The builder downloads the current official Jersey City parcel, zoning, and historic
district feature layers, spatially joins their public attributes, assigns each parcel a
deterministic visualization category, and writes `data/jersey-city-land-use.pmtiles`. It
also writes `data/jersey-city-land-use-summary.json` with source timestamps and category
totals. Owner names and other personal fields are not included.

Categories combine tax class, building description, zoning or redevelopment-plan
context, construction year, stories, and historic-district membership. “Vacant” means
the parcel is recorded in the vacant-land tax class; it does not establish abandonment,
contamination, code status, or redevelopment eligibility. Auto-oriented retail and tower
categories are heuristic descriptions intended for exploration. Consult the
[official Jersey City zoning map](https://experience.arcgis.com/experience/63717e4171904651a65fe9827fcb5571/)
and source records for legal or site-specific decisions.

## Circumference routes

After station, schedule, and track snapshots are current, run:

```sh
npm run build:data:circumference
```

This writes the complete display networks and offline-proven maximum-area routes for all
loop-forming areas, including every distinct weekly segment-level service topology
derived from the published route-direction schedule windows. Express stop-to-stop
service is normalized across the physical track segments it traverses. The exact
optimizer reuses a superset certificate whenever its winner remains valid and solves
only the reduced topologies that need a different winner. It may take several minutes
for NYC. That cost is intentionally paid only during a data refresh; the browser loads
the committed results directly.

MARTA Rail is a branched cross without a geographically meaningful closed passenger
route. Its full network is still published and rendered in Circumference Lab with an
explicit no-loop result.

## North American controlled-access highways

Install `osmium-tool` and `tippecanoe`, then download the current Geofabrik motorway
extracts for Canada, Mexico, and every United States region:

```sh
scripts/download-osm-highways.sh
```

The script merges and filters those extracts into the ignored
`data/.osm-highway-cache/north-america-motorways.osm.pbf`. Download and extract Natural
Earth 5.1.1's 1:10m land shapefile, then build the continental result:

```sh
npm run build:data:highways -- \
  data/.osm-highway-cache/north-america-motorways.osm.pbf \
  data/north-america-highway-circumference.json \
  data/north-america-highways.pmtiles \
  /path/to/ne_10m_land.shp
```

This is a network-wide detailed build, not a local precision override. It requires OSM
`motorway`, a separated one-way carriageway, and at least two lanes where an explicit
lane count exists for each mainline. Opposing carriageways are paired locally and their
geodesic midpoint is sampled every 50 meters. One-lane motorway branches and
`motorway_link` ways remain separate connector edges; ordinary traffic signals
invalidate a connector while ramp meters do not.

Wide separations are continued only when the same opposing source chain is confirmed at
both ends of the gap and remains the closest eligible partner from both sides. If local
closest-point matching reverses along a bend or exceeds the original 2 km width bound,
an ordered correspondence follows both complete source sections, each bounded to 25 km.
Its allowed width derives from the shorter source span. A dynamic program minimizes
integrated separation while advancing monotonically along both roads and respecting
their travel tangents. Source matching uses 10 m samples; monotone interpolation removes
sampling steps before taking WGS84 midpoints. Both the matches and the resulting curve
must stay between the source roads, with no backtracking or self-crossings. Existing
mainline and ramp geometry is resolved first, and each addition attaches to the final
existing endpoints.

The wide-gap audit examined 89 previously rejected gaps with the same source partner on
both sides. The committed `scripts/fixtures/ordered-carriageway-gap-audit.json` records
the retained repairs and their shared endpoints; the tile regression verifies each
repair's interior and both connections. The Monteagle I-24 source fixture also checks
continuity and containment in either input ordering. Gaps with competing roads, missing
directional support, reversed source bounds, or no valid contained ordered
correspondence remain rejected. All 6,797 existing mainline geometries and 5,003
reciprocal ramps were preserved. This audit covers bounded gaps between established
pairs; other types of source network discontinuity require separate checks.

The route graph preserves every original OSM node identity. Mainline sides are mapped
onto the sampled centerline, and a ramp may attach only through its exact source mapping
to that mainline. The attachment search can span an early carriageway split, but only
for that source-mapped endpoint; a bridge, tunnel, or other coordinate-only crossing
therefore cannot become an intersection.

After reciprocal ramps are attached, every displayed mainline end is audited against
both source carriageways. If both terminate exclusively in different, already
represented `motorway_link` movements, the common mainline stops at its outermost
existing ramp attachment. A reciprocal movement using both terminal sides, an
unrepresented exit, a mainline continuation, or another mainline junction prevents
trimming. This removes redundant tails even when the physical pavement remains parallel
beyond the split. Ramp geometry and attachment coordinates are preserved.

The September 2026 audit checked 13,594 ends and removed seven tails totaling 1,429.7 m,
including the 443.4 m tail north of Morelia. The recorded source nodes and retained
attachments are in `scripts/fixtures/mainline-ending-audit.json`; the tile regression
checks every recorded location. `scripts/fixtures/morelia-interchange.json` exercises
the complete build from source roads. These checks cover terminal support and
connectivity; they are not a visual certification of every interchange's ramp curves.

The continental boundary is assembled directly on the detailed biconnected graph. A
northeastern cycle is routed through Highway 407, Ottawa, Québec, and coastal New
England; independent node-disjoint perimeter ears then add I-495 in southeastern
Massachusetts and the southern/western continental arc. Tiny hooks created where two
consecutive averaged centerlines overshoot their shared graph junction are clipped at
their mutual intersection. This clipping never spans nonadjacent edges and never creates
a new junction. Every nonlocal proper crossing still forbids the responsible corridor
and triggers another detailed routing attempt. Absolute-area and explicit
407/Ottawa/I-495 coverage thresholds reject both self-intersecting and silently
truncated output; the previous output file is not used as its own regression guide.

The committed JSON contains the segmented thick winning route, source attributes, and
WGS84 land-contained and coastward areas. The complete thin network is stored separately
as PMTiles so the browser can stream only the visible zoom tiles.

## Landmasses

After downloading and extracting Natural Earth 5.1.1 `ne_10m_land.shp`:

```sh
npm run build:data:landmasses -- /path/to/ne_10m_land.shp
```

The result includes the masks and measured areas used by Circumference Lab. Landmass
totals and clipped route coverage use WGS84 ellipsoidal area; the clipping workspace
uses a local equal-area transform rather than Web Mercator.

## Clock skew

```sh
npm run build:data:timezone-skew
npm run build:data:timezone-countries
```

The builder downloads timezone-boundary-builder's version-pinned `timezones-1970`
archive and the matching IANA tzdata release, verifies both SHA-256 checksums,
simplifies the post-1970 timekeeping regions for browser rendering, compiles the IANA
source with `zic`, and writes `data/timezone-skew-zones.geojson`. To rebuild from
already downloaded archives, pass the output and both source paths explicitly:

```sh
node scripts/build-timezone-skew-data.mjs \
  data/timezone-skew-zones.geojson \
  /path/to/timezones-1970.geojson.zip /path/to/tzdata2026c.tar.gz
```

The boundary snapshot is derived from OpenStreetMap and remains subject to ODbL; both
upstream releases, source URLs, checksums, and the boundary license are recorded in the
generated file. The committed IANA 2026c rule table covers 1970 through 2037, so runtime
results do not depend on the browser's bundled timezone release. The current-year
selector groups every recurring or one-off UTC-offset transition into ranges with a
unique global pattern. The historical selector groups one-off standard-offset changes
into eras, while paired recurring daylight-saving reversals are excluded. Solar noon is
then derived directly from longitude for the selected range:
`12:00 + UTC offset − longitude × 4 minutes per degree`.

The country-timezone simulator uses a separately generated Natural Earth 1:50m Admin 0
snapshot. Its builder pins the upstream commit and checksum, keeps only country names,
codes, and simplified polygons, and records Natural Earth's public-domain status in
`data/timezone-skew-countries.geojson`. To rebuild from a downloaded source:

```sh
node scripts/build-timezone-country-data.mjs \
  data/timezone-skew-countries.geojson /path/to/ne_50m_admin_0_countries.geojson
```

## Validation

After any data refresh:

```sh
npm test
npm run build
git diff --stat data
```

Inspect unexpectedly large changes, station-count changes, source metadata, and route
invariant failures before committing the snapshot. Never commit `.gtfs-cache` or
`.overpass-cache`.

## Automatic time-zone regions

Clock Skew's automatic option loads `data/timezone-automatic-regions.json` only when
selected. The browser runs `assignAutomaticTimezones` against the recorded hierarchy;
the offline builder uses the same TypeScript calculation to prune unnecessary child
geometry. Official seasonal and historical settings do not affect these fixed offsets.

Every polygon's original longitude interval is tested against whole-hour meridians (15
degrees per hour). Every interval must fit **strictly** inside ±30 minutes; if none
qualifies, try **strictly** inside ±60 minutes before subdividing. Exact boundary
equality fails that test. A passing parent always remains whole, even when its children
could achieve a tighter fit. Of multiple passing meridians, minimize the largest
absolute skew, then minimize the absolute UTC offset, then choose the lower offset. The
shared UTC−12/UTC+12 meridian is represented as UTC+12. Separate polygon intervals
preserve islands on both sides of the date line without treating the country as a nearly
worldwide bounding box. The full interval matters, including the polygon's interior, not
only its vertices or centroid.

Natural Earth 1:10m country and subdivision boundaries provide the baseline. Countries
and territories follow Natural Earth's country grouping; separately listed overseas
dependencies are evaluated separately. The pinned Debian `iso-codes` hierarchy groups
smaller units into their principal ISO regions (notably France, Spain, and Indonesia).
Boundary snapshots have different dates and some source ISO codes are historical.
Greenland and Kiribati use geoBoundaries first-level boundaries. Named first-level
administrative equivalents in French Polynesia and the French Southern Territories
retain source IDs because they have no individual ISO subdivision codes. Where
second-level units do not have ISO codes, their actual source identifiers are retained
without inventing ISO codes. Canada uses Statistics Canada's **2021 census divisions**,
not geoBoundaries' economic regions. China uses geoBoundaries' humanitarian
**prefectures**, not the county-level units in its open ADM2 dataset. Chile, Norway,
Russia, and the United States use geoBoundaries' administrative children.

Second-level regions that still fail both tests receive UTC+0. Unavailable child
boundaries and uncovered land between boundary datasets are **separate data fallbacks**,
also temporarily UTC+0, and are named in the interface. No artificial subdivision is
presented as an ISO unit. Antarctica, in particular, has no ISO subdivision hierarchy.
Source polygons are intersected with their parent footprint for display, but their
original, unsimplified extents determine eligibility. Overlapping longitude intervals
are merged without changing their coverage. Display simplification is 0.012 degrees,
with five-decimal coordinates. Polygon pieces below 1e-5 square degrees are omitted from
display, retaining the largest piece for tiny regions; every original island still
participates in the calculation. Coverage-gap strips use non-topological display
simplification. Numerical overlay dust below 1e-10 square degrees is discarded.

The source manifest in `scripts/automatic-timezone-sources.json` pins download URLs,
SHA-256 digests, source names, and licenses. Natural Earth is public domain; the other
boundary files retain their listed Statistics Canada, ODbL, CC BY, or CC BY-SA terms.
Those data licenses are separate from this repository's MIT code license. The browser
dataset embeds the source manifest, and the map credits the source providers.

To rebuild (Python 3.13 or newer):

```sh
python3 -m venv /tmp/automatic-timezones-venv
/tmp/automatic-timezones-venv/bin/pip install -r scripts/automatic-timezone-requirements.txt
AUTOMATIC_TIMEZONE_PYTHON=/tmp/automatic-timezones-venv/bin/python npm run build:data:timezone-automatic
```

The builder downloads verified inputs to the ignored `data/.automatic-timezone-cache/`
directory. Preparation can take several minutes for the detailed Canadian and Russian
coastlines. Normal application builds use the committed runtime dataset and require
neither Python nor boundary downloads.
