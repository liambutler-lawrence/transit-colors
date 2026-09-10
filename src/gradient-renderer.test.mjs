import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GradientRenderer } from './gradient-renderer.ts';
import {
  circumferenceGradientViewReusable,
  renderCircumferenceGradient,
  renderCircumferenceGradientAsync,
} from './circumference-map.ts';

const geometry = {
  coordinates: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ],
  landmassPolygons: [],
  maxDistanceMeters: 10_000,
  outsideOnly: false,
};
const view = (x = 0, span = 2) => ({
  bounds: [x, 0, x + span, span],
  width: 256,
  height: 256,
});

function harness(t) {
  const messages = [],
    presented = [],
    errors = [];
  const worker = {
    postMessage(message) {
      messages.push(message);
    },
    terminate() {},
    onmessage: null,
    onerror: null,
  };
  const renderer = new GradientRenderer({
    createWorker: () => worker,
    present: (key, image) => presented.push({ key, ...image }),
    onError: (error) => errors.push(error),
    delayMs: 0,
  });
  t.after(() => renderer.destroy());
  renderer.configure('highway', geometry);
  const renders = () => messages.filter((message) => message.type === 'render');
  const finish = (request, type = 'rendered') =>
    worker.onmessage({
      data: {
        id: request.id,
        type,
        image: new Blob(['pixels']),
        message: 'Network unavailable',
      },
    });
  return { renderer, worker, messages, presented, errors, renders, finish };
}

test('rapid views coalesce and a late response never replaces the latest view', async (t) => {
  const h = harness(t);
  h.renderer.request('highway', view());
  await delay(10);
  const first = h.renders()[0];
  for (let x = 2; x <= 20; x += 2) h.renderer.request('highway', view(x));
  await delay(10);
  assert.equal(h.renders().length, 1, 'only one in-flight render');
  h.finish(first);
  assert.equal(h.presented.length, 0, 'stale pixels never flash on the map');
  await delay(10);
  assert.equal(h.renders().length, 2, 'one replacement, not a gesture backlog');
  assert.deepEqual(h.renders()[1].view, view(20));
  h.finish(h.renders()[1]);
  assert.equal(h.presented.length, 1);
  assert.deepEqual(h.presented[0].view, view(20));
  assert.equal(
    h.messages.filter((m) => m.type === 'configure').length,
    1,
    'geometry copied only once',
  );
});

test('moving and hidden gradients never publish late images; resume uses the newest view', async (t) => {
  const h = harness(t);
  h.renderer.request('highway', view());
  await delay(10);
  h.renderer.setPaused(true);
  h.renderer.request('highway', view(8));
  h.finish(h.renders()[0]);
  await delay(10);
  assert.equal(h.presented.length, 0);
  assert.equal(h.renders().length, 1);
  h.renderer.setPaused(false);
  await delay(10);
  const latest = h.renders()[1];
  assert.deepEqual(latest.view, view(8));
  h.renderer.cancel('highway');
  h.finish(latest);
  assert.equal(h.presented.length, 0, 'hiding a gradient invalidates the result');
});

test('padded images cover small pans and returning views without rerendering or reuploading', async (t) => {
  const h = harness(t);
  h.renderer.request('highway', view());
  await delay(10);
  h.finish(h.renders()[0]);
  h.renderer.request('highway', view(0.1), [0.3, 0.2, 1.8, 1.8]);
  await delay(10);
  assert.equal(h.renders().length, 1);
  assert.equal(h.presented.length, 1, 'current cached image needs no texture upload');
  h.renderer.request('highway', view(10));
  await delay(10);
  h.finish(h.renders()[1]);
  h.renderer.request('highway', view());
  await delay(10);
  assert.equal(h.renders().length, 2);
  assert.deepEqual(h.presented.at(-1).view, view());
  h.renderer.request('highway', view(0.5, 0.5));
  await delay(10);
  assert.equal(h.renders().length, 3, 'zooming requires a sharper image');
});

test('new route geometry invalidates both cached and in-flight pixels', async (t) => {
  const h = harness(t);
  h.renderer.request('highway', view());
  await delay(10);
  const first = h.renders()[0];
  h.renderer.configure('highway', {
    ...geometry,
    coordinates: [
      [2, 2],
      [3, 3],
      [2, 2],
    ],
  });
  h.renderer.request('highway', view());
  h.finish(first);
  await delay(10);
  assert.equal(h.presented.length, 0);
  assert.equal(h.messages.filter((m) => m.type === 'configure').length, 2);
  h.finish(h.renders()[1]);
  assert.equal(h.presented.length, 1);
});

test('worker load failures keep the current image and allow a later retry', async (t) => {
  const h = harness(t);
  h.renderer.request('highway', view());
  await delay(10);
  h.finish(h.renders()[0]);
  h.renderer.request('highway', view(10));
  await delay(10);
  h.worker.onerror({ message: 'Slow or disconnected network', preventDefault() {} });
  assert.equal(h.presented.length, 1);
  assert.equal(h.errors.length, 1);
  h.renderer.request('highway', view(20));
  await delay(10);
  h.finish(h.renders().at(-1));
  assert.deepEqual(h.presented.at(-1).view, view(20));
});

test('geometry loads inside the worker and failed data requests can retry', async (t) => {
  const h = harness(t);
  h.renderer.configure('highway', { highwayUrl: 'https://example.test/route.json' });
  h.renderer.request('highway', view());
  await delay(10);
  const setup = h.messages.find((m) => m.type === 'configure');
  assert.deepEqual(setup.geometry, { highwayUrl: 'https://example.test/route.json' });
  h.finish(h.renders()[0], 'error');
  h.renderer.request('highway', view());
  await delay(10);
  assert.equal(h.messages.filter((m) => m.type === 'configure').length, 2);
  h.finish(h.renders()[1]);
  assert.equal(h.presented.length, 1);
});

test('cache requires complete coverage and Mercator resolution in both dimensions', () => {
  assert.equal(circumferenceGradientViewReusable(view(), view(), [0, 0, 2, 2]), true);
  assert.equal(
    circumferenceGradientViewReusable(view(), view(), [-0.1, 0, 2, 2]),
    false,
  );
  assert.equal(
    circumferenceGradientViewReusable(view(), view(0, 0.2), [0, 0, 0.2, 0.2]),
    false,
  );
  assert.equal(
    circumferenceGradientViewReusable({ ...view(), height: 64 }, view(), [0, 0, 2, 2]),
    false,
  );
});

function fakeCanvas() {
  let pixels = null;
  const context = {
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    clearRect() {},
    putImageData(image) {
      pixels = image.data;
    },
  };
  return { width: 64, height: 64, getContext: () => context, pixels: () => pixels };
}

test('cooperative worker rendering matches reference pixels and stops obsolete work', async () => {
  const reference = fakeCanvas(),
    asynchronous = fakeCanvas(),
    cancelled = fakeCanvas();
  renderCircumferenceGradient(
    reference,
    geometry.coordinates,
    view().bounds,
    [],
    10_000,
  );
  assert.equal(
    await renderCircumferenceGradientAsync(
      asynchronous,
      geometry.coordinates,
      view().bounds,
      [],
      10_000,
      false,
      () => false,
    ),
    true,
  );
  assert.deepEqual(asynchronous.pixels(), reference.pixels());
  let batches = 0;
  assert.equal(
    await renderCircumferenceGradientAsync(
      cancelled,
      geometry.coordinates,
      view().bounds,
      [],
      10_000,
      false,
      () => ++batches > 2,
    ),
    false,
  );
  assert.equal(cancelled.pixels(), null, 'a cancelled canvas is never published');
});
