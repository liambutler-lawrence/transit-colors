import {
  circumferenceGradientDistanceForArea,
  renderCircumferenceGradientAsync,
} from './circumference-map.js';
import {
  gradientWorkerRequestSchema,
  type GradientGeometry,
  type GradientWorkerResponse,
} from './gradient-render-protocol.js';

import { fetchParsed } from './parse.js';
import {
  roadCircleGeometrySchema,
  type RoadCircleGeometry,
} from './highway-circumference.js';

const geometries = new Map<string, Promise<GradientGeometry>>();
const roadGeometry = new Map<string, Promise<RoadCircleGeometry>>();

async function loadHighwayGeometry(circleUrl: string): Promise<GradientGeometry> {
  const url = new URL(circleUrl);
  const id = url.hash.slice(1);
  url.hash = '';
  const path = url.href;
  const pending = roadGeometry.get(path) ?? fetchParsed(path, roadCircleGeometrySchema);
  roadGeometry.set(path, pending);
  const data = await pending.catch((error: unknown) => {
    roadGeometry.delete(path);
    throw error;
  });
  const circle = data.circles[id];
  if (!circle)
    throw new Error(`Road circle ${id} is missing from the geometry catalog.`);
  return {
    coordinates: circle.coordinates,
    landmassPolygons: data.mask,
    maxDistanceMeters: circumferenceGradientDistanceForArea(circle.areaSquareMeters),
    outsideOnly: true,
  };
}
let cancelledId = -1;

function respond(message: GradientWorkerResponse): void {
  postMessage(message);
}

globalThis.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const message = gradientWorkerRequestSchema.parse(event.data);
  if (message.type === 'configure') {
    const geometry = message.geometry;
    const pending =
      'highwayUrl' in geometry
        ? loadHighwayGeometry(geometry.highwayUrl)
        : Promise.resolve(geometry);
    // A failed fetch is reported by the matching render request below.
    void pending.catch(() => undefined);
    geometries.set(message.key, pending);
    return;
  }
  if (message.type === 'cancel') {
    cancelledId = message.id;
    return;
  }
  const { id, key, view } = message;
  const cancelled = (): boolean => cancelledId === id;
  try {
    const geometry = await geometries.get(key);
    if (!geometry) throw new Error('Gradient geometry is unavailable.');
    if (cancelled()) {
      respond({ type: 'cancelled', id });
      return;
    }
    const canvas = new OffscreenCanvas(view.width, view.height);
    const rendered = await renderCircumferenceGradientAsync(
      canvas,
      geometry.coordinates,
      view.bounds,
      geometry.landmassPolygons,
      geometry.maxDistanceMeters,
      geometry.outsideOnly,
      cancelled,
    );
    if (!rendered || cancelled()) {
      respond({ type: 'cancelled', id });
      return;
    }
    const image = await canvas.convertToBlob({ type: 'image/png' });
    respond(cancelled() ? { type: 'cancelled', id } : { type: 'rendered', id, image });
  } catch (error) {
    respond({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
