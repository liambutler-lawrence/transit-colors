import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
  CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
  circumferenceGradientBounds,
  circumferenceGradientOpacity,
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

test('the circumference gradient has a route-relative transparent 10 km edge', () => {
  const route = [
    [-74, 40.7],
    [-73.9, 40.8],
    [-74, 40.7],
  ];
  const [west, south, east, north] = circumferenceGradientBounds(route);

  assert.equal(CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS, 10_000);
  assert.ok(west < -74.12);
  assert.ok(south < 40.61);
  assert.ok(east > -73.78);
  assert.ok(north > 40.89);
  assert.equal(circumferenceGradientOpacity(0), 116);
  assert.equal(circumferenceGradientOpacity(5_000), 58);
  assert.equal(circumferenceGradientOpacity(9_999), 1);
  assert.equal(circumferenceGradientOpacity(10_000), 0);
  assert.equal(circumferenceGradientOpacity(20_000), 0);
});

test('the sidebar follows product, mode, results, and selection hierarchy', async () => {
  const shell = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  const productIndex = shell.indexOf('1 · Product');
  const accessModeIndex = shell.indexOf('<span class="section-eyebrow">Mode</span>');
  const accessResultsIndex = shell.indexOf(
    '<span class="section-eyebrow">Results</span>',
  );
  const accessSelectionIndex = shell.indexOf(
    '<span class="section-eyebrow">Selected item</span>',
  );

  assert.ok(productIndex >= 0);
  assert.ok(productIndex < accessModeIndex);
  assert.ok(accessModeIndex < accessResultsIndex);
  assert.ok(accessResultsIndex < accessSelectionIndex);
  assert.match(shell, />\s*Transit heatmap\s*</);
  assert.match(shell, />\s*Circumference routes\s*</);
  assert.match(shell, /id="circumference-results"/);
  assert.match(shell, /id="access-result-area"/);
  assert.doesNotMatch(shell, /<span>Focus on…<\/span>/);
});

test('circumference result cards focus an always-visible map', async () => {
  const shell = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const lifecycle = await readFile(
    new URL('./app/map-lifecycle.ts', import.meta.url),
    'utf8',
  );
  const circumferenceUi = await readFile(
    new URL('./app/circumference-ui.ts', import.meta.url),
    'utf8',
  );

  assert.match(shell, /Both metro networks stay visible/);
  assert.match(lifecycle, /AREA_KEYS\.map\(async \(areaKey\)/);
  assert.match(lifecycle, /circumference-gradient-\$\{areaKey\}/);
  assert.match(lifecycle, /button\[data-focus-area\]/);
  assert.match(lifecycle, /select\.dataset\['routeArea'\]/);
  assert.match(circumferenceUi, /dataset\['focusArea'\] = areaKey/);
  assert.match(circumferenceUi, /dataset\['routeArea'\] = areaKey/);
  assert.match(
    circumferenceUi,
    /AREA_KEYS\.flatMap\(\(areaKey\) =>[\s\S]*routeFeatureCollection/,
  );
});
