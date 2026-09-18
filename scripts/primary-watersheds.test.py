"""Run with the documented watershed Python environment, without network access."""
import importlib.util
import json
import tempfile
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
corrections = module('watershed_corrections')


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

    def test_groundwater_union_fills_hole_without_retaining_sink_boundary(self):
        def feature(identifier, geometry, area, count):
            return {'type': 'Feature', 'id': identifier, 'properties': {'id': identifier, 'area_km2': area, 'catchments': count, 'outlet_stream': 100 + identifier}, 'geometry': json.loads(shapely.to_geojson(geometry))}
        hole = shapely.box(1, 1, 2, 2)
        parent = feature(1, shapely.box(0, 0, 3, 3).difference(hole), 90000, 20)
        child = feature(2, hole, 999999, 3)
        merged = corrections.merge_features(parent, [child])
        geometry = shapely.from_geojson(json.dumps(merged))
        self.assertTrue(shapely.equals(geometry, shapely.box(0, 0, 3, 3)))
        self.assertFalse(shapely.intersects(shapely.boundary(geometry), shapely.Point(1, 1.5)))
        self.assertEqual(merged['properties']['catchments'], 23)
        self.assertEqual(merged['properties']['outlet_stream'], 101)
        self.assertEqual(merged['properties']['karst_connections'], 1)
        self.assertTrue(100000 < merged['properties']['area_km2'] < 110000)
        self.assertEqual(parent['properties']['catchments'], 20)
        with self.assertRaisesRegex(AssertionError, 'overlaps'):
            corrections.merge_features(parent, [parent])

    def test_groundwater_connections_require_matching_reviewed_sink(self):
        def feature(identifier, geometry):
            return {'type': 'Feature', 'id': identifier, 'properties': {'id': identifier, 'area_km2': 100, 'catchments': 1}, 'geometry': json.loads(shapely.to_geojson(geometry))}
        child = feature(2, shapely.box(1, 1, 2, 2))
        parent = feature(1, shapely.box(0, 0, 3, 3).difference(shapely.box(1, 1, 2, 2)))
        link = {'source_basins': [2], 'target_basin': 1, 'modeled_sink': [1, 1], 'source_url': 'https://example.org/evidence', 'evidence': 'Tracer connection', 'downstream_route': 'Spring to river'}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.geojsonl'
            source.write_text(''.join(json.dumps(f, separators=(',', ':')) + '\n' for f in [parent, child]))
            replacements, removed = corrections.prepare(source, {2: (1, 1)}, {1: 'ocean', 2: 'inland'}, {'connections': [link]})
            self.assertEqual(set(replacements), {1})
            self.assertEqual(removed, {2})
            with self.assertRaisesRegex(AssertionError, 'sink has moved'):
                corrections.prepare(source, {2: (1.01, 1)}, {1: 'ocean', 2: 'inland'}, {'connections': [link]})
            with self.assertRaisesRegex(AssertionError, 'assigned twice'):
                corrections.prepare(source, {2: (1, 1)}, {1: 'ocean', 2: 'inland'}, {'connections': [link, link]})
            with self.assertRaisesRegex(AssertionError, 'terminal node has changed'):
                corrections.prepare(source, {1: (0, 0), 2: (1, 1)}, {1: 'ocean', 2: 'inland'}, {'connections': [{**link, 'terminal_node': 999}]}, {1: 100, 2: 200})

    def test_shared_nodes_merge_and_equal_coordinates_alone_do_not(self):
        nodes = {10: 100, 11: 100, 12: 101}
        outlets = {10: (1, 1), 11: (1, 1), 12: (1, 1)}
        drainage = {i: 'inland' for i in nodes}
        self.assertEqual(corrections.terminal_groups(nodes, outlets, drainage), {10: [10, 11], 12: [12]})
        with self.assertRaisesRegex(AssertionError, 'inconsistent coordinates'):
            corrections.terminal_groups(nodes, {**outlets, 11: (1.00001, 1)}, drainage)
        with self.assertRaisesRegex(AssertionError, 'inconsistent drainage'):
            corrections.terminal_groups(nodes, outlets, {**drainage, 11: 'ocean'})
        features = [{'type': 'Feature', 'id': i, 'properties': {'id': i, 'area_km2': 999999, 'catchments': 2}, 'geometry': json.loads(shapely.to_geojson(shapely.box(i-10, 0, i-9, 1)))} for i in nodes]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.geojsonl'
            source.write_text(''.join(json.dumps(f, separators=(',', ':')) + '\n' for f in features))
            replacements, removed = corrections.prepare(source, outlets, drainage, {'connections': []}, nodes)
            self.assertEqual(removed, {11})
            self.assertEqual(set(replacements), {10})
            merged = replacements[10]
            self.assertTrue(shapely.equals(shapely.from_geojson(json.dumps(merged)), shapely.box(0, 0, 2, 1)))
            self.assertEqual(merged['properties']['catchments'], 4)
            self.assertEqual(merged['properties']['source_basins'], 2)
            self.assertNotIn('karst_connections', merged['properties'])
            self.assertTrue(24000 < merged['properties']['area_km2'] < 25000)

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
