import { z } from 'zod';
import { automaticTimezoneNameSchema } from './automatic-timezone-names.js';

export const AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES = 45;
export const AUTOMATIC_TIMEZONE_ASSIGNMENT_RULES = Object.freeze({
  method: 'minimax-whole-hour',
  maximum_skew_minutes: AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES,
  maximum_subdivision_level: 2,
});

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
  // Filled after resolving the UTC hierarchy; branches need no display name.
  naming: automaticTimezoneNameSchema.nullable().default(null),
});

export const automaticTimezoneDataSchema = z.object({
  metadata: z.object({
    // Parent geometry is pruned according to these rules. A different algorithm
    // must not treat that parent as a drawable leaf or silently invent fallbacks.
    assignment_rules: z.object({
      method: z.literal(AUTOMATIC_TIMEZONE_ASSIGNMENT_RULES.method),
      maximum_skew_minutes: z.literal(AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES),
      maximum_subdivision_level: z.literal(2),
    }),
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
  readonly maximumSkewMinutes: number;
}
export interface AutomaticTimezoneAssignment {
  readonly region: AutomaticRegion;
  readonly offsetHours: number;
  readonly fit: AutomaticTimezoneFit | null;
  readonly fallback: 'too-wide' | 'missing-subdivisions' | 'uncovered-area' | null;
}

/** Minimize the worst skew across whole polygon longitude intervals.
 * Each interval can use a different world copy, preserving islands across ±180°.
 */
function rankAutomaticTimezones(
  ranges: readonly LongitudeRange[],
): AutomaticTimezoneFit[] {
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
  return candidates;
}

export function optimizeAutomaticTimezone(
  ranges: readonly LongitudeRange[],
): AutomaticTimezoneFit {
  const best = rankAutomaticTimezones(ranges)[0];
  if (!best) throw new Error('No automatic timezone candidates.');
  return best;
}

/** Custom choices are strictly below 45 minutes, unlike the inclusive split rule. */
export function automaticTimezoneOptions(
  ranges: readonly LongitudeRange[],
): AutomaticTimezoneFit[] {
  return rankAutomaticTimezones(ranges).filter(
    ({ maximumSkewMinutes }) =>
      maximumSkewMinutes < AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES,
  );
}

/** Apply an offset to a resolved leaf without changing its geography or name. */
export function customizeAutomaticTimezone(
  assignment: AutomaticTimezoneAssignment,
  offsetHours: number | null,
): AutomaticTimezoneAssignment {
  if (offsetHours === null || offsetHours === assignment.offsetHours) return assignment;
  const fit = automaticTimezoneOptions(assignment.region.longitude_ranges).find(
    (candidate) => candidate.offsetHours === offsetHours,
  );
  if (!fit || assignment.region.geometry.coordinates.length === 0)
    throw new Error('This region has no eligible custom offset below 45 minutes.');
  return { ...assignment, offsetHours, fit, fallback: null };
}

/** Keep a region whole at exactly 45 minutes; subdivide only above the limit. */
export function fitAutomaticTimezone(
  ranges: readonly LongitudeRange[],
): AutomaticTimezoneFit | null {
  const best = optimizeAutomaticTimezone(ranges);
  return best.maximumSkewMinutes <= AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES ? best : null;
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
  const assignments = regions
    .filter(({ parent_id }) => parent_id === null)
    .flatMap(visit);
  for (const { region } of assignments) {
    if (region.geometry.coordinates.length === 0) {
      throw new Error(
        `Automatic region has no geometry: ${region.id}. Reload the map with matching boundary data.`,
      );
    }
  }
  return assignments;
}
