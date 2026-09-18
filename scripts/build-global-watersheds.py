"""Build detailed GRIT main-outlet basins outside existing North American coverage.

Dependencies: numpy, pyarrow, pyogrio, shapely>=2, pyproj, rasterio, tippecanoe.
Download the pinned archives in data/sources/grit-v1-files.json to GRIT_CACHE.
Each region is checkpointed so a build can resume without repeating dissolves.
"""
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import numpy as np
import pyogrio
from pyproj import Transformer
import rasterio.warp
import shapely
from shapely.geometry import shape
from shapely.geometry import mapping

from grit_routing import route_segments
from global_marine import MarineBodies
from na_coverage import NorthAmericaCoverage

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('GRIT_CACHE', '/tmp/grit'))
REGIONS = ['EU', 'SI', 'SA', 'SP', 'AS', 'AF', 'NA']
TRANSFORM = Transformer.from_crs(8857, 4326, always_xy=True)
MARINE = MarineBodies()
# The release files contain Greenland features although the published scope excludes it.
# Omit those unsupported whole basins rather than imply validated ice-sheet routing.
GREENLAND = shape(next(f['geometry'] for f in json.loads((ROOT / 'data/timezone-skew-countries.geojson').read_text())['features'] if f['properties']['iso_a3'] == 'GRL')).buffer(0.2)

def unsupported_greenland(geometry):
    return GREENLAND.covers(geometry.representative_point())

OUTLET_REVIEWS = {r['terminal_node']: r for r in json.loads((ROOT / 'data/global-watersheds-outlet-reviews.json').read_text())}


def dataset(kind, region):
    name = f'GRITv1.0_{kind}_{region}_EPSG8857.gpkg'
    path = CACHE / name
    archive = CACHE / (name + '.zip')
    record = next(f for f in json.loads((ROOT / 'data/sources/grit-v1-files.json').read_text()) if f['file'] == archive.name)
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'md5').hexdigest() == record['md5'], f'Incomplete/wrong archive: {archive}'
    if not path.exists():
        with zipfile.ZipFile(archive) as zipped:
            assert zipped.namelist() == [name]
            zipped.extract(name, CACHE)
    return path


def write_feature(stream, properties, geometry):
    if not shapely.is_valid(geometry):
        geometry = shapely.make_valid(geometry)
    if geometry.geom_type == 'GeometryCollection':
        geometry = shapely.union_all([p for p in geometry.geoms if p.geom_type in ('Polygon', 'MultiPolygon')])
    assert not geometry.is_empty
    # GDAL cuts at the antimeridian during reprojection, avoiding world-spanning rings.
    geo = rasterio.warp.transform_geom('EPSG:8857', 'EPSG:4326', mapping(geometry), antimeridian_cutting=True, precision=7)
    assert geo['type'] in ('Polygon', 'MultiPolygon')
    polygons = [geo['coordinates']] if geo['type'] == 'Polygon' else geo['coordinates']
    for polygon in polygons:
        for ring in polygon:
            assert all(abs(a[0] - b[0]) <= 180 for a, b in zip(ring, ring[1:])), 'Uncut antimeridian ring'
    stream.write(json.dumps({'type': 'Feature', 'properties': properties, 'geometry': dict(geo)}, separators=(',', ':'), allow_nan=False) + '\n')


def build_region(region):
    target = CACHE / f'basins-{region}.geojsonl'
    stats_path = CACHE / f'basins-{region}.json'
    if stats_path.exists():
        return json.loads(stats_path.read_text())
    network = dataset('segments', region)
    _, table = pyogrio.read_arrow(network, layer='lines', read_geometry=False,
        columns=['global_id', 'upstream_node_id', 'downstream_node_id', 'is_mainstem', 'width_adjusted', 'name', 'drainage_area_mainstem_out', 'domain'])
    rows = table.to_pylist()
    routing = route_segments(rows)
    domains = sorted(set(r['domain'] for r in rows))
    _, nodes_table = pyogrio.read_arrow(network, layer='nodes', columns=['global_id', 'node_type'])
    nodes = {r['global_id']: r for r in nodes_table.to_pylist()}
    del table, nodes_table
    assert {node for node, _ in routing.values()} <= nodes.keys(), 'Terminal node is absent from source network'
    best_names = {}
    for r in rows:
        node = routing[r['global_id']][0]
        score = r['drainage_area_mainstem_out'] or 0
        if r['name'] and score > best_names.get(node, (0, ''))[0]:
            best_names[node] = (score, r['name'])
    catchments = dataset('segment_catchments', region)
    _, table = pyogrio.read_arrow(catchments, columns=['global_id', 'area'])
    assert table.num_rows == len(rows)
    ids = table['global_id'].to_numpy()
    assert set(ids) == set(routing), 'Every network segment needs exactly one catchment'
    geometry = shapely.from_wkb(table['geom'].to_numpy())
    areas = table['area'].to_numpy()
    groups = defaultdict(list)
    for index, identifier in enumerate(ids):
        groups[routing[int(identifier)][0]].append(index)
    stats = dict(region=region, domains=domains, catchments=len(ids), basins=len(groups), area_km2=float(areas.sum()), drainage=Counter(), receiving_bodies=Counter())
    coverage = NorthAmericaCoverage() if region == 'NA' else None
    if coverage:
        stats.update(source_catchments=stats['catchments'], source_basins=stats['basins'], catchments=0, basins=0, area_km2=0, omitted_existing_basins=0)
    with target.open('w') as output:
        for count, (node, indices) in enumerate(sorted(groups.items())):
            if coverage:
                largest = indices[int(np.argmax(areas[indices]))]
                test = shapely.transform(geometry[largest], TRANSFORM.transform, interleaved=False)
                if coverage.intersects(test):
                    stats['omitted_existing_basins'] += 1
                    continue
                merged = shapely.union_all(geometry[indices])
                test = shapely.transform(merged, TRANSFORM.transform, interleaved=False)
                if coverage.intersects(test):
                    stats['omitted_existing_basins'] += 1
                    continue
                stats['catchments'] += len(indices)
                stats['basins'] += 1
                stats['area_km2'] += float(areas[indices].sum())
            record = nodes[node]
            point = shapely.from_wkb(record['geom'])
            xy = TRANSFORM.transform(point.x, point.y)
            drainage = {'coastal_outlet': 'ocean', 'sink_outlet': 'unresolved_sink'}.get(record['node_type'], 'unverified')
            if node in OUTLET_REVIEWS:
                review = OUTLET_REVIEWS[node]
                assert np.allclose(xy, review['coordinate'], atol=1e-8, rtol=0)
                drainage = review['drainage']
            properties = dict(id=1_000_000_000 + node, terminal_node=node, source_basins=1,
                outlet_stream=routing[int(ids[indices[0]])][1], area_km2=float(areas[indices].sum()),
                catchments=len(indices), outlet_lon=xy[0], outlet_lat=xy[1], drainage=drainage, source='grit')
            if drainage == 'ocean':
                body = OUTLET_REVIEWS[node]['exit_body'] if node in OUTLET_REVIEWS else MARINE.classify(xy)
                if body == 'Caspian Sea':
                    properties['drainage'] = 'endorheic'
                properties.update(exit_body=body, fill_color=MARINE.colors[body])
                stats['receiving_bodies'][body] += 1
            if node in best_names:
                properties['name'] = best_names[node][1] + ' basin'
            stats['drainage'][properties['drainage']] += 1
            merged = shapely.union_all(geometry[indices])
            write_feature(output, properties, merged)
            if count % 1000 == 0:
                print(region, count, '/', len(groups), flush=True)
    stats_path.write_text(json.dumps(stats, indent=2) + '\n')
    # All source archives remain pinned and cached; release large expanded files.
    network.unlink()
    catchments.unlink()
    return stats


def build_sinks(stats):
    target = CACHE / 'basins-sinks.geojsonl'
    stats_path = CACHE / 'basins-sinks.json'
    if stats_path.exists():
        return json.loads(stats_path.read_text())
    path = dataset('component_catchments', 'GLOBAL')
    domains = {d for r in stats for d in r['domains']}
    _, table = pyogrio.read_arrow(path, where='is_sink = 1', columns=['global_id', 'area', 'domain'])
    total, area = 0, 0
    na_domains = {d for r in stats if r['region'] == 'NA' for d in r['domains']}
    coverage = NorthAmericaCoverage() if na_domains else None
    with target.open('w') as output:
        for row in table.to_pylist():
            if row['domain'] not in domains:
                continue
            if row['domain'] == 'ICEL' and unsupported_greenland(shapely.transform(shapely.from_wkb(row['geom']), TRANSFORM.transform, interleaved=False)):
                continue
            if row['domain'] in na_domains and coverage.intersects(shapely.transform(shapely.from_wkb(row['geom']), TRANSFORM.transform, interleaved=False)):
                continue
            properties = dict(id=3_000_000_000 + row['global_id'], area_km2=row['area'], catchments=1,
                source_basins=1, drainage='unverified', source='grit', outlet_known=False)
            write_feature(output, properties, shapely.from_wkb(row['geom']))
            total += 1
            area += row['area']
    _, coastal = pyogrio.read_arrow(path, where='is_coastal = 1', columns=['domain', 'area'], read_geometry=False)
    omitted = [r for r in coastal.to_pylist() if r['domain'] in domains]
    result = dict(basins=total, area_km2=area, composite_coastal_units_omitted=len(omitted), composite_coastal_area_km2=sum(r['area'] for r in omitted))
    stats_path.write_text(json.dumps(result, indent=2) + '\n')
    path.unlink()
    return result


def finalize_regions(stats):
    """Refresh labels separately from expensive geometry, preserving every vertex."""
    names = json.loads((ROOT / 'data/global-watersheds-names.json').read_text())
    for entry in stats:
        path = CACHE / f"basins-{entry['region']}.geojsonl"
        temporary = path.with_suffix('.tmp')
        drainage, bodies = Counter(), Counter()
        with path.open() as source, temporary.open('w') as output:
            for line in source:
                header, separator, geometry = line.partition(',"geometry":')
                feature = json.loads(header + '}')
                p = feature['properties']
                node = p['terminal_node']
                if node in OUTLET_REVIEWS:
                    review = OUTLET_REVIEWS[node]
                    assert np.allclose([p['outlet_lon'], p['outlet_lat']], review['coordinate'], atol=1e-8, rtol=0)
                    p['drainage'] = review['drainage']
                if p['drainage'] in ('ocean', 'endorheic'):
                    body = OUTLET_REVIEWS[node]['exit_body'] if node in OUTLET_REVIEWS else MARINE.classify([p['outlet_lon'], p['outlet_lat']])
                    p.update(exit_body=body, fill_color=MARINE.colors[body], drainage='endorheic' if body == 'Caspian Sea' else 'ocean')
                    bodies[body] += 1
                if str(p['id']) in names:
                    p['name'] = names[str(p['id'])]
                drainage[p['drainage']] += 1
                output.write(json.dumps(feature, separators=(',', ':'))[:-1] + separator + geometry)
        temporary.replace(path)
        entry.update(drainage=dict(drainage), receiving_bodies=dict(bodies))
        (CACHE / f"basins-{entry['region']}.json").write_text(json.dumps(entry, indent=2) + '\n')


def merge_closed_basins(stats):
    """All rivers entering the same confirmed terminal lake share one closed basin."""
    members = []
    for entry in stats:
        source = CACHE / f"basins-{entry['region']}.geojsonl"
        target = CACHE / f"display-{entry['region']}.geojsonl"
        groups, unsupported = 0, 0
        with source.open() as lines, target.open('w') as output:
            for line in lines:
                p = json.loads(line.partition(',"geometry":')[0] + '}')['properties']
                if entry['region'] == 'EU' and p['outlet_lon'] < -10 and p['outlet_lat'] > 58 and unsupported_greenland(shapely.from_geojson(line)):
                    unsupported += 1
                    continue
                if p['drainage'] == 'endorheic':
                    assert p['exit_body'] == 'Caspian Sea'
                    members.append((p, shapely.from_geojson(line)))
                    groups += 1
                else:
                    output.write(line)
        entry['closed_lake_terminal_groups'] = groups
        entry['unsupported_greenland_basins'] = unsupported
        entry['displayed_individual_basins'] = entry['basins'] - groups - unsupported
    assert len(members) > 1
    properties = dict(id=2_900_000_001, source='grit', name='Caspian Sea basin',
        drainage='endorheic', exit_body='Caspian Sea', fill_color=MARINE.colors['Caspian Sea'],
        outlet_known=False, source_basins=len(members),
        catchments=sum(p['catchments'] for p, _ in members),
        area_km2=sum(p['area_km2'] for p, _ in members))
    geometry = shapely.union_all([g for _, g in members])
    assert geometry.is_valid
    feature = dict(type='Feature', properties=properties, geometry=mapping(geometry))
    (CACHE / 'basins-closed.geojsonl').write_text(json.dumps(feature, separators=(',', ':'), allow_nan=False) + '\n')
    return dict(count=1, terminal_groups_joined=len(members), members=[p['id'] for p, _ in members], area_km2=properties['area_km2'], catchments=properties['catchments'])


def tile(stats, sinks, closed):
    manifest_path = ROOT / 'data/global-watersheds-summary.json'
    previous_parts = json.loads(manifest_path.read_text()).get('parts', []) if manifest_path.exists() else []
    target = CACHE / 'global-primary-watersheds.pmtiles'
    sources = [CACHE / f'display-{r}.geojsonl' for r in REGIONS] + [CACHE / 'basins-sinks.geojsonl', CACHE / 'basins-closed.geojsonl']
    command = ['tippecanoe', '--force', f'--output={target}', '--layer=basins',
        '--minimum-zoom=0', '--maximum-zoom=10', '--full-detail=14', '--low-detail=12',
        '--simplify-only-low-zooms', '--detect-shared-borders', '--no-tiny-polygon-reduction-at-maximum-zoom',
        '--no-feature-limit', '--no-tile-size-limit', '--no-tile-stats',
        '--name=Global primary watersheds outside North America',
        '--attribution=GRIT v1.0 / Wortmann et al. (2025); CC BY-NC 4.0'] + list(map(str, sources))
    subprocess.run(command, check=True)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    summary = dict(source='GRIT v1.0', source_url='https://zenodo.org/records/17435232',
        license='CC BY-NC 4.0', outlet_reviews=list(OUTLET_REVIEWS.values()), source_resolution_m=30, source_vectors_simplified=True,
        grouping='Follow mainstem at bifurcations, then dissolve segment catchments by terminal node. Secondary outlets remain distinct.',
        regions=stats, surface_depressions=sinks, closed_basins=closed, exclusions=['Greenland', 'Antarctica', 'Composite coastal units below the source 50 km² stream threshold'],
        count=sum(s['displayed_individual_basins'] for s in stats) + sinks['basins'] + closed['count'], file=target.name, sha256=digest,
        bytes=target.stat().st_size, maximum_zoom=10, maximum_zoom_extent=16384,
        maximum_zoom_simplification=False, parts=[])
    with target.open('rb') as stream:
        index = 0
        while chunk := stream.read(95 * 1024 * 1024):
            name = f'global-primary-watersheds-{digest[:12]}.{index:03}.bin'
            (ROOT / 'data' / name).write_bytes(chunk)
            summary['parts'].append(dict(file=name, bytes=len(chunk), sha256=hashlib.sha256(chunk).hexdigest()))
            index += 1
    (ROOT / 'data/global-watersheds-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    current_names = {part['file'] for part in summary['parts']}
    for part in previous_parts:
        name = part['file']
        if name not in current_names and Path(name).name == name and name.startswith('global-primary-watersheds-') and name.endswith('.bin'):
            (ROOT / 'data' / name).unlink(missing_ok=True)
    used = {name for s in stats for name in s['receiving_bodies']}
    bodies = [dict(name=name, color=MARINE.colors[name]) for name in sorted(used)]
    (ROOT / 'data/global-watersheds-exit-bodies.json').write_text(json.dumps(bodies, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    requested = sys.argv[1:]
    if requested:
        for region in requested:
            build_region(region)
    else:
        stats = [build_region(region) for region in REGIONS]
        finalize_regions(stats)
        tile(stats, build_sinks(stats), merge_closed_basins(stats))
