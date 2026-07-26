import type { Coordinate } from '../domain.js';
import {
  EAR_EXPANSION_PAIR_LIMIT,
  EAR_EXPANSION_SEED_LIMIT,
  EDGE_KEY_SEPARATOR,
  EXTREME_ANCHOR_PAIR_LIMIT,
  addFlowArc,
  convexHullNodeIds,
  distanceMeters,
  edgeKey,
  getRequired,
  graphEdges,
  hasSelfIntersection,
  pathFromCycleEdges,
  stableCandidateId,
  toRadians,
} from './graph.js';
import type {
  Adjacency,
  CyclePath,
  EdgeCost,
  EdgeKey,
  FlowArc,
  GraphEdge,
  NodeId,
  NodeMap,
  ReadonlyAdjacency,
} from './types.js';

export function vertexDisjointCycle(
  adjacency: ReadonlyAdjacency,
  fromId: NodeId,
  toId: NodeId,
  edgeCost: EdgeCost,
): CyclePath | null {
  const nodeIds = [...adjacency.keys()];
  const indexById = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const graph: FlowArc[][] = Array.from({ length: nodeIds.length * 2 }, () => []);
  const inputIndex = (nodeId: NodeId): number => getRequired(indexById, nodeId) * 2;
  const outputIndex = (nodeId: NodeId): number =>
    getRequired(indexById, nodeId) * 2 + 1;

  for (const nodeId of nodeIds) {
    addFlowArc(
      graph,
      inputIndex(nodeId),
      outputIndex(nodeId),
      nodeId === fromId || nodeId === toId ? 2 : 1,
      0,
    );
  }
  for (const [firstId, secondId] of graphEdges(adjacency)) {
    const key = edgeKey(firstId, secondId);
    const cost = edgeCost(firstId, secondId);
    addFlowArc(graph, outputIndex(firstId), inputIndex(secondId), 1, cost, key);
    addFlowArc(graph, outputIndex(secondId), inputIndex(firstId), 1, cost, key);
  }

  const source = outputIndex(fromId);
  const sink = inputIndex(toId);
  for (let flow = 0; flow < 2; flow += 1) {
    const distances = Array.from<number>({ length: graph.length }).fill(Infinity);
    const previousNode = Array.from<number>({ length: graph.length }).fill(-1);
    const previousEdge = Array.from<number>({ length: graph.length }).fill(-1);
    distances[source] = 0;

    for (let iteration = 0; iteration < graph.length - 1; iteration += 1) {
      let changed = false;
      for (let nodeIndex = 0; nodeIndex < graph.length; nodeIndex += 1) {
        if (!Number.isFinite(distances[nodeIndex])) continue;
        const edges = graph[nodeIndex] ?? [];
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
          const edge = edges[edgeIndex];
          if (!edge) continue;
          if (edge.capacity <= 0) continue;
          const nextDistance =
            (distances[nodeIndex] ?? Number.POSITIVE_INFINITY) + edge.cost;
          if (nextDistance >= (distances[edge.to] ?? Number.POSITIVE_INFINITY) - 1e-9) {
            continue;
          }
          distances[edge.to] = nextDistance;
          previousNode[edge.to] = nodeIndex;
          previousEdge[edge.to] = edgeIndex;
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (!Number.isFinite(distances[sink])) return null;

    let current = sink;
    while (current !== source) {
      const prior = previousNode[current] ?? -1;
      if (prior < 0) return null;
      const edgeIndex = previousEdge[current] ?? -1;
      const edge = graph[prior]?.[edgeIndex];
      if (!edge) return null;
      edge.capacity -= 1;
      const reverseEdge = graph[current]?.[edge.reverseIndex];
      if (!reverseEdge) return null;
      reverseEdge.capacity += 1;
      current = prior;
    }
  }

  const usedRouteEdges = new Set<EdgeKey>();
  for (const edges of graph) {
    for (const edge of edges) {
      if (edge.routeKey && edge.capacity === 0) {
        if (usedRouteEdges.has(edge.routeKey)) {
          usedRouteEdges.delete(edge.routeKey);
        } else {
          usedRouteEdges.add(edge.routeKey);
        }
      }
    }
  }
  return pathFromCycleEdges(usedRouteEdges);
}

/**
 * Close two vertex-disjoint paths between geographically extreme anchors.
 * This retains complete north/east/south/west perimeter options that a
 * locally greedy face merger can discard before they become area-positive.
 */
export function extremeAnchorCycles(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
): CyclePath[] {
  const hullNodeIds = convexHullNodeIds(adjacency, nodes);
  const pairs: {
    readonly distance: number;
    readonly firstId: NodeId;
    readonly secondId: NodeId;
  }[] = [];
  for (let firstIndex = 0; firstIndex < hullNodeIds.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < hullNodeIds.length;
      secondIndex += 1
    ) {
      const firstId = hullNodeIds[firstIndex];
      const secondId = hullNodeIds[secondIndex];
      if (!firstId || !secondId) continue;
      pairs.push({
        firstId,
        secondId,
        distance: distanceMeters(
          getRequired(nodes, firstId).coordinate,
          getRequired(nodes, secondId).coordinate,
        ),
      });
    }
  }
  pairs.sort((first, second) => second.distance - first.distance);

  const componentNodeIds = [...adjacency.keys()];
  const center = componentNodeIds.reduce(
    (total, nodeId) => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      total[0] += coordinate[0] / componentNodeIds.length;
      total[1] += coordinate[1] / componentNodeIds.length;
      return total;
    },
    [0, 0] satisfies Coordinate,
  );
  const radialDistance = (nodeId: NodeId): number => {
    const coordinate = getRequired(nodes, nodeId).coordinate;
    return Math.hypot(
      (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
      coordinate[1] - center[1],
    );
  };
  const maximumRadius = Math.max(...componentNodeIds.map(radialDistance));
  const cycles = new Map<string, CyclePath>();

  for (const { firstId, secondId } of pairs.slice(0, EXTREME_ANCHOR_PAIR_LIMIT)) {
    for (const minimumFactor of [1, 0.35, 0.12, 0.04]) {
      const path = vertexDisjointCycle(
        adjacency,
        firstId,
        secondId,
        (edgeFromId, edgeToId) => {
          const length = distanceMeters(
            getRequired(nodes, edgeFromId).coordinate,
            getRequired(nodes, edgeToId).coordinate,
          );
          const radial =
            (radialDistance(edgeFromId) + radialDistance(edgeToId)) /
            (2 * maximumRadius);
          return length * (minimumFactor + 1 - radial);
        },
      );
      if (path) cycles.set(stableCandidateId(path), path);
    }
  }

  return [...cycles.values()];
}

export function shortestNodePath(
  adjacency: ReadonlyAdjacency,
  fromId: NodeId,
  toId: NodeId,
  excludedNodeIds: ReadonlySet<NodeId>,
  edgeCost: EdgeCost,
): CyclePath | null {
  const distances = new Map<NodeId, number>([[fromId, 0]]);
  const previous = new Map<NodeId, NodeId>();
  const pending: [number, NodeId][] = [[0, fromId]];

  while (pending.length > 0) {
    pending.sort((first, second) => second[0] - first[0]);
    const current = pending.pop();
    if (!current) break;
    const [distance, nodeId] = current;
    if (distance !== distances.get(nodeId)) continue;
    if (nodeId === toId) {
      const path = [toId];
      while (path[0] !== fromId) {
        const previousId = previous.get(path[0] ?? '');
        if (!previousId) return null;
        path.unshift(previousId);
      }
      return path;
    }
    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (
        neighborId !== toId &&
        neighborId !== fromId &&
        excludedNodeIds.has(neighborId)
      ) {
        continue;
      }
      const nextDistance = distance + edgeCost(nodeId, neighborId);
      if (nextDistance >= (distances.get(neighborId) ?? Infinity)) continue;
      distances.set(neighborId, nextDistance);
      previous.set(neighborId, nodeId);
      pending.push([nextDistance, neighborId]);
    }
  }
  return null;
}

export function pathThroughWaypoints(
  adjacency: ReadonlyAdjacency,
  fromId: NodeId,
  waypointIds: readonly NodeId[],
  toId: NodeId,
  excludedNodeIds: ReadonlySet<NodeId>,
  edgeCost: EdgeCost,
): CyclePath | null {
  const stops = [fromId, ...waypointIds, toId];
  const path = [fromId];
  const exclusions = new Set(excludedNodeIds);
  for (let index = 1; index < stops.length; index += 1) {
    const segment = shortestNodePath(
      adjacency,
      stops[index - 1] ?? fromId,
      stops[index] ?? toId,
      exclusions,
      edgeCost,
    );
    if (!segment) return null;
    path.push(...segment.slice(1));
    for (const nodeId of segment.slice(1, -1)) exclusions.add(nodeId);
  }
  return path;
}

/**
 * Preserve three-sided geographic extent explicitly: one anchor-to-anchor path
 * must pass through the opposite extreme, while the return path remains
 * vertex-disjoint. This preserves valid outer perimeters that span several
 * locally nested loops.
 */
export function waypointExtremeCycles(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
): CyclePath[] {
  const nodeIds = [...adjacency.keys()];
  if (nodeIds.length < 3) return [];
  const northId = nodeIds.toSorted(
    (firstId, secondId) =>
      getRequired(nodes, secondId).coordinate[1] -
      getRequired(nodes, firstId).coordinate[1],
  )[0];
  const eastId = nodeIds.toSorted(
    (firstId, secondId) =>
      getRequired(nodes, secondId).coordinate[0] -
      getRequired(nodes, firstId).coordinate[0],
  )[0];
  const southId = nodeIds.toSorted(
    (firstId, secondId) =>
      getRequired(nodes, firstId).coordinate[1] -
      getRequired(nodes, secondId).coordinate[1],
  )[0];
  const westId = nodeIds.toSorted(
    (firstId, secondId) =>
      getRequired(nodes, firstId).coordinate[0] -
      getRequired(nodes, secondId).coordinate[0],
  )[0];
  if (!northId || !eastId || !southId || !westId) return [];
  if (new Set([northId, eastId, southId, westId]).size < 4) return [];

  const center = nodeIds.reduce(
    (total, nodeId) => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      total[0] += coordinate[0] / nodeIds.length;
      total[1] += coordinate[1] / nodeIds.length;
      return total;
    },
    [0, 0] satisfies Coordinate,
  );
  const radialDistance = (nodeId: NodeId): number => {
    const coordinate = getRequired(nodes, nodeId).coordinate;
    return Math.hypot(
      (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
      coordinate[1] - center[1],
    );
  };
  const maximumRadius = Math.max(...nodeIds.map(radialDistance));
  const costs: EdgeCost[] = [1, 0.4, 0.12].map(
    (minimumFactor) =>
      (fromId: NodeId, toId: NodeId): number => {
        const length = distanceMeters(
          getRequired(nodes, fromId).coordinate,
          getRequired(nodes, toId).coordinate,
        );
        const radial =
          (radialDistance(fromId) + radialDistance(toId)) / (2 * maximumRadius);
        return length * (minimumFactor + 1 - radial);
      },
  );
  const cycles = new Map<string, CyclePath>();

  for (const directCost of costs) {
    for (const waypointCost of costs) {
      for (const waypointIds of [[southId], [westId, southId]]) {
        for (const directFirst of [true, false]) {
          let directPath;
          let waypointPath;
          if (directFirst) {
            directPath = shortestNodePath(
              adjacency,
              northId,
              eastId,
              new Set(),
              directCost,
            );
            if (!directPath) continue;
            waypointPath = pathThroughWaypoints(
              adjacency,
              northId,
              waypointIds,
              eastId,
              new Set(directPath.slice(1, -1)),
              waypointCost,
            );
          } else {
            waypointPath = pathThroughWaypoints(
              adjacency,
              northId,
              waypointIds,
              eastId,
              new Set(),
              waypointCost,
            );
            if (!waypointPath) continue;
            directPath = shortestNodePath(
              adjacency,
              northId,
              eastId,
              new Set(waypointPath.slice(1, -1)),
              directCost,
            );
          }
          if (!directPath || !waypointPath) continue;
          const path = [...directPath, ...[...waypointPath].reverse().slice(1, -1)];
          if (new Set(path).size === path.length) {
            cycles.set(stableCandidateId(path), path);
          }
        }
      }
    }
  }
  return [...cycles.values()];
}

export function closedPathThroughWaypoints(
  adjacency: ReadonlyAdjacency,
  waypointIds: readonly NodeId[],
  edgeCost: EdgeCost,
): CyclePath | null {
  if (new Set(waypointIds).size < 3) return null;
  const firstWaypoint = waypointIds[0];
  if (!firstWaypoint) return null;
  const stops = [...waypointIds, firstWaypoint];
  const path = [firstWaypoint];
  const exclusions = new Set<NodeId>();

  for (let index = 1; index < stops.length; index += 1) {
    const segment = shortestNodePath(
      adjacency,
      stops[index - 1] ?? firstWaypoint,
      stops[index] ?? firstWaypoint,
      exclusions,
      edgeCost,
    );
    if (!segment) return null;
    path.push(...segment.slice(1));
    for (const nodeId of segment.slice(0, -1)) exclusions.add(nodeId);
  }

  path.pop();
  return new Set(path).size === path.length ? path : null;
}

/**
 * Cardinal anchors alone can miss a real perimeter bulge that is not the
 * northernmost or easternmost station. Sample several angular directions and
 * join their extreme platform nodes in geographic order, retaining the exact
 * walking links used between line-specific platforms.
 */
export function radialWaypointCycles(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
): CyclePath[] {
  const nodeIds = [...adjacency.keys()];
  if (nodeIds.length < 3) return [];
  const center = nodeIds.reduce(
    (total, nodeId) => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      total[0] += coordinate[0] / nodeIds.length;
      total[1] += coordinate[1] / nodeIds.length;
      return total;
    },
    [0, 0] satisfies Coordinate,
  );
  const projected = new Map<NodeId, Coordinate>(
    nodeIds.map((nodeId) => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      return [
        nodeId,
        [
          (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
          coordinate[1] - center[1],
        ],
      ];
    }),
  );
  const radialDistance = (nodeId: NodeId): number =>
    Math.hypot(...getRequired(projected, nodeId));
  const maximumRadius = Math.max(...nodeIds.map(radialDistance));
  const costs: EdgeCost[] = [1, 0.4, 0.12].map(
    (minimumFactor) =>
      (fromId: NodeId, toId: NodeId): number => {
        const length = distanceMeters(
          getRequired(nodes, fromId).coordinate,
          getRequired(nodes, toId).coordinate,
        );
        const radial =
          (radialDistance(fromId) + radialDistance(toId)) / (2 * maximumRadius);
        return length * (minimumFactor + 1 - radial);
      },
  );
  const cycles = new Map<string, CyclePath>();

  for (const directionCount of [6, 8, 10, 12]) {
    for (const rotation of [0, 0.5]) {
      const anchors: NodeId[] = [];
      for (let index = 0; index < directionCount; index += 1) {
        const angle = ((index + rotation) * Math.PI * 2) / directionCount;
        const direction: Coordinate = [Math.cos(angle), Math.sin(angle)];
        const anchorId = nodeIds.toSorted((firstId, secondId) => {
          const first = getRequired(projected, firstId);
          const second = getRequired(projected, secondId);
          const [firstX, firstY] = first;
          const [secondX, secondY] = second;
          const [directionX, directionY] = direction;
          return (
            secondX * directionX +
            secondY * directionY -
            (firstX * directionX + firstY * directionY)
          );
        })[0];
        if (anchorId && !anchors.includes(anchorId)) anchors.push(anchorId);
      }
      if (anchors.length < 3) continue;

      for (const edgeCost of costs) {
        for (const orderedAnchors of [anchors, [...anchors].reverse()]) {
          const path = closedPathThroughWaypoints(adjacency, orderedAnchors, edgeCost);
          if (path) cycles.set(stableCandidateId(path), path);
        }
      }
    }
  }
  return [...cycles.values()];
}

export function transferWaypointCycles(
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
  transferEdgeKeys: Iterable<EdgeKey>,
): CyclePath[] {
  const nodeIds = [...adjacency.keys()];
  if (nodeIds.length < 4) return [];
  const center = nodeIds.reduce(
    (total, nodeId) => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      total[0] += coordinate[0] / nodeIds.length;
      total[1] += coordinate[1] / nodeIds.length;
      return total;
    },
    [0, 0] satisfies Coordinate,
  );
  const projected = (nodeId: NodeId): Coordinate => {
    const coordinate = getRequired(nodes, nodeId).coordinate;
    return [
      (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
      coordinate[1] - center[1],
    ];
  };
  const directions: Coordinate[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const cardinalAnchors = directions
    .map(
      (direction) =>
        nodeIds.toSorted((firstId, secondId) => {
          const first = projected(firstId);
          const second = projected(secondId);
          const [firstX, firstY] = first;
          const [secondX, secondY] = second;
          const [directionX, directionY] = direction;
          return (
            secondX * directionX +
            secondY * directionY -
            (firstX * directionX + firstY * directionY)
          );
        })[0],
    )
    .filter((nodeId): nodeId is NodeId => nodeId !== undefined);
  const transferPairs = [...transferEdgeKeys]
    .flatMap((key) => {
      const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
      return fromId && toId ? ([[fromId, toId]] satisfies GraphEdge[]) : [];
    })
    .filter(([fromId, toId]) => adjacency.get(fromId)?.has(toId) === true)
    .sort((first, second) => {
      const firstRadius = Math.max(
        Math.hypot(...projected(first[0])),
        Math.hypot(...projected(first[1])),
      );
      const secondRadius = Math.max(
        Math.hypot(...projected(second[0])),
        Math.hypot(...projected(second[1])),
      );
      return secondRadius - firstRadius;
    })
    .slice(0, 48);
  const maximumRadius = Math.max(
    ...nodeIds.map((nodeId) => Math.hypot(...projected(nodeId))),
  );
  const costs: EdgeCost[] = [1, 0.35, 0.1].map(
    (minimumFactor) =>
      (fromId: NodeId, toId: NodeId): number => {
        const length = distanceMeters(
          getRequired(nodes, fromId).coordinate,
          getRequired(nodes, toId).coordinate,
        );
        const radial =
          (Math.hypot(...projected(fromId)) + Math.hypot(...projected(toId))) /
          (2 * maximumRadius);
        return length * (minimumFactor + 1 - radial);
      },
  );
  const cycles = new Map<string, CyclePath>();

  for (const transferPair of transferPairs) {
    const anchors = [...new Set([...cardinalAnchors, ...transferPair])].sort(
      (firstId, secondId) => {
        const first = projected(firstId);
        const second = projected(secondId);
        return Math.atan2(first[1], first[0]) - Math.atan2(second[1], second[0]);
      },
    );
    for (const edgeCost of costs) {
      for (const orderedAnchors of [anchors, [...anchors].reverse()]) {
        const path = closedPathThroughWaypoints(adjacency, orderedAnchors, edgeCost);
        if (path) cycles.set(stableCandidateId(path), path);
      }
    }
  }
  return [...cycles.values()];
}

export function cycleArc(
  path: readonly NodeId[],
  fromIndex: number,
  toIndex: number,
): CyclePath {
  const startId = path[fromIndex];
  if (!startId) return [];
  const arc = [startId];
  let index = fromIndex;
  while (index !== toIndex) {
    index = (index + 1) % path.length;
    const nodeId = path[index];
    if (nodeId) arc.push(nodeId);
  }
  return arc;
}

/**
 * Expand a large cycle with "ears": an off-cycle path that reconnects at two
 * existing platform nodes. This captures legitimate perimeter detours (for
 * example through a transfer branch) without collapsing either endpoint into
 * a station-complex centroid.
 */
export function expandCyclesWithEars(
  seedPaths: readonly CyclePath[],
  adjacency: ReadonlyAdjacency,
  nodes: NodeMap,
  transferEdgeKeys: Iterable<EdgeKey>,
): CyclePath[] {
  const transferKeys = new Set<EdgeKey>(transferEdgeKeys);
  const transferNodeIds = new Set<NodeId>(
    [...transferKeys].flatMap((key) => key.split(EDGE_KEY_SEPARATOR)),
  );
  const proposals = new Map<string, CyclePath>();

  for (const seedPath of seedPaths.slice(0, EAR_EXPANSION_SEED_LIMIT)) {
    const cycleNodes = new Set(seedPath);
    const unvisited = new Set(
      [...adjacency.keys()].filter((nodeId) => !cycleNodes.has(nodeId)),
    );
    const components: {
      readonly boundary: Set<NodeId>;
      readonly component: Set<NodeId>;
    }[] = [];

    while (unvisited.size > 0) {
      const startId = unvisited.values().next().value;
      if (!startId) break;
      const pending = [startId];
      const component = new Set<NodeId>();
      const boundary = new Set<NodeId>();
      unvisited.delete(startId);
      while (pending.length > 0) {
        const nodeId = pending.pop();
        if (!nodeId) break;
        component.add(nodeId);
        for (const neighborId of adjacency.get(nodeId) ?? []) {
          if (cycleNodes.has(neighborId)) {
            boundary.add(neighborId);
          } else if (unvisited.delete(neighborId)) {
            pending.push(neighborId);
          }
        }
      }
      if (boundary.size >= 2) components.push({ component, boundary });
    }

    const center = seedPath.reduce(
      (total, nodeId) => {
        const coordinate = getRequired(nodes, nodeId).coordinate;
        total[0] += coordinate[0] / seedPath.length;
        total[1] += coordinate[1] / seedPath.length;
        return total;
      },
      [0, 0] satisfies Coordinate,
    );
    const radialDistance = (nodeId: NodeId): number => {
      const coordinate = getRequired(nodes, nodeId).coordinate;
      return Math.hypot(
        (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
        coordinate[1] - center[1],
      );
    };
    const maximumRadius = Math.max(...[...adjacency.keys()].map(radialDistance));

    for (const { component, boundary } of components) {
      const boundaryIds = [...boundary];
      const pairs: {
        readonly fromId: NodeId;
        readonly score: number;
        readonly toId: NodeId;
      }[] = [];
      for (let firstIndex = 0; firstIndex < boundaryIds.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < boundaryIds.length;
          secondIndex += 1
        ) {
          const fromId = boundaryIds[firstIndex];
          const toId = boundaryIds[secondIndex];
          if (!fromId || !toId) continue;
          const transferPriority =
            Number(transferNodeIds.has(fromId)) + Number(transferNodeIds.has(toId));
          pairs.push({
            fromId,
            toId,
            score:
              transferPriority * 1_000_000 +
              distanceMeters(
                getRequired(nodes, fromId).coordinate,
                getRequired(nodes, toId).coordinate,
              ),
          });
        }
      }
      pairs.sort((first, second) => second.score - first.score);

      const allowedNodeIds = new Set(component);
      for (const boundaryId of boundary) allowedNodeIds.add(boundaryId);
      const earAdjacency: Adjacency = new Map(
        [...allowedNodeIds].map((nodeId) => [
          nodeId,
          new Set(
            [...(adjacency.get(nodeId) ?? [])].filter((neighborId) =>
              allowedNodeIds.has(neighborId),
            ),
          ),
        ]),
      );
      const costs: EdgeCost[] = [1, 0.35, 0.1].map(
        (minimumFactor) =>
          (fromId: NodeId, toId: NodeId): number => {
            const length = distanceMeters(
              getRequired(nodes, fromId).coordinate,
              getRequired(nodes, toId).coordinate,
            );
            const radial =
              (radialDistance(fromId) + radialDistance(toId)) / (2 * maximumRadius);
            return length * (minimumFactor + 1 - radial);
          },
      );
      const addEarProposals = (ear: CyclePath | null): void => {
        if (!ear || ear.length < 3) return;
        const fromId = ear[0];
        const toId = ear.at(-1);
        if (!fromId || !toId) return;
        const fromIndex = seedPath.indexOf(fromId);
        const toIndex = seedPath.indexOf(toId);
        if (fromIndex < 0 || toIndex < 0) return;
        const forwardArc = cycleArc(seedPath, fromIndex, toIndex);
        const reverseArc = cycleArc(seedPath, toIndex, fromIndex);
        for (const path of [
          [...forwardArc, ...ear.slice(1, -1).reverse()],
          [...reverseArc, ...ear.slice(1, -1)],
        ]) {
          if (new Set(path).size !== path.length) continue;
          const coordinates = path.map(
            (nodeId) => getRequired(nodes, nodeId).coordinate,
          );
          if (hasSelfIntersection(coordinates)) continue;
          proposals.set(stableCandidateId(path), path);
        }
      };

      const portals = boundaryIds
        .flatMap((boundaryId) =>
          [...(adjacency.get(boundaryId) ?? [])]
            .filter((neighborId) => component.has(neighborId))
            .map((neighborId) => ({
              boundaryId,
              neighborId,
              isTransfer: transferKeys.has(edgeKey(boundaryId, neighborId)),
              radius: radialDistance(neighborId),
            })),
        )
        .sort(
          (first, second) =>
            Number(second.isTransfer) - Number(first.isTransfer) ||
            second.radius - first.radius,
        )
        .slice(0, 32);
      for (const { boundaryId, neighborId } of portals) {
        const targets = boundaryIds
          .filter((targetId) => targetId !== boundaryId)
          .sort(
            (firstId, secondId) =>
              distanceMeters(
                getRequired(nodes, boundaryId).coordinate,
                getRequired(nodes, secondId).coordinate,
              ) -
              distanceMeters(
                getRequired(nodes, boundaryId).coordinate,
                getRequired(nodes, firstId).coordinate,
              ),
          )
          .slice(0, 18);
        for (const targetId of targets) {
          for (const edgeCost of costs) {
            const continuation = shortestNodePath(
              earAdjacency,
              neighborId,
              targetId,
              new Set([boundaryId]),
              edgeCost,
            );
            if (continuation) {
              addEarProposals([boundaryId, ...continuation]);
            }
          }
        }
      }

      for (const { fromId, toId } of pairs.slice(0, EAR_EXPANSION_PAIR_LIMIT)) {
        for (const edgeCost of costs) {
          const ear = shortestNodePath(earAdjacency, fromId, toId, new Set(), edgeCost);
          addEarProposals(ear);
        }
      }
    }
  }
  return [...proposals.values()];
}
