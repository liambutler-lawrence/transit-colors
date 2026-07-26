import type {
  Coordinate,
  Mode,
  StationFeature,
  StreetFeature,
  StreetProperties,
} from '../domain.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly minX: number;
  readonly minY: number;
}

export interface IndexedStation {
  readonly id: string;
  readonly mode: Mode;
  readonly projected: Point;
}

export interface Grid<T extends { readonly projected: Point }> {
  candidates(bounds: Bounds, padding: number): T[];
}

export interface StationIndex {
  readonly exhaustive: boolean;
  readonly grid: Grid<IndexedStation>;
  readonly stations: readonly IndexedStation[];
}

export interface NearestStation<T> {
  readonly distanceSquared: number;
  readonly station: T;
}

export interface ModeAccessProperties {
  readonly distance?: string;
  readonly station?: string;
}

export interface ScoreOptions {
  readonly candidateCount?: number;
  readonly directDistanceProperty?: string;
  readonly directStationProperty?: string;
  readonly modeProperties?: Readonly<Partial<Record<Mode, ModeAccessProperties>>>;
}

export interface AsyncScoreOptions extends ScoreOptions {
  readonly batchSize?: number;
  readonly yieldControl?: () => Promise<void>;
}

export interface StreetAccessScorer {
  score(streetFeatures: StreetFeature[], options?: ScoreOptions): StreetFeature[];
  scoreAsync(
    streetFeatures: StreetFeature[],
    options?: AsyncScoreOptions,
  ): Promise<StreetFeature[]>;
}

export interface CreateScorerOptions {
  readonly exhaustive?: boolean;
  readonly modeForStation?: (feature: StationFeature) => Mode;
  readonly stationFilter?: (feature: StationFeature) => boolean;
}

export interface AssignNearestOptions {
  readonly batchSize?: number;
  readonly candidateCount?: number;
  readonly distanceForFeature?: (
    feature: StreetFeature,
    index: number,
  ) => number | undefined;
  readonly distancePropertyKey?: string | null;
  readonly onProgress?: (complete: number, total: number) => void;
  readonly propertyKey?: string;
  readonly stationFilter?: (feature: StationFeature) => boolean;
  readonly yieldControl?: () => Promise<void>;
}

export interface TransitNode {
  readonly coordinates: Coordinate;
  readonly groups: ReadonlySet<string>;
  readonly id: string;
  readonly mode: Mode;
  readonly name: string;
  readonly normalizedName: string;
}

export interface TransitGraph {
  readonly adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly nodeById: ReadonlyMap<string, TransitNode>;
  readonly nodes: readonly TransitNode[];
  readonly scheduleGraph?: ScheduleGraph;
}

export interface ScheduleGraph {
  readonly reverseTransfers: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly ridePredecessors: ReadonlyMap<
    string,
    readonly (readonly [string, number])[]
  >;
  readonly servicesByStation: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface WaitResult {
  readonly minutes: number;
  readonly routeCount: number;
  readonly scheduled: boolean;
}

export interface WaitLeg {
  readonly minutes: number;
  readonly serviceKey: string | null;
  readonly stationId: string;
  readonly type: 'wait';
}

export interface RideLeg {
  readonly fromStationId: string;
  readonly minutes: number;
  readonly mode?: Mode;
  readonly serviceKey: string | null;
  readonly toStationId: string;
  readonly type: 'ride';
}

export interface TransferLeg {
  readonly fromStationId: string;
  readonly minutes: number;
  readonly mode?: Mode;
  readonly serviceKey?: null;
  readonly toStationId: string;
  readonly type: 'transfer';
}

export type RouteLeg = RideLeg | TransferLeg | WaitLeg;

export interface TransitTimes extends Map<string, number> {
  routeFromStation(stationId: string): RouteLeg[] | null;
  serviceByStation?: ReadonlyMap<string, string>;
}

export interface TransitTimeOptions {
  readonly waitMinutesByService?: ReadonlyMap<string, number>;
  readonly waitMinutesByStation?: ReadonlyMap<string, number>;
}

export interface AccessCandidate {
  readonly distanceMeters: number;
  readonly stationId: string;
  readonly [key: string]: boolean | number | string;
}

export interface StreetTravel {
  readonly distance: number;
  readonly stationId: string | null;
  readonly totalMinutes: number;
  readonly transitMinutes: number;
  readonly walkingMinutes: number;
}

export interface AccessTravel extends AccessCandidate {
  readonly totalMinutes: number;
  readonly transitMinutes: number;
  readonly walkingMinutes: number;
}

export type MutableStreetProperties = StreetProperties;
