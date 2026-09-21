import { distance, lineLength } from './government-connections-geometry.mjs';

// Recover only audited reciprocal source paths. Endpoint attachment is limited
// to the named paired mainline, never to an arbitrary nearby/crossing road.
export function applySourceRecoveries(network, recoveries, fingerprint) {
  for (const recovery of recoveries) {
    if (recovery.sourceFingerprint !== fingerprint)
      throw new Error(`Re-audit ${recovery.id}: source topology changed`);
    if (network.parts.some((p) => p.id === recovery.id)) continue;
    const fromId = attach(network, recovery.start, recovery.id + ':start');
    const toId = attach(network, recovery.end, recovery.id + ':end');
    const partIndex = network.parts.length;
    network.parts.push({
      id: recovery.id,
      role: 'connector',
      sourceWayIds: [
        ...new Set(
          recovery.directionalPaths.flatMap((p) => [
            ...p.rampWayIds,
            ...(p.sourceSegments ?? []).map((s) => s.wayId),
          ]),
        ),
      ],
    });
    const fromTurnPort = {
      mainlineId: `mainline:${recovery.start.partIndex}`,
      direction: recovery.start.direction,
    };
    const toTurnPort = {
      mainlineId: `mainline:${recovery.end.partIndex}`,
      direction: recovery.end.direction,
    };
    network.edges.push({
      fromId,
      toId,
      fromTurnPort,
      toTurnPort,
      coordinates: recovery.coordinates,
      rawIndices: [],
      partIndices: [partIndex],
      role: 'connector',
      boundary: false,
      invalidTurn: false,
      lengthMeters: lineLength(recovery.coordinates),
    });
  }
  network.sourceRecoveries = recoveries.map((r) => r.id);
  return network;
}

function attach(network, endpoint, newId) {
  const prefix = `center:${endpoint.partIndex}:`,
    portId = `mainline:${endpoint.partIndex}`;
  for (let edgeIndex = 0; edgeIndex < network.edges.length; edgeIndex++) {
    const edge = network.edges[edgeIndex];
    if (edge.role !== 'mainline') continue;
    for (const [id, coordinate] of [
      [edge.fromId, edge.coordinates[0]],
      [edge.toId, edge.coordinates.at(-1)],
    ]) {
      if (id.startsWith(prefix) && distance(coordinate, endpoint.coordinate) < 0.05)
        return id;
    }
    let node = edge.fromId;
    for (let i = 0; i < edge.rawIndices.length; i++) {
      const raw = network.rawEdges[edge.rawIndices[i]];
      const next = raw.fromId === node ? raw.toId : raw.fromId;
      if (raw.fromId !== node && raw.toId !== node)
        throw new Error('Non-contiguous raw corridor');
      const a = edge.coordinates[i],
        b = edge.coordinates[i + 1],
        target = endpoint.coordinate;
      if (node.startsWith(prefix) && next.startsWith(prefix)) {
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          den = dx * dx + dy * dy;
        const t = den
          ? Math.max(
              0,
              Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / den),
            )
          : 0;
        const projected = [a[0] + t * dx, a[1] + t * dy];
        if (distance(projected, target) < 0.05) {
          const atA = distance(a, target) < 0.05,
            atB = distance(b, target) < 0.05;
          const id = atA ? node : atB ? next : newId;
          if (id === edge.fromId || id === edge.toId) return id;
          const direction = Math.sign(
            Number(next.slice(prefix.length)) - Number(node.slice(prefix.length)),
          );
          if (!direction) throw new Error('Ambiguous parent mainline direction');
          let points = edge.coordinates,
            indices = edge.rawIndices,
            split = atA ? i : i + 1;
          if (!atA && !atB) {
            points = [...points.slice(0, i + 1), target, ...points.slice(i + 1)];
            const forward = raw.fromId === node;
            const left = {
              ...raw,
              fromId: forward ? node : id,
              toId: forward ? id : node,
            };
            const right = {
              ...raw,
              fromId: forward ? id : next,
              toId: forward ? next : id,
            };
            const leftIndex = network.rawEdges.length;
            network.rawEdges.push(left, right);
            indices = [
              ...indices.slice(0, i),
              leftIndex,
              leftIndex + 1,
              ...indices.slice(i + 1),
            ];
          }
          const left = {
            ...edge,
            toId: id,
            toTurnPort: { mainlineId: portId, direction: -direction },
            coordinates: points.slice(0, split + 1),
            rawIndices: indices.slice(0, split),
          };
          const right = {
            ...edge,
            fromId: id,
            fromTurnPort: { mainlineId: portId, direction },
            coordinates: points.slice(split),
            rawIndices: indices.slice(split),
          };
          left.lengthMeters = lineLength(left.coordinates);
          right.lengthMeters = lineLength(right.coordinates);
          network.edges[edgeIndex] = left;
          network.edges.push(right);
          return id;
        }
      }
      node = next;
    }
  }
  throw new Error(`Audited endpoint no longer lies on ${endpoint.partId}`);
}
