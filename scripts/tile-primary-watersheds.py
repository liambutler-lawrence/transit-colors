"""Attach checked terminal outlets and build precise, locally hosted vector tiles."""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

import numpy as np
import shapely
import pyogrio

from watershed_corrections import prepare

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
MAX_ZOOM = 10
FULL_DETAIL = 14
# Names verified by terminal coordinates and the included drainage test points.
NAMES = {72911: 'Mississippi basin', 82920: 'Colorado basin', 66083: 'Columbia basin', 70334: 'Great Lakes–St. Lawrence basin', 83239: 'Great Salt Lake basin'}


def main():
    manifest_path = ROOT / 'data/north-america-watersheds-summary.json'
    previous_parts = json.loads(manifest_path.read_text()).get('parts', []) if manifest_path.exists() else []
    data = np.load(CACHE / 'watersheds-v2-outlets.npz')
    assert bool(data['node_verified']), 'Verify terminal coordinates against downstream nodes first'
    outlets = {int(identifier): tuple(coordinate) for identifier, coordinate in zip(data['id'], data['coordinates'])}
    connection = sqlite3.connect(CACHE / 'watersheds-v2-outlets.sqlite')
    drainage = dict(connection.execute('SELECT id, drainage FROM outlets'))
    assert len(drainage) == len(outlets), 'Finish or retry outlet classification first'
    source = CACHE / 'north-america-primary-watersheds.geojsonl'
    target = ROOT / 'data/north-america-primary-watersheds.pmtiles'
    command = [
        'tippecanoe', '--force', f'--output={target}', '--layer=basins',
        '--minimum-zoom=0', f'--maximum-zoom={MAX_ZOOM}',
        f'--full-detail={FULL_DETAIL}', '--low-detail=12',
        '--simplify-only-low-zooms', '--detect-shared-borders',
        '--no-tiny-polygon-reduction-at-maximum-zoom',
        '--no-feature-limit', '--no-tile-size-limit', '--no-tile-stats',
        '--name=North America primary watersheds',
        '--attribution=HydroSHEDS v2 / WWF / DLR; CC BY 4.0',
    ]
    corrections = json.loads((ROOT / 'data/north-america-watersheds-corrections.json').read_text())
    nodes = {int(identifier): int(node) for identifier, node in zip(data['id'], data['node'])}
    replacements, removed = prepare(source, outlets, drainage, corrections, nodes)
    emitted_nodes = set()
    total_catchments = 0
    classifications = Counter()
    count = 0
    samples = []
    with source.open() as lines, subprocess.Popen(command, stdin=subprocess.PIPE, text=True) as tiler:
        output = tiler.stdin
        assert output is not None
        for line in lines:
            # The builder writes properties before geometry. Parse only that small
            # header in Python and preserve the validated coordinate text exactly.
            header, separator, geometry_text = line.partition(',"geometry":')
            assert separator, 'Unexpected source feature layout'
            feature = json.loads(header + '}')
            properties = feature['properties']
            identifier = properties['id']
            if identifier in removed:
                continue
            if identifier in replacements:
                line = json.dumps(replacements[identifier], separators=(',', ':')) + '\n'
                header, _, geometry_text = line.partition(',"geometry":')
                feature = json.loads(header + '}')
                properties = feature['properties']
            lon, lat = outlets[identifier]
            kind = 'unresolved_sink' if drainage[identifier] == 'inland' else drainage[identifier]
            assert nodes[identifier] not in emitted_nodes, 'Duplicate displayed terminal node'
            emitted_nodes.add(nodes[identifier])
            total_catchments += properties['catchments']
            properties.update(terminal_node=nodes[identifier], source_basins=properties.get('source_basins', 1))
            classifications[kind] += 1
            count += 1
            properties.update(outlet_lon=lon, outlet_lat=lat, drainage=kind)
            if identifier in NAMES:
                properties['name'] = NAMES[identifier]
            output.write(json.dumps(feature, separators=(',', ':'))[:-1] + ',"geometry":' + geometry_text)
            if identifier in [72911, 82920, 66083, 70334]:
                geometry = shapely.from_geojson(line)
                boundary = shapely.get_coordinates(shapely.boundary(geometry))
                for index in np.linspace(0, len(boundary) - 1, 16, dtype=int):
                    samples.append({'id': identifier, 'coordinate': boundary[index].tolist()})
        output.close()
        code = tiler.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)
    (ROOT / 'data/north-america-watersheds-precision.json').write_text(json.dumps({'source': 'HydroSHEDS v2 BAS, dissolved on the source lattice before tiling', 'samples': samples}, indent=2) + '\n')
    summary = json.loads((CACHE / 'watersheds-v2-manifest.json').read_text())
    assert total_catchments == summary['routed_catchments'], 'Every source catchment must occur exactly once'
    bas = CACHE / 'watersheds-v2-bas/north-america_BAS_1s_v2r0.gdb'
    if bas.exists():
        _, coastal = pyogrio.read_arrow(bas, where='STRM_ID < 0', columns=['STRM_ID', 'UPLAND_SKM'], read_geometry=False)
        coastal_area = float(coastal['UPLAND_SKM'].to_numpy().sum())
    else:
        previous = json.loads(manifest_path.read_text())
        assert previous['archives'] == json.loads((CACHE / 'watersheds-v2-archives.json').read_text()), 'Cached coastal area belongs to another source'
        coastal_area = previous['unresolved_coastal_area_km2']
    summary.update(
        count=count,
        source_primary_basins=len(outlets),
        source_terminal_nodes=len(set(nodes.values())),
        grouping='Shared terminal node, followed by reviewed groundwater connections',
        unique_displayed_terminal_nodes=len(emitted_nodes),
        shared_terminal_groups=sum(size > 1 for size in Counter(nodes.values()).values()),
        groundwater_corrections=corrections,
        unresolved_coastal_area_km2=coastal_area,
        routed_area_km2=float(data['area'].sum()),
        archives=json.loads((CACHE / 'watersheds-v2-archives.json').read_text()),
        terminal_coordinates_verified=True,
        direction_raster={'url': 'https://data.hydrosheds.org/file/hydrosheds-v2/DIR/1s/north-america_DIR_1s_v2r0.tif', 'access': 'Full-resolution block range reads; full-file hash not computed'},
        outlet_classification=dict(classifications),
        file=target.name, bytes=target.stat().st_size,
        maximum_zoom=MAX_ZOOM, maximum_zoom_extent=2 ** FULL_DETAIL,
        maximum_zoom_simplification=False,
        maximum_grid_quantization_error_m=40075016.686 / (2 ** MAX_ZOOM * 2 ** FULL_DETAIL) / 2 ** 0.5,
    )
    with target.open('rb') as file:
        summary['sha256'] = hashlib.file_digest(file, 'sha256').hexdigest()
    summary['parts'] = []
    with target.open('rb') as archive:
        index = 0
        while chunk := archive.read(95 * 1024 * 1024):
            name = f"{target.stem}-{summary['sha256'][:12]}.{index:03}.bin"
            (target.parent / name).write_bytes(chunk)
            summary['parts'].append({'file': name, 'bytes': len(chunk), 'sha256': hashlib.sha256(chunk).hexdigest()})
            index += 1
    target.unlink()
    (ROOT / 'data/north-america-watersheds-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    current_names = {part['file'] for part in summary['parts']}
    for part in previous_parts:
        name = part['file']
        if name not in current_names and Path(name).name == name and name.startswith('north-america-primary-watersheds-') and name.endswith('.bin'):
            (ROOT / 'data' / name).unlink(missing_ok=True)
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
