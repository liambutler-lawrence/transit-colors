"""Dissolve HydroSHEDS v2's 1-second catchments by ultimate drainage outlet.

Dependencies: numpy, pyogrio, pyarrow, shapely>=2.1; tippecanoe.
Inputs: official North America BAS and RIV FileGDB archives, unpacked under
WATERSHED_V2_CACHE (default /tmp). See docs/watersheds.md.
Intermediate SQLite groups are resumable; no tributary boundaries survive union.
"""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import json
import os
from pathlib import Path
import sqlite3
import time

import numpy as np
import pyogrio
import shapely

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
BAS = CACHE / 'watersheds-v2-bas/north-america_BAS_1s_v2r0.gdb'
RIV = CACHE / 'watersheds-v2-riv/north-america_RIV_1s_v2r0.gdb'
BATCH = 10000


def dissolve(geometries):
    # Source boundaries lie on a one-arc-second lattice. Integer coordinates
    # remove FileGDB floating point noise without moving a grid boundary.
    coordinates = shapely.get_coordinates(geometries)
    assert np.max(np.abs(coordinates * 3600 - np.rint(coordinates * 3600)), initial=0) < 0.001, 'Source is not aligned to the expected one-second lattice'
    geometries = shapely.transform(geometries, lambda xy: np.rint(xy * 3600))
    invalid = ~shapely.is_valid(geometries)
    geometries[invalid] = shapely.make_valid(geometries[invalid])
    geometries = shapely.simplify(geometries, 0)
    return geometries


def process(batch, geometry_name, lookup):
    streams = batch['STRM_ID'].to_numpy(zero_copy_only=False)
    valid = streams > 0
    ids = lookup[streams[valid]]
    geometries = dissolve(shapely.from_wkb(batch[geometry_name].to_numpy(zero_copy_only=False)[valid]))
    order = np.argsort(ids, kind='stable')
    groups = np.split(order, np.flatnonzero(np.diff(ids[order])) + 1)
    result = []
    for group in groups:
        if not len(group):
            continue
        merged = shapely.union_all(geometries[group])
        # Degenerate lines from make_valid do not represent land.
        parts = shapely.get_parts(merged)
        polygons = parts[np.isin(shapely.get_type_id(parts), [3, 6])]
        merged = shapely.union_all(polygons)
        result.append((int(ids[group[0]]), len(group), shapely.to_wkb(shapely.simplify(merged, 0))))
    return result, int(np.count_nonzero(~valid))


def routing():
    filename = CACHE / 'watersheds-v2-routing.npz'
    if not filename.exists():
        layer = next(str(name) for name, _ in pyogrio.list_layers(RIV) if 'STREAMS' in name)
        _, table = pyogrio.read_arrow(RIV, layer=layer, columns=['STRM_ID', 'STRM_DN', 'MAIN_BAS', 'UPLAND_SKM'], read_geometry=False)
        np.savez(filename, **{k: table[k].to_numpy() for k in table.column_names})
    data = np.load(filename)
    lookup = np.zeros(int(data['STRM_ID'].max()) + 1, dtype='i4')
    lookup[data['STRM_ID']] = data['MAIN_BAS']
    terminal = data['STRM_DN'] < 0
    roots, counts = np.unique(data['MAIN_BAS'][terminal], return_counts=True)
    assert np.all(counts == 1), 'A main basin has more than one terminal outlet'
    assert np.array_equal(roots, np.unique(data['MAIN_BAS']))
    downstream = data['STRM_DN'] > 0
    assert np.all(lookup[data['STRM_DN'][downstream]] == data['MAIN_BAS'][downstream])
    # Follow every reach to its terminal, detecting cycles/disconnected components.
    resolved = np.arange(len(lookup), dtype='i4')
    resolved[data['STRM_ID']] = np.where(downstream, data['STRM_DN'], data['STRM_ID'])
    for _ in range(32):
        jumped = resolved[resolved]
        if np.array_equal(jumped, resolved):
            break
        resolved = jumped
    else:
        raise ValueError('Unresolved downstream routing cycle')
    terminal_by_main = np.zeros(int(roots.max()) + 1, dtype='i4')
    terminal_by_main[data['MAIN_BAS'][terminal]] = data['STRM_ID'][terminal]
    assert np.array_equal(resolved[data['STRM_ID']], terminal_by_main[data['MAIN_BAS']])
    outlets = {int(root): {'stream': int(stream), 'area': float(area)} for root, stream, area in zip(data['MAIN_BAS'][terminal], data['STRM_ID'][terminal], data['UPLAND_SKM'][terminal])}
    return lookup, outlets


def build():
    lookup, outlets = routing()
    db = sqlite3.connect(CACHE / 'watersheds-v2-unions.sqlite')
    db.execute('CREATE TABLE IF NOT EXISTS parts (batch INTEGER, id INTEGER, count INTEGER, geom BLOB)')
    db.execute('CREATE TABLE IF NOT EXISTS batches (batch INTEGER PRIMARY KEY, unresolved INTEGER)')
    completed = {row[0] for row in db.execute('SELECT batch FROM batches')}
    first_batch = 0
    while first_batch in completed:
        first_batch += 1
    start = time.time()
    with ThreadPoolExecutor(max_workers=6) as pool, pyogrio.open_arrow(BAS, columns=['STRM_ID'], batch_size=BATCH, skip_features=first_batch * BATCH, use_pyarrow=True) as (meta, reader):
        pending = []
        def save():
            finished, _ = wait([future for _, future in pending], return_when=FIRST_COMPLETED)
            index = next(index for index, (_, future) in enumerate(pending) if future in finished)
            number, future = pending.pop(index)
            rows, unresolved = future.result()
            db.executemany('INSERT INTO parts VALUES (?,?,?,?)', [(number, *row) for row in rows])
            db.execute('INSERT INTO batches VALUES (?,?)', (number, unresolved))
            db.commit()
            if number % 10 == 0:
                print(f'Catchments {(number + 1) * BATCH:,}; {time.time() - start:.0f}s', flush=True)
        for number, batch in enumerate(reader, start=first_batch):
            if number in completed:
                continue
            pending.append((number, pool.submit(process, batch, meta['geometry_name'], lookup)))
            if len(pending) >= 8:
                save()
        while pending:
            save()
    # Counts alone cannot detect one duplicate paired with one missing catchment.
    # Check the complete join key partition independently of geometric batching.
    _, keys = pyogrio.read_arrow(BAS, columns=['STRM_ID'], read_geometry=False)
    stream_ids = keys['STRM_ID'].to_numpy()
    occurrences = np.bincount(stream_ids[stream_ids > 0], minlength=len(lookup))
    assert np.all(occurrences[1:] == 1), 'Catchment stream keys are duplicated or missing'
    db.execute('CREATE INDEX IF NOT EXISTS parts_id ON parts(id)')
    db.commit()
    target = CACHE / 'north-america-primary-watersheds.geojsonl'
    total = 0
    with target.open('w') as output:
        for index, root in enumerate(sorted(outlets)):
            rows = db.execute('SELECT count, geom FROM parts WHERE id=? ORDER BY batch', (root,)).fetchall()
            assert rows, f'Missing catchments for main basin {root}'
            geometry = shapely.union_all(shapely.from_wkb([row[1] for row in rows]))
            geometry = shapely.simplify(geometry, 0)
            assert shapely.is_valid(geometry), f'Invalid main basin {root}'
            geometry = shapely.transform(geometry, lambda xy: xy / 3600)
            count = sum(row[0] for row in rows)
            total += count
            props = {'id': root, 'outlet_stream': outlets[root]['stream'], 'area_km2': outlets[root]['area'], 'catchments': count, 'color': root % 8}
            feature = {'type': 'Feature', 'id': root, 'properties': props, 'geometry': json.loads(shapely.to_geojson(geometry))}
            output.write(json.dumps(feature, separators=(',', ':')) + '\n')
            if index % 5000 == 0:
                print(f'Complete basins {index:,}/{len(outlets):,}', flush=True)
    assert total == int(np.count_nonzero(lookup)), 'Every routed catchment must occur exactly once'
    print(f'Geometry ready: {target}', flush=True)
    manifest = {'dataset': 'HydroSHEDS v2.0, North America BAS beta and RIV', 'resolution_arc_seconds': 1, 'count': len(outlets), 'routed_catchments': total, 'unresolved_coastal_units': db.execute('SELECT SUM(unresolved) FROM batches').fetchone()[0], 'source': 'https://www.hydrosheds.org/hydrosheds-v2', 'single_terminal_outlet_verified': True, 'accuracy_guarantee_m': None}
    (CACHE / 'watersheds-v2-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    build()
