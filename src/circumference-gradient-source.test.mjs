import assert from 'node:assert/strict';
import test from 'node:test';

import {
  circumferenceGradientCoordinates,
  createCircumferenceGradientSource,
} from './circumference-gradient-source.ts';

test('circumference gradient uses a refreshable image map source', () => {
  const bounds = [-99.42, 19.18, -98.84, 19.66];

  assert.deepEqual(circumferenceGradientCoordinates(bounds), [
    [-99.42, 19.66],
    [-98.84, 19.66],
    [-98.84, 19.18],
    [-99.42, 19.18],
  ]);
  assert.deepEqual(
    createCircumferenceGradientSource('data:image/png;base64,abc', bounds),
    {
      coordinates: [
        [-99.42, 19.66],
        [-98.84, 19.66],
        [-98.84, 19.18],
        [-99.42, 19.18],
      ],
      type: 'image',
      url: 'data:image/png;base64,abc',
    },
  );
});
