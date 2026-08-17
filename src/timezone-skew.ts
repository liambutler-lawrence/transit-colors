import { z } from 'zod';

const coordinateSchema = z.tuple([z.number(), z.number()]);
const linearRingSchema = z.array(coordinateSchema).min(4);
const polygonCoordinatesSchema = z.array(linearRingSchema).min(1);

export const timezoneSkewPropertiesSchema = z.object({
  id: z.number(),
  offset_hours: z.number(),
  offset_label: z.string(),
  places: z.string(),
  dst_places: z.string(),
  timezone_name: z.string(),
});

const timezoneTransitionSchema = z.tuple([z.number().int(), z.number().int()]);

export const timezoneRuleSchema = z.object({
  initialOffsetSeconds: z.number().int(),
  initialStandardOffsetSeconds: z.number().int(),
  transitions: z.array(timezoneTransitionSchema),
  standardTransitions: z.array(timezoneTransitionSchema),
});

export const timezoneSkewCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  metadata: z.object({
    baseline_instant: z.iso.datetime(),
    iana_release: z.string(),
    iana_source: z.url(),
    iana_source_sha256: z.string(),
    land_source: z.url(),
    land_source_commit: z.string(),
    land_source_license: z.string(),
    land_source_sha256: z.string(),
    license: z.string(),
    rules_end_epoch_seconds: z.number().int(),
    rules_start_epoch_seconds: z.number().int(),
    timezone_release: z.string(),
    timezone_countries: z.record(z.string(), z.array(z.string()).min(1)),
    timezone_rules: z.record(z.string(), timezoneRuleSchema),
    timezone_source: z.url(),
    timezone_source_sha256: z.string(),
  }),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.number(),
      properties: timezoneSkewPropertiesSchema,
      geometry: z.object({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(polygonCoordinatesSchema),
      }),
    }),
  ),
});

export type TimezoneSkewCollection = z.infer<typeof timezoneSkewCollectionSchema>;
export type TimezoneSkewProperties = z.infer<typeof timezoneSkewPropertiesSchema>;
export type TimezoneRule = z.infer<typeof timezoneRuleSchema>;

export const TIMEZONE_SKEW_LIMIT_MINUTES = 120;

/**
 * Returns the clock-time displacement of mean solar noon from 12:00.
 * Positive values mean that the Sun reaches its highest point later than noon.
 */
export function solarNoonSkewMinutes(
  longitude: number,
  utcOffsetHours: number,
): number {
  const rawSkew = utcOffsetHours * 60 - longitude * 4;
  return ((((rawSkew + 720) % 1_440) + 1_440) % 1_440) - 720;
}

export function formatSolarNoon(skewMinutes: number): string {
  const roundedMinutes = Math.round(12 * 60 + skewMinutes);
  const normalizedMinutes = ((roundedMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;
  const period = hour24 >= 12 ? 'pm' : 'am';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

export function formatSkewDuration(skewMinutes: number): string {
  const absoluteMinutes = Math.round(Math.abs(skewMinutes));
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}

export function describeSolarNoonSkew(skewMinutes: number): string {
  const roundedMinutes = Math.round(skewMinutes);
  if (roundedMinutes === 0) return '0 min from 12:00';
  return `${formatSkewDuration(roundedMinutes)} ${roundedMinutes > 0 ? 'later' : 'earlier'} than 12:00`;
}

export function formatLongitude(longitude: number): string {
  const direction = longitude < 0 ? 'W' : 'E';
  return `${Math.abs(longitude).toFixed(2)}° ${direction}`;
}
