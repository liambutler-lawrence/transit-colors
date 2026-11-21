"""Build the district study data from three Census zip files (requires pyshp and Shapely).

Inputs: tl_2020_09_tabblock20.zip, tl_2020_09_tract.zip, cb_2020_09_tract_500k.zip
"""

import argparse
from collections import defaultdict
import json
from pathlib import Path

import shapefile
from shapely import coverage_union_all, orient_polygons, set_precision
from shapely.geometry import mapping, shape


def build(blocks_path, tracts_path, boundaries_path):
    populations = defaultdict(int)
    urban_populations = defaultdict(int)
    with shapefile.Reader(blocks_path) as blocks:
        for block in blocks.iterRecords(fields=["GEOID20", "POP20", "UR20"]):
            tract_id = block["GEOID20"][:11]
            population = block["POP20"]
            if population and block["UR20"] not in {"U", "R"}:
                raise ValueError(f"Missing urban/rural classification for {block['GEOID20']}")
            populations[tract_id] += population
            if block["UR20"] == "U":
                urban_populations[tract_id] += population

    with shapefile.Reader(tracts_path) as tracts:
        centers = {
            tract["GEOID"]: [float(tract["INTPTLON"]), float(tract["INTPTLAT"])]
            for tract in tracts.iterRecords(fields=["GEOID", "INTPTLON", "INTPTLAT"])
        }

    districts = []
    geometries = []
    included = set()
    with shapefile.Reader(boundaries_path) as boundaries:
        for row in sorted(boundaries.iterShapeRecords(), key=lambda row: row.record["GEOID"]):
            tract_id = row.record["GEOID"]
            geometry = orient_polygons(set_precision(shape(row.shape.__geo_interface__), 1e-6))
            geometries.append(geometry)
            included.add(tract_id)
            districts.append({
                "center": centers[tract_id],
                "population": populations[tract_id],
                "urbanPopulation": urban_populations[tract_id],
                "geometry": mapping(geometry),
            })

    # The coastal cartographic file omits four all-water tracts with no residents.
    if any(populations[tract_id] for tract_id in centers.keys() - included):
        raise ValueError("The cartographic boundaries are missing populated tracts")
    if sum(tract["population"] for tract in districts) != 3_605_944:
        raise ValueError("Tract populations do not match the 2020 Connecticut count")

    outline = orient_polygons(coverage_union_all(geometries))
    if not outline.is_valid:
        raise ValueError("Cartographic boundaries did not form a valid coverage")
    return {"outline": mapping(outline), "tracts": districts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("blocks")
    parser.add_argument("tracts")
    parser.add_argument("boundaries")
    args = parser.parse_args()
    output = Path(__file__).resolve().parent.parent / "data/connecticut-districts.json"
    with output.open("w", encoding="utf-8") as file:
        json.dump(build(args.blocks, args.tracts, args.boundaries), file, separators=(",", ":"))
        file.write("\n")
