import { z } from 'zod';
import rawReviews from '../../data/circumference-transit-grades.json';
import { transitGradeSchema } from '../circumference/grades.js';
import { lineLengthMeters, stableSegmentId } from '../circumference/graph.js';
import { circumferenceGeometryVariantsSchema } from '../circumference/schema.js';
import type {
  CircumferenceGeometryVariants,
  CircumferenceModeResult,
  CircumferenceNetworkSegment,
  CircumferenceSegment,
} from '../circumference/types.js';
import type { AreaKey, SegmentProperties } from './types.js';

const reviewSchema = z.object({
  corridor: z.string().min(1),
  grade: transitGradeSchema,
  sources: z.array(z.url()).min(1),
  segmentIds: z.array(z.string().min(1)).min(1),
});
const reviews = z
  .partialRecord(
    z.enum(['cdmx', 'nyc', 'singapore', 'atlanta', 'athens']),
    z.array(reviewSchema),
  )
  .parse(rawReviews);

export function transitSegmentProperties(
  areaKey: AreaKey,
  segment: CircumferenceSegment | CircumferenceNetworkSegment,
): SegmentProperties {
  return {
    area_key: areaKey,
    distance_m: segment.distanceMeters ?? lineLengthMeters(segment.coordinates),
    from: segment.from.name,
    from_label: segment.from.label ?? segment.from.name,
    ...(segment.type === 'ride' && segment.grade ? { grade: segment.grade } : {}),
    lines: segment.lines.join(', '),
    segment_id:
      'primaryLine' in segment
        ? segment.id
        : stableSegmentId(segment.from.id, segment.to.id),
    segment_type: segment.type,
    to: segment.to.name,
    to_label: segment.to.label ?? segment.to.name,
    transfer_minutes: segment.transferMinutes ?? '',
    transfer_source: segment.transferSource ?? '',
  };
}

export function applyTransitGradeReviews(
  variants: CircumferenceGeometryVariants,
  areaKey: AreaKey,
): CircumferenceGeometryVariants {
  const gradeById = new Map(
    reviews[areaKey]?.flatMap(({ grade, segmentIds }) =>
      segmentIds.map((id): [string, z.infer<typeof transitGradeSchema>] => [id, grade]),
    ),
  );
  const annotate = (variant: CircumferenceModeResult): CircumferenceModeResult => ({
    ...variant,
    network: {
      ...variant.network,
      segments: variant.network.segments.map((segment) => {
        const grade = gradeById.get(segment.id);
        return segment.type === 'ride' && grade !== undefined
          ? { ...segment, grade }
          : segment;
      }),
    },
  });
  return { straight: annotate(variants.straight), track: annotate(variants.track) };
}

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
  return applyTransitGradeReviews(
    circumferenceGeometryVariantsSchema.parse(await response.json()),
    areaKey,
  );
}
