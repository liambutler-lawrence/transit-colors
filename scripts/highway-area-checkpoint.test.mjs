import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointHighwayAreaSolver } from './highway-area-checkpoint.mjs';

test('completed iterations survive interruption; changed models and options solve afresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'area-checkpoint-test-'));
  try {
    let calls = 0;
    const answer = { Status: 'Time limit reached', Columns: { x0: { Primal: 1 } } };
    const solve = checkpointHighwayAreaSolver(async (model) => {
      calls++;
      if (model === 'interrupted') throw new Error('interrupted');
      return answer;
    }, directory);
    await solve('first', { time_limit: 1 });
    await assert.rejects(solve('interrupted', {}), /interrupted/);
    const resumed = checkpointHighwayAreaSolver(async () => {
      calls++;
      return answer;
    }, directory);
    assert.deepEqual(await resumed('first', { time_limit: 1 }), answer);
    assert.equal(calls, 2);
    await resumed('second', { time_limit: 1 });
    await resumed('first', { time_limit: 2 });
    await resumed('interrupted', {});
    assert.equal(calls, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
