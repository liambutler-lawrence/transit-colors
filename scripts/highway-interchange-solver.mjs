import {
  buildInterchangeGraph,
  attachInterchangeBoundaryGraph,
} from './highway-interchange-graph.mjs';
import { planarizeHighways } from './highway-boundary-search.mjs';
import { searchPairedHighwayBoundary } from './highway-paired-boundary-search.mjs';
import { highwayCycleTurnViolation } from './highway-turns.mjs';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { highwayAreaGraphDigest } from './highway-area-cache.mjs';
import { createHash } from 'node:crypto';
import { biconnectedEdgeBlocks } from './highway-cycle.mjs';

const implementation = createHash('sha256');
for (const name of [
  'highway-interchange-solver.mjs',
  'highway-interchange-graph.mjs',
  'highway-paired-boundary-search.mjs',
  'highway-boundary-search.mjs',
  'highway-boundary-pairings.mjs',
  'highway-boundary-regions.mjs',
  'highway-geodesic-splits.mjs',
  'highway-turns.mjs',
  'highway-cycle.mjs',
  '../src/geodesy.ts',
  'wgs84-geodesy.mjs',
])
  implementation.update(fs.readFileSync(new URL(name, import.meta.url)));
const implementationDigest = implementation.digest('hex');

export function solveInterchangeBoundary(
  source,
  parts,
  {
    maxPhaseMilliseconds = 30000,
    maxStates = 1000,
    onTiming = () => {},
    checkpointPath = null,
    previewUnrestricted = false,
  } = {},
) {
  const timings = {},
    phase = (name, fn) => {
      const began = performance.now(),
        check = () => {
          if (performance.now() - began > maxPhaseMilliseconds)
            throw Error(`${name} exceeded its ${maxPhaseMilliseconds} ms limit`);
        };
      let result;
      try {
        result = fn(check);
        return result;
      } finally {
        timings[name] = performance.now() - began;
        onTiming({
          phase: name,
          milliseconds: timings[name],
          ...(name === 'interchange-graph' && result
            ? { graphStatistics: result.statistics, details: result.timings }
            : {}),
          ...(name === 'mainline-planarization' && result
            ? {
                nodes: result.nodes.length,
                edges: result.edges.length,
                details: result.timings,
              }
            : {}),
        });
      }
    };
  const macro = phase('interchange-graph', (check) => {
    const graph = buildInterchangeGraph(source, parts, { check });
    graph.statistics.biconnectedBlocks = biconnectedEdgeBlocks(
      graph.nodes,
      graph.edges,
    ).length;
    check();
    return graph;
  });
  const graph = phase('mainline-planarization', (check) =>
    attachInterchangeBoundaryGraph(
      planarizeHighways(macro.edges, check, { geodesic: true }),
      macro,
    ),
  );
  let resume = null,
    digest;
  if (checkpointPath && !previewUnrestricted) {
    digest = phase('checkpoint-fingerprint', () =>
      highwayAreaGraphDigest({
        source,
        parts: parts.map(({ role, explicitMainlineMerge }) => ({
          role,
          explicitMainlineMerge,
        })),
        implementationDigest,
      }),
    );
    try {
      const saved = deserialize(fs.readFileSync(checkpointPath));
      if (saved.version === 1 && saved.digest === digest) resume = saved.state;
    } catch {
      /* First run has no checkpoint. */
    }
  }
  const onCheckpoint =
    checkpointPath && !previewUnrestricted
      ? (state) => {
          fs.mkdirSync(dirname(checkpointPath), { recursive: true });
          fs.writeFileSync(
            checkpointPath + '.next',
            serialize({ version: 1, digest, state }),
          );
          fs.renameSync(checkpointPath + '.next', checkpointPath);
        }
      : null;
  const result = phase('outer-boundary-search', () =>
    searchPairedHighwayBoundary(graph, {
      maxMilliseconds: maxPhaseMilliseconds,
      maxStates,
      resume,
      onCheckpoint,
      previewUnrestricted,
    }),
  );
  const segments = [];
  for (const piece of result.best?.pieces ?? []) {
    const edge = source.edges[piece.sourceIndex];
    const prior = segments.at(-1);
    if (
      prior &&
      prior.edgeIndex === piece.sourceIndex &&
      prior.reverse === piece.reverse
    ) {
      for (const point of piece.coordinates)
        if (prior.coordinates.at(-1).join() !== point.join())
          prior.coordinates.push(point);
    } else
      segments.push({
        ...edge,
        edgeIndex: piece.sourceIndex,
        reverse: piece.reverse,
        fromId: piece.reverse ? edge.toId : edge.fromId,
        toId: piece.reverse ? edge.fromId : edge.toId,
        coordinates: [...piece.coordinates],
      });
  }
  if (
    segments.length > 1 &&
    segments[0].edgeIndex === segments.at(-1).edgeIndex &&
    segments[0].reverse === segments.at(-1).reverse
  ) {
    const last = segments.pop();
    segments[0].coordinates = [
      ...last.coordinates,
      ...segments[0].coordinates.slice(1),
    ];
  }
  if (
    !previewUnrestricted &&
    segments.length &&
    highwayCycleTurnViolation(segments, source.edges)
  )
    throw Error('Expanded interchange route fails source turn validation');
  return {
    optimizationStatus: previewUnrestricted
      ? 'unrestricted-preview'
      : result.status === 'complete' && result.best
        ? 'optimal'
        : 'incomplete',
    model: 'mainlines with interchange movements',
    areaSquareMeters: result.best?.area ?? 0,
    coordinates: result.best?.coordinates ?? [],
    segments,
    objectiveUpperBoundSquareMeters:
      result.status === 'complete' && result.best ? result.best.area : null,
    optimizationIterations: result.states,
    biconnectedBlockCount: macro.statistics.biconnectedBlocks,
    timings,
    graphStatistics: macro.statistics,
    geometryScoreStatistics: graph.scoreStatistics,
    search: result,
    ...(previewUnrestricted ? { diagnostics: result.diagnostics } : {}),
  };
}
