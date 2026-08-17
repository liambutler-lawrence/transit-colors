import { circumferenceGeometryVariantsSchema } from '../circumference/schema.js';
import type { CircumferenceGeometryVariants } from '../circumference/types.js';

export async function fetchCircumferenceGeometryVariants(
  url: string,
): Promise<CircumferenceGeometryVariants> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load precomputed circumference data: ${response.status} ${response.statusText}`,
    );
  }
  return circumferenceGeometryVariantsSchema.parse(await response.json());
}
