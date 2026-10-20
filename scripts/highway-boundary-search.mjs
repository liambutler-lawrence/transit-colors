// Experimental exact branch-and-bound on a planarized geometric relaxation.
// Production remains on the existing solver until equivalence is validated.
import {
  geodesicSegment,
  refineGeodesicCrossing,
  geodesicWorkingCoordinates,
} from './highway-geodesic-splits.mjs';
import { createHash } from 'node:crypto';
import { orient2d } from 'robust-predicates';
import { biconnectedEdgeBlocks } from './highway-cycle.mjs';
import { highwayEdgeUsable, highwayTurnAllowed } from './highway-turns.mjs';
import { signedAreaContributionSquareMeters } from './wgs84-geodesy.mjs';

export function planarizeHighways(input, check = () => {}, { geodesic = false } = {}) {
  const begun = performance.now(),
    timings = {};

  if (geodesic)
    input = input.map((e) => ({
      ...e,
      coordinates: geodesicWorkingCoordinates(e.coordinates, check),
    }));
  timings.geodesicPreparationMs = performance.now() - begun;
  const roads = input
    .map((e, originalIndex) => ({
      ...e,
      originalIndex,
      coordinates: e.coordinates.filter(
        (p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1],
      ),
    }))
    .filter(highwayEdgeUsable);
  const decimalGrid = roads.every((r) =>
    r.coordinates.every((p) => p.every((x) => Math.round(x * 1e7) / 1e7 === x)),
  );
  const orient = (a, b, c) =>
    decimalGrid
      ? orient2d(
          ...a.map((x) => Math.round(x * 1e7)),
          ...b.map((x) => Math.round(x * 1e7)),
          ...c.map((x) => Math.round(x * 1e7)),
        )
      : orient2d(...a, ...b, ...c);
  const cells = new Map(),
    marks = roads.map(
      (e) =>
        new Map([
          [0, e.coordinates[0]],
          [e.coordinates.length - 1, e.coordinates.at(-1)],
        ]),
    );
  const stats = {
    coordinateScale: decimalGrid ? 1e7 : null,
    segments: 0,
    comparisons: 0,
    intersections: 0,
    overlaps: 0,
  };
  const key = (p) => `${p[0].toFixed(12)},${p[1].toFixed(12)}`;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  for (let i = 0; i < roads.length; i++) {
    check();
    const line = roads[i].coordinates;
    for (let j = 0; j < line.length - 1; j++) {
      const a = line[j],
        b = line[j + 1];
      if (key(a) === key(b)) continue;
      const s = { i, j, a, b },
        seen = new Set();
      stats.segments++;
      for (
        let x = Math.floor(Math.min(a[0], b[0]) * 100);
        x <= Math.floor(Math.max(a[0], b[0]) * 100);
        x++
      )
        for (
          let y = Math.floor(Math.min(a[1], b[1]) * 100);
          y <= Math.floor(Math.max(a[1], b[1]) * 100);
          y++
        ) {
          const k = `${x},${y}`,
            cell = cells.get(k) || [];
          for (const r of cell) {
            if (seen.has(r)) continue;
            seen.add(r);
            if (i === r.i && Math.abs(j - r.j) <= 1) continue;
            if (++stats.comparisons % 100000 === 0) check();
            const c = r.a,
              d = r.b;
            if (
              Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
              Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
              Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
              Math.max(c[1], d[1]) < Math.min(a[1], b[1])
            )
              continue;
            const o1 = orient(a, b, c),
              o2 = orient(a, b, d),
              o3 = orient(c, d, a),
              o4 = orient(c, d, b);
            if (o1 * o2 > 0 || o3 * o4 > 0) continue;
            const ab = sub(b, a),
              cd = sub(d, c);
            if (o1 === 0 && o2 === 0) {
              if (o1 !== 0 || o2 !== 0) continue;
              const axis = Math.abs(ab[0]) > Math.abs(ab[1]) ? 0 : 1;
              const lo = Math.max(
                Math.min(a[axis], b[axis]),
                Math.min(c[axis], d[axis]),
              );
              const hi = Math.min(
                Math.max(a[axis], b[axis]),
                Math.max(c[axis], d[axis]),
              );
              if (hi >= lo) {
                if (hi > lo) stats.overlaps++;
                // Split both geometries at overlap endpoints, retaining separate
                // road identities as parallel edges; never invent a transfer.
                for (const p of [a, b, c, d])
                  if (p[axis] >= lo && p[axis] <= hi) {
                    marks[i].set(j + (p[axis] - a[axis]) / ab[axis], p);
                    marks[r.i].set(r.j + (p[axis] - c[axis]) / cd[axis], p);
                  }
              }
              continue;
            }
            // Preserve exact source endpoints when robust orientation says the
            // intersection is an endpoint. Dividing near-parallel determinants
            // can otherwise manufacture several microscopic vertices here.
            const within = (p, a, b) =>
              p[0] >= Math.min(a[0], b[0]) &&
              p[0] <= Math.max(a[0], b[0]) &&
              p[1] >= Math.min(a[1], b[1]) &&
              p[1] <= Math.max(a[1], b[1]);
            const progress = (p, a, b) => {
              if (p === a) return 0;
              if (p === b) return 1;
              const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
              return Math.max(
                0,
                Math.min(1, (p[axis] - a[axis]) / (b[axis] - a[axis])),
              );
            };
            const endpoint =
              o1 === 0 && within(c, a, b)
                ? c
                : o2 === 0 && within(d, a, b)
                  ? d
                  : o3 === 0 && within(a, c, d)
                    ? a
                    : o4 === 0 && within(b, c, d)
                      ? b
                      : null;
            if (endpoint) {
              marks[i].set(j + progress(endpoint, a, b), endpoint);
              marks[r.i].set(r.j + progress(endpoint, c, d), endpoint);
              stats.intersections++;
              continue;
            }
            // Opposite-side robust orientation values give stable interpolation
            // weights: the denominator adds magnitudes instead of subtracting
            // almost equal products for nearly parallel roads.
            let t = o3 / (o3 - o4),
              u = o1 / (o1 - o2);
            const refined = geodesic ? refineGeodesicCrossing(a, b, c, d, t, u) : null;
            if (geodesic && !refined) continue;
            if (refined) {
              t = refined.t;
              u = refined.u;
            }
            const p =
              t === 0
                ? a
                : t === 1
                  ? b
                  : u === 0
                    ? c
                    : u === 1
                      ? d
                      : [a[0] + t * ab[0], a[1] + t * ab[1]];
            marks[i].set(j + t, refined?.point ?? p);
            marks[r.i].set(r.j + u, refined?.point ?? p);
            stats.intersections++;
          }
          cell.push(s);
          cells.set(k, cell);
        }
    }
  }
  timings.intersectionsMs = performance.now() - begun;
  const splitStarted = performance.now();
  const nodes = [],
    nodeMap = new Map(),
    edges = [];
  const node = (p) => {
    const k = key(p);
    if (!nodeMap.has(k)) {
      nodeMap.set(k, nodes.length);
      nodes.push({ id: nodes.length, coordinate: p });
    }
    return nodeMap.get(k);
  };
  for (let i = 0; i < roads.length; i++) {
    check();
    const road = roads[i],
      cuts = [...marks[i]]
        .sort((a, b) => a[0] - b[0])
        .reduce((result, cut) => {
          const previous = result.at(-1);
          if (
            previous &&
            (Math.floor(previous[0]) === Math.floor(cut[0]) ||
              Math.abs(previous[0] - cut[0]) < 1e-5) &&
            key(previous[1]) === key(cut[1])
          ) {
            if (Number.isInteger(cut[0])) result[result.length - 1] = cut;
          } else result.push(cut);
          return result;
        }, []);
    for (let j = 1; j < cuts.length; j++) {
      const [start, a] = cuts[j - 1],
        [end, b] = cuts[j];
      const points = [a];
      for (let k = Math.floor(start) + 1; k < end; k++)
        points.push(road.coordinates[k]);
      points.push(b);
      const fromId = node(a),
        toId = node(b);
      if (fromId === toId && points.length > 2) {
        // A genuine loop needs a degree-two subdivision so Tarjan and the
        // half-edge walk retain it; the original road progress still controls
        // which transitions at its geometric self-crossing are legal.
        let middle = Math.max(Math.floor(start) + 1, Math.floor((start + end) / 2));
        if (middle >= end || key(road.coordinates[middle]) === key(a)) {
          middle = Math.floor(start) + 1;
          while (middle < end && key(road.coordinates[middle]) === key(a)) middle++;
        }
        if (middle < end) {
          cuts.splice(j, 0, [middle, road.coordinates[middle]]);
          j--;
          continue;
        }
      }
      if (fromId === toId)
        throw Object.assign(
          new Error('Planarization produced a self-loop; split it before searching'),
          {
            details: {
              road: road.originalIndex,
              start,
              end,
              points: points.length,
              sample: points.slice(0, 4),
              stats,
            },
          },
        );
      edges.push({
        fromId,
        toId,
        coordinates: points,
        road: i,
        start,
        end,
        area: signedAreaContributionSquareMeters(
          geodesic
            ? [
                Number.isInteger(start)
                  ? road.coordinates[start]
                  : geodesicSegment(
                      road.coordinates[Math.floor(start)],
                      road.coordinates[Math.floor(start) + 1],
                    ).point(start % 1),
                ...points.slice(1, -1),
                Number.isInteger(end)
                  ? road.coordinates[end]
                  : geodesicSegment(
                      road.coordinates[Math.floor(end)],
                      road.coordinates[Math.floor(end) + 1],
                    ).point(end % 1),
              ]
            : points,
        ),
      });
    }
  }
  timings.splittingAndAreaMs = performance.now() - splitStarted;
  return attachBoundaryLegality({ nodes, edges, roads, stats, timings });
}

export function attachBoundaryLegality(graph) {
  const { edges, roads } = graph;
  const zeroAt = new Map();
  roads.forEach((road, i) => {
    if (road.coordinates.length !== 1) return;
    for (const node of [road.fromId, road.toId]) {
      const ids = zeroAt.get(node) ?? [];
      ids.push(i);
      zeroAt.set(node, ids);
    }
  });
  const endpoint = (e, r, v) =>
    e.fromId === v && e.start === 0
      ? r.fromId
      : e.toId === v && e.end === r.coordinates.length - 1
        ? r.toId
        : undefined;
  const key = (p) => p.map((x) => x.toFixed(12)).join(',');
  // A geometrically zero-length road can still be an explicit, legal link
  // between distinct source nodes. Preserve its turn-by-turn witness.
  function transitionRoads(a, b, v) {
    const ea = edges[a],
      eb = edges[b];
    if (a === b) return null;
    if (ea.road === eb.road)
      return (ea.toId === v && eb.fromId === v && ea.end === eb.start) ||
        (eb.toId === v && ea.fromId === v && eb.end === ea.start)
        ? []
        : null;
    const ra = roads[ea.road],
      rb = roads[eb.road];
    const na = endpoint(ea, ra, v),
      nb = endpoint(eb, rb, v);
    if (na === undefined || nb === undefined) return null;
    if (na === nb && highwayTurnAllowed(ra, rb, na)) return [];
    if (!zeroAt.has(na)) return null;
    const coordinateKey = key(
      na === ra.fromId ? ra.coordinates[0] : ra.coordinates.at(-1),
    );
    const pending = [{ node: na, incoming: ea.road, path: [], visited: new Set([na]) }];
    while (pending.length) {
      const state = pending.pop();
      for (const i of zeroAt.get(state.node) ?? []) {
        const road = roads[i];
        if (
          key(road.coordinates[0]) !== coordinateKey ||
          !highwayTurnAllowed(roads[state.incoming], road, state.node)
        )
          continue;
        const node = road.fromId === state.node ? road.toId : road.fromId;
        if (state.visited.has(node)) continue;
        const path = [...state.path, i];
        if (node === nb && highwayTurnAllowed(road, rb, node)) return path;
        pending.push({
          node,
          incoming: i,
          path,
          visited: new Set([...state.visited, node]),
        });
      }
    }
    return null;
  }
  const legal = (a, b, v) => transitionRoads(a, b, v) !== null;
  return { ...graph, legal, transitionRoads };
}

// Deleting roads preserves the cyclic order of every surviving half-edge.
// Calculate that order once; each branch only selects a subsequence of it.
export function boundaryRotationRanks(graph) {
  const out = new Map();
  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    for (const [v, h] of [
      [e.fromId, 2 * i],
      [e.toId, 2 * i + 1],
    ]) {
      const a = out.get(v) || [];
      a.push(h);
      out.set(v, a);
    }
  }
  const ray = (h) => {
    const e = graph.edges[h >> 1],
      road = graph.roads[e.road];
    const reverse = h % 2,
      k = Math.max(
        0,
        Math.min(
          road.coordinates.length - 2,
          reverse ? Math.ceil(e.end) - 1 : Math.floor(e.start),
        ),
      );
    const a = road.coordinates[k],
      b = road.coordinates[k + 1],
      sign = reverse ? -1 : 1;
    const scale = graph.stats?.coordinateScale;
    return [0, 1].map(
      (i) =>
        (scale ? Math.round(b[i] * scale) - Math.round(a[i] * scale) : b[i] - a[i]) *
        sign,
    );
  };
  for (const [v, a] of out) {
    const origin = [0, 0];
    a.sort((x, y) => {
      const p = ray(x, origin),
        q = ray(y, origin);
      const half = (p) =>
        p[1] > origin[1] || (p[1] === origin[1] && p[0] >= origin[0]) ? 0 : 1;
      const halves = half(p) - half(q);
      if (halves) return halves;
      const turn = orient2d(...origin, ...p, ...q);
      if (turn) return turn;
      const e = graph.edges[x >> 1],
        other = e.fromId === v ? e.toId : e.fromId;
      return (v < other ? 1 : -1) * ((x >> 1) - (y >> 1));
    });
  }
  const ranks = new Uint32Array(graph.edges.length * 2);
  for (const a of out.values()) for (let i = 0; i < a.length; i++) ranks[a[i]] = i;
  return ranks;
}

/** Reusable iterative Tarjan scratch, retaining multiedges and input traversal order. */
export function createDenseBoundaryBlocks(graph) {
  const vertexIndex = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const count = graph.nodes.length,
    size = graph.edges.length;
  const from = new Uint32Array(size),
    to = new Uint32Array(size);
  graph.edges.forEach((e, i) => {
    if (!vertexIndex.has(e.fromId) || !vertexIndex.has(e.toId))
      throw new Error('Boundary edge references a missing vertex');
    from[i] = vertexIndex.get(e.fromId);
    to[i] = vertexIndex.get(e.toId);
  });
  const head = new Int32Array(count).fill(-1),
    tail = new Int32Array(count);
  const next = new Int32Array(size * 2),
    discovered = new Uint32Array(count);
  const low = new Uint32Array(count),
    parent = new Int32Array(count);
  const frameVertex = new Uint32Array(count),
    frameNext = new Int32Array(count);
  const stack = new Uint32Array(size);
  let touched = [];
  return (indices) => {
    for (const v of touched) {
      head[v] = -1;
      discovered[v] = 0;
    }
    touched = [];
    for (const i of indices) {
      for (let reverse = 0; reverse < 2; reverse++) {
        const h = 2 * i + reverse,
          v = reverse ? to[i] : from[i];
        next[h] = -1;
        if (head[v] === -1) {
          head[v] = h;
          touched.push(v);
        } else next[tail[v]] = h;
        tail[v] = h;
      }
    }
    let time = 0,
      stackSize = 0;
    const blocks = [];
    for (const root of touched) {
      if (discovered[root]) continue;
      discovered[root] = low[root] = ++time;
      parent[root] = -1;
      let depth = 1;
      frameVertex[0] = root;
      frameNext[0] = head[root];
      while (depth) {
        const slot = depth - 1,
          v = frameVertex[slot],
          h = frameNext[slot];
        if (h !== -1) {
          frameNext[slot] = next[h];
          const i = h >> 1;
          if (i === parent[v]) continue;
          const neighbor = from[i] === v ? to[i] : from[i];
          if (!discovered[neighbor]) {
            stack[stackSize++] = i;
            parent[neighbor] = i;
            discovered[neighbor] = low[neighbor] = ++time;
            frameVertex[depth] = neighbor;
            frameNext[depth++] = head[neighbor];
          } else if (discovered[neighbor] < discovered[v]) {
            stack[stackSize++] = i;
            low[v] = Math.min(low[v], discovered[neighbor]);
          }
          continue;
        }
        depth--;
        const tree = parent[v];
        if (tree === -1) {
          if (stackSize) {
            const block = Array.from(stack.subarray(0, stackSize));
            if (block.length >= 2) blocks.push(block);
            stackSize = 0;
          }
          continue;
        }
        const p = from[tree] === v ? to[tree] : from[tree];
        low[p] = Math.min(low[p], low[v]);
        if (low[v] >= discovered[p]) {
          const block = [];
          let i;
          do {
            i = stack[--stackSize];
            block.push(i);
          } while (i !== tree);
          if (block.length >= 2) blocks.push(block);
        }
      }
    }
    return blocks;
  };
}

// Experimental branch-and-bound over geometrically simple planar cycles.
// NOT equivalent to source-graph cycles: source edges can retrace/touch in
// geometry, and linear coordinate splits change the WGS84 area objective.
// An optimal result here is not a certificate for the production problem.
export function searchHighwayBoundary(
  graph,
  {
    maxMilliseconds = 300000,
    cacheRotation = true,
    denseFaceTraversal = true,
    denseBlocks = true,
    incrementalPropagation = true,
    maxStates = Infinity,
    onProgress = () => {},
    checkpoint = null,
    checkpointKey = null,
    onCheckpoint = null,
  } = {},
) {
  const started = performance.now(),
    timings = {
      indexing: 0,
      rotation: 0,
      propagation: 0,
      blocks: 0,
      faces: 0,
      validation: 0,
    };
  if ((checkpoint || onCheckpoint) && !checkpointKey)
    throw new Error('Checkpoint identity is required');
  if (checkpoint && (checkpoint.version !== 1 || checkpoint.key !== checkpointKey))
    throw new Error('Boundary checkpoint does not match this graph and algorithm');
  const indexingStarted = performance.now();
  const findDenseBlocks = denseBlocks ? createDenseBoundaryBlocks(graph) : null;
  timings.indexing = performance.now() - indexingStarted;
  const rotationStarted = performance.now();
  const rotationRanks = cacheRotation ? boundaryRotationRanks(graph) : null;
  timings.rotation = performance.now() - rotationStarted;
  // Reuse bounded scratch storage across blocks/branches; every active
  // halfedge is reset before traversal, so removed edges cannot leak in.
  const faceNext = denseFaceTraversal ? new Uint32Array(graph.edges.length * 2) : null;
  const faceVisited = denseFaceTraversal
    ? new Uint8Array(graph.edges.length * 2)
    : null;
  let states = checkpoint?.states ?? 0,
    runStates = 0,
    best = checkpoint?.best ?? null,
    initialized = checkpoint?.initialized ?? false;
  const queue = checkpoint ? [...checkpoint.queue] : [],
    seen = new Set(checkpoint?.seen ?? []);
  let processingState = null,
    transactionKeys = null,
    lastCheckpoint = performance.now();
  const saveCheckpoint = () => {
    if (onCheckpoint)
      onCheckpoint({
        version: 1,
        key: checkpointKey,
        initialized,
        states,
        best,
        queue,
        seen: [...seen],
        elapsedMs: (checkpoint?.elapsedMs ?? 0) + performance.now() - started,
      });
    lastCheckpoint = performance.now();
  };
  const check = () => {
    if (performance.now() - started > maxMilliseconds)
      throw new Error('Boundary search time budget reached');
  };
  function propagationContext(indices) {
    const incident = new Map();
    for (const i of indices) {
      const e = graph.edges[i];
      for (const v of [e.fromId, e.toId]) {
        const a = incident.get(v) || [];
        a.push(i);
        incident.set(v, a);
      }
    }
    return incident;
  }
  function enqueue(indices, parent = null, removed = []) {
    check();
    // Only deleted-edge endpoints can lose previously valid continuations.
    // Also seed every unsupported parent vertex: a biconnected block may
    // have lost support that was available only in a neighboring block.
    const propagateStarted = performance.now();
    const active = new Set(indices);
    const incident = parent?.incident ?? propagationContext(indices);
    const pendingVertices = parent ? [...parent.unsupported] : [...incident.keys()];
    for (const i of parent ? removed : []) {
      const e = graph.edges[i];
      pendingVertices.push(e.fromId, e.toId);
    }
    while (pendingVertices.length) {
      const v = pendingVertices.pop(),
        a = incident.get(v);
      for (const i of a)
        if (active.has(i) && !a.some((j) => active.has(j) && graph.legal(i, j, v))) {
          active.delete(i);
          const e = graph.edges[i];
          pendingVertices.push(e.fromId === v ? e.toId : e.fromId);
        }
    }
    indices = indices.filter((i) => active.has(i));
    timings.propagation += performance.now() - propagateStarted;
    const stamp = createHash('sha256')
      .update(Buffer.from(Uint32Array.from(indices).buffer))
      .digest('hex');
    if (seen.has(stamp)) return;
    seen.add(stamp);
    transactionKeys?.push(stamp);
    let t = performance.now();
    let blocks;
    if (findDenseBlocks) blocks = findDenseBlocks(indices);
    else {
      const subset = indices.map((i) => graph.edges[i]);
      const activeNodes = [...new Set(subset.flatMap((e) => [e.fromId, e.toId]))].map(
        (id) => ({ id }),
      );
      blocks = biconnectedEdgeBlocks(activeNodes, subset).map((block) =>
        block.map((i) => indices[i]),
      );
    }
    timings.blocks += performance.now() - t;
    t = performance.now();
    try {
      for (const block of blocks) {
        const ids = block,
          out = new Map(),
          visited = denseFaceTraversal ? null : new Set();
        for (const i of ids)
          for (const reverse of [0, 1]) {
            const e = graph.edges[i],
              v = reverse ? e.toId : e.fromId,
              a = out.get(v) || [];
            a.push(2 * i + reverse);
            out.set(v, a);
          }
        if (rotationRanks) {
          for (const a of out.values())
            a.sort((x, y) => rotationRanks[x] - rotationRanks[y]);
        } else {
          const ray = (h) => {
            const e = graph.edges[h >> 1],
              road = graph.roads[e.road];
            const reverse = h % 2,
              k = Math.max(
                0,
                Math.min(
                  road.coordinates.length - 2,
                  reverse ? Math.ceil(e.end) - 1 : Math.floor(e.start),
                ),
              );
            const a = road.coordinates[k],
              b = road.coordinates[k + 1],
              sign = reverse ? -1 : 1;
            const scale = graph.stats?.coordinateScale;
            return [0, 1].map(
              (i) =>
                (scale
                  ? Math.round(b[i] * scale) - Math.round(a[i] * scale)
                  : b[i] - a[i]) * sign,
            );
          };
          for (const [v, a] of out) {
            const origin = [0, 0];
            a.sort((x, y) => {
              const p = ray(x, origin),
                q = ray(y, origin);
              const half = (p) =>
                p[1] > origin[1] || (p[1] === origin[1] && p[0] >= origin[0]) ? 0 : 1;
              const halves = half(p) - half(q);
              if (halves) return halves;
              const turn = orient2d(...origin, ...p, ...q);
              if (turn) return turn;
              const e = graph.edges[x >> 1],
                other = e.fromId === v ? e.toId : e.fromId;
              return (v < other ? 1 : -1) * ((x >> 1) - (y >> 1));
            });
          }
        }
        const next = denseFaceTraversal ? null : new Map();
        const starts = [];
        for (const a of out.values())
          for (let j = 0; j < a.length; j++) {
            const h = a[j] ^ 1,
              successor = a[(j + a.length - 1) % a.length];
            if (denseFaceTraversal) {
              faceNext[h] = successor;
              faceVisited[h] = 0;
              starts.push(h);
            } else next.set(h, successor);
          }
        let outer = null;
        for (const start of denseFaceTraversal ? starts : next.keys()) {
          if (denseFaceTraversal ? faceVisited[start] : visited.has(start)) continue;
          let h = start,
            area = 0;
          const cycle = [],
            vertices = new Set();
          let simple = true;
          do {
            if (denseFaceTraversal) faceVisited[h] = 1;
            else visited.add(h);
            cycle.push(h);
            const e = graph.edges[h >> 1],
              v = h % 2 ? e.toId : e.fromId;
            if (vertices.has(v)) simple = false;
            vertices.add(v);
            area += h % 2 ? -e.area : e.area;
            h = denseFaceTraversal ? faceNext[h] : next.get(h);
          } while (
            h !== start &&
            !(denseFaceTraversal ? faceVisited[h] : visited.has(h))
          );
          if (h !== start || !simple)
            throw Object.assign(
              new Error('Non-simple face in biconnected planar graph'),
              {
                details: {
                  blockEdges: ids.length,
                  edgeIds: ids,
                  faceHalfedges: cycle,
                  faceEdges: cycle.length,
                  repeatedVertices: cycle.length - vertices.size,
                  firstRoads: cycle
                    .slice(0, 12)
                    .map((h) => graph.roads[graph.edges[h >> 1].road].originalIndex),
                },
              },
            );
          if (!outer || Math.abs(area) > outer.area)
            outer = { area: Math.abs(area), cycle, ids };
        }
        if (outer && outer.area > (best?.area ?? 0)) queue.push(outer);
      }
    } finally {
      timings.faces += performance.now() - t;
    }
  }
  let status = 'optimal',
    error,
    details;
  try {
    if (!initialized) {
      transactionKeys = [];
      try {
        enqueue(graph.edges.map((_, i) => i));
        initialized = true;
      } catch (e) {
        for (const key of transactionKeys) seen.delete(key);
        queue.length = 0;
        throw e;
      } finally {
        transactionKeys = null;
      }
      saveCheckpoint();
    }
    while (queue.length) {
      check();
      if (runStates >= maxStates)
        throw new Error('Boundary search state budget reached');
      queue.sort((a, b) => a.area - b.area);
      const state = queue.pop();
      processingState = state;
      if (state.area <= (best?.area ?? 0)) {
        processingState = null;
        continue;
      }
      states++;
      runStates++;
      let t = performance.now(),
        bad;
      for (let j = 0; j < state.cycle.length; j++) {
        const h = state.cycle[j],
          e = graph.edges[h >> 1],
          v = h % 2 ? e.fromId : e.toId;
        if (!graph.legal(h >> 1, state.cycle[(j + 1) % state.cycle.length] >> 1, v)) {
          bad = v;
          break;
        }
      }
      timings.validation += performance.now() - t;
      if (bad === undefined) {
        best = state;
        processingState = null;
        continue;
      }
      const incident = state.ids.filter((i) => {
        const e = graph.edges[i];
        return e.fromId === bad || e.toId === bad;
      });
      const choices = [[]];
      for (let i = 0; i < incident.length; i++)
        for (let j = i + 1; j < incident.length; j++)
          if (graph.legal(incident[i], incident[j], bad))
            choices.push([incident[i], incident[j]]);
      const prepareStarted = performance.now();
      let parent = null;
      if (incrementalPropagation) {
        const adjacency = propagationContext(state.ids);
        const unsupported = [];
        for (const [v, a] of adjacency)
          if (a.some((i) => !a.some((j) => graph.legal(i, j, v)))) unsupported.push(v);
        parent = { incident: adjacency, unsupported };
      }
      timings.propagation += performance.now() - prepareStarted;
      // Expansion is transactional: a time limit or failure cannot discard
      // ungenerated branches or leave a half-enqueued child marked as seen.
      const queueLength = queue.length;
      transactionKeys = [];
      try {
        for (const choice of choices) {
          const removed = incident.filter((i) => !choice.includes(i));
          enqueue(
            state.ids.filter((i) => !removed.includes(i)),
            parent,
            removed,
          );
        }
      } catch (e) {
        queue.length = queueLength;
        for (const key of transactionKeys) seen.delete(key);
        queue.push(state);
        processingState = null;
        throw e;
      } finally {
        transactionKeys = null;
      }
      processingState = null;
      if (performance.now() - lastCheckpoint >= 5000) saveCheckpoint();
      if (states % 10 === 0)
        onProgress({
          states,
          pending: queue.length,
          bestArea: best?.area ?? null,
          elapsedMs: performance.now() - started,
        });
    }
  } catch (e) {
    if (processingState) queue.push(processingState);
    status = 'incomplete';
    error = e.message;
    details = e.details;
  }
  saveCheckpoint();
  return {
    status,
    proofScope: 'geometrically-simple-planar-cycles',
    sourceGraphOptimalityCertified: false,
    error,
    details,
    best,
    states,
    pending: queue.length,
    timings,
    elapsedMs: performance.now() - started,
  };
}
