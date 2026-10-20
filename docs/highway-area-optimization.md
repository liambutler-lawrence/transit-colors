# Highway circumference area optimization

The objective is the largest WGS84 region enclosed by a legal closed route in the
eligible paired-direction freeway graph. Secondary loops are allowed in the search, but
their area never adds to that primary region. There are no required roads, cities,
geographic waypoints, or connector penalties.

The highway builder uses the interchange-port outer-boundary solver. It retains the full
midpoint source graph, then creates a separate solver view: each source-proven
interchange has distinct mainline approach ports and precomputed shortest legal
reciprocal movements. Those movements retain their actual ramp geometry and source turn
witnesses. The solver chooses external mainlines and legal interchange movements; it
does not search over individual ramp crossings. A missing movement cannot be
manufactured by reversing along another ramp. Mainlines crossing without ramps remain
separate roads.

Degree-two compression retains nodes where a mainline, ramp, or explicit merge changes
role. Every compressed source edge therefore has one road role; interchange construction
rejects a stale edge containing both mainline and ramp pieces. Mainline intervals cannot
be absorbed into an interchange merely because another part of their corridor is a ramp.

Opposing-carriageway selection preserves route refs per source segment. A pair whose
local known refs disagree needs a geometric witness elsewhere on those same two chains:
an eligible opposing segment pair with matching local refs. Collecting route names from
unrelated positions on each chain is insufficient. These actual paired-span witnesses
allow asymmetric tags at continuous route transitions, while rejecting a nearby branch
that never forms a locally compatible pair with the through carriageway. Missing refs
retain the existing geometric fallback. The deterministic 200 m ordered midpoint
calculation itself is unchanged.

Express and collector/distributor carriageways remain eligible ramp-path candidates.
Established, inferred, mixed and through-mainline ramp options compete before their
midpoints are drawn. For an auxiliary alternative, a shorter reciprocal option on the
same directed source carriageways wins when its departure and arrival lie inside the
longer option's source intervals. A direct general-lane merge has zero intervening ramp
distance and wins only when both source directions and the existing midpoint junction
are verified. Highway names or nearby coordinates alone never establish an alternative.

The solver planarizes external mainlines with geodesic subdivision, allowing only
same-road continuation at artificial contacts. It walks unrestricted faces for bounds
and branches on legal incident-road pairings where the relaxed boundary needs repair.
Multiple distinct approach pairs may pass through one logical interchange. The bound
uses the bounded planar regions plus conservative geodesic interchange footprint
envelopes; contracted node stubs never become final route geometry. Each candidate
expands to its stored source movements and is scored by its largest enclosed region. A
bounded cache avoids repeatedly polygonizing the same oriented candidate walk.

Graph construction, mainline planarization, and search have individual 30-second limits
and timing reports. Search checkpoints atomically preserve the incumbent and pending
alternatives. They are fingerprinted by graph contents, road roles, and implementation.
An incomplete search must not be labeled optimal or published. Final expanded source
turns are validated independently. The publication pipeline still guards its exported
single ring; secondary-loop export needs separate validation before a route containing
secondary loops can be published.

## Regeneration

Run the existing highway builder after reviewing a bounded trial:

```sh
npm run build:data:highways
npm run build:data:government-connections
```

The current highway build does not use the previous integer-programming backend.
Historical published datasets retain their original optimization-method tag until a new
route is proven, validated, and deployed. Geometry and completed results are cached by
source fingerprints. Government-seat routes must be regenerated when the selected
circumference or its underlying geometry changes.

## Local working-boundary preview

Set `HIGHWAY_UNRESTRICTED_PREVIEW=1` on the normal highway builder and pass explicit,
isolated JSON and PMTiles output paths. This mode requires an existing derived-network
cache and an existing network tile archive. It does not rebuild geometry, run the legal
search, read or write solver checkpoints, or overwrite the default published outputs. It
can reuse geometry from before the latest midpoint implementation changes; inspect the
cached input rather than treating the preview as a completed geometry rollout.

The solver still constructs its interchange graph, planarizes mainlines, propagates the
initial restrictions, and walks the initial faces. A linear stack walk splits each face
at repeated vertices into closed loops without repeated vertices. The largest loop is
the primary unrestricted boundary; bridges and secondary lobes do not contribute to its
area or appear as forks in that boundary. Legal transitions expand through their normal
stored ramp movements; forbidden transitions receive explicit diagnostic bridges. The
normal coverage, summary, route tile generation, and main app rendering then run. Road
and ramp styles are unchanged. The optional preview metadata exposes contact markers in
the development app and labels the result as unvalidated. Government-seat circles remain
available, while access routes computed for the published circumference are hidden.

This preview selects a vertex-simple primary loop from the initial whole-graph face
walks used by the current search. The full walks remain available for conservative
search bounds and legal route assembly, where secondary loops may be necessary.
Candidate region scoring also decomposes face walks so secondary lobes never increase
the primary area. The primary preview can still make forbidden transitions and its
expansion through an interchange may reveal defects in the cached geometry; it is not a
certified drivable route or maximum. Preview mode bypasses the optimality, legal-turn,
and simple-ring publication guards only for these isolated outputs; normal builds retain
all three guards.

The current local session serves these artifacts through the normal Vite app at
`http://127.0.0.1:5194/?product=circumference&criterion=motorway`. Its data substitution
uses `main-pipeline-preview-server.mjs` in the persistent recovery directory, without a
separate preview HTML page.

## Subdivision classification

The expanded route follows the Texas border highway closely enough that the coarse
Natural Earth administrative polygons falsely classified it as entering Chihuahua. The
subdivision catalog now overlays all US states with the Census 2025 1:500,000 boundaries
and removes their footprint from overlapping Natural Earth polygons.
`scripts/refine-subdivision-boundaries.py` records the source and reproducible overlay;
it contains no road-specific exceptions. Country and government-seat eligibility are
computed from these boundaries, independently of the area solver.
