import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { buildAveragedMainlines } from './osm-highway-network.mjs';
const metersCoordinate = ([x, y]) => [x / 111_320, y / 110_574];
const coordinateMeters = ([x, y]) => [x * 111_320, y * 110_574];

test('interior projections do not inherit endpoint identity from an arbitrary search sample', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/source-projection-endpoints.json', import.meta.url),
      'utf8',
    ),
  );
  const result = buildAveragedMainlines(
    fixture.chains.map((chain) => ({ ...chain, tokens: new Set(['R']) })),
  );
  const part = result.parts.find((p) => p.sourceChainId === 'chain-218');
  assert.ok(geodesicDistanceMeters(part.coordinates[0], part.coordinates.at(-1)) > 500);
  assert.ok(!part.startTopologyKeys.some((key) => part.endTopologyKeys.includes(key)));
});

test('closed opposing carriageways preserve the whole ring across different source seams', () => {
  const chains = [500, 450].map((radius, index) => {
    const coordinates = Array.from({ length: 144 }, (_, i) => {
      const angle = (i / 144) * Math.PI * 2 * (index ? -1 : 1) + index * 1.2;
      return metersCoordinate([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    });
    coordinates.push(coordinates[0]);
    return {
      id: `ring-${index}`,
      coordinates,
      startNodeId: `seam-${index}`,
      endNodeId: `seam-${index}`,
      sourceWayIds: [`way-${index}`],
      tokens: new Set(['R']),
    };
  });
  const result = buildAveragedMainlines(chains);
  const points = result.parts.flatMap((part) => part.coordinates).map(coordinateMeters);
  for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x, y) - 475) < 3);
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const angle = (quadrant * Math.PI) / 2;
    assert.ok(
      points.some(
        ([x, y]) =>
          Math.hypot(x - 475 * Math.cos(angle), y - 475 * Math.sin(angle)) < 20,
      ),
    );
  }
});

test('Jacksonville I-295 follows its source ring through the SR 9B corridor', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/jacksonville-closed-mainline.json', import.meta.url),
      'utf8',
    ),
  );
  const chains = fixture.chains.map((chain) => ({
    ...chain,
    tokens: new Set(['I295']),
  }));
  const result = buildAveragedMainlines(chains);
  // This source span crosses the other carriageway's arbitrary storage seam.
  // A short chord would pull the midpoint kilometres inside the ring.
  for (const latitude of [30.205, 30.215, 30.225]) {
    assert.ok(
      result.parts.some((part) =>
        part.coordinates.some(
          ([x, y]) => x > -81.516 && x < -81.512 && Math.abs(y - latitude) < 0.008,
        ),
      ),
    );
  }
});

test('rings embedded inside longer source chains retain the Calgary and Houston corridors', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/ring-carriageway-tails.json', import.meta.url),
      'utf8',
    ),
  );
  for (const { id, chains, witness } of fixture.cases) {
    const result = buildAveragedMainlines(
      chains.map((chain) => ({ ...chain, tokens: new Set(['R']) })),
    );
    const nearest = Math.min(
      ...result.parts.flatMap((part) =>
        part.coordinates.map((point) => geodesicDistanceMeters(point, witness)),
      ),
    );
    assert.ok(nearest < 100, `${id}: source corridor displaced ${nearest} m`);
  }
});
