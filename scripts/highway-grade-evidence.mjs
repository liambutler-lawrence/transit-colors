import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const metresPerDegree = 111_195;
const radians = Math.PI / 180;
const sampleSpacingMetres = 15;
const maxRoadOffsetMetres = 170;
const maxUnobservedWayMetres = 35;
const cellDegrees = 0.005;
const motorwayClasses = new Set(['motorway', 'motorway_link']);
const crossingHighways = new Set([
  'crossing',
  'give_way',
  'mini_roundabout',
  'stop',
  'traffic_signals',
]);
const crossingRailways = new Set(['crossing', 'level_crossing', 'railway_crossing']);
const recognizedTurns = new Set([
  '',
  'none',
  'through',
  'left',
  'slight_left',
  'sharp_left',
  'right',
  'slight_right',
  'sharp_right',
  'reverse',
  'merge_to_left',
  'merge_to_right',
]);
const throughTurns = new Set(['', 'none', 'through']);

export function gradeForLaneCount(count) {
  if (!count) return null;
  return ['A-', 'A', 'A+', 'A++'][Math.min(count, 4) - 1];
}

function isAtGradeConflict(tags = {}) {
  if (tags.crossing && tags.crossing !== 'no') return true;
  if (crossingRailways.has(tags.railway)) return true;
  if (!crossingHighways.has(tags.highway)) return false;
  return tags.highway !== 'traffic_signals' || tags.traffic_signals !== 'ramp_meter';
}

function positiveLaneCount(value) {
  return /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
}

function directionTag(tags, tag) {
  const direction = tags.oneway === '-1' ? 'backward' : 'forward';
  return tags[tag] ?? tags[`${tag}:${direction}`];
}

export function throughLaneCount(tags, { connector = false } = {}) {
  if (
    tags.lane_markings === 'no' ||
    tags['lanes:conditional'] ||
    tags['turn:lanes:conditional'] ||
    tags['oneway:conditional']
  ) {
    return null;
  }

  const raw = directionTag(tags, 'lanes');
  const taggedCount = positiveLaneCount(raw);
  if (raw !== undefined && taggedCount === null) return null;

  const turnMarkings = directionTag(tags, 'turn:lanes')?.split('|');
  if (
    turnMarkings?.some((lane) =>
      lane.split(';').some((turn) => !recognizedTurns.has(turn)),
    )
  ) {
    return null;
  }
  const count = taggedCount ?? turnMarkings?.length;
  if (!count || (turnMarkings && turnMarkings.length !== count)) return null;

  const motorAccess = directionTag(tags, 'motor_vehicle:lanes')?.split('|');
  const vehicleAccess = directionTag(tags, 'vehicle:lanes')?.split('|');
  const access = directionTag(tags, 'access:lanes')?.split('|');
  const buses = directionTag(tags, 'bus:lanes')?.split('|');
  const signedRefs = directionTag(tags, 'destination:ref:lanes')?.split('|');
  for (const markings of [motorAccess, vehicleAccess, access, buses]) {
    if (markings && markings.length !== count) return null;
  }

  const routeRefs = tags.ref?.split(/\s*;\s*/) ?? [];
  let through = 0;
  for (let lane = 0; lane < count; lane += 1) {
    const permitted = motorAccess?.[lane] || vehicleAccess?.[lane] || access?.[lane];
    if (
      permitted === 'no' ||
      permitted === 'private' ||
      buses?.[lane] === 'designated'
    ) {
      continue;
    }
    const turns = turnMarkings?.[lane].split(';');
    if (!connector && !turns && signedRefs?.length === count && routeRefs.length) {
      const destinations = signedRefs[lane].split(/\s*;\s*/).filter(Boolean);
      if (destinations.length && !destinations.some((ref) => routeRefs.includes(ref))) {
        continue;
      }
    }
    // For a ramp, the turn onto the connecting freeway is the through
    // movement. Lanes that simply merge away never add a through lane.
    if (
      !turns ||
      turns.some((turn) =>
        connector
          ? count === 1 || !turn.startsWith('merge_to_')
          : throughTurns.has(turn),
      )
    ) {
      through += 1;
    }
  }
  return through || null;
}

function publicRoadEvidence(tags) {
  return (
    !tags.construction &&
    tags.access !== 'no' &&
    tags.access !== 'private' &&
    tags.motor_vehicle !== 'no' &&
    tags.motor_vehicle !== 'private' &&
    !tags['oneway:conditional']
  );
}

function sourceRoad(way, nodes, gradeSeparatedNodes) {
  const { id, tags } = way;
  if (
    !motorwayClasses.has(tags.highway) ||
    (tags.oneway && tags.oneway !== 'yes' && tags.oneway !== '-1')
  ) {
    return null;
  }
  const nodeIds = tags.oneway === '-1' ? way.nodeIds.toReversed() : way.nodeIds;
  const coordinates = nodeIds.map((nodeId) => nodes.get(nodeId)?.coordinate);
  if (coordinates.length < 2 || coordinates.some((coordinate) => !coordinate))
    return null;
  const connector = tags.highway === 'motorway_link';
  const accessible = publicRoadEvidence(tags);
  const divided = tags.divider !== 'no' && tags.divided !== 'no';
  const confirmedJunction =
    tags.junction === 'roundabout' || tags.junction === 'circular';
  const conflicts = nodeIds
    .filter((nodeId) => !gradeSeparatedNodes.has(nodeId))
    .map((nodeId) => nodes.get(nodeId).tags)
    .filter(isAtGradeConflict);
  // A traffic control alone does not establish a crossing. A foot crossing
  // tagged on a motorway mainline can also be a misattached overpass node.
  const atGrade =
    confirmedJunction ||
    conflicts.some(
      (node) =>
        node.railway === 'level_crossing' ||
        node.highway === 'mini_roundabout' ||
        (connector &&
          !(tags.foot === 'no' && tags.bicycle === 'no') &&
          (node.highway === 'crossing' || (node.crossing && node.crossing !== 'no'))),
    );
  const separated =
    !confirmedJunction &&
    !conflicts.length &&
    (!tags.access_control || tags.access_control === 'full');
  return {
    id,
    coordinates,
    firstNode: nodeIds[0],
    lastNode: nodeIds.at(-1),
    accessible,
    divided,
    separated,
    atGrade,
    separation: accessible && divided && separated,
    lanes: throughLaneCount(tags, { connector }),
    connector,
    refs: new Set(
      (tags.ref ?? '')
        .split(/[;,]/)
        .map((ref) => ref.trim())
        .filter(Boolean),
    ),
  };
}

export function roadCorridor(osm, route) {
  const cell = 0.04;
  const cells = new Set();
  for (const section of route.segments) {
    for (const [longitude, latitude] of section.coordinates) {
      const x = Math.floor(longitude / cell);
      const y = Math.floor(latitude / cell);
      for (let column = x - 1; column <= x + 1; column += 1) {
        for (let row = y - 1; row <= y + 1; row += 1) cells.add(`${column},${row}`);
      }
    }
  }
  const ways = osm.ways.filter((way) =>
    way.nodeIds.some((id) => {
      const coordinate = osm.nodes.get(id)?.coordinate;
      if (!coordinate) return false;
      const [longitude, latitude] = coordinate;
      return cells.has(
        `${Math.floor(longitude / cell)},${Math.floor(latitude / cell)}`,
      );
    }),
  );
  const retainedIds = new Set(ways.flatMap((way) => way.nodeIds));
  return {
    ways,
    nodes: new Map(
      [...retainedIds].flatMap((id) =>
        osm.nodes.has(id) ? [[id, osm.nodes.get(id)]] : [],
      ),
    ),
  };
}

function gridKey(column, row) {
  return column * 1_000_000 + row;
}

export function roadEvidence(osm, { gradeSeparatedNodes = new Set() } = {}) {
  const grid = new Map();
  const roads = new Map();
  const fromNode = new Map();
  const longitudeBuffer = 240 / (metresPerDegree * 0.56);
  const latitudeBuffer = 240 / metresPerDegree;

  for (const way of osm.ways) {
    const road = sourceRoad(way, osm.nodes, gradeSeparatedNodes);
    if (!road) continue;
    roads.set(road.id, road);
    if (road.connector) continue;
    const outgoing = fromNode.get(road.firstNode) ?? [];
    outgoing.push(road);
    fromNode.set(road.firstNode, outgoing);
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const start = road.coordinates[index - 1];
      const end = road.coordinates[index];
      if (start[0] === end[0] && start[1] === end[1]) continue;
      const edge = { start, end, road };
      const left = Math.floor(
        (Math.min(start[0], end[0]) - longitudeBuffer) / cellDegrees,
      );
      const right = Math.floor(
        (Math.max(start[0], end[0]) + longitudeBuffer) / cellDegrees,
      );
      const bottom = Math.floor(
        (Math.min(start[1], end[1]) - latitudeBuffer) / cellDegrees,
      );
      const top = Math.floor(
        (Math.max(start[1], end[1]) + latitudeBuffer) / cellDegrees,
      );
      for (let column = left; column <= right; column += 1) {
        for (let row = bottom; row <= top; row += 1) {
          const key = gridKey(column, row);
          const entries = grid.get(key) ?? [];
          entries.push(edge);
          grid.set(key, entries);
        }
      }
    }
  }
  return { grid, roads, fromNode };
}

function projectedRoads(edges, point, heading, longitudeMetres) {
  const directions = [new Map(), new Map()];
  for (const { start, end, road } of edges) {
    const x = (start[0] - point[0]) * longitudeMetres;
    const y = (start[1] - point[1]) * metresPerDegree;
    const dx = (end[0] - start[0]) * longitudeMetres;
    const dy = (end[1] - start[1]) * metresPerDegree;
    const length = Math.hypot(dx, dy);
    const alignment = (dx * heading[0] + dy * heading[1]) / length;
    if (Math.abs(alignment) < 0.79) continue;
    const projection = -(x * dx + y * dy) / length;
    if (projection < -2 || projection > length + 2) continue;
    const fraction = Math.max(0, Math.min(1, projection / length));
    const px = x + dx * fraction;
    const py = y + dy * fraction;
    const offset = -px * heading[1] + py * heading[0];
    if ((alignment > 0 ? offset : -offset) > 9) continue;
    const distance = Math.hypot(px, py);
    if (distance > maxRoadOffsetMetres) continue;
    const along = directions[alignment > 0 ? 0 : 1];
    const result = { px, py, offset, distance, road, alignment: Math.abs(alignment) };
    if (!along.has(road.id) || along.get(road.id).distance > distance) {
      along.set(road.id, result);
    }
  }
  return directions;
}

function choosePair(evidence, point, heading, longitudeMetres, prior) {
  const key = gridKey(
    Math.floor(point[0] / cellDegrees),
    Math.floor(point[1] / cellDegrees),
  );
  const [forward, reverse] = projectedRoads(
    evidence.grid.get(key) ?? [],
    point,
    heading,
    longitudeMetres,
  );
  let best = null;
  for (const a of forward.values()) {
    for (const b of reverse.values()) {
      if (a.road.id === b.road.id || Math.abs(a.offset - b.offset) < 2) continue;
      if (
        a.road.refs.size &&
        b.road.refs.size &&
        ![...a.road.refs].some((ref) => b.road.refs.has(ref))
      )
        continue;
      const centreOffset = Math.hypot((a.px + b.px) / 2, (a.py + b.py) / 2);
      const centred = centreOffset <= Math.max(12, (a.distance + b.distance) * 0.2);
      // Some route-graph edges follow an individual mapped carriageway through
      // a gap in the averaged geometry. Require a close match and a signed
      // opposing carriageway before extending the grade across those edges.
      if (
        !centred &&
        (Math.min(a.distance, b.distance) > 2 ||
          Math.max(a.distance, b.distance) > 80 ||
          Math.min(a.alignment, b.alignment) < 0.93 ||
          !a.road.refs.size ||
          !b.road.refs.size)
      )
        continue;
      const changed = prior
        ? Number(a.road.id !== prior[0].id) + Number(b.road.id !== prior[1].id)
        : 0;
      const score =
        a.distance +
        b.distance +
        centreOffset * 3 +
        (2 - a.alignment - b.alignment) * 14 +
        (centred ? 0 : 30) +
        changed * 0.25;
      if (best === null || score < best.score) best = { score, pair: [a.road, b.road] };
    }
  }
  return best?.pair ?? null;
}

function shortConnection(from, to, fromNode, remaining = maxUnobservedWayMetres) {
  if (from.id === to.id || from.lastNode === to.firstNode) return [];
  let matching = null;
  for (const road of fromNode.get(from.lastNode) ?? []) {
    if (road.id === from.id) continue;
    const straightDistance = geodesicDistanceMeters(
      road.coordinates[0],
      road.coordinates.at(-1),
    );
    if (straightDistance > remaining) continue;
    const length = road.coordinates
      .slice(1)
      .reduce(
        (sum, coordinate, index) =>
          sum + geodesicDistanceMeters(road.coordinates[index], coordinate),
        0,
      );
    if (length <= 0 || length > remaining) continue;
    const tail = shortConnection(road, to, fromNode, remaining - length);
    if (!tail) continue;
    if (matching) return null;
    matching = [road, ...tail];
  }
  return matching;
}

export function reviewMainline(coordinates, evidence, { fullRubric = false } = {}) {
  let minimum = Infinity;
  let hasAtGrade = false;
  let fullyDivided = true;
  let prior = null;
  let pending = null;
  let mileage = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const longitudeMetres =
      metresPerDegree * Math.cos(((start[1] + end[1]) * radians) / 2);
    const dx = (end[0] - start[0]) * longitudeMetres;
    const dy = (end[1] - start[1]) * metresPerDegree;
    const length = Math.hypot(dx, dy);
    if (length < 0.015) continue;
    const steps = Math.max(1, Math.ceil(length / sampleSpacingMetres));
    const heading = [dx / length, dy / length];
    for (let step = 0; step < steps; step += 1) {
      const fraction = (step + 0.5) / steps;
      const point = start.map((value, axis) => value + fraction * (end[axis] - value));
      const distance = mileage + fraction * length;
      const pair = choosePair(evidence, point, heading, longitudeMetres, prior);
      if (pending && distance - pending.distance > maxUnobservedWayMetres) {
        return pending.issue;
      }
      if (!pair) {
        const issue = { reason: 'Unmatched opposing carriageways', point };
        if (!prior) return issue;
        pending ??= { distance, issue };
        continue;
      }
      let crossed = pair;
      if (prior) {
        const forward = shortConnection(prior[0], pair[0], evidence.fromNode);
        const reverse = shortConnection(pair[1], prior[1], evidence.fromNode);
        if (!forward || !reverse) {
          const issue = { reason: 'Unverified carriageway connection', point };
          pending ??= { distance, issue };
          continue;
        }
        crossed = [...pair, ...forward, ...reverse];
      }
      pending = null;
      const exception = fullRubric
        ? unresolvedRoadEvidence
        : (road) => !road.separation;
      if (crossed.some(exception)) {
        return {
          reason: 'Separation or access exception',
          point,
          wayIds: crossed.filter(exception).map((road) => road.id),
        };
      }
      if (crossed.some((road) => !road.lanes)) {
        return {
          reason: 'Missing or ambiguous through lanes',
          point,
          wayIds: crossed.filter((road) => !road.lanes).map((road) => road.id),
        };
      }
      minimum = Math.min(minimum, ...crossed.map((road) => road.lanes));
      hasAtGrade ||= crossed.some((road) => road.atGrade);
      fullyDivided &&= crossed.every((road) => road.divided);
      prior = pair;
    }
    mileage += length;
  }
  if (pending) return pending.issue;
  return Number.isFinite(minimum)
    ? {
        grade: fullRubric
          ? roadGrade(minimum, fullyDivided, hasAtGrade)
          : gradeForLaneCount(minimum),
      }
    : { reason: 'No usable carriageway geometry', point: coordinates[0] };
}

function roadGrade(lanes, divided, atGrade) {
  if (atGrade) return lanes >= 2 ? 'B' : 'C';
  return divided ? gradeForLaneCount(lanes) : 'A-';
}

function unresolvedRoadEvidence(road) {
  return !road?.accessible || (!road.separated && !road.atGrade);
}

export function reviewReciprocalWays(wayIds, roads, point) {
  if (!wayIds.length) return { reason: 'Unverified reciprocal ramp paths', point };
  const source = wayIds.map((id) => roads.get(id));
  if (source.some(unresolvedRoadEvidence)) {
    return {
      reason: 'Separation or access exception',
      point,
      wayIds: wayIds.filter((id) => unresolvedRoadEvidence(roads.get(id))),
    };
  }
  if (source.some((road) => !road.lanes)) {
    return {
      reason: 'Missing or ambiguous through lanes',
      point,
      wayIds: source.filter((road) => !road.lanes).map((road) => road.id),
    };
  }
  return {
    grade: roadGrade(
      Math.min(...source.map((road) => road.lanes)),
      source.every((road) => road.divided),
      source.some((road) => road.atGrade),
    ),
  };
}

function distanceToLine(point, coordinates) {
  const longitudeMetres = metresPerDegree * Math.cos(point[1] * radians);
  let best = Infinity;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const x = (start[0] - point[0]) * longitudeMetres;
    const y = (start[1] - point[1]) * metresPerDegree;
    const dx = (end[0] - start[0]) * longitudeMetres;
    const dy = (end[1] - start[1]) * metresPerDegree;
    const squaredLength = dx * dx + dy * dy;
    const fraction = squaredLength
      ? Math.max(0, Math.min(1, -(x * dx + y * dy) / squaredLength))
      : 0;
    best = Math.min(best, Math.hypot(x + fraction * dx, y + fraction * dy));
  }
  return best;
}

function linesAgree(first, second) {
  // The route graph can insert a short connection at a ramp endpoint.
  // Compare both interiors to prevent borrowing a neighbouring ramp's lanes.
  const interiorTolerance = 14;
  const endpointTolerance = 35;
  const endpoints = [
    [first[0], second[0], first.at(-1), second.at(-1)],
    [first[0], second.at(-1), first.at(-1), second[0]],
  ];
  if (
    !endpoints.some(
      ([a, b, c, d]) =>
        geodesicDistanceMeters(a, b) <= endpointTolerance &&
        geodesicDistanceMeters(c, d) <= endpointTolerance,
    )
  )
    return false;
  return [
    [first, second],
    [second, first],
  ].every(([line, target]) =>
    line.every(
      (coordinate, index) =>
        distanceToLine(coordinate, target) <=
        (index === 0 || index === line.length - 1
          ? endpointTolerance
          : interiorTolerance),
    ),
  );
}

export function reviewConnector(coordinates, pairedConnectors, roads) {
  const matching = pairedConnectors.filter((part) =>
    linesAgree(coordinates, part.coordinates),
  );
  const sourceSignatures = new Set(
    matching.map((part) => part.sourceWayIds.toSorted().join(',')),
  );
  const point = coordinates[Math.floor(coordinates.length / 2)];
  if (sourceSignatures.size !== 1)
    return { reason: 'Unverified reciprocal ramp paths', point };
  const source = matching[0].sourceWayIds.map((id) => roads.get(id));
  if (source.some((road) => !road?.separation)) {
    return {
      reason: 'Separation or access exception',
      point,
      wayIds: matching[0].sourceWayIds.filter((id) => !roads.get(id)?.separation),
    };
  }
  if (source.some((road) => !road.lanes)) {
    return {
      reason: 'Missing or ambiguous through lanes',
      point,
      wayIds: source.filter((road) => !road.lanes).map((road) => road.id),
    };
  }
  return { grade: gradeForLaneCount(Math.min(...source.map((road) => road.lanes))) };
}
