# Representative districts

The map starts with Connecticut and five districts, matching the study area and district
count in the paper's worked example. Counts from two to eight can be compared using the
same statewide population.
[Brams, Bai and Patel](https://doi.org/10.1007/s11127-025-01335-9)

**Moving knife** evaluates 36 orientations spaced 10° apart. Each cut walks through
remaining Census tracts by the projection of their interior points. It keeps the last
tract if it gets the district closer to the original statewide quota. The cut with the
highest Reock score wins each round. The score divides the area of the chosen tracts by
the area of the smallest circle that encloses their boundaries. The final district takes
the remainder. This implementation uses whole Census tracts and their cartographic
boundaries in place of the paper's voting precincts.

**Smallest circles** searches all possible circle centers in a local equal-area
projection. An angular sweep tests whether a radius can enclose enough unassigned
population, and a binary search minimizes the radius to within one metre. Each round
takes the remaining tracts whose interior points lie in the winning circle. The final
circle is the smallest one enclosing all remaining populated tract points. Each district
reports its full disk area, including overlap, water and portions outside the state.
Population and urban population are assigned once, in district order.

Both methods treat each tract's population as a unit at its Census interior point. The
ideal population is the statewide total divided by the requested number of districts.
Whole-tract assignments can differ from that target. The urban share uses the Census
urban/rural classification of each resident's tabulation block.

## Rebuild the data

Download the three Census archives and pass them to
`scripts/build-connecticut-district-data.py` in this order. The script uses `pyshp` and
Shapely 2.1 or newer. It aggregates block population to tract IDs, joins the official
tract interior points, and uses the cartographic boundaries for the display and Reock
calculation.

1. [2020 Connecticut tabulation blocks with population and urban classification](https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_09_tabblock20.zip)
2. [2020 Connecticut TIGER/Line tracts](https://www2.census.gov/geo/tiger/TIGER2020/TRACT/tl_2020_09_tract.zip)
3. [2020 Connecticut cartographic tract boundaries, 1:500,000](https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_09_tract_500k.zip)
