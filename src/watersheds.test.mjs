import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';
import { MultipartPMTilesSource } from './multipart-pmtiles.ts';
import { watershedDrainageLabel, watershedPropertiesSchema } from './watersheds.ts';

const data = (name) => new URL(`../data/${name}`, import.meta.url);
const json = async (name) => JSON.parse(await readFile(data(name), 'utf8'));

async function withArchive(callback) {
  const manifest = await json('north-america-watersheds-summary.json');
  const handles = [];
  try {
    const parts = [];
    for (const part of manifest.parts) {
      const handle = await open(data(part.file));
      handles.push(handle);
      parts.push({
        bytes: part.bytes,
        source: {
          getKey: () => part.file,
          getBytes: async (offset, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return {
              data: buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + bytesRead,
              ),
            };
          },
        },
      });
    }
    const archive = new PMTiles(
      new MultipartPMTilesSource('primary-watersheds-test', parts, manifest.sha256),
    );
    await callback(archive);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

function tilePosition([longitude, latitude], z) {
  const x = ((longitude + 180) / 360) * 2 ** z;
  const y =
    ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
  return { x: Math.floor(x), y: Math.floor(y), localX: x % 1, localY: y % 1 };
}

async function tileAt(archive, coordinate, z = 10) {
  const position = tilePosition(coordinate, z);
  const tile = await archive.getZxy(z, position.x, position.y);
  assert.ok(tile, `Missing watershed tile near ${coordinate}`);
  const layer = new VectorTile(new Pbf(tile.data)).layers.basins;
  assert.ok(layer?.length, `Empty watershed tile near ${coordinate}`);
  return { layer, ...position };
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

async function basinAt(archive, coordinate) {
  const { layer, localX, localY } = await tileAt(archive, coordinate);
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const point = { x: localX * feature.extent, y: localY * feature.extent };
    if (
      feature
        .loadGeometry()
        .reduce((inside, ring) => inside !== inRing(point, ring), false)
    )
      return watershedPropertiesSchema.parse(feature.properties);
  }
  assert.fail(`No watershed contains ${coordinate}`);
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy) || 0),
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

test('surface sinks never claim verified endorheic drainage', () => {
  assert.match(watershedDrainageLabel('ocean'), /modeled ocean outlet/);
  for (const kind of ['inland', 'unresolved_sink']) {
    assert.match(watershedDrainageLabel(kind), /Underground drainage unresolved/);
    assert.doesNotMatch(watershedDrainageLabel(kind), /no ocean outlet|endorheic/);
  }
  assert.match(watershedDrainageLabel('unverified'), /unverified/);
  assert.equal(
    watershedPropertiesSchema.safeParse({ id: 1, drainage: 'ocean' }).success,
    false,
  );
});

test('primary watershed archive uses the finer source and records its limits', async () => {
  const manifest = await json('north-america-watersheds-summary.json');
  assert.equal(manifest.resolution_arc_seconds, 1);
  assert.equal(manifest.count, 108639);
  assert.equal(manifest.source_primary_basins, 108641);
  assert.deepEqual(
    manifest.groundwater_corrections,
    await json('north-america-watersheds-corrections.json'),
  );
  assert.equal(manifest.routed_catchments, 11558529);
  assert.equal(manifest.unresolved_coastal_units, 349737);
  assert.equal(manifest.single_terminal_outlet_verified, true);
  assert.equal(manifest.terminal_coordinates_verified, true);
  assert.equal(manifest.accuracy_guarantee_m, null);
  assert.equal(manifest.maximum_zoom_simplification, false);
  assert.ok(manifest.maximum_grid_quantization_error_m < 2);
  assert.equal(
    Object.values(manifest.outlet_classification).reduce((a, b) => a + b, 0),
    manifest.count,
  );
  const archiveHash = createHash('sha256');
  let bytes = 0;
  for (const part of manifest.parts) {
    assert.equal((await stat(data(part.file))).size, part.bytes);
    assert.ok(
      part.bytes < 100_000_000,
      'Each immutable part fits static hosting limits',
    );
    assert.ok(part.file.includes(manifest.sha256.slice(0, 12)));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(data(part.file))) {
      hash.update(chunk);
      archiveHash.update(chunk);
    }
    assert.equal(hash.digest('hex'), part.sha256);
    bytes += part.bytes;
  }
  assert.equal(bytes, manifest.bytes);
  assert.equal(archiveHash.digest('hex'), manifest.sha256);
  await withArchive(async (archive) => {
    const header = await archive.getHeader();
    assert.equal(header.maxZoom, manifest.maximum_zoom);
    const tile = await archive.getZxy(0, 0, 0);
    assert.ok(tile, 'Continental overview exists');
    const layer = new VectorTile(new Pbf(tile.data)).layers.basins;
    for (let i = 0; i < layer.length; i++)
      watershedPropertiesSchema.parse(layer.feature(i).properties);
  });
});

test('Missouri, Ohio, Tennessee, and upper Mississippi share one complete primary basin', async () => {
  await withArchive(async (archive) => {
    for (const coordinate of [
      [-100.78, 46.81], // Missouri at Bismarck
      [-79.98, 40.44], // Ohio headwaters at Pittsburgh
      [-86.8, 35.5], // Tennessee catchment
      [-94, 46], // Upper Mississippi
      [-90.2, 38.6], // Mississippi at St. Louis
    ]) {
      const basin = await basinAt(archive, coordinate);
      assert.equal(
        basin.id,
        72911,
        `Mississippi tributary ${coordinate} must share the same basin`,
      );
      assert.equal(basin.name, 'Mississippi basin');
      assert.equal(basin.drainage, 'ocean');
      assert.equal(basin.outlet_stream, 10283920);
      assert.ok(basin.area_km2 > 3_000_000);
      assert.ok(basin.catchments > 100_000);
    }
    for (const [coordinate, expected] of [
      [[-111.6, 36.9], 82920],
      [[-119.8, 46.2], 66083],
      [[-83, 42.3], 70334],
    ]) {
      assert.equal(
        (await basinAt(archive, coordinate)).id,
        expected,
        'Neighboring drainage systems stay separate',
      );
    }
    const inland = await basinAt(archive, [-112.2, 40.8]);
    assert.equal(inland.id, 83239);
    assert.equal(inland.drainage, 'unresolved_sink');
  });
});

test('primary basin coverage includes Mexico, Alaska, Central America, the Caribbean, and Arctic Canada', async () => {
  await withArchive(async (archive) => {
    for (const [coordinate, expected] of [
      [[-99, 19], 101193],
      [[-150, 65], 28864],
      [[-85, 13], 106671],
      [[-77, 21], 100236],
      [[-105, 69.5], 23965],
    ])
      assert.equal((await basinAt(archive, coordinate)).id, expected);
  });
});

test('full-detail tiles preserve sampled source divides within three metres', async () => {
  const fixture = await json('north-america-watersheds-precision.json');
  assert.equal(fixture.samples.length, 64);
  await withArchive(async (archive) => {
    for (const { id, coordinate } of fixture.samples) {
      const { layer, localX, localY } = await tileAt(archive, coordinate);
      let distance = Infinity;
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (feature.properties.id !== id) continue;
        const point = { x: localX * feature.extent, y: localY * feature.extent };
        for (const ring of feature.loadGeometry()) {
          for (let j = 1; j < ring.length; j++)
            distance = Math.min(
              distance,
              (segmentDistance(point, ring[j - 1], ring[j]) * 40075016.686) /
                (2 ** 10 * feature.extent),
            );
        }
      }
      assert.ok(
        distance < 3,
        `Source boundary ${id} at ${coordinate} moved ${distance} projected metres`,
      );
    }
  });
});

test('documented Culverson groundwater drainage joins Mississippi; other sinks remain unresolved', async () => {
  const corrections = await json('north-america-watersheds-corrections.json');
  await withArchive(async (archive) => {
    const unresolved = await basinAt(archive, [-80.493889, 37.915139]);
    assert.equal(unresolved.id, 86548);
    assert.equal(unresolved.drainage, 'unresolved_sink');
    assert.equal(unresolved.karst_connections, undefined);
    for (const connection of corrections.connections) {
      for (const coordinate of connection.test_points) {
        const basin = await basinAt(archive, coordinate);
        assert.equal(basin.id, connection.target_basin);
        assert.equal(basin.name, 'Mississippi basin');
        assert.equal(basin.drainage, 'ocean');
        assert.equal(basin.outlet_stream, 10283920);
        assert.equal(basin.karst_connections, 2);
        assert.equal(basin.catchments, 1723181 + 41 + 13);
        // The second source's reported upstream area already includes the first.
        assert.ok(basin.area_km2 > 3181360 && basin.area_km2 < 3181380);
        const { layer } = await tileAt(archive, coordinate);
        for (let i = 0; i < layer.length; i++) {
          assert.ok(
            !connection.source_basins.includes(layer.feature(i).properties.id),
            'No separate sink polygon or internal outline survives in the corrected tiles',
          );
        }
      }
    }
  });
});
