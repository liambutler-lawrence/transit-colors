import {
  geodesicLineLengthMeters,
  geodesicPolygonAreaSquareMeters,
} from '../src/geodesy.ts';
import {
  hasProperSelfIntersection,
  solveLargestPlanarHighwayCycle,
} from './highway-cycle.mjs';
import { solveExactMaximumAreaCycleSingleModel } from './exact-circumference-solver.mjs';

class UnionFind {
  constructor(values) {
    this.parent = new Map(values.map((value) => [value, value]));
  }

  find(value) {
    const parent = this.parent.get(value);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== secondRoot) this.parent.set(secondRoot, firstRoot);
  }
}

class MinimumDistanceHeap {
  constructor() {
    this.values = [];
  }

  get size() {
    return this.values.length;
  }

  push(value) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.values[parentIndex].distanceMeters <= value.distanceMeters) {
        break;
      }
      this.values[index] = this.values[parentIndex];
      index = parentIndex;
    }
    this.values[index] = value;
  }

  pop() {
    const result = this.values[0];
    const last = this.values.pop();
    if (this.values.length === 0) return result;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      if (leftIndex >= this.values.length) break;
      const childIndex =
        rightIndex < this.values.length &&
        this.values[rightIndex].distanceMeters < this.values[leftIndex].distanceMeters
          ? rightIndex
          : leftIndex;
      if (this.values[childIndex].distanceMeters >= last.distanceMeters) {
        break;
      }
      this.values[index] = this.values[childIndex];
      index = childIndex;
    }
    this.values[index] = last;
    return result;
  }
}

function cellKey([longitude, latitude], cellSizeDegrees) {
  return `${Math.floor(longitude / cellSizeDegrees)},${Math.floor(
    latitude / cellSizeDegrees,
  )}`;
}

function orientEdge(edge, fromId) {
  return edge.fromId === fromId
    ? {
        coordinates: edge.coordinates,
        fromId: edge.fromId,
        toId: edge.toId,
      }
    : {
        coordinates: [...edge.coordinates].reverse(),
        fromId: edge.toId,
        toId: edge.fromId,
      };
}

function contractedHighwayGraph(nodes, edges, cellSizeDegrees) {
  const coordinateByNodeId = new Map(nodes.map((node) => [node.id, node.coordinate]));
  const union = new UnionFind(nodes.map((node) => node.id));
  const internalEdgeIndices = new Set();
  for (const [edgeIndex, edge] of edges.entries()) {
    if (
      cellKey(coordinateByNodeId.get(edge.fromId), cellSizeDegrees) ===
      cellKey(coordinateByNodeId.get(edge.toId), cellSizeDegrees)
    ) {
      union.union(edge.fromId, edge.toId);
      internalEdgeIndices.add(edgeIndex);
    }
  }
  const membersByGroupId = new Map();
  for (const node of nodes) {
    const groupId = union.find(node.id);
    const members = membersByGroupId.get(groupId) ?? [];
    members.push(node.id);
    membersByGroupId.set(groupId, members);
  }
  const groupCoordinateById = new Map(
    [...membersByGroupId].map(([groupId, members]) => [
      groupId,
      [
        members.reduce(
          (total, nodeId) => total + coordinateByNodeId.get(nodeId)[0],
          0,
        ) / members.length,
        members.reduce(
          (total, nodeId) => total + coordinateByNodeId.get(nodeId)[1],
          0,
        ) / members.length,
      ],
    ]),
  );
  const externalEdges = [];
  for (const [sourceEdgeIndex, edge] of edges.entries()) {
    if (internalEdgeIndices.has(sourceEdgeIndex)) continue;
    const fromGroupId = union.find(edge.fromId);
    const toGroupId = union.find(edge.toId);
    if (fromGroupId === toGroupId) {
      internalEdgeIndices.add(sourceEdgeIndex);
      continue;
    }
    externalEdges.push({
      actualFromId: edge.fromId,
      actualToId: edge.toId,
      coordinates: [
        groupCoordinateById.get(fromGroupId),
        ...edge.coordinates,
        groupCoordinateById.get(toGroupId),
      ],
      fromId: fromGroupId,
      partIndices: edge.partIndices,
      sourceEdgeIndex,
      toId: toGroupId,
    });
  }
  const groupNodeIds = new Set(
    externalEdges.flatMap((edge) => [edge.fromId, edge.toId]),
  );
  return {
    coordinateByNodeId,
    edges,
    externalEdges,
    groupNodes: [...groupNodeIds].map((groupId) => ({
      coordinate: groupCoordinateById.get(groupId),
      id: groupId,
    })),
    internalEdgeIndices,
    union,
  };
}

function internalAdjacency(context) {
  const adjacency = new Map(
    [...context.coordinateByNodeId.keys()].map((nodeId) => [nodeId, []]),
  );
  for (const edgeIndex of context.internalEdgeIndices) {
    const edge = context.edges[edgeIndex];
    adjacency.get(edge.fromId)?.push(edgeIndex);
    adjacency.get(edge.toId)?.push(edgeIndex);
  }
  return adjacency;
}

function shortestInternalPath(fromId, toId, context, adjacency) {
  if (fromId === toId) return [];
  const distances = new Map([[fromId, 0]]);
  const previous = new Map();
  const queue = new MinimumDistanceHeap();
  queue.push({ distanceMeters: 0, nodeId: fromId });
  while (queue.size > 0) {
    const current = queue.pop();
    if (current.distanceMeters !== distances.get(current.nodeId)) continue;
    if (current.nodeId === toId) break;
    for (const edgeIndex of adjacency.get(current.nodeId) ?? []) {
      const edge = context.edges[edgeIndex];
      const nextId = edge.fromId === current.nodeId ? edge.toId : edge.fromId;
      const nextDistance =
        current.distanceMeters + geodesicLineLengthMeters(edge.coordinates);
      if (nextDistance >= (distances.get(nextId) ?? Infinity)) continue;
      distances.set(nextId, nextDistance);
      previous.set(nextId, { edgeIndex, nodeId: current.nodeId });
      queue.push({ distanceMeters: nextDistance, nodeId: nextId });
    }
  }
  if (!distances.has(toId)) {
    throw new Error(`No internal macro-cell path from ${fromId} to ${toId}.`);
  }
  const steps = [];
  let currentId = toId;
  while (currentId !== fromId) {
    const step = previous.get(currentId);
    if (!step) throw new Error('Incomplete internal macro-cell path.');
    steps.unshift({
      edgeIndex: step.edgeIndex,
      fromId: step.nodeId,
    });
    currentId = step.nodeId;
  }
  return steps;
}

function expandedMacroCycle(exact, context) {
  const externalSteps = exact.edgeIndices.map((edgeIndex, index) => {
    const edge = context.externalEdges[edgeIndex];
    const oriented =
      edge.fromId === exact.nodeIds[index]
        ? {
            actualFromId: edge.actualFromId,
            actualToId: edge.actualToId,
            coordinates: edge.coordinates.slice(1, -1),
            fromGroupId: edge.fromId,
            sourceEdgeIndex: edge.sourceEdgeIndex,
            toGroupId: edge.toId,
          }
        : {
            actualFromId: edge.actualToId,
            actualToId: edge.actualFromId,
            coordinates: [...edge.coordinates.slice(1, -1)].reverse(),
            fromGroupId: edge.toId,
            sourceEdgeIndex: edge.sourceEdgeIndex,
            toGroupId: edge.fromId,
          };
    return oriented;
  });
  const adjacency = internalAdjacency(context);
  const segments = [];
  for (let index = 0; index < externalSteps.length; index += 1) {
    const previous =
      externalSteps[(index - 1 + externalSteps.length) % externalSteps.length];
    const current = externalSteps[index];
    if (previous.toGroupId !== current.fromGroupId) {
      throw new Error('Macro-cycle group sequence is broken.');
    }
    const internalSteps = shortestInternalPath(
      previous.actualToId,
      current.actualFromId,
      context,
      adjacency,
    );
    for (const step of internalSteps) {
      const sourceEdge = context.edges[step.edgeIndex];
      const oriented = orientEdge(sourceEdge, step.fromId);
      segments.push({
        coordinates: oriented.coordinates,
        partIndices: sourceEdge.partIndices,
      });
    }
    const externalSourceEdge = context.edges[current.sourceEdgeIndex];
    segments.push({
      coordinates: current.coordinates,
      partIndices: externalSourceEdge.partIndices,
    });
  }
  const coordinates = [];
  for (const segment of segments) {
    coordinates.push(
      ...(coordinates.length === 0
        ? segment.coordinates
        : segment.coordinates.slice(1)),
    );
  }
  if (
    coordinates[0][0] !== coordinates.at(-1)[0] ||
    coordinates[0][1] !== coordinates.at(-1)[1]
  ) {
    coordinates.push(coordinates[0]);
  }
  return { coordinates, segments };
}

function exactMacroNetwork(context) {
  const stations = [...context.groupNodes];
  const segments = [];
  for (const [sourceExternalIndex, edge] of context.externalEdges.entries()) {
    const sourceCoordinates = edge.coordinates.slice(1, -1);
    const splitIndex = Math.max(
      1,
      Math.min(sourceCoordinates.length - 1, Math.floor(sourceCoordinates.length / 2)),
    );
    const dummyId = `macro-edge:${sourceExternalIndex}`;
    const dummyCoordinate = sourceCoordinates[splitIndex];
    stations.push({ coordinate: dummyCoordinate, id: dummyId });
    for (const [halfIndex, half] of [
      {
        coordinates: [
          edge.coordinates[0],
          ...sourceCoordinates.slice(0, splitIndex + 1),
        ],
        fromId: edge.fromId,
        toId: dummyId,
      },
      {
        coordinates: [...sourceCoordinates.slice(splitIndex), edge.coordinates.at(-1)],
        fromId: dummyId,
        toId: edge.toId,
      },
    ].entries()) {
      segments.push({
        coordinates: half.coordinates,
        distanceMeters: geodesicLineLengthMeters(half.coordinates),
        from: { id: half.fromId },
        id: `macro-segment:${sourceExternalIndex}:${halfIndex}`,
        sourceExternalIndex,
        to: { id: half.toId },
        type: 'ride',
      });
    }
  }
  return { segments, stations };
}

async function solveExactContractedCycle(context) {
  const network = exactMacroNetwork(context);
  const result = await solveExactMaximumAreaCycleSingleModel(network);
  const groupIds = new Set(context.groupNodes.map((node) => node.id));
  const edgeIndices = [];
  const nodeIds = [];
  for (const [routeIndex, segmentIndex] of result.edgeIndices.entries()) {
    const fromId = result.nodeIds[routeIndex];
    if (!groupIds.has(fromId)) continue;
    nodeIds.push(fromId);
    edgeIndices.push(network.segments[segmentIndex].sourceExternalIndex);
  }
  if (edgeIndices.length < 3 || edgeIndices.length !== nodeIds.length) {
    throw new Error('Exact macro route did not alternate groups and corridors.');
  }
  return {
    biconnectedBlockCount: 1,
    edgeIndices,
    faceCount: 1,
    nodeIds,
  };
}

export async function solveDetailedMacroHighwayCycle(
  nodes,
  edges,
  { cellSizesDegrees = [3, 4, 5, 6] } = {},
) {
  let best = null;
  const attempts = [];
  for (const cellSizeDegrees of cellSizesDegrees) {
    const context = contractedHighwayGraph(nodes, edges, cellSizeDegrees);
    let exact;
    try {
      exact = solveLargestPlanarHighwayCycle(context.groupNodes, context.externalEdges);
    } catch (error) {
      attempts.push({
        cellSizeDegrees,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const expanded = expandedMacroCycle(exact, context);
    const areaSquareMeters = geodesicPolygonAreaSquareMeters(expanded.coordinates);
    const selfIntersects = hasProperSelfIntersection(expanded.coordinates);
    attempts.push({
      areaSquareKilometers: areaSquareMeters / 1_000_000,
      cellSizeDegrees,
      externalEdgeCount: context.externalEdges.length,
      externalNodeCount: context.groupNodes.length,
      selfIntersects,
    });
    if (!selfIntersects && (!best || areaSquareMeters > best.areaSquareMeters)) {
      best = {
        ...expanded,
        areaSquareMeters,
        cellSizeDegrees,
        exact,
        lengthMeters: geodesicLineLengthMeters(expanded.coordinates),
      };
    }
  }
  const exactCellSizeDegrees = Math.max(...cellSizesDegrees);
  const exactContext = contractedHighwayGraph(nodes, edges, exactCellSizeDegrees);
  try {
    const exact = await solveExactContractedCycle(exactContext);
    const expanded = expandedMacroCycle(exact, exactContext);
    const areaSquareMeters = geodesicPolygonAreaSquareMeters(expanded.coordinates);
    const selfIntersects = hasProperSelfIntersection(expanded.coordinates);
    attempts.push({
      areaSquareKilometers: areaSquareMeters / 1_000_000,
      cellSizeDegrees: exactCellSizeDegrees,
      exactMilp: true,
      externalEdgeCount: exactContext.externalEdges.length,
      externalNodeCount: exactContext.groupNodes.length,
      selfIntersects,
    });
    if (!selfIntersects && (!best || areaSquareMeters > best.areaSquareMeters)) {
      best = {
        ...expanded,
        areaSquareMeters,
        cellSizeDegrees: exactCellSizeDegrees,
        exact,
        exactMilp: true,
        lengthMeters: geodesicLineLengthMeters(expanded.coordinates),
      };
    }
  } catch (error) {
    attempts.push({
      cellSizeDegrees: exactCellSizeDegrees,
      error: error instanceof Error ? error.message : String(error),
      exactMilp: true,
    });
  }
  if (!best) {
    throw new Error(
      `No non-self-intersecting detailed macro highway cycle: ${JSON.stringify(
        attempts,
      )}`,
    );
  }
  return { ...best, attempts };
}
