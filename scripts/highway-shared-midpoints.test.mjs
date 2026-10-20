import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sharedRampMidpoints } from './highway-shared-midpoints.mjs';
import {
  buildOsmHighwayCenterlines,
  averageReciprocalPathCoordinates,
} from './osm-highway-network.mjs';

test('Rocky Mount shares each collector midline exactly and preserves all four movements', () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL('./fixtures/rocky-mount-collectors.json', import.meta.url)),
  );
  const built = buildOsmHighwayCenterlines({
    nodes: new Map(fixture.nodes),
    ways: fixture.ways,
  });
  const ramps = built.parts.filter((p) => p.role === 'connector');
  assert.equal(ramps.length, 4);
  const sections = new Map();
  for (const ramp of ramps)
    for (const section of ramp.sharedMidpointSections) {
      const previous = sections.get(section.id);
      if (previous) assert.deepEqual(section.coordinates, previous.coordinates);
      else sections.set(section.id, { coordinates: section.coordinates, count: 0 });
      sections.get(section.id).count++;
      assert.ok(
        ramp.coordinates.some((p, i) =>
          section.coordinates.every(
            (q, j) => ramp.coordinates[i + j]?.join() === q.join(),
          ),
        ),
        'canonical section appears intact in each movement',
      );
    }
  assert.equal(sections.size, 4);
  assert.ok([...sections.values()].every((s) => s.count === 2));
  const west = ramps.filter((p) => p.coordinates.at(-1)[0] < -77.88);
  const common = west[0].sharedMidpointSections.find(
    (s) => s.coordinates.at(-1)[0] < -77.8878,
  );
  assert.ok(common);
  assert.ok(west[1].sharedMidpointSections.some((s) => s.id === common.id));
  assert.ok(
    common.coordinates[0][0] > -77.8834 && common.coordinates.at(-1)[0] < -77.8878,
  );
});

test('nearby geometry without shared source identity is never reused', () => {
  const coordinates = [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
    ],
    second = coordinates.map(([x, y]) => [x, y + 0.0001]);
  const entries = [0, 1].map((i) => ({
    first: { coordinates, nodeIds: coordinates.map((_, j) => `${i}:a:${j}`) },
    second: { coordinates: second, nodeIds: second.map((_, j) => `${i}:b:${j}`) },
    start: [0, 0.00005],
    end: [0.002, 0.00005],
  }));
  const result = sharedRampMidpoints(entries, averageReciprocalPathCoordinates);
  assert.equal(result.statistics.sharedSections, 0);
});

test('one shared carriageway alone does not define a shared midpoint', () => {
  const coordinates = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ];
  const entries = [0, 1].map((i) => ({
    first: { coordinates, nodeIds: ['a', 'b', 'c'] },
    second: {
      coordinates: coordinates.map(([x, y]) => [x, y + 0.0001 * (i + 1)]),
      nodeIds: [`${i}:x`, `${i}:y`, `${i}:z`],
    },
    start: [0, 0.00005],
    end: [0.002, 0.00005],
  }));
  assert.equal(
    sharedRampMidpoints(entries, averageReciprocalPathCoordinates).statistics
      .sharedSections,
    0,
  );
});

test('shared source orientation survives a reversed movement with its sides swapped', () => {
  const first = {
    coordinates: [
      [0, 0],
      [0.001, 0],
      [0.002, 0.001],
    ],
    nodeIds: ['a', 'b', 'c'],
  };
  const second = {
    coordinates: [
      [0, 0.0001],
      [0.001, 0.0001],
      [0.002, 0.0011],
    ],
    nodeIds: ['x', 'y', 'z'],
  };
  const reverse = (path) => ({
    coordinates: path.coordinates.toReversed(),
    nodeIds: path.nodeIds.toReversed(),
  });
  const entries = [
    { first, second, start: [0, 0.00005], end: [0.002, 0.00105] },
    {
      first: reverse(second),
      second: reverse(first),
      start: [0.002, 0.00105],
      end: [0, 0.00005],
    },
  ];
  const { results, statistics } = sharedRampMidpoints(
    entries,
    averageReciprocalPathCoordinates,
  );
  assert.equal(statistics.sharedSections, 1);
  assert.deepEqual(
    results[0].sharedSections[0].coordinates,
    results[1].sharedSections[0].coordinates.toReversed(),
  );
  assert.deepEqual(results[0].coordinates, results[1].coordinates.toReversed());
});
