import type { Coordinate, Schedule } from '../domain.js';
import type {
  Adjacency,
  CyclePath,
  EdgeKey,
  EdgeStringSets,
  FlowArc,
  GraphEdge,
  MutableEdgeStringSets,
  NodeId,
  NodeMap,
  ReadonlyAdjacency,
  TrackGeometryMap,
} from './types.js';

export const EARTH_RADIUS_M = 6_371_008.8;
export const INFERRED_TRANSFER_DISTANCE_WITHOUT_PUBLISHED_M = 900;
export const EDGE_KEY_SEPARATOR = '\u0000';
export const SHORTCUT_MINIMUM_LENGTH_M = 1_400;
export const SAME_LINE_SHORTCUT_RATIO = 1.8;
export const NAMED_EXPRESS_SHORTCUT_RATIO = 6;
export const CORRIDOR_SHORTCUT_RATIO = 1.6;
export const CORRIDOR_AVERAGE_WIDTH_M = 900;
export const SHORTCUT_STATION_ALIGNMENT_M = 160;
export const CYCLE_SEARCH_BEAM_WIDTH = 4;
export const CYCLE_SEARCH_MAX_ROUNDS = 18;
export const OUTER_CYCLE_MERGE_SEED_LIMIT = 80;
export const EAR_EXPANSION_SEED_LIMIT = 10;
export const EAR_EXPANSION_ROUND_SEED_LIMIT = 4;
export const EAR_EXPANSION_MAX_ROUNDS = 5;
export const EAR_EXPANSION_PAIR_LIMIT = 42;
export const SPANNING_TREE_RANDOM_SEEDS = 48;
export const EXTREME_ANCHOR_PAIR_LIMIT = 28;

export function getRequired<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing graph entry: ${String(key)}`);
  return value;
}

export function emptyStrings(): string[] {
  return [];
}

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function normalizeLongitudeDelta(delta: number): number {
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
}

export function normalizeStationName(value: string = ''): string {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:linea|line|l)\s*(?:\d+|[a-z])\b/gi, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function distanceMeters(
  [lonA, latA]: Coordinate,
  [lonB, latB]: Coordinate,
): number {
  const latARadians = toRadians(latA);
  const latBRadians = toRadians(latB);
  const latitudeDelta = latBRadians - latARadians;
  const longitudeDelta = toRadians(lonB - lonA);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latARadians) * Math.cos(latBRadians) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

/**
 * Chamberlain-Duquette spherical polygon area. At metro scale this avoids the
 * latitude distortion of ordinary degree-based shoelace calculations while
 * keeping route and landmass measurements in one consistent model.
 */
export function polygonAreaSquareMeters(coordinates: readonly Coordinate[]): number {
  if (coordinates.length < 3) return 0;

  const firstCoordinate = coordinates[0];
  const finalCoordinate = coordinates.at(-1);
  const ring =
    coordinates.length > 3 &&
    firstCoordinate !== undefined &&
    finalCoordinate !== undefined &&
    firstCoordinate[0] === finalCoordinate[0] &&
    firstCoordinate[1] === finalCoordinate[1]
      ? coordinates.slice(0, -1)
      : coordinates;
  let areaAccumulator = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (current === undefined || next === undefined) continue;
    const longitudeDelta = normalizeLongitudeDelta(
      toRadians(next[0]) - toRadians(current[0]),
    );
    areaAccumulator +=
      longitudeDelta *
      (2 + Math.sin(toRadians(current[1])) + Math.sin(toRadians(next[1])));
  }

  return Math.abs((areaAccumulator * EARTH_RADIUS_M ** 2) / 2);
}

export function lineLengthMeters(coordinates: readonly Coordinate[]): number {
  if (coordinates.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous !== undefined && current !== undefined) {
      length += distanceMeters(previous, current);
    }
  }
  return length;
}

function orientation(first: Coordinate, second: Coordinate, third: Coordinate): number {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function segmentsProperlyIntersect(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
): boolean {
  const firstSideStart = orientation(firstStart, firstEnd, secondStart);
  const firstSideEnd = orientation(firstStart, firstEnd, secondEnd);
  const secondSideStart = orientation(secondStart, secondEnd, firstStart);
  const secondSideEnd = orientation(secondStart, secondEnd, firstEnd);
  return (
    Math.sign(firstSideStart) !== Math.sign(firstSideEnd) &&
    Math.sign(secondSideStart) !== Math.sign(secondSideEnd)
  );
}

export function hasSelfIntersection(coordinates: readonly Coordinate[]): boolean {
  for (let firstIndex = 0; firstIndex < coordinates.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % coordinates.length;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < coordinates.length;
      secondIndex += 1
    ) {
      const secondNext = (secondIndex + 1) % coordinates.length;
      if (
        firstIndex === secondIndex ||
        firstIndex === secondNext ||
        firstNext === secondIndex
      ) {
        continue;
      }
      const firstStart = coordinates[firstIndex];
      const firstEnd = coordinates[firstNext];
      const secondStart = coordinates[secondIndex];
      const secondEnd = coordinates[secondNext];
      if (
        firstStart !== undefined &&
        firstEnd !== undefined &&
        secondStart !== undefined &&
        secondEnd !== undefined &&
        segmentsProperlyIntersect(firstStart, firstEnd, secondStart, secondEnd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export class UnionFind {
  private readonly parent: Map<string, string>;

  constructor(ids: readonly string[]) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  has(id: string): boolean {
    return this.parent.has(id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent) throw new Error(`Unknown union-find node: ${id}`);
    if (parent === id) return id;
    const root: string = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(firstId: string, secondId: string): boolean {
    if (!this.has(firstId) || !this.has(secondId)) return false;
    const firstRoot = this.find(firstId);
    const secondRoot = this.find(secondId);
    if (firstRoot === secondRoot) return false;
    this.parent.set(secondRoot, firstRoot);
    return true;
  }
}

export function edgeKey(firstId: NodeId, secondId: NodeId): EdgeKey {
  return [firstId, secondId].sort().join(EDGE_KEY_SEPARATOR);
}

function copyCoordinate(coordinate: Coordinate): Coordinate {
  return [coordinate[0], coordinate[1]];
}

export function trackGeometryByEdge(schedules: Schedule): TrackGeometryMap {
  const geometries = new Map<EdgeKey, { coordinates: Coordinate[]; fromId: NodeId }>();
  for (const [fromId, entries] of Object.entries(schedules.graph.g ?? {})) {
    for (const [toId, coordinates] of entries) {
      geometries.set(edgeKey(fromId, toId), {
        fromId,
        coordinates: coordinates.map(copyCoordinate),
      });
    }
  }
  return geometries;
}

export function orientedEdgeCoordinates(
  fromId: NodeId,
  toId: NodeId,
  nodes: NodeMap,
  geometriesByEdge: TrackGeometryMap,
  useTrackGeometry: boolean,
): Coordinate[] {
  const fallback = [
    copyCoordinate(getRequired(nodes, fromId).coordinate),
    copyCoordinate(getRequired(nodes, toId).coordinate),
  ];
  if (!useTrackGeometry) return fallback;
  const geometry = geometriesByEdge.get(edgeKey(fromId, toId));
  if (!geometry) return fallback;
  const coordinates =
    geometry.fromId === fromId
      ? geometry.coordinates
      : [...geometry.coordinates].reverse();
  return coordinates.map(copyCoordinate);
}

export function joinSegmentCoordinates(
  segments: readonly { readonly coordinates: readonly Coordinate[] }[],
): Coordinate[] {
  const coordinates: Coordinate[] = [];
  for (const segment of segments) {
    const additions =
      coordinates.length > 0 ? segment.coordinates.slice(1) : segment.coordinates;
    coordinates.push(...additions.map(copyCoordinate));
  }
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (
    first !== undefined &&
    last !== undefined &&
    (first[0] !== last[0] || first[1] !== last[1])
  ) {
    coordinates.push(copyCoordinate(first));
  }
  return coordinates;
}

export function serviceFamily(routeId: string, lineName: string): string {
  return /X$/i.test(String(lineName).trim())
    ? String(routeId).replace(/X$/i, '')
    : String(routeId);
}

export function routeIdForService(serviceKey: string): string {
  const separatorIndex = String(serviceKey).lastIndexOf('/');
  return separatorIndex === -1
    ? String(serviceKey)
    : String(serviceKey).slice(0, separatorIndex);
}

export function shortestAlternatePath(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
  familiesByEdge: EdgeStringSets,
  fromId: NodeId,
  toId: NodeId,
  maximumDistance: number,
  allowedLineFamilies: ReadonlySet<string> | null = null,
): { readonly distanceMeters: number; readonly nodeIds: NodeId[] } | null {
  const excludedEdgeKey = edgeKey(fromId, toId);
  const distances = new Map<NodeId, number>([[fromId, 0]]);
  const previous = new Map<NodeId, NodeId>();
  const pending: [number, NodeId][] = [[0, fromId]];

  while (pending.length > 0) {
    pending.sort((first, second) => second[0] - first[0]);
    const current = pending.pop();
    if (!current) break;
    const [currentDistance, currentId] = current;
    if (currentDistance !== distances.get(currentId)) continue;
    if (currentId === toId) {
      const nodeIds = [toId];
      while (nodeIds[0] !== fromId) {
        const previousId = previous.get(nodeIds[0] ?? '');
        if (!previousId) return null;
        nodeIds.unshift(previousId);
      }
      return { distanceMeters: currentDistance, nodeIds };
    }

    for (const neighborId of adjacency.get(currentId) ?? []) {
      const currentEdgeKey = edgeKey(currentId, neighborId);
      if (currentEdgeKey === excludedEdgeKey) continue;
      if (
        allowedLineFamilies &&
        ![...(familiesByEdge.get(currentEdgeKey) ?? [])].some((family) =>
          allowedLineFamilies.has(family),
        )
      ) {
        continue;
      }

      const nextDistance =
        currentDistance +
        distanceMeters(
          getRequired(nodes, currentId).coordinate,
          getRequired(nodes, neighborId).coordinate,
        );
      if (
        nextDistance > maximumDistance ||
        nextDistance >= (distances.get(neighborId) ?? Infinity)
      ) {
        continue;
      }
      distances.set(neighborId, nextDistance);
      previous.set(neighborId, currentId);
      pending.push([nextDistance, neighborId]);
    }
  }

  return null;
}

function distanceToSegmentMeters(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
): number {
  const latitudeRadians = toRadians(point[1]);
  const project = ([longitude, latitude]: Coordinate): readonly [number, number] => [
    toRadians(longitude - point[0]) * EARTH_RADIUS_M * Math.cos(latitudeRadians),
    toRadians(latitude - point[1]) * EARTH_RADIUS_M,
  ];
  const [startX, startY] = project(start);
  const [endX, endY] = project(end);
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) return Math.hypot(startX, startY);
  const progress = Math.max(
    0,
    Math.min(1, -(startX * deltaX + startY * deltaY) / squaredLength),
  );
  return Math.hypot(startX + progress * deltaX, startY + progress * deltaY);
}

function trackGeometryFollowsIntermediateStations(
  key: EdgeKey,
  pathNodeIds: readonly NodeId[],
  nodes: NodeMap,
  geometriesByEdge: TrackGeometryMap,
): boolean | null {
  const geometry = geometriesByEdge.get(key);
  const intermediateIds = pathNodeIds.slice(1, -1);
  if (!geometry || geometry.coordinates.length < 2 || intermediateIds.length === 0) {
    return null;
  }

  return intermediateIds.every((nodeId) => {
    const coordinate = getRequired(nodes, nodeId).coordinate;
    let closestDistance = Infinity;
    for (let index = 1; index < geometry.coordinates.length; index += 1) {
      const start = geometry.coordinates[index - 1];
      const end = geometry.coordinates[index];
      if (!start || !end) continue;
      closestDistance = Math.min(
        closestDistance,
        distanceToSegmentMeters(coordinate, start, end),
      );
    }
    return closestDistance <= SHORTCUT_STATION_ALIGNMENT_M;
  });
}

/**
 * GTFS stop sequences describe where a train stops, not the physical track
 * between those stops. Express and limited-stop trips therefore create long
 * chords over the local station chain. Those chords are useful for journey
 * timing, but treating them as map edges invents skinny triangular "loops".
 *
 * Remove a chord when a reasonably short local path already connects its ends.
 * Same-line alternatives are decisive; cross-line alternatives are accepted
 * only when the chord and path enclose a narrow corridor.
 */
export function removeServiceShortcuts(
  adjacency: Adjacency,
  nodes: NodeMap,
  linesByEdge: EdgeStringSets,
  familiesByEdge: EdgeStringSets,
  ambiguousLineNames: ReadonlySet<string>,
  normalizedLinesByEdge: MutableEdgeStringSets,
  hiddenNetworkShortcuts: Set<EdgeKey>,
  displayOnlyShortcuts: Set<EdgeKey>,
  geometriesByEdge: TrackGeometryMap,
): Set<EdgeKey> {
  const shortcuts = new Set<EdgeKey>();
  const allLineNames = new Set(
    [...linesByEdge.values()].flatMap((lines) => [...lines]),
  );
  const normalizeLinesOntoPath = (
    nodeIds: readonly NodeId[],
    lineNames: readonly string[],
  ): void => {
    for (let index = 1; index < nodeIds.length; index += 1) {
      const previousId = nodeIds[index - 1];
      const currentId = nodeIds[index];
      if (previousId === undefined || currentId === undefined) continue;
      const key = edgeKey(previousId, currentId);
      const normalizedLines = normalizedLinesByEdge.get(key) ?? new Set<string>();
      for (const lineName of lineNames) normalizedLines.add(lineName);
      normalizedLinesByEdge.set(key, normalizedLines);
    }
  };

  for (const [fromId, neighbors] of adjacency) {
    for (const toId of neighbors) {
      const key = edgeKey(fromId, toId);
      if (shortcuts.has(key) || fromId > toId) continue;

      const directDistance = distanceMeters(
        getRequired(nodes, fromId).coordinate,
        getRequired(nodes, toId).coordinate,
      );

      const directLineNames = [...(linesByEdge.get(key) ?? [])];
      if (
        directLineNames.length > 0 &&
        directLineNames.every((lineName) => ambiguousLineNames.has(lineName))
      ) {
        continue;
      }

      const namedExpressBaseLines = new Set(
        directLineNames.flatMap((lineName) => {
          const trimmedName = lineName.trim();
          const baseLineName = trimmedName.slice(0, -1);
          return trimmedName.length > 1 &&
            /X$/i.test(trimmedName) &&
            allLineNames.has(baseLineName) &&
            !directLineNames.includes(baseLineName)
            ? [baseLineName]
            : [];
        }),
      );
      const namedExpressPath =
        namedExpressBaseLines.size === 0
          ? null
          : shortestAlternatePath(
              adjacency,
              nodes,
              linesByEdge,
              fromId,
              toId,
              directDistance * NAMED_EXPRESS_SHORTCUT_RATIO,
              namedExpressBaseLines,
            );
      if (namedExpressPath && namedExpressPath.nodeIds.length > 2) {
        // Express GTFS edges are bounded by stops, not by physical turnouts.
        // Normalize a named express edge only against the corresponding base
        // service's local chain. This cannot delete atomic local edges merely
        // because a second express chord offers a path around them.
        normalizeLinesOntoPath(namedExpressPath.nodeIds, directLineNames);
        hiddenNetworkShortcuts.add(key);
        if (directDistance >= SHORTCUT_MINIMUM_LENGTH_M) {
          shortcuts.add(key);
        } else {
          displayOnlyShortcuts.add(key);
        }
        continue;
      }

      const directFamilies = new Set(familiesByEdge.get(key) ?? []);
      const sameLinePath = shortestAlternatePath(
        adjacency,
        nodes,
        familiesByEdge,
        fromId,
        toId,
        directDistance * SAME_LINE_SHORTCUT_RATIO,
        directFamilies,
      );
      if (sameLinePath && sameLinePath.nodeIds.length > 2) {
        const followsStations = trackGeometryFollowsIntermediateStations(
          key,
          sameLinePath.nodeIds,
          nodes,
          geometriesByEdge,
        );
        if (directDistance >= SHORTCUT_MINIMUM_LENGTH_M || followsStations === true) {
          // Some same-line alternatives are genuinely separate alignments,
          // such as PATH service between Grove Street and Journal Square.
          if (followsStations !== false) {
            normalizeLinesOntoPath(sameLinePath.nodeIds, directLineNames);
            hiddenNetworkShortcuts.add(key);
            if (directDistance < SHORTCUT_MINIMUM_LENGTH_M) {
              displayOnlyShortcuts.add(key);
              continue;
            }
          }
          shortcuts.add(key);
          continue;
        }
      }
      if (directDistance < SHORTCUT_MINIMUM_LENGTH_M) continue;

      const corridorPath = shortestAlternatePath(
        adjacency,
        nodes,
        familiesByEdge,
        fromId,
        toId,
        directDistance * CORRIDOR_SHORTCUT_RATIO,
      );
      if (!corridorPath || corridorPath.nodeIds.length <= 2) continue;
      const followsStations = trackGeometryFollowsIntermediateStations(
        key,
        corridorPath.nodeIds,
        nodes,
        geometriesByEdge,
      );

      const ring = corridorPath.nodeIds.map(
        (nodeId) => getRequired(nodes, nodeId).coordinate,
      );
      const averageWidth = (2 * polygonAreaSquareMeters(ring)) / directDistance;
      if (averageWidth <= CORRIDOR_AVERAGE_WIDTH_M) {
        shortcuts.add(key);
        if (followsStations !== false) {
          normalizeLinesOntoPath(corridorPath.nodeIds, directLineNames);
          hiddenNetworkShortcuts.add(key);
        }
      }
    }
  }

  for (const key of shortcuts) {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    if (!fromId || !toId) continue;
    adjacency.get(fromId)?.delete(toId);
    adjacency.get(toId)?.delete(fromId);
  }

  return shortcuts;
}

export function removeBranches(adjacency: Adjacency): void {
  const activeNodes = new Set<NodeId>(adjacency.keys());
  const pending = [...adjacency]
    .filter(([, neighbors]) => neighbors.size < 2)
    .map(([nodeId]) => nodeId);

  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId) break;
    if (!activeNodes.delete(nodeId)) continue;

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!activeNodes.has(neighborId)) continue;
      const neighbors = adjacency.get(neighborId);
      if (!neighbors) continue;
      neighbors.delete(nodeId);
      if (neighbors.size < 2) pending.push(neighborId);
    }
  }

  for (const nodeId of [...adjacency.keys()]) {
    if (!activeNodes.has(nodeId)) {
      adjacency.delete(nodeId);
      continue;
    }
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) continue;
    for (const neighborId of [...neighbors]) {
      if (!activeNodes.has(neighborId)) neighbors.delete(neighborId);
    }
  }
}

export function biconnectedComponents(adjacency: ReadonlyAdjacency): GraphEdge[][] {
  const discovery = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const parent = new Map<NodeId, NodeId>();
  const edgeStack: GraphEdge[] = [];
  const components: GraphEdge[][] = [];
  let clock = 0;

  function visit(nodeId: NodeId): void {
    clock += 1;
    discovery.set(nodeId, clock);
    low.set(nodeId, clock);

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, nodeId);
        edgeStack.push([nodeId, neighborId]);
        visit(neighborId);
        low.set(
          nodeId,
          Math.min(getRequired(low, nodeId), getRequired(low, neighborId)),
        );

        if (getRequired(low, neighborId) >= getRequired(discovery, nodeId)) {
          const edges: GraphEdge[] = [];
          let edge: GraphEdge | undefined;
          do {
            edge = edgeStack.pop();
            if (edge) edges.push(edge);
          } while (edge && !(edge[0] === nodeId && edge[1] === neighborId));
          if (edges.length >= 3) components.push(edges);
        }
      } else if (
        neighborId !== parent.get(nodeId) &&
        getRequired(discovery, neighborId) < getRequired(discovery, nodeId)
      ) {
        low.set(
          nodeId,
          Math.min(getRequired(low, nodeId), getRequired(discovery, neighborId)),
        );
        edgeStack.push([nodeId, neighborId]);
      }
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!discovery.has(nodeId)) visit(nodeId);
  }

  return components;
}

export function componentAdjacency(edges: readonly GraphEdge[]): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const [fromId, toId] of edges) {
    const fromNeighbors = adjacency.get(fromId) ?? new Set<NodeId>();
    const toNeighbors = adjacency.get(toId) ?? new Set<NodeId>();
    fromNeighbors.add(toId);
    toNeighbors.add(fromId);
    adjacency.set(fromId, fromNeighbors);
    adjacency.set(toId, toNeighbors);
  }
  return adjacency;
}

export function stableCandidateId(nodeIds: readonly NodeId[]): string {
  const canonical = nodeIds
    .flatMap((nodeId, index) => {
      const nextId = nodeIds[(index + 1) % nodeIds.length];
      return nextId ? [edgeKey(nodeId, nextId)] : [];
    })
    .sort()
    .join('|');
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `route-${(hash >>> 0).toString(36)}`;
}

export function cycleEdgeKeys(path: readonly NodeId[]): Set<EdgeKey> {
  return new Set(
    path.flatMap((nodeId, index) => {
      const nextId = path[(index + 1) % path.length];
      return nextId ? [edgeKey(nodeId, nextId)] : [];
    }),
  );
}

export function pathsFromCycleEdges(
  edgeKeys: ReadonlySet<EdgeKey>,
): CyclePath[] | null {
  if (edgeKeys.size < 3) return null;
  const adjacency: Adjacency = new Map();
  for (const key of edgeKeys) {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    if (!fromId || !toId) return null;
    const fromNeighbors = adjacency.get(fromId) ?? new Set<NodeId>();
    const toNeighbors = adjacency.get(toId) ?? new Set<NodeId>();
    fromNeighbors.add(toId);
    toNeighbors.add(fromId);
    adjacency.set(fromId, fromNeighbors);
    adjacency.set(toId, toNeighbors);
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.size !== 2)) {
    return [];
  }

  const unvisited = new Set(adjacency.keys());
  const paths: CyclePath[] = [];
  while (unvisited.size > 0) {
    const startId = [...unvisited].sort()[0];
    if (!startId) break;
    const path: CyclePath = [];
    let previousId: NodeId | null = null;
    let currentId = startId;

    do {
      path.push(currentId);
      unvisited.delete(currentId);
      const neighbors = [...getRequired(adjacency, currentId)];
      const nextId = neighbors[0] === previousId ? neighbors[1] : neighbors[0];
      if (!nextId) return [];
      previousId = currentId;
      currentId = nextId;
    } while (currentId !== startId && path.length <= adjacency.size);

    if (currentId !== startId || path.length < 3) return [];
    paths.push(path);
  }
  return paths;
}

export function pathFromCycleEdges(edgeKeys: ReadonlySet<EdgeKey>): CyclePath | null {
  const paths = pathsFromCycleEdges(edgeKeys);
  return paths?.length === 1 ? (paths[0] ?? null) : null;
}

export function mergeCyclePathOptions(
  firstPath: readonly NodeId[],
  secondPath: readonly NodeId[],
): CyclePath[] {
  const mergedEdges = cycleEdgeKeys(firstPath);
  for (const key of cycleEdgeKeys(secondPath)) {
    if (mergedEdges.has(key)) mergedEdges.delete(key);
    else mergedEdges.add(key);
  }
  return pathsFromCycleEdges(mergedEdges) ?? [];
}

export function mergeCyclePaths(
  firstPath: readonly NodeId[],
  secondPath: readonly NodeId[],
): CyclePath | null {
  const paths = mergeCyclePathOptions(firstPath, secondPath);
  return paths.length === 1 ? (paths[0] ?? null) : null;
}

export function fundamentalCycles(adjacency: ReadonlyAdjacency): CyclePath[] {
  const discovery = new Map<NodeId, number>();
  const parent = new Map<NodeId, NodeId>();
  const cycles: CyclePath[] = [];
  let clock = 0;

  function visit(nodeId: NodeId): void {
    clock += 1;
    discovery.set(nodeId, clock);

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, nodeId);
        visit(neighborId);
      } else if (
        neighborId !== parent.get(nodeId) &&
        getRequired(discovery, neighborId) < getRequired(discovery, nodeId)
      ) {
        const path = [nodeId];
        let currentId: NodeId | undefined = nodeId;
        while (currentId !== neighborId) {
          currentId = parent.get(currentId);
          if (currentId === undefined) break;
          path.push(currentId);
        }
        if (path.at(-1) === neighborId && path.length >= 3) cycles.push(path);
      }
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!discovery.has(nodeId)) visit(nodeId);
  }
  return cycles;
}

export function graphEdges(adjacency: ReadonlyAdjacency): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [fromId, neighbors] of adjacency) {
    for (const toId of neighbors) {
      if (fromId < toId) edges.push([fromId, toId]);
    }
  }
  return edges;
}

export function pathInTree(
  adjacency: ReadonlyAdjacency,
  fromId: NodeId,
  toId: NodeId,
): CyclePath | null {
  const pending = [fromId];
  const previous = new Map<NodeId, NodeId | null>([[fromId, null]]);

  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId) break;
    if (nodeId === toId) break;
    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (previous.has(neighborId)) continue;
      previous.set(neighborId, nodeId);
      pending.push(neighborId);
    }
  }
  if (!previous.has(toId)) return null;

  const path = [toId];
  while (path[0] !== fromId) {
    const previousId = previous.get(path[0] ?? '');
    if (!previousId) return null;
    path.unshift(previousId);
  }
  return path;
}

export function deterministicEdgeScore(key: EdgeKey, seed: number): number {
  let hash = (2_166_136_261 ^ seed) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Produce complete cycle proposals from several deterministic spanning trees.
 * Perimeter-biased trees retain geographically extreme edges; seeded trees
 * explore other valid topologies without making the browser result random.
 */
export function spanningTreeCycles(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
): CyclePath[] {
  const nodeIds = [...adjacency.keys()];
  const edges = graphEdges(adjacency);
  const center = nodeIds.reduce(
    (total, nodeId) => {
      const [longitude, latitude] = getRequired(nodes, nodeId).coordinate;
      total.longitude += longitude / nodeIds.length;
      total.latitude += latitude / nodeIds.length;
      return total;
    },
    { longitude: 0, latitude: 0 },
  );
  const midpoint = ([fromId, toId]: GraphEdge): Coordinate => {
    const from = getRequired(nodes, fromId).coordinate;
    const to = getRequired(nodes, toId).coordinate;
    return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  };
  const radialScore = (edge: GraphEdge): number => {
    const [longitude, latitude] = midpoint(edge);
    return (longitude - center.longitude) ** 2 + (latitude - center.latitude) ** 2;
  };
  const strategies: ((edge: GraphEdge) => number)[] = [
    (edge) => radialScore(edge),
    (edge) => -radialScore(edge),
    (edge) => midpoint(edge)[0],
    (edge) => -midpoint(edge)[0],
    (edge) => midpoint(edge)[1],
    (edge) => -midpoint(edge)[1],
    ...Array.from(
      { length: SPANNING_TREE_RANDOM_SEEDS },
      (_, seed) => (edge: GraphEdge) =>
        deterministicEdgeScore(edgeKey(edge[0], edge[1]), seed + 1),
    ),
  ];
  const cycles = new Map<string, CyclePath>();

  for (const score of strategies) {
    const unions = new UnionFind(nodeIds);
    const tree: Adjacency = new Map(
      nodeIds.map((nodeId) => [nodeId, new Set<NodeId>()]),
    );
    const nonTreeEdges: GraphEdge[] = [];
    for (const [fromId, toId] of [...edges].sort(
      (first, second) => score(second) - score(first),
    )) {
      if (unions.union(fromId, toId)) {
        getRequired(tree, fromId).add(toId);
        getRequired(tree, toId).add(fromId);
      } else {
        nonTreeEdges.push([fromId, toId]);
      }
    }

    for (const [fromId, toId] of nonTreeEdges) {
      const path = pathInTree(tree, fromId, toId);
      if (!path || path.length < 3) continue;
      cycles.set(stableCandidateId(path), path);
    }
  }

  return [...cycles.values()];
}

interface HullPoint {
  readonly coordinate: Coordinate;
  readonly nodeId: NodeId;
}

export function convexHullNodeIds(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
): NodeId[] {
  const points = [...adjacency.keys()]
    .map((nodeId) => ({ nodeId, coordinate: getRequired(nodes, nodeId).coordinate }))
    .sort(
      (first, second) =>
        first.coordinate[0] - second.coordinate[0] ||
        first.coordinate[1] - second.coordinate[1],
    );
  if (points.length <= 3) return points.map((point) => point.nodeId);

  const cross = (origin: HullPoint, first: HullPoint, second: HullPoint): number =>
    (first.coordinate[0] - origin.coordinate[0]) *
      (second.coordinate[1] - origin.coordinate[1]) -
    (first.coordinate[1] - origin.coordinate[1]) *
      (second.coordinate[0] - origin.coordinate[0]);
  const lower: HullPoint[] = [];
  for (const point of points) {
    while (lower.length >= 2) {
      const first = lower.at(-2);
      const second = lower.at(-1);
      if (!first || !second || cross(first, second, point) > 0) break;
      lower.pop();
    }
    lower.push(point);
  }
  const upper: HullPoint[] = [];
  for (const point of [...points].reverse()) {
    while (upper.length >= 2) {
      const first = upper.at(-2);
      const second = upper.at(-1);
      if (!first || !second || cross(first, second, point) > 0) break;
      upper.pop();
    }
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((point) => point.nodeId);
}

export function addFlowArc(
  graph: FlowArc[][],
  from: number,
  to: number,
  capacity: number,
  cost: number,
  routeKey: string | null = null,
): void {
  const fromEdges = graph[from];
  const toEdges = graph[to];
  if (!fromEdges || !toEdges) return;
  const forward = {
    to,
    reverseIndex: toEdges.length,
    capacity,
    cost,
    routeKey,
  };
  const reverse = {
    to: from,
    reverseIndex: fromEdges.length,
    capacity: 0,
    cost: -cost,
    routeKey: null,
  };
  fromEdges.push(forward);
  toEdges.push(reverse);
}
