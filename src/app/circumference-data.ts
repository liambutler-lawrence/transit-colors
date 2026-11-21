import { circumferenceGeometryVariantsSchema } from '../circumference/schema.js';
import type { CircumferenceGeometryVariants } from '../circumference/types.js';
import type { AreaKey } from './types.js';

// Singapore's two central passenger corridors between Little India and Chinatown.
// Downtown Line DT12–DT19 and North East Line NE4–NE7 use separate running
// tracks in underground alignments (LTA line profiles and contract C706).
const singaporeGradeAPairs = new Set([
  'network-1ej1vm7', // Little India – Rochor
  'network-b4iaz1', // Rochor – Bugis
  'network-ufupkj', // Bugis – Promenade
  'network-184h9vj', // Promenade – Bayfront
  'network-pohz23', // Bayfront – Downtown
  'network-1l43n9n', // Downtown – Telok Ayer
  'network-l487db', // Telok Ayer – Chinatown
  'network-1x71smj', // Chinatown – Clarke Quay
  'network-19x2tmx', // Clarke Quay – Dhoby Ghaut
  'network-177w2xr', // Dhoby Ghaut – Little India
]);

export async function fetchCircumferenceGeometryVariants(
  url: string,
  areaKey: AreaKey,
): Promise<CircumferenceGeometryVariants> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load precomputed circumference data: ${response.status} ${response.statusText}`,
    );
  }
  const variants = circumferenceGeometryVariantsSchema.parse(await response.json());
  if (areaKey !== 'singapore') return variants;
  for (const { network } of Object.values(variants)) {
    network.segments = network.segments.map((segment) =>
      segment.type === 'ride' &&
      segment.grade === undefined &&
      singaporeGradeAPairs.has(segment.id)
        ? { ...segment, grade: 'A' }
        : segment,
    );
  }
  return variants;
}
