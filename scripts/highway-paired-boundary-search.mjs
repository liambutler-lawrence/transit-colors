import { boundaryRotationRanks } from './highway-boundary-search.mjs';
import {
  boundaryFaceWalks,
  largestBoundaryRegion,
  splitBoundaryLoops,
} from './highway-boundary-regions.mjs';
import { boundaryPairingChoices } from './highway-boundary-pairings.mjs';

// Experimental outer-boundary search: unrestricted faces give bounds; selected
// source-road pairings define legal walks. No mathematical-programming backend.
export function searchPairedHighwayBoundary(
  graph,
  {
    maxMilliseconds = 30000,
    maxStates = 1000,
    secondaryPruning = false,
    onBranch = () => {},
    resume = null,
    onCheckpoint = null,
    previewUnrestricted = false,
  } = {},
) {
  const start = performance.now(),
    timings = {
      rotation: 0,
      propagation: 0,
      successorAssembly: 0,
      bounds: 0,
      walks: 0,
      scoring: 0,
      branching: 0,
    };
  const check = () => {
    if (performance.now() - start > maxMilliseconds) throw Error('time limit');
  };
  let t = performance.now();
  const ranks = boundaryRotationRanks(graph);
  timings.rotation = performance.now() - t;
  const queue = resume?.queue ?? [
    { ids: graph.edges.map((_, i) => i), pairs: new Map(), bound: Infinity },
  ];
  let states = resume?.states ?? 0,
    best = resume?.best ?? null,
    status = 'complete',
    error,
    workingState;
  const initialStates = states;
  const checkpoint = () => {
    if (!previewUnrestricted) onCheckpoint?.({ queue, best, states });
  };
  try {
    while (queue.length) {
      workingState = null;
      check();
      if (states - initialStates >= maxStates) throw Error('state limit');
      checkpoint();
      queue.sort((a, b) => a.bound - b.bound);
      const state = queue.pop();
      workingState = state;
      if (state.bound <= (best?.area ?? 0) + 1e-4) continue;
      states++;
      // Remove unsupported road ends before computing a geometric bound. This
      // is legality propagation, not a restriction to visually simple cycles.
      const propagationStarted = performance.now();
      const active = new Set(state.ids);
      if (states === 1 || secondaryPruning) {
        const adjacency = new Map(),
          mates = new Map();
        for (const i of active)
          for (const v of [graph.edges[i].fromId, graph.edges[i].toId]) {
            if (!adjacency.has(v)) adjacency.set(v, []);
            adjacency.get(v).push(i);
          }
        for (const pairs of state.pairs.values())
          for (const [a, b] of pairs) {
            if (!mates.has(a)) mates.set(a, []);
            if (!mates.has(b)) mates.set(b, []);
            mates.get(a).push(b);
            mates.get(b).push(a);
          }
        const pending = [...adjacency.keys()],
          scheduled = new Set(pending);
        const remove = (first) => {
          const edges = [first];
          while (edges.length) {
            const i = edges.pop();
            if (!active.delete(i)) continue;
            edges.push(...(mates.get(i) ?? []));
            for (const v of [graph.edges[i].fromId, graph.edges[i].toId])
              if (!scheduled.has(v)) {
                scheduled.add(v);
                pending.push(v);
              }
          }
        };
        for (const [i, partners] of mates)
          if (!active.has(i)) for (const j of partners) remove(j);
        let processed = 0;
        while (pending.length) {
          if (++processed % 1024 === 0) check();
          const v = pending.pop();
          scheduled.delete(v);
          const row = adjacency.get(v) ?? [];
          for (const i of row)
            if (
              active.has(i) &&
              !row.some((j) => active.has(j) && graph.legal(i, j, v))
            )
              remove(i);
        }
        state.ids = state.ids.filter((i) => active.has(i));
      }
      timings.propagation += performance.now() - propagationStarted;
      t = performance.now();
      const faces = boundaryFaceWalks(graph, state.ids, ranks);
      // Prioritize the geometric bounds, independently of source/Map order.
      // Forced road walks are not planar faces and must not choose our branch.
      faces.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
      const bound =
        graph.relaxationUpperBound?.(faces) ??
        faces.reduce((value, face) => Math.max(value, Math.abs(face.area)), 0);
      timings.bounds += performance.now() - t;
      // Local diagnostics stop at the exact same initial working boundary.
      // They do not enter scoring, legal pairing branches, or checkpointing.
      if (previewUnrestricted) {
        // Choose the primary simple loop before auditing or expanding it.
        // Keep the original face walks for bounds and legal successor assembly:
        // a legal full route may still need a secondary loop at an interchange.
        const loops = faces.flatMap((face) => splitBoundaryLoops(graph, face.cycle));
        loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
        const face = loops[0];
        if (!face) throw Error('No unrestricted boundary found');
        const junctions = new Map();
        for (let j = 0; j < face.cycle.length; j++) {
          const a = face.cycle[j] >> 1,
            b = face.cycle[(j + 1) % face.cycle.length] >> 1,
            e = graph.edges[a],
            v = face.cycle[j] % 2 ? e.fromId : e.toId;
          if (graph.legal(a, b, v)) continue;
          if (!junctions.has(v))
            junctions.set(v, {
              number: junctions.size + 1,
              node: v,
              kind: graph.transitionKind?.(a, b, v) ?? 'geometric-contact',
              coordinate: graph.nodes.find((n) => n.id === v).coordinate,
              occurrences: 0,
            });
          junctions.get(v).occurrences++;
        }
        const expanded = graph.expand(face.cycle, { allowForbiddenTurns: true });
        return {
          status: 'unrestricted-preview',
          states,
          pending: 0,
          best: { ...expanded, walk: face.cycle, area: Math.abs(face.area) },
          diagnostics: {
            junctions: [...junctions.values()],
            boundarySegments: face.cycle.length,
            repeatedVertices:
              face.cycle.length -
              new Set(
                face.cycle.map((h) => {
                  const e = graph.edges[h >> 1];
                  return h % 2 ? e.toId : e.fromId;
                }),
              ).size,
          },
          timings,
          elapsedMs: performance.now() - start,
          sourceGraphOptimalityCertified: false,
        };
      }
      if (bound <= (best?.area ?? 0) + 1e-4) continue;
      const assemblyStarted = performance.now();
      const incident = new Map(),
        next = new Map();
      for (const i of state.ids)
        for (const v of [graph.edges[i].fromId, graph.edges[i].toId]) {
          if (!incident.has(v)) incident.set(v, []);
          incident.get(v).push(i);
        }
      for (const face of faces)
        for (let j = 0; j < face.cycle.length; j++)
          next.set(face.cycle[j], face.cycle[(j + 1) % face.cycle.length]);
      for (const [v, pairs] of state.pairs)
        for (const [a, b] of pairs) {
          if (!active.has(a) || !active.has(b)) continue;
          for (const [i, j] of [
            [a, b],
            [b, a],
          ])
            next.set(
              2 * i + (graph.edges[i].fromId === v ? 1 : 0),
              2 * j + (graph.edges[j].fromId === v ? 0 : 1),
            );
        }
      t = performance.now();
      timings.successorAssembly += performance.now() - assemblyStarted;
      const scoringBefore = timings.scoring;
      const seen = new Set();
      let bad, branchBoundaryArea;
      for (const face of faces) {
        for (let j = 0; j < face.cycle.length; j++) {
          const h = face.cycle[j],
            following = face.cycle[(j + 1) % face.cycle.length];
          const edge = graph.edges[h >> 1],
            vertex = h % 2 ? edge.fromId : edge.toId;
          if (
            !state.pairs.has(vertex) &&
            !graph.legal(h >> 1, following >> 1, vertex)
          ) {
            bad = vertex;
            branchBoundaryArea = Math.abs(face.area);
            break;
          }
        }
        if (bad !== undefined) break;
      }
      for (const initial of next.keys()) {
        check();
        if (seen.has(initial)) continue;
        const walk = [];
        let h = initial,
          legal = true;
        do {
          if (h === undefined || seen.has(h)) {
            legal = false;
            break;
          }
          seen.add(h);
          walk.push(h);
          const successor = next.get(h),
            e = graph.edges[h >> 1],
            v = h % 2 ? e.fromId : e.toId;
          if (successor === undefined || !graph.legal(h >> 1, successor >> 1, v)) {
            legal = false;
          }
          h = successor;
        } while (h !== initial);
        if (!legal) continue;
        // A source-simple cycle cannot reuse a source vertex. Synthetic
        // contacts are allowed; consecutive pieces of a source road are not visits.
        const sourceVertices = new Set();
        for (let j = 0; j < walk.length; j++) {
          const current = graph.edges[walk[j] >> 1],
            following = graph.edges[walk[(j + 1) % walk.length] >> 1];
          if (current.road === following.road) continue;
          const road = graph.roads[current.road],
            vertex = walk[j] % 2 ? road.fromId : road.toId;
          if (sourceVertices.has(vertex) && !graph.sourceVertexMayRepeat?.(vertex)) {
            legal = false;
            break;
          }
          sourceVertices.add(vertex);
        }
        if (!legal) continue;
        const scoreStarted = performance.now();
        const region =
          graph.scoreWalk?.(walk, check) ?? largestBoundaryRegion(graph, walk, ranks);
        timings.scoring += performance.now() - scoreStarted;
        if (region.area > (best?.area ?? 0)) best = { ...region, walk };
      }
      timings.walks += performance.now() - t - (timings.scoring - scoringBefore);
      if (bound <= (best?.area ?? 0) + 1e-4) continue;
      // If all exposed turns are legal but the upper bound is not attained,
      // resolve another unassigned junction; do not falsely declare optimality.
      if (bad === undefined)
        for (const face of faces) {
          for (const h of face.cycle) {
            const edge = graph.edges[h >> 1],
              vertex = h % 2 ? edge.fromId : edge.toId;
            if (!state.pairs.has(vertex) && incident.get(vertex).length > 2) {
              bad = vertex;
              branchBoundaryArea = Math.abs(face.area);
              break;
            }
          }
          if (bad !== undefined) break;
        }
      if (bad === undefined) continue;
      t = performance.now();
      onBranch({
        state: states,
        vertex: bad,
        upperBoundArea: bound,
        branchBoundaryArea,
      });
      const row = incident.get(bad);
      for (const choice of boundaryPairingChoices(row, (a, b) =>
        graph.legal(a, b, bad),
      )) {
        check();
        const kept = new Set(choice.flat()),
          removed = new Set(row.filter((i) => !kept.has(i)));
        const pairs = new Map(state.pairs);
        pairs.set(bad, choice);
        const ids = state.ids.filter((i) => !removed.has(i));
        // Deleting one end of an already fixed pair must delete its mate too.
        let changed;
        do {
          changed = false;
          for (const ps of pairs.values())
            for (const [a, b] of ps)
              if (removed.has(a) !== removed.has(b)) {
                removed.add(a);
                removed.add(b);
                changed = true;
              }
        } while (changed);
        queue.push({ ids: ids.filter((i) => !removed.has(i)), pairs, bound });
      }
      timings.branching += performance.now() - t;
      workingState = null;
    }
  } catch (e) {
    status = 'incomplete';
    error = e.message;
    if (workingState) queue.push(workingState);
  }
  checkpoint();
  return {
    status,
    error,
    states,
    pending: queue.length,
    best,
    timings,
    elapsedMs: performance.now() - start,
    sourceGraphOptimalityCertified: false,
  };
}
