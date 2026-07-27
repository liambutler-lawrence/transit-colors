import { createRequire } from 'node:module';
import {
  hasSelfIntersection,
  polylinesProperlyIntersect,
} from './circumference-geometry.mjs';
import { signedAreaContributionSquareMeters } from './wgs84-geodesy.mjs';

const EDGE_SEPARATOR = '\u0000';

function toRadians(value) {
  return (value * Math.PI) / 180;
}

export { signedAreaContributionSquareMeters };

function term(coefficient, variable) {
  if (Math.abs(coefficient) < 1e-12) return '';
  return `${coefficient < 0 ? '-' : '+'} ${Math.abs(coefficient)} ${variable}`;
}

function expression(terms) {
  return (
    terms
      .map(([coefficient, variable]) => term(coefficient, variable))
      .filter(Boolean)
      .join(' ') || '0'
  );
}

function edgeKey(firstId, secondId) {
  return firstId < secondId
    ? `${firstId}${EDGE_SEPARATOR}${secondId}`
    : `${secondId}${EDGE_SEPARATOR}${firstId}`;
}

class UnionFind {
  constructor(values) {
    this.parent = new Map(values.map((value) => [value, value]));
  }

  find(value) {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error(`Unknown union-find value: ${value}`);
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

function transferPathFinder(network) {
  const adjacency = new Map(network.stations.map((station) => [station.id, []]));
  for (const [segmentIndex, segment] of network.segments.entries()) {
    if (segment.type !== 'transfer') continue;
    const weight =
      segment.transferMinutes ?? Math.max(0.01, segment.distanceMeters / 80);
    adjacency.get(segment.from.id)?.push({
      segmentIndex,
      toId: segment.to.id,
      weight,
    });
    adjacency.get(segment.to.id)?.push({
      segmentIndex,
      toId: segment.from.id,
      weight,
    });
  }

  const cache = new Map();
  return (fromId, toId) => {
    const key = `${fromId}${EDGE_SEPARATOR}${toId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (fromId === toId) {
      const samePlatform = { coordinates: [], nodeIds: [fromId] };
      cache.set(key, samePlatform);
      return samePlatform;
    }

    const distances = new Map([[fromId, 0]]);
    const previous = new Map();
    const pending = new Set([fromId]);
    while (pending.size > 0 && !distances.has(toId)) {
      let currentId = null;
      let currentDistance = Infinity;
      for (const candidateId of pending) {
        const candidateDistance = distances.get(candidateId) ?? Infinity;
        if (candidateDistance < currentDistance) {
          currentId = candidateId;
          currentDistance = candidateDistance;
        }
      }
      if (currentId === null) break;
      pending.delete(currentId);
      for (const step of adjacency.get(currentId) ?? []) {
        const nextDistance = currentDistance + step.weight;
        if (nextDistance >= (distances.get(step.toId) ?? Infinity)) continue;
        distances.set(step.toId, nextDistance);
        previous.set(step.toId, {
          fromId: currentId,
          segmentIndex: step.segmentIndex,
        });
        pending.add(step.toId);
      }
    }
    if (!distances.has(toId)) {
      throw new Error(`No published free-transfer path from ${fromId} to ${toId}`);
    }

    const reversedSteps = [];
    let currentId = toId;
    while (currentId !== fromId) {
      const step = previous.get(currentId);
      if (!step) throw new Error(`Incomplete transfer path from ${fromId} to ${toId}`);
      reversedSteps.push({
        fromId: step.fromId,
        toId: currentId,
        segmentIndex: step.segmentIndex,
      });
      currentId = step.fromId;
    }
    const steps = reversedSteps.reverse();
    const coordinates = [];
    for (const step of steps) {
      const segment = network.segments[step.segmentIndex];
      const oriented =
        segment.from.id === step.fromId
          ? segment.coordinates
          : [...segment.coordinates].reverse();
      coordinates.push(...(coordinates.length === 0 ? oriented : oriented.slice(1)));
    }
    const result = {
      coordinates,
      nodeIds: [fromId, ...steps.map((step) => step.toId)],
    };
    cache.set(key, result);
    return result;
  };
}

function buildTopology(network) {
  const platformIds = network.stations.map((station) => station.id);
  const transferGroups = new UnionFind(platformIds);
  for (const segment of network.segments) {
    if (segment.type === 'transfer') {
      transferGroups.union(segment.from.id, segment.to.id);
    }
  }

  const allGroupIds = [
    ...new Set(platformIds.map((platformId) => transferGroups.find(platformId))),
  ];
  const originalGroupIndexById = new Map(
    allGroupIds.map((groupId, groupIndex) => [groupId, groupIndex]),
  );
  const originalRideEdges = [];
  for (const [segmentIndex, segment] of network.segments.entries()) {
    if (segment.type !== 'ride') continue;
    const fromGroup = originalGroupIndexById.get(transferGroups.find(segment.from.id));
    const toGroup = originalGroupIndexById.get(transferGroups.find(segment.to.id));
    if (fromGroup === undefined || toGroup === undefined || fromGroup === toGroup) {
      continue;
    }
    originalRideEdges.push({
      edgeIndex: originalRideEdges.length,
      fromGroup,
      segmentIndex,
      toGroup,
    });
  }

  // A simple cycle cannot use a vertex outside the graph's 2-core. Removing
  // terminal branches before constructing the MILP is exact and cuts most
  // suburban tails out of the proof model.
  const incidentEdges = allGroupIds.map(() => new Set());
  for (const edge of originalRideEdges) {
    incidentEdges[edge.fromGroup].add(edge.edgeIndex);
    incidentEdges[edge.toGroup].add(edge.edgeIndex);
  }
  const activeGroups = new Set(allGroupIds.map((_, index) => index));
  const activeEdges = new Set(originalRideEdges.map((edge) => edge.edgeIndex));
  const pending = allGroupIds.flatMap((_, index) =>
    incidentEdges[index].size < 2 ? [index] : [],
  );
  while (pending.length > 0) {
    const groupIndex = pending.pop();
    if (!activeGroups.delete(groupIndex)) continue;
    for (const edgeIndex of incidentEdges[groupIndex]) {
      if (!activeEdges.delete(edgeIndex)) continue;
      const edge = originalRideEdges[edgeIndex];
      const neighbor = edge.fromGroup === groupIndex ? edge.toGroup : edge.fromGroup;
      incidentEdges[neighbor].delete(edgeIndex);
      if (activeGroups.has(neighbor) && incidentEdges[neighbor].size < 2) {
        pending.push(neighbor);
      }
    }
  }

  const junctionOriginalGroups = new Set(
    [...activeGroups].filter((groupIndex) => incidentEdges[groupIndex].size !== 2),
  );
  // A component whose every vertex has degree two is already one cycle.
  // Promote one deterministic vertex so it becomes one closed corridor.
  const unvisitedGroups = new Set(activeGroups);
  while (unvisitedGroups.size > 0) {
    const firstGroup = unvisitedGroups.values().next().value;
    const component = [];
    const componentPending = [firstGroup];
    unvisitedGroups.delete(firstGroup);
    while (componentPending.length > 0) {
      const groupIndex = componentPending.pop();
      component.push(groupIndex);
      for (const edgeIndex of incidentEdges[groupIndex]) {
        const edge = originalRideEdges[edgeIndex];
        const neighbor = edge.fromGroup === groupIndex ? edge.toGroup : edge.fromGroup;
        if (unvisitedGroups.delete(neighbor)) componentPending.push(neighbor);
      }
    }
    if (!component.some((groupIndex) => junctionOriginalGroups.has(groupIndex))) {
      junctionOriginalGroups.add(Math.min(...component));
    }
  }

  const junctions = [...junctionOriginalGroups].sort((first, second) => first - second);
  const junctionIndex = new Map(
    junctions.map((originalGroupIndex, index) => [originalGroupIndex, index]),
  );
  const groupIds = junctions.map(
    (originalGroupIndex) => allGroupIds[originalGroupIndex],
  );
  const findTransferPath = transferPathFinder(network);
  const visitedRideEdges = new Set();
  const rideEdges = [];

  const orientedRide = (edge, fromGroup) => {
    const segment = network.segments[edge.segmentIndex];
    if (edge.fromGroup === fromGroup) {
      return {
        coordinates: segment.coordinates,
        fromPlatformId: segment.from.id,
        toGroup: edge.toGroup,
        toPlatformId: segment.to.id,
      };
    }
    return {
      coordinates: [...segment.coordinates].reverse(),
      fromPlatformId: segment.to.id,
      toGroup: edge.fromGroup,
      toPlatformId: segment.from.id,
    };
  };

  for (const startGroup of junctions) {
    for (const startingEdgeIndex of incidentEdges[startGroup]) {
      if (
        !activeEdges.has(startingEdgeIndex) ||
        visitedRideEdges.has(startingEdgeIndex)
      ) {
        continue;
      }
      const nodeIds = [];
      const coordinates = [];
      const originalSegmentIndices = [];
      let currentGroup = startGroup;
      let currentEdgeIndex = startingEdgeIndex;
      while (true) {
        visitedRideEdges.add(currentEdgeIndex);
        const edge = originalRideEdges[currentEdgeIndex];
        const oriented = orientedRide(edge, currentGroup);
        if (nodeIds.length === 0) {
          nodeIds.push(oriented.fromPlatformId);
          coordinates.push(...oriented.coordinates);
        } else {
          const transfer = findTransferPath(nodeIds.at(-1), oriented.fromPlatformId);
          nodeIds.push(...transfer.nodeIds.slice(1));
          if (transfer.coordinates.length > 0) {
            coordinates.push(...transfer.coordinates.slice(1));
          }
          coordinates.push(...oriented.coordinates.slice(1));
        }
        nodeIds.push(oriented.toPlatformId);
        originalSegmentIndices.push(edge.segmentIndex);
        currentGroup = oriented.toGroup;
        if (junctionOriginalGroups.has(currentGroup)) break;
        const nextEdgeIndex = [...incidentEdges[currentGroup]].find(
          (edgeIndex) => edgeIndex !== currentEdgeIndex && activeEdges.has(edgeIndex),
        );
        if (nextEdgeIndex === undefined) {
          throw new Error('Degree-two corridor ended before reaching a junction.');
        }
        currentEdgeIndex = nextEdgeIndex;
      }
      if (hasSelfIntersection(coordinates, false)) continue;
      rideEdges.push({
        coordinates,
        edgeIndex: rideEdges.length,
        fromGroup: junctionIndex.get(startGroup),
        nodeIds,
        originalRideEdgeCount: originalSegmentIndices.length,
        originalSegmentIndices,
        toGroup: junctionIndex.get(currentGroup),
      });
    }
  }

  const arcs = rideEdges.flatMap((edge) => [
    {
      arcIndex: edge.edgeIndex * 2,
      coordinates: edge.coordinates,
      edgeIndex: edge.edgeIndex,
      fromGroup: edge.fromGroup,
      fromPlatformId: edge.nodeIds[0],
      nodeIds: edge.nodeIds,
      toGroup: edge.toGroup,
      toPlatformId: edge.nodeIds.at(-1),
    },
    {
      arcIndex: edge.edgeIndex * 2 + 1,
      coordinates: [...edge.coordinates].reverse(),
      edgeIndex: edge.edgeIndex,
      fromGroup: edge.toGroup,
      fromPlatformId: edge.nodeIds.at(-1),
      nodeIds: [...edge.nodeIds].reverse(),
      toGroup: edge.fromGroup,
      toPlatformId: edge.nodeIds[0],
    },
  ]);
  const incoming = groupIds.map(() => []);
  const outgoing = groupIds.map(() => []);
  for (const arc of arcs) {
    outgoing[arc.fromGroup].push(arc.arcIndex);
    incoming[arc.toGroup].push(arc.arcIndex);
  }

  return {
    arcs,
    groupIds,
    incoming,
    outgoing,
    rideEdges,
    transferGroups,
  };
}

function compressedRideEdgesProperlyIntersect(network, first, second, transferGroups) {
  for (const firstSegmentIndex of first.originalSegmentIndices) {
    const firstSegment = network.segments[firstSegmentIndex];
    for (const secondSegmentIndex of second.originalSegmentIndices) {
      const secondSegment = network.segments[secondSegmentIndex];
      const firstGroups = [
        transferGroups.find(firstSegment.from.id),
        transferGroups.find(firstSegment.to.id),
      ];
      const secondGroups = [
        transferGroups.find(secondSegment.from.id),
        transferGroups.find(secondSegment.to.id),
      ];
      if (firstGroups.some((groupId) => secondGroups.includes(groupId))) {
        continue;
      }
      if (
        polylinesProperlyIntersect(firstSegment.coordinates, secondSegment.coordinates)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function buildExactCircumferenceModel(
  network,
  noGoodCycles = [],
  requiredRootIndex = null,
  includeTransitionAreas = true,
  minimumRideObjective = null,
  forbiddenRootIndexes = [],
) {
  const topology = buildTopology(network);
  const { arcs, groupIds, incoming, outgoing, rideEdges, transferGroups } = topology;
  const findTransferPath = transferPathFinder(network);
  const stationById = new Map(network.stations.map((station) => [station.id, station]));
  const groupReferenceCoordinates = groupIds.map((groupId) => {
    const station = stationById.get(groupId);
    if (!station) throw new Error(`Missing reference platform ${groupId}`);
    return station.coordinate;
  });
  const referenceLatitudeRadians =
    network.stations.reduce(
      (total, station) => total + toRadians(station.coordinate[1]),
      0,
    ) / network.stations.length;
  const transitions = [];
  const transitionsByIncoming = arcs.map(() => []);
  const transitionsByOutgoing = arcs.map(() => []);

  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    for (const incomingArcIndex of incoming[groupIndex]) {
      const incomingArc = arcs[incomingArcIndex];
      for (const outgoingArcIndex of outgoing[groupIndex]) {
        const outgoingArc = arcs[outgoingArcIndex];
        if (
          incomingArc.edgeIndex === outgoingArc.edgeIndex &&
          incomingArcIndex !== outgoingArcIndex
        ) {
          continue;
        }
        const path = findTransferPath(
          incomingArc.toPlatformId,
          outgoingArc.fromPlatformId,
        );
        const arrivalCoordinate = stationById.get(incomingArc.toPlatformId)?.coordinate;
        const departureCoordinate = stationById.get(
          outgoingArc.fromPlatformId,
        )?.coordinate;
        if (!arrivalCoordinate || !departureCoordinate) {
          throw new Error('Missing platform coordinate for exact transfer turn.');
        }
        const viaReferenceCoordinates = [
          arrivalCoordinate,
          groupReferenceCoordinates[groupIndex],
          departureCoordinate,
        ];
        const transition = {
          areaSquareKilometers:
            (signedAreaContributionSquareMeters(
              path.coordinates,
              referenceLatitudeRadians,
            ) -
              signedAreaContributionSquareMeters(
                viaReferenceCoordinates,
                referenceLatitudeRadians,
              )) /
            1_000_000,
          incomingArcIndex,
          groupIndex,
          nodeIds: path.nodeIds,
          outgoingArcIndex,
          transitionIndex: transitions.length,
        };
        transitions.push(transition);
        transitionsByIncoming[incomingArcIndex].push(transition.transitionIndex);
        transitionsByOutgoing[outgoingArcIndex].push(transition.transitionIndex);
      }
    }
  }

  const constraints = [];
  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    constraints.push(
      ` out_${groupIndex}: ${expression([
        ...outgoing[groupIndex].map((arcIndex) => [1, `x${arcIndex}`]),
        [-1, `y${groupIndex}`],
      ])} = 0`,
      ` in_${groupIndex}: ${expression([
        ...incoming[groupIndex].map((arcIndex) => [1, `x${arcIndex}`]),
        [-1, `y${groupIndex}`],
      ])} = 0`,
    );
    if (requiredRootIndex === null) {
      constraints.push(
        ` order_selected_upper_${groupIndex}: u${groupIndex} - ${groupIds.length} y${groupIndex} <= 0`,
        ` order_selected_lower_${groupIndex}: u${groupIndex} - y${groupIndex} >= 0`,
        ` root_selected_${groupIndex}: r${groupIndex} - y${groupIndex} <= 0`,
        ` canonical_root_required_${groupIndex}: ${expression([
          [1, `r${groupIndex}`],
          [-1, `y${groupIndex}`],
          ...groupIds
            .slice(0, groupIndex)
            .map((_, lowerIndex) => [1, `y${lowerIndex}`]),
        ])} >= 0`,
        ` canonical_root_first_${groupIndex}: ${expression([
          [groupIds.length, `r${groupIndex}`],
          ...groupIds
            .slice(0, groupIndex)
            .map((_, lowerIndex) => [1, `y${lowerIndex}`]),
        ])} <= ${groupIds.length}`,
        ` root_order_${groupIndex}: u${groupIndex} + ${groupIds.length} r${groupIndex} <= ${groupIds.length + 1}`,
      );
    } else if (groupIndex === requiredRootIndex) {
      constraints.push(
        ` required_root: y${groupIndex} = 1`,
        ` root_flow: ${expression([
          ...outgoing[groupIndex].map((arcIndex) => [1, `f${arcIndex}`]),
          ...incoming[groupIndex].map((arcIndex) => [-1, `f${arcIndex}`]),
          ...groupIds.flatMap((_, selectedIndex) =>
            selectedIndex === groupIndex ? [] : [[-1, `y${selectedIndex}`]],
          ),
        ])} = 0`,
      );
    } else {
      constraints.push(
        ` flow_${groupIndex}: ${expression([
          ...incoming[groupIndex].map((arcIndex) => [1, `f${arcIndex}`]),
          ...outgoing[groupIndex].map((arcIndex) => [-1, `f${arcIndex}`]),
          [-1, `y${groupIndex}`],
        ])} = 0`,
      );
    }
  }
  for (const arc of arcs) {
    if (requiredRootIndex === null) {
      constraints.push(
        ` order_${arc.arcIndex}: u${arc.toGroup} - u${arc.fromGroup} - ${groupIds.length + 1} x${arc.arcIndex} + ${groupIds.length + 1} r${arc.toGroup} >= ${-groupIds.length}`,
      );
    } else {
      constraints.push(
        ` flow_capacity_${arc.arcIndex}: f${arc.arcIndex} - ${groupIds.length} x${arc.arcIndex} <= 0`,
      );
    }
    if (includeTransitionAreas) {
      constraints.push(
        ` transition_in_${arc.arcIndex}: ${expression([
          ...transitionsByIncoming[arc.arcIndex].map((transitionIndex) => [
            1,
            `z${transitionIndex}`,
          ]),
          [-1, `x${arc.arcIndex}`],
        ])} = 0`,
        ` transition_out_${arc.arcIndex}: ${expression([
          ...transitionsByOutgoing[arc.arcIndex].map((transitionIndex) => [
            1,
            `z${transitionIndex}`,
          ]),
          [-1, `x${arc.arcIndex}`],
        ])} = 0`,
      );
    }
  }
  for (const edge of rideEdges) {
    constraints.push(
      ` edge_direction_${edge.edgeIndex}: x${edge.edgeIndex * 2} + x${edge.edgeIndex * 2 + 1} <= 1`,
    );
  }
  for (const forbiddenRootIndex of forbiddenRootIndexes) {
    constraints.push(
      ` forbidden_root_${forbiddenRootIndex}: y${forbiddenRootIndex} = 0`,
    );
  }

  let crossingCutCount = 0;
  for (let firstIndex = 0; firstIndex < rideEdges.length; firstIndex += 1) {
    const first = rideEdges[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < rideEdges.length;
      secondIndex += 1
    ) {
      const second = rideEdges[secondIndex];
      if (
        !compressedRideEdgesProperlyIntersect(network, first, second, transferGroups)
      ) {
        continue;
      }
      constraints.push(
        ` crossing_${crossingCutCount}: x${first.edgeIndex * 2} + x${first.edgeIndex * 2 + 1} + x${second.edgeIndex * 2} + x${second.edgeIndex * 2 + 1} <= 1`,
      );
      crossingCutCount += 1;
    }
  }
  for (const [cycleIndex, selectedArcIndexes] of noGoodCycles.entries()) {
    constraints.push(
      ` simple_route_${cycleIndex}: ${expression(
        selectedArcIndexes.map((arcIndex) => [1, `x${arcIndex}`]),
      )} <= ${selectedArcIndexes.length - 1}`,
    );
  }
  constraints.push(
    ` minimum_cycle: ${expression(
      rideEdges.flatMap((edge) => [
        [edge.originalRideEdgeCount, `x${edge.edgeIndex * 2}`],
        [edge.originalRideEdgeCount, `x${edge.edgeIndex * 2 + 1}`],
      ]),
    )} >= 3`,
  );
  if (requiredRootIndex === null) {
    constraints.push(
      ` one_root: ${expression(groupIds.map((_, groupIndex) => [1, `r${groupIndex}`]))} = 1`,
    );
  }

  const objectiveTerms = [
    ...arcs.map((arc) => [
      signedAreaContributionSquareMeters(
        [
          groupReferenceCoordinates[arc.fromGroup],
          ...arc.coordinates,
          groupReferenceCoordinates[arc.toGroup],
        ],
        referenceLatitudeRadians,
      ) / 1_000_000,
      `x${arc.arcIndex}`,
    ]),
    ...(includeTransitionAreas
      ? transitions.map((transition) => [
          transition.areaSquareKilometers,
          `z${transition.transitionIndex}`,
        ])
      : []),
  ];
  const rideObjectiveTerms = arcs.map((arc) => [
    signedAreaContributionSquareMeters(
      [
        groupReferenceCoordinates[arc.fromGroup],
        ...arc.coordinates,
        groupReferenceCoordinates[arc.toGroup],
      ],
      referenceLatitudeRadians,
    ) / 1_000_000,
    `x${arc.arcIndex}`,
  ]);
  if (minimumRideObjective !== null) {
    constraints.push(
      ` competitive_area: ${expression(rideObjectiveTerms)} >= ${minimumRideObjective}`,
    );
  }
  const maximumTransitionAreaByGroup = new Map();
  for (const transition of transitions) {
    maximumTransitionAreaByGroup.set(
      transition.groupIndex,
      Math.max(
        maximumTransitionAreaByGroup.get(transition.groupIndex) ?? 0,
        Math.abs(transition.areaSquareKilometers),
      ),
    );
  }
  const transitionAreaBound = [...maximumTransitionAreaByGroup.values()].reduce(
    (total, area) => total + area,
    0,
  );
  const lp = [
    'Maximize',
    ` objective: ${expression(objectiveTerms)}`,
    'Subject To',
    ...constraints,
    'Bounds',
    ...(requiredRootIndex === null
      ? groupIds.map((_, groupIndex) => ` 0 <= u${groupIndex} <= ${groupIds.length}`)
      : arcs.map((arc) => ` 0 <= f${arc.arcIndex} <= ${groupIds.length}`)),
    ...groupIds.map((_, groupIndex) => ` 0 <= y${groupIndex} <= 1`),
    ...(includeTransitionAreas
      ? transitions.map((transition) => ` 0 <= z${transition.transitionIndex} <= 1`)
      : []),
    'Binary',
    ...arcs.map((arc) => ` x${arc.arcIndex}`),
    ...(requiredRootIndex === null
      ? groupIds.map((_, groupIndex) => ` r${groupIndex}`)
      : []),
    'End',
  ].join('\n');

  return {
    ...topology,
    crossingCutCount,
    lp,
    transitionAreaBound,
    transitions,
  };
}

function coordinatesForPath(network, nodeIds) {
  const segmentByEdge = new Map(
    network.segments.map((segment) => [
      edgeKey(segment.from.id, segment.to.id),
      segment,
    ]),
  );
  const coordinates = [];
  for (let index = 0; index < nodeIds.length; index += 1) {
    const fromId = nodeIds[index];
    const toId = nodeIds[(index + 1) % nodeIds.length];
    const segment = segmentByEdge.get(edgeKey(fromId, toId));
    if (!segment) {
      throw new Error(`Missing network segment from ${fromId} to ${toId}`);
    }
    const oriented =
      segment.from.id === fromId
        ? segment.coordinates
        : [...segment.coordinates].reverse();
    coordinates.push(...(coordinates.length === 0 ? oriented : oriented.slice(1)));
  }
  const firstCoordinate = coordinates[0];
  const lastCoordinate = coordinates.at(-1);
  if (
    firstCoordinate &&
    lastCoordinate &&
    (firstCoordinate[0] !== lastCoordinate[0] ||
      firstCoordinate[1] !== lastCoordinate[1])
  ) {
    coordinates.push(firstCoordinate);
  }
  return coordinates;
}

export function isValidSimpleCircumferenceCycle(network, nodeIds) {
  try {
    const { transferGroups } = buildTopology(network);
    const groupIds = [];
    for (const nodeId of nodeIds) {
      const groupId = transferGroups.find(nodeId);
      if (groupIds.at(-1) !== groupId) groupIds.push(groupId);
    }
    if (groupIds[0] === groupIds.at(-1)) groupIds.pop();
    if (groupIds.length < 3 || new Set(groupIds).size !== groupIds.length) {
      return false;
    }
    const segmentByEdge = new Map(
      network.segments.map((segment) => [
        edgeKey(segment.from.id, segment.to.id),
        segment,
      ]),
    );
    const rideEdges = [];
    for (let index = 0; index < nodeIds.length; index += 1) {
      const fromId = nodeIds[index];
      const toId = nodeIds[(index + 1) % nodeIds.length];
      const segment = segmentByEdge.get(edgeKey(fromId, toId));
      if (!segment) return false;
      if (segment.type !== 'ride') continue;
      rideEdges.push({
        coordinates:
          segment.from.id === fromId
            ? segment.coordinates
            : [...segment.coordinates].reverse(),
        fromGroup: transferGroups.find(fromId),
        toGroup: transferGroups.find(toId),
      });
    }
    for (let firstIndex = 0; firstIndex < rideEdges.length; firstIndex += 1) {
      const first = rideEdges[firstIndex];
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < rideEdges.length;
        secondIndex += 1
      ) {
        const second = rideEdges[secondIndex];
        if (
          first.fromGroup === second.fromGroup ||
          first.fromGroup === second.toGroup ||
          first.toGroup === second.fromGroup ||
          first.toGroup === second.toGroup
        ) {
          continue;
        }
        if (polylinesProperlyIntersect(first.coordinates, second.coordinates)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function orderedSelectedArcs(model, solution) {
  const selected = model.arcs.filter(
    (arc) => (solution.Columns[`x${arc.arcIndex}`]?.Primal ?? 0) > 0.5,
  );
  const nextByGroup = new Map(selected.map((arc) => [arc.fromGroup, arc]));
  const first = selected[0];
  if (!first) throw new Error('Exact circumference solve returned an empty cycle.');
  const ordered = [];
  let current = first;
  do {
    ordered.push(current);
    current = nextByGroup.get(current.toGroup);
    if (!current) throw new Error('Exact circumference solution is disconnected.');
  } while (current.arcIndex !== first.arcIndex && ordered.length <= selected.length);
  if (
    current.arcIndex !== first.arcIndex ||
    ordered.length !== selected.length ||
    new Set(ordered.map((arc) => arc.fromGroup)).size !== ordered.length
  ) {
    throw new Error('Exact circumference solution is not one simple cycle.');
  }
  return ordered;
}

function platformPathForArcs(model, orderedArcs) {
  const transitionByPair = new Map(
    model.transitions.map((transition) => [
      `${transition.incomingArcIndex}:${transition.outgoingArcIndex}`,
      transition,
    ]),
  );
  const closedNodeIds = [orderedArcs[0].fromPlatformId];
  for (let index = 0; index < orderedArcs.length; index += 1) {
    const arc = orderedArcs[index];
    const nextArc = orderedArcs[(index + 1) % orderedArcs.length];
    closedNodeIds.push(...arc.nodeIds.slice(1));
    const transition = transitionByPair.get(`${arc.arcIndex}:${nextArc.arcIndex}`);
    if (!transition) {
      throw new Error(
        `Missing exact transfer transition ${arc.arcIndex}:${nextArc.arcIndex}`,
      );
    }
    closedNodeIds.push(...transition.nodeIds.slice(1));
  }
  if (closedNodeIds.at(-1) !== closedNodeIds[0]) {
    throw new Error('Exact platform route does not close.');
  }
  return closedNodeIds.slice(0, -1);
}

export function exactRouteFromSolution(network, model, solution) {
  const orderedArcs = orderedSelectedArcs(model, solution);
  const nodeIds = platformPathForArcs(model, orderedArcs);
  const coordinates = coordinatesForPath(network, nodeIds);
  return {
    areaSquareKilometers: signedAreaContributionSquareMeters(coordinates) / 1_000_000,
    coordinates,
    nodeIds,
    orderedArcs,
  };
}

export function feedbackVertexRoots(topology) {
  const remainingGroups = new Set(topology.groupIds.map((_, groupIndex) => groupIndex));
  const remainingEdges = new Set(topology.rideEdges.map((edge) => edge.edgeIndex));
  const roots = [];

  const containsCycle = () => {
    const parent = new Map(
      [...remainingGroups].map((groupIndex) => [groupIndex, groupIndex]),
    );
    const find = (groupIndex) => {
      const parentIndex = parent.get(groupIndex);
      if (parentIndex === groupIndex) return groupIndex;
      const rootIndex = find(parentIndex);
      parent.set(groupIndex, rootIndex);
      return rootIndex;
    };
    for (const edgeIndex of remainingEdges) {
      const edge = topology.rideEdges[edgeIndex];
      const fromRoot = find(edge.fromGroup);
      const toRoot = find(edge.toGroup);
      if (fromRoot === toRoot) return true;
      parent.set(fromRoot, toRoot);
    }
    return false;
  };

  while (containsCycle()) {
    const degree = new Map([...remainingGroups].map((groupIndex) => [groupIndex, 0]));
    for (const edgeIndex of remainingEdges) {
      const edge = topology.rideEdges[edgeIndex];
      degree.set(edge.fromGroup, (degree.get(edge.fromGroup) ?? 0) + 1);
      degree.set(edge.toGroup, (degree.get(edge.toGroup) ?? 0) + 1);
    }
    const rootIndex = [...remainingGroups].sort(
      (first, second) =>
        (degree.get(second) ?? 0) - (degree.get(first) ?? 0) || first - second,
    )[0];
    if (rootIndex === undefined) break;
    roots.push(rootIndex);
    remainingGroups.delete(rootIndex);
    for (const edgeIndex of [...remainingEdges]) {
      const edge = topology.rideEdges[edgeIndex];
      if (edge.fromGroup === rootIndex || edge.toGroup === rootIndex) {
        remainingEdges.delete(edgeIndex);
      }
    }
  }
  // The degree heuristic can select vertices that become redundant after later
  // removals. Drop each such vertex while preserving the feedback-set proof.
  for (const rootIndex of [...roots].reverse()) {
    const candidateRoots = new Set(
      roots.filter((candidateIndex) => candidateIndex !== rootIndex),
    );
    const parent = new Map(
      topology.groupIds.flatMap((_, groupIndex) =>
        candidateRoots.has(groupIndex) ? [] : [[groupIndex, groupIndex]],
      ),
    );
    const find = (groupIndex) => {
      const parentIndex = parent.get(groupIndex);
      if (parentIndex === groupIndex) return groupIndex;
      const foundIndex = find(parentIndex);
      parent.set(groupIndex, foundIndex);
      return foundIndex;
    };
    let acyclic = true;
    for (const edge of topology.rideEdges) {
      if (candidateRoots.has(edge.fromGroup) || candidateRoots.has(edge.toGroup)) {
        continue;
      }
      const fromRoot = find(edge.fromGroup);
      const toRoot = find(edge.toGroup);
      if (fromRoot === toRoot) {
        acyclic = false;
        break;
      }
      parent.set(fromRoot, toRoot);
    }
    if (acyclic) roots.splice(roots.indexOf(rootIndex), 1);
  }
  return roots;
}

export async function solveExactMaximumAreaCycle(
  network,
  { onIteration = () => {} } = {},
) {
  const require = createRequire(import.meta.url);
  const loadHighs = require('highs');
  const highs = await loadHighs();
  const startedAt = performance.now();
  const topology = buildTopology(network);
  const rootIndexes = feedbackVertexRoots(topology);
  let best = null;
  let optimizationIterations = 0;

  for (const [rootNumber, rootIndex] of rootIndexes.entries()) {
    const noGoodCycles = [];
    while (true) {
      optimizationIterations += 1;
      // Assign every possible cycle to its first feedback-set root. This is a
      // disjoint exhaustive partition, so later roots do not re-prove cycles
      // already covered by an earlier certificate solve.
      const model = buildExactCircumferenceModel(
        network,
        noGoodCycles,
        rootIndex,
        true,
        null,
        rootIndexes.slice(0, rootNumber),
      );
      const solution = highs.solve(model.lp, {
        mip_abs_gap: 0.000001,
        mip_rel_gap: 0,
        presolve: 'on',
        time_limit: 300,
      });
      if (solution.Status === 'Infeasible') break;
      if (solution.Status !== 'Optimal') {
        throw new Error(
          `Exact circumference solve did not prove optimality at certificate root ${rootNumber + 1}/${rootIndexes.length}: ${solution.Status}`,
        );
      }

      const orderedArcs = orderedSelectedArcs(model, solution);
      const nodeIds = platformPathForArcs(model, orderedArcs);
      const coordinates = coordinatesForPath(network, nodeIds);
      onIteration({
        crossingCutCount: model.crossingCutCount,
        iteration: optimizationIterations,
        objectiveSquareKilometers: solution.ObjectiveValue,
        rootCount: rootIndexes.length,
        rootNumber: rootNumber + 1,
      });
      if (!isValidSimpleCircumferenceCycle(network, nodeIds)) {
        noGoodCycles.push(orderedArcs.map((arc) => arc.arcIndex));
        continue;
      }
      if (!best || solution.ObjectiveValue > best.objectiveSquareKilometers) {
        best = {
          coordinates,
          nodeIds,
          objectiveSquareKilometers: solution.ObjectiveValue,
          orderedArcs,
          model,
          status: solution.Status,
        };
      }
      break;
    }
  }
  if (!best) throw new Error('Exact circumference solve found no valid cycle.');
  return {
    areaSquareMeters: Math.abs(signedAreaContributionSquareMeters(best.coordinates)),
    coordinates: best.coordinates,
    edgeIndices: best.orderedArcs
      .map((arc) => best.model.rideEdges[arc.edgeIndex].originalSegmentIndices)
      .flat(),
    nodeIds: best.nodeIds,
    optimizationIterations,
    solveMilliseconds: performance.now() - startedAt,
    status: best.status,
  };
}
