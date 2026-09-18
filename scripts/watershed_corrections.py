"""Apply reviewed groundwater connections without guessing from nearby terrain."""
import json
from pathlib import Path

import numpy as np
import shapely
from rasterio.warp import transform

ROOT = Path(__file__).resolve().parents[1]


def read_header(line):
    header, separator, geometry = line.partition(',"geometry":')
    assert separator, 'Unexpected source feature layout'
    return json.loads(header + '}'), geometry


def merge_features(parent, children):
    features = [parent, *children]
    geometries = [shapely.from_geojson(json.dumps(feature)) for feature in features]
    # Union on the original integer lattice, so coincident hole edges disappear.
    coordinates = shapely.get_coordinates(geometries)
    assert np.max(np.abs(coordinates * 3600 - np.rint(coordinates * 3600)), initial=0) < 0.001, 'Correction geometry is not on the source lattice'
    lattice = shapely.transform(geometries, lambda xy: np.rint(xy * 3600))
    merged = shapely.union_all(lattice)
    assert shapely.is_valid(merged)
    assert abs(merged.area - sum(g.area for g in lattice)) < 0.01, 'Correction overlaps an existing catchment'
    merged = shapely.transform(shapely.simplify(merged, 0), lambda xy: xy / 3600)
    result = {**parent, 'properties': dict(parent['properties']), 'geometry': json.loads(shapely.to_geojson(merged))}
    props = result['properties']
    props['catchments'] = sum(f['properties']['catchments'] for f in features)
    props['karst_connections'] = len(children)
    # RIV upstream areas at a common sink can accumulate across distinct MAIN_BAS
    # IDs. Sum actual added polygon areas, not those overlapping upstream totals.
    def equal_area(xy):
        x, y = transform('EPSG:4326', 'EPSG:6933', xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])
    props['area_km2'] += sum(shapely.transform(g, equal_area).area for g in geometries[1:]) / 1e6
    return result


def prepare(source, outlets, drainage, corrections):
    links = corrections['connections']
    children = [identifier for link in links for identifier in link['source_basins']]
    assert len(children) == len(set(children)), 'A source basin is assigned twice'
    targets = {link['target_basin'] for link in links}
    assert not targets.intersection(children), 'Chained or cyclic corrections are not supported'
    wanted = targets | set(children)
    found = {}
    with Path(source).open() as lines:
        for line in lines:
            feature, _ = read_header(line)
            identifier = feature['properties']['id']
            if identifier in wanted:
                assert identifier not in found, 'Duplicate source basin'
                found[identifier] = json.loads(line)
    assert set(found) == wanted, 'A reviewed source/target basin is missing'
    replacements = {}
    for target in targets:
        selected = []
        for link in links:
            if link['target_basin'] != target:
                continue
            assert link['source_url'] and link['evidence'] and link['downstream_route']
            for identifier in link['source_basins']:
                assert drainage[identifier] == 'inland', 'Reviewed source is no longer a surface sink'
                assert np.allclose(outlets[identifier], link['modeled_sink'], atol=1e-7, rtol=0), 'Source sink has moved; review the connection again'
                selected.append(found[identifier])
        assert drainage[target] == 'ocean', 'Correction must reach a modeled ocean basin'
        replacements[target] = merge_features(found[target], selected)
    return replacements, set(children)
