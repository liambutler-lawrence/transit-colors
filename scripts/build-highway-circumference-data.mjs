import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import polygonClipping from 'polygon-clipping';

import { calculateLandmassCoverage } from '../src/circumference-landmass.ts';
import { geodesicPolygonAreaSquareMeters } from '../src/geodesy.ts';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { solveLargestPlanarHighwayCycle } from './highway-cycle.mjs';

const sourcePath = resolve(
  process.argv[2] ??
    '/tmp/transit-highways.VyR1xL/roads/ne_10m_roads_north_america.shp',
);
const dbfPath = sourcePath.replace(/\.shp$/i, '.dbf');
const outputPath = resolve(
  process.argv[3] ?? 'data/north-america-highway-circumference.json',
);
const landmassSourcePath = resolve(process.argv[4] ?? '/tmp/ne-land/ne_10m_land.shp');
const interchangeOverridePath = resolve(
  process.argv[5] ?? 'data/highway-interchanges/norwalk-i95-us7.json',
);
const SNAP_DISTANCE_METERS = 75;
const CROSS_BORDER_SEAM_DISTANCE_METERS = 3_000;

class UnionFind {
  constructor(values) {
    this.parent = new Map(values.map((value) => [value, value]));
  }

  find(value) {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error(`Unknown highway node ${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(first, second) {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;
    const [root, child] =
      firstRoot < secondRoot ? [firstRoot, secondRoot] : [secondRoot, firstRoot];
    this.parent.set(child, root);
  }
}

function readDbfRecords(buffer) {
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let offset = 32; offset + 32 <= headerLength; offset += 32) {
    if (buffer[offset] === 0x0d) break;
    const zeroIndex = buffer.indexOf(0, offset);
    const nameEnd =
      zeroIndex >= offset && zeroIndex < offset + 11 ? zeroIndex : offset + 11;
    fields.push({
      length: buffer[offset + 16],
      name: buffer.toString('ascii', offset, nameEnd).trim().toLowerCase(),
    });
  }

  const records = [];
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    const recordOffset = headerLength + recordIndex * recordLength;
    let fieldOffset = recordOffset + 1;
    const record = {};
    for (const field of fields) {
      record[field.name] = buffer
        .toString('utf8', fieldOffset, fieldOffset + field.length)
        .replace(/\0/g, '')
        .trim();
      fieldOffset += field.length;
    }
    records.push(record);
  }
  return records;
}

function readPolylineRecords(buffer) {
  const records = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const recordNumber = buffer.readInt32BE(offset);
    const contentLengthBytes = buffer.readInt32BE(offset + 4) * 2;
    offset += 8;
    const recordEnd = offset + contentLengthBytes;
    const shapeType = buffer.readInt32LE(offset);
    if (shapeType === 3) {
      const partCount = buffer.readInt32LE(offset + 36);
      const pointCount = buffer.readInt32LE(offset + 40);
      const partStarts = [];
      let cursor = offset + 44;
      for (let index = 0; index < partCount; index += 1) {
        partStarts.push(buffer.readInt32LE(cursor + index * 4));
      }
      cursor += partCount * 4;
      const points = [];
      for (let index = 0; index < pointCount; index += 1) {
        points.push([
          buffer.readDoubleLE(cursor + index * 16),
          buffer.readDoubleLE(cursor + index * 16 + 8),
        ]);
      }
      records.push({
        parts: partStarts.map((start, index) =>
          points.slice(start, partStarts[index + 1] ?? pointCount),
        ),
        recordNumber,
      });
    }
    offset = recordEnd;
  }
  return records;
}

function readPolygonRecords(buffer) {
  const rings = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthBytes = buffer.readInt32BE(offset + 4) * 2;
    offset += 8;
    const recordEnd = offset + contentLengthBytes;
    const shapeType = buffer.readInt32LE(offset);
    if (shapeType === 5) {
      const partCount = buffer.readInt32LE(offset + 36);
      const pointCount = buffer.readInt32LE(offset + 40);
      const partStarts = [];
      let cursor = offset + 44;
      for (let index = 0; index < partCount; index += 1) {
        partStarts.push(buffer.readInt32LE(cursor + index * 4));
      }
      cursor += partCount * 4;
      const points = [];
      for (let index = 0; index < pointCount; index += 1) {
        points.push([
          buffer.readDoubleLE(cursor + index * 16),
          buffer.readDoubleLE(cursor + index * 16 + 8),
        ]);
      }
      for (const [partIndex, start] of partStarts.entries()) {
        rings.push(points.slice(start, partStarts[partIndex + 1] ?? pointCount));
      }
    }
    offset = recordEnd;
  }
  return rings;
}

function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = ring.length - 1;
    currentIndex < ring.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    if (
      current[1] > latitude !== previous[1] > latitude &&
      longitude <
        ((previous[0] - current[0]) * (latitude - current[1])) /
          (previous[1] - current[1]) +
          current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function multiPolygonAreaSquareMeters(multiPolygon) {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal +
          geodesicPolygonAreaSquareMeters(ring) * (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

function coordinateKey([longitude, latitude]) {
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
}

function edgeKey(firstId, secondId) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

function roundCoordinate([longitude, latitude]) {
  return [Number(longitude.toFixed(5)), Number(latitude.toFixed(5))];
}

function eligibleRoad(properties) {
  return (
    ['Freeway', 'Tollway'].includes(properties.type) && properties.divided === 'Divided'
  );
}

function nearestCoordinateIndex(coordinates, target) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (const [index, coordinate] of coordinates.entries()) {
    const distance = geodesicDistanceMeters(coordinate, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  if (bestDistance > 5) {
    throw new Error(
      `Precision override anchor is ${bestDistance.toFixed(1)}m from its source feature.`,
    );
  }
  return bestIndex;
}

function applyInterchangeOverride(parts, override) {
  for (const mainline of override.mainlines) {
    const part = parts.find(
      (candidate) => candidate.featureId === mainline.targetFeatureId,
    );
    if (!part) {
      throw new Error(`Missing precision override target ${mainline.targetFeatureId}.`);
    }
    if (mainline.replacementMode === 'full') {
      part.coordinates = mainline.coordinates;
    } else {
      const firstIndex = nearestCoordinateIndex(
        part.coordinates,
        mainline.coordinates[0],
      );
      const lastIndex = nearestCoordinateIndex(
        part.coordinates,
        mainline.coordinates.at(-1),
      );
      const startIndex = Math.min(firstIndex, lastIndex);
      const endIndex = Math.max(firstIndex, lastIndex);
      const replacement =
        firstIndex <= lastIndex
          ? mainline.coordinates
          : [...mainline.coordinates].reverse();
      part.coordinates = [
        ...part.coordinates.slice(0, startIndex),
        ...replacement,
        ...part.coordinates.slice(endIndex + 1),
      ];
    }
    part.centerlineSource = override.source;
    part.osmWayIds = mainline.wayIds;
  }
  for (const connector of override.connectors) {
    parts.push({
      centerlineSource: override.source,
      coordinates: connector.coordinates,
      featureId: connector.id,
      osmWayIds: connector.wayIds,
      partIndex: 0,
      properties: {
        class: 'Direct freeway interchange',
        country: 'United States',
        divided: 'Separated ramps',
        note: `${connector.fromRef} ↔ ${connector.toRef}`,
        number: '',
        state: 'Connecticut',
        type: 'Connector',
      },
      recordNumber: connector.id,
      role: 'connector',
    });
  }
}

function buildRawGraph(parts) {
  const coordinateByNodeId = new Map();
  const rawEdges = [];
  const edgeByKey = new Map();
  for (const [partIndex, part] of parts.entries()) {
    for (const coordinate of part.coordinates) {
      coordinateByNodeId.set(coordinateKey(coordinate), coordinate);
    }
    for (let index = 1; index < part.coordinates.length; index += 1) {
      const fromId = coordinateKey(part.coordinates[index - 1]);
      const toId = coordinateKey(part.coordinates[index]);
      if (fromId === toId) continue;
      const key = edgeKey(fromId, toId);
      const existing = edgeByKey.get(key);
      if (existing !== undefined) {
        rawEdges[existing].partIndices.add(partIndex);
        continue;
      }
      edgeByKey.set(key, rawEdges.length);
      rawEdges.push({
        fromId,
        partIndices: new Set([partIndex]),
        toId,
      });
    }
  }
  return { coordinateByNodeId, rawEdges };
}

function snapDanglingEndpoints(coordinateByNodeId, rawEdges) {
  const degree = new Map([...coordinateByNodeId.keys()].map((nodeId) => [nodeId, 0]));
  for (const edge of rawEdges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }
  const endpoints = [...degree]
    .filter(([, nodeDegree]) => nodeDegree === 1)
    .map(([nodeId]) => nodeId);
  const gridSize = 0.001;
  const buckets = new Map();
  const candidates = [];
  for (const nodeId of endpoints) {
    const coordinate = coordinateByNodeId.get(nodeId);
    const cellX = Math.floor(coordinate[0] / gridSize);
    const cellY = Math.floor(coordinate[1] / gridSize);
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const otherId of buckets.get(`${x},${y}`) ?? []) {
          const distanceMeters = geodesicDistanceMeters(
            coordinate,
            coordinateByNodeId.get(otherId),
          );
          if (distanceMeters <= SNAP_DISTANCE_METERS) {
            candidates.push({ distanceMeters, firstId: otherId, secondId: nodeId });
          }
        }
      }
    }
    const bucketKey = `${cellX},${cellY}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(nodeId);
    buckets.set(bucketKey, bucket);
  }
  candidates.sort(
    (first, second) =>
      first.distanceMeters - second.distanceMeters ||
      first.firstId.localeCompare(second.firstId) ||
      first.secondId.localeCompare(second.secondId),
  );

  const union = new UnionFind([...coordinateByNodeId.keys()]);
  const snapped = new Set();
  let snapCount = 0;
  for (const candidate of candidates) {
    if (snapped.has(candidate.firstId) || snapped.has(candidate.secondId)) continue;
    union.union(candidate.firstId, candidate.secondId);
    snapped.add(candidate.firstId);
    snapped.add(candidate.secondId);
    snapCount += 1;
  }

  const membersByRoot = new Map();
  for (const nodeId of coordinateByNodeId.keys()) {
    const root = union.find(nodeId);
    const members = membersByRoot.get(root) ?? [];
    members.push(nodeId);
    membersByRoot.set(root, members);
  }
  const snappedCoordinates = new Map();
  for (const [root, members] of membersByRoot) {
    const coordinate = members
      .map((nodeId) => coordinateByNodeId.get(nodeId))
      .reduce(
        (total, coordinate) => [
          total[0] + coordinate[0] / members.length,
          total[1] + coordinate[1] / members.length,
        ],
        [0, 0],
      );
    snappedCoordinates.set(root, coordinate);
  }

  const mergedEdges = [];
  const mergedEdgeByKey = new Map();
  for (const rawEdge of rawEdges) {
    const fromId = union.find(rawEdge.fromId);
    const toId = union.find(rawEdge.toId);
    if (fromId === toId) continue;
    const key = edgeKey(fromId, toId);
    const existing = mergedEdgeByKey.get(key);
    if (existing !== undefined) {
      for (const partIndex of rawEdge.partIndices) {
        mergedEdges[existing].partIndices.add(partIndex);
      }
      continue;
    }
    mergedEdgeByKey.set(key, mergedEdges.length);
    mergedEdges.push({
      fromId,
      partIndices: new Set(rawEdge.partIndices),
      toId,
    });
  }
  return {
    coordinateByNodeId: snappedCoordinates,
    rawEdges: mergedEdges,
    snapCount,
  };
}

function largestConnectedComponent(nodeIds, edges) {
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
  if (!largestRoot) throw new Error('The divided-highway dataset is empty.');
  const componentNodes = new Set(
    nodeIds.filter((nodeId) => union.find(nodeId) === largestRoot),
  );
  return {
    edges: edges.filter((edge) => componentNodes.has(edge.fromId)),
    nodeIds: componentNodes,
  };
}

function crossBorderEndpointCandidates(coordinateByNodeId, edges, parts) {
  const incident = new Map(
    [...coordinateByNodeId.keys()].map((nodeId) => [nodeId, []]),
  );
  for (const [edgeIndex, edge] of edges.entries()) {
    incident.get(edge.fromId)?.push(edgeIndex);
    incident.get(edge.toId)?.push(edgeIndex);
  }
  const endpoints = [...incident]
    .filter(([, edgeIndices]) => edgeIndices.length === 1)
    .map(([nodeId, edgeIndices]) => {
      const countries = new Set(
        edgeIndices.flatMap((edgeIndex) =>
          [...edges[edgeIndex].partIndices].map(
            (partIndex) => parts[partIndex].properties.country,
          ),
        ),
      );
      return { countries, edgeIndices, nodeId };
    });
  const gridSize = 0.5;
  const buckets = new Map();
  const candidates = [];
  for (const endpoint of endpoints) {
    const coordinate = coordinateByNodeId.get(endpoint.nodeId);
    const cellX = Math.floor(coordinate[0] / gridSize);
    const cellY = Math.floor(coordinate[1] / gridSize);
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const other of buckets.get(`${x},${y}`) ?? []) {
          if (
            [...endpoint.countries].every((country) => other.countries.has(country))
          ) {
            continue;
          }
          const distanceMeters = geodesicDistanceMeters(
            coordinate,
            coordinateByNodeId.get(other.nodeId),
          );
          if (distanceMeters <= 25_000) {
            candidates.push({
              countries: [
                [...other.countries].join('/'),
                [...endpoint.countries].join('/'),
              ],
              distanceMeters,
              firstEdgeIndex: other.edgeIndices[0],
              firstId: other.nodeId,
              secondEdgeIndex: endpoint.edgeIndices[0],
              secondId: endpoint.nodeId,
            });
          }
        }
      }
    }
    const bucketKey = `${cellX},${cellY}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(endpoint);
    buckets.set(bucketKey, bucket);
  }
  return candidates.sort(
    (first, second) =>
      first.distanceMeters - second.distanceMeters ||
      first.firstId.localeCompare(second.firstId),
  );
}

function connectCrossBorderSeams(edges, candidates) {
  const connectedEndpoints = new Set();
  const connectors = [];
  for (const candidate of candidates) {
    if (candidate.distanceMeters > CROSS_BORDER_SEAM_DISTANCE_METERS) break;
    if (
      connectedEndpoints.has(candidate.firstId) ||
      connectedEndpoints.has(candidate.secondId)
    ) {
      continue;
    }
    connectedEndpoints.add(candidate.firstId);
    connectedEndpoints.add(candidate.secondId);
    const firstEdge = edges[candidate.firstEdgeIndex];
    const secondEdge = edges[candidate.secondEdgeIndex];
    connectors.push({
      countries: candidate.countries,
      distanceMeters: candidate.distanceMeters,
      fromId: candidate.firstId,
      partIndices: new Set([...firstEdge.partIndices, ...secondEdge.partIndices]),
      seamConnector: true,
      toId: candidate.secondId,
    });
  }
  edges.push(...connectors);
  return connectors;
}

function twoCore(nodeIds, edges) {
  const incident = new Map([...nodeIds].map((nodeId) => [nodeId, new Set()]));
  for (const [edgeIndex, edge] of edges.entries()) {
    incident.get(edge.fromId)?.add(edgeIndex);
    incident.get(edge.toId)?.add(edgeIndex);
  }
  const activeNodes = new Set(nodeIds);
  const activeEdges = new Set(edges.map((_, index) => index));
  const pending = [...nodeIds].filter((nodeId) => incident.get(nodeId)?.size < 2);
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

function compressTwoCore(coordinatesByNodeId, edges, core) {
  const junctions = new Set(
    [...core.activeNodes].filter((nodeId) => core.incident.get(nodeId)?.size !== 2),
  );
  const unvisitedNodes = new Set(core.activeNodes);
  while (unvisitedNodes.size > 0) {
    const firstNode = unvisitedNodes.values().next().value;
    const component = [];
    const pending = [firstNode];
    unvisitedNodes.delete(firstNode);
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
      const coordinates = [coordinatesByNodeId.get(startId)];
      const originalEdgeIndices = [];
      const partIndices = new Set();
      let currentId = startId;
      let edgeIndex = startingEdgeIndex;
      while (true) {
        visitedEdges.add(edgeIndex);
        originalEdgeIndices.push(edgeIndex);
        const edge = edges[edgeIndex];
        for (const partIndex of edge.partIndices) partIndices.add(partIndex);
        const nextId = edge.fromId === currentId ? edge.toId : edge.fromId;
        coordinates.push(coordinatesByNodeId.get(nextId));
        currentId = nextId;
        if (junctions.has(currentId)) break;
        const nextEdgeIndex = [...(core.incident.get(currentId) ?? [])].find(
          (candidateIndex) =>
            candidateIndex !== edgeIndex && core.activeEdges.has(candidateIndex),
        );
        if (nextEdgeIndex === undefined) {
          throw new Error(`Highway corridor ends unexpectedly at ${currentId}`);
        }
        edgeIndex = nextEdgeIndex;
      }
      corridors.push({
        coordinates,
        fromId: startId,
        originalEdgeIndices,
        partIndices,
        toId: currentId,
      });
    }
  }
  const nodes = [...junctions].map((nodeId) => ({
    coordinate: coordinatesByNodeId.get(nodeId),
    id: nodeId,
  }));
  return { edges: corridors, nodes };
}

const [shapeBuffer, dbfBuffer, landmassBuffer, interchangeOverrideBuffer] =
  await Promise.all([
    readFile(sourcePath),
    readFile(dbfPath),
    readFile(landmassSourcePath),
    readFile(interchangeOverridePath, 'utf8'),
  ]);
const interchangeOverride = JSON.parse(interchangeOverrideBuffer);
const shapeRecords = readPolylineRecords(shapeBuffer);
const propertiesRecords = readDbfRecords(dbfBuffer);
const parts = shapeRecords.flatMap((shapeRecord) => {
  const properties = propertiesRecords[shapeRecord.recordNumber - 1] ?? {};
  if (!eligibleRoad(properties)) return [];
  return shapeRecord.parts.flatMap((coordinates, partIndex) =>
    coordinates.length < 2
      ? []
      : [
          {
            centerlineSource: 'Natural Earth',
            coordinates,
            featureId: `ne-road-${shapeRecord.recordNumber}-${partIndex}`,
            partIndex,
            properties,
            recordNumber: shapeRecord.recordNumber,
            role: 'mainline',
          },
        ],
  );
});
applyInterchangeOverride(parts, interchangeOverride);

console.time('Build divided-highway graph');
const rawGraph = buildRawGraph(parts);
const snappedGraph = snapDanglingEndpoints(
  rawGraph.coordinateByNodeId,
  rawGraph.rawEdges,
);
const crossBorderCandidates = crossBorderEndpointCandidates(
  snappedGraph.coordinateByNodeId,
  snappedGraph.rawEdges,
  parts,
);
const crossBorderConnectors = connectCrossBorderSeams(
  snappedGraph.rawEdges,
  crossBorderCandidates,
);
const largestComponent = largestConnectedComponent(
  [...snappedGraph.coordinateByNodeId.keys()],
  snappedGraph.rawEdges,
);
const core = twoCore(largestComponent.nodeIds, largestComponent.edges);
const compressed = compressTwoCore(
  snappedGraph.coordinateByNodeId,
  largestComponent.edges,
  core,
);
console.timeEnd('Build divided-highway graph');
console.log({
  eligibleParts: parts.length,
  crossBorderSeamConnectors: crossBorderConnectors.length,
  endpointSnaps: snappedGraph.snapCount,
  giantEdges: largestComponent.edges.length,
  giantNodes: largestComponent.nodeIds.size,
  coreEdges: core.activeEdges.size,
  coreNodes: core.activeNodes.size,
  compressedEdges: compressed.edges.length,
  compressedNodes: compressed.nodes.length,
});

console.time('Solve exact planar highway boundary');
const exact = solveLargestPlanarHighwayCycle(compressed.nodes, compressed.edges);
console.timeEnd('Solve exact planar highway boundary');
console.log({
  areaSquareKilometers: exact.areaSquareMeters / 1_000_000,
  biconnectedBlocks: exact.biconnectedBlockCount,
  boundaryCorridors: exact.edgeIndices.length,
  boundaryPoints: exact.coordinates.length,
  faceCount: exact.faceCount,
  lengthKilometers: exact.lengthMeters / 1_000,
});

const giantPartIndices = new Set(
  largestComponent.edges.flatMap((edge) => [...edge.partIndices]),
);
const networkFeatures = [...giantPartIndices]
  .sort((first, second) => first - second)
  .map((partIndex) => {
    const part = parts[partIndex];
    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: part.coordinates.map(roundCoordinate),
      },
      properties: {
        class: part.properties.class,
        country: part.properties.country,
        divided: part.properties.divided,
        id: part.featureId,
        name: part.properties.note || part.properties.number || '',
        number: part.properties.number || '',
        role: part.role,
        state: part.properties.state || '',
        type: part.properties.type,
      },
    };
  });
for (const [index, connector] of crossBorderConnectors.entries()) {
  if (
    !largestComponent.nodeIds.has(connector.fromId) ||
    !largestComponent.nodeIds.has(connector.toId)
  ) {
    continue;
  }
  networkFeatures.push({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        roundCoordinate(snappedGraph.coordinateByNodeId.get(connector.fromId)),
        roundCoordinate(snappedGraph.coordinateByNodeId.get(connector.toId)),
      ],
    },
    properties: {
      class: 'International seam repair',
      country: connector.countries.join(' / '),
      divided: 'Divided',
      id: `cross-border-seam-${index + 1}`,
      name: 'Source seam connector',
      number: '',
      role: 'source-seam',
      state: '',
      type: 'Connector',
    },
  });
}
const boundaryPartIndices = new Set(
  exact.edgeIndices.flatMap((edgeIndex) => [
    ...compressed.edges[edgeIndex].partIndices,
  ]),
);
const routeCoordinates = exact.coordinates.map(roundCoordinate);
const routeSegments = exact.edgeIndices.map((edgeIndex, index) => {
  const corridor = compressed.edges[edgeIndex];
  const fromId = exact.nodeIds[index];
  const coordinates =
    corridor.fromId === fromId
      ? corridor.coordinates
      : [...corridor.coordinates].reverse();
  const role = [...corridor.partIndices].some(
    (partIndex) => parts[partIndex].role === 'connector',
  )
    ? 'connector'
    : 'mainline';
  return {
    coordinates: coordinates.map(roundCoordinate),
    id: `${role}-boundary-${index + 1}`,
    role,
  };
});
const americanMainlandRing = readPolygonRecords(landmassBuffer).find((ring) =>
  pointInRing([-99.1332, 19.4326], ring),
);
if (!americanMainlandRing) {
  throw new Error('Natural Earth land data does not contain the American mainland.');
}
// The Americas are physically joined at Panama. This product uses the common
// continental convention and closes the North American calculation boundary
// just south of Panama rather than attributing South America to the outside.
const northAmericanMainlandMask = polygonClipping
  .intersection(
    [[americanMainlandRing]],
    [
      [
        [
          [-180, 7],
          [-20, 7],
          [-20, 90],
          [-180, 90],
          [-180, 7],
        ],
      ],
    ],
  )
  .map((polygon) => polygon.map((ring) => ring.map(roundCoordinate)));
const northAmericanMainlandAreaSquareMeters = multiPolygonAreaSquareMeters(
  northAmericanMainlandMask,
);
console.time('Calculate highway landmass coverage');
const [landmassCoverage] = calculateLandmassCoverage(
  routeCoordinates,
  {
    area_m2: northAmericanMainlandAreaSquareMeters,
    gradient_bounds: [-125, 24, -66, 50],
    label: 'North American mainland',
    landmasses: [
      {
        area_m2: northAmericanMainlandAreaSquareMeters,
        id: 'north-american-mainland',
        label: 'North American mainland',
        mask: northAmericanMainlandMask,
      },
    ],
    mask: northAmericanMainlandMask,
  },
  polygonClipping,
);
console.timeEnd('Calculate highway landmass coverage');
if (!landmassCoverage) {
  throw new Error('The highway boundary does not intersect North American land.');
}
const output = {
  source:
    'Natural Earth 1:10m North America roads supplement with OpenStreetMap precision interchanges',
  source_url: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/roads/',
  source_version: '5.1.1',
  precision_source: interchangeOverride.source,
  precision_source_url: interchangeOverride.sourceUrl,
  precision_source_license: interchangeOverride.license,
  criterion:
    'Separated controlled-access mainlines (2+ lanes per direction) with direct ramp-only interchange connectors',
  centerline_method:
    'Average of paired OSM carriageways at precision interchanges; Natural Earth generalized centerlines elsewhere',
  landmass_source: 'Natural Earth 1:10m land polygons',
  landmass_source_url:
    'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
  landmass_source_version: '5.1.1',
  landmass: {
    area_m2: northAmericanMainlandAreaSquareMeters,
    id: 'north-american-mainland',
    label: 'North American mainland',
    mask: northAmericanMainlandMask,
  },
  network: {
    type: 'FeatureCollection',
    features: networkFeatures,
  },
  route: {
    areaSquareMeters: exact.areaSquareMeters,
    boundaryCorridorCount: exact.edgeIndices.length,
    boundaryRoadFeatureCount: boundaryPartIndices.size,
    containedLandAreaSquareMeters: landmassCoverage.insideAreaSquareMeters,
    coordinates: routeCoordinates,
    countries: [
      ...new Set(
        [...boundaryPartIndices].map(
          (partIndex) => parts[partIndex].properties.country,
        ),
      ),
    ]
      .filter(Boolean)
      .sort(),
    id: 'north-america-controlled-access-maximum',
    lengthMeters: exact.lengthMeters,
    outsideLandAreaSquareMeters: landmassCoverage.outsideAreaSquareMeters,
    segments: routeSegments,
  },
  methodology: {
    biconnectedBlockCount: exact.biconnectedBlockCount,
    compressedEdgeCount: compressed.edges.length,
    compressedNodeCount: compressed.nodes.length,
    crossBorderSeamConnectorCount: crossBorderConnectors.length,
    endpointSnapCount: snappedGraph.snapCount,
    faceCount: exact.faceCount,
    giantNetworkEdgeCount: largestComponent.edges.length,
    giantNetworkNodeCount: largestComponent.nodeIds.size,
    interchangeConnectorCount: interchangeOverride.connectors.length,
    osmPrecisionMainlineCount: interchangeOverride.mainlines.length,
    optimizationMethod: 'exact-planar-biconnected-outer-boundary',
    optimizationStatus: 'optimal',
    sourceFeatureCount: networkFeatures.length,
  },
};

await writeFile(outputPath, `${JSON.stringify(output)}\n`);
console.log(`Wrote ${outputPath}`);
