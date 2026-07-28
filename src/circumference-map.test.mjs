import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
  CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
  circumferenceGradientBounds,
  circumferenceGradientOpacity,
  renderCircumferenceGradient,
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
  assert.ok(landmasses.areas.nyc.mask.length > 4);
  assert.ok(
    landmasses.areas.nyc.mask.some(([outerRing]) =>
      pointInRing([-74.075, 40.643], outerRing),
    ),
    'the nearby-land mask includes Staten Island',
  );
});

function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = ring.length - 1;
    currentIndex < ring.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    if (
      current[1] > latitude !== previous[1] > latitude &&
      longitude <
        ((previous[0] - current[0]) * (latitude - current[1])) /
          (previous[1] - current[1]) +
          current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

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

test('the circumference gradient radiates on both sides of a closed route', () => {
  let renderedImage;
  const context = {
    clearRect() {},
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) {
      renderedImage = image;
    },
  };
  const canvas = {
    getContext: () => context,
    height: 21,
    width: 21,
  };
  const bounds = [-0.02, -0.02, 0.02, 0.02];
  const route = [
    [-0.01, -0.01],
    [0.01, -0.01],
    [0.01, 0.01],
    [-0.01, 0.01],
    [-0.01, -0.01],
  ];

  renderCircumferenceGradient(canvas, route, bounds, [], 5_000);

  const alphaAt = (x, y) => renderedImage.data[(y * canvas.width + x) * 4 + 3];
  assert.ok(alphaAt(10, 10) > 0, 'inside-side pixel has gradient alpha');
  assert.ok(alphaAt(3, 10) > 0, 'outside-side pixel has gradient alpha');
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

test('circle result cards focus an always-visible global network', async () => {
  const shell = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const lifecycle = await readFile(
    new URL('./app/map-lifecycle.ts', import.meta.url),
    'utf8',
  );
  const circumferenceUi = await readFile(
    new URL('./app/circumference-ui.ts', import.meta.url),
    'utf8',
  );

  assert.match(shell, /All metro networks stay visible/);
  assert.match(shell, /Valid circles by area/);
  assert.match(lifecycle, /AREA_KEYS\.map\(async \(areaKey\)/);
  assert.match(lifecycle, /circumference-gradient-\$\{areaKey\}/);
  assert.match(lifecycle, /button\[data-focus-area\]\[data-focus-candidate\]/);
  assert.doesNotMatch(lifecycle, /select\.dataset\['routeArea'\]/);
  assert.match(circumferenceUi, /dataset\['focusArea'\] = areaKey/);
  assert.match(circumferenceUi, /dataset\['focusCandidate'\] = candidate\.id/);
  assert.match(
    circumferenceUi,
    /AREA_KEYS\.flatMap\(\(areaKey\) => \{[\s\S]*candidates\.map\(\(candidate, index\)/,
  );
  assert.match(
    circumferenceUi,
    /compareCircleArea\(first\.candidate, second\.candidate\)/,
  );
  assert.match(circumferenceUi, /isFocused && landmassArea/);
  assert.match(circumferenceUi, /network\.segments\.length > 0/);
  assert.match(
    circumferenceUi,
    /AREA_KEYS\.flatMap\(\(areaKey\) =>[\s\S]*routeFeatureCollection/,
  );
});
