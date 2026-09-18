"""Dissolve shared terminal nodes and apply reviewed groundwater connections."""
from collections import defaultdict
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


def merge_features(parent, children, *, recompute_area=False, karst_count=None):
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
    props['source_basins'] = len(features)
    if karst_count is None:
        karst_count = len(children)
    if karst_count:
        props['karst_connections'] = karst_count
    # RIV upstream areas at a common sink can accumulate across distinct MAIN_BAS
    # IDs. Sum actual added polygon areas, not those overlapping upstream totals.
    def equal_area(xy):
        x, y = transform('EPSG:4326', 'EPSG:6933', xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])
    if recompute_area:
        props['area_km2'] = sum(shapely.transform(g, equal_area).area for g in geometries) / 1e6
    else:
        props['area_km2'] += sum(shapely.transform(g, equal_area).area for g in geometries[1:]) / 1e6
    return result


def terminal_groups(nodes, outlets, drainage):
    groups = defaultdict(list)
    for identifier, node in nodes.items():
        groups[node].append(identifier)
    for group in groups.values():
        first = group[0]
        assert all(outlets[i] == outlets[first] for i in group), 'Shared terminal node has inconsistent coordinates'
        assert all(drainage[i] == drainage[first] for i in group), 'Shared terminal node has inconsistent drainage'
    return {min(group): sorted(group) for group in groups.values()}


def prepare(source, outlets, drainage, corrections, nodes=None):
    links = corrections['connections']
    children = [identifier for link in links for identifier in link['source_basins']]
    assert len(children) == len(set(children)), 'A source basin is assigned twice'
    targets = {link['target_basin'] for link in links}
    assert not targets.intersection(children), 'Chained or cyclic corrections are not supported'
    groups = terminal_groups(nodes, outlets, drainage) if nodes is not None else {}
    destinations = {identifier: root for root, group in groups.items() for identifier in group}
    karst_counts = defaultdict(int)
    for link in links:
        target = link['target_basin']
        assert destinations.get(target, target) == target, 'Reviewed receiving basin must be its terminal representative'
        assert drainage[target] == 'ocean', 'Correction must reach a modeled ocean basin'
        assert link['source_url'] and link['evidence'] and link['downstream_route']
        for identifier in link['source_basins']:
            if nodes is not None and 'terminal_node' in link:
                assert nodes[identifier] == link['terminal_node'], 'Reviewed terminal node has changed'
            assert drainage[identifier] == 'inland', 'Reviewed source is no longer a surface sink'
            assert np.allclose(outlets[identifier], link['modeled_sink'], atol=1e-7, rtol=0), 'Source sink has moved; review the connection again'
            group = groups.get(destinations.get(identifier), [identifier])
            assert set(group) <= set(link['source_basins']), 'Review all catchments at the shared sink before overriding it'
        for identifier in link['source_basins']:
            destinations[identifier] = target
        destinations[target] = target
        karst_counts[target] += len(link['source_basins'])
    merged_groups = defaultdict(list)
    for identifier, target in destinations.items():
        merged_groups[target].append(identifier)
    merged_groups = {target: sorted(group) for target, group in merged_groups.items() if len(group) > 1}
    wanted = {identifier for group in merged_groups.values() for identifier in group}
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
    removed = set()
    for target, group in merged_groups.items():
        selected = [found[i] for i in group if i != target]
        replacements[target] = merge_features(found[target], selected,
            recompute_area=not karst_counts[target], karst_count=karst_counts[target])
        removed.update(i for i in group if i != target)
    return replacements, removed
