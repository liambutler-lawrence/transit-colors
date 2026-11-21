import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { roadGradeSchema } from './circumference/grades.ts';

function data(file) {
  return readFile(new URL(`../data/${file}.json`, import.meta.url), 'utf8');
}

test('transit reviews match both geometry variants and identify unique ride segments', async () => {
  const reviews = JSON.parse(await data('circumference-transit-grades'));
  for (const [area, groups] of Object.entries(reviews)) {
    const graph = JSON.parse(await data(`${area}-circumference`));
    const ids = groups.flatMap((review) => review.segmentIds);
    assert.equal(new Set(ids).size, ids.length, area);
    for (const mode of ['straight', 'track']) {
      const rideIds = new Set(
        graph[mode].network.segments
          .filter((segment) => segment.type === 'ride')
          .map(({ id }) => id),
      );
      for (const id of ids) assert.ok(rideIds.has(id), `${area}/${mode}: ${id}`);
    }
  }
});

test('reviewed road indices belong to the published boundary snapshot', async () => {
  const [raw, rawReviews, rawSummary] = await Promise.all([
    data('north-america-highway-circumference'),
    data('north-america-highway-grade-reviews'),
    data('north-america-highway-circumference-summary'),
  ]);
  const { route, source_version: sourceVersion } = JSON.parse(raw);
  const reviews = JSON.parse(rawReviews);
  const summary = JSON.parse(rawSummary);
  assert.equal(reviews.boundarySha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(reviews.sourceVersion, sourceVersion);
  assert.equal(reviews.sourceVersion, summary.source_version);
  assert.equal(reviews.areaSquareMeters, route.areaSquareMeters);
  assert.equal(reviews.areaSquareMeters, summary.route.areaSquareMeters);
  assert.equal(reviews.segments.length, route.segments.length);
  assert.equal(reviews.segments.length, summary.route.boundaryCorridorCount);
  assert.ok(reviews.segments.some((grade) => roadGradeSchema.safeParse(grade).success));
  for (const grade of reviews.segments) roadGradeSchema.nullable().parse(grade);
});
