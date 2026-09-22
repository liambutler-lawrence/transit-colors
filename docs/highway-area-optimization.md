# Highway circumference area optimization

The objective is the WGS84 area enclosed by one simple loop in the eligible
paired-direction freeway graph. There are no required roads, cities, geographic
waypoints, or connector penalties. Mainline and connector edges retain their computed
coordinates. Grade-separated crossings never become graph junctions.

The integer model chooses oriented graph edges. Flow balance and junction-port
constraints enforce a closed loop with legal turns; each junction is visited at most
once. Geometry conflict constraints prohibit crossing edges. Lazy winding and
connectivity constraints eliminate overlapping and disconnected cycle covers.
Connectivity cuts are conditional on the nodes selected by a candidate; they do not
force that candidate's roads into later solutions.

Geometric crossings use robust orientation predicates, including short segments.
Interior winding probes prevent nested loops from inflating the objective. Once a valid
loop exists, biconnected blocks whose entire area upper bound is smaller can be
discarded. This pruning follows from graph structure and computed bounds, not from a
preferred region. Zero-area extra loops can be discarded when the remaining valid loop
already attains the optimization bound.

Signed geodesic edge areas add up to the ring area. A node-potential transformation
reduces numerical cancellation without changing the area of any cycle. No road role,
length, or ramp count contributes to the objective.

The builder publishes only a single validated loop with a proved optimum under the
model's numerical tolerance. A feasible result at a time limit is insufficient. The
upper bound and iteration count are recorded in the dataset. This establishes optimality
for the supplied graph, not completeness or correctness of the source road network.

## Regeneration

`npm run build:data:highways` uses the existing HiGHS WebAssembly dependency. For the
continental offline solve, the optional native backend is faster:

```sh
python3 -m venv /tmp/highway-area-venv
/tmp/highway-area-venv/bin/pip install highspy==1.15.1
HIGHWAY_HIGHS_PYTHON=/tmp/highway-area-venv/bin/python npm run build:data:highways
npm run build:data:government-connections
```

The native backend is used only for data generation, never in the browser or deployed
application. Verified results are cached with a fingerprint of the graph and solver
sources. Changes to either invalidate the cache. Dependent government seat routes must
be regenerated when the circumference changes.

## Subdivision classification

The expanded route follows the Texas border highway closely enough that the coarse
Natural Earth administrative polygons falsely classified it as entering Chihuahua. The
subdivision catalog now overlays all US states with the Census 2025 1:500,000 boundaries
and removes their footprint from overlapping Natural Earth polygons.
`scripts/refine-subdivision-boundaries.py` records the source and reproducible overlay;
it contains no road-specific exceptions. Country and government-seat eligibility are
computed from these boundaries, independently of the area solver.
