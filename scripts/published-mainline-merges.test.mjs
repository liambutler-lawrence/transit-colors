import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';

function distanceToLine(point, coordinates) {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  return Math.min(
    ...coordinates.slice(1).map((b, index) => {
      const a = coordinates[index];
      const x = (a[0] - point[0]) * 111320 * scale;
      const y = (a[1] - point[1]) * 110574;
      const dx = (b[0] - a[0]) * 111320 * scale;
      const dy = (b[1] - a[1]) * 110574;
      const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x + t * dx, y + t * dy);
    }),
  );
}

test('published mainline merges omit crossed pairs and keep the clean continuing geometry', async () => {
  const audit = JSON.parse(
    await readFile(
      new URL('./fixtures/covered-mainline-merge-audit.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(audit.merges.some((merge) => merge.removedId === 'osm-mainline-6512'));
  const handle = await open(
    new URL('../data/north-america-highways.pmtiles', import.meta.url),
  );
  try {
    const archive = new PMTiles({
      getKey: () => 'published-mainline-merges',
      getBytes: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return {
          data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
        };
      },
    });
    for (const merge of audit.merges) {
      const tiles = new Map();
      for (const point of [
        ...merge.points,
        ...merge.mainlines.flatMap((part) => part.points),
      ]) {
        const x = Math.floor(((point[0] + 180) / 360) * 2 ** 14);
        const y = Math.floor(
          ((1 - Math.asinh(Math.tan((point[1] * Math.PI) / 180)) / Math.PI) / 2) *
            2 ** 14,
        );
        tiles.set(`${x},${y}`, { x, y });
      }
      const seen = new Set();
      for (const { x, y } of tiles.values()) {
        const tile = await archive.getZxy(14, x, y);
        if (!tile) continue;
        const layer = new VectorTile(new Pbf(tile.data)).layers.highways;
        for (let i = 0; i < layer.length; i += 1) {
          const feature = layer.feature(i);
          assert.notEqual(
            feature.properties.id,
            merge.removedId,
            `${merge.removedId} must not return as a spurious merge centerline`,
          );
          const expected = merge.mainlines.find(
            (part) => part.id === feature.properties.id,
          );
          if (!expected) continue;
          const geometry = feature.toGeoJSON(x, y, 14).geometry;
          const points =
            geometry.type === 'LineString'
              ? geometry.coordinates
              : geometry.coordinates.flat();
          for (const point of points) {
            const [west, south, east, north] = merge.bounds;
            if (
              point[0] <= west ||
              point[0] >= east ||
              point[1] <= south ||
              point[1] >= north
            )
              continue;
            seen.add(expected.id);
            assert.ok(
              distanceToLine(point, expected.points) < 2,
              `${expected.id} must stay on its clean midpoint geometry through the merge`,
            );
          }
        }
      }
      for (const part of merge.mainlines)
        assert.ok(seen.has(part.id), `${part.id} remains published`);
    }
  } finally {
    await handle.close();
  }
});
