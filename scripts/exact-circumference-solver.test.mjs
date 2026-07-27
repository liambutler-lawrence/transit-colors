import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExactCircumferenceModel,
  feedbackVertexRoots,
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
  const result = await solveExactMaximumAreaCycle(network);

  assert.equal(result.status, 'Optimal');
  assert.deepEqual(new Set(result.nodeIds), new Set(['a', 'b', 'c', 'd']));
  assert.ok(result.areaSquareMeters > 14_000_000);
});
