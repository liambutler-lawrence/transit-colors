"""Attach checked terminal outlets and build precise, locally hosted vector tiles."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

import numpy as np
import shapely
import pyogrio

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
            lon, lat = outlets[identifier]
            properties.update(outlet_lon=lon, outlet_lat=lat, drainage=drainage[identifier])
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
    _, coastal = pyogrio.read_arrow(CACHE / 'watersheds-v2-bas/north-america_BAS_1s_v2r0.gdb', where='STRM_ID < 0', columns=['STRM_ID', 'UPLAND_SKM'], read_geometry=False)
    summary.update(
        unresolved_coastal_area_km2=float(coastal['UPLAND_SKM'].to_numpy().sum()),
        routed_area_km2=float(data['area'].sum()),
        archives=json.loads((CACHE / 'watersheds-v2-archives.json').read_text()),
        terminal_coordinates_verified=True,
        direction_raster={'url': 'https://data.hydrosheds.org/file/hydrosheds-v2/DIR/1s/north-america_DIR_1s_v2r0.tif', 'access': 'Full-resolution block range reads; full-file hash not computed'},
        outlet_classification=dict(connection.execute('SELECT drainage, COUNT(*) FROM outlets GROUP BY drainage')),
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
