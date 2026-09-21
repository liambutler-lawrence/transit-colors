# Government-seat freeway connections

The highway map's government-seat layer includes blue freeway routes using the same
mainline widths, white casing, and reciprocal-ramp dashes as the circumference. Each
route ends at the first intersection with its seat's WGS84 5 km radius circle. The extra
approach shows access to the opposite direction of the circumference. The layer is
static GeoJSON: no pathfinding or geometry generation runs on pan or zoom.

## Eligibility and routing

The subdivision must contain part of the published circumference. A circle already
intersected by that circumference receives no additional route. Subdivision polygons
come from Natural Earth 5.1.1's public-domain 1:10 million admin-1 data; Mexico City's
older `MX-DIF` identifier is mapped to the catalog's `MX-CMX`. Country membership also
follows the circumference's country inventory, preventing coarse border polygons from
assigning a border-adjacent US highway to Mexico.

The build reads the same original OSM motorway extract and current paired-mainline,
reciprocal-ramp, express-lane, and turn-port rules as the circumference builder. It
retains the full source graph, including branches removed by the circumference solver's
two-core reduction. It does not inspect rendered tiles to infer connectivity. Published
circumference segments must match the graph before connections are generated.

Shortest paths use WGS84 distance, without the circumference optimizer's connector
penalty. The search state includes the incoming edge, so a ramp cannot be entered by
reversing across a median. Matching map coordinates never create junctions. Both legal
approaches must lead into a common outgoing mainline at the joining interchange. The
circumference may itself turn there: one approach can be a straight continuation while
the other uses a reciprocal ramp pair.

Circle clipping minimizes ellipsoidal distance on each road segment and bisects its
first entry. This also detects a segment with both endpoints outside the circle that
crosses the circle between them. The building coordinate is not used as a road endpoint.

## Rebuilding and auditing

With `osmium` available and the same source PBF as the circumference:

```sh
npm run build:data:government-connections
```

The full-source cache is fingerprinted against the source extract and geometry and turn
algorithms. It is distinct from the old circumference cache. Generated connection
metadata records the circumference hash, individual subdivision status, both approach
directions, source road IDs, and circle-entry coordinates. The unrestricted shortest
distance is retained for comparison with the route requiring both directions; this
identifies missing-pair cases for source-topology review.

Runtime status data excludes this larger audit inventory. Clicking a blue route or
government marker shows its status and, where eligible, the distance to the circle. The
government-seat visibility toggle controls circles, markers, and their routes and hides
them outside highway mode.

## Current source audit

The published circumference traverses 32 catalog subdivisions. Ten government-seat
circles are already reached; 21 receive connections. Florida has no eligible
source-graph route entering its circle. These are dataset results, not a claim about
roads constructed after the source extract.

All 1,520 circumference source corridors were recovered as a closed, turn-valid cycle,
covering all 292,363 nonzero displayed segments with zero boundary-junction anomalies.
All 21 connection endpoints are within one centimetre of the WGS84 5 km radius, and each
pair of approaches converges at the same source junction.

The joining-interchange candidate search permits up to 10 km of receiving-mainline
continuation and 20 km along the circumference between approach anchors. It does not
traverse a second ordinary ramp corridor; source-proven through-mainline or
mixed-mainline continuations remain eligible even when rendered as connectors. These
bounds are discovery limits, not proof of interchange identity. The selected pairs were
reviewed against their source paths; their circumference anchors are less than 5 km
apart. The unrestricted one-direction search also checks for shorter candidates that a
missing or misrepresented approach might otherwise hide.

Three cases required particular source review:

- **Delaware:** the I-95/DE-1 approaches include a source-proven mainline continuation
  represented as a connector. Preserving that continuation produces the 61.0 km shortest
  connection without treating it as another interchange.
- **Ontario:** the east-401/south-DVP reciprocal pair was missing from the derived graph
  because the two directional paths attached to overlapping DVP mainline fragments.
  `government-connection-source-recoveries.json` records both actual directed source
  paths, their road and node IDs, the source fingerprint, and the closest-tangent
  midpoint. Every one of its 72 directional segments was checked against the original
  OSM directed road edges, including continuation to the staggered mainline join. Only
  the specified parent mainlines may receive the recovered endpoints. A source change
  requires a fresh audit. This produces the 10.2 km shortest connection, including the
  west-401 approach at the same 401/DVP interchange. It does not change the published
  circumference.
- **Mississippi:** the unrestricted 252.6 km candidate uses I-55/I-10 at LaPlace, which
  lacks the required direct connection for the other direction. The chosen 266.0 km
  connection uses I-10/I-12 at Baton Rouge. The source topology is consistent with the
  [original I-55 southbound road photographs and access description](https://www.aaroads.com/guides/i-055-south-laplace-la).

The recovered Toronto path can be checked against the original PBF independently:

```sh
node --max-old-space-size=8192 --import tsx scripts/verify-government-source-recoveries.mjs
```

Subdivision polygon provenance:
[Natural Earth admin-1 states and provinces](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/),
[version 5.1.1 source GeoJSON](https://github.com/nvkelso/natural-earth-vector/blob/v5.1.1/geojson/ne_10m_admin_1_states_provinces.geojson).
The 1:10 million boundaries are appropriate for this continental eligibility inventory
but are not cadastral boundaries; border-adjacent future route changes need review.
