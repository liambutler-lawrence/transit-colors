import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  watershedExitBodies,
  watershedExitBody,
  watershedFillColor,
} from './watershed-colors.ts';

test('receiving bodies cover every ocean basin exactly once', async () => {
  const summary = JSON.parse(
    await readFile(
      new URL('../data/north-america-watersheds-summary.json', import.meta.url),
    ),
  );
  const ids = watershedExitBodies.flatMap((body) => body.basins);
  assert.equal(ids.length, summary.outlet_classification.ocean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    new Set(watershedExitBodies.map((body) => body.color)).size,
    watershedExitBodies.length,
  );
  assert.ok(watershedFillColor().length);
});

test('major river systems use their receiving body, not their basin color', () => {
  for (const [id, expected] of [
    [72911, 'Gulf of Mexico'], // Mississippi, including Missouri and Ohio
    [82920, 'Gulf of California'], // Colorado
    [66083, 'Pacific Ocean'], // Columbia estuary
    [70334, 'Gulf of St. Lawrence'], // Great Lakes and St. Lawrence
    [28864, 'Bering Sea'], // Yukon
    [101193, 'Pacific Ocean'], // Balsas
    [106671, 'Caribbean Sea'], // Rio Grande de Matagalpa
    [90094, 'Atlantic Ocean'], // Bermuda, outside generalized marine polygon
    [23965, 'Arctic Ocean'], // Canadian Arctic Archipelago
  ])
    assert.equal(watershedExitBody(id, 'ocean'), expected);
  assert.equal(watershedExitBody(83239, 'unresolved_sink'), 'Unresolved');
  assert.equal(watershedExitBody(72911, 'unresolved_sink'), 'Unresolved');
  assert.equal(watershedExitBody(-1, 'ocean'), 'Receiving body unclassified');
});
