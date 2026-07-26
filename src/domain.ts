import { z } from 'zod';

export const coordinateSchema = z.tuple([z.number(), z.number()]);
export const modeSchema = z.enum([
  'brt',
  'cable_car',
  'commuter_rail',
  'light_rail',
  'monorail',
  'regional_rail',
  'subway',
]);
export const stationStatusSchema = z.enum(['future', 'open']);

const propertyValueSchema = z.union([z.boolean(), z.number(), z.string(), z.null()]);
export const mapFeaturePropertiesSchema = z.record(z.string(), propertyValueSchema);

export const stationPropertiesSchema = z
  .object({
    id: z.string().min(1),
    mode: modeSchema,
    name: z.string(),
    status: stationStatusSchema,
    brand: z.string().optional(),
    local_ref: z.string().optional(),
    network: z.string().optional(),
    opening_date: z.string().optional(),
    operator: z.string().optional(),
    ref: z.string().optional(),
    route_name: z.string().optional(),
    route_ref: z.string().optional(),
    status_detail: z.string().optional(),
    status_source: z.string().optional(),
    system: z.string().optional(),
  })
  .catchall(propertyValueSchema);

export const streetPropertiesSchema = z
  .object({
    d: z.number().optional(),
    h: z.string().optional(),
    n: z.string().optional(),
    o: z.number().optional(),
  })
  .catchall(propertyValueSchema);

export const stationFeatureSchema = z.object({
  geometry: z.object({
    coordinates: coordinateSchema,
    type: z.literal('Point'),
  }),
  properties: stationPropertiesSchema,
  type: z.literal('Feature'),
});

export const streetFeatureSchema = z.object({
  geometry: z.object({
    coordinates: z.array(coordinateSchema).min(2),
    type: z.literal('LineString'),
  }),
  properties: streetPropertiesSchema,
  type: z.literal('Feature'),
});

export const stationCollectionSchema = z.object({
  features: z.array(stationFeatureSchema),
  type: z.literal('FeatureCollection'),
});

export const streetCollectionSchema = z.object({
  features: z.array(streetFeatureSchema),
  type: z.literal('FeatureCollection'),
});

const serviceWindowSchema = z.tuple([z.number(), z.number(), z.number().positive()]);
const serviceDaysSchema = z.array(z.array(serviceWindowSchema)).length(7);

export const scheduleSchema = z
  .object({
    graph: z.object({
      e: z.record(
        z.string(),
        z.array(z.tuple([z.string().min(1), z.number(), z.string().min(1)])),
      ),
      t: z.record(z.string(), z.array(z.tuple([z.string().min(1), z.number()]))),
    }),
    routes: z.record(
      z.string(),
      z
        .object({
          mode: modeSchema,
          agency: z.string().optional(),
          description: z.string().optional(),
          name: z.string().optional(),
        })
        .loose(),
    ),
    stations: z.record(
      z.string(),
      z.object({
        d: serviceDaysSchema,
        r: z.array(z.string()),
        p: z.record(z.string(), serviceDaysSchema).optional(),
      }),
    ),
    source: z.string().optional(),
    timezone: z.string().optional(),
  })
  .loose();

const boundsSchema = z.object({
  east: z.number(),
  north: z.number(),
  south: z.number(),
  west: z.number(),
});

export const metadataSchema = z
  .object({
    bbox: boundsSchema,
    city: z.string(),
    future_station_count: z.number().int().nonnegative().optional(),
    histogram: z
      .object({
        under_2500_m: z.number().int().nonnegative(),
      })
      .optional(),
    max_distance_m: z.number().positive(),
    near_count_threshold_m: z.number().nonnegative().optional(),
    near_counts_by_mode_selection: z
      .record(z.string(), z.number().nonnegative())
      .optional(),
    open_station_count: z.number().int().nonnegative().optional(),
    station_count: z.number().int().nonnegative(),
    station_modes: z.partialRecord(modeSchema, z.number().int().nonnegative()),
    station_modes_future: z
      .partialRecord(modeSchema, z.number().int().nonnegative())
      .optional(),
    station_modes_open: z
      .partialRecord(modeSchema, z.number().int().nonnegative())
      .optional(),
    street_count: z.number().int().nonnegative().optional(),
  })
  .loose();

const polygonSchema = z.array(coordinateSchema).min(4);
const landmassSchema = z.object({
  area_m2: z.number().positive(),
  id: z.string().min(1),
  label: z.string().min(1),
  mask: polygonSchema.nullable(),
});
const landmassAreaSchema = z.object({
  area_m2: z.number().positive(),
  gradient_bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  label: z.string().min(1),
  landmasses: z.array(landmassSchema).min(1),
  mask: polygonSchema.nullable(),
});

export const landmassDataSchema = z
  .object({
    areas: z.object({
      cdmx: landmassAreaSchema,
      nyc: landmassAreaSchema,
    }),
  })
  .loose();

export type Coordinate = z.infer<typeof coordinateSchema>;
export type LandmassArea = z.infer<typeof landmassAreaSchema>;
export type LandmassData = z.infer<typeof landmassDataSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type ServiceDays = z.infer<typeof serviceDaysSchema>;
export type StationCollection = z.infer<typeof stationCollectionSchema>;
export type StationFeature = z.infer<typeof stationFeatureSchema>;
export type StationProperties = z.infer<typeof stationPropertiesSchema>;
export type StreetCollection = z.infer<typeof streetCollectionSchema>;
export type StreetFeature = z.infer<typeof streetFeatureSchema>;
export type StreetProperties = z.infer<typeof streetPropertiesSchema>;
