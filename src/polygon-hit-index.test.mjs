import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PolygonHitIndex } from './polygon-hit-index.ts';

test('finds points inside polygons and excludes holes', () => {
  const index = new PolygonHitIndex([
    {
      value: 'land',
      polygons: [
        [
          [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
            [-10, -10],
          ],
          [
            [-2, -2],
            [2, -2],
            [2, 2],
            [-2, 2],
            [-2, -2],
          ],
        ],
      ],
    },
  ]);

  assert.equal(index.find(5, 5), 'land');
  assert.equal(index.find(0, 0), null);
  assert.equal(index.find(20, 0), null);
});

test('finds polygons that cross the antimeridian', () => {
  const index = new PolygonHitIndex([
    {
      value: 'dateline',
      polygons: [
        [
          [
            [175, -5],
            [-175, -5],
            [-175, 5],
            [175, 5],
            [175, -5],
          ],
        ],
      ],
    },
  ]);

  assert.equal(index.find(179, 0), 'dateline');
  assert.equal(index.find(-179, 0), 'dateline');
  assert.equal(index.find(0, 0), null);
});

test('supports filtering overlapping values', () => {
  const polygons = [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  ];
  const index = new PolygonHitIndex([
    { value: 'first', polygons },
    { value: 'second', polygons },
  ]);

  assert.equal(
    index.find(5, 5, (value) => value === 'second'),
    'second',
  );
});

test('finds land and excludes ocean in the generated timezone map', async () => {
  const data = JSON.parse(
    await readFile(new URL('../data/timezone-skew-zones.geojson', import.meta.url)),
  );
  const index = new PolygonHitIndex(
    data.features.map(({ geometry, properties }) => ({
      polygons: geometry.coordinates,
      value: properties.timezone_name,
    })),
  );

  assert.equal(index.find(-0.1276, 51.5072), 'Europe/London');
  assert.equal(index.find(0, 0), null);
});
