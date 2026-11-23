import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { roadGradeMask } from '../src/circumference/grades.ts';
import {
  gradedRoadNetworkSchema,
  roadCircleGeometrySchema,
} from '../src/highway-circumference.ts';
import { solveHighwayGradeCircles } from './highway-grade-circles.mjs';

function square(name, x, size, grades) {
  const nodes = [
    [x, 0],
    [x + size, 0],
    [x + size, size],
    [x, size],
  ].map((coordinate, index) => ({ id: `${name}-${index}`, coordinate }));
  const edges = nodes.map(({ id, coordinate }, index) => {
    const next = nodes[(index + 1) % nodes.length];
    return {
      id,
      coordinates: [coordinate, next.coordinate],
      fromId: id,
      toId: next.id,
      review: { grade: grades[index] },
    };
  });
  return { nodes, edges };
}

test('grade choices search the whole road network for a different valid circle', async () => {
  const mixed = square('mixed', 0, 2, ['A', 'A', 'A', 'A-']);
  const allA = square('allA', 3, 1, ['A', 'A', 'A', 'A']);
  const unresolved = square('unresolved', 6, 4, ['A', 'A', 'A', undefined]);
  const { circles, selections } = await solveHighwayGradeCircles({
    nodes: [...mixed.nodes, ...allA.nodes, ...unresolved.nodes],
    edges: [...mixed.edges, ...allA.edges, ...unresolved.edges],
  });
  const select = (...grades) =>
    circles.find(({ id }) => selections[roadGradeMask(grades)] === id);
  assert.deepEqual(
    new Set(select('A', 'A-').edgeIds),
    new Set(mixed.edges.map(({ id }) => id)),
  );
  assert.deepEqual(
    new Set(select('A').edgeIds),
    new Set(allA.edges.map(({ id }) => id)),
  );
  assert.equal(select('A', 'C'), select('A'));
  assert.equal(select('A-'), undefined);
  assert.equal(select(), undefined);
});

test('the published road choices use only the grades allowed by their selector', async () => {
  const [catalog, geometry] = await Promise.all(
    ['north-america-road-circles.json', 'north-america-road-circles-geometry.json'].map(
      async (name) =>
        JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8')),
    ),
  );
  const data = gradedRoadNetworkSchema.parse(catalog);
  const shapes = roadCircleGeometrySchema.parse(geometry);
  assert.equal(
    Object.values(data.coverage).reduce((count, gradeCount) => count + gradeCount, 0),
    data.segmentCount,
  );
  assert.equal(data.selections[0], null);
  assert.deepEqual(Object.keys(data.circles), Object.keys(shapes.circles));
  for (const [mask, id] of data.selections.entries()) {
    if (id === null) continue;
    const circle = data.circles[id];
    assert.ok(circle, `Grade selection ${mask} references a missing road circle`);
    const required = roadGradeMask(circle.grades);
    assert.equal(required & mask, required);
    assert.equal(circle.areaSquareMeters, shapes.circles[id].areaSquareMeters);
    const coordinates = shapes.circles[id].coordinates;
    assert.deepEqual(coordinates[0], coordinates.at(-1));
  }
});
