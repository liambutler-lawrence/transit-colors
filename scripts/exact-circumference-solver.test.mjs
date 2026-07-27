import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExactCircumferenceModel,
  feedbackVertexRoots,
  signedAreaContributionSquareMeters,
  solveExactMaximumAreaCycle,
} from './exact-circumference-solver.mjs';

function station(id, coordinate) {
  return {
    coordinate,
    id,
    label: id,
    lineNames: ['T'],
    name: id,
    stationIds: [id],
  };
}

function ride(from, to) {
  return {
    coordinates: [from.coordinate, to.coordinate],
    from,
    id: `${from.id}-${to.id}`,
    lines: ['T'],
    to,
    type: 'ride',
  };
}

test('exact objective uses signed WGS84 ellipsoidal area', () => {
  const area = signedAreaContributionSquareMeters([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);
  assert.ok(Math.abs(Math.abs(area) / 1_000_000 - 12_308.778_361) < 0.001);
});

test('the model precludes crossings inside adjacent compressed corridors', () => {
  const [junction, firstMidpoint, firstEnd, secondMidpoint, secondEnd, last] = [
    station('junction', [0, 0]),
    station('first-midpoint', [0.5, 0]),
    station('first-end', [2, 2]),
    station('second-midpoint', [0, 1]),
    station('second-end', [2, -1]),
    station('last', [-1, 0]),
  ];
  const crossingNetwork = {
    stations: [junction, firstMidpoint, firstEnd, secondMidpoint, secondEnd, last],
    segments: [
      [junction, firstMidpoint],
      [firstMidpoint, firstEnd],
      [junction, secondMidpoint],
      [secondMidpoint, secondEnd],
      [junction, last],
      [firstEnd, secondEnd],
      [firstEnd, last],
      [secondEnd, last],
    ].map(([from, to]) => ride(from, to)),
  };

  assert.match(
    buildExactCircumferenceModel(crossingNetwork).lp,
    /crossing_0: x0 \+ x1 \+ x2 \+ x3 <= 1/,
  );
});

test('exact circumference solver proves the largest cycle beyond local faces', async () => {
  const stations = [
    station('a', [0, 0]),
    station('b', [0.04, 0]),
    station('c', [0.04, 0.03]),
    station('d', [0, 0.03]),
    station('e', [0.02, 0.012]),
  ];
  const [a, b, c, d, e] = stations;
  const network = {
    stations,
    segments: [ride(a, b), ride(b, c), ride(c, d), ride(d, a), ride(a, e), ride(e, c)],
  };

  const model = buildExactCircumferenceModel(network);
  const certificateRoots = feedbackVertexRoots(model);
  assert.ok(certificateRoots.length > 0);
  assert.match(
    buildExactCircumferenceModel(network, [], 1, true, null, [0]).lp,
    /forbidden_root_0: y0 = 0/,
  );
  const result = await solveExactMaximumAreaCycle(network);

  assert.equal(result.status, 'Optimal');
  assert.deepEqual(new Set(result.nodeIds), new Set(['a', 'b', 'c', 'd']));
  assert.ok(result.areaSquareMeters > 14_000_000);
});
