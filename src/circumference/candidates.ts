import type { Coordinate, Schedule, StationFeature } from '../domain.js';
import {
  CYCLE_SEARCH_BEAM_WIDTH,
  CYCLE_SEARCH_MAX_ROUNDS,
  EAR_EXPANSION_MAX_ROUNDS,
  EAR_EXPANSION_ROUND_SEED_LIMIT,
  EDGE_KEY_SEPARATOR,
  INFERRED_TRANSFER_DISTANCE_WITHOUT_PUBLISHED_M,
  OUTER_CYCLE_MERGE_SEED_LIMIT,
  biconnectedComponents,
  componentAdjacency,
  cycleEdgeKeys,
  distanceMeters,
  edgeKey,
  emptyStrings,
  fundamentalCycles,
  getRequired,
  hasSelfIntersection,
  joinSegmentCoordinates,
  lineLengthMeters,
  mergeCyclePaths,
  normalizeStationName,
  orientedEdgeCoordinates,
  polygonAreaSquareMeters,
  removeBranches,
  removeServiceShortcuts,
  routeIdForService,
  serviceFamily,
  spanningTreeCycles,
  stableCandidateId,
  trackGeometryByEdge,
} from './graph.js';
import {
  expandCyclesWithEars,
  extremeAnchorCycles,
  radialWaypointCycles,
  transferWaypointCycles,
  waypointExtremeCycles,
} from './cycles.js';
import type {
  Adjacency,
  BuildCircumferenceOptions,
  CircumferenceCandidate,
  CircumferenceGeometryVariants,
  CircumferenceModeResult,
  CircumferenceNetwork,
  CircumferenceNetworkSegment,
  CircumferenceNode,
  CircumferenceResult,
  CircumferenceSegment,
  CyclePath,
  EdgeKey,
  EdgeStringSets,
  MutableEdgeStringSets,
  NodeId,
  NodeMap,
  ReadonlyAdjacency,
  SelectCircumferenceOptions,
  TrackGeometryMap,
  TransferEdge,
} from './types.js';

// The current MTA static GTFS omits this in-complex connection even though the
// 1 and R/W platforms are connected inside the Whitehall St–South Ferry paid
// area. Keep the platform nodes distinct and supply only the missing walk.
const PUBLISHED_TRANSFER_SUPPLEMENTS = [
  {
    fromId: 'gtfs/mta-subway/142',
    minutes: 3,
    toId: 'gtfs/mta-subway/R27',
  },
];

function traceFaces(adjacency: ReadonlyAdjacency, nodes: NodeMap): CyclePath[] {
  const sortedNeighbors = new Map<NodeId, NodeId[]>();
  for (const [nodeId, neighbors] of adjacency) {
    const [originLongitude, originLatitude] = getRequired(nodes, nodeId).coordinate;
    sortedNeighbors.set(
      nodeId,
      [...neighbors].sort((firstId, secondId) => {
        const first = getRequired(nodes, firstId).coordinate;
        const second = getRequired(nodes, secondId).coordinate;
        return (
          Math.atan2(first[1] - originLatitude, first[0] - originLongitude) -
          Math.atan2(second[1] - originLatitude, second[0] - originLongitude)
        );
      }),
    );
  }

  const visitedDirections = new Set<string>();
  const faces: CyclePath[] = [];

  for (const [startId, neighbors] of sortedNeighbors) {
    for (const nextId of neighbors) {
      const startingDirection = `${startId}${EDGE_KEY_SEPARATOR}${nextId}`;
      if (visitedDirections.has(startingDirection)) continue;

      const path: CyclePath = [];
      let previousId = startId;
      let currentId = nextId;
      let guard = 0;

      while (guard < adjacency.size * 4) {
        guard += 1;
        const direction = `${previousId}${EDGE_KEY_SEPARATOR}${currentId}`;
        if (visitedDirections.has(direction)) break;
        visitedDirections.add(direction);
        path.push(previousId);

        const currentNeighbors = sortedNeighbors.get(currentId);
        if (!currentNeighbors) break;
        const incomingIndex = currentNeighbors.indexOf(previousId);
        if (incomingIndex === -1) break;
        const followingId =
          currentNeighbors[
            (incomingIndex - 1 + currentNeighbors.length) % currentNeighbors.length
          ];
        if (!followingId) break;
        previousId = currentId;
        currentId = followingId;

        if (previousId === startId && currentId === nextId) break;
      }

      const closed = previousId === startId && currentId === nextId;
      const isSimple = new Set(path).size === path.length;
      if (!closed || !isSimple || path.length < 3) continue;

      const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
      if (hasSelfIntersection(coordinates)) continue;
      faces.push(path);
    }
  }

  return faces;
}

/**
 * A maximum-area route can surround many smaller network faces. Generate those
 * larger boundaries by taking the symmetric difference of adjacent cycles:
 * shared internal edges disappear and the remaining degree-two boundary is a
 * single rideable loop. A bounded beam keeps this fast enough for the browser.
 */
interface CycleState {
  readonly areaSquareMeters: number;
  readonly edges: Set<EdgeKey>;
  readonly id: string;
  readonly path: CyclePath;
}

function combineCycles(seedPaths: readonly CyclePath[], nodes: NodeMap): CyclePath[] {
  const candidates = new Map<string, CycleState>();
  const seeds: CycleState[] = [];

  function stateForPath(path: CyclePath): CycleState | null {
    if (new Set(path).size !== path.length) return null;
    const id = stableCandidateId(path);
    const existing = candidates.get(id);
    if (existing) return existing;
    const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
    if (hasSelfIntersection(coordinates)) return null;
    const state = {
      id,
      path,
      edges: cycleEdgeKeys(path),
      areaSquareMeters: polygonAreaSquareMeters(coordinates),
    };
    candidates.set(id, state);
    return state;
  }

  for (const path of seedPaths) {
    const state = stateForPath(path);
    if (state && !seeds.some((seed) => seed.id === state.id)) seeds.push(state);
  }

  let frontier = [...seeds];
  for (
    let round = 0;
    round < CYCLE_SEARCH_MAX_ROUNDS && frontier.length > 0;
    round += 1
  ) {
    const next = new Map<string, CycleState>();
    for (const state of frontier) {
      for (const seed of seeds) {
        let sharesEdge = false;
        for (const key of seed.edges) {
          if (state.edges.has(key)) {
            sharesEdge = true;
            break;
          }
        }
        if (!sharesEdge) continue;

        const mergedPath = mergeCyclePaths(state.path, seed.path);
        if (!mergedPath) continue;

        const mergedId = stableCandidateId(mergedPath);
        if (candidates.has(mergedId)) continue;
        const mergedState = stateForPath(mergedPath);
        if (mergedState) next.set(mergedState.id, mergedState);
      }
    }
    frontier = [...next.values()]
      .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters)
      .slice(0, CYCLE_SEARCH_BEAM_WIDTH);
  }

  return [...candidates.values()].map((candidate) => candidate.path);
}

function candidateSimilarity(
  first: CircumferenceCandidate,
  second: CircumferenceCandidate,
): number {
  const firstEdges = cycleEdgeKeys(first.nodeIds);
  const secondEdges = cycleEdgeKeys(second.nodeIds);
  let intersectionSize = 0;
  for (const key of firstEdges) {
    if (secondEdges.has(key)) intersectionSize += 1;
  }
  return intersectionSize / (firstEdges.size + secondEdges.size - intersectionSize);
}

function selectDiverseCandidates(
  rankedCandidates: readonly CircumferenceCandidate[],
  maximumCount: number,
): CircumferenceCandidate[] {
  if (rankedCandidates.length <= maximumCount) return [...rankedCandidates];
  const selected: CircumferenceCandidate[] = [];
  const selectedIds = new Set<string>();

  // Start with genuinely different circumferences, then relax the threshold so
  // the override menu remains full even in a network with only a few loop shapes.
  for (const maximumSimilarity of [0.72, 0.84, 0.93, 1]) {
    for (const candidate of rankedCandidates) {
      if (selectedIds.has(candidate.id)) continue;
      if (
        selected.every(
          (selectedCandidate) =>
            candidateSimilarity(candidate, selectedCandidate) <= maximumSimilarity,
        )
      ) {
        selected.push(candidate);
        selectedIds.add(candidate.id);
        if (selected.length === maximumCount) return selected;
      }
    }
  }

  return selected;
}

export function sortLineNames(first: string, second: string): number {
  return String(first).localeCompare(String(second), 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

export function serviceStopPriority(lineName: string, description?: string): number {
  const serviceDescription = String(description ?? '');
  const isLocal = /\blocal\b/i.test(serviceDescription);
  const isExpress =
    /\bexpress\b/i.test(serviceDescription) ||
    /^(?:N|.*X)$/i.test(String(lineName).trim());
  if (isLocal && !isExpress) return 0;
  if (isExpress && !isLocal) return 2;
  return 1;
}

interface PrimaryLineChoice {
  readonly coveragePenalty: number;
  readonly lines: readonly string[];
  readonly servicePenalty: number;
  readonly signature: string;
  readonly switches: number;
}

function comparePrimaryLineChoices(
  first: PrimaryLineChoice,
  second: PrimaryLineChoice,
): number {
  return (
    first.servicePenalty - second.servicePenalty ||
    first.switches - second.switches ||
    first.coveragePenalty - second.coveragePenalty ||
    first.signature.localeCompare(second.signature, 'en', {
      numeric: true,
      sensitivity: 'base',
    })
  );
}

function selectRideRunPrimaryLines(
  runIndices: readonly number[],
  segments: readonly CircumferenceSegment[],
  servicePriorityByLine: ReadonlyMap<string, number>,
  closed: boolean,
): readonly string[] {
  const firstSegment = segments[runIndices[0] ?? -1];
  if (!firstSegment || firstSegment.lines.length === 0) return [];
  const coverageByLine = new Map<string, number>();
  for (const segmentIndex of runIndices) {
    for (const lineName of segments[segmentIndex]?.lines ?? []) {
      coverageByLine.set(lineName, (coverageByLine.get(lineName) ?? 0) + 1);
    }
  }

  const servicePenalty = (lineName: string): number =>
    servicePriorityByLine.get(lineName) ?? serviceStopPriority(lineName);
  const coveragePenalty = (lineName: string): number =>
    runIndices.length - (coverageByLine.get(lineName) ?? 0);
  const solve = (requiredFirstLine: string | null): PrimaryLineChoice | null => {
    let states = new Map<string, PrimaryLineChoice>();
    for (const lineName of firstSegment.lines) {
      if (requiredFirstLine !== null && lineName !== requiredFirstLine) continue;
      states.set(lineName, {
        servicePenalty: servicePenalty(lineName),
        switches: 0,
        coveragePenalty: coveragePenalty(lineName),
        lines: [lineName],
        signature: lineName,
      });
    }

    for (const segmentIndex of runIndices.slice(1)) {
      const segment = segments[segmentIndex];
      if (!segment) continue;
      const nextStates = new Map<string, PrimaryLineChoice>();
      for (const lineName of segment.lines) {
        for (const [previousLine, state] of states) {
          const choice: PrimaryLineChoice = {
            servicePenalty: state.servicePenalty + servicePenalty(lineName),
            switches: state.switches + (previousLine === lineName ? 0 : 1),
            coveragePenalty: state.coveragePenalty + coveragePenalty(lineName),
            lines: [...state.lines, lineName],
            signature: `${state.signature}\u0000${lineName}`,
          };
          const existing = nextStates.get(lineName);
          if (!existing || comparePrimaryLineChoices(choice, existing) < 0) {
            nextStates.set(lineName, choice);
          }
        }
      }
      states = nextStates;
    }

    const completed = [...states].map(([lastLine, state]) =>
      closed && requiredFirstLine !== null && lastLine !== requiredFirstLine
        ? { ...state, switches: state.switches + 1 }
        : state,
    );
    return completed.sort(comparePrimaryLineChoices)[0] ?? null;
  };

  if (!closed) return solve(null)?.lines ?? [];
  return (
    firstSegment.lines
      .map((lineName) => solve(lineName))
      .filter((choice): choice is PrimaryLineChoice => choice !== null)
      .sort(comparePrimaryLineChoices)[0]?.lines ?? []
  );
}

export function assignPrimaryLines(
  segments: readonly CircumferenceSegment[],
  servicePriorityByLine: ReadonlyMap<string, number>,
): CircumferenceSegment[] {
  const primaryLines: (string | null)[] = segments.map(() => null);
  const separatorIndex = segments.findIndex(
    (segment) => segment.type !== 'ride' || segment.lines.length === 0,
  );
  const assignRun = (runIndices: readonly number[], closed: boolean): void => {
    const selectedLines = selectRideRunPrimaryLines(
      runIndices,
      segments,
      servicePriorityByLine,
      closed,
    );
    for (const [runIndex, segmentIndex] of runIndices.entries()) {
      primaryLines[segmentIndex] = selectedLines[runIndex] ?? null;
    }
  };

  if (separatorIndex === -1) {
    assignRun(
      segments.map((_, index) => index),
      true,
    );
  } else {
    let runIndices: number[] = [];
    for (let offset = 1; offset <= segments.length; offset += 1) {
      const segmentIndex = (separatorIndex + offset) % segments.length;
      const segment = segments[segmentIndex];
      if (segment?.type === 'ride' && segment.lines.length > 0) {
        runIndices.push(segmentIndex);
      } else if (runIndices.length > 0) {
        assignRun(runIndices, false);
        runIndices = [];
      }
    }
  }

  return segments.map((segment, index) => ({
    ...segment,
    primaryLine: primaryLines[index] ?? null,
  }));
}

function simplifyTransferPath(
  path: readonly NodeId[],
  transfersByEdge: ReadonlyMap<EdgeKey, TransferEdge>,
  nodes: NodeMap,
): CyclePath {
  const simplified = [...path];
  let changed = true;

  while (changed && simplified.length > 3) {
    changed = false;
    for (let index = 0; index < simplified.length; index += 1) {
      const previousId =
        simplified[(index - 1 + simplified.length) % simplified.length];
      const currentId = simplified[index];
      const nextId = simplified[(index + 1) % simplified.length];
      if (!previousId || !currentId || !nextId) continue;
      const stationName = normalizeStationName(getRequired(nodes, currentId).name);
      if (
        stationName &&
        normalizeStationName(getRequired(nodes, previousId).name) === stationName &&
        normalizeStationName(getRequired(nodes, nextId).name) === stationName &&
        transfersByEdge.has(edgeKey(previousId, currentId)) &&
        transfersByEdge.has(edgeKey(currentId, nextId)) &&
        transfersByEdge.has(edgeKey(previousId, nextId))
      ) {
        simplified.splice(index, 1);
        changed = true;
        break;
      }
    }
  }

  return simplified;
}

interface GeometryVariant {
  readonly candidates: CircumferenceCandidate[];
  readonly generatedCandidateCount: number;
  readonly network: CircumferenceNetwork;
}

function buildGeometryVariant({
  candidatePaths,
  geometriesByEdge,
  linesByEdge,
  maxCandidates,
  minimumAreaSquareMeters,
  nodes,
  normalizedLinesByEdge,
  servicePriorityByLine,
  displayOnlyShortcuts,
  hiddenNetworkShortcuts,
  trackGeometryEnabled,
  transfersByEdge,
}: {
  readonly candidatePaths: readonly CyclePath[];
  readonly geometriesByEdge: TrackGeometryMap;
  readonly linesByEdge: EdgeStringSets;
  readonly maxCandidates: number;
  readonly minimumAreaSquareMeters: number;
  readonly nodes: NodeMap;
  readonly normalizedLinesByEdge: EdgeStringSets;
  readonly servicePriorityByLine: ReadonlyMap<string, number>;
  readonly displayOnlyShortcuts: ReadonlySet<EdgeKey>;
  readonly hiddenNetworkShortcuts: ReadonlySet<EdgeKey>;
  readonly trackGeometryEnabled: boolean;
  readonly transfersByEdge: ReadonlyMap<EdgeKey, TransferEdge>;
}): GeometryVariant {
  const simplifiedCandidatePaths = new Map<string, CyclePath>();
  for (const candidatePath of candidatePaths) {
    const path = simplifyTransferPath(candidatePath, transfersByEdge, nodes);
    simplifiedCandidatePaths.set(stableCandidateId(path), path);
  }
  const rankedCandidates: CircumferenceCandidate[] = [
    ...simplifiedCandidatePaths.values(),
  ]
    .map((path) => {
      const segments = assignPrimaryLines(
        path.flatMap((nodeId, index) => {
          const nextId = path[(index + 1) % path.length];
          if (!nextId) return [];
          const key = edgeKey(nodeId, nextId);
          const transfer = transfersByEdge.get(key);
          const from = getRequired(nodes, nodeId);
          const to = getRequired(nodes, nextId);
          const coordinates: Coordinate[] = transfer
            ? [
                [from.coordinate[0], from.coordinate[1]],
                [to.coordinate[0], to.coordinate[1]],
              ]
            : orientedEdgeCoordinates(
                nodeId,
                nextId,
                nodes,
                geometriesByEdge,
                trackGeometryEnabled,
              );
          return [
            {
              id: stableCandidateId([nodeId, nextId]).replace('route-', 'segment-'),
              from,
              to,
              type: transfer ? 'transfer' : 'ride',
              lines: [...(linesByEdge.get(key) ?? [])].sort(sortLineNames),
              primaryLine: null,
              coordinates,
              distanceMeters: lineLengthMeters(coordinates),
              transferSource: transfer?.source ?? null,
              transferMinutes: transfer?.minutes ?? null,
            } satisfies CircumferenceSegment,
          ];
        }),
        servicePriorityByLine,
      );
      const coordinates = joinSegmentCoordinates(segments);
      const lines = [
        ...new Set(
          segments.flatMap((segment) =>
            segment.primaryLine === null ? [] : [segment.primaryLine],
          ),
        ),
      ].sort(sortLineNames);
      const walkingLengthMeters = segments
        .filter((segment) => segment.type === 'transfer')
        .reduce((total, segment) => total + segment.distanceMeters, 0);

      return {
        id: stableCandidateId(path),
        nodeIds: path,
        stations: path.map((nodeId) => getRequired(nodes, nodeId)),
        coordinates,
        segments,
        lines,
        transferCount: segments.filter((segment) => segment.type === 'transfer').length,
        walkingLengthMeters,
        rideLengthMeters: segments
          .filter((segment) => segment.type === 'ride')
          .reduce((total, segment) => total + segment.distanceMeters, 0),
        areaSquareMeters: polygonAreaSquareMeters(coordinates),
        lengthMeters: segments.reduce(
          (total, segment) => total + segment.distanceMeters,
          0,
        ),
      } satisfies CircumferenceCandidate;
    })
    // Candidate topology is already constrained to a simple station-node cycle.
    // Do not reject a physical alignment merely because grade-separated tracks
    // cross in plan view or a short interchange walk crosses another segment.
    .filter((candidate) => candidate.coordinates.length >= 4)
    .filter((candidate) => candidate.areaSquareMeters >= minimumAreaSquareMeters)
    .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters);
  const networkRideSegments: CircumferenceNetworkSegment[] = [...normalizedLinesByEdge]
    .filter(
      ([key]) => !hiddenNetworkShortcuts.has(key) || displayOnlyShortcuts.has(key),
    )
    .map(([key, lineNames]) => {
      const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
      if (!fromId || !toId) throw new Error(`Invalid edge key: ${key}`);
      return {
        id: stableCandidateId([fromId, toId]).replace('route-', 'network-'),
        from: getRequired(nodes, fromId),
        to: getRequired(nodes, toId),
        type: 'ride',
        display: !displayOnlyShortcuts.has(key),
        lines: [...lineNames].sort(sortLineNames),
        coordinates: orientedEdgeCoordinates(
          fromId,
          toId,
          nodes,
          geometriesByEdge,
          trackGeometryEnabled,
        ),
      };
    });
  const networkTransferSegments: CircumferenceNetworkSegment[] = [
    ...transfersByEdge,
  ].map(([key, transfer]) => {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    if (!fromId || !toId) throw new Error(`Invalid transfer edge key: ${key}`);
    const from = getRequired(nodes, fromId);
    const to = getRequired(nodes, toId);
    return {
      id: stableCandidateId([fromId, toId]).replace('route-', 'network-transfer-'),
      from,
      to,
      type: 'transfer',
      lines: [],
      coordinates: [
        [from.coordinate[0], from.coordinate[1]],
        [to.coordinate[0], to.coordinate[1]],
      ],
      distanceMeters: transfer.distanceMeters,
      transferSource: transfer.source,
      transferMinutes: transfer.minutes,
    };
  });

  return {
    candidates: selectDiverseCandidates(rankedCandidates, maxCandidates),
    network: {
      stations: [...nodes.values()].filter((node) => node.lineNames.length > 0),
      segments: [...networkRideSegments, ...networkTransferSegments],
    },
    generatedCandidateCount: rankedCandidates.length,
  };
}

/**
 * Builds closed metro loops from route edges and zero-fare interchanges.
 * Express stop-to-stop shortcuts are normalized onto local station chains,
 * then adjacent cycle boundaries are combined and ranked by contained area.
 * Returning several geographically distinct candidates provides a stable
 * manual override without changing the source feed.
 */
export function buildCircumferenceCandidates(
  stationFeatures: readonly StationFeature[],
  schedules: Schedule,
  {
    maxCandidates = 12,
    minimumAreaSquareMeters = 250_000,
    useTrackGeometry = true,
  }: BuildCircumferenceOptions = {},
): CircumferenceResult {
  const eligibleStations = stationFeatures.filter(
    (feature) =>
      feature.properties.mode === 'subway' && feature.properties.status === 'open',
  );
  const stationById = new Map(
    eligibleStations.map((feature) => [feature.properties.id, feature]),
  );
  const nodes = new Map<NodeId, CircumferenceNode>(
    eligibleStations.map((feature) => [
      feature.properties.id,
      {
        id: feature.properties.id,
        coordinate: feature.geometry.coordinates,
        name: feature.properties.name || 'Unnamed platform',
        stationIds: [feature.properties.id],
        lineNames: emptyStrings(),
      },
    ]),
  );
  const adjacency: Adjacency = new Map(
    [...nodes.keys()].map((nodeId) => [nodeId, new Set<NodeId>()]),
  );
  const linesByEdge: MutableEdgeStringSets = new Map();
  const familiesByEdge: MutableEdgeStringSets = new Map();
  const linesByNode = new Map<NodeId, Set<string>>(
    [...nodes.keys()].map((nodeId) => [nodeId, new Set<string>()]),
  );
  const transfersByEdge = new Map<EdgeKey, TransferEdge>();
  const geometriesByEdge = trackGeometryByEdge(schedules);
  const routeIdsByLineName = new Map<string, Set<string>>();
  const servicePriorityByLine = new Map<string, number>();
  for (const [routeId, route] of Object.entries(schedules.routes)) {
    if (route.mode !== 'subway') continue;
    const lineName = route.name || routeId;
    const routeIds = routeIdsByLineName.get(lineName) ?? new Set();
    routeIds.add(routeId);
    routeIdsByLineName.set(lineName, routeIds);
    const priority = serviceStopPriority(lineName, route.description);
    servicePriorityByLine.set(
      lineName,
      Math.min(servicePriorityByLine.get(lineName) ?? priority, priority),
    );
  }
  const ambiguousLineNames = new Set(
    [...routeIdsByLineName]
      .filter(([, routeIds]) => routeIds.size > 1)
      .map(([lineName]) => lineName),
  );

  for (const [fromStationId, edges] of Object.entries(schedules.graph.e)) {
    if (!stationById.has(fromStationId)) continue;

    for (const [toStationId, , serviceKey] of edges) {
      if (!stationById.has(toStationId)) continue;
      const routeId = routeIdForService(serviceKey);
      const route = schedules.routes[routeId];
      if (route?.mode !== 'subway') continue;

      if (fromStationId === toStationId) continue;

      getRequired(adjacency, fromStationId).add(toStationId);
      getRequired(adjacency, toStationId).add(fromStationId);
      const key = edgeKey(fromStationId, toStationId);
      const lineName = route.name || routeId;
      const lines = linesByEdge.get(key) ?? new Set();
      lines.add(lineName);
      linesByEdge.set(key, lines);
      const families = familiesByEdge.get(key) ?? new Set();
      families.add(serviceFamily(routeId, lineName));
      familiesByEdge.set(key, families);
      getRequired(linesByNode, fromStationId).add(lineName);
      getRequired(linesByNode, toStationId).add(lineName);
    }
  }

  let publishedTransferCount = 0;
  let inferredTransferCount = 0;
  const addTransfer = (
    fromStationId: NodeId,
    toStationId: NodeId,
    {
      source,
      minutes = null,
    }: {
      readonly minutes?: number | null;
      readonly source: TransferEdge['source'];
    },
  ): boolean => {
    if (
      fromStationId === toStationId ||
      !nodes.has(fromStationId) ||
      !nodes.has(toStationId)
    ) {
      return false;
    }
    const key = edgeKey(fromStationId, toStationId);
    if (linesByEdge.has(key)) return false;
    const existing = transfersByEdge.get(key);
    if (existing) {
      if (
        minutes !== null &&
        Number.isFinite(minutes) &&
        (existing.minutes === null ||
          !Number.isFinite(existing.minutes) ||
          minutes < existing.minutes)
      ) {
        existing.minutes = minutes;
      }
      if (source === 'published') existing.source = source;
      return false;
    }

    const walkingDistanceMeters = distanceMeters(
      getRequired(nodes, fromStationId).coordinate,
      getRequired(nodes, toStationId).coordinate,
    );
    transfersByEdge.set(key, {
      source,
      minutes: minutes !== null && Number.isFinite(minutes) ? minutes : null,
      distanceMeters: walkingDistanceMeters,
    });
    getRequired(adjacency, fromStationId).add(toStationId);
    getRequired(adjacency, toStationId).add(fromStationId);
    return true;
  };

  for (const [fromStationId, transfers] of Object.entries(schedules.graph.t)) {
    for (const [toStationId, minutes] of transfers) {
      if (
        addTransfer(fromStationId, toStationId, {
          source: 'published',
          minutes,
        })
      ) {
        publishedTransferCount += 1;
      }
    }
  }
  for (const supplement of PUBLISHED_TRANSFER_SUPPLEMENTS) {
    if (
      addTransfer(supplement.fromId, supplement.toId, {
        source: 'published',
        minutes: supplement.minutes,
      })
    ) {
      publishedTransferCount += 1;
    }
  }
  // Name matching is only a fallback for feeds that publish no transfer table
  // at all (currently CDMX). When a feed publishes transfers, that table is
  // authoritative: same-name stations can be separate, fare-controlled
  // complexes such as NYC's two 155 St stations.
  if (publishedTransferCount === 0) {
    const stationsByName = new Map<string, StationFeature[]>();
    for (const feature of eligibleStations) {
      const normalizedName = normalizeStationName(feature.properties.name);
      if (!normalizedName) continue;
      const bucket = stationsByName.get(normalizedName) ?? [];
      bucket.push(feature);
      stationsByName.set(normalizedName, bucket);
    }

    for (const bucket of stationsByName.values()) {
      for (let firstIndex = 0; firstIndex < bucket.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < bucket.length;
          secondIndex += 1
        ) {
          const first = bucket[firstIndex];
          const second = bucket[secondIndex];
          if (!first || !second) continue;
          const firstId = first.properties.id;
          const secondId = second.properties.id;
          const firstLines = getRequired(linesByNode, firstId);
          const secondLines = getRequired(linesByNode, secondId);
          if (firstLines.size === 0 || secondLines.size === 0) continue;
          const sameLineSet =
            firstLines.size === secondLines.size &&
            [...firstLines].every((lineName) => secondLines.has(lineName));
          if (
            sameLineSet ||
            distanceMeters(first.geometry.coordinates, second.geometry.coordinates) >
              INFERRED_TRANSFER_DISTANCE_WITHOUT_PUBLISHED_M
          ) {
            continue;
          }
          if (
            addTransfer(firstId, secondId, {
              source: 'inferred',
            })
          ) {
            inferredTransferCount += 1;
          }
        }
      }
    }
  }

  for (const [nodeId, node] of nodes) {
    node.lineNames = [...getRequired(linesByNode, nodeId)].sort(sortLineNames);
    node.label = node.lineNames.length
      ? `${node.name} · ${node.lineNames.join('/')}`
      : node.name;
  }

  const normalizedLinesByEdge: MutableEdgeStringSets = new Map(
    [...linesByEdge].map(([key, lineNames]) => [key, new Set(lineNames)]),
  );
  const candidatePaths = new Map<string, CyclePath>();
  const removedShortcuts = new Set<EdgeKey>();
  const hiddenNetworkShortcuts = new Set<EdgeKey>();
  const displayOnlyShortcuts = new Set<EdgeKey>();
  const biconnectedComponentSizes: number[] = [];
  let biconnectedComponentCount = 0;
  let corePlatformNodeCount = 0;
  for (const searchAdjacency of [adjacency]) {
    for (const key of removeServiceShortcuts(
      searchAdjacency,
      nodes,
      linesByEdge,
      familiesByEdge,
      ambiguousLineNames,
      normalizedLinesByEdge,
      hiddenNetworkShortcuts,
      displayOnlyShortcuts,
      geometriesByEdge,
    )) {
      removedShortcuts.add(key);
    }
    removeBranches(searchAdjacency);
    corePlatformNodeCount = Math.max(corePlatformNodeCount, searchAdjacency.size);
    const components = biconnectedComponents(searchAdjacency);
    biconnectedComponentCount += components.length;
    biconnectedComponentSizes.push(
      ...components.map((component) => new Set(component.flat()).size),
    );

    for (const component of components) {
      const componentGraph = componentAdjacency(component);
      const componentCandidates = new Map<string, CyclePath>();
      const addComponentCandidate = (path: CyclePath): void => {
        const id = stableCandidateId(path);
        componentCandidates.set(id, path);
        candidatePaths.set(id, path);
      };
      const seeds = [
        ...traceFaces(componentGraph, nodes),
        ...fundamentalCycles(componentGraph),
      ];
      for (const path of combineCycles(seeds, nodes)) {
        addComponentCandidate(path);
      }
      const spanningProposals = spanningTreeCycles(componentGraph, nodes);
      for (const path of spanningProposals) {
        const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
        if (new Set(path).size === path.length && !hasSelfIntersection(coordinates)) {
          addComponentCandidate(path);
        }
      }
      const extremeProposals = extremeAnchorCycles(componentGraph, nodes);
      for (const path of extremeProposals) {
        const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
        if (!hasSelfIntersection(coordinates)) {
          addComponentCandidate(path);
        }
      }
      for (const path of waypointExtremeCycles(componentGraph, nodes)) {
        const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
        if (!hasSelfIntersection(coordinates)) addComponentCandidate(path);
      }
      for (const path of radialWaypointCycles(componentGraph, nodes)) {
        const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
        if (!hasSelfIntersection(coordinates)) addComponentCandidate(path);
      }
      for (const path of transferWaypointCycles(
        componentGraph,
        nodes,
        transfersByEdge.keys(),
      )) {
        const coordinates = path.map((nodeId) => getRequired(nodes, nodeId).coordinate);
        if (!hasSelfIntersection(coordinates)) addComponentCandidate(path);
      }

      const outerMergeSeeds = [...componentCandidates.values()]
        .map((path) => ({
          path,
          areaSquareMeters: polygonAreaSquareMeters(
            path.map((nodeId) => getRequired(nodes, nodeId).coordinate),
          ),
        }))
        .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters)
        .slice(0, OUTER_CYCLE_MERGE_SEED_LIMIT)
        .map((candidate) => candidate.path);
      for (const path of combineCycles(outerMergeSeeds, nodes)) {
        addComponentCandidate(path);
      }
    }
  }

  let earExpansionSeeds = [...candidatePaths.values()]
    .map((path) => ({
      path,
      areaSquareMeters: polygonAreaSquareMeters(
        path.map((nodeId) => getRequired(nodes, nodeId).coordinate),
      ),
    }))
    .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters)
    .map((candidate) => candidate.path);
  // A perimeter can need several independent outward substitutions (for
  // example the Bronx extension first, then the West End/D branch in Brooklyn).
  // Feed only newly discovered ears into the next round so combinations are
  // found without repeatedly expanding the entire candidate population.
  for (
    let round = 0;
    round < EAR_EXPANSION_MAX_ROUNDS && earExpansionSeeds.length > 0;
    round += 1
  ) {
    const newEarPaths: CyclePath[] = [];
    for (const path of expandCyclesWithEars(
      earExpansionSeeds,
      adjacency,
      nodes,
      transfersByEdge.keys(),
    )) {
      const id = stableCandidateId(path);
      if (candidatePaths.has(id)) continue;
      candidatePaths.set(id, path);
      newEarPaths.push(path);
    }
    earExpansionSeeds = newEarPaths
      .map((path) => ({
        path,
        areaSquareMeters: polygonAreaSquareMeters(
          path.map((nodeId) => getRequired(nodes, nodeId).coordinate),
        ),
      }))
      .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters)
      .slice(0, EAR_EXPANSION_ROUND_SEED_LIMIT)
      .map((candidate) => candidate.path);
  }

  const removedShortcutsDetails = [...removedShortcuts].map((key) => {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    if (!fromId || !toId) {
      throw new Error(`Invalid edge key: ${key}`);
    }
    return {
      from: getRequired(nodes, fromId).name,
      to: getRequired(nodes, toId).name,
      lines: [...(linesByEdge.get(key) ?? [])].sort(sortLineNames),
    };
  });
  const makeModeResult = (trackGeometryEnabled: boolean): CircumferenceModeResult => {
    const variant = buildGeometryVariant({
      candidatePaths: [...candidatePaths.values()],
      geometriesByEdge,
      linesByEdge,
      maxCandidates,
      minimumAreaSquareMeters,
      nodes,
      normalizedLinesByEdge,
      servicePriorityByLine,
      displayOnlyShortcuts,
      hiddenNetworkShortcuts,
      trackGeometryEnabled,
      transfersByEdge,
    });
    return {
      candidates: variant.candidates,
      network: variant.network,
      methodology: {
        eligibleStationCount: eligibleStations.length,
        platformNodeCount: nodes.size,
        corePlatformNodeCount,
        publishedTransferCount,
        inferredTransferCount,
        removedShortcutCount: removedShortcuts.size,
        removedShortcuts: removedShortcutsDetails,
        biconnectedComponentCount,
        biconnectedComponentSizes: [...biconnectedComponentSizes].sort(
          (first, second) => second - first,
        ),
        generatedCandidateCount: variant.generatedCandidateCount,
        displayOnlyShortcutCount: displayOnlyShortcuts.size,
        trackGeometryAvailable: geometriesByEdge.size > 0,
        trackGeometryEdgeCount: geometriesByEdge.size,
        trackGeometryEnabled: trackGeometryEnabled && geometriesByEdge.size > 0,
        trackGeometryMethod: schedules.track_geometry?.method ?? null,
      },
    };
  };
  const geometryVariants: CircumferenceGeometryVariants = {
    track: makeModeResult(true),
    straight: makeModeResult(false),
  };
  const selectedVariant = useTrackGeometry
    ? geometryVariants.track
    : geometryVariants.straight;
  return {
    ...selectedVariant,
    geometryVariants,
  };
}

export function selectCircumferenceCandidate(
  candidates: readonly CircumferenceCandidate[],
  overrideId: string = '',
  { requiredSegmentIds = [], avoidedSegmentIds = [] }: SelectCircumferenceOptions = {},
): CircumferenceCandidate | null {
  const requiredSegments = new Set(requiredSegmentIds);
  const avoidedSegments = new Set(avoidedSegmentIds);
  const matchingCandidates = candidates.filter((candidate) => {
    const candidateSegments = new Set(candidate.segments.map((segment) => segment.id));
    return (
      [...requiredSegments].every((segmentId) => candidateSegments.has(segmentId)) &&
      [...avoidedSegments].every((segmentId) => !candidateSegments.has(segmentId))
    );
  });

  return (
    candidates.find((candidate) => candidate.id === overrideId) ??
    matchingCandidates[0] ??
    null
  );
}
