/* eslint-disable max-lines -- Parsing, carriageway pairing, and explicit-node topology are one audited pipeline. */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { orderedCarriagewayMidpoints } from './highway-ordered-midpoint.mjs';
import { coveredMainlineMergePairs } from './highway-mainline-merges.mjs';
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
  // OPL escapes Unicode code points between TWO percent signs; these are
  // not URL escapes. Consuming only the first delimiter corrupts I 295,
  // for example, by decoding the closing percent sign plus "29" again.
  return value.replace(/%([0-9a-fA-F]{1,6})%/g, (_, hexadecimal) =>
    String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
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
    // Open ramp links can retain a construction road class after reopening,
    // or describe ongoing minor works. Do not sever those explicit paths.
    // Keep the existing construction qualification for mainline pairing.
    (tags.construction &&
      (tags.highway !== 'motorway_link' || tags.construction === 'yes')) ||
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
    return (lanes !== null && lanes < 2) || isAuxiliaryCarriageway(way.tags)
      ? 'connector'
      : 'mainline';
  }
  if (way.tags.highway === 'motorway_link') {
    if (way.tags.oneway === 'no') return null;
    return 'connector';
  }
  return null;
}

function isAuxiliaryCarriageway(tags) {
  // Classify the separately mapped carriageway, never its destinations or
  // individual lane guidance. A normal freeway advertising an express-lane
  // exit (or containing one HOV lane) still supplies the mainline midpoint.
  const name = [tags.name, tags.official_name, tags.alt_name].filter(Boolean).join(';');
  return (
    /\bexpress\s*(?:toll\s+)?lanes?\b|\bTEXpress\b|\bcollector(?:[\s/-]+distributor)?\b|\bdistributor\b|\bHOV(?:\s*\/\s*HOT)?(?:\s+lanes?)?\b/i.test(
      name,
    ) ||
    (tags.toll === 'yes' && /\bexpress\b\s*$/i.test(name)) ||
    tags.express_lanes === 'yes' ||
    tags.express_lane === 'yes' ||
    tags.managed_lane === 'yes' ||
    (tags.hov === 'designated' && !tags['hov:lanes'])
  );
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
    let minimumMatchPosition = Infinity;
    let maximumMatchPosition = -Infinity;
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
          sourceRanges: [
            {
              chainId: chain.id,
              positions: [runStartSampleIndex, runEndSampleIndex].map((index) => {
                const sample = chain.samples[index];
                return (
                  sample.sourceSegmentIndex +
                  coordinateProjectionFraction(
                    sample.coordinate,
                    chain.coordinates[sample.sourceSegmentIndex],
                    chain.coordinates[sample.sourceSegmentIndex + 1],
                  )
                );
              }),
            },
            {
              chainId: matchedChainId,
              positions: [minimumMatchPosition, maximumMatchPosition],
            },
          ],
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
      minimumMatchPosition = Infinity;
      maximumMatchPosition = -Infinity;
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
      minimumMatchPosition = Math.min(minimumMatchPosition, match.sourcePosition);
      maximumMatchPosition = Math.max(maximumMatchPosition, match.sourcePosition);
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
  if (mainlinePartIndices.size === 0) return null;
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
function reciprocalPathMidpoints(
  firstCoordinates,
  secondCoordinates,
  startCoordinate,
  endCoordinate,
  monotone = false,
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
      const oppositeDistance =
        segment.distanceAlong + geodesicDistanceMeters(segment.start, projected);
      if (
        monotone &&
        matches.length &&
        oppositeDistance < matches.at(-1).oppositeDistance - 0.01
      )
        continue;
      const distanceMeters = geodesicDistanceMeters(sample.coordinate, projected);
      if (!best || distanceMeters < best.distanceMeters) {
        best = {
          opposite: projected,
          oppositeDistance,
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

function trimRampAttachmentOverhangs(coordinates) {
  // A projected mainline attachment can fall just beyond the first sampled
  // midpoint. Keep the attachment and the remaining source midpoints, without
  // making a short excursion behind the attachment before following the ramp.
  const result = [...coordinates];
  for (const reverse of [false, true]) {
    if (reverse) result.reverse();
    while (result.length > 2) {
      const [attachment, sample, next] = result;
      if (
        geodesicDistanceMeters(attachment, sample) >
          RAMP_CORRESPONDENCE_SPACING_METERS ||
        dot(vector(attachment, sample), vector(sample, next)) >= 0 ||
        dot(vector(attachment, next), vector(sample, next)) < 0
      )
        break;
      result.splice(1, 1);
    }
    if (reverse) result.reverse();
  }
  return result;
}

function directionalReciprocalPathCoordinates(first, second, start, end) {
  const coordinates = trimRampAttachmentOverhangs(
    reciprocalPathMidpoints(first, second, start, end),
  );
  const before = rampBendMetrics(coordinates);
  if (!before.backwards) return coordinates;
  // A shorter collector can expose an earlier loop to independent nearest
  // projections. Search only forward along the opposite source path on retry.
  // This keeps tangent-qualified source midpoints instead of smoothing the line.
  const candidate = trimRampAttachmentOverhangs(
    reciprocalPathMidpoints(first, second, start, end, true),
  );
  const after = rampBendMetrics(candidate);
  if (
    after.backwards >= before.backwards ||
    after.maximum >= before.maximum ||
    hasProperSelfIntersection(candidate)
  )
    return coordinates;
  return candidate;
}

export function averageReciprocalPathCoordinates(first, second, start, end) {
  const coordinates = directionalReciprocalPathCoordinates(first, second, start, end);
  const before = rampBendMetrics(coordinates);
  if (!before.backwards) return coordinates;
  // A cutoff around a loop can give the forward correspondence a different
  // set of closest tangent anchors. Try the same source calculation from the
  // other end; retain it only when the complete attached curve improves.
  const candidate = directionalReciprocalPathCoordinates(
    first.toReversed(),
    second.toReversed(),
    end,
    start,
  ).reverse();
  const after = rampBendMetrics(candidate);
  return after.backwards < before.backwards &&
    after.maximum < before.maximum &&
    !hasProperSelfIntersection(candidate)
    ? candidate
    : coordinates;
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

function haveOpposingCarriageways(first, second, pairedChains, directionPenalty) {
  const firstChains = first.carriagewayIds ?? [];
  const secondChains = second.carriagewayIds ?? [];
  // Source pairs remain opposed through a bend, even when their ramp joins
  // are far apart and local headings alone cannot identify the return leg.
  if (firstChains.some((a) => secondChains.some((b) => pairedChains.get(a)?.has(b))))
    return true;
  // A long source chain can curve around a ring and face the other way.
  // Sharing a chain (or a partner elsewhere) does not determine the local
  // travel side. Without a direct source pair, require the same opposing
  // tangent alignment used to pair mainlines, not merely different headings.
  return directionPenalty <= (1 - MIN_PAIRED_TANGENT_ALIGNMENT) * 0.5;
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

function shareDirectedSourceEdges(first, second) {
  const edges = new Set(
    (first.nodeIds ?? []).slice(1).map((id, index) => `${first.nodeIds[index]}:${id}`),
  );
  return (second.nodeIds ?? []).some(
    (id, index) => index > 0 && edges.has(`${second.nodeIds[index - 1]}:${id}`),
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
    // A return may share collectors with another movement, but the two sides
    // of one reciprocal pair cannot travel along the same one-way pavement.
    if (shareDirectedSourceEdges(...pair)) continue;
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

export function shortenReciprocalMatches(matches, candidates, groupByPartIndex) {
  const pairs = [...matches];
  const used = new Set(pairs.flat());
  const length = (pair) => pair[0].distanceMeters + pair[1].distanceMeters;
  const sameSourceLegs = (first, second) =>
    ['firstAttachment', 'secondAttachment'].every(
      (end) =>
        sameMainlineLeg(first[end], second[end], groupByPartIndex) &&
        first[end].carriagewayIds?.some((id) =>
          second[end].carriagewayIds?.includes(id),
        ),
    );
  const ordered = [...candidates].sort(
    (first, second) => length(first) - length(second),
  );
  let changed;
  do {
    changed = false;
    for (const [index, pair] of pairs.entries()) {
      const shorter = ordered.find(
        (candidate) =>
          length(candidate) < length(pair) - 0.001 &&
          candidate.every(
            (path, direction) =>
              (path === pair[direction] || !used.has(path)) &&
              (sameDirectedRampMovement(path, pair[direction], groupByPartIndex) ||
                // Separate collectors need not share pavement. An identical
                // opposite path fixes the movement; source carriageways at
                // both ends then prove that the shorter side serves it too.
                (candidate[1 - direction] === pair[1 - direction] &&
                  sameSourceLegs(path, pair[direction]))),
          ),
      );
      if (!shorter) continue;
      for (const path of pair) used.delete(path);
      for (const path of shorter) used.add(path);
      pairs[index] = shorter;
      changed = true;
    }
    // A replacement can free a direction for a different matched movement.
    // Every change strictly reduces total ramp distance, so this converges.
  } while (changed);
  return pairs;
}

function mainlineLegContinuation(osm, parts, chains, graph) {
  // Opposing ramp joins can straddle a change of paired source intervals.
  // Follow actual motorway pavement near those ends to find a median interval
  // shared by both sides; another nearby road or an overpass is insufficient.
  let owners;
  const cache = new Map();
  const reachable = (attachment, maximumMeters) => {
    const key = `${attachment.nodeId}:${maximumMeters}:${attachment.travelDirections.flat().join()}`;
    if (cache.has(key)) return cache.get(key);
    owners ??= indexPartsBySourceNode(parts, chains);
    const result = new Set();
    for (const [edges, sign] of [
      [graph.forward, 1],
      [graph.backward, -1],
    ]) {
      const queue = new MinimumDistanceHeap();
      const distances = new Map([[attachment.nodeId, 0]]);
      queue.push({
        nodeId: attachment.nodeId,
        distanceMeters: 0,
        directions: attachment.travelDirections.map((d) => d.map((v) => v * sign)),
      });
      while (queue.size) {
        const current = queue.pop();
        if (
          current.distanceMeters !== distances.get(current.nodeId) ||
          blockingTrafficSignal(osm.nodes.get(current.nodeId))
        )
          continue;
        for (const index of owners.get(current.nodeId) ?? []) result.add(index);
        for (const edge of edges.get(current.nodeId) ?? []) {
          if (
            !current.directions.some(
              (direction) =>
                dot(direction, edge.direction) >= MIN_PAIRED_TANGENT_ALIGNMENT,
            )
          )
            continue;
          const distanceMeters =
            current.distanceMeters +
            geodesicDistanceMeters(
              osm.nodes.get(current.nodeId).coordinate,
              edge.coordinate,
            );
          if (
            distanceMeters > maximumMeters ||
            distanceMeters >= (distances.get(edge.nextNodeId) ?? Infinity)
          )
            continue;
          distances.set(edge.nextNodeId, distanceMeters);
          queue.push({
            nodeId: edge.nextNodeId,
            distanceMeters,
            directions: [edge.direction],
          });
        }
      }
    }
    cache.set(key, result);
    return result;
  };
  return (first, second, gap) => {
    if (first.partIndex === second.partIndex) return true;
    const firstPart = parts[first.partIndex],
      secondPart = parts[second.partIndex];
    const nearestEnds = Math.min(
      ...[firstPart.coordinates[0], firstPart.coordinates.at(-1)].flatMap((a) =>
        [secondPart.coordinates[0], secondPart.coordinates.at(-1)].map((b) =>
          geodesicDistanceMeters(a, b),
        ),
      ),
    );
    const sameSourcePair =
      firstPart.sourceChainId &&
      firstPart.pairedChainId &&
      [firstPart.sourceChainId, firstPart.pairedChainId].sort().join(':') ===
        [secondPart.sourceChainId, secondPart.pairedChainId].sort().join(':');
    if (!sameSourcePair && nearestEnds > PAIR_SEARCH_METERS) return false;
    const nearTerminal = [
      [first, firstPart],
      [second, secondPart],
    ].some(
      ([attachment, part]) =>
        Math.min(
          geodesicDistanceMeters(attachment.coordinate, part.coordinates[0]),
          geodesicDistanceMeters(attachment.coordinate, part.coordinates.at(-1)),
        ) <= SAMPLE_SPACING_METERS,
    );
    if (!sameSourcePair && !nearTerminal) return false;
    const maximumMeters = Math.min(
      MAX_RECIPROCAL_ENDPOINT_GAP_METERS,
      Math.ceil((gap + 2 * PAIR_SEARCH_METERS) / SAMPLE_SPACING_METERS) *
        SAMPLE_SPACING_METERS,
    );
    const a = reachable(first, maximumMeters),
      b = reachable(second, maximumMeters);
    return [first.partIndex, second.partIndex].some(
      (index) => a.has(index) && b.has(index),
    );
  };
}

export function findReciprocalMainlineContinuations({
  osm,
  parts,
  paths,
  establishedPairs,
  mainlineWays = prepareWays(osm).mainlines,
  chains = traceMotorwayChains(mainlineWays),
  continuationGraph = mainlineContinuationGraph(osm, mainlineWays),
}) {
  const pairedChains = new Map();
  for (const part of parts)
    for (const [a, b] of [
      [part.sourceChainId, part.pairedChainId],
      [part.pairedChainId, part.sourceChainId],
    ]) {
      if (!a || !b) continue;
      const opposites = pairedChains.get(a) ?? new Set();
      opposites.add(b);
      pairedChains.set(a, opposites);
    }
  const sameLeg = mainlineLegContinuation(osm, parts, chains, continuationGraph);
  const identity = (path) => path.nodeIds.join(':');
  const used = new Set(establishedPairs.flat().map(identity));
  const remaining = paths.filter((path) => !used.has(identity(path)));
  const candidates = [];
  for (let i = 0; i < remaining.length; i += 1) {
    const first = remaining[i];
    for (let j = i + 1; j < remaining.length; j += 1) {
      const second = remaining[j];
      const legs = [
        [first.firstAttachment, second.secondAttachment],
        [first.secondAttachment, second.firstAttachment],
      ];
      // A known common leg anchors this fallback. The other leg may span a
      // split median, but proximity or a shared road-chain name cannot join it.
      const identical = legs.map(([a, b]) => a.partIndex === b.partIndex);
      if (!identical.some(Boolean) || identical.every(Boolean)) continue;
      // A padded degree bound avoids geodesic work for distant pairs while
      // retaining the full 2.5 km search radius at each latitude.
      if (
        legs.some(
          ([a, b]) =>
            Math.abs(a.coordinate[1] - b.coordinate[1]) > 0.025 ||
            Math.abs(a.coordinate[0] - b.coordinate[0]) *
              Math.cos((a.coordinate[1] * Math.PI) / 180) >
              0.025,
        )
      )
        continue;
      const gaps = legs.map(([a, b]) =>
        geodesicDistanceMeters(a.coordinate, b.coordinate),
      );
      if (gaps.some((gap) => gap > MAX_RECIPROCAL_ENDPOINT_GAP_METERS)) continue;
      const penalties = legs.map(([a, b]) => reciprocalDirectionPenalty(a, b));
      if (
        legs.some(
          ([a, b], index) =>
            !haveOpposingCarriageways(a, b, pairedChains, penalties[index]) ||
            a.carriagewayIds?.some((id) => b.carriagewayIds?.includes(id)),
        )
      )
        continue;
      if (!legs.every(([a, b], index) => sameLeg(a, b, gaps[index]))) continue;
      candidates.push({
        pair: [first, second],
        score:
          gaps[0] +
          gaps[1] +
          penalties.reduce((a, b) => a + b, 0) * MAX_RECIPROCAL_ENDPOINT_GAP_METERS * 8,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      a.pair.reduce((s, p) => s + p.distanceMeters, 0) -
        b.pair.reduce((s, p) => s + p.distanceMeters, 0),
  );
  const pairs = [];
  for (const { pair } of candidates) {
    if (pair.some((path) => used.has(identity(path)))) continue;
    pair.forEach((path) => used.add(identity(path)));
    pairs.push(pair);
  }
  const groups = mainlineGroupByPartIndex(parts);
  return selectShortestReciprocalMovements(
    shortenReciprocalMatches(
      pairs,
      candidates.map((candidate) => candidate.pair),
      groups,
    ),
    groups,
  );
}

function reciprocalPathPairs(paths, groupByPartIndex, pairedChains) {
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
  const alternativeCandidates = [];
  for (const group of groups.values()) {
    const candidates = [];
    for (const first of group.forward) {
      for (const second of group.reverse) {
        if (shareDirectedSourceEdges(first.path, second.path)) continue;
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
        // Reciprocity is required at both highway legs, before proximity or
        // heading scores can select an exit/entrance using the same travel side.
        if (
          !haveOpposingCarriageways(
            first.path.firstAttachment,
            second.path.secondAttachment,
            pairedChains,
            firstDirectionPenalty,
          ) ||
          !haveOpposingCarriageways(
            first.path.secondAttachment,
            second.path.firstAttachment,
            pairedChains,
            secondDirectionPenalty,
          )
        )
          continue;
        candidates.push({
          first,
          pair: [first.path, second.path],
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
    const matches = [];
    for (const candidate of candidates) {
      if (used.has(candidate.first.pathIndex) || used.has(candidate.second.pathIndex)) {
        continue;
      }
      used.add(candidate.first.pathIndex);
      used.add(candidate.second.pathIndex);
      matches.push(candidate.pair);
    }
    // Keep the reciprocal assignments, then compare ALL paths for each
    // movement, including alternatives that share its already-matched return.
    // A shorter collector must not steal a path from a different movement.
    const shorter = shortenReciprocalMatches(
      matches,
      candidates.map((candidate) => candidate.pair),
      groupByPartIndex,
    );
    pairs.push(...shorter);
    alternativeCandidates.push(...matches);
  }
  const distinctPairs = selectShortestReciprocalMovements(pairs, groupByPartIndex);
  const retained = new Set(distinctPairs);
  alternativeCandidates.push(...pairs.filter((pair) => !retained.has(pair)));
  const selectedPaths = new Set(distinctPairs.flat());
  const alternativePaths = [...new Set(alternativeCandidates.flat())].filter(
    (path) => !selectedPaths.has(path),
  );
  return {
    alternativePaths,
    alternativePathCount: alternativePaths.length,
    pairs: distinctPairs,
    unpairedPathCount: paths.length - selectedPaths.size - alternativePaths.length,
  };
}

export function outerReciprocalAttachment(first, second, parts, atStart) {
  // In the forward path's travel direction, start at the earlier split and end
  // at the later merge. The shorter ramp is extended along its own carriageway.
  const part = parts[first.partIndex];
  const segment = first.segmentIndex;
  const direction =
    first.travelDirections?.[0] ??
    vector(part.coordinates[segment], part.coordinates[segment + 1]);
  const tangents = [vector(part.coordinates[segment], part.coordinates[segment + 1])];
  // An attachment exactly on a vertex can project onto either adjacent
  // segment. Use the tangent that agrees most closely with the source road;
  // a short junction offset must not reverse the highway's travel direction.
  for (const [vertex, adjacent] of [
    [segment, segment - 1],
    [segment + 1, segment + 1],
  ]) {
    if (
      adjacent >= 0 &&
      adjacent + 1 < part.coordinates.length &&
      geodesicDistanceMeters(first.coordinate, part.coordinates[vertex]) < 0.25
    ) {
      tangents.push(vector(part.coordinates[adjacent], part.coordinates[adjacent + 1]));
    }
  }
  const partDirection = tangents.sort(
    (a, b) => Math.abs(dot(b, direction)) - Math.abs(dot(a, direction)),
  )[0];
  const alongTravel =
    first.partIndex === second.partIndex
      ? (second.distanceAlongPartMeters - first.distanceAlongPartMeters) *
        dot(partDirection, direction)
      : dot(vector(first.coordinate, second.coordinate), direction);
  return alongTravel >= 0 === atStart ? first : second;
}

export function rampAttachmentTravelDirection(part, attachment) {
  const sourceDirection = attachment.travelDirections?.[0];
  if (!sourceDirection) {
    throw new Error('A ramp attachment requires source travel direction.');
  }
  let nearest = Infinity;
  let alignment = 0;
  // A source attachment can appear twice at a closed parent or shared merge.
  // Check all coincident tangents, not just its original segment index.
  for (let index = 1; index < part.coordinates.length; index += 1) {
    const a = part.coordinates[index - 1];
    const b = part.coordinates[index];
    const meters = geodesicDistanceMeters(
      attachment.coordinate,
      projectCoordinateOntoSegment(attachment.coordinate, a, b),
    );
    const candidate = dot(vector(a, b), sourceDirection);
    if (
      meters < nearest - 0.25 ||
      (meters <= nearest + 0.25 && Math.abs(candidate) > Math.abs(alignment))
    ) {
      nearest = meters;
      alignment = candidate;
    }
  }
  return Math.sign(alignment);
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
    const sourceNodes = indexPartsBySourceNode(
      averagedParts,
      traceMotorwayChains(prepared.mainlines),
    );
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
                mainlinePartIndices: supportedPartsAtNode(
                  averagedParts,
                  eligiblePartIndices,
                  sourceNodes,
                  nodeId,
                ),
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
  const sourceNodes = indexPartsBySourceNode(
    averagedParts,
    traceMotorwayChains(prepared.mainlines),
  );
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
      return existingIndex;
    }
    edgeIndexByKey.set(key, edges.length);
    edges.push({
      fromId,
      partIndices: new Set([partIndex]),
      toId,
    });
    return edges.length - 1;
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
              mainlinePartIndices: supportedPartsAtNode(
                averagedParts,
                eligiblePartIndices,
                sourceNodes,
                nodeId,
              ),
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

  const turnJunctions = new Map();
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
      const edgeIndex = addEdge(
        graphNodes[index - 1].id,
        graphNodes[index].id,
        partIndex,
      );
      for (const [atEndpoint, node, mainlinePartIndex, direction] of [
        [
          index === 1,
          startNode,
          connector.startMainlinePartIndex,
          connector.startMainlineDirection,
        ],
        [
          index === graphNodes.length - 1,
          endNode,
          connector.endMainlinePartIndex,
          connector.endMainlineDirection,
        ],
      ]) {
        if (!atEndpoint || direction === undefined || edgeIndex === undefined) continue;
        const port = { mainlineId: `mainline:${mainlinePartIndex}`, direction };
        const edge = edges[edgeIndex];
        edge[edge.fromId === node.id ? 'fromTurnPort' : 'toTurnPort'] = port;
        turnJunctions.set(node.id, { mainlinePartIndex, coordinate: node.coordinate });
      }
    }
  }

  // At a paired-ramp endpoint, the mainline has two distinct legs. Preserve
  // those ports when contracting the graph; an undirected junction alone
  // would also permit entering a ramp by reversing across the median.
  for (const edge of edges) {
    for (const [nodeId, otherId, field] of [
      [edge.fromId, edge.toId, 'fromTurnPort'],
      [edge.toId, edge.fromId, 'toTurnPort'],
    ]) {
      const junction = turnJunctions.get(nodeId);
      if (!junction || edge[field]) continue;
      const part = averagedParts[junction.mainlinePartIndex];
      const prefix = `center:${junction.mainlinePartIndex}:`;
      const direction =
        nodeId.startsWith(prefix) && otherId.startsWith(prefix)
          ? Math.sign(
              Number(otherId.slice(prefix.length)) -
                Number(nodeId.slice(prefix.length)),
            )
          : rampAttachmentTravelDirection(part, {
              coordinate: junction.coordinate,
              travelDirections: [
                vector(junction.coordinate, coordinateByNodeId.get(otherId)),
              ],
            });
      edge[field] = { mainlineId: `mainline:${junction.mainlinePartIndex}`, direction };
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
    // a single merge. A source-proven continuation uses the same endpoint
    // replacement as a branch, so it cannot overshoot and revisit its terminal.
    if (
      (!group.junctions.some((junction) => junction.branch) &&
        group.junctions.some((junction) =>
          junction.attachments.some((entry) => !parts[entry.partIndex].sourceRanges),
        )) ||
      group.endpoints.size === 0 ||
      [...group.endpoints.values()].some((endpoints) => endpoints.size > 1)
    )
      continue;
    group.proposed = [];
    const attachments = group.junctions.flatMap((junction) => junction.attachments);
    // Both directional source merges can clamp to the same branch terminal.
    // They describe one centerline junction, including any existing split-part
    // endpoint keys. Do not append them and then revisit the old terminal.
    const branches = group.junctions.filter((junction) => junction.branch);
    const positions = (branches.length > 0 ? branches : group.junctions).map(
      (junction) => junction.coordinate,
    );
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

function indexPartsBySourceNode(parts, chains, branchNodes = new Set()) {
  const chainById = new Map(chains.map((chain) => [chain.id, chain]));
  const partById = new Map(parts.map((part) => [part.id, part]));
  const indices = new Map();
  for (const [partIndex, part] of parts.entries()) {
    let ranges = part.sourceRanges ?? [];
    if (part.continuationEndpoints) {
      const before = partById.get(part.continuationEndpoints.beforeId);
      const after = partById.get(part.continuationEndpoints.afterId);
      ranges = (before?.sourceRanges ?? []).flatMap((range) => {
        const other = after?.sourceRanges?.find(
          (entry) => entry.chainId === range.chainId,
        );
        return other
          ? [
              {
                chainId: range.chainId,
                positions: [
                  Math.min(Math.max(...range.positions), Math.max(...other.positions)),
                  Math.max(Math.min(...range.positions), Math.min(...other.positions)),
                ],
              },
            ]
          : [];
      });
    }
    for (const range of ranges) {
      const chain = chainById.get(range.chainId);
      if (!chain) continue;
      const start = Math.max(0, Math.floor(Math.min(...range.positions)));
      const end = Math.min(
        chain.nodeIds.length - 1,
        Math.ceil(Math.max(...range.positions)),
      );
      const add = (position) => {
        const nodeId = chain.nodeIds[position];
        const owners = indices.get(nodeId) ?? new Set();
        owners.add(partIndex);
        indices.set(nodeId, owners);
      };
      for (let position = start; position <= end; position += 1) add(position);
      // At staggered directional merges, the displayed median can end before
      // one of the physical joins. Follow that same source road to the join;
      // geographic proximity to another turn of a ring road is insufficient.
      for (const [boundary, step, limit] of [
        [start, -1, Math.min(...range.positions)],
        [end, 1, Math.max(...range.positions)],
      ]) {
        const segment = Math.min(chain.coordinates.length - 2, Math.floor(limit));
        const fraction = limit - segment;
        const a = chain.coordinates[segment],
          b = chain.coordinates[segment + 1];
        const coordinate = [
          a[0] + (b[0] - a[0]) * fraction,
          a[1] + (b[1] - a[1]) * fraction,
        ];
        let distance = geodesicDistanceMeters(coordinate, chain.coordinates[boundary]);
        for (
          let position = boundary + step;
          position >= 0 && position < chain.nodeIds.length;
          position += step
        ) {
          distance += geodesicDistanceMeters(
            chain.coordinates[position - step],
            chain.coordinates[position],
          );
          if (distance > PAIR_SEARCH_METERS) break;
          if (branchNodes.has(chain.nodeIds[position])) add(position);
        }
      }
    }
  }
  return indices;
}

function supportedPartsAtNode(parts, eligible, sourceNodes, nodeId) {
  return new Set(
    [...eligible].filter(
      (index) => !parts[index].sourceRanges || sourceNodes.get(nodeId)?.has(index),
    ),
  );
}

function redundantMainlineSplit(parts, attachments) {
  return attachments.every((first, index) =>
    attachments.slice(index + 1).every((second) => {
      const a = parts[first.partIndex];
      const b = parts[second.partIndex];
      if (!a.sourceRanges || !b.sourceRanges) return false;
      const keys = new Set([
        ...(a.startTopologyKeys ?? []),
        ...(a.endTopologyKeys ?? []),
      ]);
      if (
        [...(b.startTopologyKeys ?? []), ...(b.endTopologyKeys ?? [])].some((key) =>
          keys.has(key),
        )
      )
        return true;
      return a.sourceRanges.some((range) =>
        b.sourceRanges.some(
          (other) =>
            range.chainId === other.chainId &&
            Math.min(Math.max(...range.positions), Math.max(...other.positions)) >
              Math.max(Math.min(...range.positions), Math.min(...other.positions)) +
                1e-9,
        ),
      );
    }),
  );
}

export function connectMainlinePartsAtSourceNodes(
  osm,
  mainlineWays,
  parts,
  chains = parts.some((part) => part.sourceRanges)
    ? traceMotorwayChains(mainlineWays)
    : [],
) {
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
      chains,
    );
    attachWidePairContinuations(existingParts, continuations);
    parts.splice(0, parts.length, ...existingParts);
    return statistics;
  }
  const wayById = new Map(mainlineWays.map((way) => [way.id, way]));
  const sourceWayIdToPartIndices = indexPartsBySourceWay(parts);
  // A chain can loop back across itself on a different bridge. Its complete
  // way list is provenance, not evidence that every displayed interval meets
  // every node on that chain. Only the represented source interval can join.
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
  const neighborsByNode = new Map();
  for (const [nodeId, wayIds] of wayIdsByNodeId) {
    if (wayIds.size < 2) continue;
    const neighbors = new Set();
    for (const wayId of wayIds) {
      const way = wayById.get(wayId);
      for (const [index, id] of way.nodeIds.entries()) {
        if (id !== nodeId) continue;
        if (index > 0) neighbors.add(way.nodeIds[index - 1]);
        if (index + 1 < way.nodeIds.length) neighbors.add(way.nodeIds[index + 1]);
      }
    }
    neighborsByNode.set(nodeId, neighbors.size);
  }
  const sourceNodeIdToPartIndices = indexPartsBySourceNode(
    parts,
    chains,
    new Set([...neighborsByNode].filter(([, count]) => count > 2).map(([id]) => id)),
  );
  const junctions = [];
  for (const [nodeId, wayIds] of wayIdsByNodeId) {
    if (wayIds.size < 2) continue;
    const partIndices = new Set(
      [...wayIds].flatMap((wayId) => sourceWayIdToPartIndices.get(wayId) ?? []),
    );
    for (const partIndex of partIndices) {
      if (
        parts[partIndex].sourceRanges &&
        !sourceNodeIdToPartIndices.get(nodeId)?.has(partIndex)
      ) {
        partIndices.delete(partIndex);
      }
    }
    if (partIndices.size < 2) continue;
    const attachments = attachmentsForNodeByPart({
      grid: partSegmentGrid,
      mainlinePartIndices: partIndices,
      nodeCoordinate: osm.nodes.get(nodeId).coordinate,
    });
    if (attachments.length < 2) continue;
    const neighborCount = neighborsByNode.get(nodeId);
    if (neighborCount === 2 && redundantMainlineSplit(parts, attachments)) continue;
    junctions.push({
      attachments,
      nodeId,
      coordinate: osm.nodes.get(nodeId).coordinate,
      branch: neighborCount > 2,
    });
  }
  joinMainlineJunctions(parts, partSegmentGrid, junctions);
  return { junctionCount: junctions.length };
}

function rampAttachmentResolver(
  osm,
  parts,
  sourceParts,
  grid,
  continuationGraph,
  sourceNodes,
  rampGraph,
) {
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
        const mapped = [
          ...supportedPartsAtNode(
            parts,
            new Set(sourceParts.get(edge.wayId) ?? []),
            sourceNodes,
            current.nodeId,
          ),
        ];
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
  // Where a represented pair ends before a ramp root, follow real motorway
  // edges upstream of an exit or downstream of an entrance. A distant point
  // on the same source chain is not sufficient evidence for a direct snap.
  const recover = (nodeId, group) => {
    const outgoing = (rampGraph.outgoing.get(nodeId) ?? []).length > 0;
    const incoming = (rampGraph.incident.get(nodeId) ?? []).some(
      (i) => rampGraph.edges[i].toId === nodeId,
    );
    if (outgoing === incoming) return null;
    const graph = outgoing ? continuationGraph.backward : continuationGraph.forward;
    const queue = new MinimumDistanceHeap();
    const distances = new Map([[nodeId, 0]]);
    queue.push({ nodeId, distanceMeters: 0 });
    while (queue.size) {
      const current = queue.pop();
      if (current.distanceMeters !== distances.get(current.nodeId)) continue;
      if (current.nodeId !== nodeId) {
        const indices = new Set(
          [...(sourceNodes.get(current.nodeId) ?? [])].filter(
            (index) => group === null || groups.get(index) === group,
          ),
        );
        if (indices.size) {
          const attachment = attachmentForNode({
            grid,
            mainlinePartIndices: indices,
            nodeCoordinate: osm.nodes.get(current.nodeId).coordinate,
          });
          if (attachment)
            return {
              ...attachment,
              inferredCorridor: true,
              recoveredAtNode: current.nodeId,
            };
        }
      }
      for (const edge of graph.get(current.nodeId) ?? []) {
        const distanceMeters =
          current.distanceMeters +
          geodesicDistanceMeters(
            osm.nodes.get(current.nodeId).coordinate,
            edge.coordinate,
          );
        if (
          distanceMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS ||
          distanceMeters >= (distances.get(edge.nextNodeId) ?? Infinity)
        )
          continue;
        distances.set(edge.nextNodeId, distanceMeters);
        queue.push({ nodeId: edge.nextNodeId, distanceMeters });
      }
    }
    return null;
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
    const attachment =
      group === null
        ? null
        : attachmentForNode({
            grid,
            mainlinePartIndices: partsByGroup.get(group),
            nodeCoordinate,
          });
    if (!attachment) {
      const recovered = recover(nodeId, group);
      if (!recovered) return direct;
      originalByNode.set(nodeId, null);
      return recovered;
    }
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

function throughConnectionExtendsMainline(coordinates, firstPart, secondPart) {
  // A terminal can already extend into the other part at a source junction.
  // Extend at least one terminal: two outward ends bridge a gap; one outward
  // end merges into a continuing mainline. Returning into both existing parts
  // would draw a duplicate segment across overlapping tails.
  return [
    [firstPart, coordinates[0], coordinates[1]],
    [secondPart, coordinates.at(-1), coordinates.at(-2)],
  ].some(([part, endpoint, next]) => {
    const atStart =
      geodesicDistanceMeters(endpoint, part.coordinates[0]) <=
      geodesicDistanceMeters(endpoint, part.coordinates.at(-1));
    const points = atStart ? part.coordinates : part.coordinates.toReversed();
    const inside = points.find(
      (coordinate) => geodesicDistanceMeters(coordinate, points[0]) > 1,
    );
    return (
      inside &&
      dot(vector(inside, points[0]), vector(endpoint, next)) >=
        MIN_PAIRED_TANGENT_ALIGNMENT
    );
  });
}

function throughMainlineReturn(path, osm, waysById, parts, graph) {
  // At least one terminal must extend into a gap. The other endpoint may
  // join a continuing mainline, provided both ends share an actual opposing
  // source road and that road connects them in the correct travel direction.
  const firstPart = parts[path.firstAttachment.partIndex];
  const secondPart = parts[path.secondAttachment.partIndex];
  if (
    ![
      [path.firstAttachment, firstPart],
      [path.secondAttachment, secondPart],
    ].some(
      ([attachment, part]) =>
        Math.min(
          geodesicDistanceMeters(attachment.coordinate, part.coordinates[0]),
          geodesicDistanceMeters(attachment.coordinate, part.coordinates.at(-1)),
        ) <= SAMPLE_SPACING_METERS,
    )
  )
    return null;
  const sharedWays = new Set(
    firstPart.sourceWayIds.filter((id) => secondPart.sourceWayIds.includes(id)),
  );
  if (sharedWays.size === 0) return null;
  const oppositeSeed = (attachment) => {
    const origin = osm.nodes.get(attachment.nodeId).coordinate;
    let seed = null;
    for (const wayId of sharedWays) {
      const way = waysById.get(wayId);
      if (!way) continue;
      const coordinates =
        way.coordinates ?? way.nodeIds.map((id) => osm.nodes.get(id).coordinate);
      for (const [index, nodeId] of way.nodeIds.entries()) {
        const coordinate = coordinates[index];
        if (Math.abs(coordinate[1] - origin[1]) > 0.002) continue;
        const distanceMeters = geodesicDistanceMeters(origin, coordinate);
        if (distanceMeters > PAIR_SEARCH_METERS) continue;
        const direction = travelDirectionAtNode(coordinates, index);
        if (
          !(attachment.travelDirections ?? []).some(
            (other) => dot(direction, other) < -MIN_PAIRED_TANGENT_ALIGNMENT,
          )
        )
          continue;
        if (
          !seed ||
          distanceMeters < seed.distanceMeters ||
          (distanceMeters === seed.distanceMeters && nodeId < seed.nodeId)
        )
          seed = { nodeId, distanceMeters, direction };
      }
    }
    return seed;
  };
  const start = oppositeSeed(path.secondAttachment);
  const end = oppositeSeed(path.firstAttachment);
  if (!start || !end || start.nodeId === end.nodeId) return null;
  const queue = new MinimumDistanceHeap();
  const distances = new Map([[start.nodeId, 0]]);
  const previous = new Map();
  queue.push({ nodeId: start.nodeId, distanceMeters: 0 });
  let found = false;
  while (queue.size > 0) {
    const current = queue.pop();
    if (distances.get(current.nodeId) !== current.distanceMeters) continue;
    if (blockingTrafficSignal(osm.nodes.get(current.nodeId))) continue;
    if (current.nodeId === end.nodeId) {
      found = true;
      break;
    }
    for (const edge of graph.forward.get(current.nodeId) ?? []) {
      if (!sharedWays.has(edge.wayId)) continue;
      const incoming = previous.get(current.nodeId)?.direction ?? start.direction;
      if (dot(incoming, edge.direction) < MIN_PAIRED_TANGENT_ALIGNMENT) continue;
      const distanceMeters =
        current.distanceMeters +
        geodesicDistanceMeters(
          osm.nodes.get(current.nodeId).coordinate,
          edge.coordinate,
        );
      if (
        distanceMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS ||
        distanceMeters >= (distances.get(edge.nextNodeId) ?? Infinity)
      )
        continue;
      distances.set(edge.nextNodeId, distanceMeters);
      previous.set(edge.nextNodeId, { ...edge, nodeId: current.nodeId });
      queue.push({ nodeId: edge.nextNodeId, distanceMeters });
    }
  }
  if (!found) return null;
  const nodeIds = [end.nodeId];
  const sourceWayIds = [];
  while (previous.has(nodeIds.at(-1))) {
    const edge = previous.get(nodeIds.at(-1));
    sourceWayIds.push(edge.wayId);
    nodeIds.push(edge.nodeId);
  }
  nodeIds.reverse();
  return {
    coordinates: nodeIds.map((id) => osm.nodes.get(id).coordinate),
    distanceMeters: distances.get(end.nodeId),
    edgeIndices: nodeIds
      .slice(1)
      .map((id, index) => `mainline:${nodeIds[index]}:${id}`),
    firstAttachment: {
      ...path.secondAttachment,
      nodeId: start.nodeId,
      travelDirections: [start.direction],
    },
    secondAttachment: {
      ...path.firstAttachment,
      nodeId: end.nodeId,
      travelDirections: [end.direction],
    },
    throughMainline: true,
    nodeIds,
    sourceWayIds: [...new Set(sourceWayIds)],
  };
}

function mixedMainlineReturn(path, osm, waysById, parts, graph, grid, sourceParts) {
  // A motorway may narrow to one lane in only one direction, while the
  // reverse direction remains classified as mainline. Follow its established
  // opposing carriageway to an explicit junction on the other highway.
  for (const atStart of [true, false]) {
    const branch = atStart ? path.firstAttachment : path.secondAttachment;
    const through = atStart ? path.secondAttachment : path.firstAttachment;
    const part = parts[branch.partIndex];
    // Allow one sample of terminal projection tolerance on the averaged line.
    if (
      Math.min(
        geodesicDistanceMeters(branch.coordinate, part.coordinates[0]),
        geodesicDistanceMeters(branch.coordinate, part.coordinates.at(-1)),
      ) > SAMPLE_SPACING_METERS
    )
      continue;
    const origin = osm.nodes.get(branch.nodeId).coordinate;
    const sourceWays = new Set(part.sourceWayIds);
    const targetWays = new Set(parts[through.partIndex].sourceWayIds);
    // Shared source ways already describe a through corridor, not a missing
    // reciprocal merge between two different highways.
    if ([...sourceWays].some((id) => targetWays.has(id))) continue;
    let seed = null;
    for (const wayId of sourceWays) {
      const way = waysById.get(wayId);
      if (!way) continue;
      const coordinates =
        way.coordinates ?? way.nodeIds.map((id) => osm.nodes.get(id).coordinate);
      for (const [index, nodeId] of way.nodeIds.entries()) {
        const coordinate = coordinates[index];
        if (Math.abs(coordinate[1] - origin[1]) > 0.002) continue;
        const distanceMeters = geodesicDistanceMeters(origin, coordinate);
        if (distanceMeters > PAIR_SEARCH_METERS) continue;
        const direction = travelDirectionAtNode(coordinates, index);
        if (
          !(branch.travelDirections ?? []).some(
            (other) => dot(direction, other) < -MIN_PAIRED_TANGENT_ALIGNMENT,
          )
        )
          continue;
        if (
          !seed ||
          distanceMeters < seed.distanceMeters ||
          (distanceMeters === seed.distanceMeters && nodeId < seed.nodeId)
        )
          seed = { nodeId, distanceMeters, direction };
      }
    }
    if (!seed) continue;
    const searchGraph = atStart ? graph.backward : graph.forward;
    const queue = new MinimumDistanceHeap();
    const distances = new Map([[seed.nodeId, 0]]);
    const previous = new Map();
    queue.push({ nodeId: seed.nodeId, distanceMeters: 0 });
    let found = null;
    while (queue.size > 0) {
      const current = queue.pop();
      if (distances.get(current.nodeId) !== current.distanceMeters) continue;
      if (blockingTrafficSignal(osm.nodes.get(current.nodeId))) continue;
      const allEdges = [
        ...(graph.forward.get(current.nodeId) ?? []),
        ...(graph.backward.get(current.nodeId) ?? []),
      ];
      const targetParts = new Set(
        allEdges
          .filter((edge) => targetWays.has(edge.wayId))
          .flatMap((edge) => sourceParts.get(edge.wayId) ?? []),
      );
      if (current.nodeId !== seed.nodeId && targetParts.size > 0) {
        const attachment = attachmentForNode({
          grid,
          mainlinePartIndices: targetParts,
          nodeCoordinate: osm.nodes.get(current.nodeId).coordinate,
        });
        if (attachment) {
          found = { ...current, attachment };
          break;
        }
        continue;
      }
      for (const edge of searchGraph.get(current.nodeId) ?? []) {
        // Stay on the known opposite carriageway. Way splits can introduce
        // an unrepresented segment, but may not switch to another source pair.
        if (!sourceWays.has(edge.wayId) && (sourceParts.get(edge.wayId) ?? []).length)
          continue;
        const incoming =
          previous.get(current.nodeId)?.direction ??
          seed.direction.map((value) => value * (atStart ? -1 : 1));
        if (dot(incoming, edge.direction) < MIN_PAIRED_TANGENT_ALIGNMENT) continue;
        const distanceMeters =
          current.distanceMeters +
          geodesicDistanceMeters(
            osm.nodes.get(current.nodeId).coordinate,
            edge.coordinate,
          );
        if (
          distanceMeters > MAX_RECIPROCAL_ENDPOINT_GAP_METERS ||
          distanceMeters >= (distances.get(edge.nextNodeId) ?? Infinity)
        )
          continue;
        distances.set(edge.nextNodeId, distanceMeters);
        previous.set(edge.nextNodeId, { ...edge, nodeId: current.nodeId });
        queue.push({ nodeId: edge.nextNodeId, distanceMeters });
      }
    }
    if (!found) continue;
    const nodeIds = [found.nodeId];
    const sourceWayIds = [];
    while (previous.has(nodeIds.at(-1))) {
      const edge = previous.get(nodeIds.at(-1));
      sourceWayIds.push(edge.wayId);
      nodeIds.push(edge.nodeId);
    }
    if (!atStart) nodeIds.reverse();
    const branchAttachment = {
      ...branch,
      nodeId: seed.nodeId,
      travelDirections: [seed.direction],
    };
    const direction = atStart
      ? vector(
          osm.nodes.get(nodeIds[0]).coordinate,
          osm.nodes.get(nodeIds[1]).coordinate,
        )
      : vector(
          osm.nodes.get(nodeIds.at(-2)).coordinate,
          osm.nodes.get(nodeIds.at(-1)).coordinate,
        );
    const throughAttachment = {
      ...found.attachment,
      nodeId: found.nodeId,
      travelDirections: [direction],
    };
    if (reciprocalDirectionPenalty(through, throughAttachment) > 0.2) continue;
    return {
      coordinates: nodeIds.map((id) => osm.nodes.get(id).coordinate),
      distanceMeters: found.distanceMeters,
      edgeIndices: nodeIds
        .slice(1)
        .map((id, index) => `mainline:${nodeIds[index]}:${id}`),
      firstAttachment: atStart ? throughAttachment : branchAttachment,
      secondAttachment: atStart ? branchAttachment : throughAttachment,
      mixedMainline: true,
      nodeIds,
      sourceWayIds: [...new Set(sourceWayIds)],
    };
  }
  return null;
}

export function buildRampConnectors(
  osm,
  mainlineWays,
  parts,
  connectorWays,
  chains = [],
) {
  const partSegmentGrid = buildPartSegmentGrid(parts);
  const sourceWayIdToPartIndices = indexPartsBySourceWay(parts);
  const graph = connectorSegmentGraph(connectorWays);
  const continuationGraph = mainlineContinuationGraph(osm, mainlineWays);
  const sourceNodes = indexPartsBySourceNode(parts, chains);
  const resolver = rampAttachmentResolver(
    osm,
    parts,
    sourceWayIdToPartIndices,
    partSegmentGrid,
    continuationGraph,
    sourceNodes,
    graph,
  );
  const mainlinePartIndicesByNode = new Map();
  const mainlineDirectionsByNodeAndPart = new Map();
  const mainlineDirectionsByNode = new Map();
  const carriagewaysByNode = new Map();
  const carriagewaysByNodeAndPart = new Map();
  const chainByWay = new Map(
    chains.flatMap((chain) => chain.sourceWayIds.map((id) => [id, chain.id])),
  );
  const pairedChains = new Map();
  for (const part of parts) {
    if (!part.sourceChainId || !part.pairedChainId) continue;
    for (const [a, b] of [
      [part.sourceChainId, part.pairedChainId],
      [part.pairedChainId, part.sourceChainId],
    ]) {
      const opposites = pairedChains.get(a) ?? new Set();
      opposites.add(b);
      pairedChains.set(a, opposites);
    }
  }
  for (const way of mainlineWays) {
    const partIndices = sourceWayIdToPartIndices.get(way.id) ?? [];
    const wayCoordinates =
      way.coordinates ?? way.nodeIds.map((nodeId) => osm.nodes.get(nodeId).coordinate);
    for (const [nodeIndex, nodeId] of way.nodeIds.entries()) {
      if (!graph.incident.has(nodeId)) continue;
      const direction = travelDirectionAtNode(wayCoordinates, nodeIndex);
      const chainId = chainByWay.get(way.id);
      if (chainId) {
        const ids = carriagewaysByNode.get(nodeId) ?? new Set();
        ids.add(chainId);
        carriagewaysByNode.set(nodeId, ids);
      }
      const nodeDirections = mainlineDirectionsByNode.get(nodeId) ?? [];
      nodeDirections.push(direction);
      mainlineDirectionsByNode.set(nodeId, nodeDirections);
      const indices = mainlinePartIndicesByNode.get(nodeId) ?? new Set();
      for (const partIndex of partIndices) {
        indices.add(partIndex);
        const key = `${nodeId}:${partIndex}`;
        if (chainId) {
          const ids = carriagewaysByNodeAndPart.get(key) ?? new Set();
          ids.add(chainId);
          carriagewaysByNodeAndPart.set(key, ids);
        }
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
    carriagewayIds: [
      ...((attachment.inferredCorridor
        ? carriagewaysByNode.get(nodeId)
        : carriagewaysByNodeAndPart.get(`${nodeId}:${attachment.partIndex}`)) ?? []),
    ],
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
  const established = reciprocalPathPairs(
    originalDirectedPaths,
    groupByPartIndex,
    pairedChains,
  );
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
  const inferred = reciprocalPathPairs(available, groupByPartIndex, pairedChains);
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
  const pairedPaths = new Set(pairs.flat().map(pathIdentity));
  const waysById = new Map(mainlineWays.map((way) => [way.id, way]));
  const connectorById = new Map(connectorWays.map((way) => [way.id, way]));
  const mixedPaths = [];
  const mixedPairs = [];
  const throughPairs = [];
  for (const path of available) {
    if (
      pairedPaths.has(pathIdentity(path)) ||
      !path.sourceWayIds.every(
        (id) => connectorById.get(id)?.tags?.highway === 'motorway',
      )
    )
      continue;
    const reverse = mixedMainlineReturn(
      path,
      osm,
      waysById,
      parts,
      continuationGraph,
      partSegmentGrid,
      sourceWayIdToPartIndices,
    );
    if (!reverse) {
      const through = throughMainlineReturn(
        path,
        osm,
        waysById,
        parts,
        continuationGraph,
      );
      if (through) {
        throughPairs.push([path, through]);
        mixedPaths.push(through);
      }
      continue;
    }
    mixedPairs.push([path, reverse]);
    mixedPaths.push(reverse);
  }
  const shortestMixedPairs = selectShortestReciprocalMovements(
    mixedPairs,
    groupByPartIndex,
  );
  const selectedMixedPairs = new Set(shortestMixedPairs);
  const shortestThroughPairs = selectShortestReciprocalMovements(
    throughPairs,
    groupByPartIndex,
  );
  const selectedThroughPairs = new Set(shortestThroughPairs);
  const alternativeMixedPaths = mixedPairs
    .filter((pair) => !selectedMixedPairs.has(pair))
    .flat();
  alternativeMixedPaths.push(
    ...throughPairs.filter((pair) => !selectedThroughPairs.has(pair)).flat(),
  );
  pairs.push(...shortestMixedPairs);
  pairs.push(...shortestThroughPairs);
  // Existing reciprocal assignments retain their directions. Complete only
  // unmatched pairs whose attachment spans a source-proven mainline split.
  pairs.push(
    ...findReciprocalMainlineContinuations({
      osm,
      parts,
      paths: originalDirectedPaths,
      establishedPairs: pairs,
      mainlineWays,
      chains,
      continuationGraph,
    }),
  );
  let mixedMainlineConnectorCount = 0;
  let throughMainlineConnectorCount = 0;
  for (const [pairIndex, [forward, reverse]] of pairs.entries()) {
    if (shareDirectedSourceEdges(forward, reverse)) continue;
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
      (rampBendMetrics(coordinates).backwards ||
        hasProperSelfIntersection(coordinates) ||
        (reverse.throughMainline &&
          !throughConnectionExtendsMainline(
            coordinates,
            parts[startPartIndex],
            parts[endPartIndex],
          )))
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
      startMainlineDirection:
        rampAttachmentTravelDirection(parts[startPartIndex], startAttachment) *
        (startAttachment === forward.firstAttachment ? 1 : -1),
      endMainlineDirection:
        rampAttachmentTravelDirection(parts[endPartIndex], endAttachment) *
        (endAttachment === reverse.firstAttachment ? 1 : -1),
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
    if (reverse.mixedMainline) {
      connector.mixedMainline = true;
      mixedMainlineConnectorCount += 1;
    }
    if (reverse.throughMainline) {
      connector.throughMainline = true;
      throughMainlineConnectorCount += 1;
    }
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
    [...originalDirectedPaths, ...allDirectedPaths, ...mixedPaths].map(pathIdentity),
  ).size;
  const alternativePathCount = new Set(
    [
      ...established.alternativePaths,
      ...inferred.alternativePaths,
      ...alternativeMixedPaths,
    ]
      .map(pathIdentity)
      .filter((key) => !acceptedPathKeys.has(key)),
  ).size;
  return {
    connectors,
    attachmentRepairs,
    statistics: {
      mixedMainlineConnectorCount,
      throughMainlineConnectorCount,
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

export function buildOsmHighwayCenterlines(osm, onProgress = () => {}) {
  const prepared = prepareWays(osm);
  const chains = traceMotorwayChains(prepared.mainlines);
  const averaged = buildAveragedMainlines(chains);
  const originalParts = structuredClone(averaged.parts);
  let mainlineTopology = connectMainlinePartsAtSourceNodes(
    osm,
    prepared.mainlines,
    averaged.parts,
    chains,
  );
  // Resolve established ramp attachments before adding gap geometry, then
  // anchor each addition to the final endpoints. A wider displayed median
  // must not relocate an existing ramp to a different nearest feature.
  const orderedContinuations = averaged.parts.filter(
    (part) => part.orderedContinuation,
  );
  averaged.parts = averaged.parts.filter((part) => !part.orderedContinuation);
  let ramps = buildRampConnectors(
    osm,
    prepared.mainlines,
    averaged.parts,
    prepared.connectors,
    chains,
  );
  let coveredMerges = coveredMainlineMergePairs(
    originalParts,
    ramps.connectors,
    averaged.parts,
    chains,
  );
  const initial = { parts: averaged.parts, ramps, mainlineTopology };
  let rejectedMergeCount = 0;
  while (coveredMerges.length > 0) {
    onProgress({
      mergeCandidates: coveredMerges.map((merge) => merge.partId),
      rejectedMergeCount,
    });
    const removedIds = new Set(coveredMerges.map((merge) => merge.partId));
    // Each attempt starts from the actual averaged carriageways. Junction
    // insertions made for a rejected proposal must never leak into a retry.
    averaged.parts = structuredClone(
      originalParts.filter(
        (part) => !removedIds.has(part.id) && !part.orderedContinuation,
      ),
    );
    mainlineTopology = connectMainlinePartsAtSourceNodes(
      osm,
      prepared.mainlines,
      averaged.parts,
      chains,
    );
    ramps = buildRampConnectors(
      osm,
      prepared.mainlines,
      averaged.parts,
      prepared.connectors,
      chains,
    );
    const supported = coveredMerges.filter((merge) =>
      ramps.connectors.some(
        (connector) =>
          connector.mixedMainline &&
          [connector.startMainlinePartIndex, connector.endMainlinePartIndex]
            .map((index) => averaged.parts[index].id)
            .sort()
            .join() === [merge.branchId, merge.throughId].sort().join() &&
          connector.sourceWayIds.toSorted().join() ===
            merge.connectorSourceWayIds.toSorted().join(),
      ),
    );
    if (supported.length === coveredMerges.length) break;
    rejectedMergeCount += coveredMerges.length - supported.length;
    onProgress({
      retainedMergePairs: coveredMerges
        .filter((merge) => !supported.includes(merge))
        .map((merge) => merge.partId),
    });
    coveredMerges = supported;
    if (coveredMerges.length === 0) {
      averaged.parts = initial.parts;
      ramps = initial.ramps;
      mainlineTopology = initial.mainlineTopology;
    }
  }
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
      coveredMainlineMergeCount: coveredMerges.length,
      retainedMainlineMergeCount: rejectedMergeCount,
      orderedPairContinuationCount: averaged.parts.filter(
        (part) => part.orderedContinuation,
      ).length,
      ...ramps.statistics,
      ...endingAudit.statistics,
    },
    connectorWays: prepared.connectors,
    mainlineWays: prepared.mainlines,
    rampAttachmentRepairs: ramps.attachmentRepairs,
    coveredMainlineMerges: coveredMerges,
  };
}
