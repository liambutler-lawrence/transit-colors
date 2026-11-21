import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyTransitGradeReviews,
  transitSegmentProperties,
} from './app/circumference-data.ts';
import { segmentPropertiesSchema } from './app/types.ts';
import { roadGradeSchema, TRANSIT_GRADES } from './circumference/grades.ts';
import { candidateFromNetworkPath } from './circumference/precomputed.ts';
import { filterCircumferenceNetwork } from './circumference/schedule.ts';

function data(file) {
  return readFile(new URL(`../data/${file}.json`, import.meta.url), 'utf8');
}

test('both geometry variants account for every transit ride with a grade or documented gap', async () => {
  const reviews = JSON.parse(await data('circumference-transit-grades'));
  const gapReport = await readFile(
    new URL('../docs/circumference-transit-grade-gaps.md', import.meta.url),
    'utf8',
  );
  const flagged = Array.from(gapReport.matchAll(/`(network-[\w-]+)`/g), ([, id]) => id);
  assert.equal(new Set(flagged).size, flagged.length, 'Duplicate review gaps');
  const unresolved = { straight: new Set(), track: new Set() };
  for (const [area, groups] of Object.entries(reviews)) {
    const graph = applyTransitGradeReviews(
      JSON.parse(await data(`${area}-circumference`)),
      area,
    );
    const ids = groups.flatMap((review) => review.segmentIds);
    const reviewed = new Set(ids);
    assert.equal(reviewed.size, ids.length, area);
    for (const mode of ['straight', 'track']) {
      const { network } = graph[mode];
      for (const { id, type, grade } of network.segments) {
        if (type === 'ride' && grade === undefined) unresolved[mode].add(id);
      }
      const filtered = filterCircumferenceNetwork(
        network,
        null,
        new Set(TRANSIT_GRADES),
      );
      const searchable = filtered.segments.filter(({ type }) => type === 'ride');
      assert.deepEqual(
        new Set(searchable.map(({ id }) => id)),
        reviewed,
        `${area}/${mode}`,
      );
    }
  }
  assert.deepEqual(unresolved.straight, new Set(flagged));
  assert.deepEqual(unresolved.track, new Set(flagged));
});

test('transit line and transfer features expose the properties accepted by the inspector', async () => {
  const { track, straight } = applyTransitGradeReviews(
    JSON.parse(await data('nyc-circumference')),
    'nyc',
  );
  const express = track.network.segments.find(({ id }) => id === 'network-3ow1vv');
  assert.ok(express);
  assert.ok(express.coordinates.length > 2);
  assert.equal(
    straight.network.segments.find(({ id }) => id === express.id)?.coordinates.length,
    2,
  );
  const expressProperties = segmentPropertiesSchema.parse(
    transitSegmentProperties('nyc', express),
  );
  assert.equal(expressProperties.from, '125 St');
  assert.equal(expressProperties.to, '145 St');
  assert.equal(expressProperties.lines, 'D');
  assert.equal(expressProperties.grade, 'A');
  assert.ok(expressProperties.distance_m > 1_000);

  const ride = track.network.segments.find((segment) => segment.grade === 'A-');
  assert.ok(ride);
  const properties = segmentPropertiesSchema.parse(
    transitSegmentProperties('nyc', ride),
  );
  assert.equal(properties.segment_type, 'ride');
  assert.equal(properties.grade, 'A-');
  assert.ok(properties.distance_m > 0);

  const candidate = candidateFromNetworkPath(track.network, [ride.to.id, ride.from.id]);
  const reversed = segmentPropertiesSchema.parse(
    transitSegmentProperties('nyc', candidate.segments[0]),
  );
  assert.equal(reversed.from, properties.to);
  assert.equal(reversed.segment_id, properties.segment_id);
  assert.equal(reversed.grade, properties.grade);

  const transfer = track.network.segments.find(
    (segment) => segment.type === 'transfer' && segment.display !== false,
  );
  assert.ok(transfer);
  const walking = segmentPropertiesSchema.parse(
    transitSegmentProperties('nyc', transfer),
  );
  assert.equal(walking.segment_type, 'transfer');
  assert.equal(walking.grade, undefined);
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
