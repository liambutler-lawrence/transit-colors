import {
  geodesicLineLengthMeters,
  geodesicPolygonAreaSquareMeters,
} from '../src/geodesy.ts';

function otherEndpoint(edge, nodeId) {
  return edge.fromId === nodeId ? edge.toId : edge.fromId;
}

function orientedCoordinates(edge, fromId) {
  return edge.fromId === fromId ? edge.coordinates : [...edge.coordinates].reverse();
}

/**
 * Iterative Tarjan decomposition. Every simple cycle is wholly contained in
 * one vertex-biconnected edge block, so blocks can be optimized independently.
 */
export function biconnectedEdgeBlocks(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const [edgeIndex, edge] of edges.entries()) {
    adjacency.get(edge.fromId)?.push(edgeIndex);
    adjacency.get(edge.toId)?.push(edgeIndex);
  }

  const discovered = new Map();
  const low = new Map();
  const parentEdge = new Map();
  const edgeStack = [];
  const blocks = [];
  let time = 0;

  for (const node of nodes) {
    if (discovered.has(node.id)) continue;
    time += 1;
    discovered.set(node.id, time);
    low.set(node.id, time);
    const frames = [{ nodeId: node.id, nextIndex: 0 }];

    while (frames.length > 0) {
      const frame = frames.at(-1);
      const incident = adjacency.get(frame.nodeId) ?? [];
      if (frame.nextIndex < incident.length) {
        const edgeIndex = incident[frame.nextIndex];
        frame.nextIndex += 1;
        const edge = edges[edgeIndex];
        if (!edge || edgeIndex === parentEdge.get(frame.nodeId)) continue;
        const neighborId = otherEndpoint(edge, frame.nodeId);

        if (!discovered.has(neighborId)) {
          edgeStack.push(edgeIndex);
          parentEdge.set(neighborId, edgeIndex);
          time += 1;
          discovered.set(neighborId, time);
          low.set(neighborId, time);
          frames.push({ nodeId: neighborId, nextIndex: 0 });
          continue;
        }
        if (
          (discovered.get(neighborId) ?? Infinity) <
          (discovered.get(frame.nodeId) ?? Infinity)
        ) {
          edgeStack.push(edgeIndex);
          low.set(
            frame.nodeId,
            Math.min(
              low.get(frame.nodeId) ?? Infinity,
              discovered.get(neighborId) ?? Infinity,
            ),
          );
        }
        continue;
      }

      frames.pop();
      const treeEdgeIndex = parentEdge.get(frame.nodeId);
      if (treeEdgeIndex === undefined) {
        if (edgeStack.length > 0) blocks.push(edgeStack.splice(0));
        continue;
      }
      const treeEdge = edges[treeEdgeIndex];
      const parentId = otherEndpoint(treeEdge, frame.nodeId);
      low.set(
        parentId,
        Math.min(low.get(parentId) ?? Infinity, low.get(frame.nodeId) ?? Infinity),
      );
      if (
        (low.get(frame.nodeId) ?? Infinity) >= (discovered.get(parentId) ?? Infinity)
      ) {
        const block = [];
        while (edgeStack.length > 0) {
          const edgeIndex = edgeStack.pop();
          block.push(edgeIndex);
          if (edgeIndex === treeEdgeIndex) break;
        }
        blocks.push(block);
      }
    }
  }

  return blocks.filter((block) => block.length >= 2);
}

function directionAngle(coordinates) {
  const start = coordinates[0];
  let end = coordinates[1];
  let index = 1;
  while (end && end[0] === start[0] && end[1] === start[1]) {
    index += 1;
    end = coordinates[index];
  }
  if (!start || !end) return 0;
  const meanLatitude = ((start[1] + end[1]) / 2) * (Math.PI / 180);
  return Math.atan2(end[1] - start[1], (end[0] - start[0]) * Math.cos(meanLatitude));
}

function stableCycleKey(edgeIndices) {
  return [...edgeIndices].sort((first, second) => first - second).join(',');
}

function orientation(first, second, third) {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function properlyIntersects(firstStart, firstEnd, secondStart, secondEnd) {
  const firstStartSide = orientation(firstStart, firstEnd, secondStart);
  const firstEndSide = orientation(firstStart, firstEnd, secondEnd);
  const secondStartSide = orientation(secondStart, secondEnd, firstStart);
  const secondEndSide = orientation(secondStart, secondEnd, firstEnd);
  return (
    firstStartSide * firstEndSide < -1e-18 && secondStartSide * secondEndSide < -1e-18
  );
}

export function hasProperSelfIntersection(coordinates) {
  const cellSize = 0.05;
  const cells = new Map();
  for (let segmentIndex = 0; segmentIndex + 1 < coordinates.length; segmentIndex += 1) {
    const start = coordinates[segmentIndex];
    const end = coordinates[segmentIndex + 1];
    const west = Math.min(start[0], end[0]);
    const east = Math.max(start[0], end[0]);
    const south = Math.min(start[1], end[1]);
    const north = Math.max(start[1], end[1]);
    const checked = new Set();
    for (
      let cellX = Math.floor(west / cellSize);
      cellX <= Math.floor(east / cellSize);
      cellX += 1
    ) {
      for (
        let cellY = Math.floor(south / cellSize);
        cellY <= Math.floor(north / cellSize);
        cellY += 1
      ) {
        const cellKey = `${cellX},${cellY}`;
        for (const otherIndex of cells.get(cellKey) ?? []) {
          if (
            checked.has(otherIndex) ||
            Math.abs(otherIndex - segmentIndex) <= 1 ||
            (otherIndex === 0 && segmentIndex === coordinates.length - 2)
          ) {
            continue;
          }
          checked.add(otherIndex);
          if (
            properlyIntersects(
              start,
              end,
              coordinates[otherIndex],
              coordinates[otherIndex + 1],
            )
          ) {
            return true;
          }
        }
        const cell = cells.get(cellKey) ?? [];
        cell.push(segmentIndex);
        cells.set(cellKey, cell);
      }
    }
  }
  return false;
}

/**
 * Returns the face boundaries induced by the supplied geographic rotation
 * system. For a planar vertex-biconnected block, its outer face is a simple
 * cycle and encloses every bounded face, making it the maximum-area cycle.
 */
export function blockFaceCycles(nodes, edges, blockEdgeIndices) {
  const nodeCoordinates = new Map(nodes.map((node) => [node.id, node.coordinate]));
  const halfEdges = [];
  const outgoing = new Map();

  const addHalfEdge = (edgeIndex, fromId, toId) => {
    const coordinates = orientedCoordinates(edges[edgeIndex], fromId);
    const halfEdgeIndex = halfEdges.length;
    halfEdges.push({
      coordinates,
      edgeIndex,
      fromId,
      toId,
    });
    const incident = outgoing.get(fromId) ?? [];
    incident.push(halfEdgeIndex);
    outgoing.set(fromId, incident);
  };

  for (const edgeIndex of blockEdgeIndices) {
    const edge = edges[edgeIndex];
    if (!edge || edge.fromId === edge.toId) continue;
    addHalfEdge(edgeIndex, edge.fromId, edge.toId);
    addHalfEdge(edgeIndex, edge.toId, edge.fromId);
  }

  for (const [nodeId, incident] of outgoing) {
    incident.sort((firstIndex, secondIndex) => {
      const first = halfEdges[firstIndex];
      const second = halfEdges[secondIndex];
      return (
        directionAngle(first.coordinates) - directionAngle(second.coordinates) ||
        first.edgeIndex - second.edgeIndex
      );
    });
    if (!nodeCoordinates.has(nodeId)) {
      throw new Error(`Missing highway junction coordinate ${nodeId}`);
    }
  }

  const twinIndex = new Map();
  for (const [index, halfEdge] of halfEdges.entries()) {
    const twin = halfEdges.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.edgeIndex === halfEdge.edgeIndex &&
        candidate.fromId === halfEdge.toId,
    );
    if (twin < 0) throw new Error(`Missing highway half-edge twin ${index}`);
    twinIndex.set(index, twin);
  }

  const visited = new Set();
  const seenCycleKeys = new Set();
  const cycles = [];
  for (let startIndex = 0; startIndex < halfEdges.length; startIndex += 1) {
    if (visited.has(startIndex)) continue;
    const nodeIds = [];
    const edgeIndices = [];
    const coordinates = [];
    let currentIndex = startIndex;

    while (!visited.has(currentIndex)) {
      visited.add(currentIndex);
      const current = halfEdges[currentIndex];
      nodeIds.push(current.fromId);
      edgeIndices.push(current.edgeIndex);
      coordinates.push(
        ...(coordinates.length === 0
          ? current.coordinates
          : current.coordinates.slice(1)),
      );
      const incident = outgoing.get(current.toId) ?? [];
      const twin = twinIndex.get(currentIndex);
      const incomingPosition = incident.indexOf(twin);
      if (incomingPosition < 0) {
        throw new Error(`Broken highway rotation at ${current.toId}`);
      }
      // Take the clockwise predecessor so the same face remains on the left.
      currentIndex =
        incident[(incomingPosition - 1 + incident.length) % incident.length];
    }

    if (
      currentIndex !== startIndex ||
      nodeIds.length < 3 ||
      new Set(nodeIds).size !== nodeIds.length
    ) {
      continue;
    }
    const cycleKey = stableCycleKey(edgeIndices);
    if (seenCycleKeys.has(cycleKey)) continue;
    seenCycleKeys.add(cycleKey);
    const firstCoordinate = coordinates[0];
    const lastCoordinate = coordinates.at(-1);
    if (
      firstCoordinate &&
      lastCoordinate &&
      (firstCoordinate[0] !== lastCoordinate[0] ||
        firstCoordinate[1] !== lastCoordinate[1])
    ) {
      coordinates.push(firstCoordinate);
    }
    cycles.push({
      areaSquareMeters: geodesicPolygonAreaSquareMeters(coordinates),
      coordinates,
      edgeIndices,
      lengthMeters: geodesicLineLengthMeters(coordinates),
      nodeIds,
    });
  }

  return cycles;
}

export function solveLargestPlanarHighwayCycle(nodes, edges) {
  const blocks = biconnectedEdgeBlocks(nodes, edges);
  let best = null;
  let faceCount = 0;

  for (const blockEdgeIndices of blocks) {
    if (blockEdgeIndices.length < 3) continue;
    const cycles = blockFaceCycles(nodes, edges, blockEdgeIndices);
    faceCount += cycles.length;
    for (const cycle of cycles) {
      if (
        best === null ||
        cycle.areaSquareMeters > best.areaSquareMeters ||
        (cycle.areaSquareMeters === best.areaSquareMeters &&
          cycle.lengthMeters < best.lengthMeters)
      ) {
        best = cycle;
      }
    }
  }

  if (best === null) {
    throw new Error('No simple highway cycle was found.');
  }
  if (hasProperSelfIntersection(best.coordinates)) {
    throw new Error('Maximum highway boundary crosses itself in map geometry.');
  }
  return {
    ...best,
    biconnectedBlockCount: blocks.length,
    faceCount,
  };
}
