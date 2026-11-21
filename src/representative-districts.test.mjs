import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import polygonClipping from 'polygon-clipping';

import {
  circleContains,
  circlePointSelector,
  minimumEnclosingCircle,
  minimumPopulationCircle,
} from './district-circles.ts';
import {
  availableDistrictCounts,
  districtState,
  districtStateBounds,
  districtStates,
} from './district-states.ts';
import {
  geodesicPolygonAreaSquareMeters,
  localEqualAreaProjection,
} from './geodesy.ts';
import { PolygonHitIndex } from './polygon-hit-index.ts';
import {
  calculateDistrictAssignments,
  districtPlanSchema,
  districtRequestSchema,
  isKnifeMethod,
  prepareDistrictBlocks,
} from './representative-districts.ts';

test('district count choices use the 435 apportioned House seats', () => {
  assert.equal(
    districtStates.reduce((sum, state) => sum + state.houseSeats, 0),
    435,
  );
  assert.deepEqual(availableDistrictCounts(districtState('AK')), [1, 2]);
  assert.deepEqual(availableDistrictCounts(districtState('CT')), [4, 5, 6]);
  assert.deepEqual(availableDistrictCounts(districtState('CA')), [51, 52, 53]);
  assert.ok(districtRequestSchema.safeParse({ method: 'knife', seats: 53 }).success);
  assert.ok(!districtRequestSchema.safeParse({ method: 'knife', seats: 54 }).success);
});

test('indexed circle candidates retain blocks on the edge and blocks with no residents', () => {
  const points = Array.from({ length: 81 }, (_, index) => ({
    index,
    point: [(index % 9) - 4, Math.floor(index / 9) - 4],
    population: index % 2,
  }));
  const select = circlePointSelector(points);
  for (const [center, radius] of [
    [[0, 0], 3],
    [[4, -3], 5],
    [[-12, 1], 8],
    [[0, 0], 0],
  ]) {
    const circle = { center, radius };
    assert.deepEqual(
      select(circle)
        .map(({ index }) => index)
        .sort((a, b) => a - b),
      points
        .filter(({ point }) => circleContains(circle, point))
        .map(({ index }) => index),
    );
  }
});

test('the 50-state selector and Alaska projection span the antimeridian', () => {
  assert.equal(districtStates.length, 50);
  assert.equal(new Set(districtStates.map(({ fips }) => fips)).size, 50);
  assert.equal(new Set(districtStates.map(({ code }) => code)).size, 50);
  assert.equal(districtState('DC'), undefined);

  const alaska = districtState('ak');
  assert.equal(alaska.population, 733_391);
  const [[west, south], [east, north]] = districtStateBounds(alaska);
  assert.ok(west < -180 && east > -180 && east - west < 60);

  const origin = [(west + east) / 2, (south + north) / 2];
  const prepared = prepareDistrictBlocks(
    [179.9, -179.9].map((longitude) => ({
      center: [longitude, 52],
      population: 1,
      urbanPopulation: 0,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [longitude - 0.01, 52],
            [longitude + 0.01, 52],
            [longitude, 52.01],
            [longitude - 0.01, 52],
          ],
        ],
      },
    })),
    origin,
  );
  assert.ok(Math.abs(prepared[0].point[0] - prepared[1].point[0]) < 25_000);
});

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

test('Reock circles can choose a larger circle for a more compact district', () => {
  const { unproject } = localEqualAreaProjection([-72.7, 41.6]);
  const blocks = prepareDistrictBlocks(
    [
      [-50, 5, 5],
      [50, 5, 5],
      [1000, 100, 150],
      [1200, 100, 150],
    ].map(([x, halfWidth, halfHeight]) => ({
      center: unproject([x, 0]),
      population: 2,
      urbanPopulation: 2,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x - halfWidth, -halfHeight],
            [x + halfWidth, -halfHeight],
            [x + halfWidth, halfHeight],
            [x - halfWidth, halfHeight],
            [x - halfWidth, -halfHeight],
          ].map(unproject),
        ],
      },
    })),
  );
  const [smallest] = calculateDistrictAssignments(blocks, {
    method: 'circles',
    seats: 2,
  });
  const [compact] = calculateDistrictAssignments(blocks, {
    method: 'reock-circles',
    seats: 2,
  });
  assert.deepEqual(smallest.blocks, [0, 1]);
  assert.deepEqual(compact.blocks, [2, 3]);
  assert.equal(compact.properties.population, 4);
  assert.ok(compact.properties.radiusMeters > smallest.properties.radiusMeters);
  const expectedReock = (400 * 300) / (Math.PI * 250 ** 2);
  assert.ok(Math.abs(compact.properties.reock - expectedReock) < 1e-6);
});

test('smallest-area knife takes the smaller cut even when its Reock score is lower', () => {
  const { unproject } = localEqualAreaProjection([-72.7, 41.6]);
  const blocks = prepareDistrictBlocks(
    [
      [-1_200, 10, 1],
      [-1_000, 10, 1],
      [1_000, 20, 2],
    ].map(([x, halfWidth, population]) => ({
      center: unproject([x, 0]),
      population,
      urbanPopulation: population,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x - halfWidth, -halfWidth],
            [x + halfWidth, -halfWidth],
            [x + halfWidth, halfWidth],
            [x - halfWidth, halfWidth],
            [x - halfWidth, -halfWidth],
          ].map(unproject),
        ],
      },
    })),
  );
  const [smallest, remainder] = calculateDistrictAssignments(blocks, {
    method: 'area-knife',
    seats: 2,
  });
  const [compact] = calculateDistrictAssignments(blocks, { method: 'knife', seats: 2 });
  assert.deepEqual(
    smallest.blocks.toSorted((a, b) => a - b),
    [0, 1],
  );
  assert.deepEqual(remainder.blocks, [2]);
  assert.equal(smallest.properties.population, 2);
  assert.equal(remainder.properties.population, 2);
  assert.ok(smallest.properties.areaSquareMeters < compact.properties.areaSquareMeters);
  assert.ok(smallest.properties.reock < compact.properties.reock);
  assert.equal(smallest.properties.radiusMeters, null);
});

test('published Connecticut plans clip the coast and count every resident once', () => {
  // Clipping shared edges can leave sub-metre floating-point slivers when a
  // second geometry engine overlays the GeoJSON.
  const exteriorArea = (polygons) =>
    polygons.reduce((sum, [outer]) => sum + geodesicPolygonAreaSquareMeters(outer), 0);
  for (const method of districtRequestSchema.shape.method.options) {
    const maximumDeviation = method === 'reock-circles' ? 0.0025 : 0.001;
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
      const outline = new PolygonHitIndex([
        {
          value: true,
          polygons:
            plan.outline.type === 'Polygon'
              ? [plan.outline.coordinates]
              : plan.outline.coordinates,
        },
      ]);
      assert.equal(
        outline.find(-73.1, 41.11),
        null,
        'Western Long Island Sound is clear',
      );
      assert.equal(
        outline.find(-72.2, 41.25),
        null,
        'Eastern Long Island Sound is clear',
      );
      assert.equal(
        outline.find(-72.98191, 41.2022),
        null,
        'The Housatonic mouth is clear',
      );
      assert.equal(
        outline.find(-72.7, 41.76),
        true,
        'The outline still covers Hartford',
      );
      assert.equal(
        outline.find(-72.663, 41.761),
        true,
        'The inland Connecticut River keeps its district shading',
      );
      assert.equal(
        outline.find(-72.9554, 41.9405),
        true,
        'The outline still covers the isolated Barkhamsted Reservoir',
      );
      for (const { population, reock, radiusMeters, areaSquareMeters } of districts) {
        assert.ok(Math.abs(population - plan.target) / plan.target < maximumDeviation);
        assert.ok(areaSquareMeters > 0);
        if (method === 'circles') assert.equal(reock, null);
        else assert.ok(reock > 0 && reock <= 1);
        if (isKnifeMethod(method)) assert.equal(radiusMeters, null);
        else assert.ok(radiusMeters > 0);
      }
      const geometries = plan.districts.features.map(
        ({ geometry }) => geometry.coordinates,
      );
      const union = polygonClipping.union(...geometries);
      assert.ok(exteriorArea(polygonClipping.xor(plan.outline.coordinates, union)) < 1);
      for (const [index, geometry] of geometries.entries()) {
        for (const later of geometries.slice(index + 1)) {
          assert.ok(exteriorArea(polygonClipping.intersection(geometry, later)) < 1);
        }
      }
    }
  }
});
