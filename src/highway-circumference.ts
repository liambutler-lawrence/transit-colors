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

const highwayFeaturePropertiesSchema = z.object({
  class: z.string(),
  country: z.string(),
  divided: z.string(),
  id: z.string().min(1),
  name: z.string(),
  number: z.string(),
  state: z.string(),
  type: z.string(),
});
const highwayFeatureSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(coordinateSchema).min(2),
  }),
  properties: highwayFeaturePropertiesSchema,
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
    biconnectedBlockCount: z.number().int().positive(),
    compressedEdgeCount: z.number().int().positive(),
    compressedNodeCount: z.number().int().positive(),
    crossBorderSeamConnectorCount: z.number().int().nonnegative(),
    endpointSnapCount: z.number().int().nonnegative(),
    faceCount: z.number().int().positive(),
    giantNetworkEdgeCount: z.number().int().positive(),
    giantNetworkNodeCount: z.number().int().positive(),
    optimizationMethod: z.literal('exact-planar-biconnected-outer-boundary'),
    optimizationStatus: z.literal('optimal'),
    sourceFeatureCount: z.number().int().positive(),
  }),
  network: z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(highwayFeatureSchema).min(1),
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
  }),
  source: z.string().min(1),
  source_url: z.url(),
  source_version: z.string().min(1),
});

export type HighwayCircumferenceData = z.infer<typeof highwayCircumferenceDataSchema>;
export type HighwayFeatureProperties = z.infer<typeof highwayFeaturePropertiesSchema>;

export const highwayMapFeaturePropertiesSchema = highwayFeaturePropertiesSchema.extend({
  kind: z.enum(['highway-network', 'highway-route']),
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
  const route: Feature<LineString, GeoJsonProperties> = {
    type: 'Feature',
    id: data.route.id,
    geometry: {
      type: 'LineString',
      coordinates: data.route.coordinates,
    },
    properties: {
      class: 'Controlled-access boundary',
      country: data.route.countries.join(', '),
      divided: 'Divided',
      id: data.route.id,
      kind: 'highway-route',
      name: 'Maximum-area highway circle',
      number: '',
      state: '',
      type: 'Boundary',
    },
  };
  return {
    type: 'FeatureCollection',
    features: [
      inside,
      ...data.network.features.map(
        (feature): Feature<LineString, GeoJsonProperties> => ({
          ...feature,
          properties: {
            ...feature.properties,
            kind: 'highway-network',
          },
        }),
      ),
      route,
    ],
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
