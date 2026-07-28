import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isValidSimpleCircumferenceCycle } from '../scripts/exact-circumference-solver.mjs';
import {
  activeCircumferenceService,
  scheduleCircumferenceMode,
} from './circumference.ts';
import { circumferenceGeometryVariantsSchema } from './circumference/schema.ts';

const LOOP_AREA_KEYS = ['cdmx', 'nyc', 'singapore', 'athens'];

test('precomputed circumference winners are validated and topology-stable', async () => {
  for (const areaKey of LOOP_AREA_KEYS) {
    const startedAt = performance.now();
    const routeData = circumferenceGeometryVariantsSchema.parse(
      JSON.parse(
        await readFile(
          new URL(`../data/${areaKey}-circumference.json`, import.meta.url),
          'utf8',
        ),
      ),
    );
    assert.ok(performance.now() - startedAt < 2_000);
    assert.equal(routeData.track.methodology.optimizationStatus, 'optimal');
    assert.equal(routeData.straight.methodology.optimizationStatus, 'optimal');
    assert.equal(
      routeData.track.methodology.optimizationGeometry,
      'straight-platform-edges',
    );
    assert.deepEqual(
      routeData.track.candidates.map((candidate) => candidate.nodeIds),
      routeData.straight.candidates.map((candidate) => candidate.nodeIds),
    );
    assert.deepEqual(
      routeData.track.scheduleCandidates.map((candidate) => candidate.nodeIds),
      routeData.straight.scheduleCandidates.map((candidate) => candidate.nodeIds),
    );
    assert.ok(routeData.straight.scheduleCandidates.length >= 1);
    for (const [index, candidate] of routeData.straight.candidates.entries()) {
      assert.equal(
        isValidSimpleCircumferenceCycle(routeData.straight.network, candidate.nodeIds),
        true,
      );
      if (index > 0) {
        assert.ok(
          routeData.straight.candidates[index - 1].areaSquareMeters >=
            candidate.areaSquareMeters,
        );
      }
    }
  }
});

test('Atlanta publishes its full branched network without a fake loop', async () => {
  const [routeData, schedules] = await Promise.all([
    readFile(
      new URL('../data/atlanta-circumference.json', import.meta.url),
      'utf8',
    ).then((data) => circumferenceGeometryVariantsSchema.parse(JSON.parse(data))),
    readFile(new URL('../data/atlanta-schedules.json', import.meta.url), 'utf8').then(
      JSON.parse,
    ),
  ]);
  assert.equal(routeData.track.candidates.length, 0);
  assert.equal(routeData.straight.candidates.length, 0);
  assert.ok(routeData.track.network.stations.length >= 50);
  assert.ok(routeData.track.network.segments.length >= 50);
  assert.deepEqual(
    [...activeCircumferenceService(schedules, 1, 6 * 60 + 30).lineNames].sort(),
    ['BLUE', 'GOLD', 'GREEN', 'RED'],
  );
});

test('Singapore includes the completed Circle Line closure', async () => {
  const routeData = circumferenceGeometryVariantsSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/singapore-circumference.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const circleClosure = [
    ['NE1-CC29', 'CC30'],
    ['CC30', 'CC31'],
    ['CC31', 'CC32'],
    ['CC32', 'NS27-CE2-TE20'],
  ];
  const rideEdges = new Set(
    routeData.track.network.segments
      .filter((segment) => segment.type === 'ride' && segment.lines.includes('CC'))
      .map((segment) =>
        [segment.from.id, segment.to.id]
          .map((id) => id.split('/').at(-2))
          .sort()
          .join('::'),
      ),
  );

  for (const stationPair of circleClosure) {
    assert.ok(rideEdges.has(stationPair.sort().join('::')));
  }
  assert.ok(routeData.track.candidates[0].areaSquareMeters > 200_000_000);
});

test('NYC exact winner uses the 1 from South Ferry through 14 St', async () => {
  const routeData = circumferenceGeometryVariantsSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/nyc-circumference.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const winner = routeData.track.candidates[0];
  const expectedOneRun = [
    'gtfs/mta-subway/142',
    'gtfs/mta-subway/139',
    'gtfs/mta-subway/138',
    'gtfs/mta-subway/137',
    'gtfs/mta-subway/136',
    'gtfs/mta-subway/135',
    'gtfs/mta-subway/134',
    'gtfs/mta-subway/133',
    'gtfs/mta-subway/132',
  ];
  const startIndex = winner.nodeIds.indexOf(expectedOneRun[0]);
  assert.ok(startIndex >= 0);
  assert.deepEqual(
    winner.nodeIds.slice(startIndex, startIndex + expectedOneRun.length),
    expectedOneRun,
  );
  assert.equal(
    winner.segments.find(
      (segment) =>
        segment.from.id === 'gtfs/mta-subway/R28' &&
        segment.to.id === 'gtfs/mta-subway/R27',
    )?.primaryLine,
    'R',
  );
});

test('NYC Monday noon uses branch-specific service and a certified route', async () => {
  const [routeData, schedules] = await Promise.all([
    readFile(new URL('../data/nyc-circumference.json', import.meta.url), 'utf8').then(
      (data) => circumferenceGeometryVariantsSchema.parse(JSON.parse(data)),
    ),
    readFile(new URL('../data/nyc-schedules.json', import.meta.url), 'utf8').then(
      JSON.parse,
    ),
  ]);
  const noonService = activeCircumferenceService(schedules, 0, 12 * 60);
  const result = scheduleCircumferenceMode(routeData.track, noonService, 'track');
  const rideLines = (firstId, secondId) =>
    result.network.segments.find(
      (segment) =>
        segment.type === 'ride' &&
        new Set([segment.from.id, segment.to.id]).has(firstId) &&
        new Set([segment.from.id, segment.to.id]).has(secondId),
    )?.lines;

  assert.deepEqual(rideLines('gtfs/mta-subway/249', 'gtfs/mta-subway/250'), ['3', '4']);
  assert.deepEqual(rideLines('gtfs/mta-subway/250', 'gtfs/mta-subway/251'), ['3']);
  assert.deepEqual(rideLines('gtfs/mta-subway/256', 'gtfs/mta-subway/257'), ['3']);
  assert.deepEqual(rideLines('gtfs/mta-subway/246', 'gtfs/mta-subway/247'), ['2', '5']);
  assert.equal(
    result.network.stations.find((station) => station.id === 'gtfs/mta-subway/250')
      ?.label,
    'Crown Hts-Utica Av · 3/4',
  );
  assert.equal(
    result.network.stations.find((station) => station.id === 'gtfs/mta-subway/251')
      ?.label,
    'Sutter Av-Rutland Rd · 3',
  );
  assert.ok(result.candidates[0]);
  assert.equal(
    isValidSimpleCircumferenceCycle(result.network, result.candidates[0].nodeIds),
    true,
  );
});
