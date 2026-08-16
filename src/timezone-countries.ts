import { z } from 'zod';

const coordinateSchema = z.tuple([z.number(), z.number()]);
const linearRingSchema = z.array(coordinateSchema).min(4);
const polygonCoordinatesSchema = z.array(linearRingSchema).min(1);

export const timezoneCountryPropertiesSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
  iso_a2: z.string(),
  iso_a3: z.string(),
});

export const timezoneCountryCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  metadata: z.object({
    license: z.literal('Public domain'),
    source_commit: z.string(),
    source_name: z.string(),
    source_sha256: z.string(),
    source_url: z.url(),
  }),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.number().int().nonnegative(),
      properties: timezoneCountryPropertiesSchema,
      geometry: z.object({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(polygonCoordinatesSchema),
      }),
    }),
  ),
});

export type TimezoneCountryCollection = z.infer<typeof timezoneCountryCollectionSchema>;
export type TimezoneCountryFeature = TimezoneCountryCollection['features'][number];
export type TimezoneCountryProperties = z.infer<typeof timezoneCountryPropertiesSchema>;
