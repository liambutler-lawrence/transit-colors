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

test('published tiles omit audited nonreciprocal ramp curves across North America', async () => {
  const audit = JSON.parse(
    await readFile(
      new URL('./fixtures/nonreciprocal-ramp-audit.json', import.meta.url),
    ),
  );
  assert.ok(audit.removed.some((part) => part.sourceWayIds.includes('719052142')));
  const handle = await open(
    new URL('../data/north-america-highways.pmtiles', import.meta.url),
  );
  try {
    const archive = new PMTiles({
      getKey: () => 'published-reciprocal-directions',
      getBytes: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return {
          data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
        };
      },
    });
    for (const part of audit.removed) {
      if (!part.witness) continue;
      const point = part.witness;
      const x = Math.floor(((point[0] + 180) / 360) * 2 ** 14);
      const y = Math.floor(
        ((1 - Math.asinh(Math.tan((point[1] * Math.PI) / 180)) / Math.PI) / 2) *
          2 ** 14,
      );
      const tile = await archive.getZxy(14, x, y);
      if (!tile) continue;
      const layer = new VectorTile(new Pbf(tile.data)).layers.highways;
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.properties.role !== 'connector') continue;
        const geometry = feature.toGeoJSON(x, y, 14).geometry;
        const lines =
          geometry.type === 'LineString'
            ? [geometry.coordinates]
            : geometry.coordinates;
        assert.ok(
          lines.every((line) => distanceToLine(point, line) > 2),
          `${part.previousId} must not return as a false two-way connection`,
        );
      }
    }
  } finally {
    await handle.close();
  }
});
