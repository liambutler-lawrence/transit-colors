import { z } from 'zod';

import {
  availableDistrictCounts,
  baselineDistrictCounts,
  defaultDistrictState,
  districtDataBundles,
  districtOutlineVersion,
  districtState,
} from './district-states.js';
import { fetchParsed } from './parse.js';
import {
  districtGeometrySchema,
  districtPlanSchema,
  districtRequestSchema,
  type DistrictPlan,
  type DistrictRequest,
  type DistrictResponse,
} from './representative-districts.js';

const messageSchema = districtRequestSchema.extend({
  id: z.int().positive(),
  state: z.string(),
  baseUrl: z.url(),
});
const urls = import.meta.glob<string>('../data/connecticut-district-plans/*.json', {
  eager: true,
  import: 'default',
  query: '?url',
});
const plans = new Map<string, Promise<DistrictPlan>>();
const outlines = new Map<string, Promise<DistrictPlan['outline']>>();
const statewidePlanSchema = districtPlanSchema.omit({ outline: true });

async function fetchCompressed<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not load ${url}`);
  const body = await response.arrayBuffer();
  const bytes = new Uint8Array(body);
  // Some static servers send .gz files with Content-Encoding, which fetch
  // already decodes. Other hosts deliver the same files as binary downloads.
  const decoded =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))
      : body;
  const json: unknown = await new Response(decoded).json();
  return schema.parse(json);
}

function loadOutline(base: URL): Promise<DistrictPlan['outline']> {
  const url = new URL('outline.json.gz', base).href;
  const cached = outlines.get(url);
  if (cached) return cached;
  const pending = fetchCompressed(url, districtGeometrySchema).catch(
    (error: unknown) => {
      outlines.delete(url);
      throw error;
    },
  );
  outlines.clear();
  outlines.set(url, pending);
  return pending;
}

async function fetchPlan(
  state: string,
  baseUrl: string,
  { method, seats }: DistrictRequest,
): Promise<DistrictPlan> {
  const selected = districtState(state);
  if (!selected || !availableDistrictCounts(selected).includes(seats)) {
    throw new Error('The requested state or district count is unknown');
  }
  const filename = `${method}-${seats}.json`;
  if (state === defaultDistrictState) {
    const url = urls[`../data/connecticut-district-plans/${filename}`];
    if (!url) throw new Error('The requested Connecticut district plan is missing');
    return fetchParsed(url, districtPlanSchema);
  }
  const needsSupplement = !baselineDistrictCounts.includes(seats);
  const bundle = districtDataBundles.find(
    ({ methods, supplemental }) =>
      supplemental === needsSupplement && methods.includes(method),
  );
  if (!bundle) throw new Error('The requested algorithm has no district data bundle');
  const outlineBase = new URL(
    `district-plans/${districtOutlineVersion}/${selected.fips}/`,
    baseUrl,
  );
  const planBase = new URL(
    `district-plans/${bundle.version}/${selected.fips}/`,
    baseUrl,
  );
  const [outline, plan] = await Promise.all([
    loadOutline(outlineBase),
    fetchCompressed(new URL(`${filename}.gz`, planBase).href, statewidePlanSchema),
  ]);
  if (
    plan.totalPopulation !== selected.population ||
    plan.districts.features.length !== seats
  ) {
    throw new Error(
      'The district plan does not match the requested state and district count',
    );
  }
  return { ...plan, outline };
}

globalThis.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const request = messageSchema.safeParse(event.data);
  if (!request.success) return;
  const { baseUrl, id, method, seats, state } = request.data;
  const key = `${state}/${method}-${seats}`;
  try {
    let pending = plans.get(key);
    if (!pending) {
      pending = fetchPlan(state, baseUrl, request.data).catch((error: unknown) => {
        plans.delete(key);
        throw error;
      });
      if (plans.size >= 3) {
        const oldest = plans.keys().next().value;
        if (oldest) plans.delete(oldest);
      }
      plans.set(key, pending);
    }
    const plan = await pending;
    globalThis.postMessage({ id, plan } satisfies DistrictResponse);
  } catch (error) {
    console.error('Representative district map could not be loaded.', error);
    globalThis.postMessage({
      id,
      error: 'Districts could not be loaded.',
    } satisfies DistrictResponse);
  }
};
