import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { minimumPopulationCircle } from './district-circles.ts';
import { localEqualAreaProjection } from './geodesy.ts';
import {
  calculateDistrictPlan,
  districtStudySchema,
} from './representative-districts.ts';

test('the smallest population circle can be centered between three tracts', () => {
  const points = [
    { point: [-100, 0], population: 2 },
    { point: [100, 0], population: 2 },
    { point: [0, 200], population: 2 },
    { point: [1000, 1000], population: 1 },
  ];
  const { center, radius } = minimumPopulationCircle(points, 6);
  assert.ok(radius >= 125 && radius <= 126);
  assert.ok(Math.hypot(center[0], center[1] - 75) < 2);
});

test('nested circles each count their full area and only newly assigned residents', () => {
  const { unproject } = localEqualAreaProjection([-72.7, 41.6]);
  const polygon = (x, y, halfSize) => ({
    type: 'Polygon',
    coordinates: [
      [
        [x - halfSize, y - halfSize],
        [x + halfSize, y - halfSize],
        [x + halfSize, y + halfSize],
        [x - halfSize, y + halfSize],
        [x - halfSize, y - halfSize],
      ].map(unproject),
    ],
  });
  const tracts = [
    [-100, 0, 2, 2],
    [100, 0, 2, 2],
    [0, 1000, 1, 0],
    [1000, 0, 1, 0],
    [0, -1000, 1, 0],
    [-1000, 0, 1, 0],
  ].map(([x, y, population, urbanPopulation]) => ({
    center: unproject([x, y]),
    population,
    urbanPopulation,
    geometry: polygon(x, y, 10),
  }));
  const study = { outline: polygon(0, 0, 1100), tracts };
  const plan = calculateDistrictPlan(study, { method: 'circles', seats: 2 });
  const [inner, outer] = plan.districts.features.map(({ properties }) => properties);
  assert.ok(Math.abs(inner.radiusMeters - 100) <= 1);
  assert.ok(Math.abs(outer.radiusMeters - 1000) < 0.001);
  assert.deepEqual([inner.population, outer.population], [4, 4]);
  assert.deepEqual([inner.urbanPopulation, outer.urbanPopulation], [4, 0]);
  assert.equal(
    plan.totalAreaSquareMeters,
    inner.areaSquareMeters + outer.areaSquareMeters,
  );
  assert.ok(plan.totalAreaSquareMeters > outer.areaSquareMeters);
});

test('the Connecticut methods assign all 2020 Census residents once', () => {
  const study = districtStudySchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../data/connecticut-districts.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  for (const method of ['knife', 'circles']) {
    for (const seats of [2, 5, 8]) {
      const plan = calculateDistrictPlan(study, { method, seats });
      const districts = plan.districts.features.map(({ properties }) => properties);
      assert.equal(districts.length, seats);
      assert.equal(
        districts.reduce((sum, district) => sum + district.population, 0),
        3_605_944,
      );
      assert.equal(
        districts.reduce((sum, district) => sum + district.urbanPopulation, 0),
        3_110_153,
      );
      for (const { population, reock, radiusMeters, areaSquareMeters } of districts) {
        assert.ok(Math.abs(population - plan.target) / plan.target < 0.03);
        assert.ok(areaSquareMeters > 0);
        if (method === 'knife') assert.ok(reock > 0 && reock <= 1);
        else assert.ok(radiusMeters > 0);
      }
    }
  }
});
