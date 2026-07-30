/* eslint-disable max-lines -- Parsing, carriageway pairing, and explicit-node topology are one audited pipeline. */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const SAMPLE_SPACING_METERS = 50;
const PAIR_SEARCH_METERS = 160;
const GRID_SIZE_DEGREES = 0.002;
const MAX_DIRECT_CONNECTOR_METERS = 25_000;
const MAX_RECIPROCAL_ENDPOINT_GAP_METERS = 2_500;

function decodeOplString(value) {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, hexadecimal) =>
    String.fromCharCode(Number.parseInt(hexadecimal, 16)),
  );
}

function parseOplTags(value) {
  if (!value) return {};
  return Object.fromEntries(
    value.split(',').flatMap((entry) => {
      const separator = entry.indexOf('=');
      return separator < 0
        ? []
        : [
            [
              decodeOplString(entry.slice(0, separator)),
              decodeOplString(entry.slice(separator + 1)),
            ],
          ];
    }),
  );
}

export function parseOplLine(line) {
  if (line.startsWith('n')) {
    const id = line.match(/^n(\d+)/)?.[1];
    const longitude = Number(line.match(/ x(-?\d+(?:\.\d+)?)/)?.[1]);
    const latitude = Number(line.match(/ y(-?\d+(?:\.\d+)?)/)?.[1]);
    if (!id || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return null;
    }
    const tagStart = line.indexOf(' T');
    const coordinateStart = line.indexOf(' x');
    return {
      id,
      coordinate: [longitude, latitude],
      tags:
        tagStart >= 0 && coordinateStart > tagStart
          ? parseOplTags(line.slice(tagStart + 2, coordinateStart))
          : {},
      type: 'node',
    };
  }
  if (!line.startsWith('w')) return null;
  const id = line.match(/^w(\d+)/)?.[1];
  const tagStart = line.indexOf(' T');
  const nodeStart = line.indexOf(' N');
  if (!id || tagStart < 0 || nodeStart < 0) return null;
  return {
    id,
    nodeIds: line
      .slice(nodeStart + 2)
      .split(',')
      .map((nodeId) => nodeId.replace(/^n/, '')),
    tags: parseOplTags(line.slice(tagStart + 2, nodeStart)),
    type: 'way',
  };
}

export async function readOsmMotorwayPbf(sourcePath) {
  const osmium = spawn('osmium', ['cat', sourcePath, '-f', 'opl'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const nodes = new Map();
  const ways = [];
  const lines = readline.createInterface({ input: osmium.stdout });
  for await (const line of lines) {
    const element = parseOplLine(line);
    if (!element) continue;
    if (element.type === 'node') {
      nodes.set(element.id, {
        coordinate: element.coordinate,
        tags: element.tags,
      });
    } else {
      ways.push(element);
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    osmium.once('error', reject);
    osmium.once('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`osmium cat exited with code ${exitCode}.`);
  }
  return { nodes, ways };
}

function laneCount(tags) {
  const counts = (tags.lanes ?? '')
    .split(/[;|]/)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);
  return counts.length > 0 ? Math.min(...counts) : null;
}

function forbiddenHighway(tags) {
  return (
    tags.construction ||
    tags.access === 'no' ||
    tags.motor_vehicle === 'no' ||
    tags.highway === 'construction'
  );
}

export function classifyOsmMotorwayWay(way) {
  if (forbiddenHighway(way.tags)) return null;
  if (way.tags.highway === 'motorway') {
    const lanes = laneCount(way.tags);
    if (way.tags.oneway === 'no') return null;
    return lanes !== null && lanes < 2 ? 'connector' : 'mainline';
  }
  if (way.tags.highway === 'motorway_link') {
    if (way.tags.oneway === 'no') return null;
    return 'connector';
  }
  return null;
}

function routeTokens(tags) {
  const refs = (tags.ref ?? '')
    .split(/[;,]/)
    .map((value) => value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())
    .filter(Boolean);
  if (refs.length > 0) return new Set(refs);
  const name = (tags.name ?? '')
    .replace(/%/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return new Set(name ? [`NAME:${name}`] : []);
}

function vector(first, second) {
  const latitudeScale = Math.cos((((first[1] + second[1]) / 2) * Math.PI) / 180);
  const x = (second[0] - first[0]) * latitudeScale;
  const y = second[1] - first[1];
  const length = Math.hypot(x, y);
  return length === 0 ? [0, 0] : [x / length, y / length];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1];
}

function tokenOverlap(first, second) {
  for (const token of first) if (second.has(token)) return true;
  return false;
}

export function prepareWays(osm) {
  const mainlines = [];
  const connectors = [];
  for (const way of osm.ways) {
    const role = classifyOsmMotorwayWay(way);
    if (!role) continue;
    let nodeIds = way.nodeIds;
    if (way.tags.oneway === '-1') nodeIds = [...nodeIds].reverse();
    const coordinates = nodeIds.map((nodeId) => osm.nodes.get(nodeId)?.coordinate);
    if (coordinates.length < 2 || coordinates.some((coordinate) => !coordinate)) {
      continue;
    }
    const prepared = {
      coordinates,
      endNodeId: nodeIds.at(-1),
      id: way.id,
      nodeIds,
      role,
      startNodeId: nodeIds[0],
      tags: way.tags,
      tokens: routeTokens(way.tags),
    };
    (role === 'mainline' ? mainlines : connectors).push(prepared);
  }
  return { connectors, mainlines };
}

function continuationScore(current, candidate) {
  const currentDirection = vector(
    current.coordinates.at(-2),
    current.coordinates.at(-1),
  );
  const candidateDirection = vector(candidate.coordinates[0], candidate.coordinates[1]);
  const alignment = dot(currentDirection, candidateDirection);
  // Opposing carriageways can share a physical node at a freeway terminus.
  // Route/ref agreement must never turn that U-turn into a continuation.
  if (alignment < 0.25) return Number.NEGATIVE_INFINITY;
  return alignment + (tokenOverlap(current.tokens, candidate.tokens) ? 2 : 0);
}

export function traceMotorwayChains(mainlines) {
  const byStartNode = new Map();
  const predecessorCount = new Map(mainlines.map((way) => [way.id, 0]));
  for (const way of mainlines) {
    const entries = byStartNode.get(way.startNodeId) ?? [];
    entries.push(way);
    byStartNode.set(way.startNodeId, entries);
  }
  for (const way of mainlines) {
    for (const successor of byStartNode.get(way.endNodeId) ?? []) {
      if (successor.id !== way.id) {
        predecessorCount.set(
          successor.id,
          (predecessorCount.get(successor.id) ?? 0) + 1,
        );
      }
    }
  }

  const unvisited = new Set(mainlines.map((way) => way.id));
  const seeds = [
    ...mainlines.filter((way) => (predecessorCount.get(way.id) ?? 0) === 0),
    ...mainlines,
  ];
  const chains = [];
  for (const seed of seeds) {
    if (!unvisited.delete(seed.id)) continue;
    const ways = [seed];
    let current = seed;
    while (true) {
      const candidates = (byStartNode.get(current.endNodeId) ?? [])
        .filter((candidate) => unvisited.has(candidate.id))
        .sort(
          (first, second) =>
            continuationScore(current, second) - continuationScore(current, first) ||
            first.id.localeCompare(second.id),
        );
      const next = candidates[0];
      if (!next || continuationScore(current, next) < 0.1) break;
      unvisited.delete(next.id);
      ways.push(next);
      current = next;
    }
    const coordinates = [];
    const nodeIds = [];
    const tokens = new Set();
    for (const [index, way] of ways.entries()) {
      coordinates.push(...(index === 0 ? way.coordinates : way.coordinates.slice(1)));
      nodeIds.push(...(index === 0 ? way.nodeIds : way.nodeIds.slice(1)));
      for (const token of way.tokens) tokens.add(token);
    }
    chains.push({
      coordinates,
      endNodeId: nodeIds.at(-1),
      id: `chain-${chains.length + 1}`,
      nodeIds,
      sourceWayIds: ways.map((way) => way.id),
      startNodeId: nodeIds[0],
      tokens,
    });
  }
  if (unvisited.size > 0) {
    throw new Error(`Failed to trace ${unvisited.size} motorway ways.`);
  }
  return chains;
}

function lineLengthMeters(coordinates) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += geodesicDistanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

function resampleChain(chain) {
  const samples = resampleCoordinates(chain.coordinates);
  return {
    ...chain,
    lengthMeters: samples.at(-1)?.distanceMeters ?? 0,
    samples: samples.map((sample, sampleIndex) => ({
      ...sample,
      chainId: chain.id,
      sampleIndex,
    })),
  };
}

function resampleCoordinates(coordinates, spacingMeters = SAMPLE_SPACING_METERS) {
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(
      cumulative.at(-1) +
        geodesicDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  const lengthMeters = cumulative.at(-1);
  const sampleCount = Math.max(2, Math.ceil(lengthMeters / spacingMeters) + 1);
  const samples = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const distance = (lengthMeters * sampleIndex) / Math.max(1, sampleCount - 1);
    while (
      segmentIndex < cumulative.length - 1 &&
      cumulative[segmentIndex] < distance
    ) {
      segmentIndex += 1;
    }
    const startDistance = cumulative[segmentIndex - 1];
    const endDistance = cumulative[segmentIndex];
    const fraction =
      endDistance === startDistance
        ? 0
        : (distance - startDistance) / (endDistance - startDistance);
    const start = coordinates[segmentIndex - 1];
    const end = coordinates[segmentIndex];
    samples.push({
      coordinate: [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ],
      direction: vector(start, end),
      distanceMeters: distance,
      sourceSegmentIndex: segmentIndex - 1,
    });
  }
  return samples;
}

function resampleCoordinatesToCount(coordinates, sampleCount) {
  const sampled = resampleCoordinates(
    coordinates,
    Math.max(1, lineLengthMeters(coordinates) / Math.max(1, sampleCount - 1)),
  );
  if (sampled.length === sampleCount) {
    return sampled.map((sample) => sample.coordinate);
  }
  // Floating-point length/spacing division can land one sample either side of
  // the requested count, so fall back to exact normalized-distance sampling.
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(
      cumulative.at(-1) +
        geodesicDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  const result = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const distance = (cumulative.at(-1) * sampleIndex) / Math.max(1, sampleCount - 1);
    while (
      segmentIndex < cumulative.length - 1 &&
      cumulative[segmentIndex] < distance
    ) {
      segmentIndex += 1;
    }
    const segmentLength = cumulative[segmentIndex] - cumulative[segmentIndex - 1];
    const fraction =
      segmentLength === 0
        ? 0
        : (distance - cumulative[segmentIndex - 1]) / segmentLength;
    const start = coordinates[segmentIndex - 1];
    const end = coordinates[segmentIndex];
    result.push([
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ]);
  }
  return result;
}

function gridCell([longitude, latitude]) {
  return [
    Math.floor(longitude / GRID_SIZE_DEGREES),
    Math.floor(latitude / GRID_SIZE_DEGREES),
  ];
}

function nearestOpposingSample(sample, chain, grid, chainById) {
  const [cellX, cellY] = gridCell(sample.coordinate);
  let best = null;
  const visitedSegments = new Set();
  for (let x = cellX - 2; x <= cellX + 2; x += 1) {
    for (let y = cellY - 2; y <= cellY + 2; y += 1) {
      for (const candidate of grid.get(`${x},${y}`) ?? []) {
        if (candidate.chainId === chain.id) continue;
        if (dot(sample.direction, candidate.direction) > -0.62) continue;
        const segmentKey = `${candidate.chainId}:${candidate.sourceSegmentIndex}`;
        if (visitedSegments.has(segmentKey)) continue;
        visitedSegments.add(segmentKey);
        const candidateChain = chainById.get(candidate.chainId);
        const segmentStart = candidateChain.coordinates[candidate.sourceSegmentIndex];
        const segmentEnd = candidateChain.coordinates[candidate.sourceSegmentIndex + 1];
        const projectedCoordinate = projectCoordinateOntoSegment(
          sample.coordinate,
          segmentStart,
          segmentEnd,
        );
        const distanceMeters = geodesicDistanceMeters(
          sample.coordinate,
          projectedCoordinate,
        );
        if (distanceMeters > PAIR_SEARCH_METERS) continue;
        const routePenalty =
          chain.tokens.size > 0 &&
          candidateChain.tokens.size > 0 &&
          !tokenOverlap(chain.tokens, candidateChain.tokens)
            ? 110
            : 0;
        const score = distanceMeters + routePenalty;
        if (!best || score < best.score) {
          best = {
            ...candidate,
            coordinate: projectedCoordinate,
            distanceMeters,
            score,
          };
        }
      }
    }
  }
  return best;
}

function projectCoordinateOntoSegment(point, start, end) {
  const referenceLatitude = ((point[1] + start[1] + end[1]) / 3) * (Math.PI / 180);
  const longitudeScale = Math.cos(referenceLatitude);
  const startX = start[0] * longitudeScale;
  const endX = end[0] * longitudeScale;
  const pointX = point[0] * longitudeScale;
  const segmentX = endX - startX;
  const segmentY = end[1] - start[1];
  const squaredLength = segmentX * segmentX + segmentY * segmentY;
  const fraction =
    squaredLength === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((pointX - startX) * segmentX + (point[1] - start[1]) * segmentY) /
              squaredLength,
          ),
        );
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function midpoint(first, second) {
  return geodesicMidpoint(first, second).map((value) => Number(value.toFixed(7)));
}

export function buildAveragedMainlines(chains) {
  const sampledChains = chains.map(resampleChain);
  const chainById = new Map(sampledChains.map((chain) => [chain.id, chain]));
  const grid = new Map();
  for (const chain of sampledChains) {
    for (const sample of chain.samples) {
      const [cellX, cellY] = gridCell(sample.coordinate);
      const key = `${cellX},${cellY}`;
      const entries = grid.get(key) ?? [];
      entries.push(sample);
      grid.set(key, entries);
    }
  }

  const parts = [];
  const endpointsByTopologyKey = new Map();
  for (const chain of sampledChains) {
    let coordinates = [];
    let matchCount = 0;
    let matchedChainId = null;
    let runStartSampleIndex = null;
    let runEndSampleIndex = null;
    let runStartMatchSampleIndex = null;
    let runEndMatchSampleIndex = null;
    let priorRunEndTopologyKey = null;
    const finishPart = () => {
      if (
        coordinates.length >= 2 &&
        lineLengthMeters(coordinates) >= SAMPLE_SPACING_METERS
      ) {
        const pairedChain = chainById.get(matchedChainId);
        const startTopologyKeys = [
          priorRunEndTopologyKey,
          runStartSampleIndex === 0 && chain.startNodeId
            ? `osm-node:${chain.startNodeId}`
            : null,
          runStartMatchSampleIndex === 0 && pairedChain.startNodeId
            ? `osm-node:${pairedChain.startNodeId}`
            : null,
          runStartMatchSampleIndex === pairedChain.samples.length - 1 &&
          pairedChain.endNodeId
            ? `osm-node:${pairedChain.endNodeId}`
            : null,
        ].filter(Boolean);
        const endTopologyKey =
          runEndSampleIndex === chain.samples.length - 1 && chain.endNodeId
            ? `osm-node:${chain.endNodeId}`
            : `${chain.id}:sample-boundary:${runEndSampleIndex + 0.5}`;
        const endTopologyKeys = [
          endTopologyKey,
          runEndMatchSampleIndex === 0 && pairedChain.startNodeId
            ? `osm-node:${pairedChain.startNodeId}`
            : null,
          runEndMatchSampleIndex === pairedChain.samples.length - 1 &&
          pairedChain.endNodeId
            ? `osm-node:${pairedChain.endNodeId}`
            : null,
        ].filter(Boolean);
        const part = {
          coordinates,
          endNodeId:
            runEndSampleIndex === chain.samples.length - 1 ? chain.endNodeId : null,
          id: `osm-mainline-${parts.length + 1}`,
          role: 'mainline',
          sourceChainId: chain.id,
          startNodeId: runStartSampleIndex === 0 ? chain.startNodeId : null,
          startTopologyKeys,
          endTopologyKeys,
          pairedChainId: matchedChainId,
          sourceWayIds: [
            ...new Set([...chain.sourceWayIds, ...pairedChain.sourceWayIds]),
          ],
          tokens: [...new Set([...chain.tokens, ...pairedChain.tokens])],
        };
        const partIndex = parts.length;
        parts.push(part);
        for (const startTopologyKey of startTopologyKeys) {
          const endpoints = endpointsByTopologyKey.get(startTopologyKey) ?? [];
          endpoints.push(`${partIndex}:start`);
          endpointsByTopologyKey.set(startTopologyKey, endpoints);
        }
        for (const topologyKey of endTopologyKeys) {
          const endpoints = endpointsByTopologyKey.get(topologyKey) ?? [];
          endpoints.push(`${partIndex}:end`);
          endpointsByTopologyKey.set(topologyKey, endpoints);
        }
        priorRunEndTopologyKey = endTopologyKey;
      }
      coordinates = [];
      matchedChainId = null;
      runStartSampleIndex = null;
      runEndSampleIndex = null;
      runStartMatchSampleIndex = null;
      runEndMatchSampleIndex = null;
    };
    for (const [sampleIndex, sample] of chain.samples.entries()) {
      const match = nearestOpposingSample(sample, chain, grid, chainById);
      if (!match) {
        finishPart();
        priorRunEndTopologyKey = null;
        continue;
      }
      matchCount += 1;
      if (chain.id.localeCompare(match.chainId, undefined, { numeric: true }) > 0) {
        finishPart();
        priorRunEndTopologyKey = null;
        continue;
      }
      const coordinate = midpoint(sample.coordinate, match.coordinate);
      if (
        coordinates.length > 0 &&
        (matchedChainId !== match.chainId ||
          geodesicDistanceMeters(coordinates.at(-1), coordinate) >
            SAMPLE_SPACING_METERS * 2.8)
      ) {
        finishPart();
      }
      if (runStartSampleIndex === null) runStartSampleIndex = sampleIndex;
      if (runStartMatchSampleIndex === null) {
        runStartMatchSampleIndex = match.sampleIndex;
      }
      runEndSampleIndex = sampleIndex;
      runEndMatchSampleIndex = match.sampleIndex;
      matchedChainId = match.chainId;
      coordinates.push(coordinate);
    }
    finishPart();
    chain.pairCoverage = matchCount / chain.samples.length;
  }
  const endpointParents = new Map(
    parts.flatMap((_, partIndex) => [
      [`${partIndex}:start`, `${partIndex}:start`],
      [`${partIndex}:end`, `${partIndex}:end`],
    ]),
  );
  const findEndpoint = (endpointId) => {
    const parent = endpointParents.get(endpointId);
    if (parent === endpointId) return endpointId;
    const root = findEndpoint(parent);
    endpointParents.set(endpointId, root);
    return root;
  };
  for (const endpoints of endpointsByTopologyKey.values()) {
    const firstEndpoint = endpoints[0];
    for (const endpointId of endpoints.slice(1)) {
      endpointParents.set(findEndpoint(endpointId), findEndpoint(firstEndpoint));
    }
  }
  const endpointGroups = new Map();
  for (const endpointId of endpointParents.keys()) {
    const root = findEndpoint(endpointId);
    const endpoints = endpointGroups.get(root) ?? [];
    endpoints.push(endpointId);
    endpointGroups.set(root, endpoints);
  }
  for (const endpointIds of endpointGroups.values()) {
    if (endpointIds.length < 2) continue;
    const coordinates = endpointIds.map((endpointId) => {
      const [partIndexValue, endpoint] = endpointId.split(':');
      const part = parts[Number(partIndexValue)];
      return endpoint === 'start' ? part.coordinates[0] : part.coordinates.at(-1);
    });
    const center = [
      Number(
        (
          coordinates.reduce((total, coordinate) => total + coordinate[0], 0) /
          coordinates.length
        ).toFixed(7),
      ),
      Number(
        (
          coordinates.reduce((total, coordinate) => total + coordinate[1], 0) /
          coordinates.length
        ).toFixed(7),
      ),
    ];
    for (const endpointId of endpointIds) {
      const [partIndexValue, endpoint] = endpointId.split(':');
      const partIndex = Number(partIndexValue);
      const coordinates = parts[partIndex].coordinates;
      if (endpoint === 'start') coordinates[0] = center;
      else coordinates[coordinates.length - 1] = center;
    }
  }
  return {
    chains: sampledChains,
    parts,
    statistics: {
      averagedPartCount: parts.length,
      chainCount: sampledChains.length,
      pairedChainCount: sampledChains.filter((chain) => chain.pairCoverage > 0.5)
        .length,
      sampleCount: sampledChains.reduce(
        (total, chain) => total + chain.samples.length,
        0,
      ),
    },
  };
}

function connectorSegmentGraph(connectorWays) {
  const edges = [];
  const incident = new Map();
  const outgoing = new Map();
  for (const way of connectorWays) {
    for (let index = 1; index < way.nodeIds.length; index += 1) {
      const edgeIndex = edges.length;
      const edge = {
        fromId: way.nodeIds[index - 1],
        toId: way.nodeIds[index],
        wayId: way.id,
      };
      edges.push(edge);
      const outgoingEntries = outgoing.get(edge.fromId) ?? [];
      outgoingEntries.push(edgeIndex);
      outgoing.set(edge.fromId, outgoingEntries);
      for (const nodeId of [edge.fromId, edge.toId]) {
        const entries = incident.get(nodeId) ?? [];
        entries.push(edgeIndex);
        incident.set(nodeId, entries);
      }
    }
  }
  return { edges, incident, outgoing };
}

function traceLinkComponents(graph) {
  const unvisited = new Set(graph.edges.map((_, index) => index));
  const components = [];
  while (unvisited.size > 0) {
    const seed = unvisited.values().next().value;
    const edgeIndices = new Set();
    const nodeIds = new Set();
    const pending = [seed];
    while (pending.length > 0) {
      const edgeIndex = pending.pop();
      if (!unvisited.delete(edgeIndex)) continue;
      edgeIndices.add(edgeIndex);
      const edge = graph.edges[edgeIndex];
      for (const nodeId of [edge.fromId, edge.toId]) {
        nodeIds.add(nodeId);
        for (const neighborIndex of graph.incident.get(nodeId) ?? []) {
          if (unvisited.has(neighborIndex)) pending.push(neighborIndex);
        }
      }
    }
    components.push({ edgeIndices, nodeIds });
  }
  return components;
}

function attachmentForNode({ grid, mainlinePartIndices, nodeCoordinate }) {
  let best = null;
  const [cellX, cellY] = gridCell(nodeCoordinate);
  for (let x = cellX - 2; x <= cellX + 2; x += 1) {
    for (let y = cellY - 2; y <= cellY + 2; y += 1) {
      for (const segment of grid.get(`${x},${y}`) ?? []) {
        if (!mainlinePartIndices.has(segment.partIndex)) continue;
        const coordinate = projectCoordinateOntoSegment(
          nodeCoordinate,
          segment.start,
          segment.end,
        ).map((value) => Number(value.toFixed(7)));
        const distanceMeters = geodesicDistanceMeters(nodeCoordinate, coordinate);
        if (
          distanceMeters <= PAIR_SEARCH_METERS &&
          (!best || distanceMeters < best.distanceMeters)
        ) {
          best = {
            coordinate,
            distanceAlongMeters: geodesicDistanceMeters(segment.start, coordinate),
            distanceAlongPartMeters:
              segment.startDistanceMeters +
              geodesicDistanceMeters(segment.start, coordinate),
            distanceMeters,
            partIndex: segment.partIndex,
            segmentIndex: segment.segmentIndex,
          };
        }
      }
    }
  }
  return best;
}

function attachmentsForNodeByPart({ grid, mainlinePartIndices, nodeCoordinate }) {
  const bestByPart = new Map();
  const [cellX, cellY] = gridCell(nodeCoordinate);
  for (let x = cellX - 2; x <= cellX + 2; x += 1) {
    for (let y = cellY - 2; y <= cellY + 2; y += 1) {
      for (const segment of grid.get(`${x},${y}`) ?? []) {
        if (!mainlinePartIndices.has(segment.partIndex)) continue;
        const coordinate = projectCoordinateOntoSegment(
          nodeCoordinate,
          segment.start,
          segment.end,
        ).map((value) => Number(value.toFixed(7)));
        const distanceMeters = geodesicDistanceMeters(nodeCoordinate, coordinate);
        const existing = bestByPart.get(segment.partIndex);
        if (
          distanceMeters <= PAIR_SEARCH_METERS &&
          (!existing || distanceMeters < existing.distanceMeters)
        ) {
          bestByPart.set(segment.partIndex, {
            coordinate,
            distanceAlongMeters: geodesicDistanceMeters(segment.start, coordinate),
            distanceAlongPartMeters:
              segment.startDistanceMeters +
              geodesicDistanceMeters(segment.start, coordinate),
            distanceMeters,
            partIndex: segment.partIndex,
            segmentIndex: segment.segmentIndex,
          });
        }
      }
    }
  }
  return [...bestByPart.values()];
}

function buildPartSegmentGrid(parts) {
  const grid = new Map();
  for (const [partIndex, part] of parts.entries()) {
    let startDistanceMeters = 0;
    for (
      let segmentIndex = 0;
      segmentIndex < part.coordinates.length - 1;
      segmentIndex += 1
    ) {
      const start = part.coordinates[segmentIndex];
      const end = part.coordinates[segmentIndex + 1];
      const [startCellX, startCellY] = gridCell(start);
      const [endCellX, endCellY] = gridCell(end);
      for (
        let cellX = Math.min(startCellX, endCellX);
        cellX <= Math.max(startCellX, endCellX);
        cellX += 1
      ) {
        for (
          let cellY = Math.min(startCellY, endCellY);
          cellY <= Math.max(startCellY, endCellY);
          cellY += 1
        ) {
          const key = `${cellX},${cellY}`;
          const segments = grid.get(key) ?? [];
          segments.push({
            end,
            partIndex,
            segmentIndex,
            start,
            startDistanceMeters,
          });
          grid.set(key, segments);
        }
      }
      startDistanceMeters += geodesicDistanceMeters(start, end);
    }
  }
  return grid;
}

function directedPath(nodeId, previousByNode) {
  const nodeIds = [nodeId];
  const edgeIndices = [];
  let currentId = nodeId;
  while (previousByNode.has(currentId)) {
    const previous = previousByNode.get(currentId);
    edgeIndices.push(previous.edgeIndex);
    currentId = previous.nodeId;
    nodeIds.push(currentId);
  }
  return {
    edgeIndices: edgeIndices.reverse(),
    nodeIds: nodeIds.reverse(),
  };
}

function blockingTrafficSignal(node) {
  return (
    node?.tags?.highway === 'traffic_signals' &&
    node?.tags?.traffic_signals !== 'ramp_meter'
  );
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
      if (!this.before(value, this.values[parentIndex])) break;
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
        this.before(this.values[rightIndex], this.values[leftIndex])
          ? rightIndex
          : leftIndex;
      if (!this.before(this.values[childIndex], last)) break;
      this.values[index] = this.values[childIndex];
      index = childIndex;
    }
    this.values[index] = last;
    return result;
  }

  before(first, second) {
    return (
      first.distanceMeters < second.distanceMeters ||
      (first.distanceMeters === second.distanceMeters &&
        first.nodeId.localeCompare(second.nodeId) < 0)
    );
  }
}

function directedConnectorPaths(component, graph, attachments, osm) {
  const activeEdges = new Set(component.edgeIndices);
  const attachmentIndicesByNodeId = new Map();
  for (const [attachmentIndex, attachment] of attachments.entries()) {
    const indices = attachmentIndicesByNodeId.get(attachment.nodeId) ?? [];
    indices.push(attachmentIndex);
    attachmentIndicesByNodeId.set(attachment.nodeId, indices);
  }

  const paths = [];
  for (const sourceAttachment of attachments) {
    if (blockingTrafficSignal(osm.nodes.get(sourceAttachment.nodeId))) continue;
    const queue = new MinimumDistanceHeap();
    const distanceByNode = new Map([[sourceAttachment.nodeId, 0]]);
    const previousByNode = new Map();
    const bestByTarget = new Map();
    queue.push({ distanceMeters: 0, nodeId: sourceAttachment.nodeId });
    while (queue.size > 0) {
      const current = queue.pop();
      if (current.distanceMeters !== distanceByNode.get(current.nodeId)) continue;
      if (current.distanceMeters > MAX_DIRECT_CONNECTOR_METERS) continue;

      const targetIndices = attachmentIndicesByNodeId.get(current.nodeId) ?? [];
      if (current.nodeId !== sourceAttachment.nodeId && targetIndices.length > 0) {
        for (const targetIndex of targetIndices) {
          const targetAttachment = attachments[targetIndex];
          if (targetAttachment.partIndex === sourceAttachment.partIndex) continue;
          const existing = bestByTarget.get(targetIndex);
          if (existing && existing.distanceMeters <= current.distanceMeters) continue;
          bestByTarget.set(targetIndex, {
            ...directedPath(current.nodeId, previousByNode),
            distanceMeters: current.distanceMeters,
            firstAttachment: sourceAttachment,
            secondAttachment: targetAttachment,
          });
        }
        // A direct freeway connector ends at the first mainline it reaches.
        // Continuing through that mainline would manufacture a multi-interchange link.
        continue;
      }

      for (const edgeIndex of graph.outgoing.get(current.nodeId) ?? []) {
        if (!activeEdges.has(edgeIndex)) continue;
        const edge = graph.edges[edgeIndex];
        const nextId = edge.toId;
        if (blockingTrafficSignal(osm.nodes.get(nextId))) continue;
        const edgeLength = geodesicDistanceMeters(
          osm.nodes.get(current.nodeId).coordinate,
          osm.nodes.get(nextId).coordinate,
        );
        const nextDistance = current.distanceMeters + edgeLength;
        if (
          nextDistance > MAX_DIRECT_CONNECTOR_METERS ||
          nextDistance >= (distanceByNode.get(nextId) ?? Infinity)
        ) {
          continue;
        }
        distanceByNode.set(nextId, nextDistance);
        previousByNode.set(nextId, { edgeIndex, nodeId: current.nodeId });
        queue.push({ distanceMeters: nextDistance, nodeId: nextId });
      }
    }
    paths.push(...bestByTarget.values());
  }
  return paths;
}

function attachmentAtPartDistance(part, partIndex, distanceAlongPartMeters) {
  const targetDistance = Math.max(
    0,
    Math.min(lineLengthMeters(part.coordinates), distanceAlongPartMeters),
  );
  let traversedMeters = 0;
  for (
    let segmentIndex = 0;
    segmentIndex < part.coordinates.length - 1;
    segmentIndex += 1
  ) {
    const start = part.coordinates[segmentIndex];
    const end = part.coordinates[segmentIndex + 1];
    const segmentLengthMeters = geodesicDistanceMeters(start, end);
    if (
      traversedMeters + segmentLengthMeters >= targetDistance ||
      segmentIndex === part.coordinates.length - 2
    ) {
      const distanceAlongMeters = targetDistance - traversedMeters;
      const fraction =
        segmentLengthMeters === 0 ? 0 : distanceAlongMeters / segmentLengthMeters;
      return {
        coordinate: [
          Number((start[0] + (end[0] - start[0]) * fraction).toFixed(7)),
          Number((start[1] + (end[1] - start[1]) * fraction).toFixed(7)),
        ],
        distanceAlongMeters,
        distanceAlongPartMeters: targetDistance,
        distanceMeters: 0,
        partIndex,
        segmentIndex,
      };
    }
    traversedMeters += segmentLengthMeters;
  }
  throw new Error(`Highway part ${part.id} has no segment for a ramp attachment.`);
}

function averageReciprocalPathCoordinates(
  firstCoordinates,
  secondCoordinates,
  startCoordinate,
  endCoordinate,
) {
  const maximumLength = Math.max(
    lineLengthMeters(firstCoordinates),
    lineLengthMeters(secondCoordinates),
  );
  const sampleCount = Math.max(
    3,
    Math.min(800, Math.ceil(maximumLength / SAMPLE_SPACING_METERS) + 1),
  );
  const firstSamples = resampleCoordinatesToCount(firstCoordinates, sampleCount);
  const secondSamples = resampleCoordinatesToCount(secondCoordinates, sampleCount);
  const coordinates = firstSamples.map((coordinate, index) =>
    midpoint(coordinate, secondSamples[index]),
  );
  coordinates[0] = startCoordinate;
  coordinates[coordinates.length - 1] = endCoordinate;
  return coordinates.filter(
    (coordinate, index) =>
      index === 0 || geodesicDistanceMeters(coordinates[index - 1], coordinate) > 0.25,
  );
}

function mainlineGroupByPartIndex(parts) {
  const parent = new Map(
    parts
      .map((part, partIndex) => ({ part, partIndex }))
      .filter(({ part }) => part.role === 'mainline')
      .map(({ partIndex }) => [partIndex, partIndex]),
  );
  const find = (partIndex) => {
    const current = parent.get(partIndex);
    if (current === partIndex) return partIndex;
    const root = find(current);
    parent.set(partIndex, root);
    return root;
  };
  const union = (firstPartIndex, secondPartIndex) => {
    const firstRoot = find(firstPartIndex);
    const secondRoot = find(secondPartIndex);
    if (firstRoot === secondRoot) return;
    parent.set(Math.max(firstRoot, secondRoot), Math.min(firstRoot, secondRoot));
  };
  const firstPartIndexBySourceWayId = new Map();
  for (const [partIndex, part] of parts.entries()) {
    if (part.role !== 'mainline') continue;
    for (const sourceWayId of part.sourceWayIds) {
      const firstPartIndex = firstPartIndexBySourceWayId.get(sourceWayId);
      if (firstPartIndex === undefined) {
        firstPartIndexBySourceWayId.set(sourceWayId, partIndex);
      } else {
        union(firstPartIndex, partIndex);
      }
    }
  }
  return new Map([...parent.keys()].map((partIndex) => [partIndex, find(partIndex)]));
}

function reciprocalPathPairs(paths, groupByPartIndex) {
  const groups = new Map();
  for (const [pathIndex, path] of paths.entries()) {
    const firstPartIndex = path.firstAttachment.partIndex;
    const secondPartIndex = path.secondAttachment.partIndex;
    const firstGroup = groupByPartIndex.get(firstPartIndex) ?? firstPartIndex;
    const secondGroup = groupByPartIndex.get(secondPartIndex) ?? secondPartIndex;
    const sameGroup = firstGroup === secondGroup;
    const lowGroup = sameGroup
      ? Math.min(firstPartIndex, secondPartIndex)
      : Math.min(firstGroup, secondGroup);
    const highGroup = sameGroup
      ? Math.max(firstPartIndex, secondPartIndex)
      : Math.max(firstGroup, secondGroup);
    const key = `${lowGroup}:${highGroup}`;
    const group = groups.get(key) ?? { forward: [], reverse: [] };
    const forward = sameGroup ? firstPartIndex === lowGroup : firstGroup === lowGroup;
    (forward ? group.forward : group.reverse).push({
      path,
      pathIndex,
    });
    groups.set(key, group);
  }

  const used = new Set();
  const pairs = [];
  for (const group of groups.values()) {
    const candidates = [];
    for (const first of group.forward) {
      for (const second of group.reverse) {
        const firstEndpointGapMeters = geodesicDistanceMeters(
          first.path.firstAttachment.coordinate,
          second.path.secondAttachment.coordinate,
        );
        const secondEndpointGapMeters = geodesicDistanceMeters(
          first.path.secondAttachment.coordinate,
          second.path.firstAttachment.coordinate,
        );
        if (
          firstEndpointGapMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS ||
          secondEndpointGapMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS
        ) {
          continue;
        }
        candidates.push({
          first,
          score:
            firstEndpointGapMeters +
            secondEndpointGapMeters +
            (first.path.firstAttachment.partIndex ===
              second.path.secondAttachment.partIndex &&
            first.path.secondAttachment.partIndex ===
              second.path.firstAttachment.partIndex
              ? 0
              : MAX_RECIPROCAL_ENDPOINT_GAP_METERS * 4),
          second,
        });
      }
    }
    candidates.sort(
      (first, second) =>
        first.score - second.score ||
        first.first.pathIndex - second.first.pathIndex ||
        first.second.pathIndex - second.second.pathIndex,
    );
    for (const candidate of candidates) {
      if (used.has(candidate.first.pathIndex) || used.has(candidate.second.pathIndex)) {
        continue;
      }
      used.add(candidate.first.pathIndex);
      used.add(candidate.second.pathIndex);
      pairs.push([candidate.first.path, candidate.second.path]);
    }
  }
  return { pairs, unpairedPathCount: paths.length - used.size };
}

function attachmentForCoordinateOnPart(part, partIndex, coordinate) {
  let best = null;
  let startDistanceMeters = 0;
  for (
    let segmentIndex = 0;
    segmentIndex < part.coordinates.length - 1;
    segmentIndex += 1
  ) {
    const start = part.coordinates[segmentIndex];
    const end = part.coordinates[segmentIndex + 1];
    const projected = projectCoordinateOntoSegment(coordinate, start, end).map(
      (value) => Number(value.toFixed(7)),
    );
    const distanceMeters = geodesicDistanceMeters(coordinate, projected);
    const distanceAlongMeters = geodesicDistanceMeters(start, projected);
    if (!best || distanceMeters < best.distanceMeters) {
      best = {
        coordinate: projected,
        distanceAlongMeters,
        distanceAlongPartMeters: startDistanceMeters + distanceAlongMeters,
        distanceMeters,
        partIndex,
        segmentIndex,
      };
    }
    startDistanceMeters += geodesicDistanceMeters(start, end);
  }
  return best;
}

function averageReciprocalAttachment(first, second, parts) {
  if (first.partIndex === second.partIndex) {
    return attachmentAtPartDistance(
      parts[first.partIndex],
      first.partIndex,
      (first.distanceAlongPartMeters + second.distanceAlongPartMeters) / 2,
    );
  }
  const averageCoordinate = midpoint(first.coordinate, second.coordinate);
  return [first.partIndex, second.partIndex]
    .map((partIndex) =>
      attachmentForCoordinateOnPart(parts[partIndex], partIndex, averageCoordinate),
    )
    .sort(
      (firstCandidate, secondCandidate) =>
        firstCandidate.distanceMeters - secondCandidate.distanceMeters ||
        firstCandidate.partIndex - secondCandidate.partIndex,
    )[0];
}

function topologyCoordinate(part, coordinate, key) {
  const entries = part.topologyCoordinates ?? [];
  entries.push({ coordinate, key });
  part.topologyCoordinates = entries;
}

function insertPartProjections(parts, insertionsByPart) {
  for (const [partIndex, insertions] of insertionsByPart) {
    const part = parts[partIndex];
    const bySegment = new Map();
    for (const insertion of insertions) {
      const entries = bySegment.get(insertion.segmentIndex) ?? [];
      entries.push(insertion);
      bySegment.set(insertion.segmentIndex, entries);
    }
    const coordinates = [];
    for (let index = 0; index < part.coordinates.length - 1; index += 1) {
      coordinates.push(part.coordinates[index]);
      for (const insertion of (bySegment.get(index) ?? []).sort(
        (first, second) => first.distanceAlongMeters - second.distanceAlongMeters,
      )) {
        if (geodesicDistanceMeters(coordinates.at(-1), insertion.coordinate) > 0.25) {
          coordinates.push(insertion.coordinate);
        }
      }
    }
    coordinates.push(part.coordinates.at(-1));
    part.coordinates = coordinates;
  }
}

function indexPartsBySourceWay(parts) {
  const sourceWayIdToPartIndices = new Map();
  for (const [partIndex, part] of parts.entries()) {
    for (const wayId of part.sourceWayIds) {
      const indices = sourceWayIdToPartIndices.get(wayId) ?? [];
      indices.push(partIndex);
      sourceWayIdToPartIndices.set(wayId, indices);
    }
  }
  return sourceWayIdToPartIndices;
}

function exactEdgeKey(firstId, secondId) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

export function buildOsmSourceTopologyGraph(osm, averagedParts) {
  const parentByNodeId = new Map();
  const coordinateByLocalNodeId = new Map();
  const localNodeIdsByPart = [];
  const localNodeIdsByTopologyKey = new Map();

  const find = (nodeId) => {
    const parent = parentByNodeId.get(nodeId);
    if (parent === nodeId) return nodeId;
    const root = find(parent);
    parentByNodeId.set(nodeId, root);
    return root;
  };
  const union = (firstId, secondId) => {
    const firstRoot = find(firstId);
    const secondRoot = find(secondId);
    if (firstRoot === secondRoot) return;
    parentByNodeId.set(
      firstRoot < secondRoot ? secondRoot : firstRoot,
      firstRoot < secondRoot ? firstRoot : secondRoot,
    );
  };
  const registerTopologyKey = (topologyKey, localNodeId) => {
    const existing = localNodeIdsByTopologyKey.get(topologyKey);
    if (existing) union(existing, localNodeId);
    else localNodeIdsByTopologyKey.set(topologyKey, localNodeId);
  };

  for (const [partIndex, part] of averagedParts.entries()) {
    const localNodeIds = part.coordinates.map((coordinate, coordinateIndex) => {
      const nodeId = `part:${partIndex}:vertex:${coordinateIndex}`;
      parentByNodeId.set(nodeId, nodeId);
      coordinateByLocalNodeId.set(nodeId, coordinate);
      return nodeId;
    });
    localNodeIdsByPart.push(localNodeIds);
    for (const key of part.startTopologyKeys ?? []) {
      registerTopologyKey(key, localNodeIds[0]);
    }
    for (const key of part.endTopologyKeys ?? []) {
      registerTopologyKey(key, localNodeIds.at(-1));
    }
    for (const topology of part.topologyCoordinates ?? []) {
      let nearestIndex = 0;
      let nearestDistanceMeters = Infinity;
      for (const [coordinateIndex, coordinate] of part.coordinates.entries()) {
        const distanceMeters = geodesicDistanceMeters(topology.coordinate, coordinate);
        if (distanceMeters < nearestDistanceMeters) {
          nearestDistanceMeters = distanceMeters;
          nearestIndex = coordinateIndex;
        }
      }
      if (nearestDistanceMeters > 1) {
        throw new Error(
          `Topology key ${topology.key} is ${nearestDistanceMeters.toFixed(
            2,
          )} m from highway part ${part.id}.`,
        );
      }
      registerTopologyKey(topology.key, localNodeIds[nearestIndex]);
    }
  }

  const coordinateByNodeId = new Map();
  for (const [localNodeId, coordinate] of coordinateByLocalNodeId) {
    const root = find(localNodeId);
    if (!coordinateByNodeId.has(root)) coordinateByNodeId.set(root, coordinate);
  }
  const graphParts = averagedParts.map((part) => ({
    id: part.id,
    role: part.role,
    sourceWayIds: part.sourceWayIds,
    tokens: part.tokens,
  }));
  const edges = [];
  const edgeIndexByKey = new Map();
  const addEdge = (fromId, toId, partIndex) => {
    if (fromId === toId) return;
    const key = exactEdgeKey(fromId, toId);
    const existingIndex = edgeIndexByKey.get(key);
    if (existingIndex !== undefined) {
      edges[existingIndex].partIndices.add(partIndex);
      return;
    }
    edgeIndexByKey.set(key, edges.length);
    edges.push({
      fromId,
      partIndices: new Set([partIndex]),
      toId,
    });
  };
  for (const [partIndex, localNodeIds] of localNodeIdsByPart.entries()) {
    for (let index = 1; index < localNodeIds.length; index += 1) {
      const fromId = find(localNodeIds[index - 1]);
      const toId = find(localNodeIds[index]);
      addEdge(fromId, toId, partIndex);
    }
  }

  // The averaged display geometry intentionally omits short stretches where
  // the two carriageways cannot be paired confidently. Preserve continuous
  // mainline topology across those gaps by mapping the original mainline
  // vertices onto their averaged centerline vertices wherever available.
  // Ramp edges are never restored here: only the reciprocal averaged ramp
  // parts above are eligible for the route graph.
  if (osm) {
    const prepared = prepareWays(osm);
    const sourceWayIdToPartIndices = indexPartsBySourceWay(averagedParts);
    const partSegmentGrid = buildPartSegmentGrid(averagedParts);
    const mappedMainlineNodeByOsmNodeId = new Map();
    for (const way of prepared.mainlines) {
      const eligiblePartIndices = new Set(sourceWayIdToPartIndices.get(way.id) ?? []);
      const graphNodes = way.nodeIds.map((nodeId) => {
        const cached = mappedMainlineNodeByOsmNodeId.get(nodeId);
        if (cached) return cached;
        const sourceCoordinate = osm.nodes.get(nodeId).coordinate;
        const attachment =
          eligiblePartIndices.size > 0
            ? attachmentForNode({
                grid: partSegmentGrid,
                mainlinePartIndices: eligiblePartIndices,
                nodeCoordinate: sourceCoordinate,
              })
            : null;
        const node = attachment
          ? (() => {
              const part = averagedParts[attachment.partIndex];
              const segmentStart = part.coordinates[attachment.segmentIndex];
              const segmentEnd = part.coordinates[attachment.segmentIndex + 1];
              const vertexIndex =
                geodesicDistanceMeters(attachment.coordinate, segmentStart) <=
                geodesicDistanceMeters(attachment.coordinate, segmentEnd)
                  ? attachment.segmentIndex
                  : attachment.segmentIndex + 1;
              const id = find(localNodeIdsByPart[attachment.partIndex][vertexIndex]);
              return { coordinate: coordinateByNodeId.get(id), id };
            })()
          : {
              coordinate: sourceCoordinate,
              id: `osm-mainline:${nodeId}`,
            };
        mappedMainlineNodeByOsmNodeId.set(nodeId, node);
        coordinateByNodeId.set(node.id, node.coordinate);
        return node;
      });
      const partIndex = graphParts.length;
      graphParts.push({
        id: `osm-mainline-continuity-${way.id}`,
        role: 'mainline',
        sourceWayIds: [way.id],
        tokens: [...way.tokens],
      });
      for (let index = 1; index < graphNodes.length; index += 1) {
        addEdge(graphNodes[index - 1].id, graphNodes[index].id, partIndex);
      }
    }
  }
  return {
    coordinateByNodeId,
    edges,
    parts: graphParts,
    statistics: {
      explicitTopologyKeyCount: localNodeIdsByTopologyKey.size,
      signalRejectedConnectorCount: 0,
      sourceConnectorPartCount: averagedParts.filter(
        (part) => part.role === 'connector',
      ).length,
      sourceMainlinePartCount: graphParts.filter((part) => part.role === 'mainline')
        .length,
    },
  };
}

export function buildPairedOsmSourceTopologyGraph(osm, averagedParts) {
  if (!osm) throw new Error('OSM mainline topology is required.');
  const prepared = prepareWays(osm);
  const sourceWayIdToPartIndices = indexPartsBySourceWay(averagedParts);
  const partSegmentGrid = buildPartSegmentGrid(averagedParts);
  const coordinateByNodeId = new Map();
  const graphParts = [];
  const edges = [];
  const edgeIndexByKey = new Map();
  const addEdge = (fromId, toId, partIndex) => {
    if (fromId === toId) return;
    const key = exactEdgeKey(fromId, toId);
    const existingIndex = edgeIndexByKey.get(key);
    if (existingIndex !== undefined) {
      edges[existingIndex].partIndices.add(partIndex);
      return;
    }
    edgeIndexByKey.set(key, edges.length);
    edges.push({
      fromId,
      partIndices: new Set([partIndex]),
      toId,
    });
  };

  const mappedMainlineNodeByOsmNodeId = new Map();
  const mappedCenterNodesByPartIndex = new Map();
  const mappedCenterNode = (partIndex, vertexIndex) => {
    const id = `center:${partIndex}:${vertexIndex}`;
    const entries = mappedCenterNodesByPartIndex.get(partIndex) ?? new Map();
    entries.set(vertexIndex, id);
    mappedCenterNodesByPartIndex.set(partIndex, entries);
    const node = {
      coordinate: averagedParts[partIndex].coordinates[vertexIndex],
      id,
      partIndex,
      vertexIndex,
    };
    coordinateByNodeId.set(node.id, node.coordinate);
    return node;
  };
  for (const way of prepared.mainlines) {
    const eligiblePartIndices = new Set(sourceWayIdToPartIndices.get(way.id) ?? []);
    const graphNodes = way.nodeIds.map((nodeId) => {
      const cached = mappedMainlineNodeByOsmNodeId.get(nodeId);
      if (cached) return cached;
      const sourceCoordinate = osm.nodes.get(nodeId).coordinate;
      const attachment =
        eligiblePartIndices.size > 0
          ? attachmentForNode({
              grid: partSegmentGrid,
              mainlinePartIndices: eligiblePartIndices,
              nodeCoordinate: sourceCoordinate,
            })
          : null;
      const node = attachment
        ? (() => {
            const part = averagedParts[attachment.partIndex];
            const segmentStart = part.coordinates[attachment.segmentIndex];
            const segmentEnd = part.coordinates[attachment.segmentIndex + 1];
            const vertexIndex =
              geodesicDistanceMeters(attachment.coordinate, segmentStart) <=
              geodesicDistanceMeters(attachment.coordinate, segmentEnd)
                ? attachment.segmentIndex
                : attachment.segmentIndex + 1;
            return mappedCenterNode(attachment.partIndex, vertexIndex);
          })()
        : {
            coordinate: sourceCoordinate,
            id: `osm-mainline:${nodeId}`,
          };
      mappedMainlineNodeByOsmNodeId.set(nodeId, node);
      coordinateByNodeId.set(node.id, node.coordinate);
      return node;
    });
    const partIndex = graphParts.length;
    graphParts.push({
      id: `osm-source-mainline-${way.id}`,
      role: 'mainline',
      sourceWayIds: [way.id],
      tokens: [...way.tokens],
    });
    for (let index = 1; index < graphNodes.length; index += 1) {
      const fromNode = graphNodes[index - 1];
      const toNode = graphNodes[index];
      if (fromNode.partIndex !== undefined && fromNode.partIndex === toNode.partIndex) {
        const direction = Math.sign(toNode.vertexIndex - fromNode.vertexIndex);
        let currentNode = fromNode;
        for (
          let vertexIndex = fromNode.vertexIndex + direction;
          direction !== 0 &&
          (direction > 0
            ? vertexIndex <= toNode.vertexIndex
            : vertexIndex >= toNode.vertexIndex);
          vertexIndex += direction
        ) {
          const nextNode = mappedCenterNode(fromNode.partIndex, vertexIndex);
          addEdge(currentNode.id, nextNode.id, partIndex);
          currentNode = nextNode;
        }
      } else {
        addEdge(fromNode.id, toNode.id, partIndex);
      }
    }
  }

  const attachmentPartIndexByMainlinePartIndex = new Map();
  const attachmentPartIndex = (mainlinePartIndex) => {
    const existing = attachmentPartIndexByMainlinePartIndex.get(mainlinePartIndex);
    if (existing !== undefined) return existing;
    const partIndex = graphParts.length;
    const mainlinePart = averagedParts[mainlinePartIndex];
    graphParts.push({
      id: `osm-centerline-attachment-${mainlinePartIndex}`,
      role: 'mainline',
      sourceWayIds: mainlinePart.sourceWayIds,
      tokens: mainlinePart.tokens,
    });
    attachmentPartIndexByMainlinePartIndex.set(mainlinePartIndex, partIndex);
    return partIndex;
  };
  const exactMappedMainlineNode = (mainlinePartIndex, coordinate) => {
    const candidates = mappedCenterNodesByPartIndex.get(mainlinePartIndex);
    if (!candidates || candidates.size === 0) {
      throw new Error(
        `Paired ramp has no mapped mainline nodes on part ${mainlinePartIndex}.`,
      );
    }
    let best = null;
    for (const [vertexIndex, nodeId] of candidates) {
      const candidateCoordinate =
        averagedParts[mainlinePartIndex].coordinates[vertexIndex];
      const distanceMeters = geodesicDistanceMeters(coordinate, candidateCoordinate);
      if (!best || distanceMeters < best.distanceMeters) {
        best = { coordinate: candidateCoordinate, distanceMeters, nodeId, vertexIndex };
      }
    }
    const mainlinePart = averagedParts[mainlinePartIndex];
    let targetVertexIndex = 0;
    let targetDistanceMeters = Infinity;
    for (const [
      vertexIndex,
      candidateCoordinate,
    ] of mainlinePart.coordinates.entries()) {
      const distanceMeters = geodesicDistanceMeters(coordinate, candidateCoordinate);
      if (distanceMeters < targetDistanceMeters) {
        targetDistanceMeters = distanceMeters;
        targetVertexIndex = vertexIndex;
      }
    }
    if (targetDistanceMeters > 1) {
      throw new Error(
        `Paired ramp endpoint is not a vertex of mainline part ${mainlinePartIndex}.`,
      );
    }
    const direction = Math.sign(targetVertexIndex - best.vertexIndex);
    let currentNode = best;
    const partIndex = attachmentPartIndex(mainlinePartIndex);
    for (
      let vertexIndex = best.vertexIndex + direction;
      direction !== 0 &&
      (direction > 0
        ? vertexIndex <= targetVertexIndex
        : vertexIndex >= targetVertexIndex);
      vertexIndex += direction
    ) {
      const nextNode = mappedCenterNode(mainlinePartIndex, vertexIndex);
      addEdge(currentNode.nodeId, nextNode.id, partIndex);
      currentNode = { ...nextNode, nodeId: nextNode.id };
    }
    return direction === 0
      ? {
          coordinate: best.coordinate,
          id: best.nodeId,
        }
      : {
          coordinate: currentNode.coordinate,
          id: currentNode.nodeId,
        };
  };

  const pairedConnectors = averagedParts.filter((part) => part.role === 'connector');
  for (const [connectorIndex, connector] of pairedConnectors.entries()) {
    const startNode = exactMappedMainlineNode(
      connector.startMainlinePartIndex,
      connector.coordinates[0],
    );
    const endNode = exactMappedMainlineNode(
      connector.endMainlinePartIndex,
      connector.coordinates.at(-1),
    );
    const graphNodes = connector.coordinates.map((coordinate, coordinateIndex) => {
      if (coordinateIndex === 0) return startNode;
      if (coordinateIndex === connector.coordinates.length - 1) return endNode;
      const node = {
        coordinate,
        id: `paired-ramp:${connectorIndex}:vertex:${coordinateIndex}`,
      };
      coordinateByNodeId.set(node.id, node.coordinate);
      return node;
    });
    const partIndex = graphParts.length;
    graphParts.push({
      id: connector.id,
      role: 'connector',
      sourceWayIds: connector.sourceWayIds,
      tokens: connector.tokens,
    });
    for (let index = 1; index < graphNodes.length; index += 1) {
      addEdge(graphNodes[index - 1].id, graphNodes[index].id, partIndex);
    }
  }

  return {
    coordinateByNodeId,
    edges,
    parts: graphParts,
    statistics: {
      explicitTopologyKeyCount: pairedConnectors.length * 2,
      signalRejectedConnectorCount: 0,
      sourceConnectorPartCount: pairedConnectors.length,
      sourceMainlinePartCount: prepared.mainlines.length,
    },
  };
}

export function connectMainlinePartsAtSourceNodes(osm, mainlineWays, parts) {
  const sourceWayIdToPartIndices = indexPartsBySourceWay(parts);
  const partSegmentGrid = buildPartSegmentGrid(parts);
  const wayIdsByNodeId = new Map();
  for (const way of mainlineWays) {
    if (!sourceWayIdToPartIndices.has(way.id)) continue;
    for (const nodeId of way.nodeIds) {
      const wayIds = wayIdsByNodeId.get(nodeId) ?? new Set();
      wayIds.add(way.id);
      wayIdsByNodeId.set(nodeId, wayIds);
    }
  }
  const insertionsByPart = new Map();
  let junctionCount = 0;
  for (const [nodeId, wayIds] of wayIdsByNodeId) {
    if (wayIds.size < 2) continue;
    const partIndices = new Set(
      [...wayIds].flatMap((wayId) => sourceWayIdToPartIndices.get(wayId) ?? []),
    );
    if (partIndices.size < 2) continue;
    const attachments = attachmentsForNodeByPart({
      grid: partSegmentGrid,
      mainlinePartIndices: partIndices,
      nodeCoordinate: osm.nodes.get(nodeId).coordinate,
    });
    if (attachments.length < 2) continue;
    const commonCoordinate = [
      Number(
        (
          attachments.reduce(
            (total, attachment) => total + attachment.coordinate[0],
            0,
          ) / attachments.length
        ).toFixed(7),
      ),
      Number(
        (
          attachments.reduce(
            (total, attachment) => total + attachment.coordinate[1],
            0,
          ) / attachments.length
        ).toFixed(7),
      ),
    ];
    const topologyKey = `osm-mainline-junction:${nodeId}`;
    for (const attachment of attachments) {
      const entries = insertionsByPart.get(attachment.partIndex) ?? [];
      entries.push({ ...attachment, coordinate: commonCoordinate });
      insertionsByPart.set(attachment.partIndex, entries);
      topologyCoordinate(parts[attachment.partIndex], commonCoordinate, topologyKey);
    }
    junctionCount += 1;
  }
  insertPartProjections(parts, insertionsByPart);
  return { junctionCount };
}

export function buildRampConnectors(osm, mainlineWays, parts, connectorWays) {
  const partSegmentGrid = buildPartSegmentGrid(parts);
  const sourceWayIdToPartIndices = indexPartsBySourceWay(parts);
  const mainlinePartIndicesByNode = new Map();
  for (const way of mainlineWays) {
    const partIndices = sourceWayIdToPartIndices.get(way.id) ?? [];
    if (partIndices.length === 0) continue;
    for (const nodeId of way.nodeIds) {
      const indices = mainlinePartIndicesByNode.get(nodeId) ?? new Set();
      for (const partIndex of partIndices) indices.add(partIndex);
      mainlinePartIndicesByNode.set(nodeId, indices);
    }
  }

  const graph = connectorSegmentGraph(connectorWays);
  const components = traceLinkComponents(graph);
  const connectors = [];
  const insertionsByPart = new Map();
  const allDirectedPaths = [];
  for (const component of components) {
    const attachments = [...component.nodeIds].flatMap((nodeId) => {
      const partIndices = mainlinePartIndicesByNode.get(nodeId);
      if (!partIndices) return [];
      const attachment = attachmentForNode({
        grid: partSegmentGrid,
        mainlinePartIndices: partIndices,
        nodeCoordinate: osm.nodes.get(nodeId).coordinate,
      });
      return attachment ? [{ ...attachment, nodeId }] : [];
    });
    if (attachments.length < 2) continue;
    const directedPaths = directedConnectorPaths(
      component,
      graph,
      attachments,
      osm,
    ).flatMap((path) => {
      const coordinates = path.nodeIds.map(
        (nodeId) => osm.nodes.get(nodeId).coordinate,
      );
      coordinates[0] = path.firstAttachment.coordinate;
      coordinates[coordinates.length - 1] = path.secondAttachment.coordinate;
      return lineLengthMeters(coordinates) < 5
        ? []
        : [
            {
              ...path,
              coordinates,
              sourceWayIds: [
                ...new Set(
                  path.edgeIndices.map((edgeIndex) => graph.edges[edgeIndex].wayId),
                ),
              ],
            },
          ];
    });
    allDirectedPaths.push(...directedPaths);
  }
  const paired = reciprocalPathPairs(allDirectedPaths, mainlineGroupByPartIndex(parts));
  for (const [forward, reverse] of paired.pairs) {
    const startAttachment = averageReciprocalAttachment(
      forward.firstAttachment,
      reverse.secondAttachment,
      parts,
    );
    const endAttachment = averageReciprocalAttachment(
      forward.secondAttachment,
      reverse.firstAttachment,
      parts,
    );
    const startPartIndex = startAttachment.partIndex;
    const endPartIndex = endAttachment.partIndex;
    const coordinates = averageReciprocalPathCoordinates(
      forward.coordinates,
      [...reverse.coordinates].reverse(),
      startAttachment.coordinate,
      endAttachment.coordinate,
    );
    if (lineLengthMeters(coordinates) < 5) continue;
    const connectorIndex = connectors.length + 1;
    const startTopologyKey = `osm-ramp-pair:${connectorIndex}:start`;
    const endTopologyKey = `osm-ramp-pair:${connectorIndex}:end`;
    const connector = {
      coordinates,
      endMainlinePartIndex: endPartIndex,
      endTopologyKeys: [endTopologyKey],
      id: `osm-connector-${connectorIndex}`,
      pairedDirectionCount: 2,
      role: 'connector',
      sourceNodeIds: [...new Set([...forward.nodeIds, ...reverse.nodeIds])],
      sourceWayIds: [...new Set([...forward.sourceWayIds, ...reverse.sourceWayIds])],
      startMainlinePartIndex: startPartIndex,
      startTopologyKeys: [startTopologyKey],
      tokens: [
        ...new Set([...parts[startPartIndex].tokens, ...parts[endPartIndex].tokens]),
      ],
    };
    connectors.push(connector);
    for (const [attachment, topologyKey] of [
      [startAttachment, startTopologyKey],
      [endAttachment, endTopologyKey],
    ]) {
      const entries = insertionsByPart.get(attachment.partIndex) ?? [];
      entries.push(attachment);
      insertionsByPart.set(attachment.partIndex, entries);
      topologyCoordinate(
        parts[attachment.partIndex],
        attachment.coordinate,
        topologyKey,
      );
    }
  }
  insertPartProjections(parts, insertionsByPart);
  return {
    connectors,
    statistics: {
      connectorComponentCount: components.length,
      directedConnectorPathCount: allDirectedPaths.length,
      directConnectorCount: connectors.length,
      unpairedConnectorPathCount: paired.unpairedPathCount,
    },
  };
}

export function buildOsmHighwayCenterlines(osm) {
  const prepared = prepareWays(osm);
  const chains = traceMotorwayChains(prepared.mainlines);
  const averaged = buildAveragedMainlines(chains);
  const mainlineTopology = connectMainlinePartsAtSourceNodes(
    osm,
    prepared.mainlines,
    averaged.parts,
  );
  const ramps = buildRampConnectors(
    osm,
    prepared.mainlines,
    averaged.parts,
    prepared.connectors,
  );
  return {
    ...averaged,
    parts: [...averaged.parts, ...ramps.connectors],
    statistics: {
      ...averaged.statistics,
      mainlineJunctionCount: mainlineTopology.junctionCount,
      ...ramps.statistics,
    },
    connectorWays: prepared.connectors,
    mainlineWays: prepared.mainlines,
  };
}
