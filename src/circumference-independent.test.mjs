import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CIRCUMFERENCE_INTERIOR_OVERLAP_TOLERANCE_SQUARE_METERS,
  circumferenceInteriorOverlapSquareMeters,
  selectIndependentCircumferenceCandidates,
} from './circumference.js';

const squareCoordinates = (west, south, size) => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];
const independentCandidate = (id, areaSquareMeters, rideSegmentIds, coordinates) => ({
  id,
  areaSquareMeters,
  coordinates,
  lines: ['A', 'B'],
  segments: rideSegmentIds.map((segmentId) => ({
    id: segmentId,
    type: 'ride',
  })),
});

test('independent circle selection rejects shared, nested, and overlapping routes', () => {
  assert.deepEqual(
    selectIndependentCircumferenceCandidates([
      independentCandidate(
        'shared-rail-alternative',
        90,
        ['trunk', 'west'],
        squareCoordinates(20, 20, 1),
      ),
      {
        ...independentCandidate(
          'concentric-native-circle',
          80,
          ['native-a', 'native-b'],
          squareCoordinates(1, 1, 1),
        ),
        independentCircleKind: 'native-line',
        lines: ['Circle'],
      },
      independentCandidate(
        'partially-overlapping-circle',
        75,
        ['overlap-a', 'overlap-b'],
        squareCoordinates(3, 3, 2),
      ),
      independentCandidate(
        'eastern-circle',
        70,
        ['east-a', 'east-b'],
        squareCoordinates(5, 0, 1),
      ),
      independentCandidate(
        'boundary-touching-circle',
        65,
        ['touch-a', 'touch-b'],
        squareCoordinates(4, 0, 1),
      ),
      independentCandidate(
        'largest-circle',
        100,
        ['trunk', 'north'],
        squareCoordinates(0, 0, 4),
      ),
      independentCandidate(
        'southern-circle',
        60,
        ['south-a', 'south-b'],
        squareCoordinates(0, -2, 1),
      ),
    ]).map(({ id }) => id),
    ['largest-circle', 'eastern-circle', 'boundary-touching-circle', 'southern-circle'],
  );
  assert.ok(
    circumferenceInteriorOverlapSquareMeters(
      { coordinates: squareCoordinates(0, 0, 4) },
      { coordinates: squareCoordinates(1, 1, 1) },
    ) > 10_000_000_000,
  );
  assert.ok(
    circumferenceInteriorOverlapSquareMeters(
      { coordinates: squareCoordinates(0, 0, 4) },
      { coordinates: squareCoordinates(4, 0, 1) },
    ) <= CIRCUMFERENCE_INTERIOR_OVERLAP_TOLERANCE_SQUARE_METERS,
  );
});

test('real-path geometry, not ranking geometry, governs independence', () => {
  const rankedSeparateCandidates = [
    independentCandidate(
      'ranked-largest',
      100,
      ['ranked-largest-edge'],
      squareCoordinates(0, 0, 2),
    ),
    independentCandidate(
      'ranked-smaller',
      90,
      ['ranked-smaller-edge'],
      squareCoordinates(10, 10, 1),
    ),
  ];
  assert.deepEqual(
    selectIndependentCircumferenceCandidates(rankedSeparateCandidates, {
      spatialCandidatesById: new Map([
        ['ranked-largest', { coordinates: squareCoordinates(0, 0, 2) }],
        ['ranked-smaller', { coordinates: squareCoordinates(1, 1, 1) }],
      ]),
    }).map(({ id }) => id),
    ['ranked-largest'],
  );
});
