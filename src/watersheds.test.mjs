import assert from 'node:assert/strict';
import { open, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';
import {
  WATERSHED_LEVELS,
  watershedDrainageLabel,
  watershedLevel,
  watershedPropertiesSchema,
} from './watersheds.ts';

test('invalid detail links fall back to regional basins; inland sinks are not coastal outlets', () => {
  for (const value of [null, '', '12', 'constructor'])
    assert.equal(watershedLevel(value), 6);
  assert.equal(watershedLevel('4'), 4);
  assert.equal(watershedLevel('8'), 8);
  assert.match(watershedDrainageLabel(2, 0), /Inland sink/);
  assert.match(watershedDrainageLabel(1, 0), /inland-draining/);
  assert.match(watershedDrainageLabel(0, 1), /coastal/);
});

test('shipped watershed hierarchy covers America, Arctic Canada, and Greenland at every level', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../data/north-america-watersheds-summary.json', import.meta.url),
      'utf8',
    ),
  );
  let previousCount = 0;
  for (const level of WATERSHED_LEVELS) {
    const summary = manifest.levels[level];
    assert.ok(summary.count > previousCount);
    previousCount = summary.count;
    assert.ok(
      Math.abs(summary.area_km2 - manifest.levels[4].area_km2) < 100,
      'Subdividing basins preserves total coverage',
    );
    const file = new URL(
      `../data/north-america-watersheds-${level}.pmtiles`,
      import.meta.url,
    );
    assert.equal((await stat(file)).size, summary.bytes);
    assert.ok(summary.bytes < 100 * 1024 * 1024);
    const handle = await open(file);
    try {
      const archive = new PMTiles({
        getKey: () => `watersheds-test-${level}`,
        getBytes: async (offset, length) => {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return {
            data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
          };
        },
      });
      const root = await archive.getZxy(0, 0, 0);
      assert.ok(root, 'Continental overview tile exists');
      const layer = new VectorTile(new Pbf(root.data)).layers['basins'];
      const regions = new Set();
      for (let index = 0; index < layer.length; index++) {
        const basin = watershedPropertiesSchema.parse(layer.feature(index).properties);
        assert.equal(basin.level, level);
        regions.add(basin.region);
      }
      assert.deepEqual([...regions].sort(), ['ar', 'gr', 'na']);
      // Exercise full-detail tiles near Mexico, the US, Canada, Alaska,
      // Central America, the Caribbean, Arctic Canada, and Greenland.
      for (const [longitude, latitude] of [
        [-99, 19],
        [-105, 40],
        [-80, 48],
        [-150, 65],
        [-85, 13],
        [-77, 21],
        [-95, 68],
        [-45, 65],
      ]) {
        const z = 9;
        const x = Math.floor(((longitude + 180) / 360) * 2 ** z);
        const y = Math.floor(
          ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
            2 ** z,
        );
        const tile = await archive.getZxy(z, x, y);
        assert.ok(tile, `Missing basin tile near ${longitude}, ${latitude}`);
        const basins = new VectorTile(new Pbf(tile.data)).layers['basins'];
        assert.ok(basins.length > 0);
        for (let index = 0; index < basins.length; index++)
          watershedPropertiesSchema.parse(basins.feature(index).properties);
      }
    } finally {
      await handle.close();
    }
  }
});
