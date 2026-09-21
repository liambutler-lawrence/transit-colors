import { geodesicDistanceMeters as distance } from './wgs84-geodesy.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { highwayTurnAllowed } from './highway-turns.mjs';
// Limit source-graph searches to a local interchange; this is not a snapping radius.
const LIMIT = 2500;
function projection(point, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    den = dx * dx + dy * dy;
  const t = den
    ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / den))
    : 0;
  return a.map((v, i) => v + t * (b[i] - v));
}
function nearest(point, coordinates) {
  let best = null,
    along = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i],
      p = projection(point, a, b),
      d = distance(point, p);
    if (!best || d < best.distance)
      best = {
        coordinate: p,
        distance: d,
        segmentIndex: i - 1,
        along: along + distance(a, p),
      };
    along += distance(a, b);
  }
  return { ...best, length: along };
}
function pointAt(chain, position) {
  const i = Math.min(chain.coordinates.length - 2, Math.floor(position)),
    t = position - i;
  return chain.coordinates[i].map((v, j) => v + t * (chain.coordinates[i + 1][j] - v));
}
function direction(a, b) {
  const x = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180),
    y = b[1] - a[1],
    d = Math.hypot(x, y) || 1;
  return [x / d, y / d];
}
function reversed(points) {
  for (let i = 1; i < points.length - 1; i++) {
    const a = direction(points[i - 1], points[i]),
      b = direction(points[i], points[i + 1]);
    if (
      a[0] * b[0] + a[1] * b[1] < -0.1 &&
      distance(points[i - 1], points[i]) > 1 &&
      distance(points[i], points[i + 1]) > 1
    )
      return true;
  }
  return false;
}

// A terminal is extended only when both original opposing carriageways reach
// opposite sides of one continuing paired mainline through actual directed
// freeway edges. Proximity alone never establishes a connection.
export function recoverTerminalContinuations(
  osm,
  prepared,
  chains,
  parts,
  average,
  onlyParts,
) {
  const chainById = new Map(chains.map((c) => [c.id, c])),
    owners = new Map(),
    forward = new Map(),
    backward = new Map();
  const originalCount = parts.length;
  for (const [partIndex, part] of parts.entries())
    for (const [side, range] of (part.sourceRanges ?? []).entries()) {
      const chain = chainById.get(range.chainId);
      if (!chain) continue;
      for (
        let i = Math.ceil(Math.min(...range.positions));
        i <= Math.floor(Math.max(...range.positions));
        i++
      ) {
        const id = chain.nodeIds[i],
          entries = owners.get(id) ?? [];
        entries.push({ partIndex, side });
        owners.set(id, entries);
      }
      // A represented interval can start between widely spaced OSM nodes.
      // Keep that fractional entry so a merge does not overshoot to the next node.
      for (const [position, index, field] of [
        [
          Math.min(...range.positions),
          Math.ceil(Math.min(...range.positions)),
          'entryForward',
        ],
        [
          Math.max(...range.positions),
          Math.floor(Math.max(...range.positions)),
          'entryBackward',
        ],
      ]) {
        const id = chain.nodeIds[index];
        const entries = owners.get(id) ?? [];
        let entry = entries.find(
          (item) => item.partIndex === partIndex && item.side === side,
        );
        if (!entry) {
          entry = { partIndex, side };
          entries.push(entry);
        }
        entry[field] = pointAt(chain, position);
        owners.set(id, entries);
      }
    }
  for (const [role, ways] of [
    ['mainline', prepared.mainlines],
    // One-lane motorway transitions remain connectors; ordinary ramps and
    // collectors must go through the separate reciprocal-ramp matcher.
    ['connector', prepared.connectors.filter((way) => way.mainlineTransition)],
  ])
    for (const way of ways)
      for (let i = 1; i < way.nodeIds.length; i++) {
        const a = way.nodeIds[i - 1],
          b = way.nodeIds[i];
        for (const [graph, from, to] of [
          [forward, a, b],
          [backward, b, a],
        ]) {
          const list = graph.get(from) ?? [];
          list.push({ to, wayId: way.id, role });
          graph.set(from, list);
        }
      }
  const graphFor = (dir) => (dir === 1 ? forward : backward);
  function trace(partIndex, side, atEnd) {
    const part = parts[partIndex],
      range = part.sourceRanges[side],
      chain = chainById.get(range.chainId);
    const dir = (atEnd ? 1 : -1) * (side === 0 ? 1 : -1),
      position =
        dir === 1 ? Math.max(...range.positions) : Math.min(...range.positions),
      index = dir === 1 ? Math.ceil(position) : Math.floor(position);
    const origin = pointAt(chain, position),
      node = chain.nodeIds[index],
      coordinate = chain.coordinates[index];
    const partialFrom = chain.nodeIds[index - dir];
    const partial =
      Math.abs(position - index) > 1e-9
        ? (graphFor(dir).get(partialFrom) ?? []).find((edge) => edge.to === node)
        : null;
    if (Math.abs(position - index) > 1e-9 && !partial) return [];
    const pending = [
        {
          node,
          coordinates:
            distance(origin, coordinate) < 0.001 ? [origin] : [origin, coordinate],
          nodeIds: [node],
          segments: partial ? [{ ...partial, from: partialFrom }] : [],
          length: distance(origin, coordinate),
        },
      ],
      seen = new Map(),
      found = [];
    while (pending.length) {
      pending.sort((a, b) => b.length - a.length);
      const state = pending.pop();
      if (state.length > LIMIT || (seen.get(state.node) ?? Infinity) <= state.length)
        continue;
      seen.set(state.node, state.length);
      const tags = osm.nodes.get(state.node)?.tags;
      if (tags?.highway === 'traffic_signals' && tags.traffic_signals !== 'ramp_meter')
        continue;
      const targets = (owners.get(state.node) ?? []).filter(
        (x) =>
          x.partIndex !== partIndex && parts[x.partIndex].sourceRanges?.length === 2,
      );
      if (targets.length) {
        for (const target of targets) {
          const entry = target[dir === 1 ? 'entryForward' : 'entryBackward'];
          const previous = state.coordinates.at(-2);
          const last = state.coordinates.at(-1);
          const arrivalCoordinate =
            entry &&
            previous &&
            distance(previous, entry) + distance(entry, last) <=
              distance(previous, last) + 0.1
              ? entry
              : last;
          found.push({ ...state, ...target, dir, arrivalCoordinate });
        }
        continue;
      }
      for (const edge of graphFor(dir).get(state.node) ?? []) {
        if (state.nodeIds.includes(edge.to)) continue;
        const coordinate = osm.nodes.get(edge.to).coordinate;
        pending.push({
          ...state,
          node: edge.to,
          coordinates: [...state.coordinates, coordinate],
          nodeIds: [...state.nodeIds, edge.to],
          segments: [...state.segments, { ...edge, from: state.node }],
          length: state.length + distance(state.coordinates.at(-1), coordinate),
        });
      }
    }
    return found;
  }
  // Staggered joins continue on the receiving mainline until both source sides
  // support the same endpoint. Never extend a ramp with a straight chord.
  function extend(state, target, anchor) {
    const allowed = new Set(target.sourceWayIds),
      visited = new Set(state.nodeIds),
      graph = graphFor(state.dir);
    let node = state.node,
      points = [...state.coordinates],
      segments = [...state.segments],
      best = {
        distance: distance(points.at(-1), anchor),
        coordinates: points,
        segments,
      },
      travel = 0;
    if (points.length > 1) {
      const closest = nearest(anchor, points);
      const remainingSegments = points.length - closest.segmentIndex - 2;
      best = {
        distance: closest.distance,
        coordinates: [...points.slice(0, closest.segmentIndex + 1), closest.coordinate],
        segments: segments.slice(0, Math.max(0, segments.length - remainingSegments)),
      };
    }
    while (travel < LIMIT) {
      const edges = (graph.get(node) ?? [])
        .filter((e) => allowed.has(e.wayId) && !visited.has(e.to))
        .sort(
          (a, b) =>
            distance(osm.nodes.get(a.to).coordinate, anchor) -
            distance(osm.nodes.get(b.to).coordinate, anchor),
        );
      const edge = edges[0];
      if (!edge) break;
      const last = points.at(-1),
        next = osm.nodes.get(edge.to).coordinate,
        p = projection(anchor, last, next),
        d = distance(p, anchor);
      segments = [...segments, { ...edge, from: node }];
      if (d < best.distance)
        best = { distance: d, coordinates: [...points, p], segments };
      travel += distance(last, next);
      points = [...points, next];
      node = edge.to;
      visited.add(node);
      if (travel > 500 && distance(next, anchor) > best.distance + 200) break;
    }
    return best;
  }
  const coordinateOwners = new Map();
  const cell = (p) => p.map((v) => Math.floor(v * 10000));
  for (const [index, part] of parts.entries())
    for (const point of part.coordinates) {
      const key = cell(point).join(','),
        entries = coordinateOwners.get(key) ?? [];
      entries.push({ index, point });
      coordinateOwners.set(key, entries);
    }
  const connected = (index, point) => {
    const [x, y] = cell(point);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        if (
          (coordinateOwners.get(`${x + dx},${y + dy}`) ?? []).some(
            (e) => e.index !== index && distanceFast(e.point, point) < 3,
          )
        )
          return true;
    return false;
  };
  const additions = [],
    audit = [],
    acceptedConnections = new Set();
  for (let i = 0; i < originalCount; i++) {
    const part = parts[i];
    if (
      part.role !== 'mainline' ||
      part.sourceRanges?.length !== 2 ||
      part.continuationEndpoints ||
      (onlyParts && !onlyParts.has(i))
    )
      continue;
    for (const atEnd of [false, true]) {
      const endpoint = atEnd ? part.coordinates.at(-1) : part.coordinates[0];
      if (connected(i, endpoint)) continue;
      const a = trace(i, 0, atEnd),
        b = trace(i, 1, atEnd),
        candidates = [];
      for (const first of a)
        for (const second of b) {
          if (first.partIndex !== second.partIndex || first.side === second.side)
            continue;
          const target = parts[first.partIndex],
            travelDirection = first.dir * (first.side === 0 ? 1 : -1);
          // A terminal already within the receiving median corridor is not a
          // wide missing merge. Extending it can duplicate an existing pairing.
          if (nearest(endpoint, target.coordinates).distance < 50) continue;
          const branchDirection = atEnd ? 1 : -1;
          const connectionKey = [
            `${i}:${branchDirection}`,
            `${first.partIndex}:${-travelDirection}`,
          ]
            .sort()
            .join('|');
          if (acceptedConnections.has(connectionKey)) continue;
          const existing = parts.some(
            (p) =>
              (p.role === 'connector' || p.explicitMainlineMerge) &&
              ((p.startMainlinePartIndex === i &&
                p.endMainlinePartIndex === first.partIndex &&
                p.startMainlineDirection === branchDirection &&
                p.endMainlineDirection === -travelDirection) ||
                (p.endMainlinePartIndex === i &&
                  p.startMainlinePartIndex === first.partIndex &&
                  p.endMainlineDirection === branchDirection &&
                  p.startMainlineDirection === -travelDirection)),
          );
          if (existing) continue;
          const projections = [first, second].map((s) =>
            nearest(s.arrivalCoordinate, target.coordinates),
          );
          const anchor = projections.toSorted(
            (a, b) => travelDirection * (b.along - a.along),
          )[0];
          if (
            (travelDirection === 1 ? anchor.length - anchor.along : anchor.along) < 50
          )
            continue;
          const pa = extend(first, target, anchor.coordinate),
            pb = extend(second, target, anchor.coordinate);
          if (
            pa.distance > 160 ||
            pb.distance > 160 ||
            pa.coordinates.length < 2 ||
            pb.coordinates.length < 2
          )
            continue;
          const end = anchor.coordinate.map((v) => Number(v.toFixed(7)));
          const coordinates = average(pa.coordinates, pb.coordinates, endpoint, end);
          if (
            coordinates.length < 2 ||
            distance(endpoint, end) < 50 ||
            reversed(coordinates) ||
            hasProperSelfIntersection(coordinates)
          )
            continue;
          // A midpoint that switches to the wrong branch can be simple yet far
          // closer to one carriageway. Reject it instead of smoothing it over.
          if (
            coordinates
              .slice(1, -1)
              .some(
                (p) =>
                  Math.abs(
                    curveDistance(p, pa.coordinates) - curveDistance(p, pb.coordinates),
                  ) > 35,
              )
          )
            continue;
          const firstEdges = new Set(
            pa.segments.map((s) => [s.from, s.to].sort().join(':')),
          );
          if (pb.segments.some((s) => firstEdges.has([s.from, s.to].sort().join(':'))))
            continue;
          // Two one-lane sides form a ramp pair, not a mainline continuation;
          // leave those to the reciprocal ramp matcher and its movement rules.
          if (
            [pa, pb].every((path) =>
              path.segments.some((segment) => segment.role === 'connector'),
            )
          )
            continue;
          const segments = [...pa.segments, ...pb.segments];
          candidates.push({
            targetIndex: first.partIndex,
            target,
            anchor: { ...anchor, coordinate: end },
            coordinates,
            segments,
            paths: [pa, pb],
            travelDirection,
            length: first.length + second.length,
            connectionKey,
          });
        }
      candidates.sort((a, b) => a.length - b.length);
      const candidate = candidates[0];
      if (!candidate) continue;
      const {
        targetIndex,
        target,
        anchor,
        coordinates,
        segments,
        paths,
        travelDirection,
      } = candidate;
      const id = `osm-terminal-continuation-${part.id}-${atEnd ? 'end' : 'start'}`;
      const sourceWayIds = [...new Set(segments.map((s) => s.wayId))];
      const mixed = segments.some((s) => s.role === 'connector');
      const startKey = id + ':start',
        endKey = id + ':end';
      const targetCoordinates = target.coordinates;
      if (!targetCoordinates.some((c) => distanceFast(c, anchor.coordinate) < 0.01))
        targetCoordinates.splice(anchor.segmentIndex + 1, 0, anchor.coordinate);
      part.topologyCoordinates = [
        ...(part.topologyCoordinates ?? []),
        { coordinate: endpoint, key: startKey },
      ];
      target.topologyCoordinates = [
        ...(target.topologyCoordinates ?? []),
        { coordinate: anchor.coordinate, key: endKey },
      ];
      const addition = {
        id,
        role: mixed ? 'connector' : 'mainline',
        explicitMainlineMerge: true,
        throughMainline: !mixed,
        mixedMainline: mixed,
        coordinates,
        sourceWayIds,
        sourceNodeIds: [...new Set(segments.flatMap((s) => [s.from, s.to]))],
        pairedDirectionCount: 2,
        startMainlinePartIndex: i,
        endMainlinePartIndex: targetIndex,
        startMainlineDirection: atEnd ? 1 : -1,
        endMainlineDirection: -travelDirection,
        startTopologyKeys: [startKey],
        endTopologyKeys: [endKey],
        tokens: [...new Set([...(part.tokens ?? []), ...(target.tokens ?? [])])],
      };
      acceptedConnections.add(candidate.connectionKey);
      additions.push(addition);
      audit.push({
        id,
        branchId: part.id,
        targetId: target.id,
        atEnd,
        paths: paths.map((p) => ({ coordinates: p.coordinates, segments: p.segments })),
        coordinates,
      });
    }
  }
  parts.push(...additions);
  return { additions, audit };
}
function distanceFast(a, b) {
  if (Math.abs(a[0] - b[0]) > 0.0001 || Math.abs(a[1] - b[1]) > 0.0001) return Infinity;
  return distance(a, b);
}

function curveDistance(p, curve) {
  const c = Math.cos((p[1] * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1],
      b = curve[i],
      ax = (a[0] - p[0]) * c * 111320,
      ay = (a[1] - p[1]) * 110574,
      dx = (b[0] - a[0]) * c * 111320,
      dy = (b[1] - a[1]) * 110574,
      t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// Source geometry alone is insufficient: both ports must also attach to usable
// graph legs. Remove failed recoveries before either routing or tile publication.
export function pruneUnusableTerminalContinuations(graph, parts) {
  const additions = parts.filter((part) => part.explicitMainlineMerge);
  if (!additions.length) return [];
  const indexById = new Map(graph.parts.map((part, index) => [part.id, index]));
  const selected = new Set(additions.map((part) => indexById.get(part.id)));
  const edgesByPart = new Map();
  for (const edge of graph.edges)
    for (const index of edge.partIndices)
      if (selected.has(index)) {
        const entries = edgesByPart.get(index) ?? [];
        entries.push(edge);
        edgesByPart.set(index, entries);
      }
  const endpoints = new Set(
    [...edgesByPart.values()].flatMap((edges) => [edges[0].fromId, edges.at(-1).toId]),
  );
  const adjacent = new Map();
  for (const edge of graph.edges)
    for (const node of [edge.fromId, edge.toId])
      if (endpoints.has(node)) {
        const entries = adjacent.get(node) ?? [];
        entries.push(edge);
        adjacent.set(node, entries);
      }
  const rejected = new Set();
  for (const part of additions) {
    const index = indexById.get(part.id);
    const edges = edgesByPart.get(index) ?? [];
    if (
      edges.length !== part.coordinates.length - 1 ||
      !edges.length ||
      [
        [edges[0], edges[0].fromId],
        [edges.at(-1), edges.at(-1).toId],
      ].some(
        ([edge, node]) =>
          !(adjacent.get(node) ?? []).some(
            (other) =>
              !edges.includes(other) &&
              [...other.partIndices].some((index) => !selected.has(index)) &&
              highwayTurnAllowed(edge, other, node),
          ),
      )
    )
      rejected.add(index);
  }
  if (!rejected.size) return [];
  const rejectedIds = additions
    .filter((part) => rejected.has(indexById.get(part.id)))
    .map((part) => part.id);
  graph.edges = graph.edges.filter((edge) => {
    for (const index of rejected) edge.partIndices.delete(index);
    return edge.partIndices.size > 0;
  });
  const keep = parts.filter((part) => !rejectedIds.includes(part.id));
  // Parents always precede the appended recoveries; their indices stay stable.
  parts.splice(0, parts.length, ...keep);
  graph.statistics.rejectedTerminalContinuationIds = rejectedIds;
  graph.statistics.explicitTopologyKeyCount -= rejectedIds.length * 2;
  graph.statistics.sourceConnectorPartCount = parts.filter(
    (part) => part.role === 'connector',
  ).length;
  graph.statistics.sourceTerminalMainlinePartCount = parts.filter(
    (part) => part.explicitMainlineMerge && part.role === 'mainline',
  ).length;
  return rejectedIds;
}
