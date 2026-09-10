import assert from 'node:assert/strict';
import { open, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { highwayCircumferenceSummarySchema } from '../src/highway-circumference.ts';

test('compact highway summary retains route metrics and exact texture bounds without bulk geometry', async () => {
  const raw = await readFile(
    new URL(
      '../data/north-america-highway-circumference-summary.json',
      import.meta.url,
    ),
    'utf8',
  );
  assert.ok(raw.length < 10_000, 'the UI must not parse the continental geometry');
  const summary = highwayCircumferenceSummarySchema.parse(JSON.parse(raw));
  const full = JSON.parse(
    await readFile(
      new URL('../data/north-america-highway-circumference.json', import.meta.url),
      'utf8',
    ),
  );
  for (const key of [
    'id',
    'areaSquareMeters',
    'lengthMeters',
    'containedLandAreaSquareMeters',
    'outsideLandAreaSquareMeters',
  ]) {
    assert.equal(summary.route[key], full.route[key]);
  }
  assert.equal('coordinates' in summary.route, false);
  assert.equal('segments' in summary.route, false);
  assert.equal('mask' in summary.landmass, false);
  const [[west, south], [east, north]] = summary.route.bounds;
  for (const [x, y] of full.route.coordinates)
    assert.ok(x >= west && x <= east && y >= south && y <= north);
});

test('tiled highway display preserves full interior and both boundary roles at close zoom', async () => {
  const url = new URL('../data/north-america-highways-route.pmtiles', import.meta.url);
  assert.ok((await stat(url)).size < 100 * 1024 * 1024);
  const handle = await open(url);
  try {
    const archive = new PMTiles({
      getKey: () => 'highway-display',
      getBytes: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return {
          data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
        };
      },
    });
    const header = await archive.getHeader();
    assert.equal(header.maxZoom, 14);
    async function features(point, z) {
      const x = Math.floor(((point[0] + 180) / 360) * 2 ** z);
      const y = Math.floor(
        ((1 - Math.asinh(Math.tan((point[1] * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z,
      );
      const tile = await archive.getZxy(z, x, y);
      if (!tile) return [];
      const layer = new VectorTile(new Pbf(tile.data)).layers.boundary;
      return Array.from({ length: layer.length }, (_, i) =>
        layer.feature(i).toGeoJSON(x, y, z),
      );
    }
    for (const z of [4, 10, 14]) {
      assert.ok(
        (await features([-100, 40], z)).some(
          (f) => f.properties.kind === 'highway-inside',
        ),
        `interior exists at zoom ${z}`,
      );
    }
    assert.ok(
      !(await features([-130, 40], 14)).some(
        (f) => f.properties.kind === 'highway-inside',
      ),
    );
    const full = JSON.parse(
      await readFile(
        new URL('../data/north-america-highway-circumference.json', import.meta.url),
        'utf8',
      ),
    );
    for (const role of ['mainline', 'connector']) {
      const segments = full.route.segments.filter((s) => s.role === role);
      for (const index of [0, Math.floor(segments.length / 2), segments.length - 1]) {
        const point =
          segments[index].coordinates[
            Math.floor(segments[index].coordinates.length / 2)
          ];
        const matching = (await features(point, 14)).filter(
          (f) => f.properties.kind === `highway-route-${role}`,
        );
        assert.ok(matching.length > 0, `${role} boundary remains tiled`);
        assert.ok(matching.every((f) => Number.isInteger(f.properties.segment_id)));
      }
    }
  } finally {
    await handle.close();
  }
});
