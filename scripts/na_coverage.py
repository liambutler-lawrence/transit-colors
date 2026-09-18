"""Preserve the existing precise North American layer when adding missing islands.

Reject a supplemental GRIT basin if any of its polygon overlaps or touches an
existing HydroSHEDS basin. Never cut a primary basin at a rectangular extent.
The temporary spatial index stores byte offsets, so the 3 GB source need not be
held in memory. Existing groundwater joins do not change the combined footprint.
"""
import os
from pathlib import Path
from functools import lru_cache
import numpy as np
import shapely

CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
SOURCE = CACHE / 'north-america-primary-watersheds.geojsonl'


class NorthAmericaCoverage:
    def __init__(self):
        path = CACHE / 'watersheds-na-footprint-index.npz'
        if not path.exists():
            bounds, offsets, lengths = [], [], []
            with SOURCE.open('rb') as stream:
                offset = 0
                for line in stream:
                    geometry = shapely.from_geojson(line.decode())
                    bounds.append(geometry.bounds)
                    offsets.append(offset)
                    lengths.append(len(line))
                    offset += len(line)
            np.savez(path, bounds=np.array(bounds), offsets=np.array(offsets), lengths=np.array(lengths), source_bytes=SOURCE.stat().st_size)
        index = np.load(path)
        assert index['source_bytes'] == SOURCE.stat().st_size
        bounds = index['bounds']
        self.tree = shapely.STRtree(shapely.box(bounds[:, 0], bounds[:, 1], bounds[:, 2], bounds[:, 3]))
        self.offsets, self.lengths = index['offsets'], index['lengths']
        self.stream = SOURCE.open('rb')

    @lru_cache(maxsize=128)
    def geometry(self, index):
        self.stream.seek(int(self.offsets[index]))
        return shapely.from_geojson(self.stream.read(int(self.lengths[index])).decode())

    def intersects(self, geometry):
        return any(geometry.intersects(self.geometry(int(i))) for i in self.tree.query(geometry))


if __name__ == '__main__':
    coverage = NorthAmericaCoverage()
    print('Indexed', len(coverage.offsets), 'existing basin footprints', flush=True)
