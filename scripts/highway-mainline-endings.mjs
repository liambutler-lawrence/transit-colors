import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

export function buildMainlineEndingIndex(chains, mainlines, connectorWays) {
  const chainById = new Map(chains.map((chain) => [chain.id, chain]));
  const endpoints = new Set(
    chains.flatMap((chain) => [chain.startNodeId, chain.endNodeId]),
  );
  const neighbors = new Map();
  const links = new Map();
  for (const way of mainlines) {
    for (const [index, nodeId] of way.nodeIds.entries()) {
      if (!endpoints.has(nodeId)) continue;
      const adjacent = neighbors.get(nodeId) ?? new Set();
      if (index > 0) adjacent.add(way.nodeIds[index - 1]);
      if (index < way.nodeIds.length - 1) adjacent.add(way.nodeIds[index + 1]);
      neighbors.set(nodeId, adjacent);
    }
  }
  for (const way of connectorWays) {
    for (const nodeId of way.nodeIds) {
      if (!endpoints.has(nodeId)) continue;
      const incident = links.get(nodeId) ?? [];
      incident.push({ id: way.id, highway: way.tags.highway });
      links.set(nodeId, incident);
    }
  }
  return { chainById, neighbors, links };
}

function mainlineTopologyOwners(parts) {
  const owners = new Map();
  for (const [partIndex, part] of parts.entries()) {
    if (part.role !== 'mainline') continue;
    const keys = [
      ...(part.startTopologyKeys ?? []),
      ...(part.endTopologyKeys ?? []),
      ...(part.topologyCoordinates ?? []).map((entry) => entry.key),
    ];
    for (const key of keys) {
      const indices = owners.get(key) ?? new Set();
      indices.add(partIndex);
      owners.set(key, indices);
    }
  }
  return owners;
}

function connectorsByMainline(connectors) {
  const attachments = new Map();
  for (const connector of connectors) {
    for (const [partIndex, coordinate] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      const entries = attachments.get(partIndex) ?? [];
      entries.push({ coordinate, connector });
      attachments.set(partIndex, entries);
    }
  }
  return attachments;
}

function terminalRampMovements(part, side, endings, attachments) {
  const keys = new Set(part[`${side}TopologyKeys`] ?? []);
  const sourceNodes = [part.sourceChainId, part.pairedChainId].map((chainId) => {
    const chain = endings.chainById.get(chainId);
    if (!chain) return null;
    const nodes = [...new Set([chain.startNodeId, chain.endNodeId])].filter((nodeId) =>
      keys.has(`osm-node:${nodeId}`),
    );
    return nodes.length === 1 ? nodes[0] : null;
  });
  if (
    sourceNodes.some((nodeId) => nodeId == null) ||
    sourceNodes[0] === sourceNodes[1]
  ) {
    return null;
  }
  const movements = [];
  for (const nodeId of sourceNodes) {
    // An actual mainline continuation, including a branch or a through road
    // split into multiple OSM ways, prevents an endpoint from being ramp-only.
    if (endings.neighbors.get(nodeId)?.size !== 1) return null;
    const links = endings.links.get(nodeId) ?? [];
    if (!links.length || links.some((link) => link.highway !== 'motorway_link'))
      return null;
    const pairedIds = new Set();
    for (const link of links) {
      const paired = attachments.filter(({ connector }) =>
        connector.sourceWayIds.includes(link.id),
      );
      // Do not remove a mainline serving an unpaired or otherwise omitted exit.
      if (!paired.length) return null;
      for (const { connector } of paired) pairedIds.add(connector.id);
    }
    movements.push(pairedIds);
  }
  // Parallel pavement is still a common mainline if any reciprocal movement
  // uses both terminal sides. The tail is redundant only when the two sides
  // exclusively serve different, already represented ramp movements.
  if ([...movements[0]].some((id) => movements[1].has(id))) return null;
  return {
    sourceNodes,
    connectorIds: [...new Set(movements.flatMap((ids) => [...ids]))],
  };
}

function outermostAttachment(part, side, attachments) {
  const coordinates =
    side === 'start' ? part.coordinates : part.coordinates.toReversed();
  let distanceMeters = 0;
  for (const [index, coordinate] of coordinates.entries()) {
    if (index > 0)
      distanceMeters += geodesicDistanceMeters(coordinates[index - 1], coordinate);
    if (
      attachments.some(
        (entry) => geodesicDistanceMeters(entry.coordinate, coordinate) <= 0.25,
      )
    ) {
      return { index, distanceMeters, coordinates };
    }
  }
  return null;
}

/**
 * Audit every displayed mainline end after reciprocal ramps are attached.
 * Source topology, not proximity or a coordinate-specific exception, proves
 * when the remaining pavement belongs exclusively to separate ramp movements.
 */
export function trimRampOnlyMainlineTails(parts, connectors, endings) {
  const owners = mainlineTopologyOwners(parts);
  const attachmentsByPart = connectorsByMainline(connectors);
  const trims = [];
  let checkedEnds = 0;
  for (const [partIndex, part] of parts.entries()) {
    if (part.role !== 'mainline') continue;
    const attachments = attachmentsByPart.get(partIndex) ?? [];
    for (const side of ['start', 'end']) {
      checkedEnds += 1;
      const proof = terminalRampMovements(part, side, endings, attachments);
      if (!proof) continue;
      if (
        (part[`${side}TopologyKeys`] ?? []).some((key) =>
          [...(owners.get(key) ?? [])].some((owner) => owner !== partIndex),
        )
      )
        continue;
      const cut = outermostAttachment(part, side, attachments);
      if (!cut || cut.distanceMeters <= 1 || cut.index >= cut.coordinates.length - 1)
        continue;
      const retained = cut.coordinates.slice(cut.index);
      const removed = cut.coordinates.slice(0, cut.index);
      // Keep every existing junction and every ramp attachment. A terminal
      // adjustment must never trim through a connection on the shared trunk.
      if (
        (part.topologyCoordinates ?? []).some((entry) =>
          removed.some(
            (coordinate) =>
              geodesicDistanceMeters(entry.coordinate, coordinate) <= 0.25,
          ),
        )
      )
        continue;
      const coordinate = retained[0];
      const topologyKeys = (part.topologyCoordinates ?? [])
        .filter((entry) => geodesicDistanceMeters(entry.coordinate, coordinate) <= 0.25)
        .map((entry) => entry.key);
      if (!topologyKeys.length) continue;
      trims.push({
        partId: part.id,
        side,
        from: cut.coordinates[0],
        to: coordinate,
        distanceMeters: cut.distanceMeters,
        ...proof,
      });
      part.coordinates = side === 'start' ? retained : retained.toReversed();
      part[`${side}NodeId`] = null;
      part[`${side}TopologyKeys`] = topologyKeys;
    }
  }
  return {
    trims,
    statistics: {
      auditedMainlineEndCount: checkedEnds,
      trimmedRampOnlyTailCount: trims.length,
      trimmedRampOnlyTailMeters: trims.reduce(
        (total, trim) => total + trim.distanceMeters,
        0,
      ),
    },
  };
}
