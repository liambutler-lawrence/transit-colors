"""Run with the documented watershed Python environment, without network access."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np
import pyarrow as pa
import shapely


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


builder = module('build-primary-watersheds')
classifier = module('classify-watershed-outlets')


class PrimaryWatersheds(unittest.TestCase):
    def test_tributary_union_removes_internal_edge_and_excludes_coastal_composites(self):
        polygons = [shapely.box(0, 0, 1, 1), shapely.box(1, 0, 2, 1), shapely.box(2, 0, 3, 1), shapely.box(3, 0, 4, 1)]
        polygons = shapely.transform(polygons, lambda xy: xy / 3600)
        batch = pa.record_batch({'STRM_ID': [1, 2, 3, -1], 'Shape': shapely.to_wkb(polygons)})
        rows, unresolved = builder.process(batch, 'Shape', np.array([0, 10, 10, 20]))
        self.assertEqual(unresolved, 1)
        groups = {identifier: (count, shapely.from_wkb(wkb)) for identifier, count, wkb in rows}
        self.assertEqual(set(groups), {10, 20})
        self.assertEqual(groups[10][0], 2)
        self.assertTrue(shapely.equals(groups[10][1], shapely.box(0, 0, 2, 1)))
        self.assertFalse(shapely.intersects(shapely.boundary(groups[10][1]), shapely.Point(1, .5)))

    def test_source_lattice_must_match_before_snapping(self):
        with self.assertRaises(AssertionError):
            builder.dissolve(np.array([shapely.box(0, 0, .000123, .000123)]))

    def classify(self, array):
        class Raster:
            def read(self, *args, **kwargs):
                return array
        classifier.LOCAL.source = Raster()
        return classifier.classify(((0, 0), [(1, 10, 10)]))[0][1]

    def test_flow_to_sea_is_ocean_and_landlocked_zero_is_inland(self):
        grid = np.ones((512, 512), dtype='uint8')
        grid[:, 12:] = 255
        self.assertEqual(self.classify(grid), 'ocean')
        self.assertEqual(self.classify(np.zeros((512, 512), dtype='uint8')), 'inland')

    def test_ambiguous_and_unresolved_outlets_are_never_assigned_to_ocean(self):
        grid = np.ones((512, 512), dtype='uint8')
        grid[:, 12:] = 255
        grid[9, 9] = 0
        self.assertEqual(self.classify(grid), 'unverified')
        self.assertEqual(self.classify(np.full((512, 512), 255, dtype='uint8')), 'unverified')
        self.assertEqual(self.classify(np.ones((512, 512), dtype='uint8')), 'unverified')


if __name__ == '__main__':
    unittest.main()
