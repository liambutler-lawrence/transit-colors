import { z } from 'zod';

const longitudeRangeSchema = z.tuple([z.number(), z.number()]);
const pointSchema = z.tuple([z.number(), z.number()]);
const polygonsSchema = z.array(z.array(z.array(pointSchema).min(4)).min(1));

export const automaticRegionSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().nullable(),
  name: z.string().min(1),
  country_name: z.string().min(1),
  country_code: z.string().min(1),
  iso_code: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  longitude_ranges: z.array(longitudeRangeSchema).min(1),
  source: z.string().min(1),
  // Empty for branches: only terminal regions need browser geometry.
  geometry: z.object({ type: z.literal('MultiPolygon'), coordinates: polygonsSchema }),
  coverage_note: z.string(),
});

export const automaticTimezoneDataSchema = z.object({
  metadata: z.object({
    sources: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        url: z.url(),
        sha256: z.string(),
        license: z.string(),
      }),
    ),
    notes: z.array(z.string()),
  }),
  regions: z.array(automaticRegionSchema).min(1),
});

export type AutomaticRegion = z.infer<typeof automaticRegionSchema>;
export type AutomaticTimezoneData = z.infer<typeof automaticTimezoneDataSchema>;
export type LongitudeRange = readonly [number, number];
export interface AutomaticTimezoneFit {
  readonly offsetHours: number;
  readonly toleranceMinutes: 30 | 60;
  readonly maximumSkewMinutes: number;
}
export interface AutomaticTimezoneAssignment {
  readonly region: AutomaticRegion;
  readonly offsetHours: number;
  readonly fit: AutomaticTimezoneFit | null;
  readonly fallback: 'too-wide' | 'missing-subdivisions' | 'uncovered-area' | null;
}

/** Whole polygon longitude intervals, not just centroids or endpoints of a country bbox.
 * Each interval can use a different world copy, preserving islands across ±180°.
 */
export function fitAutomaticTimezone(
  ranges: readonly LongitudeRange[],
): AutomaticTimezoneFit | null {
  if (
    ranges.length === 0 ||
    ranges.some(
      ([west, east]) => !Number.isFinite(west) || !Number.isFinite(east) || west > east,
    )
  ) {
    throw new Error(
      'Automatic time zones require nonempty, finite longitude intervals.',
    );
  }
  const candidates = Array.from({ length: 24 }, (_, index) => {
    // UTC+12 and UTC−12 share a meridian; use +12 consistently for this solar simulation.
    const offsetHours = index - 11;
    const maximumSkewMinutes = Math.max(
      ...ranges.map(([west, east]) => {
        const meridian = offsetHours * 15;
        const nearestMeridian =
          meridian + 360 * Math.round(((west + east) / 2 - meridian) / 360);
        return (
          4 *
          Math.max(Math.abs(west - nearestMeridian), Math.abs(east - nearestMeridian))
        );
      }),
    );
    return { offsetHours, maximumSkewMinutes };
  }).sort(
    (left, right) =>
      left.maximumSkewMinutes - right.maximumSkewMinutes ||
      Math.abs(left.offsetHours) - Math.abs(right.offsetHours) ||
      left.offsetHours - right.offsetHours,
  );
  for (const toleranceMinutes of [30, 60] satisfies (30 | 60)[]) {
    const candidate = candidates.find(
      ({ maximumSkewMinutes }) => maximumSkewMinutes < toleranceMinutes,
    );
    if (candidate) return { ...candidate, toleranceMinutes };
  }
  return null;
}

/** Resolve a country before its children; stop after the second administrative level. */
export function assignAutomaticTimezones(
  regions: readonly AutomaticRegion[],
): AutomaticTimezoneAssignment[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  if (byId.size !== regions.length) throw new Error('Duplicate automatic region IDs.');
  const children = new Map<string, AutomaticRegion[]>();
  for (const region of regions) {
    if (region.parent_id === null) {
      if (region.level !== 0) throw new Error(`Non-country root: ${region.id}`);
    } else {
      const parent = byId.get(region.parent_id);
      if (
        !parent ||
        parent.level + 1 !== region.level ||
        parent.country_code !== region.country_code
      ) {
        throw new Error(`Invalid automatic region parent: ${region.id}`);
      }
      children.set(parent.id, [...(children.get(parent.id) ?? []), region]);
    }
  }
  function visit(region: AutomaticRegion): AutomaticTimezoneAssignment[] {
    const fit = fitAutomaticTimezone(region.longitude_ranges);
    if (fit && !region.coverage_note)
      return [{ region, offsetHours: fit.offsetHours, fit, fallback: null }];
    const subdivisions = children.get(region.id) ?? [];
    if (region.level < 2 && subdivisions.length > 0) return subdivisions.flatMap(visit);
    return [
      {
        region,
        offsetHours: 0,
        fit: null,
        fallback: region.coverage_note
          ? 'uncovered-area'
          : region.level === 2
            ? 'too-wide'
            : 'missing-subdivisions',
      },
    ];
  }
  return regions.filter(({ parent_id }) => parent_id === null).flatMap(visit);
}
