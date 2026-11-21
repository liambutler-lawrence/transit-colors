"""Build a state's district assets from 2020 TIGER/Line tabulation blocks."""

import argparse
import gzip
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import numpy as np
from pyogrio.raw import read
from shapely import (
    GEOSException, box, coverage_union_all, covers, difference, from_wkb, get_parts,
    intersection, is_valid, make_valid, orient_polygons, prepare, set_precision,
    to_geojson, transform, union_all,
)
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon


ROOT = Path(__file__).resolve().parent.parent
# Atlantic, Pacific, Gulf of Mexico and Great Lakes states.
COASTAL_STATES = set(
    "AL AK CA CT DE FL GA HI IL IN LA ME MD MA MI MN MS NH NJ NY NC OH OR PA RI SC TX VA WA WI".split()
)


def polygons(geometry):
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    return MultiPolygon([
        polygon
        for part in get_parts(geometry)
        if isinstance(part, (Polygon, MultiPolygon))
        for polygon in get_parts(part)
    ])


def unwrap_alaska(geometries):
    # TIGER cuts at 180°. Bring both sides into Alaska's own longitude range.
    return transform(geometries, lambda x, y: (np.where(x > 0, x - 360, x), y),
                     interleaved=False)


def dissolve(geometries):
    try:
        coverage = coverage_union_all(geometries)
        if coverage.is_valid:
            return coverage
    except GEOSException:
        pass
    return polygons(union_all(geometries))


def load_blocks(path, state):
    _, _, wkb, fields = read(str(path), columns=[
        "GEOID20", "POP20", "UR20", "INTPTLON20", "INTPTLAT20", "AWATER20",
    ])
    geoids, urban_class, water, latitude, longitude, population = fields
    order = np.argsort(geoids)
    unique = np.unique(geoids)
    if (len(geoids) != state["blocks"] or len(unique) != len(geoids)
            or any(not geoid.startswith(state["fips"]) for geoid in unique)):
        raise ValueError("The block IDs do not match the Census state tally")
    population = population[order].astype(np.int64)
    urban_class = urban_class[order]
    if population.sum() != state["population"]:
        raise ValueError("The blocks do not add up to the 2020 Census population")
    if not np.all(np.isin(urban_class[population > 0], ("U", "R"))):
        raise ValueError("A populated block is missing its Census urban/rural classification")
    geometries = from_wkb(wkb[order])
    longitude = longitude[order].astype(float)
    if state["code"] == "AK":
        geometries = unwrap_alaska(geometries)
        longitude = np.where(longitude > 0, longitude - 360, longitude)
    for index in np.flatnonzero(~is_valid(geometries)):
        geometries[index] = polygons(make_valid(geometries[index]))
        if geometries[index].is_empty:
            raise ValueError(f"Block {geoids[order[index]]} has an empty polygon")
    return (geometries, population, np.where(urban_class == "U", population, 0),
            longitude, latitude[order].astype(float), water[order] > 0)


def coastal_water(path, state, wet_blocks):
    if state["code"] not in COASTAL_STATES:
        return Polygon()
    west, south, east, north = state["bounds"]
    bounds = None if state["code"] == "AK" else (west - 1, south - 1, east + 1, north + 1)
    _, _, wkb, _ = read(str(path), columns=[], bbox=bounds)
    land = from_wkb(wkb)
    if state["code"] == "AK":
        land = unwrap_alaska(land)
        land = intersection(make_valid(land), box(west - 5, south - 5, east + 5, north + 5))
    shoreline = polygons(union_all(make_valid(land)))
    if shoreline.is_empty:
        raise ValueError("Missing Census cartographic shoreline")
    # Use the Census shoreline only to remove water outside the cartographic
    # land extent. Dry blocks and inland waters keep their full display geometry.
    prepare(shoreline)
    offshore = wet_blocks[~covers(shoreline, wet_blocks)]
    return polygons(union_all(difference(offshore, shoreline)))


def display_geometry(geometry, water):
    if not water.is_empty:
        geometry = polygons(geometry.difference(water))
    if geometry.bounds[0] < -180:
        west = geometry.intersection(box(-360, -90, -180, 90))
        east = geometry.intersection(box(-180, -90, 180, 90))
        geometry = polygons(union_all([translate(west, xoff=360), east]))
    geometry = set_precision(geometry, 0.0000001)
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError("Clipping produced an empty or invalid display polygon")
    return orient_polygons(geometry)


def write_blocks(path, geometries, population, urban, longitude, latitude):
    with path.open("w", encoding="utf8") as output:
        for start in range(0, len(geometries), 2048):
            stop = start + 2048
            shapes = to_geojson(geometries[start:stop])
            for x, y, residents, city, geometry in zip(
                longitude[start:stop], latitude[start:stop],
                population[start:stop], urban[start:stop], shapes, strict=True
            ):
                output.write(
                    f'{{"center":[{x},{y}],"population":{residents},'
                    f'"urbanPopulation":{city},"geometry":{geometry}}}\n'
                )


def write_plan(path, geoms, population, urban, water, assignments):
    labels = np.zeros(len(geoms), dtype=np.uint8)
    total_area = 0
    with gzip.open(path, "wt", compresslevel=5, encoding="utf8") as output:
        output.write('{"districts":{"type":"FeatureCollection","features":[')
        for number, district in enumerate(assignments, start=1):
            indices = np.asarray(district["blocks"], dtype=int)
            properties = district["properties"]
            if (not len(indices) or np.any(indices < 0) or np.any(indices >= len(geoms))
                    or np.any(labels[indices]) or len(np.unique(indices)) != len(indices)):
                raise ValueError(f"{path.name} does not partition the Census blocks")
            if (properties["number"] != number
                    or population[indices].sum() != properties["population"]
                    or urban[indices].sum() != properties["urbanPopulation"]):
                raise ValueError(f"{path.name} reported incorrect district population")
            labels[indices] = number
            total_area += properties["areaSquareMeters"]
            geometry = display_geometry(dissolve(geoms[indices]), water)
            if number > 1:
                output.write(",")
            output.write('{"type":"Feature","properties":')
            json.dump(properties, output, separators=(",", ":"), allow_nan=False)
            output.write(',"geometry":')
            output.write(to_geojson(geometry))
            output.write("}")
        if not np.all(labels):
            raise ValueError(f"{path.name} omitted Census blocks")
        output.write(']},')
        output.write(f'"target":{population.sum() / len(assignments)},'
                     f'"totalPopulation":{population.sum()},'
                     f'"totalAreaSquareMeters":{total_area}}}\n')


def build(args):
    states = json.loads((ROOT / "src/district-states.json").read_text())
    state = next(state for state in states if state["fips"] == args.fips)
    geoms, population, urban, longitude, latitude, wet = load_blocks(args.blocks, state)
    print(f"{state['name']} has {len(geoms)} verified blocks.", flush=True)
    water = coastal_water(args.shoreline, state, geoms[wet])
    print(f"Prepared {state['name']}'s shoreline.", flush=True)
    outline = display_geometry(dissolve(geoms), water)
    args.output.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output / "outline.json.gz", "wt", compresslevel=5, encoding="utf8") as file:
        file.write(to_geojson(outline))
    west, south, east, north = state["bounds"]
    with TemporaryDirectory() as temporary:
        directory = Path(temporary)
        blocks = directory / "blocks.ndjson"
        write_blocks(blocks, geoms, population, urban, longitude, latitude)
        command = [
            "node", "--max-old-space-size=8192", "--import", "tsx",
            str(ROOT / "scripts/build-state-district-assignments.mjs"),
            str(blocks), str(directory), str((west + east) / 2), str((south + north) / 2),
        ]
        if args.method:
            command.append(args.method)
        if args.seats:
            command.append(str(args.seats))
        subprocess.run(command, cwd=ROOT, check=True)
        for assignment in sorted(directory.glob("*.json")):
            path = args.output / (assignment.name + ".gz")
            write_plan(path, geoms, population, urban, water, json.loads(assignment.read_text()))
            print(f"Built {state['name']} {path.name} ({path.stat().st_size:,} bytes).", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fips")
    parser.add_argument("blocks", type=Path)
    parser.add_argument("shoreline", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--method", choices=["knife", "circles", "reock-circles"])
    parser.add_argument("--seats", type=int, choices=range(2, 9))
    args = parser.parse_args()
    if args.seats and not args.method:
        parser.error("--seats requires --method")
    build(args)
