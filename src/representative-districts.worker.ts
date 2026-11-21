import { z } from 'zod';

import studyUrl from '../data/connecticut-districts.json?url';
import { fetchParsed } from './parse.js';
import {
  calculateDistrictPlan,
  districtRequestSchema,
  districtStudySchema,
  type DistrictResponse,
} from './representative-districts.js';

const messageSchema = districtRequestSchema.extend({ id: z.int().positive() });
let study: ReturnType<typeof loadStudy> | undefined;

function loadStudy(): ReturnType<
  typeof fetchParsed<z.infer<typeof districtStudySchema>>
> {
  return fetchParsed(studyUrl, districtStudySchema).catch((error: unknown) => {
    study = undefined;
    throw error;
  });
}

globalThis.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const request = messageSchema.safeParse(event.data);
  if (!request.success) return;
  const { id } = request.data;
  try {
    const plan = calculateDistrictPlan(await (study ??= loadStudy()), request.data);
    globalThis.postMessage({ id, plan } satisfies DistrictResponse);
  } catch (error) {
    console.error('Representative districts could not be calculated.', error);
    globalThis.postMessage({
      id,
      error: 'Districts could not be calculated.',
    } satisfies DistrictResponse);
  }
};
