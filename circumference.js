const EARTH_RADIUS_M = 6_371_008.8;
const NAME_TRANSFER_DISTANCE_M = 350;
const EDGE_KEY_SEPARATOR = '\u0000';
const SHORTCUT_MINIMUM_LENGTH_M = 2_000;
const SAME_LINE_SHORTCUT_RATIO = 1.8;
const CORRIDOR_SHORTCUT_RATIO = 1.6;
const CORRIDOR_AVERAGE_WIDTH_M = 900;
const CYCLE_SEARCH_BEAM_WIDTH = 4;
const CYCLE_SEARCH_MAX_ROUNDS = 18;
const SPANNING_TREE_RANDOM_SEEDS = 48;
const EXTREME_ANCHOR_PAIR_LIMIT = 28;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function normalizeLongitudeDelta(delta) {
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
}

function normalizeStationName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:linea|line|l)\s*(?:\d+|[a-z])\b/gi, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function distanceMeters([lonA, latA], [lonB, latB]) {
  const latARadians = toRadians(latA);
  const latBRadians = toRadians(latB);
  const latitudeDelta = latBRadians - latARadians;
  const longitudeDelta = toRadians(lonB - lonA);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latARadians) *
      Math.cos(latBRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

/**
 * Chamberlain-Duquette spherical polygon area. At metro scale this avoids the
 * latitude distortion of ordinary degree-based shoelace calculations while
 * keeping route and landmass measurements in one consistent model.
 */
export function polygonAreaSquareMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return 0;

  const ring =
    coordinates.length > 3 &&
    coordinates[0][0] === coordinates.at(-1)[0] &&
    coordinates[0][1] === coordinates.at(-1)[1]
      ? coordinates.slice(0, -1)
      : coordinates;
  let areaAccumulator = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const longitudeDelta = normalizeLongitudeDelta(
      toRadians(next[0]) - toRadians(current[0]),
    );
    areaAccumulator +=
      longitudeDelta *
      (2 + Math.sin(toRadians(current[1])) + Math.sin(toRadians(next[1])));
  }

  return Math.abs((areaAccumulator * EARTH_RADIUS_M ** 2) / 2);
}

export function lineLengthMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  has(id) {
    return this.parent.has(id);
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(firstId, secondId) {
    if (!this.has(firstId) || !this.has(secondId)) return false;
    const firstRoot = this.find(firstId);
    const secondRoot = this.find(secondId);
    if (firstRoot === secondRoot) return false;
    this.parent.set(secondRoot, firstRoot);
    return true;
  }
}

function edgeKey(firstId, secondId) {
  return [firstId, secondId].sort().join(EDGE_KEY_SEPARATOR);
}

function serviceFamily(routeId, lineName) {
  return /X$/i.test(String(lineName).trim())
    ? String(routeId).replace(/X$/i, '')
    : String(routeId);
}

function routeIdForService(serviceKey) {
  const separatorIndex = String(serviceKey).lastIndexOf('/');
  return separatorIndex === -1
    ? String(serviceKey)
    : String(serviceKey).slice(0, separatorIndex);
}

function shortestAlternatePath(
  adjacency,
  nodes,
  familiesByEdge,
  fromId,
  toId,
  maximumDistance,
  allowedLineFamilies = null,
) {
  const excludedEdgeKey = edgeKey(fromId, toId);
  const distances = new Map([[fromId, 0]]);
  const previous = new Map();
  const pending = [[0, fromId]];

  while (pending.length > 0) {
    pending.sort((first, second) => second[0] - first[0]);
    const [currentDistance, currentId] = pending.pop();
    if (currentDistance !== distances.get(currentId)) continue;
    if (currentId === toId) {
      const nodeIds = [toId];
      while (nodeIds[0] !== fromId) {
        nodeIds.unshift(previous.get(nodeIds[0]));
      }
      return { distanceMeters: currentDistance, nodeIds };
    }

    for (const neighborId of adjacency.get(currentId) ?? []) {
      const currentEdgeKey = edgeKey(currentId, neighborId);
      if (currentEdgeKey === excludedEdgeKey) continue;
      if (
        allowedLineFamilies &&
        ![...(familiesByEdge.get(currentEdgeKey) ?? [])].some((family) =>
          allowedLineFamilies.has(family),
        )
      ) {
        continue;
      }

      const nextDistance =
        currentDistance +
        distanceMeters(
          nodes.get(currentId).coordinate,
          nodes.get(neighborId).coordinate,
        );
      if (
        nextDistance > maximumDistance ||
        nextDistance >= (distances.get(neighborId) ?? Infinity)
      ) {
        continue;
      }
      distances.set(neighborId, nextDistance);
      previous.set(neighborId, currentId);
      pending.push([nextDistance, neighborId]);
    }
  }

  return null;
}

/**
 * GTFS stop sequences describe where a train stops, not the physical track
 * between those stops. Express and limited-stop trips therefore create long
 * chords over the local station chain. Those chords are useful for journey
 * timing, but treating them as map edges invents skinny triangular "loops".
 *
 * Remove a chord when a reasonably short local path already connects its ends.
 * Same-line alternatives are decisive; cross-line alternatives are accepted
 * only when the chord and path enclose a narrow corridor.
 */
function removeServiceShortcuts(
  adjacency,
  nodes,
  linesByEdge,
  familiesByEdge,
  ambiguousLineNames,
) {
  const shortcuts = new Set();

  for (const [fromId, neighbors] of adjacency) {
    for (const toId of neighbors) {
      const key = edgeKey(fromId, toId);
      if (shortcuts.has(key) || fromId > toId) continue;

      const directDistance = distanceMeters(
        nodes.get(fromId).coordinate,
        nodes.get(toId).coordinate,
      );
      if (directDistance < SHORTCUT_MINIMUM_LENGTH_M) continue;

      const directLineNames = [...(linesByEdge.get(key) ?? [])];
      if (
        directLineNames.length > 0 &&
        directLineNames.every((lineName) => ambiguousLineNames.has(lineName))
      ) {
        continue;
      }

      const directFamilies = new Set(
        familiesByEdge.get(key) ?? [],
      );
      const sameLinePath = shortestAlternatePath(
        adjacency,
        nodes,
        familiesByEdge,
        fromId,
        toId,
        directDistance * SAME_LINE_SHORTCUT_RATIO,
        directFamilies,
      );
      if (sameLinePath?.nodeIds.length > 2) {
        shortcuts.add(key);
        continue;
      }

      const corridorPath = shortestAlternatePath(
        adjacency,
        nodes,
        familiesByEdge,
        fromId,
        toId,
        directDistance * CORRIDOR_SHORTCUT_RATIO,
      );
      if (!corridorPath || corridorPath.nodeIds.length <= 2) continue;

      const ring = corridorPath.nodeIds.map(
        (nodeId) => nodes.get(nodeId).coordinate,
      );
      const averageWidth =
        (2 * polygonAreaSquareMeters(ring)) / directDistance;
      if (averageWidth <= CORRIDOR_AVERAGE_WIDTH_M) shortcuts.add(key);
    }
  }

  for (const key of shortcuts) {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    adjacency.get(fromId)?.delete(toId);
    adjacency.get(toId)?.delete(fromId);
  }

  return shortcuts;
}

function removeBranches(adjacency) {
  const activeNodes = new Set(adjacency.keys());
  const pending = [...adjacency]
    .filter(([, neighbors]) => neighbors.size < 2)
    .map(([nodeId]) => nodeId);

  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!activeNodes.delete(nodeId)) continue;

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!activeNodes.has(neighborId)) continue;
      adjacency.get(neighborId).delete(nodeId);
      if (adjacency.get(neighborId).size < 2) pending.push(neighborId);
    }
  }

  for (const nodeId of [...adjacency.keys()]) {
    if (!activeNodes.has(nodeId)) {
      adjacency.delete(nodeId);
      continue;
    }
    for (const neighborId of [...adjacency.get(nodeId)]) {
      if (!activeNodes.has(neighborId)) adjacency.get(nodeId).delete(neighborId);
    }
  }
}

function biconnectedComponents(adjacency) {
  const discovery = new Map();
  const low = new Map();
  const parent = new Map();
  const edgeStack = [];
  const components = [];
  let clock = 0;

  function visit(nodeId) {
    clock += 1;
    discovery.set(nodeId, clock);
    low.set(nodeId, clock);

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, nodeId);
        edgeStack.push([nodeId, neighborId]);
        visit(neighborId);
        low.set(nodeId, Math.min(low.get(nodeId), low.get(neighborId)));

        if (low.get(neighborId) >= discovery.get(nodeId)) {
          const edges = [];
          let edge;
          do {
            edge = edgeStack.pop();
            if (edge) edges.push(edge);
          } while (
            edge &&
            !(edge[0] === nodeId && edge[1] === neighborId)
          );
          if (edges.length >= 3) components.push(edges);
        }
      } else if (
        neighborId !== parent.get(nodeId) &&
        discovery.get(neighborId) < discovery.get(nodeId)
      ) {
        low.set(nodeId, Math.min(low.get(nodeId), discovery.get(neighborId)));
        edgeStack.push([nodeId, neighborId]);
      }
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!discovery.has(nodeId)) visit(nodeId);
  }

  return components;
}

function componentAdjacency(edges) {
  const adjacency = new Map();
  for (const [fromId, toId] of edges) {
    if (!adjacency.has(fromId)) adjacency.set(fromId, new Set());
    if (!adjacency.has(toId)) adjacency.set(toId, new Set());
    adjacency.get(fromId).add(toId);
    adjacency.get(toId).add(fromId);
  }
  return adjacency;
}

function stableCandidateId(nodeIds) {
  const canonical = nodeIds
    .map((nodeId, index) => edgeKey(nodeId, nodeIds[(index + 1) % nodeIds.length]))
    .sort()
    .join('|');
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `route-${(hash >>> 0).toString(36)}`;
}

function cycleEdgeKeys(path) {
  return new Set(
    path.map((nodeId, index) =>
      edgeKey(nodeId, path[(index + 1) % path.length]),
    ),
  );
}

function pathsFromCycleEdges(edgeKeys) {
  if (edgeKeys.size < 3) return null;
  const adjacency = new Map();
  for (const key of edgeKeys) {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    if (!adjacency.has(fromId)) adjacency.set(fromId, new Set());
    if (!adjacency.has(toId)) adjacency.set(toId, new Set());
    adjacency.get(fromId).add(toId);
    adjacency.get(toId).add(fromId);
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.size !== 2)) {
    return [];
  }

  const unvisited = new Set(adjacency.keys());
  const paths = [];
  while (unvisited.size > 0) {
    const startId = [...unvisited].sort()[0];
    const path = [];
    let previousId = null;
    let currentId = startId;

    do {
      path.push(currentId);
      unvisited.delete(currentId);
      const neighbors = [...adjacency.get(currentId)];
      const nextId =
        neighbors[0] === previousId ? neighbors[1] : neighbors[0];
      previousId = currentId;
      currentId = nextId;
    } while (currentId !== startId && path.length <= adjacency.size);

    if (currentId !== startId || path.length < 3) return [];
    paths.push(path);
  }
  return paths;
}

function pathFromCycleEdges(edgeKeys) {
  const paths = pathsFromCycleEdges(edgeKeys);
  return paths?.length === 1 ? paths[0] : null;
}

function mergeCyclePathOptions(firstPath, secondPath) {
  const mergedEdges = cycleEdgeKeys(firstPath);
  for (const key of cycleEdgeKeys(secondPath)) {
    if (mergedEdges.has(key)) mergedEdges.delete(key);
    else mergedEdges.add(key);
  }
  return pathsFromCycleEdges(mergedEdges) ?? [];
}

function mergeCyclePaths(firstPath, secondPath) {
  const paths = mergeCyclePathOptions(firstPath, secondPath);
  return paths.length === 1 ? paths[0] : null;
}

function fundamentalCycles(adjacency) {
  const discovery = new Map();
  const parent = new Map();
  const cycles = [];
  let clock = 0;

  function visit(nodeId) {
    clock += 1;
    discovery.set(nodeId, clock);

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, nodeId);
        visit(neighborId);
      } else if (
        neighborId !== parent.get(nodeId) &&
        discovery.get(neighborId) < discovery.get(nodeId)
      ) {
        const path = [nodeId];
        let currentId = nodeId;
        while (currentId !== neighborId) {
          currentId = parent.get(currentId);
          if (currentId === undefined) break;
          path.push(currentId);
        }
        if (path.at(-1) === neighborId && path.length >= 3) cycles.push(path);
      }
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!discovery.has(nodeId)) visit(nodeId);
  }
  return cycles;
}

function graphEdges(adjacency) {
  const edges = [];
  for (const [fromId, neighbors] of adjacency) {
    for (const toId of neighbors) {
      if (fromId < toId) edges.push([fromId, toId]);
    }
  }
  return edges;
}

function pathInTree(adjacency, fromId, toId) {
  const pending = [fromId];
  const previous = new Map([[fromId, null]]);

  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (nodeId === toId) break;
    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (previous.has(neighborId)) continue;
      previous.set(neighborId, nodeId);
      pending.push(neighborId);
    }
  }
  if (!previous.has(toId)) return null;

  const path = [toId];
  while (path[0] !== fromId) path.unshift(previous.get(path[0]));
  return path;
}

function deterministicEdgeScore(key, seed) {
  let hash = (2_166_136_261 ^ seed) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Produce complete cycle proposals from several deterministic spanning trees.
 * Perimeter-biased trees retain geographically extreme edges; seeded trees
 * explore other valid topologies without making the browser result random.
 */
function spanningTreeCycles(adjacency, nodes) {
  const nodeIds = [...adjacency.keys()];
  const edges = graphEdges(adjacency);
  const center = nodeIds.reduce(
    (total, nodeId) => {
      const [longitude, latitude] = nodes.get(nodeId).coordinate;
      total.longitude += longitude / nodeIds.length;
      total.latitude += latitude / nodeIds.length;
      return total;
    },
    { longitude: 0, latitude: 0 },
  );
  const midpoint = ([fromId, toId]) => {
    const from = nodes.get(fromId).coordinate;
    const to = nodes.get(toId).coordinate;
    return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  };
  const radialScore = (edge) => {
    const [longitude, latitude] = midpoint(edge);
    return (
      (longitude - center.longitude) ** 2 +
      (latitude - center.latitude) ** 2
    );
  };
  const strategies = [
    (edge) => radialScore(edge),
    (edge) => -radialScore(edge),
    (edge) => midpoint(edge)[0],
    (edge) => -midpoint(edge)[0],
    (edge) => midpoint(edge)[1],
    (edge) => -midpoint(edge)[1],
    ...Array.from(
      { length: SPANNING_TREE_RANDOM_SEEDS },
      (_, seed) => (edge) =>
        deterministicEdgeScore(edgeKey(edge[0], edge[1]), seed + 1),
    ),
  ];
  const cycles = new Map();

  for (const score of strategies) {
    const unions = new UnionFind(nodeIds);
    const tree = new Map(nodeIds.map((nodeId) => [nodeId, new Set()]));
    const nonTreeEdges = [];
    for (const [fromId, toId] of [...edges].sort(
      (first, second) => score(second) - score(first),
    )) {
      if (unions.union(fromId, toId)) {
        tree.get(fromId).add(toId);
        tree.get(toId).add(fromId);
      } else {
        nonTreeEdges.push([fromId, toId]);
      }
    }

    for (const [fromId, toId] of nonTreeEdges) {
      const path = pathInTree(tree, fromId, toId);
      if (!path || path.length < 3) continue;
      cycles.set(stableCandidateId(path), path);
    }
  }

  return [...cycles.values()];
}

function convexHullNodeIds(adjacency, nodes) {
  const points = [...adjacency.keys()]
    .map((nodeId) => ({ nodeId, coordinate: nodes.get(nodeId).coordinate }))
    .sort(
      (first, second) =>
        first.coordinate[0] - second.coordinate[0] ||
        first.coordinate[1] - second.coordinate[1],
    );
  if (points.length <= 3) return points.map((point) => point.nodeId);

  const cross = (origin, first, second) =>
    (first.coordinate[0] - origin.coordinate[0]) *
      (second.coordinate[1] - origin.coordinate[1]) -
    (first.coordinate[1] - origin.coordinate[1]) *
      (second.coordinate[0] - origin.coordinate[0]);
  const lower = [];
  for (const point of points) {
    while (
      lower.length >= 2 &&
      cross(lower.at(-2), lower.at(-1), point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (const point of [...points].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper.at(-2), upper.at(-1), point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(
    (point) => point.nodeId,
  );
}

function addFlowArc(graph, from, to, capacity, cost, routeKey = null) {
  const forward = {
    to,
    reverseIndex: graph[to].length,
    capacity,
    cost,
    routeKey,
  };
  const reverse = {
    to: from,
    reverseIndex: graph[from].length,
    capacity: 0,
    cost: -cost,
    routeKey: null,
  };
  graph[from].push(forward);
  graph[to].push(reverse);
}

function vertexDisjointCycle(
  adjacency,
  nodes,
  fromId,
  toId,
  edgeCost,
) {
  const nodeIds = [...adjacency.keys()];
  const indexById = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const graph = Array.from({ length: nodeIds.length * 2 }, () => []);
  const inputIndex = (nodeId) => indexById.get(nodeId) * 2;
  const outputIndex = (nodeId) => indexById.get(nodeId) * 2 + 1;

  for (const nodeId of nodeIds) {
    addFlowArc(
      graph,
      inputIndex(nodeId),
      outputIndex(nodeId),
      nodeId === fromId || nodeId === toId ? 2 : 1,
      0,
    );
  }
  for (const [firstId, secondId] of graphEdges(adjacency)) {
    const key = edgeKey(firstId, secondId);
    const cost = edgeCost(firstId, secondId);
    addFlowArc(
      graph,
      outputIndex(firstId),
      inputIndex(secondId),
      1,
      cost,
      key,
    );
    addFlowArc(
      graph,
      outputIndex(secondId),
      inputIndex(firstId),
      1,
      cost,
      key,
    );
  }

  const source = outputIndex(fromId);
  const sink = inputIndex(toId);
  for (let flow = 0; flow < 2; flow += 1) {
    const distances = Array(graph.length).fill(Infinity);
    const previousNode = Array(graph.length).fill(-1);
    const previousEdge = Array(graph.length).fill(-1);
    distances[source] = 0;

    for (let iteration = 0; iteration < graph.length - 1; iteration += 1) {
      let changed = false;
      for (let nodeIndex = 0; nodeIndex < graph.length; nodeIndex += 1) {
        if (!Number.isFinite(distances[nodeIndex])) continue;
        for (
          let edgeIndex = 0;
          edgeIndex < graph[nodeIndex].length;
          edgeIndex += 1
        ) {
          const edge = graph[nodeIndex][edgeIndex];
          if (edge.capacity <= 0) continue;
          const nextDistance = distances[nodeIndex] + edge.cost;
          if (nextDistance >= distances[edge.to] - 1e-9) continue;
          distances[edge.to] = nextDistance;
          previousNode[edge.to] = nodeIndex;
          previousEdge[edge.to] = edgeIndex;
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (!Number.isFinite(distances[sink])) return null;

    let current = sink;
    while (current !== source) {
      const prior = previousNode[current];
      if (prior < 0) return null;
      const edge = graph[prior][previousEdge[current]];
      edge.capacity -= 1;
      graph[current][edge.reverseIndex].capacity += 1;
      current = prior;
    }
  }

  const usedRouteEdges = new Set();
  for (const edges of graph) {
    for (const edge of edges) {
      if (edge.routeKey && edge.capacity === 0) {
        if (usedRouteEdges.has(edge.routeKey)) {
          usedRouteEdges.delete(edge.routeKey);
        } else {
          usedRouteEdges.add(edge.routeKey);
        }
      }
    }
  }
  return pathFromCycleEdges(usedRouteEdges);
}

/**
 * Close two vertex-disjoint paths between geographically extreme anchors.
 * This retains complete north/east/south/west perimeter options that a
 * locally greedy face merger can discard before they become area-positive.
 */
function extremeAnchorCycles(adjacency, nodes) {
  const hullNodeIds = convexHullNodeIds(adjacency, nodes);
  const pairs = [];
  for (let firstIndex = 0; firstIndex < hullNodeIds.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < hullNodeIds.length;
      secondIndex += 1
    ) {
      const firstId = hullNodeIds[firstIndex];
      const secondId = hullNodeIds[secondIndex];
      pairs.push({
        firstId,
        secondId,
        distance: distanceMeters(
          nodes.get(firstId).coordinate,
          nodes.get(secondId).coordinate,
        ),
      });
    }
  }
  pairs.sort((first, second) => second.distance - first.distance);

  const componentNodeIds = [...adjacency.keys()];
  const center = componentNodeIds.reduce(
    (total, nodeId) => {
      const coordinate = nodes.get(nodeId).coordinate;
      total[0] += coordinate[0] / componentNodeIds.length;
      total[1] += coordinate[1] / componentNodeIds.length;
      return total;
    },
    [0, 0],
  );
  const radialDistance = (nodeId) => {
    const coordinate = nodes.get(nodeId).coordinate;
    return Math.hypot(
      (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
      coordinate[1] - center[1],
    );
  };
  const maximumRadius = Math.max(...componentNodeIds.map(radialDistance));
  const cycles = new Map();

  for (const { firstId, secondId } of pairs.slice(
    0,
    EXTREME_ANCHOR_PAIR_LIMIT,
  )) {
    for (const minimumFactor of [1, 0.35, 0.12, 0.04]) {
      const path = vertexDisjointCycle(
        adjacency,
        nodes,
        firstId,
        secondId,
        (edgeFromId, edgeToId) => {
          const length = distanceMeters(
            nodes.get(edgeFromId).coordinate,
            nodes.get(edgeToId).coordinate,
          );
          const radial =
            (radialDistance(edgeFromId) + radialDistance(edgeToId)) /
            (2 * maximumRadius);
          return length * (minimumFactor + 1 - radial);
        },
      );
      if (path) cycles.set(stableCandidateId(path), path);
    }
  }

  return [...cycles.values()];
}

function shortestNodePath(
  adjacency,
  fromId,
  toId,
  excludedNodeIds,
  edgeCost,
) {
  const distances = new Map([[fromId, 0]]);
  const previous = new Map();
  const pending = [[0, fromId]];

  while (pending.length > 0) {
    pending.sort((first, second) => second[0] - first[0]);
    const [distance, nodeId] = pending.pop();
    if (distance !== distances.get(nodeId)) continue;
    if (nodeId === toId) {
      const path = [toId];
      while (path[0] !== fromId) path.unshift(previous.get(path[0]));
      return path;
    }
    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (
        neighborId !== toId &&
        neighborId !== fromId &&
        excludedNodeIds.has(neighborId)
      ) {
        continue;
      }
      const nextDistance = distance + edgeCost(nodeId, neighborId);
      if (nextDistance >= (distances.get(neighborId) ?? Infinity)) continue;
      distances.set(neighborId, nextDistance);
      previous.set(neighborId, nodeId);
      pending.push([nextDistance, neighborId]);
    }
  }
  return null;
}

function pathThroughWaypoints(
  adjacency,
  fromId,
  waypointIds,
  toId,
  excludedNodeIds,
  edgeCost,
) {
  const stops = [fromId, ...waypointIds, toId];
  const path = [fromId];
  const exclusions = new Set(excludedNodeIds);
  for (let index = 1; index < stops.length; index += 1) {
    const segment = shortestNodePath(
      adjacency,
      stops[index - 1],
      stops[index],
      exclusions,
      edgeCost,
    );
    if (!segment) return null;
    path.push(...segment.slice(1));
    for (const nodeId of segment.slice(1, -1)) exclusions.add(nodeId);
  }
  return path;
}

/**
 * Preserve three-sided geographic extent explicitly: one anchor-to-anchor path
 * must pass through the opposite extreme, while the return path remains
 * vertex-disjoint. This preserves valid outer perimeters that span several
 * locally nested loops.
 */
function waypointExtremeCycles(adjacency, nodes) {
  const nodeIds = [...adjacency.keys()];
  if (nodeIds.length < 3) return [];
  const northId = nodeIds.toSorted(
    (firstId, secondId) =>
      nodes.get(secondId).coordinate[1] - nodes.get(firstId).coordinate[1],
  )[0];
  const eastId = nodeIds.toSorted(
    (firstId, secondId) =>
      nodes.get(secondId).coordinate[0] - nodes.get(firstId).coordinate[0],
  )[0];
  const southId = nodeIds.toSorted(
    (firstId, secondId) =>
      nodes.get(firstId).coordinate[1] - nodes.get(secondId).coordinate[1],
  )[0];
  const westId = nodeIds.toSorted(
    (firstId, secondId) =>
      nodes.get(firstId).coordinate[0] - nodes.get(secondId).coordinate[0],
  )[0];
  if (new Set([northId, eastId, southId, westId]).size < 4) return [];

  const center = nodeIds.reduce(
    (total, nodeId) => {
      const coordinate = nodes.get(nodeId).coordinate;
      total[0] += coordinate[0] / nodeIds.length;
      total[1] += coordinate[1] / nodeIds.length;
      return total;
    },
    [0, 0],
  );
  const radialDistance = (nodeId) => {
    const coordinate = nodes.get(nodeId).coordinate;
    return Math.hypot(
      (coordinate[0] - center[0]) * Math.cos(toRadians(center[1])),
      coordinate[1] - center[1],
    );
  };
  const maximumRadius = Math.max(...nodeIds.map(radialDistance));
  const costs = [1, 0.4, 0.12].map(
    (minimumFactor) => (fromId, toId) => {
      const length = distanceMeters(
        nodes.get(fromId).coordinate,
        nodes.get(toId).coordinate,
      );
      const radial =
        (radialDistance(fromId) + radialDistance(toId)) /
        (2 * maximumRadius);
      return length * (minimumFactor + 1 - radial);
    },
  );
  const cycles = new Map();

  for (const directCost of costs) {
    for (const waypointCost of costs) {
      for (const waypointIds of [[southId], [westId, southId]]) {
        for (const directFirst of [true, false]) {
          let directPath;
          let waypointPath;
          if (directFirst) {
            directPath = shortestNodePath(
              adjacency,
              northId,
              eastId,
              new Set(),
              directCost,
            );
            if (!directPath) continue;
            waypointPath = pathThroughWaypoints(
              adjacency,
              northId,
              waypointIds,
              eastId,
              new Set(directPath.slice(1, -1)),
              waypointCost,
            );
          } else {
            waypointPath = pathThroughWaypoints(
              adjacency,
              northId,
              waypointIds,
              eastId,
              new Set(),
              waypointCost,
            );
            if (!waypointPath) continue;
            directPath = shortestNodePath(
              adjacency,
              northId,
              eastId,
              new Set(waypointPath.slice(1, -1)),
              directCost,
            );
          }
          if (!directPath || !waypointPath) continue;
          const path = [
            ...directPath,
            ...[...waypointPath].reverse().slice(1, -1),
          ];
          if (new Set(path).size === path.length) {
            cycles.set(stableCandidateId(path), path);
          }
        }
      }
    }
  }
  return [...cycles.values()];
}

function orientation(first, second, third) {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function segmentsProperlyIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstSideStart = orientation(firstStart, firstEnd, secondStart);
  const firstSideEnd = orientation(firstStart, firstEnd, secondEnd);
  const secondSideStart = orientation(secondStart, secondEnd, firstStart);
  const secondSideEnd = orientation(secondStart, secondEnd, firstEnd);
  return (
    Math.sign(firstSideStart) !== Math.sign(firstSideEnd) &&
    Math.sign(secondSideStart) !== Math.sign(secondSideEnd)
  );
}

function hasSelfIntersection(coordinates) {
  for (let firstIndex = 0; firstIndex < coordinates.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % coordinates.length;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < coordinates.length;
      secondIndex += 1
    ) {
      const secondNext = (secondIndex + 1) % coordinates.length;
      if (
        firstIndex === secondIndex ||
        firstIndex === secondNext ||
        firstNext === secondIndex
      ) {
        continue;
      }
      if (
        segmentsProperlyIntersect(
          coordinates[firstIndex],
          coordinates[firstNext],
          coordinates[secondIndex],
          coordinates[secondNext],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function traceFaces(adjacency, nodes) {
  const sortedNeighbors = new Map();
  for (const [nodeId, neighbors] of adjacency) {
    const [originLongitude, originLatitude] = nodes.get(nodeId).coordinate;
    sortedNeighbors.set(
      nodeId,
      [...neighbors].sort((firstId, secondId) => {
        const first = nodes.get(firstId).coordinate;
        const second = nodes.get(secondId).coordinate;
        return (
          Math.atan2(first[1] - originLatitude, first[0] - originLongitude) -
          Math.atan2(second[1] - originLatitude, second[0] - originLongitude)
        );
      }),
    );
  }

  const visitedDirections = new Set();
  const faces = [];

  for (const [startId, neighbors] of sortedNeighbors) {
    for (const nextId of neighbors) {
      const startingDirection = `${startId}${EDGE_KEY_SEPARATOR}${nextId}`;
      if (visitedDirections.has(startingDirection)) continue;

      const path = [];
      let previousId = startId;
      let currentId = nextId;
      let guard = 0;

      while (guard < adjacency.size * 4) {
        guard += 1;
        const direction = `${previousId}${EDGE_KEY_SEPARATOR}${currentId}`;
        if (visitedDirections.has(direction)) break;
        visitedDirections.add(direction);
        path.push(previousId);

        const currentNeighbors = sortedNeighbors.get(currentId);
        const incomingIndex = currentNeighbors.indexOf(previousId);
        if (incomingIndex === -1) break;
        const followingId =
          currentNeighbors[
            (incomingIndex - 1 + currentNeighbors.length) %
              currentNeighbors.length
          ];
        previousId = currentId;
        currentId = followingId;

        if (previousId === startId && currentId === nextId) break;
      }

      const closed = previousId === startId && currentId === nextId;
      const isSimple = new Set(path).size === path.length;
      if (!closed || !isSimple || path.length < 3) continue;

      const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      if (hasSelfIntersection(coordinates)) continue;
      faces.push(path);
    }
  }

  return faces;
}

/**
 * A maximum-area route can surround many smaller network faces. Generate those
 * larger boundaries by taking the symmetric difference of adjacent cycles:
 * shared internal edges disappear and the remaining degree-two boundary is a
 * single rideable loop. A bounded beam keeps this fast enough for the browser.
 */
function combineCycles(seedPaths, nodes) {
  const candidates = new Map();
  const seeds = [];

  function stateForPath(path) {
    if (new Set(path).size !== path.length) return null;
    const id = stableCandidateId(path);
    if (candidates.has(id)) return candidates.get(id);
    const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
    if (hasSelfIntersection(coordinates)) return null;
    const state = {
      id,
      path,
      edges: cycleEdgeKeys(path),
      areaSquareMeters: polygonAreaSquareMeters(coordinates),
    };
    candidates.set(id, state);
    return state;
  }

  for (const path of seedPaths) {
    const state = stateForPath(path);
    if (state && !seeds.some((seed) => seed.id === state.id)) seeds.push(state);
  }

  let frontier = [...seeds];
  for (
    let round = 0;
    round < CYCLE_SEARCH_MAX_ROUNDS && frontier.length > 0;
    round += 1
  ) {
    const next = new Map();
    for (const state of frontier) {
      for (const seed of seeds) {
        let sharesEdge = false;
        for (const key of seed.edges) {
          if (state.edges.has(key)) {
            sharesEdge = true;
            break;
          }
        }
        if (!sharesEdge) continue;

        const mergedPath = mergeCyclePaths(state.path, seed.path);
        if (!mergedPath) continue;

        const mergedId = stableCandidateId(mergedPath);
        if (candidates.has(mergedId)) continue;
        const mergedState = stateForPath(mergedPath);
        if (mergedState) next.set(mergedState.id, mergedState);
      }
    }
    frontier = [...next.values()]
      .sort(
        (first, second) =>
          second.areaSquareMeters - first.areaSquareMeters,
      )
      .slice(0, CYCLE_SEARCH_BEAM_WIDTH);
  }

  return [...candidates.values()].map((candidate) => candidate.path);
}

function candidateSimilarity(first, second) {
  const firstEdges = cycleEdgeKeys(first.nodeIds);
  const secondEdges = cycleEdgeKeys(second.nodeIds);
  let intersectionSize = 0;
  for (const key of firstEdges) {
    if (secondEdges.has(key)) intersectionSize += 1;
  }
  return (
    intersectionSize /
    (firstEdges.size + secondEdges.size - intersectionSize)
  );
}

function selectDiverseCandidates(rankedCandidates, maximumCount) {
  if (rankedCandidates.length <= maximumCount) return rankedCandidates;
  const selected = [];
  const selectedIds = new Set();

  // Start with genuinely different circumferences, then relax the threshold so
  // the override menu remains full even in a network with only a few loop shapes.
  for (const maximumSimilarity of [0.72, 0.84, 0.93, 1]) {
    for (const candidate of rankedCandidates) {
      if (selectedIds.has(candidate.id)) continue;
      if (
        selected.every(
          (selectedCandidate) =>
            candidateSimilarity(candidate, selectedCandidate) <=
            maximumSimilarity,
        )
      ) {
        selected.push(candidate);
        selectedIds.add(candidate.id);
        if (selected.length === maximumCount) return selected;
      }
    }
  }

  return selected;
}

function representativeName(features) {
  return (
    features
      .map((feature) => feature.properties.name)
      .filter(Boolean)
      .sort((first, second) => first.length - second.length)[0] ||
    'Unnamed interchange'
  );
}

function sortLineNames(first, second) {
  return String(first).localeCompare(String(second), 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Builds closed metro loops from route edges and zero-fare interchanges.
 * Express stop-to-stop shortcuts are normalized onto local station chains,
 * then adjacent cycle boundaries are combined and ranked by contained area.
 * Returning several geographically distinct candidates provides a stable
 * manual override without changing the source feed.
 */
export function buildCircumferenceCandidates(
  stationFeatures,
  schedules,
  { maxCandidates = 12, minimumAreaSquareMeters = 250_000 } = {},
) {
  const eligibleStations = stationFeatures.filter(
    (feature) =>
      feature.properties?.mode === 'subway' &&
      feature.properties?.status === 'open',
  );
  const stationById = new Map(
    eligibleStations.map((feature) => [feature.properties.id, feature]),
  );
  const unions = new UnionFind([...stationById.keys()]);
  let publishedTransferCount = 0;
  let inferredTransferCount = 0;

  for (const [fromStationId, transfers] of Object.entries(
    schedules?.graph?.t ?? {},
  )) {
    for (const [toStationId] of transfers) {
      if (unions.union(fromStationId, toStationId)) publishedTransferCount += 1;
    }
  }

  const stationsByName = new Map();
  for (const feature of eligibleStations) {
    const normalizedName = normalizeStationName(feature.properties.name);
    if (!normalizedName) continue;
    const bucket = stationsByName.get(normalizedName) ?? [];
    bucket.push(feature);
    stationsByName.set(normalizedName, bucket);
  }

  for (const bucket of stationsByName.values()) {
    for (let firstIndex = 0; firstIndex < bucket.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < bucket.length;
        secondIndex += 1
      ) {
        const first = bucket[firstIndex];
        const second = bucket[secondIndex];
        if (
          distanceMeters(
            first.geometry.coordinates,
            second.geometry.coordinates,
          ) <= NAME_TRANSFER_DISTANCE_M &&
          unions.union(first.properties.id, second.properties.id)
        ) {
          inferredTransferCount += 1;
        }
      }
    }
  }

  const featuresByComplex = new Map();
  for (const feature of eligibleStations) {
    const complexId = unions.find(feature.properties.id);
    const members = featuresByComplex.get(complexId) ?? [];
    members.push(feature);
    featuresByComplex.set(complexId, members);
  }

  const nodes = new Map();
  for (const [complexId, features] of featuresByComplex) {
    nodes.set(complexId, {
      id: complexId,
      coordinate: [
        features.reduce(
          (total, feature) => total + feature.geometry.coordinates[0],
          0,
        ) / features.length,
        features.reduce(
          (total, feature) => total + feature.geometry.coordinates[1],
          0,
        ) / features.length,
      ],
      name: representativeName(features),
      stationIds: features.map((feature) => feature.properties.id),
    });
  }

  const adjacency = new Map([...nodes.keys()].map((nodeId) => [nodeId, new Set()]));
  const linesByEdge = new Map();
  const familiesByEdge = new Map();
  const routeIdsByLineName = new Map();
  for (const [routeId, route] of Object.entries(schedules?.routes ?? {})) {
    if (route?.mode !== 'subway') continue;
    const lineName = route.name || routeId;
    const routeIds = routeIdsByLineName.get(lineName) ?? new Set();
    routeIds.add(routeId);
    routeIdsByLineName.set(lineName, routeIds);
  }
  const ambiguousLineNames = new Set(
    [...routeIdsByLineName]
      .filter(([, routeIds]) => routeIds.size > 1)
      .map(([lineName]) => lineName),
  );

  for (const [fromStationId, edges] of Object.entries(
    schedules?.graph?.e ?? {},
  )) {
    if (!stationById.has(fromStationId)) continue;

    for (const [toStationId, , serviceKey] of edges) {
      if (!stationById.has(toStationId)) continue;
      const routeId = routeIdForService(serviceKey);
      const route = schedules?.routes?.[routeId];
      if (route?.mode !== 'subway') continue;

      const fromComplexId = unions.find(fromStationId);
      const toComplexId = unions.find(toStationId);
      if (fromComplexId === toComplexId) continue;

      adjacency.get(fromComplexId).add(toComplexId);
      adjacency.get(toComplexId).add(fromComplexId);
      const key = edgeKey(fromComplexId, toComplexId);
      const lines = linesByEdge.get(key) ?? new Set();
      lines.add(route.name || routeId);
      linesByEdge.set(key, lines);
      const families = familiesByEdge.get(key) ?? new Set();
      families.add(serviceFamily(routeId, route.name || routeId));
      familiesByEdge.set(key, families);
    }
  }

  const removedShortcuts = removeServiceShortcuts(
    adjacency,
    nodes,
    linesByEdge,
    familiesByEdge,
    ambiguousLineNames,
  );
  removeBranches(adjacency);
  const components = biconnectedComponents(adjacency);
  const candidatePaths = new Map();
  for (const component of components) {
    const componentGraph = componentAdjacency(component);
    const addComponentCandidate = (path) => {
      candidatePaths.set(stableCandidateId(path), path);
    };
    const seeds = [
      ...traceFaces(componentGraph, nodes),
      ...fundamentalCycles(componentGraph),
    ];
    for (const path of combineCycles(seeds, nodes)) {
      addComponentCandidate(path);
    }
    const spanningProposals = spanningTreeCycles(componentGraph, nodes);
    for (const path of spanningProposals) {
      const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      if (
        new Set(path).size === path.length &&
        !hasSelfIntersection(coordinates)
      ) {
        addComponentCandidate(path);
      }
    }
    const extremeProposals = extremeAnchorCycles(componentGraph, nodes);
    for (const path of extremeProposals) {
      const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      if (!hasSelfIntersection(coordinates)) {
        addComponentCandidate(path);
      }
    }
    for (const path of waypointExtremeCycles(componentGraph, nodes)) {
      const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      if (!hasSelfIntersection(coordinates)) addComponentCandidate(path);
    }
  }

  const rankedCandidates = [...candidatePaths.values()]
    .map((path) => {
      const openCoordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      const coordinates = [...openCoordinates, openCoordinates[0]];
      const segments = path.map((nodeId, index) => {
        const nextId = path[(index + 1) % path.length];
        return {
          id: stableCandidateId([nodeId, nextId]).replace('route-', 'segment-'),
          from: nodes.get(nodeId),
          to: nodes.get(nextId),
          lines: [...(linesByEdge.get(edgeKey(nodeId, nextId)) ?? [])].sort(
            sortLineNames,
          ),
        };
      });
      const lines = [...new Set(segments.flatMap((segment) => segment.lines))].sort(
        sortLineNames,
      );

      return {
        id: stableCandidateId(path),
        nodeIds: path,
        stations: path.map((nodeId) => nodes.get(nodeId)),
        coordinates,
        segments,
        lines,
        areaSquareMeters: polygonAreaSquareMeters(coordinates),
        lengthMeters: lineLengthMeters(coordinates),
      };
    })
    .filter((candidate) => candidate.areaSquareMeters >= minimumAreaSquareMeters)
    .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters);
  const candidates = selectDiverseCandidates(rankedCandidates, maxCandidates);

  return {
    candidates,
    methodology: {
      eligibleStationCount: eligibleStations.length,
      complexCount: nodes.size,
      coreComplexCount: adjacency.size,
      publishedTransferCount,
      inferredTransferCount,
      removedShortcutCount: removedShortcuts.size,
      removedShortcuts: [...removedShortcuts].map((key) => {
        const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
        return {
          from: nodes.get(fromId).name,
          to: nodes.get(toId).name,
          lines: [...(linesByEdge.get(key) ?? [])].sort(sortLineNames),
        };
      }),
      biconnectedComponentCount: components.length,
      biconnectedComponentSizes: components
        .map((component) => new Set(component.flat()).size)
        .sort((first, second) => second - first),
      generatedCandidateCount: rankedCandidates.length,
    },
  };
}

export function selectCircumferenceCandidate(
  candidates,
  overrideId = '',
  { requiredSegmentIds = [], avoidedSegmentIds = [] } = {},
) {
  const requiredSegments = new Set(requiredSegmentIds);
  const avoidedSegments = new Set(avoidedSegmentIds);
  const matchingCandidates = candidates.filter((candidate) => {
    const candidateSegments = new Set(
      candidate.segments.map((segment) => segment.id),
    );
    return (
      [...requiredSegments].every((segmentId) =>
        candidateSegments.has(segmentId),
      ) &&
      [...avoidedSegments].every(
        (segmentId) => !candidateSegments.has(segmentId),
      )
    );
  });

  return (
    candidates.find((candidate) => candidate.id === overrideId) ??
    matchingCandidates[0] ??
    null
  );
}
