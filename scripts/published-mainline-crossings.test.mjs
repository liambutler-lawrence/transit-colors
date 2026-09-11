import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';

function distanceToLine(point, coordinates) {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  return Math.min(
    ...coordinates.slice(1).map((end, index) => {
      const start = coordinates[index];
      const x = (start[0] - point[0]) * 111_320 * scale;
      const y = (start[1] - point[1]) * 110_574;
      const dx = (end[0] - start[0]) * 111_320 * scale;
      const dy = (end[1] - start[1]) * 110_574;
      const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x + t * dx, y + t * dy);
    }),
  );
}

const inside = (point, [west, south, east, north]) =>
  point[0] > west && point[0] < east && point[1] > south && point[1] < north;

test('published source-interval repairs retain clean mainlines at merges and grade-separated crossings', async () => {
  const audit = JSON.parse(
    await readFile(
      new URL('./fixtures/mainline-source-interval-audit.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(
    audit.cases.length >= 5,
    'published checks cover more than the reported interchange',
  );
  const handle = await open(
    new URL('../data/north-america-highways.pmtiles', import.meta.url),
  );
  try {
    const archive = new PMTiles({
      getKey: () => 'mainline-source-intervals',
      getBytes: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return {
          data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
        };
      },
    });
    for (const item of audit.cases) {
      const [west, south, east, north] = item.bounds;
      const tileX = (longitude) => Math.floor(((longitude + 180) / 360) * 2 ** 14);
      const tileY = (latitude) =>
        Math.floor(
          ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
            2 ** 14,
        );
      const seen = new Set();
      for (let x = tileX(west); x <= tileX(east); x += 1)
        for (let y = tileY(north); y <= tileY(south); y += 1) {
          const tile = await archive.getZxy(14, x, y);
          if (!tile) continue;
          const layer = new VectorTile(new Pbf(tile.data)).layers.highways;
          if (!layer) continue;
          for (let index = 0; index < layer.length; index += 1) {
            const feature = layer.feature(index);
            if (feature.properties.role !== 'mainline') continue;
            const geometry = feature.toGeoJSON(x, y, 14).geometry;
            const lines =
              geometry.type === 'LineString'
                ? [geometry.coordinates]
                : geometry.coordinates;
            const localPoints = lines
              .flat()
              .filter((point) => inside(point, item.bounds));
            if (localPoints.length === 0) continue;
            const expected = item.mainlines.find(
              (part) => part.id === feature.properties.id,
            );
            assert.ok(
              expected,
              `${item.name}: no extra mainline spur ${feature.properties.id}`,
            );
            seen.add(expected.id);
            for (const point of localPoints)
              assert.ok(
                expected.lines.some((line) => distanceToLine(point, line) < 2),
                `${item.name}: ${expected.id} stays on its supported midpoint`,
              );
          }
        }
      for (const part of item.mainlines)
        assert.ok(seen.has(part.id), `${item.name}: ${part.id} remains published`);
    }
  } finally {
    await handle.close();
  }
});
