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

A separate merge audit removed eight fully covered cross-pairings at seven junctions,
including I-29/I-35 in Kansas City. It retained all 5,246 reciprocal connections and all
independent mainline attachments. Of the surviving geometry, 6,801 mainlines and 5,242
connector curves were unchanged; nine mainlines were rebuilt without the false junction
insertions, and four connector curves were recomputed. No changed curve gained a
reversal or self-intersection. The valid northern Kansas City ramp is exactly unchanged.
Source-road comparisons were reviewed at all seven affected junctions.

`scripts/fixtures/kansas-city-mainline-merge.json` exercises the source build and checks
the continuing midpoint geometry, both reciprocal movements, and the unchanged north
ramp. `scripts/fixtures/covered-mainline-merge-audit.json` records all eight removed
pairs, surviving mainlines, and supporting connections for tile regressions. The older
mixed-merge fixture retains the same source paths and parent mainlines; two curves are
updated for removed junction insertions, including a 9.2 m endpoint correction. These
checks cover fully supported redundant pairings, not every possible merge defect.

A subsequent direction audit traced all 5,246 published ramp pairs to their source
junctions. It rejected 275 pairs without opposing carriageway evidence at one or both
highway legs, including the southbound exit/entrance pair at I-435/MO-210 in Kansas
City. The matcher previously penalized such candidates but could still select them when
a valid return was absent. The same requirement now applies to established and inferred
pairs before ranking. Direct source-carriageway pairs preserve valid returns through
sharp bends; otherwise the local tangents must meet the mainline opposition threshold of
0.62. Borderline cases and the newly selected alternatives were reviewed against
source-road plots, including curved highways and ring roads where headings alone or
global source-chain identity would be misleading.

The rebuild retained all 4,971 other connector curves without changes and recovered 14
valid alternatives, for 4,985 reciprocal connectors. All 4,985 pass the source direction
audit and retain both mainline attachments. No changed mainline or new connector
acquired a reversal or self-intersection; this comparison removes duplicate consecutive
vertices before measuring bends. The eight earlier covered-merge removals remain in
place.

The existing source-topology ending rule trims three ramp-only tails farther after their
false pairings are removed. It retains one previously trimmed terminal that now serves
an unpaired exit. `scripts/fixtures/mainline-ending-audit.json` checks the six remaining
trims and that retained terminal; the total trimmed distance agrees with the rebuilt
source audit to within one millimetre.

`scripts/fixtures/i435-mo210-nonreciprocal.json` exercises the reported junction from
source roads. `scripts/fixtures/memphis-curved-carriageways.json` preserves a curved
I-40 return and verifies that removing it does not substitute an I-240 ramp using the
wrong travel side. `scripts/fixtures/nonreciprocal-ramp-audit.json` records the rejected
source paths and travel directions, 208 isolated witness points where tile regressions
can verify removal, all 14 recovered curves, and 12 retained curved returns with their
parent mainlines. The other 67 removed curves overlap surviving connector geometry too
closely for an isolated witness check; their exclusion is verified by source-path
identity in the rebuild audit. Two formerly positive attachment fixtures were
nonreciprocal and are now recorded in this rejection audit. The remaining attachment
fixtures retain their original geometry and parent mainlines, with only generated
connector IDs updated. These checks cover directional reciprocity, not every possible
interchange geometry defect.

The Jacksonville I-95/I-295 north interchange exposed a collector-selection gap: the
shorter north-to-east path and the longer collector path use the same return. The
initial matching pass consumed that return for the longer option, hiding the shorter
candidate from the later comparison. Matched movements now compare against all
compatible alternatives, including their own assigned return, without consuming paths
assigned to another movement. Each replacement strictly reduces mean ramp distance;
released paths can support further improvements. Disjoint reciprocal alternatives are
then consolidated as before.

The missing northwest return crossed two open `motorway_link` ways with residual
`construction=motorway_link` tags. The source edit history shows that the construction
highway class and access closure were removed when the ramp reopened
([source history](https://www.openstreetmap.org/way/943967900/history)). The ramp filter
now follows the active link class while still excluding explicit closures and the legacy
`construction=yes`. Mainline construction qualification is unchanged.
`scripts/fixtures/jacksonville-collector-interchange.json` preserves the source
junctions and tests all four movements in both source-way orders, the earlier northeast
join, and the absence of the northwest pair when its return is actually closed. The
selected northeast pair reduces mean directional ramp distance by approximately 619
metres.

The network audit also tests shortened collectors whose nearest projections can jump
back into an earlier loop. A forward-only closest-tangent retry must remove all backward
turns, improve the largest turn, and have no self-intersection. The four source-path
cases in `scripts/fixtures/short-collector-midpoints.json` preserve the directed ramps,
their mainline continuations, and exact attachments for those regression checks.

The rebuilt network contains 6,810 mainlines and 5,009 reciprocal connectors. Its audit
finds 57 shorter replacements sharing directed source segments in both directions; an
additional I-495/Dulles inferred pair uses a shorter return on the same two mainline
groups. There are 24 additional valid pairs. Of the retained source pairs, 355 midpoint
curves lose their backward projections, including 74 that previously self-intersected.
All 355 corrected curves have neither backward turns nor self-intersections. The 45
mainlines touched by attachment changes retain their source roadways and introduce no
new reversals or self-intersections. All 275 earlier nonreciprocal rejections remain
excluded, and the same six unsupported mainline tails remain trimmed.
`scripts/fixtures/collector-ramp-audit.json` checks the published curves and both
mainline attachments for 438 changed or relevant connectors, including all four
Jacksonville movements. The existing positive fixtures retain their curves except for
six source-verified shorter replacements; generated connector IDs are updated.

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

Clicking a final automatic region pins its details and exposes a custom offset menu.
Alternatives are whole-hour UTC offsets whose maximum skew across every longitude
interval is strictly below 45 minutes. The hierarchy still uses the inclusive 45-minute
subdivision rule; customization never changes boundaries, levels, or names. The default
choice and reset button restore the original minimax offset or UTC+0 fallback. Regions
with no eligible alternative explain that in the menu.

Custom offsets are keyed by source region ID and saved in browser local storage.
Restored choices are checked against the current final regions and their full extents;
obsolete or newly invalid choices are ignored. Fill colors, selected-point solar noon,
maximum region skew, and fallback counts all use the effective custom offsets.

Clock Skew's automatic option loads a content-hashed build asset generated from
`data/timezone-automatic-regions.json` only when selected. The browser runs
`assignAutomaticTimezones` against the recorded hierarchy; the offline builder uses the
same TypeScript calculation to prune unnecessary child geometry. Official seasonal and
historical settings do not affect these fixed offsets.

The snapshot records its assignment method, skew limit, and subdivision depth; the
browser validates them before resolving regions and rejects any selected region with
empty geometry. The production build verifies that its script references the hashed
asset and that its bytes match the checked snapshot. The unversioned data copy remains
available for existing clients, but new builds never request it. Query-string versions
were insufficient: an old ±30/60-minute page could fetch the new 45-minute hierarchy,
select a pruned parent as a leaf, and silently leave it blank. An open tab whose hashed
asset is no longer available offers **Reload map** instead of displaying a partial map.

Every polygon's original longitude interval is tested against all whole-hour UTC
meridians (15 degrees per hour). Choose the meridian that minimizes the largest absolute
skew across the entire region. **Subdivide only when this minimum maximum skew exceeds
45 minutes.** Exactly 45 minutes remains whole, as does any qualifying parent even when
its children could achieve a tighter fit. Ties minimize the absolute UTC offset, then
choose the lower offset. The shared UTC−12/UTC+12 meridian is represented as UTC+12.
Separate polygon intervals preserve islands on both sides of the date line without
treating the country as a nearly worldwide bounding box. The full interval matters,
including the polygon's interior, not only its vertices or centroid.

Natural Earth **1:10 million** country and subdivision boundaries provide the baseline;
these are generalized world-map outlines, not locally precise borders. Countries and
territories follow Natural Earth's country grouping; separately listed overseas
dependencies are evaluated separately. The pinned Debian `iso-codes` hierarchy groups
smaller units into their principal ISO regions (notably France, Spain, and Indonesia).
Boundary snapshots have different dates and some source ISO codes are historical.
Greenland and Kiribati use geoBoundaries first-level boundaries. Named first-level
administrative equivalents in French Polynesia and the French Southern Territories
retain source IDs because they have no individual ISO subdivision codes. Where
second-level units do not have ISO codes, their actual source identifiers are retained
without inventing ISO codes. Canada uses Statistics Canada's **2021 census divisions**,
not geoBoundaries' economic regions, including Manitoba when the 45-minute rule requires
it. China uses geoBoundaries' humanitarian **prefectures**, not the county-level units
in its open ADM2 dataset. Argentina, Australia, Brazil, Chile, Japan, Kazakhstan,
Norway, Russia, South Africa, and the United States use geoBoundaries' administrative
children. For principal ISO regions already assembled from smaller ISO units, those
units provide the second level: Scotland uses council areas and Kalimantan uses
provinces from the pinned Natural Earth/ISO snapshot. These retain their own ISO codes.

Mexico uses INEGI's detailed **2020 state boundaries**, distributed by geoBoundaries.
Its country footprint is the union of the same 32 states, so detailed borders and
islands are not clipped to a generalized Natural Earth coastline. State borders are
simplified as one shared-edge coverage at a 0.0001-degree tolerance, retaining all
polygon pieces and six-decimal coordinates. Validity and shared-edge coverage are
checked after rounding. This avoids gaps and overlaps from simplifying neighboring
states independently. The source incorrectly labels Distrito Federal as `MX-MEX`; the
builder corrects that pinned feature to `MX-CMX` / Ciudad de México, keeping it distinct
from the State of Mexico. Other countries still inherit their listed source's
resolution; inspection explicitly identifies Natural Earth's generalized outlines.

Second-level regions whose optimized maximum skew still exceeds 45 minutes receive
UTC+0. Unavailable child boundaries and uncovered land between boundary datasets are
**separate data fallbacks**, also temporarily UTC+0, and are named in the interface. No
artificial subdivision is presented as an ISO unit. Antarctica, in particular, has no
ISO subdivision hierarchy. Source polygons are intersected with their parent footprint
for display, but their original, unsimplified extents determine eligibility. Overlapping
longitude intervals are merged without changing their coverage. General display
simplification is 0.001 degrees, with five-decimal coordinates. Polygon pieces below
1e-7 square degrees are omitted from display, retaining the largest piece for tiny
regions; every original island still participates in the calculation. Coverage-gap
strips use non-topological display simplification. Numerical overlay dust below 1e-10
square degrees is discarded. Mexico uses the shared-edge processing described above
instead. The same display polygons drive border lines, color triangulation, and hover
selection. MapLibre's GeoJSON simplification uses a subpixel tolerance of 0.1 and the
tile source refines through zoom 18, retaining detailed edges at local zooms while
keeping world-view lines inexpensive to draw.

The boundary source manifest lists every optional second-level file the preparer may
use; unrelated files in the cache cannot affect the result. Some regions still have no
usable next tier in these sources. In particular, geoBoundaries' open Algeria ADM2 file
repeats the first-level provinces, while its ADM3 file and humanitarian ADM2 file
contain communes. Neither supplies the intervening district tier needed for Tamanrasset,
as distinguished in the
[official commune/daïra/wilaya directory](https://www.interieur.gov.dz/index.php/fr/component/annuaires/annuairecommunes.html?start=340),
so that region retains the explicit missing-subdivisions fallback. Greenland and the
Tuamotu Archipelago also retain missing-tier fallbacks where required.

The source manifest in `scripts/automatic-timezone-sources.json` pins download URLs,
SHA-256 digests, source names, and licenses. Natural Earth is public domain; the other
boundary files retain their listed Statistics Canada, ODbL, CC BY, or CC BY-SA terms.
Those data licenses are separate from this repository's MIT code license. The browser
dataset embeds the source manifest, and the map credits the source providers.

Each terminal region also has an `Area/City` name, assigned **after** resolving the
country/first-level/second-level hierarchy. Naming does not change its borders, level,
longitude extents, or UTC decision. A place must have its center inside that region's
polygon and belong to the same source country grouping. A metro spanning multiple
regions only names the region containing its center: New York State is
`America/New_York`, while New Jersey is `America/Newark`. Ciudad de México retains
`America/Mexico_City`.

The primary gazetteer is Natural Earth's 5.1.2 populated places. Centers are ranked by
`POP_MAX`, its metropolitan population estimate. Non-UN entries where `POP_MAX` equals
the city-proper `POP_MIN` instead use the larger of that count and the source's LandScan
catchment estimates (`MAX_POP10`, `MAX_POP20`, `MAX_POP50`, `MAX_POP300`, `MAX_POP310`).
This accounts for places such as Newark whose `POP_MAX` alone is a city-proper count.
The population vintages and definitions vary; these are source estimates for naming, not
current census totals or a new delineation of metro boundaries. See
[Natural Earth's population methodology](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/).

If a region contains no primary place, the largest settlement in the pinned GeoNames
`cities500` snapshot supplies its name. Neighborhoods and abandoned/historical places
are excluded. These city-proper counts never compete against primary metro estimates.
GeoNames selections and primary places below 50,000 people are identified as settlement
fallbacks in the inspector. Regions with no matching populated place, including boundary
coverage gaps, receive an explicitly flagged `Etc/Geographic_name` identifier. A nearby
city outside the region is never borrowed. GeoNames data is
[CC BY 4.0](https://download.geonames.org/export/dump/).

Names use the selected center's IANA geographic area prefix, not its official timezone
city or UTC rules. Spaces become underscores, and names use the source ASCII spelling.
Population ties resolve by ASCII name, then source ID. Homonyms receive an
administrative suffix; a matching existing `Area/City` keeps its bare name. These unique
identifiers describe the simulation and are not additional IANA timezones. The inspector
retains the administrative name, level, calculated offset, naming basis, population, and
source.

The committed `scripts/data/automatic-timezone-places.json.gz` contains both verified
gazetteers (about 5.3 MiB). It is an offline build input and is not shipped to browsers;
the runtime dataset includes only each selected name and its provenance. To regenerate
the snapshot from `populated-places.geojson` and `cities500.zip` in a local source
cache:

```sh
python3 scripts/prepare-automatic-timezone-places.py /path/to/source/cache
```

The preparation script verifies both source SHA-256 digests and writes deterministic
gzip output. GeoNames' download URL changes over time; refreshing its snapshot requires
an intentional checksum and snapshot-date update. Normal region rebuilds use the
committed gazetteer and do not download the rolling GeoNames export.

To rebuild (Python 3.13 or newer):

```sh
python3 -m venv /tmp/automatic-timezones-venv
/tmp/automatic-timezones-venv/bin/pip install -r scripts/automatic-timezone-requirements.txt
AUTOMATIC_TIMEZONE_PYTHON=/tmp/automatic-timezones-venv/bin/python npm run build:data:timezone-automatic
```

The builder downloads verified inputs to the ignored `data/.automatic-timezone-cache/`
directory. Preparation can take several minutes for the detailed Canadian and Russian
coastlines. Normal application builds use the committed runtime dataset and require
neither Python nor boundary downloads. Changes to the subdivision rule require full
boundary preparation, because a previously passing parent may now need children that
were omitted from the old prepared hierarchy. Do not use `--use-prepared` for a rule
change.
