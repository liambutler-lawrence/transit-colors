import assert from 'node:assert/strict';
import test from 'node:test';
import { MultipartPMTilesSource } from './multipart-pmtiles.ts';

function fixture() {
  const calls = [];
  const parts = [
    [0, 1, 2, 3],
    [4, 5, 6],
    [7, 8, 9, 10, 11],
  ].map((values, index) => ({
    bytes: values.length,
    source: {
      getKey: () => `part-${index}`,
      getBytes: async (offset, length, signal) => {
        calls.push({ index, offset, length, signal });
        return {
          data: Uint8Array.from(values.slice(offset, offset + length)).buffer,
          etag: `physical-${index}`,
        };
      },
    },
  }));
  return {
    source: new MultipartPMTilesSource('archive', parts, 'whole-archive-digest'),
    calls,
  };
}

test('archive byte ranges cross physical part boundaries without changing data or ETag', async () => {
  const { source, calls } = fixture();
  const controller = new AbortController();
  const response = await source.getBytes(2, 8, controller.signal);
  assert.deepEqual([...new Uint8Array(response.data)], [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(response.etag, 'whole-archive-digest');
  assert.equal(source.getKey(), 'archive');
  assert.equal(source.byteLength, 12);
  assert.deepEqual(
    calls.map(({ index, offset, length }) => [index, offset, length]),
    [
      [0, 2, 2],
      [1, 0, 3],
      [2, 0, 3],
    ],
  );
  assert.ok(calls.every(({ signal }) => signal === controller.signal));
});

test('reads within one part fetch only that part and safely clamp at the archive end', async () => {
  const { source, calls } = fixture();
  const response = await source.getBytes(10, 10);
  assert.deepEqual([...new Uint8Array(response.data)], [10, 11]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, 2);
  assert.equal(calls[0].offset, 3);
  assert.equal(calls[0].length, 2);
});

test('invalid and aborted requests fail before fetching; truncated parts are rejected', async () => {
  const { source, calls } = fixture();
  for (const [offset, length] of [
    [-1, 1],
    [12, 1],
    [0, 0],
    [0.5, 2],
    [0, Infinity],
  ])
    await assert.rejects(source.getBytes(offset, length), RangeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getBytes(0, 1, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 0);
  const broken = new MultipartPMTilesSource(
    'broken',
    [
      {
        bytes: 2,
        source: {
          getKey: () => 'short',
          getBytes: async () => ({ data: new ArrayBuffer(1) }),
        },
      },
    ],
    'digest',
  );
  await assert.rejects(broken.getBytes(0, 2), /Incomplete/);
});
