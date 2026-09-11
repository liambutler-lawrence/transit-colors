import {
  geodesicLineLengthMeters,
  geodesicPolygonAreaSquareMeters,
} from '../src/geodesy.ts';
import {
  biconnectedEdgeBlocks,
  properSelfIntersectionSegments,
} from './highway-cycle.mjs';
import {
  highwayCycleTurnViolation,
  highwayTurnAllowed,
  highwayEdgeUsable,
} from './highway-turns.mjs';

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

function properSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const firstX = firstEnd[0] - firstStart[0];
  const firstY = firstEnd[1] - firstStart[1];
  const secondX = secondEnd[0] - secondStart[0];
  const secondY = secondEnd[1] - secondStart[1];
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < 1e-18) return null;
  const offsetX = secondStart[0] - firstStart[0];
  const offsetY = secondStart[1] - firstStart[1];
  const firstFraction = (offsetX * secondY - offsetY * secondX) / denominator;
  const secondFraction = (offsetX * firstY - offsetY * firstX) / denominator;
  if (
    firstFraction <= 1e-9 ||
    firstFraction >= 1 - 1e-9 ||
    secondFraction <= 1e-9 ||
    secondFraction >= 1 - 1e-9
  ) {
    return null;
  }
  return {
    coordinate: [
      firstStart[0] + firstFraction * firstX,
      firstStart[1] + firstFraction * firstY,
    ],
    firstFraction,
    secondFraction,
  };
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
      role: edge.role,
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
    role: edge.role,
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

export function highwayAdjacency(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const [edgeIndex, edge] of edges.entries()) {
    // A self-loop would repeat a junction in the required simple cycle.
    if (!highwayEdgeUsable(edge)) continue;
    const distanceMeters =
      geodesicLineLengthMeters(edge.coordinates) + (edge.routingPenaltyMeters ?? 0);
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

export function shortestHighwayPath(
  startId,
  isTarget,
  adjacency,
  edges,
  forbiddenEdgeIndices,
  forbiddenNodeIds,
  incomingEdgeIndex = null,
  { viaNodeIds = [], closingEdgeIndex = null } = {},
) {
  // Arrivals on different highways are different routing states. Keeping
  // only one distance per node discards a longer but legally usable arrival.
  const viaSet = new Set(viaNodeIds);
  const startStage = viaNodeIds[0] === startId ? 1 : 0;
  const stateKey = (nodeId, edgeIndex, stage) =>
    `${stage}\u0000${nodeId}\u0000${edgeIndex ?? ''}`;
  const startKey = stateKey(startId, incomingEdgeIndex, startStage);
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const pending = new MinimumDistanceHeap();
  pending.push({
    distanceMeters: 0,
    nodeId: startId,
    edgeIndex: incomingEdgeIndex,
    key: startKey,
    stage: startStage,
  });
  let targetId = null;
  let targetKey = null;

  while (pending.size > 0) {
    const current = pending.pop();
    if (current.distanceMeters !== distances.get(current.key)) continue;
    if (
      current.nodeId !== startId &&
      current.stage === viaNodeIds.length &&
      isTarget(current.nodeId)
    ) {
      targetId = current.nodeId;
      targetKey = current.key;
      break;
    }
    for (const incident of adjacency.get(current.nodeId) ?? []) {
      if (forbiddenEdgeIndices.has(incident.edgeIndex)) continue;
      if (
        current.edgeIndex !== null &&
        !highwayTurnAllowed(
          edges[current.edgeIndex],
          edges[incident.edgeIndex],
          current.nodeId,
        )
      )
        continue;
      if (forbiddenNodeIds.has(incident.toId) && !isTarget(incident.toId)) {
        continue;
      }
      let stage = current.stage;
      if (viaSet.has(incident.toId)) {
        if (viaNodeIds[stage] !== incident.toId) continue;
        stage += 1;
      }
      if (isTarget(incident.toId)) {
        if (stage !== viaNodeIds.length) continue;
        if (
          closingEdgeIndex !== null &&
          !highwayTurnAllowed(
            edges[incident.edgeIndex],
            edges[closingEdgeIndex],
            incident.toId,
          )
        )
          continue;
      }
      const nextDistance = current.distanceMeters + incident.distanceMeters;
      const nextKey = stateKey(incident.toId, incident.edgeIndex, stage);
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      previous.set(nextKey, {
        edgeIndex: incident.edgeIndex,
        fromId: current.nodeId,
        key: current.key,
      });
      pending.push({
        distanceMeters: nextDistance,
        nodeId: incident.toId,
        edgeIndex: incident.edgeIndex,
        key: nextKey,
        stage,
      });
    }
  }

  if (targetId === null) return null;
  const steps = [];
  let currentKey = targetKey;
  while (currentKey !== startKey) {
    const previousStep = previous.get(currentKey);
    if (!previousStep) return null;
    steps.unshift(
      orientedStep(
        edges[previousStep.edgeIndex],
        previousStep.edgeIndex,
        previousStep.fromId,
        'ear',
      ),
    );
    currentKey = previousStep.key;
  }
  return { steps, targetId, distanceMeters: distances.get(targetKey) };
}

function reverseSteps(steps) {
  return [...steps].reverse().map((step) => ({
    ...step,
    coordinates: [...step.coordinates].reverse(),
    fromId: step.toId,
    toId: step.fromId,
  }));
}

export function clippedHighwayJunctionCoordinates(steps) {
  const clipped = steps.map((step) => [...step.coordinates]);
  const maximumTailMeters = 3_000;
  for (let index = 0; index < steps.length; index += 1) {
    const nextIndex = (index + 1) % steps.length;
    const first = clipped[index];
    const second = clipped[nextIndex];
    if (
      steps[index].toId !== steps[nextIndex].fromId ||
      first.length < 2 ||
      second.length < 2
    ) {
      continue;
    }
    const firstTailIndices = [];
    let firstTailMeters = 0;
    for (
      let coordinateIndex = first.length - 2;
      coordinateIndex >= 0;
      coordinateIndex -= 1
    ) {
      firstTailMeters += geodesicLineLengthMeters(
        first.slice(coordinateIndex, coordinateIndex + 2),
      );
      if (firstTailMeters > maximumTailMeters) break;
      firstTailIndices.push({ coordinateIndex, distanceMeters: firstTailMeters });
    }
    const secondHeadIndices = [];
    let secondHeadMeters = 0;
    for (
      let coordinateIndex = 0;
      coordinateIndex + 1 < second.length;
      coordinateIndex += 1
    ) {
      secondHeadMeters += geodesicLineLengthMeters(
        second.slice(coordinateIndex, coordinateIndex + 2),
      );
      if (secondHeadMeters > maximumTailMeters) break;
      secondHeadIndices.push({ coordinateIndex, distanceMeters: secondHeadMeters });
    }
    let best = null;
    for (const firstTail of firstTailIndices) {
      for (const secondHead of secondHeadIndices) {
        const intersection = properSegmentIntersection(
          first[firstTail.coordinateIndex],
          first[firstTail.coordinateIndex + 1],
          second[secondHead.coordinateIndex],
          second[secondHead.coordinateIndex + 1],
        );
        if (!intersection) continue;
        const distanceMeters = firstTail.distanceMeters + secondHead.distanceMeters;
        if (!best || distanceMeters < best.distanceMeters) {
          best = {
            coordinate: intersection.coordinate,
            distanceMeters,
            firstIndex: firstTail.coordinateIndex,
            secondIndex: secondHead.coordinateIndex,
          };
        }
      }
    }
    if (!best) continue;
    clipped[index] = [...first.slice(0, best.firstIndex + 1), best.coordinate];
    clipped[nextIndex] = [best.coordinate, ...second.slice(best.secondIndex + 1)];
  }
  return clipped;
}

function buildCoordinates(steps) {
  const coordinates = [];
  const owners = [];
  const clippedCoordinates = clippedHighwayJunctionCoordinates(steps);
  for (const [stepIndex, step] of steps.entries()) {
    const stepCoordinates = clippedCoordinates[stepIndex];
    if (coordinates.length === 0) coordinates.push(stepCoordinates[0]);
    for (const coordinate of stepCoordinates.slice(1)) {
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

function simpleCandidate(steps, edges) {
  if (steps.length < 3) return null;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].toId !== steps[(index + 1) % steps.length].fromId) {
      return null;
    }
  }
  const firstVisit = new Map();
  let repeatedNode = null;
  for (const [index, step] of steps.entries()) {
    if (firstVisit.has(step.fromId)) {
      repeatedNode = [firstVisit.get(step.fromId), index];
      break;
    }
    firstVisit.set(step.fromId, index);
  }
  const built = buildCoordinates(steps);
  const intersection = properSelfIntersectionSegments(built.coordinates);
  const turnViolation = highwayCycleTurnViolation(steps, edges);
  return {
    ...built,
    areaSquareMeters:
      intersection || turnViolation || repeatedNode
        ? 0
        : geodesicPolygonAreaSquareMeters(built.coordinates),
    intersection,
    turnViolation,
    repeatedNode,
    lengthMeters:
      intersection || turnViolation || repeatedNode
        ? Infinity
        : geodesicLineLengthMeters(built.coordinates),
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
  const firstPath = shortestHighwayPath(
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
    const path = shortestHighwayPath(
      currentId,
      (nodeId) => nodeId === waypointId,
      adjacency,
      edges,
      forbiddenEdgeIndices,
      forbiddenNodeIds,
      forwardSteps.at(-1)?.edgeIndex ?? null,
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
  const lastPath = shortestHighwayPath(
    lastWaypointId,
    (nodeId) =>
      requiredToId
        ? nodeId === requiredToId
        : cycleNodeIds.has(nodeId) && nodeId !== firstPath.targetId,
    adjacency,
    edges,
    forbiddenEdgeIndices,
    lastForbiddenNodes,
    forwardSteps.at(-1)?.edgeIndex ?? null,
  );
  if (!lastPath) return { failure: 'last-attachment' };
  forwardSteps.push(...lastPath.steps);
  return {
    fromId: firstPath.targetId,
    steps: forwardSteps,
    toId: lastPath.targetId,
  };
}

function candidateCycles(cycleSteps, ear, edges) {
  const fromIndex = cycleSteps.findIndex((step) => step.fromId === ear.fromId);
  const toIndex = cycleSteps.findIndex((step) => step.fromId === ear.toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [];
  return [
    simpleCandidate([...ear.steps, ...cycleArc(cycleSteps, toIndex, fromIndex)], edges),
    simpleCandidate(
      [...reverseSteps(ear.steps), ...cycleArc(cycleSteps, fromIndex, toIndex)],
      edges,
    ),
  ].filter(Boolean);
}

function crossingEarEdges(candidate) {
  if (!candidate) return [];
  const stepViolation = candidate.turnViolation ?? candidate.repeatedNode;
  const owners = stepViolation
    ? stepViolation.map((index) => candidate.steps[index])
    : (candidate.intersection ?? []).map((index) => candidate.owners[index]);
  return owners
    .filter((owner) => owner?.kind === 'ear')
    .sort(
      (first, second) =>
        (first.role === 'connector' ? 0 : 1) - (second.role === 'connector' ? 0 : 1) ||
        first.edgeIndex - second.edgeIndex,
    );
}

/**
 * Replaces one arc of a detailed seed cycle with a node-disjoint network ear
 * through the supplied outer support nodes. Every accepted result remains an
 * explicit graph cycle; crossings and illegal turns cause the offending ear corridor
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
  const seed = simpleCandidate(cycleSteps, edges);
  if (!seed || seed.intersection || seed.turnViolation || seed.repeatedNode) {
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
    const candidates = candidateCycles(cycleSteps, ear, routingEdges);
    const valid = candidates
      .filter(
        (candidate) =>
          !candidate.intersection &&
          !candidate.turnViolation &&
          !candidate.repeatedNode,
      )
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
      turnViolations: candidates.map((candidate) => candidate.turnViolation),
      repeatedNodes: candidates.map((candidate) => candidate.repeatedNode),
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
          fromId: owner.fromId,
          partIndices: owner.partIndices,
          toId: owner.toId,
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

function waypointCycle(waypointIds, adjacency, edges, forbiddenEdgeIndices) {
  const usedNodeIds = new Set();
  const steps = [];
  for (let waypointIndex = 0; waypointIndex < waypointIds.length; waypointIndex += 1) {
    const startId = waypointIds[waypointIndex];
    const targetId = waypointIds[(waypointIndex + 1) % waypointIds.length];
    const forbiddenNodeIds = new Set([
      ...usedNodeIds,
      ...waypointIds.filter((nodeId) => nodeId !== startId && nodeId !== targetId),
    ]);
    forbiddenNodeIds.delete(startId);
    forbiddenNodeIds.delete(targetId);
    const path = shortestHighwayPath(
      startId,
      (nodeId) => nodeId === targetId,
      adjacency,
      edges,
      forbiddenEdgeIndices,
      forbiddenNodeIds,
      steps.at(-1)?.edgeIndex ?? null,
    );
    if (!path) {
      return jointWaypointCycle(waypointIds, adjacency, edges, forbiddenEdgeIndices);
    }
    steps.push(...path.steps);
    for (const step of path.steps) {
      usedNodeIds.add(step.fromId);
      usedNodeIds.add(step.toId);
    }
  }
  return { candidate: simpleCandidate(steps, edges) };
}

function jointWaypointCycle(waypointIds, adjacency, edges, forbiddenEdgeIndices) {
  const startId = waypointIds[0];
  const candidates = [];
  // Search the ordered perimeter as one route. Choosing each waypoint's
  // arrival greedily can force a later leg to loop around to change direction.
  for (const first of adjacency.get(startId) ?? []) {
    if (forbiddenEdgeIndices.has(first.edgeIndex)) continue;
    const path = shortestHighwayPath(
      first.toId,
      (nodeId) => nodeId === startId,
      adjacency,
      edges,
      forbiddenEdgeIndices,
      new Set(),
      first.edgeIndex,
      { viaNodeIds: waypointIds.slice(1), closingEdgeIndex: first.edgeIndex },
    );
    if (!path) continue;
    const steps = [
      orientedStep(edges[first.edgeIndex], first.edgeIndex, startId, 'ear'),
      ...path.steps,
    ];
    const candidate = simpleCandidate(steps, edges);
    if (candidate)
      candidates.push({
        ...candidate,
        searchDistanceMeters: path.distanceMeters + first.distanceMeters,
      });
  }
  if (!candidates.length) return { failure: 'no-direction-compatible-perimeter' };
  candidates.sort((a, b) => {
    const valid = (c) => !c.intersection && !c.turnViolation && !c.repeatedNode;
    return (
      Number(valid(b)) - Number(valid(a)) ||
      (valid(a)
        ? b.areaSquareMeters - a.areaSquareMeters
        : a.searchDistanceMeters - b.searchDistanceMeters)
    );
  });
  return { candidate: candidates[0] };
}

/**
 * Builds the continental boundary itself on the detailed biconnected graph.
 * Consecutive perimeter supports are joined by node-disjoint source paths.
 * Crossings and illegal turns branch on both offending corridors until a
 * valid simple graph cycle is found.
 */
export function solveHighwayEnvelopeCycleThroughWaypoints(
  nodes,
  edges,
  waypointIds,
  { maximumRerouteAttempts = 500, onAttempt = () => {}, tryReverse = true } = {},
) {
  if (waypointIds.length < 3 || new Set(waypointIds).size !== waypointIds.length) {
    throw new Error('A detailed highway envelope needs three distinct supports.');
  }
  const routingEdges = edges.map((edge) => ({
    ...edge,
    coordinates: loopErasedHighwayCoordinates(edge.coordinates),
  }));
  const adjacency = highwayAdjacency(nodes, routingEdges);
  const validCandidates = [];
  const waypointOrders = tryReverse
    ? [waypointIds, [...waypointIds].reverse()]
    : [waypointIds];
  for (const orderedWaypointIds of waypointOrders) {
    const pendingForbiddenEdgeSets = [new Set()];
    const seenForbiddenEdgeSets = new Set(['']);
    for (let attempt = 0; attempt < maximumRerouteAttempts; attempt += 1) {
      const forbiddenEdgeIndices = pendingForbiddenEdgeSets.shift();
      if (!forbiddenEdgeIndices) break;
      const result = waypointCycle(
        orderedWaypointIds,
        adjacency,
        routingEdges,
        forbiddenEdgeIndices,
      );
      if (result.failure) {
        onAttempt({
          attempt,
          failure: result.failure,
          outcome: 'no-cycle',
        });
        continue;
      }
      const candidate = result.candidate;
      onAttempt({
        areaSquareMeters: candidate?.areaSquareMeters ?? 0,
        attempt,
        forbiddenEdgeCount: forbiddenEdgeIndices.size,
        intersection: candidate?.intersection ?? null,
        turnViolation: candidate?.turnViolation ?? null,
        repeatedNode: candidate?.repeatedNode ?? null,
        intersectingCoordinates: candidate?.intersection?.map((coordinateIndex) => [
          candidate.coordinates[coordinateIndex],
          candidate.coordinates[coordinateIndex + 1],
        ]),
        intersectingEdges: candidate?.intersection?.map((coordinateIndex) => {
          const owner = candidate.owners[coordinateIndex];
          return owner ? { edgeIndex: owner.edgeIndex, kind: owner.kind } : null;
        }),
        outcome:
          candidate &&
          !candidate.intersection &&
          !candidate.turnViolation &&
          !candidate.repeatedNode
            ? 'accepted'
            : 'retry',
      });
      if (
        candidate &&
        !candidate.intersection &&
        !candidate.turnViolation &&
        !candidate.repeatedNode
      ) {
        validCandidates.push(candidate);
        break;
      }
      for (const owner of crossingEarEdges(candidate)) {
        const nextForbiddenEdgeIndices = new Set(forbiddenEdgeIndices);
        nextForbiddenEdgeIndices.add(owner.edgeIndex);
        const key = [...nextForbiddenEdgeIndices]
          .sort((first, second) => first - second)
          .join(',');
        if (seenForbiddenEdgeSets.has(key)) continue;
        seenForbiddenEdgeSets.add(key);
        pendingForbiddenEdgeSets.push(nextForbiddenEdgeIndices);
      }
    }
  }
  const best = validCandidates.sort(
    (first, second) =>
      second.areaSquareMeters - first.areaSquareMeters ||
      first.lengthMeters - second.lengthMeters,
  )[0];
  if (!best) {
    throw new Error('No simple detailed highway cycle joins the perimeter supports.');
  }
  return {
    areaSquareMeters: best.areaSquareMeters,
    coordinates: best.coordinates,
    lengthMeters: best.lengthMeters,
    segments: ownedSegments(best).map(({ coordinates, owner }) => ({
      coordinates,
      edgeIndex: owner.edgeIndex,
      fromId: owner.fromId,
      partIndices: owner.partIndices,
      toId: owner.toId,
    })),
    supportNodeIds: waypointIds,
  };
}

export const NORTH_AMERICAN_HIGHWAY_ENVELOPE_COORDINATES = [
  [-87.74, 41.96], // Chicago
  [-79.55, 43.78], // Highway 407 itself, west of the Highway 400 ramp junction
  [-75.7, 45.42], // Highway 416 / 417 through Ottawa
  [-73.6, 45.5], // Montréal
  [-70.9, 42.86], // coastal New England
  [-70.95, 41.9], // I-495 through southeastern Massachusetts
  [-81.24, 32.08], // Savannah
  [-80.2, 25.8], // Miami
  [-90.1, 30], // New Orleans
  [-95.4, 29.8], // Houston
  [-98.5, 29.4], // San Antonio
  [-106.5, 31.8], // El Paso
  [-117.1, 32.7], // San Diego
  [-118.2, 34], // Los Angeles
  [-122.2, 37.7], // San Francisco Bay
  [-122.3, 47.5], // Seattle
  [-93.2, 45], // Minneapolis
];

export function northAmericanHighwayEnvelopeSupportNodeIds(
  nodes,
  edges,
  { supportCoordinates = NORTH_AMERICAN_HIGHWAY_ENVELOPE_COORDINATES } = {},
) {
  edges = edges.filter(highwayEdgeUsable);
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
