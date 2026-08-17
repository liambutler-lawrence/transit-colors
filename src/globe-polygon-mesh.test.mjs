import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GLOBE_MESH_MAX_MERCATOR_SPAN,
  triangulateGlobePolygons,
} from './globe-polygon-mesh.ts';

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
