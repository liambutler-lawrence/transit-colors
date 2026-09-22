# Nearest-distance midpoint experiment

Open `/midpoint-comparison.html` to compare the production geometry with unrestricted
bidirectional nearest-point midpoints. This experiment does not change the production
highway network or route solver.

The 14 cases include 11 real saved source pairs (Sugarloaf east/west, Seattle, Brewster,
two collector pairs, Camden, New York, Monteagle, Coachochitlán, and Memphis) and three
labeled synthetic controls (parallel, concentric, and widening S-bend).

Regenerate frozen inputs and production outputs with:

```sh
node --import tsx scripts/build-midpoint-comparison.mjs
```

The mainline examples call the production mainline/network builders; ramp examples call
`averageReciprocalPathCoordinates` with their saved continuation and attachment inputs.
The experimental worker applies the same calculation to both road roles:

1. Orient both sides consistently by endpoint distances.
2. Project to a local WGS84 azimuthal-equidistant metric plane.
3. Sample every N meters plus the final endpoint on each side.
4. Find the unrestricted closest point on the opposite source segments, using a
   bounding-volume index. The match need not be a sampled point.
5. Take the midpoint of each pair without smoothing, filtering or snapping.
6. Combine by mean normalized progress along the two source sides. This ordering is an
   explicit convention, not a requirement implied by nearest matching.

Separate directional traces and an unconnected cloud let the reviewer distinguish
nearest-match behavior from artifacts of combining and ordering the sequences. The
pair-link overlay is limited to 240 links, but all midpoint samples remain in the line.

Distances are local planar approximations. Production attachments are preserved only on
the production side. In the Memphis example one source chain extends beyond the other:
the unrestricted algorithm keeps pairing against the shorter chain's endpoint. Large
disagreement there includes this change in extent, not just interior deviation.

## Initial observations

At 1 m spacing in a local Chromium run, matching and turn diagnostics took about 1–16 ms
for smaller pairs, 34 ms for Coachochitlán and 84 ms for Monteagle (85,533 pairs). This
excludes rendering and deviation measurement and is not a network-wide benchmark. The
work runs in a web worker.

The parallel control yields the expected straight midpoint. The concentric control also
behaves cleanly. Asymmetric curves can produce different A-to-B and B-to-A traces;
interleaving those traces makes the combined line zigzag. Loops can additionally cause
nearest matches to reverse progress. Higher sampling density does not remove these
geometric ambiguities. Counts of sharp turns depend on the chosen ordering, so they must
not be interpreted as defects in the point cloud itself or proof that the current
algorithm is ground truth.
