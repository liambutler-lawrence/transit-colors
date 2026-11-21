"""Generate the block-based plans from 2020 TIGER/Line blocks and coastal waters.

Requires pyshp, Shapely 2.1 or newer, and the repository's Node dependencies.
"""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import shapefile
from shapely import coverage_is_valid, coverage_union_all, get_parts, orient_polygons, union_all
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry


COASTAL_COUNTIES = ("09001", "09007", "09009", "09011")
COASTAL_WATER_TYPES = {"H2051", "H2053"}


@dataclass(frozen=True)
class Block:
    geoid: str
    center: tuple[float, float]
    population: int
    urban_population: int
    geometry: BaseGeometry


def load_blocks(blocks_path):
    blocks = []
    fields = ["GEOID20", "POP20", "UR20", "INTPTLON20", "INTPTLAT20"]
    with shapefile.Reader(blocks_path) as shapefile_reader:
        for row in shapefile_reader.iterShapeRecords(fields=fields):
            geoid = row.record["GEOID20"]
            population = row.record["POP20"]
            urban_class = row.record["UR20"]
            if population and urban_class not in {"U", "R"}:
                raise ValueError(f"Missing urban/rural classification for {geoid}")
            blocks.append(Block(
                geoid,
                (float(row.record["INTPTLON20"]), float(row.record["INTPTLAT20"])),
                population,
                population if urban_class == "U" else 0,
                shape(row.shape.__geo_interface__),
            ))
    blocks.sort(key=lambda block: block.geoid)
    if len({block.geoid for block in blocks}) != 49_926:
        raise ValueError("Unexpected Connecticut tabulation block IDs")
    if (sum(block.population for block in blocks), sum(block.urban_population for block in blocks)) != (
        3_605_944, 3_110_153
    ):
        raise ValueError("Block populations do not match the 2020 Connecticut counts")
    if not coverage_is_valid([block.geometry for block in blocks]):
        raise ValueError("The block polygons do not form a valid coverage")
    return blocks


def load_coastal_water(directory, shoreline):
    waters = []
    sea = []
    for county in COASTAL_COUNTIES:
        path = directory / f"tl_2020_{county}_areawater.zip"
        with shapefile.Reader(str(path)) as reader:
            for row in reader.iterShapeRecords(fields=["MTFCC"]):
                water = shape(row.shape.__geo_interface__)
                waters.append(water)
                if row.record["MTFCC"] in COASTAL_WATER_TYPES:
                    sea.append(water)
    marine_water = union_all(sea)
    # Some river polygons extend out into the Sound. Use the cartographic
    # shoreline to trim their offshore sections while keeping inland rivers.
    connected_water = union_all([
        part for part in get_parts(union_all(waters)) if part.intersects(marine_water)
    ])
    with shapefile.Reader(str(shoreline)) as reader:
        land = coverage_union_all([shape(tract.__geo_interface__) for tract in reader.iterShapes()])
    if land.is_empty or not land.is_valid:
        raise ValueError("Cartographic tracts did not form a valid shoreline")
    coastal_water = marine_water.union(connected_water.difference(land))
    if coastal_water.is_empty or not coastal_water.is_valid:
        raise ValueError("Coastal hydrography did not form a valid water mask")
    return coastal_water


def display_geometry(geometry, coastal_water):
    clipped = orient_polygons(geometry.difference(coastal_water))
    if clipped.is_empty or not clipped.is_valid:
        raise ValueError("Coastal clipping produced invalid display geometry")
    return clipped


def write_blocks(path, blocks):
    with path.open("w", encoding="utf-8") as file:
        file.write("[")
        for index, block in enumerate(blocks):
            if index:
                file.write(",")
            json.dump({
                "center": block.center,
                "population": block.population,
                "urbanPopulation": block.urban_population,
                "geometry": mapping(block.geometry),
            }, file, separators=(",", ":"))
        file.write("]")


def write_plan(directory, blocks, outline, coastal_water, assignment):
    method = assignment["method"]
    seats = assignment["seats"]
    assigned = set()
    districts = []
    for district in assignment["districts"]:
        indices = district["blocks"]
        properties = district["properties"]
        if not indices or len(indices) != len(set(indices)) or assigned.intersection(indices):
            raise ValueError(f"Invalid block partition for {method}, {seats} districts")
        members = [blocks[index] for index in indices]
        assigned.update(indices)
        if (
            sum(block.population for block in members) != properties["population"]
            or sum(block.urban_population for block in members) != properties["urbanPopulation"]
        ):
            raise ValueError(f"Incorrect reported population for {method}, {seats} districts")
        geometry = coverage_union_all([block.geometry for block in members])
        if not geometry.is_valid:
            raise ValueError(f"Invalid district geometry for {method}, {seats} districts")
        districts.append({
            "type": "Feature",
            "properties": properties,
            "geometry": mapping(display_geometry(geometry, coastal_water)),
        })
    if len(districts) != seats or assigned != set(range(len(blocks))):
        raise ValueError(f"Incomplete block partition for {method}, {seats} districts")

    population = sum(district["properties"]["population"] for district in districts)
    result = {
        "outline": mapping(outline),
        "districts": {"type": "FeatureCollection", "features": districts},
        "target": population / seats,
        "totalPopulation": population,
        "totalAreaSquareMeters": sum(
            district["properties"]["areaSquareMeters"] for district in districts
        ),
    }
    with (directory / f"{method}-{seats}.json").open("w", encoding="utf-8") as file:
        json.dump(result, file, separators=(",", ":"))
        file.write("\n")


def build(blocks_path, hydrography, shoreline):
    root = Path(__file__).resolve().parent.parent
    blocks = load_blocks(blocks_path)
    coastal_water = load_coastal_water(hydrography, shoreline)
    outline = display_geometry(
        coverage_union_all([block.geometry for block in blocks]), coastal_water
    )
    output = root / "data/connecticut-district-plans"
    with TemporaryDirectory(dir=output.parent) as temporary:
        directory = Path(temporary)
        block_file = directory / "blocks.json"
        assignment_file = directory / "assignments.json"
        write_blocks(block_file, blocks)
        subprocess.run([
            "node", "--import", "tsx", str(root / "scripts/build-connecticut-district-assignments.mjs"),
            str(block_file), str(assignment_file),
        ], cwd=root, check=True)
        assignments = json.loads(assignment_file.read_text(encoding="utf-8"))
        generated = directory / "plans"
        generated.mkdir()
        for assignment in assignments:
            write_plan(generated, blocks, outline, coastal_water, assignment)
        output.mkdir(exist_ok=True)
        for plan in generated.iterdir():
            plan.replace(output / plan.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("blocks")
    parser.add_argument("hydrography", type=Path, help="Directory containing coastal AREAWATER ZIP files")
    parser.add_argument("shoreline", help="2020 Connecticut cartographic tract ZIP file")
    args = parser.parse_args()
    build(args.blocks, args.hydrography, args.shoreline)
