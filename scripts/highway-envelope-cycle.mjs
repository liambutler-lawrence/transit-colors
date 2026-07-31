import {
  geodesicLineLengthMeters,
  geodesicPolygonAreaSquareMeters,
} from '../src/geodesy.ts';
import {
  biconnectedEdgeBlocks,
  properSelfIntersectionSegments,
} from './highway-cycle.mjs';

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
      if (this.values[parentIndex].distanceMeters <= value.distanceMeters) break;
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
      if (this.values[childIndex].distanceMeters >= last.distanceMeters) break;
      this.values[index] = this.values[childIndex];
      index = childIndex;
    }
    this.values[index] = last;
    return result;
  }
}

function sameCoordinate(first, second) {
  return Math.abs(first[0] - second[0]) < 1e-6 && Math.abs(first[1] - second[1]) < 1e-6;
}

function segmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const firstX = firstEnd[0] - firstStart[0];
  const firstY = firstEnd[1] - firstStart[1];
  const secondX = secondEnd[0] - secondStart[0];
  const secondY = secondEnd[1] - secondStart[1];
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < 1e-18) return null;
  const offsetX = secondStart[0] - firstStart[0];
  const offsetY = secondStart[1] - firstStart[1];
  const firstFraction = (offsetX * secondY - offsetY * secondX) / denominator;
  return [
    firstStart[0] + firstFraction * firstX,
    firstStart[1] + firstFraction * firstY,
  ];
}

export function loopErasedHighwayCoordinates(sourceCoordinates) {
  let coordinates = sourceCoordinates;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const intersectionSegments = properSelfIntersectionSegments(coordinates);
    if (!intersectionSegments) return coordinates;
    const [firstIndex, secondIndex] = intersectionSegments;
    const intersection = segmentIntersection(
      coordinates[firstIndex],
      coordinates[firstIndex + 1],
      coordinates[secondIndex],
      coordinates[secondIndex + 1],
    );
    if (!intersection) break;
    coordinates = [
      ...coordinates.slice(0, firstIndex + 1),
      intersection,
      ...coordinates.slice(secondIndex + 1),
    ];
  }
  throw new Error('Could not erase all loops from a highway corridor.');
}

function orientedStep(edge, edgeIndex, fromId, kind, partIndices = edge.partIndices) {
  if (edge.fromId === fromId) {
    return {
      coordinates: edge.coordinates,
      edgeIndex,
      fromId: edge.fromId,
      kind,
      partIndices,
      toId: edge.toId,
    };
  }
  if (edge.toId !== fromId) {
    throw new Error(`Highway edge ${edgeIndex} is not incident to ${fromId}.`);
  }
  return {
    coordinates: [...edge.coordinates].reverse(),
    edgeIndex,
    fromId: edge.toId,
    kind,
    partIndices,
    toId: edge.fromId,
  };
}

function normalizedCycleSteps(edges, segments) {
  const steps = segments.map((segment) => {
    const edge = edges[segment.edgeIndex];
    if (!edge) throw new Error(`Missing source highway edge ${segment.edgeIndex}.`);
    const fromId =
      segment.fromId ??
      (sameCoordinate(segment.coordinates[0], edge.coordinates[0])
        ? edge.fromId
        : edge.toId);
    const step = orientedStep(
      edge,
      segment.edgeIndex,
      fromId,
      'cycle',
      segment.partIndices,
    );
    return {
      ...step,
      coordinates: segment.coordinates,
    };
  });
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].toId !== steps[(index + 1) % steps.length].fromId) {
      throw new Error(`Expanded highway cycle is broken at segment ${index}.`);
    }
  }
  if (new Set(steps.map((step) => step.fromId)).size !== steps.length) {
    throw new Error('Expanded highway cycle repeats a graph junction.');
  }
  return steps;
}

function highwayAdjacency(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const [edgeIndex, edge] of edges.entries()) {
    const distanceMeters = geodesicLineLengthMeters(edge.coordinates);
    adjacency.get(edge.fromId)?.push({
      distanceMeters,
      edgeIndex,
      toId: edge.toId,
    });
    adjacency.get(edge.toId)?.push({
      distanceMeters,
      edgeIndex,
      toId: edge.fromId,
    });
  }
  return adjacency;
}

function shortestPath(
  startId,
  isTarget,
  adjacency,
  edges,
  forbiddenEdgeIndices,
  forbiddenNodeIds,
) {
  const distances = new Map([[startId, 0]]);
  const previous = new Map();
  const pending = new MinimumDistanceHeap();
  pending.push({ distanceMeters: 0, nodeId: startId });
  let targetId = null;

  while (pending.size > 0) {
    const current = pending.pop();
    if (current.distanceMeters !== distances.get(current.nodeId)) continue;
    if (current.nodeId !== startId && isTarget(current.nodeId)) {
      targetId = current.nodeId;
      break;
    }
    for (const incident of adjacency.get(current.nodeId) ?? []) {
      if (forbiddenEdgeIndices.has(incident.edgeIndex)) continue;
      if (forbiddenNodeIds.has(incident.toId) && !isTarget(incident.toId)) {
        continue;
      }
      const nextDistance = current.distanceMeters + incident.distanceMeters;
      if (nextDistance >= (distances.get(incident.toId) ?? Infinity)) continue;
      distances.set(incident.toId, nextDistance);
      previous.set(incident.toId, {
        edgeIndex: incident.edgeIndex,
        fromId: current.nodeId,
      });
      pending.push({
        distanceMeters: nextDistance,
        nodeId: incident.toId,
      });
    }
  }

  if (targetId === null) return null;
  const steps = [];
  let currentId = targetId;
  while (currentId !== startId) {
    const previousStep = previous.get(currentId);
    if (!previousStep) return null;
    steps.unshift(
      orientedStep(
        edges[previousStep.edgeIndex],
        previousStep.edgeIndex,
        previousStep.fromId,
        'ear',
      ),
    );
    currentId = previousStep.fromId;
  }
  return { steps, targetId };
}

function reverseSteps(steps) {
  return [...steps].reverse().map((step) => ({
    ...step,
    coordinates: [...step.coordinates].reverse(),
    fromId: step.toId,
    toId: step.fromId,
  }));
}

function buildCoordinates(steps) {
  const coordinates = [];
  const owners = [];
  for (const step of steps) {
    if (coordinates.length === 0) coordinates.push(step.coordinates[0]);
    for (const coordinate of step.coordinates.slice(1)) {
      coordinates.push(coordinate);
      owners.push(step);
    }
  }
  if (!sameCoordinate(coordinates[0], coordinates.at(-1))) {
    coordinates.push(coordinates[0]);
    owners.push(steps.at(-1));
  }
  return { coordinates, owners };
}

function eraseLocalEarLoops(built) {
  let { coordinates, owners } = built;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const intersection = properSelfIntersectionSegments(coordinates);
    if (!intersection) return { coordinates, owners };
    const [firstIndex, secondIndex] = intersection;
    const firstOwner = owners[firstIndex];
    const secondOwner = owners[secondIndex];
    const loopLengthMeters = geodesicLineLengthMeters(
      coordinates.slice(firstIndex, secondIndex + 2),
    );
    if (
      firstOwner?.kind !== 'ear' ||
      secondOwner?.kind !== 'ear' ||
      loopLengthMeters > 50_000
    ) {
      return { coordinates, owners };
    }
    const crossingCoordinate = segmentIntersection(
      coordinates[firstIndex],
      coordinates[firstIndex + 1],
      coordinates[secondIndex],
      coordinates[secondIndex + 1],
    );
    if (!crossingCoordinate) return { coordinates, owners };
    coordinates = [
      ...coordinates.slice(0, firstIndex + 1),
      crossingCoordinate,
      ...coordinates.slice(secondIndex + 1),
    ];
    owners = [
      ...owners.slice(0, firstIndex),
      firstOwner,
      secondOwner,
      ...owners.slice(secondIndex + 1),
    ];
  }
  return { coordinates, owners };
}

function ownedSegments(candidate) {
  const segments = [];
  for (let index = 0; index < candidate.owners.length; index += 1) {
    const owner = candidate.owners[index];
    const previous = segments.at(-1);
    if (previous?.owner === owner) {
      previous.coordinates.push(candidate.coordinates[index + 1]);
      continue;
    }
    segments.push({
      coordinates: [candidate.coordinates[index], candidate.coordinates[index + 1]],
      owner,
    });
  }
  return segments;
}

function cycleArc(steps, fromIndex, toIndex) {
  const result = [];
  let index = fromIndex;
  while (index !== toIndex) {
    result.push(steps[index]);
    index = (index + 1) % steps.length;
  }
  return result;
}

function simpleCandidate(steps) {
  if (steps.length < 3) return null;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].toId !== steps[(index + 1) % steps.length].fromId) {
      return null;
    }
  }
  if (new Set(steps.map((step) => step.fromId)).size !== steps.length) {
    return null;
  }
  const built = eraseLocalEarLoops(buildCoordinates(steps));
  const intersection = properSelfIntersectionSegments(built.coordinates);
  return {
    ...built,
    areaSquareMeters: intersection
      ? 0
      : geodesicPolygonAreaSquareMeters(built.coordinates),
    intersection,
    lengthMeters: intersection ? Infinity : geodesicLineLengthMeters(built.coordinates),
    steps,
  };
}

function internalNodeIds(steps) {
  return steps.slice(0, -1).map((step) => step.toId);
}

function buildEar(
  cycleSteps,
  waypointIds,
  adjacency,
  edges,
  forbiddenEdgeIndices,
  attachmentNodeIds,
) {
  const cycleNodeIds = new Set(cycleSteps.map((step) => step.fromId));
  const [requiredFromId, requiredToId] = attachmentNodeIds ?? [];
  const blockedCycleNodeIds =
    requiredFromId && requiredToId
      ? new Set(
          cycleArc(
            cycleSteps,
            cycleSteps.findIndex((step) => step.fromId === requiredToId),
            cycleSteps.findIndex((step) => step.fromId === requiredFromId),
          ).map((step) => step.fromId),
        )
      : cycleNodeIds;
  const firstWaypointId = waypointIds[0];
  const lastWaypointId = waypointIds.at(-1);
  const firstForbiddenNodes = new Set(
    [...blockedCycleNodeIds].filter((nodeId) => nodeId !== firstWaypointId),
  );
  const firstPath = shortestPath(
    firstWaypointId,
    (nodeId) => (requiredFromId ? nodeId === requiredFromId : cycleNodeIds.has(nodeId)),
    adjacency,
    edges,
    forbiddenEdgeIndices,
    firstForbiddenNodes,
  );
  if (!firstPath) return { failure: 'first-attachment' };

  const usedInternalNodeIds = new Set(internalNodeIds(firstPath.steps));
  usedInternalNodeIds.delete(firstPath.targetId);
  const forwardSteps = reverseSteps(firstPath.steps);
  let currentId = firstWaypointId;
  for (const waypointId of waypointIds.slice(1)) {
    const forbiddenNodeIds = new Set([...blockedCycleNodeIds, ...usedInternalNodeIds]);
    forbiddenNodeIds.delete(currentId);
    forbiddenNodeIds.delete(waypointId);
    const path = shortestPath(
      currentId,
      (nodeId) => nodeId === waypointId,
      adjacency,
      edges,
      forbiddenEdgeIndices,
      forbiddenNodeIds,
    );
    if (!path) return { failure: `support-${currentId}-${waypointId}` };
    forwardSteps.push(...path.steps);
    for (const nodeId of internalNodeIds(path.steps)) {
      usedInternalNodeIds.add(nodeId);
    }
    currentId = waypointId;
  }

  const lastForbiddenNodes = new Set([...blockedCycleNodeIds, ...usedInternalNodeIds]);
  lastForbiddenNodes.delete(lastWaypointId);
  lastForbiddenNodes.add(firstPath.targetId);
  const lastPath = shortestPath(
    lastWaypointId,
    (nodeId) =>
      requiredToId
        ? nodeId === requiredToId
        : cycleNodeIds.has(nodeId) && nodeId !== firstPath.targetId,
    adjacency,
    edges,
    forbiddenEdgeIndices,
    lastForbiddenNodes,
  );
  if (!lastPath) return { failure: 'last-attachment' };
  forwardSteps.push(...lastPath.steps);
  return {
    fromId: firstPath.targetId,
    steps: forwardSteps,
    toId: lastPath.targetId,
  };
}

function candidateCycles(cycleSteps, ear) {
  const fromIndex = cycleSteps.findIndex((step) => step.fromId === ear.fromId);
  const toIndex = cycleSteps.findIndex((step) => step.fromId === ear.toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [];
  return [
    simpleCandidate([...ear.steps, ...cycleArc(cycleSteps, toIndex, fromIndex)]),
    simpleCandidate([
      ...reverseSteps(ear.steps),
      ...cycleArc(cycleSteps, fromIndex, toIndex),
    ]),
  ].filter(Boolean);
}

function crossingEarEdges(candidate) {
  if (!candidate?.intersection) return [];
  const [firstIndex, secondIndex] = candidate.intersection;
  return [candidate.owners[firstIndex], candidate.owners[secondIndex]]
    .filter((owner) => owner?.kind === 'ear')
    .sort((first, second) => first.edgeIndex - second.edgeIndex);
}

/**
 * Replaces one arc of a detailed seed cycle with a node-disjoint network ear
 * through the supplied outer support nodes. Every accepted result remains an
 * explicit graph cycle; geometric crossings cause the offending ear corridor
 * to be forbidden and rerouted.
 */
export function refineHighwayCycleThroughWaypoints(
  nodes,
  edges,
  seedSegments,
  waypointIds,
  {
    attachmentCoordinates = null,
    maximumRerouteAttempts = 300,
    onAttempt = () => {},
  } = {},
) {
  const cycleSteps = normalizedCycleSteps(edges, seedSegments);
  const seed = simpleCandidate(cycleSteps);
  if (!seed || seed.intersection) {
    throw new Error('The detailed highway seed is not a simple graph cycle.');
  }
  const coordinateByNodeId = new Map(nodes.map((node) => [node.id, node.coordinate]));
  const attachmentNodeIds = attachmentCoordinates?.map((target) => {
    const distance = (nodeId) => {
      const coordinate = coordinateByNodeId.get(nodeId);
      const meanLatitudeRadians = ((coordinate[1] + target[1]) / 2) * (Math.PI / 180);
      return (
        ((coordinate[0] - target[0]) * Math.cos(meanLatitudeRadians)) ** 2 +
        (coordinate[1] - target[1]) ** 2
      );
    };
    return cycleSteps
      .map((step) => step.fromId)
      .sort((firstId, secondId) => distance(firstId) - distance(secondId))[0];
  });
  if (
    attachmentNodeIds &&
    (attachmentNodeIds.length !== 2 || attachmentNodeIds[0] === attachmentNodeIds[1])
  ) {
    throw new Error('Envelope attachments must resolve to two cycle junctions.');
  }
  const routingEdges = edges.map((edge) => ({
    ...edge,
    coordinates: loopErasedHighwayCoordinates(edge.coordinates),
  }));
  const adjacency = highwayAdjacency(nodes, routingEdges);
  const pendingForbiddenEdgeSets = [new Set()];
  const seenForbiddenEdgeSets = new Set(['']);
  for (let attempt = 0; attempt < maximumRerouteAttempts; attempt += 1) {
    const forbiddenEdgeIndices = pendingForbiddenEdgeSets.shift();
    if (!forbiddenEdgeIndices) break;
    const ear = buildEar(
      cycleSteps,
      waypointIds,
      adjacency,
      routingEdges,
      forbiddenEdgeIndices,
      attachmentNodeIds,
    );
    if (ear.failure) {
      onAttempt({ attempt, failure: ear.failure, outcome: 'no-ear' });
      continue;
    }
    const candidates = candidateCycles(cycleSteps, ear);
    const valid = candidates
      .filter((candidate) => !candidate.intersection)
      .sort(
        (first, second) =>
          second.areaSquareMeters - first.areaSquareMeters ||
          first.lengthMeters - second.lengthMeters,
      )[0];
    onAttempt({
      areasSquareMeters: candidates.map((candidate) => candidate.areaSquareMeters),
      attempt,
      forbiddenEdgeCount: forbiddenEdgeIndices.size,
      fromId: ear.fromId,
      intersections: candidates.map((candidate) => candidate.intersection),
      intersectingEdges: candidates.map((candidate) =>
        candidate.intersection?.map((coordinateIndex) => {
          const owner = candidate.owners[coordinateIndex];
          return owner ? { edgeIndex: owner.edgeIndex, kind: owner.kind } : null;
        }),
      ),
      outcome:
        valid && valid.areaSquareMeters > seed.areaSquareMeters ? 'accepted' : 'retry',
      toId: ear.toId,
    });
    if (valid && valid.areaSquareMeters > seed.areaSquareMeters) {
      return {
        areaSquareMeters: valid.areaSquareMeters,
        coordinates: valid.coordinates,
        lengthMeters: valid.lengthMeters,
        segments: ownedSegments(valid).map(({ coordinates, owner }) => ({
          coordinates,
          edgeIndex: owner.edgeIndex,
          partIndices: owner.partIndices,
        })),
        supportNodeIds: waypointIds,
      };
    }
    const rerouteEdgeIndices = [
      ...new Set(
        candidates.flatMap((candidate) =>
          crossingEarEdges(candidate).map((owner) => owner.edgeIndex),
        ),
      ),
    ].sort((first, second) => first - second);
    for (const rerouteEdgeIndex of rerouteEdgeIndices) {
      const nextForbiddenEdgeIndices = new Set(forbiddenEdgeIndices);
      nextForbiddenEdgeIndices.add(rerouteEdgeIndex);
      const key = [...nextForbiddenEdgeIndices]
        .sort((first, second) => first - second)
        .join(',');
      if (seenForbiddenEdgeSets.has(key)) continue;
      seenForbiddenEdgeSets.add(key);
      pendingForbiddenEdgeSets.push(nextForbiddenEdgeIndices);
    }
  }
  throw new Error(
    `No larger simple highway envelope could be routed through ${waypointIds.join(
      ', ',
    )}.`,
  );
}

export function northAmericanHighwayEnvelopeSupportNodeIds(
  nodes,
  edges,
  {
    supportCoordinates = [
      [-73.6, 45.5],
      [-70.9, 42.86],
    ],
  } = {},
) {
  const largestBlock = biconnectedEdgeBlocks(nodes, edges).sort(
    (first, second) => second.length - first.length,
  )[0];
  if (!largestBlock) throw new Error('The highway graph has no cyclic block.');
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeIds = [
    ...new Set(
      largestBlock.flatMap((edgeIndex) => [
        edges[edgeIndex].fromId,
        edges[edgeIndex].toId,
      ]),
    ),
  ];
  const nearestNodeId = (target) =>
    [...nodeIds].sort((firstId, secondId) => {
      const distance = (nodeId) => {
        const coordinate = nodeById.get(nodeId).coordinate;
        const meanLatitudeRadians = ((coordinate[1] + target[1]) / 2) * (Math.PI / 180);
        return (
          ((coordinate[0] - target[0]) * Math.cos(meanLatitudeRadians)) ** 2 +
          (coordinate[1] - target[1]) ** 2
        );
      };
      return distance(firstId) - distance(secondId);
    })[0];
  return [...new Set(supportCoordinates.map(nearestNodeId))];
}
