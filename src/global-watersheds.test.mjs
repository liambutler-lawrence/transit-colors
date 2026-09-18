import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';
import { MultipartPMTilesSource } from './multipart-pmtiles.ts';
import { watershedPropertiesSchema } from './watersheds.ts';
import { worldwideExitBodies } from './watershed-colors.ts';

const data = (name) => new URL(`../data/${name}`, import.meta.url);
const json = async (name) => JSON.parse(await readFile(data(name), 'utf8'));

async function withArchive(callback) {
  const manifest = await json('global-watersheds-summary.json');
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
    await callback(
      new PMTiles(new MultipartPMTilesSource('global-test', parts, manifest.sha256)),
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
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

async function basinsAt(archive, [longitude, latitude]) {
  const z = 10;
  const x = ((longitude + 180) / 360) * 2 ** z;
  const y =
    ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
  const tile = await archive.getZxy(z, Math.floor(x), Math.floor(y));
  if (!tile) return [];
  const layer = new VectorTile(new Pbf(tile.data)).layers.basins;
  const matches = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const point = { x: (x % 1) * feature.extent, y: (y % 1) * feature.extent };
    if (
      feature
        .loadGeometry()
        .reduce((inside, ring) => inside !== inRing(point, ring), false)
    )
      matches.push(watershedPropertiesSchema.parse(feature.properties));
  }
  return matches;
}

test('global archive retains source detail, scope, license, and complete regional accounting', async () => {
  const summary = await json('global-watersheds-summary.json');
  assert.equal(summary.source, 'GRIT v1.0');
  assert.equal(summary.license, 'CC BY-NC 4.0');
  assert.equal(summary.source_resolution_m, 30);
  assert.equal(summary.source_vectors_simplified, true);
  assert.equal(summary.maximum_zoom_simplification, false);
  assert.deepEqual(summary.regions.map((r) => r.region).sort(), [
    'AF',
    'AS',
    'EU',
    'NA',
    'SA',
    'SI',
    'SP',
  ]);
  assert.equal(
    summary.count,
    summary.regions.reduce((sum, r) => sum + r.displayed_individual_basins, 0) +
      summary.surface_depressions.basins +
      summary.closed_basins.count,
  );
  for (const region of summary.regions) {
    assert.ok(region.catchments > region.basins);
    assert.equal(
      region.basins,
      Object.values(region.drainage).reduce((a, b) => a + b, 0),
    );
  }
  const overall = createHash('sha256');
  for (const part of summary.parts) {
    assert.equal((await stat(data(part.file))).size, part.bytes);
    assert.ok(part.bytes < 100 * 1024 ** 2);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(data(part.file))) {
      hash.update(chunk);
      overall.update(chunk);
    }
    assert.equal(hash.digest('hex'), part.sha256);
  }
  assert.equal(overall.digest('hex'), summary.sha256);
});

test('major world rivers reach their expected receiving bodies and tributary points share primary basins', async () => {
  const fixtures = await json('global-watersheds-fixtures.json');
  await withArchive(async (archive) => {
    const ids = new Map();
    for (const fixture of fixtures) {
      const matches = await basinsAt(archive, fixture.coordinate);
      assert.equal(matches.length, 1, `Expected one basin at ${fixture.coordinate}`);
      const basin = matches[0];
      assert.equal(basin.source, 'grit');
      assert.equal(basin.exit_body, fixture.receiving_body, fixture.river);
      assert.equal(
        basin.drainage,
        fixture.receiving_body === 'Caspian Sea' ? 'endorheic' : 'ocean',
        fixture.river,
      );
      assert.ok(basin.catchments >= (fixture.minimum_catchments ?? 100), fixture.river);
      const group = fixture.primary_group ?? fixture.river;
      if (ids.has(group)) assert.equal(basin.id, ids.get(group), fixture.river);
      ids.set(group, basin.id);
    }
    assert.notEqual(
      ids.get('Rhine'),
      ids.get('Danube'),
      'Canals must not merge Rhine and Danube',
    );
  });
});

test('global legend has one stable color per receiving body and missing outlets cannot fabricate markers', () => {
  assert.equal(
    new Set(worldwideExitBodies.map((b) => b.name)).size,
    worldwideExitBodies.length,
  );
  assert.equal(
    new Set(worldwideExitBodies.map((b) => b.color)).size,
    worldwideExitBodies.length,
  );
  for (const body of [
    'Indian Ocean',
    'Mediterranean Sea',
    'Black Sea',
    'Caspian Sea',
    'North Sea',
  ])
    assert.ok(worldwideExitBodies.some((b) => b.name === body));
  const depression = {
    id: 3000000001,
    source: 'grit',
    area_km2: 10,
    catchments: 1,
    source_basins: 1,
    drainage: 'unverified',
    outlet_known: false,
  };
  assert.equal(watershedPropertiesSchema.safeParse(depression).success, true);
  assert.equal(
    watershedPropertiesSchema.safeParse({ ...depression, drainage: 'ocean' }).success,
    false,
  );
  assert.equal(
    watershedPropertiesSchema.safeParse({ ...depression, outlet_lon: 0, outlet_lat: 0 })
      .success,
    false,
  );
});

test('global supplements do not cover the existing Mississippi, WV, Baja, or Mexico City basins', async () => {
  await withArchive(async (archive) => {
    for (const point of [
      [-100, 40],
      [-80.46319, 37.93903],
      [-114.35208, 29.38042],
      [-99.13, 19.43],
    ]) {
      assert.deepEqual(
        await basinsAt(archive, point),
        [],
        `Global data overlaps North America at ${point}`,
      );
    }
  });
});

test('mainstem routing keeps canals and secondary outlets distinct and rejects cycles', () => {
  execFileSync('python3', ['scripts/global-watersheds.test.py'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe',
  });
});

test('unsupported Greenland ice-sheet routing is absent from the global layer', async () => {
  await withArchive(async (archive) => {
    assert.deepEqual(await basinsAt(archive, [-40, 72]), []);
  });
});
