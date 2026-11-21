import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import polygonClipping from 'polygon-clipping';

import {
  circleContains,
  minimumEnclosingCircle,
  minimumPopulationCircle,
} from './district-circles.ts';
import { localEqualAreaProjection } from './geodesy.ts';
import {
  calculateDistrictAssignments,
  districtPlanSchema,
  prepareDistrictBlocks,
} from './representative-districts.ts';

test('the smallest population circle can be centered between three block points', () => {
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

test('the population circle search agrees with an exhaustive search on small weighted inputs', () => {
  let seed = 8910;
  const next = (maximum) => {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
    return Math.floor((seed / 2 ** 32) * maximum);
  };
  for (let trial = 0; trial < 40; trial += 1) {
    const points = Array.from({ length: 7 }, () => ({
      point: [next(80) * 10 - 400, next(80) * 10 - 400],
      population: next(10) + 1,
    }));
    const target =
      1 + next(points.reduce((sum, { population }) => sum + population, 0));
    let exact = Infinity;
    for (let mask = 1; mask < 2 ** points.length; mask += 1) {
      const subset = points.filter((_, index) => (mask & (1 << index)) !== 0);
      if (subset.reduce((sum, { population }) => sum + population, 0) >= target) {
        exact = Math.min(
          exact,
          minimumEnclosingCircle(subset.map(({ point }) => point)).radius,
        );
      }
    }
    const circle = minimumPopulationCircle(points, target);
    const covered = points.reduce(
      (sum, { point, population }) =>
        sum + (circleContains(circle, point) ? population : 0),
      0,
    );
    assert.ok(covered >= target);
    assert.ok(circle.radius >= exact - 1e-6 && circle.radius <= exact + 1);
  }
});

test('nested circles assign whole blocks and report their full selection areas', () => {
  const { unproject } = localEqualAreaProjection([-72.7, 41.6]);
  const polygon = (x, y) => ({
    type: 'Polygon',
    coordinates: [
      [
        [x - 10, y - 10],
        [x + 10, y - 10],
        [x + 10, y + 10],
        [x - 10, y + 10],
        [x - 10, y - 10],
      ].map(unproject),
    ],
  });
  const blocks = [
    [-100, 0, 2, 2],
    [100, 0, 2, 2],
    [0, 0, 0, 0],
    [0, 1000, 1, 0],
    [1000, 0, 1, 0],
    [0, -1000, 1, 0],
    [-1000, 0, 1, 0],
    [1500, 0, 0, 0],
  ].map(([x, y, population, urbanPopulation]) => ({
    center: unproject([x, y]),
    population,
    urbanPopulation,
    geometry: polygon(x, y),
  }));
  const [innerDistrict, outerDistrict] = calculateDistrictAssignments(
    prepareDistrictBlocks(blocks),
    {
      method: 'circles',
      seats: 2,
    },
  );
  assert.deepEqual(innerDistrict.blocks, [0, 1, 2]);
  assert.deepEqual(outerDistrict.blocks, [3, 4, 5, 6, 7]);
  const inner = innerDistrict.properties;
  const outer = outerDistrict.properties;
  assert.ok(Math.abs(inner.radiusMeters - 100) <= 1);
  assert.ok(Math.abs(outer.radiusMeters - 1000) < 0.001);
  assert.deepEqual([inner.population, outer.population], [4, 4]);
  assert.deepEqual([inner.urbanPopulation, outer.urbanPopulation], [4, 0]);
  for (const district of [inner, outer]) {
    assert.equal(district.areaSquareMeters, Math.PI * district.radiusMeters ** 2);
  }
});

test('published Connecticut plans cover the study area and count every resident once', () => {
  for (const method of ['knife', 'circles']) {
    for (let seats = 2; seats <= 8; seats += 1) {
      const file = new URL(
        `../data/connecticut-district-plans/${method}-${seats}.json`,
        import.meta.url,
      );
      const plan = districtPlanSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const districts = plan.districts.features.map(({ properties }) => properties);
      assert.equal(districts.length, seats);
      assert.equal(plan.totalPopulation, 3_605_944);
      assert.equal(plan.target, plan.totalPopulation / seats);
      assert.equal(
        districts.reduce((sum, { population }) => sum + population, 0),
        plan.totalPopulation,
      );
      assert.equal(
        districts.reduce((sum, { urbanPopulation }) => sum + urbanPopulation, 0),
        3_110_153,
      );
      for (const { population, reock, radiusMeters, areaSquareMeters } of districts) {
        assert.ok(Math.abs(population - plan.target) / plan.target < 0.001);
        assert.ok(areaSquareMeters > 0);
        if (method === 'knife') assert.ok(reock > 0 && reock <= 1);
        else assert.ok(radiusMeters > 0);
      }
      const geometries = plan.districts.features.map(
        ({ geometry }) => geometry.coordinates,
      );
      const union = polygonClipping.union(...geometries);
      assert.deepEqual(polygonClipping.xor(plan.outline.coordinates, union), []);
      for (const [index, geometry] of geometries.entries()) {
        for (const later of geometries.slice(index + 1)) {
          assert.deepEqual(polygonClipping.intersection(geometry, later), []);
        }
      }
    }
  }
});
