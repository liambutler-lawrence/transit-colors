"""Retry uncertain endpoint types with longer D8 traces across raster-block edges."""
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
import importlib.util
from pathlib import Path
import sqlite3
import threading

import rasterio
from rasterio.windows import Window

spec = importlib.util.spec_from_file_location('outlets', Path(__file__).with_name('classify-watershed-outlets.py'))
outlets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(outlets)
LOCAL = threading.local()


def resolve(task):
    identifier, lon, lat = task
    try:
        if not hasattr(LOCAL, 'source'):
            LOCAL.source = rasterio.open('/vsicurl/' + outlets.URL)
            LOCAL.cache = OrderedDict()

        def value(row, col):
            if row < 0 or col < 0 or row >= LOCAL.source.height or col >= LOCAL.source.width:
                raise ValueError('Trace leaves source coverage')
            block = row // 512, col // 512
            if block not in LOCAL.cache:
                LOCAL.cache[block] = LOCAL.source.read(1, window=Window(block[1] * 512, block[0] * 512, 512, 512), boundless=True, fill_value=255)
                if len(LOCAL.cache) > 32:
                    LOCAL.cache.popitem(last=False)
            return int(LOCAL.cache[block][row % 512, col % 512])

        col, row = int(round((lon + 170) * 3600)), int(round((84 - lat) * 3600))
        outcomes = set()
        for dr, dc in [(0, 0), (-1, 0), (0, -1), (-1, -1)]:
            r, c = row + dr, col + dc
            if value(r, c) == 255:
                continue
            seen = set()
            for _ in range(4096):
                if (r, c) in seen:
                    outcomes.add('unverified')
                    break
                seen.add((r, c))
                code = value(r, c)
                if code == 255:
                    outcomes.add('ocean')
                    break
                if code == 0:
                    sea = any(value(r + dy, c + dx) == 255 for dy in [-1, 0, 1] for dx in [-1, 0, 1])
                    outcomes.add('ocean' if sea else 'inland')
                    break
                if code not in outlets.D8:
                    outcomes.add('unverified')
                    break
                dy, dx = outlets.D8[code]
                r, c = r + dy, c + dx
            else:
                outcomes.add('unverified')
        return next(iter(outcomes)) if len(outcomes) == 1 else 'unverified', identifier
    except Exception as error:
        print(f'Outlet {identifier} remains unverified: {error}', flush=True)
        return 'unverified', identifier


def main():
    data = outlets.extract()
    db = sqlite3.connect(outlets.CACHE / 'watersheds-v2-outlets.sqlite')
    uncertain = {row[0] for row in db.execute("SELECT id FROM outlets WHERE drainage='unverified'")}
    tasks = [(int(identifier), *coordinate) for identifier, coordinate in zip(data['id'], data['coordinates']) if int(identifier) in uncertain]
    print(f'Rechecking {len(tasks)} uncertain terminal types', flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for index, result in enumerate(pool.map(resolve, tasks)):
            db.execute('UPDATE outlets SET drainage=? WHERE id=?', result)
            db.commit()
            if index % 50 == 0:
                print(f'Checked {index}/{len(tasks)}', flush=True)
    print(db.execute('SELECT drainage, COUNT(*) FROM outlets GROUP BY drainage').fetchall(), flush=True)


if __name__ == '__main__':
    main()
