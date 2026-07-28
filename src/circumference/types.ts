import type { Coordinate, Mode } from '../domain.js';

export type NodeId = string;
export type EdgeKey = string;
export type CyclePath = NodeId[];
export type GraphEdge = readonly [NodeId, NodeId];
export type Adjacency = Map<NodeId, Set<NodeId>>;
export type ReadonlyAdjacency = ReadonlyMap<NodeId, ReadonlySet<NodeId>>;

export interface CircumferenceNode {
  readonly coordinate: Coordinate;
  readonly id: NodeId;
  label?: string | undefined;
  lineNames: string[];
  readonly name: string;
  readonly stationIds: string[];
}

export type NodeMap = ReadonlyMap<NodeId, CircumferenceNode>;

export interface TransferEdge {
  distanceMeters: number;
  minutes: number | null;
  source: 'inferred' | 'published';
}

export interface CircumferenceSegment {
  readonly coordinates: Coordinate[];
  readonly distanceMeters: number;
  readonly from: CircumferenceNode;
  readonly id: string;
  readonly lines: readonly string[];
  readonly primaryLine: string | null;
  readonly to: CircumferenceNode;
  readonly transferMinutes: number | null;
  readonly transferSource: TransferEdge['source'] | null;
  readonly type: 'ride' | 'transfer';
}

export interface CircumferenceCandidate {
  readonly areaSquareMeters: number;
  readonly coordinates: Coordinate[];
  readonly id: string;
  readonly lengthMeters: number;
  readonly lines: readonly string[];
  readonly nodeIds: readonly NodeId[];
  readonly rideLengthMeters: number;
  readonly segments: readonly CircumferenceSegment[];
  readonly stations: readonly CircumferenceNode[];
  readonly transferCount: number;
  readonly walkingLengthMeters: number;
}

export interface CircumferenceNetworkSegment {
  readonly coordinates: Coordinate[];
  readonly display?: boolean | undefined;
  readonly distanceMeters?: number | undefined;
  readonly from: CircumferenceNode;
  readonly id: string;
  readonly lines: readonly string[];
  readonly to: CircumferenceNode;
  readonly transferMinutes?: number | null | undefined;
  readonly transferSource?: TransferEdge['source'] | undefined;
  readonly type: 'ride' | 'transfer';
}

export interface CircumferenceNetwork {
  readonly segments: CircumferenceNetworkSegment[];
  readonly stations: CircumferenceNode[];
}

export interface RemovedShortcut {
  readonly from: string;
  readonly lines: readonly string[];
  readonly to: string;
}

export interface CircumferenceMethodology {
  readonly biconnectedComponentCount: number;
  readonly biconnectedComponentSizes: number[];
  readonly corePlatformNodeCount: number;
  readonly displayOnlyShortcutCount: number;
  readonly eligibleStationCount: number;
  readonly generatedCandidateCount: number;
  readonly inferredTransferCount: number;
  readonly optimizationGeometry?: 'straight-platform-edges' | undefined;
  readonly optimizationIterations?: number | undefined;
  readonly optimizationMethod?: 'exact-milp' | 'heuristic' | undefined;
  readonly optimizationMilliseconds?: number | undefined;
  readonly optimizationStatus?: 'optimal' | undefined;
  readonly platformNodeCount: number;
  readonly publishedTransferCount: number;
  readonly removedShortcutCount: number;
  readonly removedShortcuts: RemovedShortcut[];
  readonly trackGeometryAvailable: boolean;
  readonly trackGeometryEdgeCount: number;
  readonly trackGeometryEnabled: boolean;
  readonly trackGeometryMethod: string | null;
}

export interface CircumferenceModeResult {
  readonly candidates: CircumferenceCandidate[];
  readonly methodology: CircumferenceMethodology;
  readonly network: CircumferenceNetwork;
  readonly scheduleCandidates?: CircumferenceCandidate[] | undefined;
}

export type CircumferenceGeometryMode = 'straight' | 'track';
export type CircumferenceGeometryVariants = Readonly<
  Record<CircumferenceGeometryMode, CircumferenceModeResult>
>;

export interface CircumferenceResult extends CircumferenceModeResult {
  readonly geometryVariants: CircumferenceGeometryVariants;
}

export interface BuildCircumferenceOptions {
  readonly maxCandidates?: number;
  readonly minimumAreaSquareMeters?: number;
  readonly useTrackGeometry?: boolean;
}

export interface SelectCircumferenceOptions {
  readonly avoidedSegmentIds?: readonly string[];
  readonly requiredSegmentIds?: readonly string[];
}

export type EdgeStringSets = ReadonlyMap<EdgeKey, ReadonlySet<string>>;
export type MutableEdgeStringSets = Map<EdgeKey, Set<string>>;
export type EdgeCost = (fromId: NodeId, toId: NodeId) => number;

export interface TrackGeometry {
  readonly coordinates: Coordinate[];
  readonly fromId: NodeId;
}

export type TrackGeometryMap = ReadonlyMap<EdgeKey, TrackGeometry>;

export interface RankedPath {
  readonly areaSquareMeters: number;
  readonly edgeKeys: ReadonlySet<EdgeKey>;
  readonly path: CyclePath;
}

export interface FlowArc {
  capacity: number;
  readonly cost: number;
  readonly reverseIndex: number;
  readonly routeKey: string | null;
  readonly to: number;
}

export interface TransitRouteSummary {
  readonly mode: Mode;
  readonly name?: string;
}
