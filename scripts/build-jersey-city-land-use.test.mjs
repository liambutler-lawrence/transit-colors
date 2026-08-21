import assert from 'node:assert/strict';
import test from 'node:test';

import {
  featureAtPoint,
  geometryContainsPoint,
  representativePoint,
} from './build-jersey-city-land-use.mjs';

const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [8, 0],
      [8, 8],
      [0, 8],
      [0, 0],
    ],
    [
      [3, 3],
      [5, 3],
      [5, 5],
      [3, 5],
      [3, 3],
    ],
  ],
};

test('point-in-polygon respects holes', () => {
  assert.equal(geometryContainsPoint(polygon, [1, 1]), true);
  assert.equal(geometryContainsPoint(polygon, [4, 4]), false);
  assert.equal(geometryContainsPoint(polygon, [9, 9]), false);
});

test('representative points stay inside an ordinary parcel', () => {
  const point = representativePoint(polygon);
  assert.equal(geometryContainsPoint(polygon, point), true);
});

test('overlay lookup returns only the polygon containing the parcel point', () => {
  const feature = { type: 'Feature', properties: { zone: 'R-1' }, geometry: polygon };
  const searchable = [{ feature, bbox: [0, 0, 8, 8] }];
  assert.equal(featureAtPoint(searchable, [1, 1]), feature);
  assert.equal(featureAtPoint(searchable, [4, 4]), undefined);
});
