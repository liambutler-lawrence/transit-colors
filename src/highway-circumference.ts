import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  Polygon,
} from 'geojson';
import { z } from 'zod';

import { coordinateSchema, type Coordinate, type LandmassArea } from './domain.js';
import { ROAD_GRADES, roadGradeSchema } from './circumference/grades.js';
import {
  circumferenceGradientBounds,
  circumferenceGradientDistanceForArea,
} from './circumference-map.js';

export const highwayFeaturePropertiesSchema = z.object({
  class: z.string(),
  country: z.string(),
  divided: z.string(),
  id: z.string().min(1),
  name: z.string(),
  number: z.string(),
  role: z.enum(['mainline', 'connector', 'source-seam']),
  state: z.string(),
  type: z.string(),
});
const highwayLandmassSchema = z.object({
  area_m2: z.number().positive(),
  id: z.string().min(1),
  label: z.string().min(1),
  mask: z.array(z.array(z.array(coordinateSchema).min(4)).min(1)).min(1),
});

export const highwayCircumferenceDataSchema = z.object({
  centerline_method: z.string().min(1),
  criterion: z.string().min(1),
  landmass: highwayLandmassSchema,
  landmass_source: z.string().min(1),
  landmass_source_url: z.url(),
  landmass_source_version: z.string().min(1),
  methodology: z.object({
    alternativeRampPathCount: z.number().int().nonnegative(),
    biconnectedBlockCount: z.number().int().positive(),
    compressedEdgeCount: z.number().int().positive(),
    compressedNodeCount: z.number().int().positive(),
    crossBorderSeamConnectorCount: z.number().int().nonnegative(),
    directionalRampPathCount: z.number().int().nonnegative(),
    endpointSnapCount: z.number().int().nonnegative(),
    faceCount: z.number().int().positive(),
    giantNetworkEdgeCount: z.number().int().positive(),
    giantNetworkNodeCount: z.number().int().positive(),
    interchangeConnectorCount: z.number().int().nonnegative(),
    terminalConnectorCount: z.number().int().nonnegative().default(0),
    osmPrecisionMainlineCount: z.number().int().nonnegative(),
    optimizationMethod: z.enum([
      'source-topology-wgs84-area-integer-program',
      'exact-planar-biconnected-outer-boundary',
      'coarse-exact-detailed-map-match',
      'detailed-macro-cycle-expansion',
      'detailed-macro-cycle-with-envelope-ears',
      'detailed-topology-preserving-perimeter-ears',
    ]),
    optimizationStatus: z.enum([
      'optimal',
      'optimal-guide-refined',
      'validated-detailed',
    ]),
    objectiveUpperBoundSquareMeters: z.number().nonnegative().optional(),
    optimizationIterations: z.number().int().positive().optional(),
    sourceFeatureCount: z.number().int().positive(),
    unpairedRampPathCount: z.number().int().nonnegative(),
  }),
  network: z.object({
    featureCount: z.number().int().positive(),
    sourceLayer: z.literal('highways'),
    tileUrl: z.string().min(1),
  }),
  route: z.object({
    areaSquareMeters: z.number().positive(),
    boundaryCorridorCount: z.number().int().positive(),
    boundaryRoadFeatureCount: z.number().int().positive(),
    containedLandAreaSquareMeters: z.number().positive(),
    coordinates: z.array(coordinateSchema).min(4),
    countries: z.array(z.string()).min(1),
    id: z.string().min(1),
    lengthMeters: z.number().positive(),
    outsideLandAreaSquareMeters: z.number().nonnegative(),
    segments: z
      .array(
        z.object({
          coordinates: z.array(coordinateSchema).min(2),
          grade: roadGradeSchema.optional(),
          id: z.string().min(1),
          role: z.enum(['mainline', 'connector']),
        }),
      )
      .min(1),
  }),
  precision_source: z.string().min(1),
  precision_source_license: z.string().min(1),
  precision_source_url: z.url(),
  source: z.string().min(1),
  source_url: z.url(),
  source_version: z.string().min(1),
});

export type HighwayCircumferenceData = z.infer<typeof highwayCircumferenceDataSchema>;
export const highwayCircumferenceSummarySchema = highwayCircumferenceDataSchema
  .omit({ landmass: true, route: true })
  .extend({
    landmass: highwayLandmassSchema.omit({ mask: true }),
    route: highwayCircumferenceDataSchema.shape.route
      .omit({ coordinates: true, segments: true })
      .extend({
        bounds: z.tuple([coordinateSchema, coordinateSchema]),
        gradientBounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
  });
export type HighwayCircumferenceSummary = z.infer<
  typeof highwayCircumferenceSummarySchema
>;

const roadCircleSchema = z.object({
  id: z.string(),
  areaSquareMeters: z.number().positive(),
  boundaryCorridorCount: z.number().int().positive(),
  bounds: z.tuple([coordinateSchema, coordinateSchema]),
  containedLandAreaSquareMeters: z.number().nonnegative(),
  gradientBounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  grades: z.array(roadGradeSchema).min(1),
  lengthMeters: z.number().positive(),
  outsideLandAreaSquareMeters: z.number().nonnegative(),
});
export type RoadCircle = z.infer<typeof roadCircleSchema>;

export const gradedRoadNetworkSchema = z.object({
  sourceVersion: z.string(),
  segmentCount: z.number().int().positive(),
  coverage: z.partialRecord(
    z.union([roadGradeSchema, z.literal('pending')]),
    z.number().int().nonnegative(),
  ),
  bounds: z.tuple([coordinateSchema, coordinateSchema]),
  landmassLabel: z.string(),
  selections: z.array(z.string().nullable()).length(1 << ROAD_GRADES.length),
  circles: z.record(z.string(), roadCircleSchema),
});
export type GradedRoadNetwork = z.infer<typeof gradedRoadNetworkSchema>;

export const roadCircleGeometrySchema = z.object({
  mask: highwayLandmassSchema.shape.mask,
  circles: z.record(
    z.string(),
    z.object({
      coordinates: z.array(coordinateSchema).min(4),
      areaSquareMeters: z.number().positive(),
    }),
  ),
});
export type RoadCircleGeometry = z.infer<typeof roadCircleGeometrySchema>;

export function highwayCircumferenceSummary(
  data: HighwayCircumferenceData,
): HighwayCircumferenceSummary {
  return highwayCircumferenceSummarySchema.parse({
    ...data,
    route: {
      ...data.route,
      bounds: highwayBounds(data.route.coordinates),
      gradientBounds: circumferenceGradientBounds(
        data.route.coordinates,
        circumferenceGradientDistanceForArea(data.route.areaSquareMeters),
      ),
    },
  });
}
export type HighwayFeatureProperties = z.infer<typeof highwayFeaturePropertiesSchema>;

export const highwayMapFeaturePropertiesSchema = highwayFeaturePropertiesSchema.extend({
  segment_id: z.number().int().positive().optional(),
  grade: roadGradeSchema.optional(),
  review_issue: z.string().optional(),
  osm_ways: z.string().optional(),
  circles: z.string().optional(),
  kind: z
    .enum([
      'highway-network-mainline',
      'highway-network-connector',
      'highway-route-mainline',
      'highway-route-connector',
    ])
    .optional(),
});

export function highwayLandmassArea(data: HighwayCircumferenceData): LandmassArea {
  const { landmass } = data;
  return {
    area_m2: landmass.area_m2,
    gradient_bounds: [-125, 24, -66, 50],
    label: landmass.label,
    landmasses: [landmass],
    mask: landmass.mask,
  };
}

export function highwayFeatureCollection(
  data: HighwayCircumferenceData,
): FeatureCollection<Geometry, GeoJsonProperties> {
  const inside: Feature<Polygon, GeoJsonProperties> = {
    type: 'Feature',
    id: 'north-america-highway-inside',
    geometry: {
      type: 'Polygon',
      coordinates: [data.route.coordinates],
    },
    properties: {
      kind: 'highway-inside',
    },
  };
  const route = data.route.segments.map(
    (segment): Feature<LineString, GeoJsonProperties> => ({
      type: 'Feature',
      id: segment.id,
      geometry: {
        type: 'LineString',
        coordinates: segment.coordinates,
      },
      properties: {
        class:
          segment.role === 'connector'
            ? 'Boundary paired interchange connector'
            : 'Controlled-access boundary',
        country: data.route.countries.join(', '),
        divided: segment.role === 'connector' ? 'Averaged directional pair' : 'Divided',
        id: data.route.id,
        kind: `highway-route-${segment.role}`,
        name: 'Maximum-area highway circle',
        number: '',
        role: segment.role,
        state: '',
        type: segment.role === 'connector' ? 'Connector' : 'Boundary',
      },
    }),
  );
  return {
    type: 'FeatureCollection',
    features: [inside, ...route],
  };
}

export function highwayBounds(
  coordinates: readonly Coordinate[],
): [[number, number], [number, number]] {
  const bounds = coordinates.reduce(
    (result, [longitude, latitude]) => ({
      east: Math.max(result.east, longitude),
      north: Math.max(result.north, latitude),
      south: Math.min(result.south, latitude),
      west: Math.min(result.west, longitude),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.north],
  ];
}
