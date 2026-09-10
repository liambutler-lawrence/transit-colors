/* eslint-disable max-lines -- Parsing, carriageway pairing, and explicit-node topology are one audited pipeline. */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { orderedCarriagewayMidpoints } from './highway-ordered-midpoint.mjs';
import {
  buildMainlineEndingIndex,
  trimRampOnlyMainlineTails,
} from './highway-mainline-endings.mjs';

import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const SAMPLE_SPACING_METERS = 50;
const PAIR_SEARCH_METERS = 160;
const MAX_PAIRED_CONTINUATION_WIDTH_METERS = 2_000;
const MAX_PAIRED_CONTINUATION_LENGTH_METERS = 25_000;
const GRID_SIZE_DEGREES = 0.002;
const MAX_DIRECT_CONNECTOR_METERS = 25_000;
const MAX_RECIPROCAL_ENDPOINT_GAP_METERS = 2_500;
const MAX_RAMP_CORRESPONDENCE_SAMPLES = 240;
const RAMP_CORRESPONDENCE_SPACING_METERS = 25;
const MIN_PAIRED_TANGENT_ALIGNMENT = 0.62;

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

function gridCell([longitude, latitude]) {
  return [
    Math.floor(longitude / GRID_SIZE_DEGREES),
    Math.floor(latitude / GRID_SIZE_DEGREES),
  ];
}

function nearestOpposingSample(
  sample,
  chain,
  grid,
  chainById,
  maximumDistanceMeters = PAIR_SEARCH_METERS,
) {
  const [cellX, cellY] = gridCell(sample.coordinate);
  const cellRadius =
    maximumDistanceMeters === PAIR_SEARCH_METERS
      ? 2
      : Math.ceil(
          maximumDistanceMeters /
            (110_000 *
              GRID_SIZE_DEGREES *
              Math.cos((sample.coordinate[1] * Math.PI) / 180)),
        ) + 1;
  const nearestByChain = new Map();
  const visitedSegments = new Set();
  for (let x = cellX - cellRadius; x <= cellX + cellRadius; x += 1) {
    for (let y = cellY - cellRadius; y <= cellY + cellRadius; y += 1) {
      for (const candidate of grid.get(`${x},${y}`) ?? []) {
        if (candidate.chainId === chain.id) continue;
        if (
          dot(sample.direction, candidate.direction) > -MIN_PAIRED_TANGENT_ALIGNMENT
        ) {
          continue;
        }
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
        if (distanceMeters > maximumDistanceMeters) continue;
        const routePenalty =
          chain.tokens.size > 0 &&
          candidateChain.tokens.size > 0 &&
          !tokenOverlap(chain.tokens, candidateChain.tokens)
            ? 110
            : 0;
        const score = distanceMeters + routePenalty;
        const nearest = nearestByChain.get(candidate.chainId);
        if (!nearest || score < nearest.score) {
          nearestByChain.set(candidate.chainId, {
            ...candidate,
            coordinate: projectedCoordinate,
            distanceMeters,
            score,
          });
        }
      }
    }
  }
  let best = null;
  for (const match of nearestByChain.values()) {
    const opposingChain = chainById.get(match.chainId);
    const coordinates = opposingChain.coordinates;
    const closed =
      opposingChain.startNodeId != null &&
      opposingChain.startNodeId === opposingChain.endNodeId;
    const fraction = coordinateProjectionFraction(
      sample.coordinate,
      coordinates[match.sourceSegmentIndex],
      coordinates[match.sourceSegmentIndex + 1],
    );
    // A terminal point cannot act as an opposing carriageway after that
    // carriageway ends. Reject the whole chain's nearest match, so a farther
    // interior vertex cannot replace the same invalid endpoint. Interior bends
    // may still use their closest vertex where adjacent segments meet.
    if (
      !closed &&
      ((match.sourceSegmentIndex === 0 && fraction < -1e-9) ||
        (match.sourceSegmentIndex === coordinates.length - 2 && fraction > 1 + 1e-9))
    ) {
      continue;
    }
    if (!best || match.score < best.score) {
      best = {
        ...match,
        sourcePosition: match.sourceSegmentIndex + Math.max(0, Math.min(1, fraction)),
      };
    }
  }
  return best;
}

function coordinateProjectionFraction(point, start, end) {
  const referenceLatitude = ((point[1] + start[1] + end[1]) / 3) * (Math.PI / 180);
  const longitudeScale = Math.cos(referenceLatitude);
  const startX = start[0] * longitudeScale;
  const endX = end[0] * longitudeScale;
  const pointX = point[0] * longitudeScale;
  const segmentX = endX - startX;
  const segmentY = end[1] - start[1];
  const squaredLength = segmentX * segmentX + segmentY * segmentY;
  return squaredLength === 0
    ? 0
    : ((pointX - startX) * segmentX + (point[1] - start[1]) * segmentY) / squaredLength;
}

function projectCoordinateOntoSegment(point, start, end) {
  const fraction = Math.max(
    0,
    Math.min(1, coordinateProjectionFraction(point, start, end)),
  );
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function midpoint(first, second) {
  return geodesicMidpoint(first, second).map((value) => Number(value.toFixed(7)));
}

function sourceSection(chain, first, last) {
  return [
    first.coordinate,
    ...chain.coordinates.slice(
      first.sourceSegmentIndex + 1,
      last.sourceSegmentIndex + 1,
    ),
    last.coordinate,
  ].filter(
    (point, index, points) =>
      index === 0 || geodesicDistanceMeters(points[index - 1], point) > 0.01,
  );
}

function orderedGapContinuation(chain, before, after, start, end, grid, chainById) {
  const opposite = chainById.get(before.chainId);
  const first = sourceSection(chain, chain.samples[start], chain.samples[end]);
  const second = sourceSection(opposite, after, before);
  const firstLength = lineLengthMeters(first);
  const secondLength = lineLengthMeters(second);
  if (Math.max(firstLength, secondLength) > MAX_PAIRED_CONTINUATION_LENGTH_METERS)
    return null;
  // Two confirmed narrow endpoints bound the entire excursion. Allow the
  // separation supported by that source span instead of imposing a 2 km median.
  const maximumWidth = Math.max(
    MAX_PAIRED_CONTINUATION_WIDTH_METERS,
    Math.min(firstLength, secondLength) / 2 + 2 * PAIR_SEARCH_METERS,
  );
  for (const [road, other, coordinates] of [
    [chain, opposite, first],
    [opposite, chain, second],
  ]) {
    for (const sample of resampleCoordinates(coordinates)) {
      if (
        nearestOpposingSample(sample, road, grid, chainById, maximumWidth)?.chainId !==
        other.id
      )
        return null;
    }
  }
  const paired = orderedCarriagewayMidpoints(first, second.toReversed(), maximumWidth);
  return (
    paired && { start, end, chainId: opposite.id, coordinates: paired.coordinates }
  );
}

function continueBoundedCarriagewayPairs(chain, matches, grid, chainById, orderedGaps) {
  const continuations = [];
  for (let index = 1; index < matches.length - 1; index += 1) {
    if (matches[index] || !matches[index - 1]) continue;
    const start = index;
    while (index < matches.length && !matches[index]) index += 1;
    const before = matches[start - 1];
    const after = matches[index];
    // Only continue an already established pair, confirmed on both sides of
    // the gap. Never extend an unmatched terminal or switch opposing roads.
    if (
      !after ||
      before.chainId !== after.chainId ||
      before.sourcePosition <= after.sourcePosition ||
      chain.samples[index].distanceMeters - chain.samples[start - 1].distanceMeters >
        MAX_PAIRED_CONTINUATION_LENGTH_METERS
    ) {
      continue;
    }
    const continuation = [];
    let prior = before;
    let priorMidpoint = midpoint(
      chain.samples[start - 1].coordinate,
      before.coordinate,
    );
    for (let gapIndex = start; gapIndex <= index; gapIndex += 1) {
      const sample = chain.samples[gapIndex];
      const match =
        gapIndex === index
          ? after
          : nearestOpposingSample(
              sample,
              chain,
              grid,
              chainById,
              MAX_PAIRED_CONTINUATION_WIDTH_METERS,
            );
      if (
        !match ||
        match.chainId !== before.chainId ||
        match.sourcePosition > prior.sourcePosition + 1e-9 ||
        match.sourcePosition < after.sourcePosition - 1e-9
      ) {
        break;
      }
      if (
        gapIndex !== index &&
        nearestOpposingSample(
          match,
          chainById.get(match.chainId),
          grid,
          chainById,
          MAX_PAIRED_CONTINUATION_WIDTH_METERS,
        )?.chainId !== chain.id
      ) {
        break;
      }
      const coordinate = midpoint(sample.coordinate, match.coordinate);
      if (
        geodesicDistanceMeters(priorMidpoint, coordinate) >
        SAMPLE_SPACING_METERS * 2.8
      ) {
        break;
      }
      continuation.push(match);
      prior = match;
      priorMidpoint = coordinate;
    }
    // Every sample must have a valid closest opposing tangent, in reverse
    // order along the same continuous source chain. A closer competing road
    // on either side invalidates the continuation; never force the partner through
    // a junction with a different nearest opposing carriageway.
    if (continuation.length !== index - start + 1) {
      if (chain.id.localeCompare(before.chainId, undefined, { numeric: true }) < 0) {
        const ordered = orderedGapContinuation(
          chain,
          before,
          after,
          start - 1,
          index,
          grid,
          chainById,
        );
        if (ordered) orderedGaps.push(ordered);
      }
      continue;
    }
    for (let offset = 0; offset < index - start; offset += 1) {
      matches[start + offset] = continuation[offset];
    }
    continuations.push({ start: start - 1, end: index, chainId: before.chainId });
  }
  return continuations;
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
  const pendingOrderedContinuations = [];
  let widePairContinuationCount = 0;
  let widePairSampleCount = 0;
  const endpointsByTopologyKey = new Map();
  for (const chain of sampledChains) {
    const matches = chain.samples.map((sample) =>
      nearestOpposingSample(sample, chain, grid, chainById),
    );
    const continuedMatches = [...matches];
    const orderedGaps = [];
    const continuations = continueBoundedCarriagewayPairs(
      chain,
      continuedMatches,
      grid,
      chainById,
      orderedGaps,
    );
    const partIndicesByStartSample = new Map();
    const partIndicesByEndSample = new Map();
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
        partIndicesByStartSample.set(runStartSampleIndex, partIndex);
        partIndicesByEndSample.set(runEndSampleIndex, partIndex);
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
      const match = matches[sampleIndex];
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
    for (const continuation of continuations) {
      const beforeIndex = partIndicesByEndSample.get(continuation.start);
      const afterIndex = partIndicesByStartSample.get(continuation.end);
      if (beforeIndex === undefined || afterIndex === undefined) continue;
      const before = parts[beforeIndex];
      const after = parts[afterIndex];
      if (
        before.pairedChainId !== continuation.chainId ||
        after.pairedChainId !== continuation.chainId
      ) {
        continue;
      }
      const startKey = `${chain.id}:wide-pair:${continuation.start}`;
      const endKey = `${chain.id}:wide-pair:${continuation.end}`;
      before.endTopologyKeys.push(startKey);
      after.startTopologyKeys.push(endKey);
      const partIndex = parts.length;
      const bridgeCoordinates = [before.coordinates.at(-1)];
      for (let i = continuation.start + 1; i < continuation.end; i += 1) {
        bridgeCoordinates.push(
          midpoint(chain.samples[i].coordinate, continuedMatches[i].coordinate),
        );
      }
      bridgeCoordinates.push(after.coordinates[0]);
      // Keep existing feature extents: merging long features changes which
      // distant junctions attach to their terminals. The new sampled section
      // joins their exact endpoints through explicit shared topology keys.
      parts.push({
        ...before,
        id: `osm-mainline-${partIndex + 1}`,
        coordinates: bridgeCoordinates,
        startNodeId: null,
        endNodeId: null,
        startTopologyKeys: [startKey],
        endTopologyKeys: [endKey],
        continuationEndpoints: { beforeId: before.id, afterId: after.id },
        continuationSampleCount: continuation.end - continuation.start - 1,
      });
      endpointsByTopologyKey.set(startKey, [
        `${beforeIndex}:end`,
        `${partIndex}:start`,
      ]);
      endpointsByTopologyKey.set(endKey, [`${partIndex}:end`, `${afterIndex}:start`]);
      widePairContinuationCount += 1;
      widePairSampleCount += continuation.end - continuation.start - 1;
    }
    for (const gap of orderedGaps) {
      const beforeIndex = partIndicesByEndSample.get(gap.start);
      const afterIndex = partIndicesByStartSample.get(gap.end);
      if (beforeIndex === undefined || afterIndex === undefined) continue;
      if (
        parts[beforeIndex].pairedChainId !== gap.chainId ||
        parts[afterIndex].pairedChainId !== gap.chainId
      )
        continue;
      pendingOrderedContinuations.push({ gap, beforeIndex, afterIndex });
    }
    chain.pairCoverage = matchCount / chain.samples.length;
  }
  // Append new continuations after the existing network so a newly supported
  // gap cannot renumber established features or change their junction extents.
  for (const { gap, beforeIndex, afterIndex } of pendingOrderedContinuations) {
    const before = parts[beforeIndex];
    const after = parts[afterIndex];
    const startKey = `${before.sourceChainId}:ordered-pair:${gap.start}`;
    const endKey = `${before.sourceChainId}:ordered-pair:${gap.end}`;
    const partIndex = parts.length;
    before.endTopologyKeys.push(startKey);
    after.startTopologyKeys.push(endKey);
    parts.push({
      ...before,
      id: `osm-mainline-${partIndex + 1}`,
      coordinates: [
        before.coordinates.at(-1),
        ...gap.coordinates.slice(1, -1),
        after.coordinates[0],
      ],
      startNodeId: null,
      endNodeId: null,
      startTopologyKeys: [startKey],
      endTopologyKeys: [endKey],
      continuationEndpoints: { beforeId: before.id, afterId: after.id },
      continuationSampleCount: gap.coordinates.length - 2,
      orderedContinuation: true,
    });
    endpointsByTopologyKey.set(startKey, [`${beforeIndex}:end`, `${partIndex}:start`]);
    endpointsByTopologyKey.set(endKey, [`${partIndex}:end`, `${afterIndex}:start`]);
    widePairContinuationCount += 1;
    widePairSampleCount += gap.coordinates.length - 2;
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
    // Continuations reuse established endpoints; their duplicate coordinates
    // must not change the mean of an existing multi-feature endpoint group.
    const originalEndpointIds = endpointIds.filter(
      (endpointId) => !parts[Number(endpointId.split(':')[0])].continuationEndpoints,
    );
    const coordinates = originalEndpointIds.map((endpointId) => {
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
      widePairContinuationCount,
      widePairSampleCount,
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

function attachmentForNode({
  grid,
  mainlinePartIndices,
  maximumDistanceMeters = PAIR_SEARCH_METERS,
  nodeCoordinate,
}) {
  let best = null;
  const [cellX, cellY] = gridCell(nodeCoordinate);
  const search = (radiusCells) => {
    for (let x = cellX - radiusCells; x <= cellX + radiusCells; x += 1) {
      for (let y = cellY - radiusCells; y <= cellY + radiusCells; y += 1) {
        for (const segment of grid.get(`${x},${y}`) ?? []) {
          if (!mainlinePartIndices.has(segment.partIndex)) continue;
          const coordinate = projectCoordinateOntoSegment(
            nodeCoordinate,
            segment.start,
            segment.end,
          ).map((value) => Number(value.toFixed(7)));
          const distanceMeters = geodesicDistanceMeters(nodeCoordinate, coordinate);
          if (
            distanceMeters <= maximumDistanceMeters &&
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
  };
  search(2);
  if (!best && maximumDistanceMeters > PAIR_SEARCH_METERS) {
    const longitudeMetersPerCell =
      GRID_SIZE_DEGREES *
      111_320 *
      Math.max(0.25, Math.cos((nodeCoordinate[1] * Math.PI) / 180));
    search(Math.ceil(maximumDistanceMeters / longitudeMetersPerCell) + 1);
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

function rampCurveSamples(coordinates) {
  const lengthMeters = lineLengthMeters(coordinates);
  const sampleCount = Math.max(
    3,
    Math.min(
      MAX_RAMP_CORRESPONDENCE_SAMPLES,
      Math.ceil(lengthMeters / RAMP_CORRESPONDENCE_SPACING_METERS) + 1,
    ),
  );
  return resampleCoordinates(
    coordinates,
    Math.max(1, lengthMeters / Math.max(1, sampleCount - 1)),
  );
}

function rampSourceCurve(coordinates) {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    distances.push(
      distances.at(-1) +
        geodesicDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  return { coordinates, distances };
}

function rampPointAlong(curve, distance) {
  const { coordinates, distances } = curve;
  let index = 1;
  while (index < distances.length - 1 && distances[index] < distance) index += 1;
  const fraction =
    (distance - distances[index - 1]) / (distances[index] - distances[index - 1] || 1);
  return {
    coordinate: coordinates[index - 1].map(
      (value, axis) => value + (coordinates[index][axis] - value) * fraction,
    ),
    direction: vector(coordinates[index - 1], coordinates[index]),
  };
}

function rampCorrespondenceWindows(matches) {
  const windows = [];
  for (let index = 1; index < matches.length; index += 1) {
    const before = matches[index - 1];
    const after = matches[index];
    const advance = after.oppositeDistance - before.oppositeDistance;
    const spacing = after.referenceDistance - before.referenceDistance;
    // A nearest-tangent switch can omit an entire source bend between two
    // neighboring samples. Ordinary projections and short source corners stay exact.
    if (advance <= Math.max(75, 4 * spacing)) continue;
    const margin = Math.max(50, advance / 2);
    let start = index - 1;
    let end = index;
    while (
      start > 0 &&
      before.referenceDistance - matches[start].referenceDistance < margin
    ) {
      start -= 1;
    }
    while (
      end < matches.length - 1 &&
      matches[end].referenceDistance - after.referenceDistance < margin
    ) {
      end += 1;
    }
    if (windows.length && start <= windows.at(-1).end) {
      windows.at(-1).end = Math.max(end, windows.at(-1).end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

function rampCorrespondenceSlope(first, last) {
  return Math.max(
    0,
    (last.oppositeDistance - first.oppositeDistance) /
      (last.referenceDistance - first.referenceDistance),
  );
}

function rampBendMetrics(coordinates) {
  let maximum = 0;
  let backwards = 0;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const [before, point, after] = coordinates.slice(index - 1, index + 2);
    if (
      geodesicDistanceMeters(before, point) < 1 ||
      geodesicDistanceMeters(point, after) < 1
    )
      continue;
    const alignment = dot(vector(before, point), vector(point, after));
    maximum = Math.max(maximum, 1 - alignment);
    if (alignment < 0) backwards += 1;
  }
  return { maximum, backwards };
}

function continuousRampCorrespondence(
  matches,
  reference,
  opposite,
  coordinateForMatch,
) {
  const result = [...matches];
  for (const { start, end } of rampCorrespondenceWindows(matches).toReversed()) {
    const first = matches[start];
    const last = matches[end];
    const referenceSpan = last.referenceDistance - first.referenceDistance;
    const oppositeSpan = last.oppositeDistance - first.oppositeDistance;
    if (oppositeSpan <= 0) continue;
    const slope = oppositeSpan / referenceSpan;
    let firstSlope =
      start > 0 ? rampCorrespondenceSlope(matches[start - 1], first) : slope;
    let lastSlope =
      end < matches.length - 1
        ? rampCorrespondenceSlope(last, matches[end + 1])
        : slope;
    // Limit Hermite derivatives so correspondence moves forward on both source
    // paths. Interpolate distance along the roads, never the resulting map line.
    const slopeNorm = Math.hypot(firstSlope / slope, lastSlope / slope);
    if (slopeNorm > 3) {
      firstSlope *= 3 / slopeNorm;
      lastSlope *= 3 / slopeNorm;
    }
    const sampleCount = Math.ceil(
      (referenceSpan + oppositeSpan) / RAMP_CORRESPONDENCE_SPACING_METERS,
    );
    const replacement = [first];
    let valid = true;
    for (let index = 1; index < sampleCount; index += 1) {
      const t = index / sampleCount;
      const referenceDistance = first.referenceDistance + t * referenceSpan;
      const oppositeDistance =
        (2 * t ** 3 - 3 * t ** 2 + 1) * first.oppositeDistance +
        (t ** 3 - 2 * t ** 2 + t) * referenceSpan * firstSlope +
        (-2 * t ** 3 + 3 * t ** 2) * last.oppositeDistance +
        (t ** 3 - t ** 2) * referenceSpan * lastSlope;
      const sample = rampPointAlong(reference, referenceDistance);
      const paired = rampPointAlong(opposite, oppositeDistance);
      // A skipped loop can contain travel in the opposite direction. It must
      // not be pulled into a different movement just to make correspondence continuous.
      if (dot(sample.direction, paired.direction) < 0.25) {
        valid = false;
        break;
      }
      replacement.push({
        referenceDistance,
        oppositeDistance,
        sample: sample.coordinate,
        opposite: paired.coordinate,
      });
    }
    if (!valid) continue;
    replacement.push(last);
    const before = start > 0 ? [matches[start - 1]] : [];
    const after = end < matches.length - 1 ? [matches[end + 1]] : [];
    const oldCoordinates = [...before, ...matches.slice(start, end + 1), ...after].map(
      coordinateForMatch,
    );
    const newCoordinates = [...before, ...replacement, ...after].map(
      coordinateForMatch,
    );
    // Include the joins to untouched samples: a repaired bend cannot introduce
    // a sharper corner or a backward turn at the edge of its correspondence window.
    if (
      rampBendMetrics(newCoordinates).maximum >
      rampBendMetrics(oldCoordinates).maximum + 1e-4
    )
      continue;
    result.splice(start, end - start + 1, ...replacement);
  }
  return result;
}

function repairReversingRamp(coordinates, first, second, start, end) {
  const before = rampBendMetrics(coordinates);
  if (!before.backwards) return coordinates;
  // Independent nearest projections can revisit an earlier section of an
  // asymmetric ramp. Use the same ordered, tangent-compatible correspondence
  // as mainlines only when the original midpoint actually turns backwards.
  const ordered = orderedCarriagewayMidpoints(
    first,
    second,
    MAX_RECIPROCAL_ENDPOINT_GAP_METERS,
  );
  if (!ordered) return coordinates;
  const candidate = [start, ...ordered.coordinates.slice(1, -1), end];
  const after = rampBendMetrics(candidate);
  if (
    after.backwards ||
    after.maximum >= before.maximum ||
    hasProperSelfIntersection(candidate)
  )
    return coordinates;
  return candidate;
}

/**
 * Closest tangent-aligned projections supply the correspondence anchors. When
 * their source positions jump across a bend, continue monotonically along both
 * carriageways through that bend before taking their WGS84 midpoints. Both
 * inputs run in the same direction; endpoints and final midpoints are never warped.
 */
export function averageReciprocalPathCoordinates(
  firstCoordinates,
  secondCoordinates,
  startCoordinate,
  endCoordinate,
) {
  const [reference, opposite] =
    lineLengthMeters(firstCoordinates) <= lineLengthMeters(secondCoordinates)
      ? [firstCoordinates, secondCoordinates]
      : [secondCoordinates, firstCoordinates];
  const referenceCurve = rampSourceCurve(reference);
  const oppositeCurve = rampSourceCurve(opposite);
  const segments = opposite.slice(1).map((end, index) => ({
    start: opposite[index],
    end,
    distanceAlong: oppositeCurve.distances[index],
    direction: vector(opposite[index], end),
  }));
  const matches = [];
  for (const sample of rampCurveSamples(reference)) {
    let best = null;
    for (const segment of segments) {
      if (dot(sample.direction, segment.direction) < MIN_PAIRED_TANGENT_ALIGNMENT)
        continue;
      const projected = projectCoordinateOntoSegment(
        sample.coordinate,
        segment.start,
        segment.end,
      );
      const distanceMeters = geodesicDistanceMeters(sample.coordinate, projected);
      if (!best || distanceMeters < best.distanceMeters) {
        best = {
          opposite: projected,
          oppositeDistance:
            segment.distanceAlong + geodesicDistanceMeters(segment.start, projected),
          distanceMeters,
        };
      }
    }
    if (best)
      matches.push({
        ...best,
        sample: sample.coordinate,
        referenceDistance: sample.distanceMeters,
      });
  }
  const length = referenceCurve.distances.at(-1);
  const coordinateForMatch = (match) => {
    if (match.referenceDistance === 0) return startCoordinate;
    if (Math.abs(match.referenceDistance - length) < 1e-6) return endCoordinate;
    return midpoint(match.sample, match.opposite);
  };
  const paired = continuousRampCorrespondence(
    matches,
    referenceCurve,
    oppositeCurve,
    coordinateForMatch,
  );
  const midpointCoordinates = (correspondence) => {
    const coordinates = [startCoordinate];
    for (const match of correspondence) {
      if (
        match.referenceDistance === 0 ||
        Math.abs(match.referenceDistance - length) < 1e-6
      )
        continue;
      const coordinate = coordinateForMatch(match);
      if (geodesicDistanceMeters(coordinates.at(-1), coordinate) > 0.25)
        coordinates.push(coordinate);
    }
    coordinates.push(endCoordinate);
    return coordinates;
  };
  const coordinates = midpointCoordinates(paired);
  if (
    paired.length === matches.length &&
    paired.every((match, index) => match === matches[index])
  )
    return repairReversingRamp(
      coordinates,
      reference,
      opposite,
      startCoordinate,
      endCoordinate,
    );
  const original = midpointCoordinates(matches);
  const before = rampBendMetrics(original);
  const after = rampBendMetrics(coordinates);
  // Check the complete output after endpoint attachment and duplicate removal.
  // Even a locally regular correspondence can intersect another part of a loop.
  if (
    after.backwards > before.backwards ||
    after.maximum > before.maximum + 1e-4 ||
    (hasProperSelfIntersection(coordinates) && !hasProperSelfIntersection(original))
  )
    return repairReversingRamp(
      original,
      reference,
      opposite,
      startCoordinate,
      endCoordinate,
    );
  return repairReversingRamp(
    coordinates,
    reference,
    opposite,
    startCoordinate,
    endCoordinate,
  );
}

function travelDirectionAtNode(coordinates, nodeIndex) {
  if (nodeIndex === 0) return vector(coordinates[0], coordinates[1]);
  if (nodeIndex === coordinates.length - 1) {
    return vector(coordinates.at(-2), coordinates.at(-1));
  }
  return vector(coordinates[nodeIndex - 1], coordinates[nodeIndex + 1]);
}

function reciprocalDirectionPenalty(first, second) {
  const firstDirections = first.travelDirections ?? [];
  const secondDirections = second.travelDirections ?? [];
  if (firstDirections.length === 0 || secondDirections.length === 0) return 0;
  return Math.min(
    ...firstDirections.flatMap((firstDirection) =>
      secondDirections.map(
        (secondDirection) => (1 + dot(firstDirection, secondDirection)) * 0.5,
      ),
    ),
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

function sameMainlineLeg(first, second, groupByPartIndex) {
  if (first.nodeId === second.nodeId) return true;
  const firstGroup = groupByPartIndex.get(first.partIndex) ?? first.partIndex;
  const secondGroup = groupByPartIndex.get(second.partIndex) ?? second.partIndex;
  return (
    firstGroup === secondGroup &&
    geodesicDistanceMeters(first.coordinate, second.coordinate) <=
      MAX_RECIPROCAL_ENDPOINT_GAP_METERS &&
    (first.travelDirections ?? []).some((firstDirection) =>
      (second.travelDirections ?? []).some(
        (secondDirection) =>
          dot(firstDirection, secondDirection) >= MIN_PAIRED_TANGENT_ALIGNMENT,
      ),
    )
  );
}

function sameDirectedRampMovement(first, second, groupByPartIndex) {
  // Collector roads can offer several splits/merges for the same movement.
  // Require a shared source junction AND directed segment: nearby curves or
  // shared road names alone do not make two connections interchangeable.
  return (
    (first.firstAttachment.nodeId === second.firstAttachment.nodeId ||
      first.secondAttachment.nodeId === second.secondAttachment.nodeId) &&
    sameMainlineLeg(first.firstAttachment, second.firstAttachment, groupByPartIndex) &&
    sameMainlineLeg(
      first.secondAttachment,
      second.secondAttachment,
      groupByPartIndex,
    ) &&
    first.edgeIndices.some((edgeIndex) => second.edgeIndices.includes(edgeIndex))
  );
}

export function selectShortestReciprocalMovements(pairs, groupByPartIndex) {
  const accepted = [];
  const pairsByJunction = new Map();
  // Minimize mean ramp distance across both directions (ranking by their sum
  // is equivalent). This favors later departures and earlier arrivals without
  // bias toward one travel direction. Leave both paths intact for averaging.
  const ordered = [...pairs].sort(
    (first, second) =>
      first[0].distanceMeters +
      first[1].distanceMeters -
      (second[0].distanceMeters + second[1].distanceMeters),
  );
  for (const pair of ordered) {
    const keys = [
      `start:${pair[0].firstAttachment.nodeId}`,
      `end:${pair[0].secondAttachment.nodeId}`,
    ];
    const alternatives = new Set(keys.flatMap((key) => pairsByJunction.get(key) ?? []));
    if (
      [...alternatives].some((other) =>
        pair.every((path, index) =>
          sameDirectedRampMovement(path, other[index], groupByPartIndex),
        ),
      )
    ) {
      continue;
    }
    accepted.push(pair);
    for (const key of keys) {
      const entries = pairsByJunction.get(key) ?? [];
      entries.push(pair);
      pairsByJunction.set(key, entries);
    }
  }
  // Preserve the original relative ordering after selecting representatives.
  const retained = new Set(accepted);
  return pairs.filter((pair) => retained.has(pair));
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
        const firstDirectionPenalty = reciprocalDirectionPenalty(
          first.path.firstAttachment,
          second.path.secondAttachment,
        );
        const secondDirectionPenalty = reciprocalDirectionPenalty(
          first.path.secondAttachment,
          second.path.firstAttachment,
        );
        candidates.push({
          first,
          score:
            firstEndpointGapMeters +
            secondEndpointGapMeters +
            // Physical merge points can sit on opposite sides of a large
            // interchange. Opposing mainline travel directions identify the
            // same external legs more reliably than endpoint proximity alone.
            (firstDirectionPenalty + secondDirectionPenalty) *
              MAX_RECIPROCAL_ENDPOINT_GAP_METERS *
              8 +
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
  const distinctPairs = selectShortestReciprocalMovements(pairs, groupByPartIndex);
  const retained = new Set(distinctPairs);
  return {
    alternativePaths: pairs.filter((pair) => !retained.has(pair)).flat(),
    alternativePathCount: (pairs.length - distinctPairs.length) * 2,
    pairs: distinctPairs,
    unpairedPathCount: paths.length - used.size,
  };
}

function outerReciprocalAttachment(first, second, parts, atStart) {
  // In the forward path's travel direction, start at the earlier split and end
  // at the later merge. The shorter ramp is extended along its own carriageway.
  const part = parts[first.partIndex];
  const partDirection = vector(
    part.coordinates[first.segmentIndex],
    part.coordinates[first.segmentIndex + 1],
  );
  const direction = first.travelDirections?.[0] ?? partDirection;
  const alongTravel =
    first.partIndex === second.partIndex
      ? (second.distanceAlongPartMeters - first.distanceAlongPartMeters) *
        dot(partDirection, direction)
      : dot(vector(first.coordinate, second.coordinate), direction);
  return alongTravel >= 0 === atStart ? first : second;
}

function mainlineContinuationGraph(osm, ways) {
  const forward = new Map();
  const backward = new Map();
  for (const way of ways) {
    for (let index = 1; index < way.nodeIds.length; index += 1) {
      const from = way.nodeIds[index - 1];
      const to = way.nodeIds[index];
      const start = osm.nodes.get(from).coordinate;
      const end = osm.nodes.get(to).coordinate;
      for (const [graph, nodeId, nextNodeId, first, last] of [
        [forward, from, to, start, end],
        [backward, to, from, end, start],
      ]) {
        const entries = graph.get(nodeId) ?? [];
        entries.push({
          nextNodeId,
          coordinate: last,
          direction: vector(first, last),
          wayId: way.id,
        });
        graph.set(nodeId, entries);
      }
    }
  }
  return { forward, backward };
}

function mainlineExtension(osm, graph, attachment, target, part, backwards) {
  const origin = osm.nodes.get(attachment.nodeId).coordinate;
  const maximumDistance = geodesicDistanceMeters(origin, target) * 2 + 250;
  const eligibleWays = new Set(part.sourceWayIds);
  let nodeId = attachment.nodeId;
  let coordinate = origin;
  let direction = attachment.travelDirections?.[0];
  if (direction && backwards) direction = direction.map((value) => -value);
  const visited = new Set([nodeId]);
  const coordinates = [origin];
  let best = {
    distance: geodesicDistanceMeters(origin, target),
    coordinates: [origin],
  };
  let traversed = 0;
  while (traversed < maximumDistance) {
    const candidates = (graph.get(nodeId) ?? [])
      .filter((edge) => !visited.has(edge.nextNodeId))
      .map((edge) => ({
        ...edge,
        alignment: direction ? dot(direction, edge.direction) : 1,
      }))
      .filter((edge) => edge.alignment > 0.25)
      .sort(
        (first, second) =>
          (Number(eligibleWays.has(second.wayId)) -
            Number(eligibleWays.has(first.wayId))) *
            2 +
          second.alignment -
          first.alignment,
      );
    const next = candidates[0];
    if (!next) break;
    const projected = projectCoordinateOntoSegment(target, coordinate, next.coordinate);
    const distance = geodesicDistanceMeters(projected, target);
    if (distance < best.distance) {
      best = { distance, coordinates: [...coordinates, projected] };
    }
    traversed += geodesicDistanceMeters(coordinate, next.coordinate);
    coordinate = next.coordinate;
    nodeId = next.nextNodeId;
    direction = next.direction;
    coordinates.push(coordinate);
    visited.add(nodeId);
  }
  return best.coordinates;
}

function extendReciprocalPath(osm, path, start, end, parts, graph) {
  const before = mainlineExtension(
    osm,
    graph.backward,
    path.firstAttachment,
    start,
    parts[path.firstAttachment.partIndex],
    true,
  );
  const after = mainlineExtension(
    osm,
    graph.forward,
    path.secondAttachment,
    end,
    parts[path.secondAttachment.partIndex],
    false,
  );
  return [...before.reverse().slice(0, -1), ...path.coordinates, ...after.slice(1)];
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

function mainlineEndpoint(part, attachment) {
  if (geodesicDistanceMeters(part.coordinates[0], part.coordinates.at(-1)) < 0.25) {
    return null;
  }
  if (
    attachment.segmentIndex === 0 &&
    geodesicDistanceMeters(attachment.coordinate, part.coordinates[0]) < 0.25
  ) {
    return 'start';
  }
  if (
    attachment.segmentIndex === part.coordinates.length - 2 &&
    geodesicDistanceMeters(attachment.coordinate, part.coordinates.at(-1)) < 0.25
  ) {
    return 'end';
  }
  return null;
}

function mainlineJunctionGroups(parts, junctions) {
  const parents = new Map();
  const find = (key) => {
    if (!parents.has(key)) parents.set(key, key);
    const parent = parents.get(key);
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  const union = (first, second) => parents.set(find(first), find(second));
  for (const [partIndex, part] of parts.entries()) {
    for (const endpoint of ['start', 'end']) {
      const endpointId = `${partIndex}:${endpoint}`;
      find(endpointId);
      for (const key of part[`${endpoint}TopologyKeys`] ?? []) {
        union(endpointId, key);
      }
    }
  }
  for (const [index, junction] of junctions.entries()) {
    for (const attachment of junction.attachments) {
      const endpoint = mainlineEndpoint(parts[attachment.partIndex], attachment);
      if (endpoint) union(`junction:${index}`, `${attachment.partIndex}:${endpoint}`);
    }
  }
  const groups = new Map();
  for (const [index, junction] of junctions.entries()) {
    const root = find(`junction:${index}`);
    const group = groups.get(root) ?? { junctions: [], endpoints: new Map() };
    group.junctions.push(junction);
    groups.set(root, group);
  }
  for (const partIndex of parts.keys()) {
    for (const endpoint of ['start', 'end']) {
      const group = groups.get(find(`${partIndex}:${endpoint}`));
      if (!group) continue;
      const endpoints = group.endpoints.get(partIndex) ?? new Set();
      endpoints.add(endpoint);
      group.endpoints.set(partIndex, endpoints);
    }
  }
  return [...groups.values()];
}

function applyMainlineJunctions(part, insertions) {
  const start = insertions.find((insertion) => insertion.endpoint === 'start');
  const end = insertions.find((insertion) => insertion.endpoint === 'end');
  const startExtends =
    start &&
    coordinateProjectionFraction(
      start.coordinate,
      part.coordinates[0],
      part.coordinates[1],
    ) < 0;
  const endExtends =
    end &&
    coordinateProjectionFraction(
      end.coordinate,
      part.coordinates.at(-2),
      part.coordinates.at(-1),
    ) > 1;
  const startDistance = startExtends
    ? -Infinity
    : (start?.distanceAlongPartMeters ?? -Infinity);
  const endDistance = endExtends
    ? Infinity
    : (end?.distanceAlongPartMeters ?? Infinity);
  const vertices = [];
  let distance = 0;
  for (const [index, coordinate] of part.coordinates.entries()) {
    if (index > 0)
      distance += geodesicDistanceMeters(part.coordinates[index - 1], coordinate);
    if (distance > startDistance + 0.25 && distance < endDistance - 0.25) {
      vertices.push({ coordinate, position: index, priority: 0 });
    }
  }
  for (const insertion of insertions) {
    if (insertion.endpoint) continue;
    if (
      insertion.distanceAlongPartMeters < startDistance - 0.25 ||
      insertion.distanceAlongPartMeters > endDistance + 0.25
    ) {
      throw new Error(
        `Mainline junction lies beyond a trimmed endpoint of ${part.id}.`,
      );
    }
    const segmentLength = geodesicDistanceMeters(
      part.coordinates[insertion.segmentIndex],
      part.coordinates[insertion.segmentIndex + 1],
    );
    const fraction =
      segmentLength === 0
        ? 0
        : Math.min(1, Math.max(0, insertion.distanceAlongMeters / segmentLength));
    // Segment-local order is exact at a vertex; adding long cumulative
    // distances can put an endpoint insertion just beyond that vertex.
    vertices.push({
      ...insertion,
      position: insertion.segmentIndex + fraction,
      priority: fraction === 0 ? 1 : -1,
    });
  }
  vertices.sort(
    (first, second) =>
      first.position - second.position || first.priority - second.priority,
  );
  if (start) vertices.unshift(start);
  if (end) vertices.push(end);
  part.coordinates = vertices
    .map((vertex) => vertex.coordinate)
    .filter(
      (coordinate, index, coordinates) =>
        index === 0 ||
        geodesicDistanceMeters(coordinates[index - 1], coordinate) > 0.25,
    );
}

function mainlineReversalCount(coordinates) {
  let count = 0;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const [before, point, after] = coordinates.slice(index - 1, index + 2);
    if (
      geodesicDistanceMeters(before, point) < 1 ||
      geodesicDistanceMeters(point, after) < 1
    )
      continue;
    if (dot(vector(before, point), vector(point, after)) < -0.1) count += 1;
  }
  return count;
}

function joinMainlineJunctions(parts, grid, junctions) {
  const lengths = parts.map((part) => lineLengthMeters(part.coordinates));
  const groups = mainlineJunctionGroups(parts, junctions);
  for (const group of groups) {
    group.legacy = group.junctions.flatMap((junction) => {
      const coordinate = [0, 1].map((axis) =>
        Number(
          (
            junction.attachments.reduce(
              (sum, attachment) => sum + attachment.coordinate[axis],
              0,
            ) / junction.attachments.length
          ).toFixed(7),
        ),
      );
      return junction.attachments.map((attachment) => ({
        ...attachment,
        coordinate,
        keys: [`osm-mainline-junction:${junction.nodeId}`],
      }));
    });
    // A short loop or two separate ends of a road must not be collapsed into
    // a single merge. Ordinary way segmentation also is not a branch merge.
    if (
      !group.junctions.some((junction) => junction.branch) ||
      group.endpoints.size === 0 ||
      [...group.endpoints.values()].some((endpoints) => endpoints.size > 1)
    )
      continue;
    group.proposed = [];
    const attachments = group.junctions.flatMap((junction) => junction.attachments);
    // Both directional source merges can clamp to the same branch terminal.
    // They describe one centerline junction, including any existing split-part
    // endpoint keys. Do not append them and then revisit the old terminal.
    const positions = group.junctions
      .filter((junction) => junction.branch)
      .map((junction) => junction.coordinate);
    const center = [0, 1].map(
      (axis) =>
        positions.reduce((sum, coordinate) => sum + coordinate[axis], 0) /
        positions.length,
    );
    const anchor = attachments.reduce((best, attachment) => {
      const clearance = (entry) =>
        Math.min(
          entry.distanceAlongPartMeters,
          lengths[entry.partIndex] - entry.distanceAlongPartMeters,
        );
      return clearance(attachment) > clearance(best) ? attachment : best;
    });
    const project = (partIndex) =>
      attachmentForNode({
        grid,
        mainlinePartIndices: new Set([partIndex]),
        nodeCoordinate: center,
        maximumDistanceMeters: PAIR_SEARCH_METERS * 3,
      });
    // Keep the continuing midpoint line in place. The shared point must be on
    // that line, rather than the average of two off-line attachment locations.
    const commonCoordinate = project(anchor.partIndex).coordinate;
    const partIndices = new Set([
      ...attachments.map((attachment) => attachment.partIndex),
      ...group.endpoints.keys(),
    ]);
    for (const partIndex of partIndices) {
      const attachment = attachmentForNode({
        grid,
        mainlinePartIndices: new Set([partIndex]),
        nodeCoordinate: commonCoordinate,
        maximumDistanceMeters: PAIR_SEARCH_METERS * 3,
      });
      if (!attachment)
        throw new Error(`Cannot place mainline junction on ${parts[partIndex].id}.`);
      const endpoints = group.endpoints.get(partIndex);
      for (const endpoint of endpoints ?? [null]) {
        group.proposed.push({
          ...attachment,
          coordinate: commonCoordinate,
          endpoint,
          keys: group.junctions.map(
            (junction) => `osm-mainline-junction:${junction.nodeId}`,
          ),
        });
      }
    }
  }
  // Moving a terminal must not erase a different junction farther along that
  // part. Retain the existing topology for these overlapping, complex cases.
  const individualByPart = new Map();
  for (const group of groups) {
    for (const entry of group.legacy) {
      const entries = individualByPart.get(entry.partIndex) ?? [];
      entries.push(entry);
      individualByPart.set(entry.partIndex, entries);
    }
  }
  const originalReversals = new Map();
  let changed;
  do {
    changed = false;
    const byPart = new Map();
    for (const group of groups) {
      for (const entry of group.proposed ?? group.legacy) {
        const entries = byPart.get(entry.partIndex) ?? [];
        entries.push({ ...entry, group });
        byPart.set(entry.partIndex, entries);
      }
    }
    for (const group of groups) {
      if (!group.proposed) continue;
      const conflicts = group.proposed.some(
        (entry) =>
          entry.endpoint &&
          ((entry.endpoint === 'start'
            ? entry.distanceAlongPartMeters >= lengths[entry.partIndex] - 0.25
            : entry.distanceAlongPartMeters <= 0.25) ||
            (byPart.get(entry.partIndex) ?? []).some(
              (other) =>
                other.group !== group &&
                (entry.endpoint === 'start'
                  ? other.distanceAlongPartMeters < entry.distanceAlongPartMeters - 0.25
                  : other.distanceAlongPartMeters >
                    entry.distanceAlongPartMeters + 0.25),
            )),
      );
      if (conflicts) {
        group.proposed = null;
        changed = true;
      }
    }
    if (changed) continue;
    for (const [partIndex, entries] of byPart) {
      const proposedGroups = new Set(
        entries.map((entry) => entry.group).filter((group) => group.proposed),
      );
      if (proposedGroups.size === 0) continue;
      if (!originalReversals.has(partIndex)) {
        const original = { ...parts[partIndex] };
        applyMainlineJunctions(original, individualByPart.get(partIndex) ?? []);
        originalReversals.set(partIndex, mainlineReversalCount(original.coordinates));
      }
      const proposed = { ...parts[partIndex] };
      applyMainlineJunctions(proposed, entries);
      // A candidate merge cannot introduce additional folds in a curved or
      // multiply paired approach. Keep those individual attachments intact.
      if (
        mainlineReversalCount(proposed.coordinates) > originalReversals.get(partIndex)
      ) {
        for (const group of proposedGroups) group.proposed = null;
        changed = true;
      }
    }
  } while (changed);
  const insertionsByPart = new Map();
  for (const group of groups) {
    for (const entry of group.proposed ?? group.legacy) {
      const entries = insertionsByPart.get(entry.partIndex) ?? [];
      entries.push(entry);
      insertionsByPart.set(entry.partIndex, entries);
      for (const key of entry.keys)
        topologyCoordinate(parts[entry.partIndex], entry.coordinate, key);
    }
  }
  for (const [partIndex, insertions] of insertionsByPart) {
    applyMainlineJunctions(parts[partIndex], insertions);
  }
  return { mergedGroups: groups.filter((group) => group.proposed).length };
}

function attachWidePairContinuations(parts, continuations) {
  const partById = new Map(parts.map((part) => [part.id, part]));
  for (const continuation of continuations) {
    const before = partById.get(continuation.continuationEndpoints.beforeId);
    const after = partById.get(continuation.continuationEndpoints.afterId);
    const coordinates = [
      before.coordinates.at(-1),
      ...continuation.coordinates.slice(1, -1),
      after.coordinates[0],
    ];
    const joined = [before.coordinates.at(-2), ...coordinates, after.coordinates[1]];
    if (
      mainlineReversalCount(joined) > 0 ||
      coordinates.some(
        (point, index) =>
          index > 0 &&
          geodesicDistanceMeters(coordinates[index - 1], point) >
            SAMPLE_SPACING_METERS * 2.8,
      )
    ) {
      before.endTopologyKeys = before.endTopologyKeys.filter(
        (key) => !continuation.startTopologyKeys.includes(key),
      );
      after.startTopologyKeys = after.startTopologyKeys.filter(
        (key) => !continuation.endTopologyKeys.includes(key),
      );
      continue;
    }
    continuation.coordinates = coordinates;
    parts.push(continuation);
  }
}

export function connectMainlinePartsAtSourceNodes(osm, mainlineWays, parts) {
  const continuations = parts.filter((part) => part.continuationEndpoints);
  if (continuations.length > 0) {
    // Resolve the existing network first. A new continuity segment already
    // has explicit endpoint connections and must not reclassify old junctions
    // by changing a long feature's extent or joining its endpoint groups.
    const existingParts = parts.filter((part) => !part.continuationEndpoints);
    const statistics = connectMainlinePartsAtSourceNodes(
      osm,
      mainlineWays,
      existingParts,
    );
    attachWidePairContinuations(existingParts, continuations);
    parts.splice(0, parts.length, ...existingParts);
    return statistics;
  }
  const wayById = new Map(mainlineWays.map((way) => [way.id, way]));
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
  const junctions = [];
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
    const neighbors = new Set();
    for (const wayId of wayIds) {
      const way = wayById.get(wayId);
      for (const [index, id] of way.nodeIds.entries()) {
        if (id !== nodeId) continue;
        if (index > 0) neighbors.add(way.nodeIds[index - 1]);
        if (index + 1 < way.nodeIds.length) neighbors.add(way.nodeIds[index + 1]);
      }
    }
    junctions.push({
      attachments,
      nodeId,
      coordinate: osm.nodes.get(nodeId).coordinate,
      branch: neighbors.size > 2,
    });
  }
  joinMainlineJunctions(parts, partSegmentGrid, junctions);
  return { junctionCount: junctions.length };
}

function rampAttachmentResolver(osm, parts, sourceParts, grid, continuationGraph) {
  const groups = mainlineGroupByPartIndex(parts);
  const partsByGroup = new Map();
  for (const [partIndex] of parts.entries()) {
    const group = groups.get(partIndex) ?? partIndex;
    const indices = partsByGroup.get(group) ?? new Set();
    indices.add(partIndex);
    partsByGroup.set(group, indices);
  }
  const singleGroup = (indices) => {
    const candidates = new Set([...indices].map((index) => groups.get(index) ?? index));
    return candidates.size === 1 ? [...candidates][0] : null;
  };
  const reachableGroup = (nodeId, graph) => {
    const queue = new MinimumDistanceHeap();
    const distances = new Map([[nodeId, 0]]);
    const reachedParts = new Set();
    const exits = new Set();
    const predecessors = new Map();
    const outsideBound = new Set();
    queue.push({ nodeId, distanceMeters: 0 });
    while (queue.size > 0) {
      const current = queue.pop();
      if (current.distanceMeters !== distances.get(current.nodeId)) continue;
      const edges = graph.get(current.nodeId) ?? [];
      if (edges.length === 0) return null;
      for (const edge of edges) {
        const mapped = sourceParts.get(edge.wayId) ?? [];
        if (mapped.length > 0) {
          for (const index of mapped) reachedParts.add(index);
          if (singleGroup(reachedParts) === null) return null;
          exits.add(current.nodeId);
          continue;
        }
        const previous = predecessors.get(edge.nextNodeId) ?? new Set();
        previous.add(current.nodeId);
        predecessors.set(edge.nextNodeId, previous);
        const distanceMeters =
          current.distanceMeters +
          geodesicDistanceMeters(
            osm.nodes.get(current.nodeId).coordinate,
            edge.coordinate,
          );
        if (distanceMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS) {
          outsideBound.add(edge.nextNodeId);
        } else if (distanceMeters < (distances.get(edge.nextNodeId) ?? Infinity)) {
          distances.set(edge.nextNodeId, distanceMeters);
          queue.push({ nodeId: edge.nextNodeId, distanceMeters });
        }
      }
    }
    if ([...outsideBound].some((id) => !distances.has(id))) return null;
    // Every branch must lead back to represented pavement; a nearby dead end
    // or a closed source loop cannot supply evidence for a mainline attachment.
    const pending = [...exits];
    while (pending.length > 0) {
      for (const previous of predecessors.get(pending.pop()) ?? []) {
        if (exits.has(previous)) continue;
        exits.add(previous);
        pending.push(previous);
      }
    }
    if ([...distances.keys()].some((id) => !exits.has(id))) return null;
    return singleGroup(reachedParts);
  };
  const repairs = [];
  const originalByNode = new Map();
  const resolve = (nodeId, directParts) => {
    const nodeCoordinate = osm.nodes.get(nodeId).coordinate;
    const direct =
      directParts.size === 0
        ? null
        : attachmentForNode({
            grid,
            mainlinePartIndices: directParts,
            maximumDistanceMeters: MAX_RECIPROCAL_ENDPOINT_GAP_METERS,
            nodeCoordinate,
          });
    originalByNode.set(nodeId, direct);
    if (direct?.distanceMeters <= PAIR_SEARCH_METERS) return direct;
    let group = singleGroup(directParts);
    if (directParts.size === 0) {
      // An auxiliary carriageway can be absent from the averaged part's source
      // list. Infer its corridor only from explicit motorway continuity in BOTH
      // travel directions, never from a crossing or geographic proximity alone.
      const before = reachableGroup(nodeId, continuationGraph.backward);
      const after = reachableGroup(nodeId, continuationGraph.forward);
      group = before !== null && before === after ? before : null;
    }
    if (group === null) return direct;
    const attachment = attachmentForNode({
      grid,
      mainlinePartIndices: partsByGroup.get(group),
      nodeCoordinate,
    });
    if (!attachment) return direct;
    repairs.push({
      nodeId,
      sourceCoordinate: nodeCoordinate,
      coordinate: attachment.coordinate,
      partId: parts[attachment.partIndex].id,
      previousDistanceMeters: direct?.distanceMeters ?? null,
      distanceMeters: attachment.distanceMeters,
      kind: directParts.size === 0 ? 'auxiliary-carriageway' : 'shared-source-corridor',
    });
    return { ...attachment, inferredCorridor: true };
  };
  return { resolve, repairs, originalByNode };
}

export function buildRampConnectors(osm, mainlineWays, parts, connectorWays) {
  const partSegmentGrid = buildPartSegmentGrid(parts);
  const sourceWayIdToPartIndices = indexPartsBySourceWay(parts);
  const graph = connectorSegmentGraph(connectorWays);
  const continuationGraph = mainlineContinuationGraph(osm, mainlineWays);
  const resolver = rampAttachmentResolver(
    osm,
    parts,
    sourceWayIdToPartIndices,
    partSegmentGrid,
    continuationGraph,
  );
  const mainlinePartIndicesByNode = new Map();
  const mainlineDirectionsByNodeAndPart = new Map();
  const mainlineDirectionsByNode = new Map();
  for (const way of mainlineWays) {
    const partIndices = sourceWayIdToPartIndices.get(way.id) ?? [];
    const wayCoordinates =
      way.coordinates ?? way.nodeIds.map((nodeId) => osm.nodes.get(nodeId).coordinate);
    for (const [nodeIndex, nodeId] of way.nodeIds.entries()) {
      if (!graph.incident.has(nodeId)) continue;
      const direction = travelDirectionAtNode(wayCoordinates, nodeIndex);
      const nodeDirections = mainlineDirectionsByNode.get(nodeId) ?? [];
      nodeDirections.push(direction);
      mainlineDirectionsByNode.set(nodeId, nodeDirections);
      const indices = mainlinePartIndicesByNode.get(nodeId) ?? new Set();
      for (const partIndex of partIndices) {
        indices.add(partIndex);
        const key = `${nodeId}:${partIndex}`;
        const directions = mainlineDirectionsByNodeAndPart.get(key) ?? [];
        directions.push(direction);
        mainlineDirectionsByNodeAndPart.set(key, directions);
      }
      mainlinePartIndicesByNode.set(nodeId, indices);
    }
  }
  const components = traceLinkComponents(graph);
  const connectors = [];
  const insertionsByPart = new Map();
  const allDirectedPaths = [];
  const originalDirectedPaths = [];
  const describeAttachment = (attachment, nodeId) => ({
    ...attachment,
    nodeId,
    travelDirections:
      (attachment.inferredCorridor
        ? mainlineDirectionsByNode.get(nodeId)
        : mainlineDirectionsByNodeAndPart.get(`${nodeId}:${attachment.partIndex}`)) ??
      [],
  });
  const pathsForAttachments = (component, attachments) => {
    if (attachments.length < 2) return [];
    return directedConnectorPaths(component, graph, attachments, osm).flatMap(
      (path) => {
        const coordinates = path.nodeIds.map(
          (nodeId) => osm.nodes.get(nodeId).coordinate,
        );
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
      },
    );
  };
  for (const component of components) {
    const attachments = [...component.nodeIds].flatMap((nodeId) => {
      const partIndices = mainlinePartIndicesByNode.get(nodeId);
      if (!partIndices) return [];
      const attachment = resolver.resolve(nodeId, partIndices);
      return attachment ? [describeAttachment(attachment, nodeId)] : [];
    });
    const directedPaths = pathsForAttachments(component, attachments);
    allDirectedPaths.push(...directedPaths);
    originalDirectedPaths.push(
      ...(attachments.some((attachment) => attachment.inferredCorridor)
        ? pathsForAttachments(
            component,
            [...component.nodeIds].flatMap((nodeId) => {
              const original = resolver.originalByNode.get(nodeId);
              return original ? [describeAttachment(original, nodeId)] : [];
            }),
          )
        : directedPaths),
    );
  }
  const groupByPartIndex = mainlineGroupByPartIndex(parts);
  const established = reciprocalPathPairs(originalDirectedPaths, groupByPartIndex);
  const usedByJunction = new Map();
  for (const path of established.pairs.flat()) {
    for (const nodeId of [path.firstAttachment.nodeId, path.secondAttachment.nodeId]) {
      const entries = usedByJunction.get(nodeId) ?? [];
      entries.push(path);
      usedByJunction.set(nodeId, entries);
    }
  }
  // Inference supplies missing movements. It must not consume a direction from
  // an established pair or add another rendering of that same movement.
  const available = allDirectedPaths.filter(
    (path) =>
      ![path.firstAttachment.nodeId, path.secondAttachment.nodeId].some((nodeId) =>
        (usedByJunction.get(nodeId) ?? []).some((used) =>
          sameDirectedRampMovement(path, used, groupByPartIndex),
        ),
      ),
  );
  const inferred = reciprocalPathPairs(available, groupByPartIndex);
  const appliedNodes = new Set();
  const acceptedPathKeys = new Set();
  const pathIdentity = (path) =>
    `${path.nodeIds.join(':')}|${path.edgeIndices.join(',')}`;
  let rejectedInferredConnectorCount = 0;
  const pairs = [
    ...established.pairs,
    ...inferred.pairs.filter((pair) =>
      pair.some(
        (path) =>
          path.firstAttachment.inferredCorridor ||
          path.secondAttachment.inferredCorridor,
      ),
    ),
  ];
  for (const [pairIndex, [forward, reverse]] of pairs.entries()) {
    const isInferred = pairIndex >= established.pairs.length;
    const startAttachment = outerReciprocalAttachment(
      forward.firstAttachment,
      reverse.secondAttachment,
      parts,
      true,
    );
    const endAttachment = outerReciprocalAttachment(
      forward.secondAttachment,
      reverse.firstAttachment,
      parts,
      false,
    );
    const startPartIndex = startAttachment.partIndex;
    const endPartIndex = endAttachment.partIndex;
    const coordinates = averageReciprocalPathCoordinates(
      extendReciprocalPath(
        osm,
        forward,
        startAttachment.coordinate,
        endAttachment.coordinate,
        parts,
        continuationGraph,
      ),
      extendReciprocalPath(
        osm,
        reverse,
        endAttachment.coordinate,
        startAttachment.coordinate,
        parts,
        continuationGraph,
      ).reverse(),
      startAttachment.coordinate,
      endAttachment.coordinate,
    );
    if (lineLengthMeters(coordinates) < 5) continue;
    if (
      isInferred &&
      (rampBendMetrics(coordinates).backwards || hasProperSelfIntersection(coordinates))
    ) {
      rejectedInferredConnectorCount += 1;
      continue;
    }
    if (isInferred) {
      for (const attachment of [
        forward.firstAttachment,
        forward.secondAttachment,
        reverse.firstAttachment,
        reverse.secondAttachment,
      ]) {
        if (attachment.inferredCorridor) appliedNodes.add(attachment.nodeId);
      }
    }
    acceptedPathKeys.add(pathIdentity(forward));
    acceptedPathKeys.add(pathIdentity(reverse));
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
  const attachmentRepairs = resolver.repairs.filter((repair) =>
    appliedNodes.has(repair.nodeId),
  );
  const directedPathCount = new Set(
    [...originalDirectedPaths, ...allDirectedPaths].map(pathIdentity),
  ).size;
  const alternativePathCount = new Set(
    [...established.alternativePaths, ...inferred.alternativePaths]
      .map(pathIdentity)
      .filter((key) => !acceptedPathKeys.has(key)),
  ).size;
  return {
    connectors,
    attachmentRepairs,
    statistics: {
      candidateRampAttachmentCount: resolver.repairs.length,
      repairedRampAttachmentCount: attachmentRepairs.length,
      rejectedInferredConnectorCount,
      restoredConnectorCount: connectors.length - established.pairs.length,
      alternativeConnectorPathCount: alternativePathCount,
      connectorComponentCount: components.length,
      directedConnectorPathCount: directedPathCount,
      directConnectorCount: connectors.length,
      unpairedConnectorPathCount:
        directedPathCount - alternativePathCount - connectors.length * 2,
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
  // Resolve established ramp attachments before adding gap geometry, then
  // anchor each addition to the final endpoints. A wider displayed median
  // must not relocate an existing ramp to a different nearest feature.
  const orderedContinuations = averaged.parts.filter(
    (part) => part.orderedContinuation,
  );
  averaged.parts = averaged.parts.filter((part) => !part.orderedContinuation);
  const ramps = buildRampConnectors(
    osm,
    prepared.mainlines,
    averaged.parts,
    prepared.connectors,
  );
  attachWidePairContinuations(averaged.parts, orderedContinuations);
  const endingAudit = trimRampOnlyMainlineTails(
    averaged.parts,
    ramps.connectors,
    buildMainlineEndingIndex(chains, prepared.mainlines, prepared.connectors),
  );
  return {
    ...averaged,
    parts: [...averaged.parts, ...ramps.connectors],
    statistics: {
      ...averaged.statistics,
      averagedPartCount: averaged.parts.length,
      widePairContinuationCount: averaged.parts.filter(
        (part) => part.continuationEndpoints,
      ).length,
      widePairSampleCount: averaged.parts.reduce(
        (total, part) => total + (part.continuationSampleCount ?? 0),
        0,
      ),
      mainlineJunctionCount: mainlineTopology.junctionCount,
      orderedPairContinuationCount: averaged.parts.filter(
        (part) => part.orderedContinuation,
      ).length,
      ...ramps.statistics,
      ...endingAudit.statistics,
    },
    connectorWays: prepared.connectors,
    mainlineWays: prepared.mainlines,
    rampAttachmentRepairs: ramps.attachmentRepairs,
  };
}
