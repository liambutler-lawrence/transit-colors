import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

for (const [fixture, title, requiredWays] of [
  ['ramp-attachment-audit.json', 'published ramp repairs', [['9080553', '9080294']]],
  [
    'mixed-merge-audit.json',
    'published mixed motorway merges',
    [['100946830', '539942066'], ['562358000']],
  ],
  [
    'through-motorway-audit.json',
    'published motorway through connections',
    [['504329517']],
  ],
]) {
  test(`${title} retain their curves and both mainline connections across the network`, async () => {
    const audit = JSON.parse(
      await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'),
    );
    for (const wayIds of requiredWays) {
      assert.ok(
        audit.connectors.some((part) =>
          wayIds.every((id) => part.sourceWayIds.includes(id)),
        ),
      );
    }
    const handle = await open(
      new URL('../data/north-america-highways.pmtiles', import.meta.url),
    );
    try {
      const archive = new PMTiles({
        getKey: () => 'published-ramp-attachments',
        getBytes: async (offset, length) => {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return {
            data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
          };
        },
      });
      const layers = new Map();
      for (const connector of audit.connectors) {
        for (const [index, point] of connector.points.entries()) {
          const dimension = 2 ** 14;
          const x = Math.floor(((point[0] + 180) / 360) * dimension);
          const y = Math.floor(
            ((1 - Math.asinh(Math.tan((point[1] * Math.PI) / 180)) / Math.PI) / 2) *
              dimension,
          );
          const key = `${x},${y}`;
          if (!layers.has(key)) {
            const tile = await archive.getZxy(14, x, y);
            assert.ok(tile, `${connector.id} has a published tile`);
            layers.set(key, new VectorTile(new Pbf(tile.data)).layers['highways']);
          }
          const layer = layers.get(key);
          const touching = new Set();
          for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
            const feature = layer.feature(featureIndex);
            const geometry = feature.toGeoJSON(x, y, 14).geometry;
            const coordinates =
              geometry.type === 'LineString'
                ? geometry.coordinates
                : geometry.coordinates.flat();
            if (
              coordinates.some(
                (coordinate) => geodesicDistanceMeters(coordinate, point) < 2,
              )
            )
              touching.add(feature.properties.id);
          }
          assert.ok(
            touching.has(connector.id),
            `${connector.id} retains its corrected curve`,
          );
          if (index === 0)
            assert.ok(
              touching.has(connector.startMainlineId),
              `${connector.id} connects to its first mainline`,
            );
          if (index === connector.points.length - 1)
            assert.ok(
              touching.has(connector.endMainlineId),
              `${connector.id} connects to its second mainline`,
            );
        }
      }
    } finally {
      await handle.close();
    }
  });
}
