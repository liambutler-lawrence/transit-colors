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

**Reock circles** uses the same population quota and whole-block selection rule as
Smallest circles. Each round tests the minimum-radius circle and also grows circles to
the quota from centers on a grid over the remaining population. It refines the
highest-scoring center at progressively smaller steps. The round takes the candidate
with the highest district Reock score, calculated from the full block boundaries using
the same formula as Moving Knife. A tie goes to the smaller selection circle. The final
district takes the remaining blocks and receives a Reock score too.

All three methods assign whole 2020 Census tabulation blocks and count each block's
population at its Census interior point. The Connecticut study area covers 49,926
blocks, including water blocks. The ideal population is the statewide total divided by
the requested number of districts. Whole-block assignments can differ from that target.
The urban share uses each block's Census urban/rural classification.

After assignment, the map removes coastal water from the displayed district polygons and
statewide outline using 2020 TIGER/Line area hydrography. It removes bays, estuaries,
gulfs, sounds, and ocean water. For waterways that open into the coast, the Census
cartographic shoreline marks where to stop clipping at the mouth. Inland waters keep
their district shading. Assignments, area calculations, and scores use the full blocks.
[Census hydrography codes](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2020/TGRSHP2020_TechDoc_E.pdf)

## Rebuild the plans

Pass the Connecticut block archive, the directory of coastal county hydrography
archives, and the cartographic tracts archive to the build script. The hydrography
archives are named `tl_2020_<county FIPS>_areawater.zip` for county codes `09001`,
`09007`, `09009`, and `09011`.
[2020 Connecticut tabulation blocks](https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_09_tabblock20.zip)
·
[2020 Census area hydrography archives](https://www2.census.gov/geo/tiger/TIGER2020/AREAWATER/)
·
[2020 Connecticut cartographic tracts](https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_09_tract_500k.zip)

```sh
python3 scripts/build-connecticut-district-data.py tl_2020_09_tabblock20.zip path/to/hydrography cb_2020_09_tract_500k.zip
```

With the project's Node dependencies, `pyshp`, and Shapely 2.1 or newer installed, the
script assigns blocks, dissolves shared edges, and clips the displayed polygons. It
checks the statewide population and verifies that each plan assigns every block exactly
once. Pass `--method reock-circles` to rebuild only the Reock circles plans. The browser
loads only the published plan selected by the user.
