import { z } from 'zod';

import { fetchParsed } from './parse.js';
import {
  districtPlanSchema,
  districtRequestSchema,
  type DistrictPlan,
  type DistrictRequest,
  type DistrictResponse,
} from './representative-districts.js';

const messageSchema = districtRequestSchema.extend({ id: z.int().positive() });
const urls = import.meta.glob<string>('../data/connecticut-district-plans/*.json', {
  eager: true,
  import: 'default',
  query: '?url',
});
const plans = new Map<string, Promise<DistrictPlan>>();

function loadPlan({ method, seats }: DistrictRequest): Promise<DistrictPlan> {
  const url = urls[`../data/connecticut-district-plans/${method}-${seats}.json`];
  if (!url) throw new Error('The requested district plan is missing');
  const cached = plans.get(url);
  if (cached) return cached;
  const pending = fetchParsed(url, districtPlanSchema).catch((error: unknown) => {
    plans.delete(url);
    throw error;
  });
  plans.set(url, pending);
  return pending;
}

globalThis.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const request = messageSchema.safeParse(event.data);
  if (!request.success) return;
  const { id } = request.data;
  try {
    const plan = await loadPlan(request.data);
    globalThis.postMessage({ id, plan } satisfies DistrictResponse);
  } catch (error) {
    console.error('Representative district map could not be loaded.', error);
    globalThis.postMessage({
      id,
      error: 'Districts could not be loaded.',
    } satisfies DistrictResponse);
  }
};
