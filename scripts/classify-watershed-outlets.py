"""Classify HydroSHEDS v2 terminal reaches using its matching D8 raster.

Reads small raster blocks, never a lower-resolution coastline. Ambiguous terminals
remain unverified. The intermediate `inland` category only means a surface sink;
it does not establish endorheic drainage. Run after extracting RIV; results are restartable in SQLite.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import sqlite3
import threading

import numpy as np
import pyogrio
import rasterio
from rasterio.windows import Window
import shapely

CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
URL = os.environ.get('WATERSHED_DIR_URL', 'https://data.hydrosheds.org/file/hydrosheds-v2/DIR/1s/north-america_DIR_1s_v2r0.tif')
LOCAL = threading.local()
D8 = {1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1), 64: (-1, 0), 128: (-1, 1)}


def extract():
    target = CACHE / 'watersheds-v2-outlets.npz'
    if target.exists():
        cached = np.load(target)
        if len(cached['id']) and bool(cached.get('node_verified', False)):
            return cached
    path = CACHE / 'watersheds-v2-riv/north-america_RIV_1s_v2r0.gdb'
    layer = next(str(name) for name, _ in pyogrio.list_layers(path) if 'STREAMS' in name)
    # Include the filtered field: GDAL's Arrow reader otherwise ignores it.
    meta, table = pyogrio.read_arrow(path, layer=layer, where='STRM_DN < 0', columns=['STRM_ID', 'STRM_DN', 'MAIN_BAS', 'UPLAND_SKM', 'NODE_ID_DOWN'])
    geometries = shapely.from_wkb(table[meta['geometry_name']].to_numpy())
    coordinates = shapely.get_coordinates(shapely.get_point(shapely.get_geometry(geometries, -1), -1))
    node_ids = table['NODE_ID_DOWN'].to_numpy()
    wanted = set(map(int, node_ids))
    found = {}
    node_layer = next(str(name) for name, _ in pyogrio.list_layers(path) if 'NODES' in name)
    with pyogrio.open_arrow(path, layer=node_layer, columns=['NODE_ID'], batch_size=100000, use_pyarrow=True) as (node_meta, reader):
        for batch in reader:
            ids = batch['NODE_ID'].to_numpy(zero_copy_only=False)
            keep = np.fromiter((int(identifier) in wanted for identifier in ids), dtype=bool, count=len(ids))
            if np.any(keep):
                points = shapely.get_coordinates(shapely.from_wkb(batch[node_meta['geometry_name']].to_numpy(zero_copy_only=False)[keep]))
                found.update(zip(map(int, ids[keep]), points))
    assert len(found) == len(wanted), 'A terminal downstream node is missing'
    assert np.array_equal(coordinates, np.array([found[int(node)] for node in node_ids])), 'River endpoints do not match downstream node coordinates'
    np.savez(target, node_verified=True, node=node_ids, id=table['MAIN_BAS'].to_numpy(), stream=table['STRM_ID'].to_numpy(), area=table['UPLAND_SKM'].to_numpy(), coordinates=coordinates)
    return np.load(target)


def classify(task):
    block, points = task
    try:
        if not hasattr(LOCAL, 'source'):
            LOCAL.source = rasterio.open('/vsicurl/' + URL)
        # Read one native raster block. Cross-block or ambiguous traces remain
        # unverified rather than guessing an ocean/inland classification.
        row0, col0 = block[0] * 512, block[1] * 512
        data = LOCAL.source.read(1, window=Window(col0, row0, 512, 512), boundless=True, fill_value=255)
        result = []
        for identifier, row, col in points:
            outcomes = set()
            for dr, dc in [(0, 0), (-1, 0), (0, -1), (-1, -1)]:
                r, c = row - row0 + dr, col - col0 + dc
                if not (0 <= r < 512 and 0 <= c < 512):
                    outcomes.add('unverified')
                    continue
                if data[r, c] == 255:
                    continue  # Start on land, then follow its flow into sea or sink.
                seen = set()
                for _ in range(64):
                    if not (0 <= r < 512 and 0 <= c < 512) or (r, c) in seen:
                        outcomes.add('unverified')
                        break
                    seen.add((r, c))
                    value = int(data[r, c])
                    if value == 255:
                        outcomes.add('ocean')
                        break
                    if value == 0:
                        # A terminal land cell touching the sea is coastal.
                        near = data[max(0, r-1):r+2, max(0, c-1):c+2]
                        outcomes.add('ocean' if np.any(near == 255) else 'inland')
                        break
                    if value not in D8:
                        outcomes.add('unverified')
                        break
                    dy, dx = D8[value]
                    r, c = r + dy, c + dx
                else:
                    outcomes.add('unverified')
            kind = next(iter(outcomes)) if len(outcomes) == 1 else 'unverified'
            result.append((int(identifier), kind))
        return result
    except Exception as error:
        print(f'Block {block} deferred: {error}', flush=True)
        return []  # Uncompleted entries are retried on the next run.


def main():
    source = extract()
    db = sqlite3.connect(CACHE / 'watersheds-v2-outlets.sqlite')
    db.execute('CREATE TABLE IF NOT EXISTS outlets (id INTEGER PRIMARY KEY, drainage TEXT)')
    done = {row[0] for row in db.execute('SELECT id FROM outlets')}
    tasks = {}
    for identifier, (lon, lat) in zip(source['id'], source['coordinates']):
        if int(identifier) in done:
            continue
        col, row = int(round((lon + 170) * 3600)), int(round((84 - lat) * 3600))
        tasks.setdefault((row // 512, col // 512), []).append((identifier, row, col))
    print(f'{len(tasks):,} raster blocks; {len(done):,} outlets already checked', flush=True)
    with rasterio.Env(GDAL_HTTP_TIMEOUT='40', GDAL_HTTP_MAX_RETRY='2', GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR'), ThreadPoolExecutor(max_workers=16) as pool:
        for index, result in enumerate(pool.map(classify, tasks.items())):
            db.executemany('INSERT OR REPLACE INTO outlets VALUES (?,?)', result)
            db.commit()
            if index % 100 == 0:
                print(f'Blocks {index:,}/{len(tasks):,}', flush=True)
    print(db.execute('SELECT drainage, COUNT(*) FROM outlets GROUP BY drainage').fetchall(), flush=True)


if __name__ == '__main__':
    main()
