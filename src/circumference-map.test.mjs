import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
} from './circumference-map.ts';

test('the map starts as an atmospheric globe with a close-zoom transition', async () => {
  const shellStyle = JSON.parse(
    await readFile(
      new URL('../vendor/openfreemap-shell.json', import.meta.url),
      'utf8',
    ),
  );

  assert.equal(shellStyle.projection.type, 'globe');
  assert.deepEqual(shellStyle.sky['atmosphere-blend'], [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    1,
    5,
    0.85,
    7,
    0,
  ]);
});

test('the circumference gradient uses the detailed basemap shoreline', async () => {
  const basemap = JSON.parse(
    await readFile(
      new URL('../vendor/openfreemap-liberty.json', import.meta.url),
      'utf8',
    ),
  );
  const landmasses = JSON.parse(
    await readFile(
      new URL('../data/circumference-landmasses.json', import.meta.url),
      'utf8',
    ),
  );
  const coastLayer = basemap.layers.find(
    (layer) => layer.id === CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  );

  assert.equal(coastLayer?.type, 'fill');
  assert.equal(coastLayer?.['source-layer'], 'water');
  assert.equal(landmasses.mask_source_url, basemap.sources.openmaptiles.tiles[0]);
  assert.ok(CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE >= 1024);

  const detailedPointMinimums = {
    'american-mainland': 750,
    manhattan: 1_000,
    'long-island': 10_000,
    'roosevelt-island': 80,
  };
  for (const landmass of landmasses.areas.nyc.landmasses) {
    const pointCount = landmass.mask.reduce(
      (total, polygon) =>
        total + polygon.reduce((polygonTotal, ring) => polygonTotal + ring.length, 0),
      0,
    );
    assert.ok(pointCount >= detailedPointMinimums[landmass.id]);
  }
  assert.equal(
    landmasses.areas.nyc.landmasses.find(
      (landmass) => landmass.id === 'american-mainland',
    ).mask.length,
    2,
  );
});
