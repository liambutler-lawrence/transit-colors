import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import Pbf from 'pbf';

import {
  createTransitRoadTiles,
  isHeatmapRoadLayer,
  scoreRoadTile,
} from './transit-road-tiles.ts';
import { createStreetAccessScorer } from './routing.ts';

const position = { z: 14, x: 8192, y: 8192 };
const road = (id, roadClass, geometry, extra = {}) => ({
  id,
  type: 2,
  geometry,
  tags: { class: roadClass, name: `Street ${id}`, ...extra },
});
const fixture = fromGeojsonVt(
  {
    transportation: {
      features: [
        road(1, 'minor', [
          [
            [0, 100],
            [500, 100],
            [1000, 100],
            [4096, 100],
          ],
        ]),
        road(2, 'pedestrian', [
          [
            [500, 100],
            [500, 500],
          ],
        ]),
        road(
          3,
          'service',
          [
            [
              [0, 1000],
              [4096, 1000],
            ],
          ],
          { brunnel: 'bridge', ramp: 1 },
        ),
        road(
          4,
          'path',
          [
            [
              [-100, 1100],
              [4200, 1100],
            ],
          ],
          { brunnel: 'tunnel' },
        ),
        road(5, 'rail', [
          [
            [0, 1200],
            [4096, 1200],
          ],
        ]),
        road(6, 'transit', [
          [
            [0, 1300],
            [4096, 1300],
          ],
        ]),
        {
          id: 7,
          type: 3,
          geometry: [
            [
              [0, 0],
              [100, 0],
              [100, 100],
              [0, 100],
              [0, 0],
            ],
          ],
          tags: { class: 'pedestrian' },
        },
      ],
    },
    water: {
      features: [
        {
          id: 8,
          type: 3,
          geometry: [
            [
              [0, 0],
              [100, 0],
              [100, 100],
              [0, 100],
              [0, 0],
            ],
          ],
          tags: { class: 'lake' },
        },
      ],
    },
  },
  { version: 2, extent: 4096 },
).slice().buffer;
const decode = (data, name = 'transportation') => {
  const layer = new VectorTile(new Pbf(data)).layers[name];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i));
};
const points = (feature) =>
  feature.loadGeometry().map((line) => line.map(({ x, y }) => [x, y]));
const station = (id, longitude) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [longitude, 0] },
  properties: { id, mode: 'subway', status: 'open', name: id },
});

test('heatmap includes outlines, pedestrian streets, bridges and tunnels but excludes rail', async () => {
  const style = JSON.parse(
    await readFile(new URL('../vendor/openfreemap-liberty.json', import.meta.url)),
  );
  const layers = style.layers.filter(isHeatmapRoadLayer);
  assert.ok(layers.length > 30);
  for (const id of [
    'road_minor_casing',
    'road_minor',
    'road_path_pedestrian',
    'bridge_path_pedestrian',
    'tunnel_service_track',
    'road_motorway_link_casing',
  ]) {
    assert.ok(
      layers.some((layer) => layer.id === id),
      id,
    );
  }
  assert.ok(layers.every((layer) => !/rail|hatching/.test(layer.id)));
  assert.ok(!layers.some((layer) => layer.type !== 'line'));
});

test('shared tiles cover every road with continuous scored segments and preserve non-road geometry', async () => {
  const output = await scoreRoadTile(
    fixture,
    position,
    createStreetAccessScorer([station('near', 0)], { exhaustive: true }),
  );
  const features = decode(output);
  for (const name of ['Street 1', 'Street 2', 'Street 3', 'Street 4']) {
    const segments = features.filter((feature) => feature.properties.name === name);
    const original = decode(fixture).find(
      (feature) => feature.properties.name === name,
    );
    const originalLine = points(original)[0];
    assert.deepEqual(points(segments[0])[0][0], originalLine[0]);
    assert.deepEqual(points(segments.at(-1))[0].at(-1), originalLine.at(-1));
    const originalVertices = new Set(originalLine.map(String));
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      assert.equal(segment.properties.s, 'near');
      assert.ok(Number.isFinite(segment.properties.d));
      assert.equal(segment.properties.n, name);
      assert.equal(segment.properties.h, original.properties.class);
      assert.equal(segment.properties.brunnel, original.properties.brunnel);
      assert.equal(segment.properties.ramp, original.properties.ramp);
      for (const point of points(segment)[0]) originalVertices.delete(String(point));
      if (i) assert.deepEqual(points(segments[i - 1])[0].at(-1), points(segment)[0][0]);
    }
    assert.equal(originalVertices.size, 0, 'all original vertices survive');
  }
  const mainline = features.filter((feature) => feature.properties.name === 'Street 1');
  assert.ok(
    mainline.some((feature) => String(points(feature)[0].at(-1)) === '500,100'),
    'shared junction splits blocks',
  );
  assert.ok(
    new Set(mainline.map((feature) => feature.properties.d)).size > 5,
    'long roads keep local distance gradients',
  );
  assert.equal(
    new Set(
      features
        .filter((feature) => feature.properties.i)
        .map((feature) => feature.properties.i),
    ).size,
    features.filter((feature) => feature.properties.i).length,
  );
  for (const name of ['Street 5', 'Street 6']) {
    const original = decode(fixture).find(
      (feature) => feature.properties.name === name,
    );
    const result = features.find((feature) => feature.properties.name === name);
    assert.deepEqual(points(result), points(original));
    assert.deepEqual(result.properties, original.properties);
  }
  assert.deepEqual(
    points(features.find((feature) => feature.type === 3)),
    points(decode(fixture).find((feature) => feature.type === 3)),
  );
  assert.deepEqual(
    points(decode(output, 'water')[0]),
    points(decode(fixture, 'water')[0]),
  );
});

test('empty station filters retain road coverage and mark every road as far away', async () => {
  const features = decode(await scoreRoadTile(fixture, position, null));
  for (const feature of features.filter((feature) => feature.properties.i)) {
    assert.equal(feature.properties.d, 5000);
    assert.equal(feature.properties.s, undefined);
  }
});

test('road detail comes exclusively from the requested tile, including a road-free zoom', async () => {
  const empty = fromGeojsonVt({ water: { features: [] } }).slice().buffer;
  assert.equal(await scoreRoadTile(empty, { z: 2, x: 1, y: 1 }, null), empty);
  const overview = decode(await scoreRoadTile(fixture, { z: 2, x: 1, y: 1 }, null));
  assert.ok(overview.length < 1500, 'world tiles have bounded subdivision');
});

test('station changes replace tile versions; repeated camera refreshes do not reload data', () => {
  const protocol = createTransitRoadTiles();
  const templates = ['https://example.com/{z}/{x}/{y}.pbf'];
  assert.equal(protocol.setStations([station('a', 0)]), true);
  const first = protocol.urls(templates);
  assert.equal(protocol.setStations([station('a', 0)]), false);
  assert.deepEqual(protocol.urls(templates), first);
  assert.equal(protocol.setStations([station('b', 1)]), true);
  assert.notDeepEqual(protocol.urls(templates), first);
  assert.equal(protocol.setStations([]), true);
});

test('obsolete tile requests are cancelled before their scores can be published', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scoreRoadTile(fixture, position, null, controller.signal), {
    name: 'AbortError',
  });
});
