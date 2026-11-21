# Representative districts

The map starts with Connecticut and five districts, matching the study area and district
count in the paper's worked example. Counts from two to eight can be compared using the
same statewide population.
[Brams, Bai and Patel](https://doi.org/10.1007/s11127-025-01335-9)

**Moving knife** evaluates 36 orientations spaced 10° apart. Each cut walks through
remaining Census blocks by the projection of their interior points. It keeps the last
block if it gets the district closer to the original statewide quota. The cut with the
highest Reock score wins each round. The score divides the area of the chosen blocks by
the area of the smallest circle that encloses their boundaries. The final district takes
the remainder. The paper uses voting precincts as its assignment units.

**Smallest circles** searches for the smallest disk that reaches the quota in a local
equal-area projection. For a given radius, the search subdivides regions of possible
centers and rules out regions that cannot reach the population target. A binary search
minimizes the radius to within one metre. Each round takes the remaining blocks whose
interior points lie in the winning circle. The last circle encloses the remaining
populated block points, and the last district also gets any remaining unpopulated
blocks. The reported circle areas include overlap, water and portions outside the state.

Both methods assign whole 2020 Census tabulation blocks, draw their TIGER/Line
boundaries, and count each block's population at its Census interior point. The
Connecticut study area covers 49,926 blocks, including water blocks. The ideal
population is the statewide total divided by the requested number of districts.
Whole-block assignments can differ from that target. The urban share uses each block's
Census urban/rural classification.

## Rebuild the plans

Pass the
[2020 Connecticut tabulation blocks archive](https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_09_tabblock20.zip)
to `python3 scripts/build-connecticut-district-data.py`. With the project's Node
dependencies, `pyshp` and Shapely 2.1 or newer installed, the script computes the block
assignments and dissolves shared block edges into district polygons. It checks the
statewide population and verifies that each plan assigns every block exactly once. The
browser loads only the published plan selected by the user.
