function coordinateKey([longitude, latitude]) {
  return `${longitude.toFixed(7)},${latitude.toFixed(7)}`;
}

function edgeKey(firstId, secondId) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

class UnionFind {
  constructor(values) {
    this.parent = new Map(values.map((value) => [value, value]));
  }

  find(value) {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error(`Unknown highway node ${value}.`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;
    this.parent.set(
      firstRoot < secondRoot ? secondRoot : firstRoot,
      firstRoot < secondRoot ? firstRoot : secondRoot,
    );
  }
}

export function buildExactHighwayGraph(parts) {
  const coordinateByNodeId = new Map();
  const edges = [];
  const edgeIndexByKey = new Map();
  for (const [partIndex, part] of parts.entries()) {
    for (const coordinate of part.coordinates) {
      coordinateByNodeId.set(coordinateKey(coordinate), coordinate);
    }
    for (let index = 1; index < part.coordinates.length; index += 1) {
      const fromId = coordinateKey(part.coordinates[index - 1]);
      const toId = coordinateKey(part.coordinates[index]);
      if (fromId === toId) continue;
      const key = edgeKey(fromId, toId);
      const existingIndex = edgeIndexByKey.get(key);
      if (existingIndex !== undefined) {
        edges[existingIndex].partIndices.add(partIndex);
        continue;
      }
      edgeIndexByKey.set(key, edges.length);
      edges.push({
        fromId,
        partIndices: new Set([partIndex]),
        toId,
      });
    }
  }
  return { coordinateByNodeId, edges };
}

export function largestHighwayComponent(coordinateByNodeId, edges) {
  const nodeIds = [...coordinateByNodeId.keys()];
  const union = new UnionFind(nodeIds);
  for (const edge of edges) union.union(edge.fromId, edge.toId);
  const edgeCountByRoot = new Map();
  for (const edge of edges) {
    const root = union.find(edge.fromId);
    edgeCountByRoot.set(root, (edgeCountByRoot.get(root) ?? 0) + 1);
  }
  const largestRoot = [...edgeCountByRoot].sort(
    (first, second) => second[1] - first[1] || first[0].localeCompare(second[0]),
  )[0]?.[0];
  if (!largestRoot) throw new Error('The detailed highway graph is empty.');
  const componentNodeIds = new Set(
    nodeIds.filter((nodeId) => union.find(nodeId) === largestRoot),
  );
  return {
    edges: edges.filter((edge) => componentNodeIds.has(edge.fromId)),
    nodeIds: componentNodeIds,
  };
}

export function highwayTwoCore(nodeIds, edges) {
  const incident = new Map([...nodeIds].map((nodeId) => [nodeId, new Set()]));
  for (const [edgeIndex, edge] of edges.entries()) {
    incident.get(edge.fromId)?.add(edgeIndex);
    incident.get(edge.toId)?.add(edgeIndex);
  }
  const activeNodes = new Set(nodeIds);
  const activeEdges = new Set(edges.map((_, index) => index));
  const pending = [...nodeIds].filter(
    (nodeId) => (incident.get(nodeId)?.size ?? 0) < 2,
  );
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!activeNodes.delete(nodeId)) continue;
    for (const edgeIndex of incident.get(nodeId) ?? []) {
      if (!activeEdges.delete(edgeIndex)) continue;
      const edge = edges[edgeIndex];
      const neighborId = edge.fromId === nodeId ? edge.toId : edge.fromId;
      incident.get(neighborId)?.delete(edgeIndex);
      if (activeNodes.has(neighborId) && (incident.get(neighborId)?.size ?? 0) < 2) {
        pending.push(neighborId);
      }
    }
  }
  return { activeEdges, activeNodes, incident };
}

export function compressHighwayCore(coordinateByNodeId, edges, core) {
  const junctions = new Set(
    [...core.activeNodes].filter(
      (nodeId) => (core.incident.get(nodeId)?.size ?? 0) !== 2,
    ),
  );
  const unvisitedNodes = new Set(core.activeNodes);
  while (unvisitedNodes.size > 0) {
    const firstNodeId = unvisitedNodes.values().next().value;
    const component = [];
    const pending = [firstNodeId];
    unvisitedNodes.delete(firstNodeId);
    while (pending.length > 0) {
      const nodeId = pending.pop();
      component.push(nodeId);
      for (const edgeIndex of core.incident.get(nodeId) ?? []) {
        if (!core.activeEdges.has(edgeIndex)) continue;
        const edge = edges[edgeIndex];
        const neighborId = edge.fromId === nodeId ? edge.toId : edge.fromId;
        if (unvisitedNodes.delete(neighborId)) pending.push(neighborId);
      }
    }
    if (!component.some((nodeId) => junctions.has(nodeId))) {
      junctions.add(component.sort()[0]);
    }
  }

  const visitedEdges = new Set();
  const corridors = [];
  for (const startId of [...junctions].sort()) {
    for (const startingEdgeIndex of core.incident.get(startId) ?? []) {
      if (
        !core.activeEdges.has(startingEdgeIndex) ||
        visitedEdges.has(startingEdgeIndex)
      ) {
        continue;
      }
      const coordinates = [coordinateByNodeId.get(startId)];
      const partIndices = new Set();
      let currentId = startId;
      let edgeIndex = startingEdgeIndex;
      while (true) {
        visitedEdges.add(edgeIndex);
        const edge = edges[edgeIndex];
        for (const partIndex of edge.partIndices) partIndices.add(partIndex);
        const nextId = edge.fromId === currentId ? edge.toId : edge.fromId;
        coordinates.push(coordinateByNodeId.get(nextId));
        currentId = nextId;
        if (junctions.has(currentId)) break;
        const nextEdgeIndex = [...(core.incident.get(currentId) ?? [])].find(
          (candidateIndex) =>
            candidateIndex !== edgeIndex && core.activeEdges.has(candidateIndex),
        );
        if (nextEdgeIndex === undefined) {
          throw new Error(
            `Detailed highway corridor ends unexpectedly at ${currentId}.`,
          );
        }
        edgeIndex = nextEdgeIndex;
      }
      corridors.push({
        coordinates,
        fromId: startId,
        partIndices,
        toId: currentId,
      });
    }
  }
  return {
    edges: corridors,
    nodes: [...junctions].map((nodeId) => ({
      coordinate: coordinateByNodeId.get(nodeId),
      id: nodeId,
    })),
  };
}

export function buildCompressedHighwayGraph(parts) {
  const exact = buildExactHighwayGraph(parts);
  const component = largestHighwayComponent(exact.coordinateByNodeId, exact.edges);
  const core = highwayTwoCore(component.nodeIds, component.edges);
  const compressed = compressHighwayCore(
    exact.coordinateByNodeId,
    component.edges,
    core,
  );
  return { component, compressed, core, exact };
}
