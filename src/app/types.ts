import type {
  ExpressionSpecification,
  FilterSpecification,
  StyleSpecification,
} from 'maplibre-gl';
import { z } from 'zod';

import type {
  CircumferenceCandidate,
  CircumferenceGeometryMode,
  CircumferenceGeometryVariants,
  CircumferenceMethodology,
  CircumferenceNetwork,
} from '../circumference/types.js';
import type {
  LandmassData,
  Metadata,
  Mode,
  Schedule,
  StationCollection,
  StationFeature,
  StreetProperties,
} from '../domain.js';
import type { TransitGraph, TransitTimes, WaitResult } from '../routing/types.js';

export type AreaKey = 'cdmx' | 'nyc' | 'singapore' | 'atlanta' | 'athens';
export type Product = 'access' | 'circumference';

export interface AreaConfig {
  readonly buildCommand: string;
  readonly center: [number, number];
  readonly circumference: string;
  readonly label: string;
  readonly liveRoads?: boolean;
  readonly metadata: string;
  readonly schedules: string;
  readonly stations: string;
  readonly streetTiles?: string;
  readonly supportsDestination: boolean;
  readonly timezone: string;
  readonly zoom: number;
}

export interface CircumferenceState {
  activeLineNames: string[];
  areaKey: AreaKey | null;
  avoidedSegmentIds: Set<string>;
  candidates: CircumferenceCandidate[];
  geometryMode: CircumferenceGeometryMode | null;
  geometryVariants: CircumferenceGeometryVariants | null;
  inspectedSegmentId: string;
  methodology: CircumferenceMethodology | null;
  network: CircumferenceNetwork;
  overrideId: string;
  requiredSegmentIds: Set<string>;
  scheduleKey: string;
  selected: CircumferenceCandidate | null;
}

export interface AppState {
  destination: StationFeature | null;
  destinationChoiceByStationId: Map<string, string>;
  destinationIdsByChoice: Map<string, string[]>;
  destinationStationIds: string[];
  metadata: Metadata | null;
  scheduleMinute: number;
  schedules: Schedule | null;
  scheduleWeekday: number;
  stationById: Map<string, StationFeature>;
  timeScaleMinutes: number;
  transitGraph: TransitGraph | null;
  transitTimes: TransitTimes | null;
  waitDetailsByService: Map<string, WaitResult>;
  waitDetailsByStation: Map<string, WaitResult>;
  waitMinutesByService: Map<string, number>;
  waitMinutesByStation: Map<string, number>;
}

export interface AppRuntime {
  activeAreaKey: AreaKey;
  activeProduct: Product;
  basemapInstallScheduled: boolean;
  circumferenceLandmasses: LandmassState;
  circumferenceSchedules: Record<AreaKey, Schedule | null>;
  futureStreetAccessStationIds: string[];
  initialLoadComplete: boolean;
  liveStreetRefreshInFlight: boolean;
  liveStreetRefreshPending: boolean;
  liveStreetRefreshSequence: number;
  liveStreetRefreshTimer: number | undefined;
  loadingCanFinish: boolean;
  loadingOperation: LoadingOperation | null;
  loadedStations: StationCollection;
  loadSequence: number;
  maxDistanceMeters: number;
  pendingBasemapStyle: StyleSpecification | null;
  selectedStreetProperties: SelectedStreetProperties;
  streetAccessStationIds: string[];
}

export interface MetadataDetail {
  readonly label: string;
  readonly value: boolean | string | number | null | undefined;
}

export interface LoadingOperation {
  readonly label: string;
  readonly startedAt: number;
  readonly type: 'area' | 'filter' | 'initial';
}

export interface CompletedOperation extends LoadingOperation {
  readonly durationMs: number;
}

export interface PerformanceLog {
  circumferenceReadyMs: number | null;
  dataFetchedMs: number | null;
  firstStreetRenderMs: number | null;
  initialReadyMs: number | null;
  lastInteractionMs: number | null;
  operations: CompletedOperation[];
  startedAt: number;
  styleLoadedMs: number | null;
}

export const segmentPropertiesSchema = z.object({
  area_key: z.enum(['cdmx', 'nyc', 'singapore', 'atlanta', 'athens']),
  distance_m: z.number(),
  from: z.string(),
  from_label: z.string(),
  kind: z.string(),
  lines: z.string(),
  segment_id: z.string(),
  segment_type: z.enum(['segment', 'transfer']),
  to: z.string(),
  to_label: z.string(),
  transfer_minutes: z.union([z.number(), z.literal('')]),
  transfer_source: z.string(),
});
export type SegmentProperties = z.infer<typeof segmentPropertiesSchema>;

export type DistanceProperties = Readonly<Record<Mode, string>>;
export type SelectedStreetProperties = StreetProperties | null;
export type LandmassState = LandmassData | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStyleSpecification(value: unknown): value is StyleSpecification {
  if (!isRecord(value)) return false;
  const layers = value['layers'];
  const sources = value['sources'];
  return (
    value['version'] === 8 &&
    isRecord(sources) &&
    Array.isArray(layers) &&
    layers.every(
      (layer) =>
        isRecord(layer) &&
        typeof layer['id'] === 'string' &&
        typeof layer['type'] === 'string',
    )
  );
}

export const styleSpecificationSchema = z.custom<StyleSpecification>(
  isStyleSpecification,
  'Invalid MapLibre style document',
);

export const expressionSpecificationSchema = z.custom<ExpressionSpecification>(
  (value) => Array.isArray(value) && typeof value[0] === 'string',
  'Invalid MapLibre expression',
);

export const filterSpecificationSchema = z.custom<FilterSpecification>(
  (value) => Array.isArray(value) && typeof value[0] === 'string',
  'Invalid MapLibre filter',
);
