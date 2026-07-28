import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const SAMPLE_SPACING_METERS = 25;

function coordinateKey(coordinate) {
  return `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`;
}

function edgeKey(firstId, secondId) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

function lineLengthMeters(coordinates) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += geodesicDistanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

function dedupeCoordinates(coordinates) {
  const result = [];
  for (const coordinate of coordinates) {
    if (
      result.length === 0 ||
      geodesicDistanceMeters(result.at(-1), coordinate) >= 0.25
    ) {
      result.push(coordinate);
    }
  }
  return result;
}

function projectOntoLine(coordinate, line) {
  const latitudeScale = Math.cos((coordinate[1] * Math.PI) / 180);
  let best = null;
  let distanceAlong = 0;
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1];
    const end = line[index];
    const segmentX = (end[0] - start[0]) * latitudeScale;
    const segmentY = end[1] - start[1];
    const pointX = (coordinate[0] - start[0]) * latitudeScale;
    const pointY = coordinate[1] - start[1];
    const denominator = segmentX ** 2 + segmentY ** 2;
    const fraction =
      denominator === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, (pointX * segmentX + pointY * segmentY) / denominator),
          );
    const projected = [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ];
    const distance = geodesicDistanceMeters(coordinate, projected);
    if (!best || distance < best.distanceMeters) {
      best = {
        coordinate: projected,
        distanceAlongMeters: distanceAlong + geodesicDistanceMeters(start, projected),
        distanceMeters: distance,
        fraction,
        segmentIndex: index - 1,
      };
    }
    distanceAlong += geodesicDistanceMeters(start, end);
  }
  return best;
}

function extractLineSection(line, fromCoordinate, toCoordinate) {
  const from = projectOntoLine(fromCoordinate, line);
  const to = projectOntoLine(toCoordinate, line);
  if (!from || !to || from.distanceAlongMeters === to.distanceAlongMeters) return null;
  const reverse = from.distanceAlongMeters > to.distanceAlongMeters;
  const start = reverse ? to : from;
  const end = reverse ? from : to;
  const coordinates = [start.coordinate];
  for (let index = start.segmentIndex + 1; index <= end.segmentIndex; index += 1) {
    coordinates.push(line[index]);
  }
  coordinates.push(end.coordinate);
  if (reverse) coordinates.reverse();
  return dedupeCoordinates(coordinates);
}

function resampleLine(coordinates, sampleCount) {
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(
      cumulative.at(-1) +
        geodesicDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  const totalLength = cumulative.at(-1);
  const result = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const target = (totalLength * sampleIndex) / Math.max(1, sampleCount - 1);
    while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex] < target) {
      segmentIndex += 1;
    }
    const startDistance = cumulative[segmentIndex - 1];
    const endDistance = cumulative[segmentIndex];
    const fraction =
      endDistance === startDistance
        ? 0
        : (target - startDistance) / (endDistance - startDistance);
    const start = coordinates[segmentIndex - 1];
    const end = coordinates[segmentIndex];
    result.push([
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ]);
  }
  return result;
}

export function averageCarriageways(
  carriageways,
  fromCoordinate = carriageways[0]?.[0],
  toCoordinate = carriageways[0]?.at(-1),
) {
  if (carriageways.length < 2 || !fromCoordinate || !toCoordinate) return null;
  const maximumLength = Math.max(...carriageways.map(lineLengthMeters));
  const sampleCount = Math.max(3, Math.ceil(maximumLength / SAMPLE_SPACING_METERS) + 1);
  const sampled = carriageways.map((line) => resampleLine(line, sampleCount));
  const result = Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const sum = sampled.reduce(
      (total, line) => [
        total[0] + line[sampleIndex][0],
        total[1] + line[sampleIndex][1],
      ],
      [0, 0],
    );
    return [
      Number((sum[0] / sampled.length).toFixed(7)),
      Number((sum[1] / sampled.length).toFixed(7)),
    ];
  });
  const originalStart = [...result[0]];
  const originalEnd = [...result.at(-1)];
  const taperSamples = Math.min(12, Math.floor((result.length - 1) / 3));
  for (let index = 0; index <= taperSamples; index += 1) {
    const weight = ((taperSamples - index) / Math.max(1, taperSamples)) ** 2;
    result[index] = [
      result[index][0] + (fromCoordinate[0] - originalStart[0]) * weight,
      result[index][1] + (fromCoordinate[1] - originalStart[1]) * weight,
    ];
    const endIndex = result.length - 1 - index;
    result[endIndex] = [
      result[endIndex][0] + (toCoordinate[0] - originalEnd[0]) * weight,
      result[endIndex][1] + (toCoordinate[1] - originalEnd[1]) * weight,
    ];
  }
  result[0] = [...fromCoordinate];
  result[result.length - 1] = [...toCoordinate];
  return dedupeCoordinates(result);
}

export function eligibleOsmMainlineWay(way, ref) {
  const laneCount = Number.parseInt(way.tags?.lanes ?? '', 10);
  return (
    way.type === 'way' &&
    way.tags?.highway === 'motorway' &&
    way.tags?.oneway === 'yes' &&
    way.tags?.ref === ref &&
    Number.isFinite(laneCount) &&
    laneCount >= 2
  );
}

function osmContext(overpass) {
  const nodes = new Map(
    overpass.elements
      .filter((element) => element.type === 'node')
      .map((node) => [
        node.id,
        {
          coordinate: [node.lon, node.lat],
          tags: node.tags ?? {},
        },
      ]),
  );
  return {
    nodes,
    ways: overpass.elements.filter((element) => element.type === 'way'),
  };
}

function segmentGraph(ways) {
  const edges = [];
  const incident = new Map();
  for (const way of ways) {
    for (let index = 1; index < way.nodes.length; index += 1) {
      const edgeIndex = edges.length;
      const edge = {
        fromId: way.nodes[index - 1],
        toId: way.nodes[index],
        wayId: way.id,
      };
      edges.push(edge);
      for (const nodeId of [edge.fromId, edge.toId]) {
        const entries = incident.get(nodeId) ?? [];
        entries.push(edgeIndex);
        incident.set(nodeId, entries);
      }
    }
  }
  return { edges, incident };
}

function traceComponents(ways, nodes) {
  const graph = segmentGraph(ways);
  const unvisited = new Set(graph.edges.map((_, index) => index));
  const components = [];
  while (unvisited.size > 0) {
    const seed = unvisited.values().next().value;
    const componentEdges = new Set();
    const pending = [seed];
    while (pending.length > 0) {
      const edgeIndex = pending.pop();
      if (!unvisited.delete(edgeIndex)) continue;
      componentEdges.add(edgeIndex);
      const edge = graph.edges[edgeIndex];
      for (const nodeId of [edge.fromId, edge.toId]) {
        for (const neighbor of graph.incident.get(nodeId) ?? []) {
          if (unvisited.has(neighbor)) pending.push(neighbor);
        }
      }
    }

    const degree = new Map();
    for (const edgeIndex of componentEdges) {
      const edge = graph.edges[edgeIndex];
      degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
      degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
    }
    if ([...degree.values()].some((value) => value > 2)) {
      throw new Error('A lane-qualified mainline branches before its gore point.');
    }
    const startId =
      [...degree].find(([, value]) => value === 1)?.[0] ??
      graph.edges[Math.min(...componentEdges)].fromId;
    const coordinates = [nodes.get(startId)?.coordinate];
    const wayIds = new Set();
    let currentId = startId;
    let previousEdge = null;
    while (true) {
      const edgeIndex = (graph.incident.get(currentId) ?? []).find(
        (candidate) => componentEdges.has(candidate) && candidate !== previousEdge,
      );
      if (edgeIndex === undefined) break;
      componentEdges.delete(edgeIndex);
      const edge = graph.edges[edgeIndex];
      wayIds.add(edge.wayId);
      currentId = edge.fromId === currentId ? edge.toId : edge.fromId;
      coordinates.push(nodes.get(currentId)?.coordinate);
      previousEdge = edgeIndex;
      if (currentId === startId || componentEdges.size === 0) break;
    }
    if (coordinates.some((coordinate) => !coordinate)) {
      throw new Error('OSM mainline references a missing node.');
    }
    components.push({
      coordinates: dedupeCoordinates(coordinates),
      wayIds: [...wayIds].sort((first, second) => first - second),
    });
  }
  return components.sort(
    (first, second) =>
      lineLengthMeters(second.coordinates) - lineLengthMeters(first.coordinates),
  );
}

function pairedCarriageways(components, fromCoordinate, toCoordinate) {
  if (components.length >= 2) {
    const sections = components
      .slice(0, 2)
      .map((component) =>
        extractLineSection(component.coordinates, fromCoordinate, toCoordinate),
      );
    if (sections.every(Boolean)) return sections;
  }
  const loop = components[0]?.coordinates;
  if (!loop || loop.length < 4) return null;
  let splitIndex = 1;
  let splitDistance = -1;
  for (let index = 1; index < loop.length - 1; index += 1) {
    const distance = geodesicDistanceMeters(loop[index], fromCoordinate);
    if (distance > splitDistance) {
      splitDistance = distance;
      splitIndex = index;
    }
  }
  const first = loop.slice(0, splitIndex + 1);
  const second = loop.slice(splitIndex).reverse();
  const sections = [first, second].map((line) =>
    extractLineSection(line, fromCoordinate, toCoordinate),
  );
  return sections.every(Boolean) ? sections : null;
}

function insertProjectedCoordinate(line, coordinate) {
  const projection = projectOntoLine(coordinate, line);
  if (!projection) throw new Error('Cannot place an interchange on its mainline.');
  const projected = projection.coordinate.map((value) => Number(value.toFixed(7)));
  if (
    coordinateKey(line[projection.segmentIndex]) === coordinateKey(projected) ||
    coordinateKey(line[projection.segmentIndex + 1]) === coordinateKey(projected)
  ) {
    return { coordinate: projected, line };
  }
  return {
    coordinate: projected,
    line: [
      ...line.slice(0, projection.segmentIndex + 1),
      projected,
      ...line.slice(projection.segmentIndex + 1),
    ],
  };
}

function shortestRampPath({
  forbiddenEdges = new Set(),
  fromNodeIds,
  graph,
  nodes,
  toNodeIds,
}) {
  const distances = new Map();
  const previous = new Map();
  const queue = [];
  for (const nodeId of fromNodeIds) {
    if (!graph.incident.has(nodeId)) continue;
    distances.set(nodeId, 0);
    queue.push({ distance: 0, nodeId });
  }
  const targets = new Set(toNodeIds);
  let targetId = null;
  while (queue.length > 0) {
    queue.sort(
      (first, second) =>
        first.distance - second.distance || first.nodeId - second.nodeId,
    );
    const current = queue.shift();
    if (current.distance !== distances.get(current.nodeId)) continue;
    if (targets.has(current.nodeId)) {
      targetId = current.nodeId;
      break;
    }
    for (const edgeIndex of graph.incident.get(current.nodeId) ?? []) {
      const edge = graph.edges[edgeIndex];
      if (forbiddenEdges.has(edgeKey(edge.fromId, edge.toId))) continue;
      const nextId = edge.fromId === current.nodeId ? edge.toId : edge.fromId;
      if (
        nextId !== targetId &&
        nodes.get(nextId)?.tags?.highway === 'traffic_signals'
      ) {
        continue;
      }
      const nextDistance =
        current.distance +
        geodesicDistanceMeters(
          nodes.get(current.nodeId).coordinate,
          nodes.get(nextId).coordinate,
        );
      if (nextDistance >= (distances.get(nextId) ?? Infinity)) continue;
      distances.set(nextId, nextDistance);
      previous.set(nextId, { edgeIndex, nodeId: current.nodeId });
      queue.push({ distance: nextDistance, nodeId: nextId });
    }
  }
  if (targetId === null) return null;
  const nodeIds = [targetId];
  const edgeIndices = [];
  while (!fromNodeIds.has(nodeIds[0])) {
    const step = previous.get(nodeIds[0]);
    if (!step) return null;
    edgeIndices.unshift(step.edgeIndex);
    nodeIds.unshift(step.nodeId);
  }
  return {
    coordinates: nodeIds.map((nodeId) => nodes.get(nodeId).coordinate),
    distanceMeters: distances.get(targetId),
    edgeIndices,
    nodeIds,
    wayIds: [
      ...new Set(edgeIndices.map((edgeIndex) => graph.edges[edgeIndex].wayId)),
    ].sort((first, second) => first - second),
  };
}

export function findDirectRampPair(overpass, firstRef, secondRef) {
  const { nodes, ways } = osmContext(overpass);
  const firstWays = ways.filter((way) => eligibleOsmMainlineWay(way, firstRef));
  const secondWays = ways.filter((way) => eligibleOsmMainlineWay(way, secondRef));
  const firstNodeIds = new Set(firstWays.flatMap((way) => way.nodes));
  const secondNodeIds = new Set(secondWays.flatMap((way) => way.nodes));
  const linkWays = ways.filter(
    (way) => way.tags?.highway === 'motorway_link' && way.tags?.oneway === 'yes',
  );
  const graph = segmentGraph(linkWays);
  const first = shortestRampPath({
    fromNodeIds: firstNodeIds,
    graph,
    nodes,
    toNodeIds: secondNodeIds,
  });
  if (!first) return [];
  const forbiddenEdges = new Set(
    first.edgeIndices.map((edgeIndex) => {
      const edge = graph.edges[edgeIndex];
      return edgeKey(edge.fromId, edge.toId);
    }),
  );
  const second = shortestRampPath({
    forbiddenEdges,
    fromNodeIds: firstNodeIds,
    graph,
    nodes,
    toNodeIds: secondNodeIds,
  });
  return [first, second].filter(Boolean);
}

function meanEndpoint(paths, index) {
  const coordinates = paths.map((path) =>
    index === 0 ? path.coordinates[0] : path.coordinates.at(-1),
  );
  return [
    coordinates.reduce((total, coordinate) => total + coordinate[0], 0) /
      coordinates.length,
    coordinates.reduce((total, coordinate) => total + coordinate[1], 0) /
      coordinates.length,
  ];
}

export function buildOsmInterchangeOverride(overpass, config) {
  const { nodes, ways } = osmContext(overpass);
  const replacements = config.mainlines.map((mainline) => {
    const eligibleWays = ways.filter((way) =>
      eligibleOsmMainlineWay(way, mainline.ref),
    );
    const components = traceComponents(eligibleWays, nodes);
    const carriageways = pairedCarriageways(
      components,
      mainline.fromCoordinate,
      mainline.toCoordinate,
    );
    if (!carriageways) {
      throw new Error(`Could not pair ${mainline.ref} carriageways.`);
    }
    const coordinates = averageCarriageways(
      carriageways,
      mainline.fromCoordinate,
      mainline.toCoordinate,
    );
    return {
      coordinates,
      ref: mainline.ref,
      replacementMode: mainline.replacementMode,
      targetFeatureId: mainline.targetFeatureId,
      wayIds: [...new Set(components.flatMap((component) => component.wayIds))].sort(
        (first, second) => first - second,
      ),
    };
  });

  const ramps = findDirectRampPair(
    overpass,
    config.mainlines[0].ref,
    config.mainlines[1].ref,
  );
  if (ramps.length < 2) {
    throw new Error('A separated directional ramp pair was not found.');
  }
  const firstReplacement = replacements[0];
  const secondReplacement = replacements[1];
  const firstInsertion = insertProjectedCoordinate(
    firstReplacement.coordinates,
    meanEndpoint(ramps, 0),
  );
  firstReplacement.coordinates = firstInsertion.line;
  const secondInsertion = insertProjectedCoordinate(
    secondReplacement.coordinates,
    meanEndpoint(ramps, -1),
  );
  secondReplacement.coordinates = secondInsertion.line;
  const connectorCoordinates = averageCarriageways(
    ramps.map((ramp) => ramp.coordinates),
    firstInsertion.coordinate,
    secondInsertion.coordinate,
  );

  return {
    id: config.id,
    license: 'OpenStreetMap contributors, ODbL 1.0',
    mainlines: replacements,
    source: 'OpenStreetMap',
    sourceUrl: 'https://www.openstreetmap.org/copyright',
    connectors: [
      {
        coordinates: connectorCoordinates,
        fromRef: config.mainlines[0].ref,
        id: `osm-interchange-${config.id}`,
        kind: 'interchange',
        toRef: config.mainlines[1].ref,
        wayIds: [...new Set(ramps.flatMap((ramp) => ramp.wayIds))].sort(
          (first, second) => first - second,
        ),
      },
    ],
  };
}
