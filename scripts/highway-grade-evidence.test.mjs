import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reviewConnector,
  reviewMainline,
  roadEvidence,
  throughLaneCount,
} from './highway-grade-evidence.mjs';

test('through lane counts exclude marked exit, merge and bus-only lanes', () => {
  assert.equal(
    throughLaneCount({
      lanes: '5',
      'turn:lanes': 'through|none|through;right|slight_right|merge_to_left',
      'bus:lanes': 'designated|yes|yes|yes|yes',
    }),
    2,
  );
  assert.equal(
    throughLaneCount(
      { lanes: '1', 'turn:lanes': 'merge_to_left' },
      { connector: true },
    ),
    1,
  );
  assert.equal(throughLaneCount({ oneway: '-1', 'lanes:backward': '2' }), 2);
  assert.equal(throughLaneCount({ lanes: '2', 'turn:lanes': 'through' }), null);
  assert.equal(throughLaneCount({ lanes: '2', 'lanes:conditional': '1 @ (Sa)' }), null);
});

function pairedMotorway(lastNodeTags = {}, options) {
  const nodes = new Map([
    ['a', { coordinate: [0, -0.00008], tags: {} }],
    ['b', { coordinate: [0.001, -0.00008], tags: {} }],
    ['c', { coordinate: [0.002, -0.00008], tags: lastNodeTags }],
    ['d', { coordinate: [0.002, 0.00008], tags: {} }],
    ['e', { coordinate: [0, 0.00008], tags: {} }],
  ]);
  const ways = [
    {
      id: 'a',
      nodeIds: ['a', 'b'],
      tags: { highway: 'motorway', ref: 'I 1', lanes: '4' },
    },
    {
      id: 'b',
      nodeIds: ['b', 'c'],
      tags: { highway: 'motorway', ref: 'I 1', lanes: '2' },
    },
    {
      id: 'c',
      nodeIds: ['d', 'e'],
      tags: { highway: 'motorway', ref: 'I 1', lanes: '3' },
    },
  ];
  return roadEvidence({ nodes, ways }, options);
}

test('a lane drop limits the entire road section in either direction', () => {
  const evidence = pairedMotorway();
  const line = [
    [0, 0],
    [0.002, 0],
  ];
  assert.deepEqual(reviewMainline(line, evidence), { grade: 'A' });
  assert.deepEqual(reviewMainline(line.toReversed(), evidence), { grade: 'A' });
  assert.deepEqual(
    reviewMainline(
      [
        [0, 0],
        [0.0008, 0],
      ],
      evidence,
    ),
    { grade: 'A+' },
  );
});

test('a visible crossing prevents a grade from the motorway tags alone', () => {
  const evidence = pairedMotorway({ railway: 'level_crossing' });
  const result = reviewMainline(
    [
      [0, 0],
      [0.002, 0],
    ],
    evidence,
  );
  assert.equal(result.reason, 'Separation or access exception');
  assert.deepEqual(result.wayIds, ['b']);
  assert.deepEqual(
    reviewMainline(
      [
        [0, 0],
        [0.002, 0],
      ],
      evidence,
      { fullRubric: true },
    ),
    { grade: 'B' },
  );
});

test('a geometrically matched reciprocal ramp takes the lower direction grade', () => {
  const coordinates = [
    [0, 0],
    [0.0005, 0.0002],
    [0.001, 0],
  ];
  const source = new Map([
    ['a', { separation: true, lanes: 1 }],
    ['b', { separation: true, lanes: 2 }],
  ]);
  const parts = [{ coordinates, sourceWayIds: ['a', 'b'] }];
  assert.deepEqual(reviewConnector(coordinates, parts, source), { grade: 'A-' });
  const differentRamp = [
    [0, 0],
    [0.0005, -0.0002],
    [0.001, 0],
  ];
  assert.equal(
    reviewConnector(differentRamp, parts, source).reason,
    'Unverified reciprocal ramp paths',
  );
});

test('a motorway crossing marker requires verification and can be resolved by a bridge review', () => {
  const line = [
    [0, 0],
    [0.002, 0],
  ];
  const ambiguous = pairedMotorway({ highway: 'crossing' });
  assert.equal(
    reviewMainline(line, ambiguous, { fullRubric: true }).reason,
    'Separation or access exception',
  );
  const confirmedBridge = pairedMotorway(
    { highway: 'crossing' },
    { gradeSeparatedNodes: new Set(['c']) },
  );
  assert.deepEqual(reviewMainline(line, confirmedBridge, { fullRubric: true }), {
    grade: 'A',
  });
});
