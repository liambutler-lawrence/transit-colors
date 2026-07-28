import assert from 'node:assert/strict';

import {
  averageShapeSections,
  buildGtfsShapeCenterlines,
  extractClosedShapeSection,
  extractShapeSection,
  resampleLine,
} from './gtfs-shape-centerlines.mjs';

const firstSide = [
  [0, 0],
  [0.005, 0.002],
  [0.01, 0],
];
const secondSide = [
  [0.01, 0],
  [0.005, -0.002],
  [0, 0],
];
const average = averageShapeSections([firstSide, [...secondSide].reverse()]);
assert.deepEqual(average[0], [0, 0]);
assert.deepEqual(average.at(-1), [0.01, 0]);
assert.ok(Math.abs(average[Math.floor(average.length / 2)][1]) < 1e-9);
assert.equal(resampleLine(firstSide, 5).length, 5);

const section = extractShapeSection(
  [
    [-0.005, 0],
    [0, 0],
    [0.005, 0.002],
    [0.01, 0],
    [0.015, 0],
  ],
  [0, 0],
  [0.01, 0],
);
assert.ok(section.length > 2);
assert.deepEqual(section[0], [0, 0]);
assert.deepEqual(section.at(-1), [0.01, 0]);

const seamSection = extractClosedShapeSection(
  [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
    [0, 0],
  ],
  [0, 0.009],
  [0.001, 0],
);
assert.ok(seamSection.length >= 3);
assert.ok(seamSection.every(([longitude]) => longitude < 0.002));

const built = buildGtfsShapeCenterlines({
  shapes: [
    ['out', 0, 0, 0],
    ['out', 1, 0.002, 0.005],
    ['out', 2, 0, 0.01],
    ['back', 0, 0, 0.01],
    ['back', 1, -0.002, 0.005],
    ['back', 2, 0, 0],
  ].map(([shape_id, shape_pt_sequence, shape_pt_lat, shape_pt_lon]) => ({
    shape_id,
    shape_pt_sequence,
    shape_pt_lat,
    shape_pt_lon,
  })),
  trips: [
    { trip_id: 'out', route_id: 'line', shape_id: 'out' },
    { trip_id: 'back', route_id: 'line', shape_id: 'back' },
  ],
  stopTimes: [
    { trip_id: 'out', stop_id: 'a', stop_sequence: 1 },
    { trip_id: 'out', stop_id: 'b', stop_sequence: 2 },
    { trip_id: 'back', stop_id: 'b', stop_sequence: 1 },
    { trip_id: 'back', stop_id: 'a', stop_sequence: 2 },
  ],
  stationCoordinateById: new Map([
    ['a', [0, 0]],
    ['b', [0.01, 0]],
  ]),
  stationIdForStop: (stopId) => stopId,
});
const centerline = built.geometries.a[0][1];
assert.equal(built.edgeCount, 1);
assert.equal(built.observationCount, 2);
assert.ok(Math.abs(centerline[Math.floor(centerline.length / 2)][1]) < 1e-9);
