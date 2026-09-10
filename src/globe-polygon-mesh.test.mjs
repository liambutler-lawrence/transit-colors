import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  GLOBE_MESH_MAX_MERCATOR_SPAN,
  GLOBE_NORTH_POLE_Y,
  GLOBE_SOUTH_POLE_Y,
  triangulateGlobePolygons,
} from './globe-polygon-mesh.ts';
import { PolygonHitIndex } from './polygon-hit-index.ts';
import { polygonOutlines } from './polygon-outlines.ts';

function latitude(y) {
  if (y === GLOBE_NORTH_POLE_Y) return 90;
  if (y === GLOBE_SOUTH_POLE_Y) return -90;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

function geographicTriangles(mesh) {
  const triangles = [];
  for (let i = 0; i < mesh.coordinates.length; i += 9) {
    triangles.push(
      [0, 3, 6].map((j) => [
        mesh.coordinates[i + j + 2],
        latitude(mesh.coordinates[i + j + 1]),
      ]),
    );
  }
  return triangles;
}

function coverage(triangles, point) {
  const cross = (a, b) =>
    (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return triangles.filter(([a, b, c]) => {
    const sides = [cross(a, b), cross(b, c), cross(c, a)];
    return sides.every((side) => side > 0) || sides.every((side) => side < 0);
  }).length;
}

function triangleSpans(coordinates) {
  const spans = [];
  for (let index = 0; index < coordinates.length; index += 9) {
    const xValues = [
      coordinates[index],
      coordinates[index + 3],
      coordinates[index + 6],
    ];
    const yValues = [
      coordinates[index + 1],
      coordinates[index + 4],
      coordinates[index + 7],
    ];
    spans.push(
      Math.max(
        Math.max(...xValues) - Math.min(...xValues),
        Math.max(...yValues) - Math.min(...yValues),
      ),
    );
  }
  return spans;
}

test('globe polygons are subdivided before nonlinear projection', () => {
  const mesh = triangulateGlobePolygons([
    [
      [
        [-30, -20],
        [30, -20],
        [30, 20],
        [-30, 20],
        [-30, -20],
      ],
    ],
  ]);

  assert.ok(mesh.coordinates.length > 18);
  assert.ok(
    triangleSpans(mesh.coordinates).every(
      (span) => span <= GLOBE_MESH_MAX_MERCATOR_SPAN + 1e-7,
    ),
  );
});

test('dateline polygons stay local instead of spanning the world', () => {
  const mesh = triangulateGlobePolygons([
    [
      [
        [179, -2],
        [-179, -2],
        [-179, 2],
        [179, 2],
        [179, -2],
      ],
    ],
  ]);
  const xValues = [];
  for (let index = 0; index < mesh.coordinates.length; index += 3) {
    xValues.push(mesh.coordinates[index]);
  }

  assert.ok(Math.max(...xValues) - Math.min(...xValues) < 0.01);
  assert.ok(Math.min(...xValues) > 0.99);
});

test('both poles have finite, subdivided geometry up to the exact pole', () => {
  for (const sign of [-1, 1]) {
    const coast = [-180, -90, 0, 90, 180].map((x) => [x, sign * 80]);
    const ring = [...coast, [180, sign * 90], [-180, sign * 90], coast[0]];
    const mesh = triangulateGlobePolygons([[ring]]);
    assert.ok(mesh.coordinates.every(Number.isFinite));
    assert.ok(
      mesh.coordinates.includes(sign > 0 ? GLOBE_NORTH_POLE_Y : GLOBE_SOUTH_POLE_Y),
    );
    const triangles = geographicTriangles(mesh);
    for (const triangle of triangles) {
      for (let i = 0; i < 3; i++) {
        const a = triangle[i];
        const b = triangle[(i + 1) % 3];
        assert.ok(
          Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) <=
            360 * GLOBE_MESH_MAX_MERCATOR_SPAN + 1e-4,
        );
      }
    }
    for (const longitude of [-179.73, -110.37, -0.37, 70.37, 179.73]) {
      assert.equal(coverage(triangles, [longitude, sign * 89.73]), 1);
    }
    assert.deepEqual(polygonOutlines([[ring]]), [coast]);
  }
});

test('Antarctica has no polar hole or date-line slit and remains selectable', async () => {
  const data = JSON.parse(
    await readFile(new URL('../data/timezone-automatic-regions.json', import.meta.url)),
  );
  const polygons = data.regions.find(({ id }) => id === 'country:ATA').geometry
    .coordinates;
  const triangles = geographicTriangles(triangulateGlobePolygons(polygons));
  const hitIndex = new PolygonHitIndex([{ polygons, value: 'Antarctica' }]);
  for (let longitude = -179.73; longitude < 180; longitude += 15) {
    const point = [longitude, -89.73];
    assert.equal(coverage(triangles, point), 1, `continuous fill at ${longitude}`);
    assert.equal(hitIndex.find(...point), 'Antarctica');
  }
  assert.equal(hitIndex.find(0, -60), null, 'Southern Ocean stays outside the region');
  const outlines = polygonOutlines(polygons);
  assert.ok(outlines.every((line) => line.every(([, y]) => Math.abs(y) < 90)));
  // The true coastline, including the Ross Ice Shelf beyond Mercator's limit,
  // survives removal of the artificial closure.
  assert.ok(
    outlines.some((line) => line.some(([x, y]) => x === -156.00841 && y === -85.22194)),
  );
});

test('ordinary borders and real polar-sector boundaries are retained', () => {
  const ring = [
    [0, -80],
    [20, -80],
    [20, -90],
    [0, -90],
    [0, -80],
  ];
  assert.deepEqual(polygonOutlines([[ring]]), [ring]);
});
