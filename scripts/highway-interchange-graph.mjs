import { highwayEdgeUsable, highwayTurnAllowed } from './highway-turns.mjs';
import {
  geodesicDistanceMeters,
  signedAreaContributionSquareMeters,
} from './wgs84-geodesy.mjs';
import { planarizeHighways } from './highway-boundary-search.mjs';
import { largestBoundaryRegion } from './highway-boundary-regions.mjs';

const append = (to, points) => {
  for (const p of points) if (!to.length || p.join() !== to.at(-1).join()) to.push(p);
};
const oriented = (e, v) =>
  e.fromId === v ? e.coordinates : e.coordinates.toReversed();
const other = (e, v) => (e.fromId === v ? e.toId : e.fromId);
const inside = (p, b) =>
  p[0] >= b[0] - 1e-10 &&
  p[1] >= b[1] - 1e-10 &&
  p[0] <= b[2] + 1e-10 &&
  p[1] <= b[3] + 1e-10;
const bounds = (points) =>
  points.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
const length = (e) =>
  e.coordinates
    .slice(1)
    .reduce((n, p, i) => n + geodesicDistanceMeters(e.coordinates[i], p), 0);
const hull = (points) => {
  const p = [...new Map(points.map((p) => [p.join(), p])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (row) => {
    const out = [];
    for (const q of row) {
      while (out.length > 1 && cross(out.at(-2), out.at(-1), q) <= 0) out.pop();
      out.push(q);
    }
    return out;
  };
  return [...half(p).slice(0, -1), ...half(p.toReversed()).slice(0, -1), p[0]].filter(
    Boolean,
  );
};

// Bound a geodesic ball with a latitude/longitude rectangle. The conservative
// global curvature limits also cover points between stored source vertices;
// a lon/lat convex hull alone would miss the bulge of a long geodesic.
function footprintBound(center, points, check) {
  let radius = 0,
    longest = 0;
  for (let i = 0; i < points.length; i++) {
    if (i % 1024 === 0) check();
    radius = Math.max(radius, geodesicDistanceMeters(center, points[i]));
    if (i)
      longest = Math.max(longest, geodesicDistanceMeters(points[i - 1], points[i]));
  }
  radius += longest / 2;
  const angular = radius / 6335000,
    latitude = (center[1] * Math.PI) / 180;
  const low = Math.max(-Math.PI / 2, latitude - angular),
    high = Math.min(Math.PI / 2, latitude + angular);
  const cosine = Math.cos(Math.max(Math.abs(low), Math.abs(high)));
  const width =
    cosine < 1e-10 ? 2 * Math.PI : Math.min(2 * Math.PI, (2 * angular) / cosine);
  return 6400000 ** 2 * width * (Math.sin(high) - Math.sin(low));
}

// The source graph remains available for government-seat routing and movement
// witnesses. This separate solver view contains only external mainline edges.
export function buildInterchangeGraph(source, parts, { check = () => {} } = {}) {
  const begun = performance.now(),
    timings = {};
  const parent = new Map(),
    find = (v) => {
      if (!parent.has(v)) parent.set(v, v);
      let r = v;
      while (parent.get(r) !== r) r = parent.get(r);
      while (v !== r) {
        const next = parent.get(v);
        parent.set(v, r);
        v = next;
      }
      return r;
    };
  const join = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  const nodes = new Map(source.nodes.map((n) => [n.id, n.coordinate]));
  const ramp = new Set();
  source.edges.forEach((e, i) => {
    if (i % 1024 === 0) check();
    if (!highwayEdgeUsable(e)) return;
    const internal = [...e.partIndices].map(
      (j) => parts[j]?.role === 'connector' || Boolean(parts[j]?.explicitMainlineMerge),
    );
    if (internal.some(Boolean) && !internal.every(Boolean))
      throw new Error(
        `Compressed highway edge ${i} mixes mainlines with ramps; rebuild the source graph.`,
      );
    if (internal.length && internal.every(Boolean)) {
      ramp.add(i);
      join(e.fromId, e.toId);
    }
  });
  // Fill only explicit intervals between contacts on the same midpoint part.
  // Overlapping intervals unite a complex; nearby independent roads never do.
  const position = (id) => {
    const m = /^center:(\d+):(\d+)$/.exec(id);
    return m ? { part: m[1], index: Number(m[2]) } : null;
  };
  let changed = true,
    intervals,
    boxes;
  while (changed) {
    check();
    changed = false;
    const spans = new Map();
    boxes = new Map();
    for (const i of ramp) {
      const root = find(source.edges[i].fromId),
        box = bounds(source.edges[i].coordinates),
        prior = boxes.get(root);
      boxes.set(
        root,
        prior
          ? bounds([
              [prior[0], prior[1]],
              [prior[2], prior[3]],
              [box[0], box[1]],
              [box[2], box[3]],
            ])
          : box,
      );
    }
    for (const id of parent.keys()) {
      const p = position(id);
      if (!p) continue;
      const root = find(id),
        key = `${root}\0${p.part}`;
      if (!spans.has(key))
        spans.set(key, { root, part: p.part, min: p.index, max: p.index });
      const span = spans.get(key);
      span.min = Math.min(span.min, p.index);
      span.max = Math.max(span.max, p.index);
    }
    intervals = new Map();
    for (const span of spans.values()) {
      if (!intervals.has(span.part)) intervals.set(span.part, []);
      intervals.get(span.part).push(span);
    }
    for (const rows of intervals.values()) {
      rows.sort((a, b) => a.min - b.min);
      let last = rows[0];
      for (const row of rows.slice(1))
        if (row.min <= last.max) {
          const a = boxes.get(row.root),
            b = boxes.get(last.root);
          if (a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) {
            if (find(row.root) !== find(last.root)) {
              join(row.root, last.root);
              changed = true;
            }
            last.max = Math.max(last.max, row.max);
          }
        } else last = row;
    }
    for (const n of source.nodes) {
      const p = position(n.id);
      if (!p) continue;
      const row = intervals
        .get(p.part)
        ?.find(
          (r) =>
            p.index >= r.min &&
            p.index <= r.max &&
            inside(n.coordinate, boxes.get(r.root)),
        );
      if (row) {
        const before = parent.has(n.id) ? find(n.id) : null;
        join(n.id, row.root);
        if (before !== null && before !== find(row.root)) changed = true;
      }
    }
  }
  const components = new Map(),
    internal = new Set(ramp),
    incident = new Map();
  const add = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };
  source.edges.forEach((e, i) => {
    if (!highwayEdgeUsable(e)) return;
    add(incident, e.fromId, i);
    add(incident, e.toId, i);
    if (
      parent.has(e.fromId) &&
      parent.has(e.toId) &&
      find(e.fromId) === find(e.toId) &&
      e.coordinates.every((p) => inside(p, boxes.get(find(e.fromId))))
    )
      internal.add(i);
  });
  for (const id of parent.keys()) {
    const root = find(id);
    if (!components.has(root))
      components.set(root, {
        id: `interchange:${root}`,
        members: [],
        internal: [],
        approaches: [],
        movements: new Map(),
      });
    components.get(root).members.push(id);
  }
  for (const i of internal)
    components.get(find(source.edges[i].fromId)).internal.push(i);
  const componentAt = (id) => (parent.has(id) ? components.get(find(id)) : null);
  let footprintArea = 0;
  for (const component of components.values()) {
    check();
    const points = component.internal.flatMap((i) => source.edges[i].coordinates);
    component.coordinate = component.members.reduce(
      (p, id) => p.map((v, k) => v + nodes.get(id)[k] / component.members.length),
      [0, 0],
    );
    component.footprint = hull(points);
    component.footprintArea = footprintBound(component.coordinate, points, check);
    footprintArea += component.footprintArea;
  }
  const edges = [],
    macroNodes = new Map();
  const emit = (e, index, fromId, toId, coordinates, fromApproach, toApproach) => {
    const from = componentAt(fromId),
      to = componentAt(toId);
    const edge = {
      ...e,
      fromId: from?.id ?? fromId,
      toId: to?.id ?? toId,
      sourceIndex: index,
      physicalCoordinates: coordinates,
      physicalStart: coordinates[0],
      physicalEnd: coordinates.at(-1),
      fromApproach: from ? fromApproach : undefined,
      toApproach: to ? toApproach : undefined,
      coordinates: [],
    };
    append(edge.coordinates, [
      from?.coordinate ?? coordinates[0],
      ...coordinates,
      to?.coordinate ?? coordinates.at(-1),
    ]);
    for (const [component, nodeId, key] of [
      [from, fromId, fromApproach],
      [to, toId, toApproach],
    ])
      if (component)
        component.approaches.push({
          key,
          nodeId,
          sourceIndex: index,
          edgeIndex: edges.length,
        });
    macroNodes.set(edge.fromId, from?.coordinate ?? coordinates[0]);
    macroNodes.set(edge.toId, to?.coordinate ?? coordinates.at(-1));
    edges.push(edge);
  };
  source.edges.forEach((e, i) => {
    if (internal.has(i) || !highwayEdgeUsable(e)) return;
    if (componentAt(e.fromId) && componentAt(e.fromId) === componentAt(e.toId)) {
      // A road may leave and return to a complex. Keep both distinct approaches
      // by subdividing that external loop; do not discard it as a self-edge.
      const middle = Math.floor(e.coordinates.length / 2),
        id = `external-loop:${i}`;
      const left = e.coordinates.slice(0, middle + 1),
        right = e.coordinates.slice(middle);
      emit(e, i, e.fromId, id, left, `${i}:${e.fromId}`, undefined);
      emit(e, i, id, e.toId, right, undefined, `${i}:${e.toId}`);
    } else
      emit(e, i, e.fromId, e.toId, e.coordinates, `${i}:${e.fromId}`, `${i}:${e.toId}`);
  });
  timings.groupingMs = performance.now() - begun;
  const started = performance.now();
  const lengths = new Map();
  for (const component of components.values()) {
    check();
    const allowed = new Set(component.internal),
      exits = new Map();
    for (const approach of component.approaches) add(exits, approach.nodeId, approach);
    for (const approach of component.approaches) {
      const queue = [
          {
            node: approach.nodeId,
            incoming: approach.sourceIndex,
            distance: 0,
            steps: [],
          },
        ],
        best = new Map();
      while (queue.length) {
        check();
        queue.sort((a, b) => b.distance - a.distance);
        const state = queue.pop(),
          key = `${state.node}\0${state.incoming}`;
        if ((best.get(key) ?? Infinity) <= state.distance) continue;
        best.set(key, state.distance);
        for (const exit of exits.get(state.node) ?? []) {
          if (
            exit.key === approach.key ||
            !highwayTurnAllowed(
              source.edges[state.incoming],
              source.edges[exit.sourceIndex],
              state.node,
            )
          )
            continue;
          const key = `${approach.key}|${exit.key}`,
            prior = component.movements.get(key);
          if (!prior || state.distance < prior.lengthMeters) {
            const coordinates = [nodes.get(approach.nodeId)];
            for (const step of state.steps)
              append(coordinates, oriented(source.edges[step.edgeIndex], step.fromId));
            component.movements.set(key, {
              from: approach.key,
              to: exit.key,
              sourceSteps: state.steps,
              coordinates,
              lengthMeters: state.distance,
              area: signedAreaContributionSquareMeters(coordinates),
            });
          }
        }
        for (const i of incident.get(state.node) ?? []) {
          if (
            !allowed.has(i) ||
            !highwayTurnAllowed(
              source.edges[state.incoming],
              source.edges[i],
              state.node,
            )
          )
            continue;
          const e = source.edges[i],
            next = other(e, state.node);
          if (!lengths.has(i)) lengths.set(i, length(e));
          queue.push({
            node: next,
            incoming: i,
            distance: state.distance + lengths.get(i),
            steps: [...state.steps, { edgeIndex: i, fromId: state.node, toId: next }],
          });
        }
      }
    }
  }
  timings.movementsMs = performance.now() - started;
  return {
    nodes: [...macroNodes].map(([id, coordinate]) => ({ id, coordinate })),
    edges,
    interchanges: new Map([...components.values()].map((c) => [c.id, c])),
    source,
    parts,
    footprintArea,
    timings,
    statistics: {
      sourceNodes: source.nodes.length,
      sourceEdges: source.edges.length,
      interchanges: components.size,
      internalEdges: internal.size,
      mainlineEdges: edges.length,
      approaches: [...components.values()].reduce((n, c) => n + c.approaches.length, 0),
      movements: [...components.values()].reduce((n, c) => n + c.movements.size, 0),
    },
  };
}

export function attachInterchangeBoundaryGraph(planar, macro) {
  const scoreCache = new Map(),
    scoreStatistics = { hits: 0, misses: 0 };
  const originalLegal = planar.legal,
    endpoint = (e, v) =>
      e.fromId === v && e.start === 0
        ? 'from'
        : e.toId === v && e.end === planar.roads[e.road].coordinates.length - 1
          ? 'to'
          : null;
  const movement = (a, b, v) => {
    const ea = planar.edges[a],
      eb = planar.edges[b],
      sa = endpoint(ea, v),
      sb = endpoint(eb, v);
    if (!sa || !sb) return undefined;
    const ra = planar.roads[ea.road],
      rb = planar.roads[eb.road],
      node = ra[`${sa}Id`];
    if (node !== rb[`${sb}Id`] || !macro.interchanges.has(node)) return undefined;
    return (
      macro.interchanges
        .get(node)
        .movements.get(`${ra[`${sa}Approach`]}|${rb[`${sb}Approach`]}`) ?? null
    );
  };
  const legal = (a, b, v) => {
    const m = movement(a, b, v);
    return m === undefined ? originalLegal(a, b, v) : m !== null;
  };
  const ranges = planar.roads.map((r) => [
    r.coordinates.findIndex((p) => p.join() === r.physicalStart.join()),
    r.coordinates.findLastIndex((p) => p.join() === r.physicalEnd.join()),
  ]);
  const physical = (e) => {
    const road = planar.roads[e.road],
      range = ranges[e.road],
      start = Math.max(e.start, range[0]),
      end = Math.min(e.end, range[1]);
    if (start > end) return [];
    const coordinates = [
      start === e.start ? e.coordinates[0] : road.coordinates[range[0]],
    ];
    for (let i = Math.floor(start) + 1; i < end; i++)
      coordinates.push(road.coordinates[i]);
    append(coordinates, [
      end === e.end ? e.coordinates.at(-1) : road.coordinates[range[1]],
    ]);
    return coordinates;
  };
  const expand = (walk, { allowForbiddenTurns = false } = {}) => {
    const coordinates = [],
      pieces = [];
    for (let i = 0; i < walk.length; i++) {
      const h = walk[i],
        e = planar.edges[h >> 1],
        next = walk[(i + 1) % walk.length],
        v = h % 2 ? e.fromId : e.toId;
      const allowed = legal(h >> 1, next >> 1, v);
      if (!allowed && !allowForbiddenTurns)
        throw Error('Forbidden interchange movement');
      const line = physical(e);
      if (h % 2) line.reverse();
      append(coordinates, line);
      if (line.length > 1)
        pieces.push({
          role: 'mainline',
          coordinates: line,
          sourceIndex: planar.roads[e.road].sourceIndex,
          reverse: Boolean(h % 2),
        });
      const m = movement(h >> 1, next >> 1, v);
      if (m) {
        append(coordinates, m.coordinates);
        for (const step of m.sourceSteps) {
          const edge = macro.source.edges[step.edgeIndex];
          pieces.push({
            role: [...edge.partIndices].some(
              (i) => macro.parts[i]?.role === 'connector',
            )
              ? 'connector'
              : 'mainline',
            coordinates: oriented(edge, step.fromId),
            sourceIndex: step.edgeIndex,
            reverse: edge.toId === step.fromId,
          });
        }
      } else if (!allowed) {
        // Keep the forbidden transition visible in a local diagnostic. Real
        // movements still use their normal stored source geometry above.
        const following = physical(planar.edges[next >> 1]);
        if (next % 2) following.reverse();
        const bridge = [
          coordinates.at(-1) ?? planar.nodes[v].coordinate,
          planar.nodes[v].coordinate,
          following[0] ?? planar.nodes[v].coordinate,
        ].filter((p, j, a) => !j || p.join() !== a[j - 1].join());
        append(coordinates, bridge);
        if (bridge.length > 1)
          pieces.push({
            role: 'mainline',
            coordinates: bridge,
            sourceIndex: planar.roads[e.road].sourceIndex,
            reverse: Boolean(h % 2),
            diagnosticOnly: true,
          });
      }
    }
    if (coordinates.length && coordinates[0].join() !== coordinates.at(-1).join())
      throw Error('Expanded interchange route does not close');
    return { coordinates, pieces };
  };
  return {
    ...planar,
    legal,
    interchangeGraph: macro,
    relaxationUpperBound: (faces) =>
      faces.reduce((sum, f) => sum + (f.area < 0 ? -f.area : 0), 0) +
      macro.footprintArea,
    sourceVertexMayRepeat: (vertex) => macro.interchanges.has(vertex),
    expand,
    transitionKind: (a, b, v) =>
      movement(a, b, v) === null ? 'interchange-movement' : 'geometric-contact',
    scoreStatistics,
    scoreWalk: (walk, check) => {
      // Branches leave most candidate walks unchanged. Cache a rotation of
      // the exact oriented walk; reverse movements can have different witnesses.
      let first = 0;
      for (let i = 1; i < walk.length; i++) if (walk[i] < walk[first]) first = i;
      const key = [...walk.slice(first), ...walk.slice(0, first)].join(',');
      if (scoreCache.has(key)) {
        const score = scoreCache.get(key);
        scoreCache.delete(key);
        scoreCache.set(key, score);
        scoreStatistics.hits++;
        return score;
      }
      scoreStatistics.misses++;
      const expanded = expand(walk);
      if (expanded.coordinates.length < 4)
        return { area: 0, boundary: [], ...expanded };
      let middle = Math.floor(expanded.coordinates.length / 2);
      while (
        middle > 0 &&
        expanded.coordinates[middle].join() === expanded.coordinates[0].join()
      )
        middle--;
      if (!middle) return { area: 0, boundary: [], ...expanded };
      const geometry = planarizeHighways(
        [
          {
            fromId: 'route:0',
            toId: 'route:1',
            coordinates: expanded.coordinates.slice(0, middle + 1),
          },
          {
            fromId: 'route:1',
            toId: 'route:0',
            coordinates: expanded.coordinates.slice(middle),
          },
        ],
        check,
        { geodesic: true },
      );
      const region = largestBoundaryRegion(
        geometry,
        geometry.edges.map((_, i) => 2 * i),
      );
      const score = { ...region, ...expanded };
      scoreCache.set(key, score);
      if (scoreCache.size > 128) scoreCache.delete(scoreCache.keys().next().value);
      return score;
    },
  };
}
