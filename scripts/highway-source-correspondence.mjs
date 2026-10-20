import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const interpolate = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sectionPosition(section, position) {
  const i = Math.min(section.positions.length - 2, Math.floor(position));
  let a = section.positions[i];
  const b = section.positions[i + 1];
  // A closed source chain can cross its storage seam inside this section.
  if (Math.abs(b - a) > 1.000001) a = b - section.direction;
  return a + (b - a) * (position - i);
}

export function sourceCorrespondence(ordered, first, second) {
  return {
    coordinates: ordered.coordinates,
    sides: [first, second].map((section, side) => ({
      chainId: section.chainId,
      positions: ordered.pairs.map((p) =>
        sectionPosition(section, side === 0 ? p.firstPosition : p.secondPosition),
      ),
    })),
  };
}

/** Resolve an actual source node through the saved ordered correspondence. */
export function sourceMidpointAttachment(part, nodeId, chainById) {
  const mapping = part.sourceCorrespondence;
  if (!mapping) return null;
  let best = null;
  for (const side of mapping.sides) {
    const chain = chainById.get(side.chainId);
    if (!chain) continue;
    for (let nodePosition = 0; nodePosition < chain.nodeIds.length; nodePosition++) {
      if (chain.nodeIds[nodePosition] !== nodeId) continue;
      for (let i = 1; i < side.positions.length; i++) {
        const a = side.positions[i - 1],
          b = side.positions[i];
        // Never interpret the storage seam as a traversal of the whole chain.
        if (Math.abs(b - a) > chain.nodeIds.length / 2) continue;
        const t = Math.max(0, Math.min(1, (nodePosition - a) / (b - a || 1)));
        const sourcePosition = a + (b - a) * t;
        const gap = Math.abs(sourcePosition - nodePosition);
        if (best && gap >= best.gap) continue;
        const coordinates = mapping.coordinates;
        let coordinate = interpolate(coordinates[i - 1], coordinates[i], t);
        if (i === 1 && t === 0) coordinate = part.coordinates[0];
        if (i === coordinates.length - 1 && t === 1)
          coordinate = part.coordinates.at(-1);
        best = {
          gap,
          coordinate,
          sourceTargets: mapping.sides.map((other) => ({
            chainId: other.chainId,
            position:
              other.positions[i - 1] +
              (other.positions[i] - other.positions[i - 1]) * t,
          })),
        };
      }
    }
  }
  return best;
}

/** Source positions, rather than a median point, bound a staggered extension. */
export function sourceExtension(attachment, target, chains, backwards) {
  return (
    sourceExtensionPath(attachment, target, chains, backwards)?.coordinates ?? null
  );
}

export function sourceExtensionPath(attachment, target, chains, backwards) {
  for (const stop of target.sourceTargets ?? []) {
    const chain = chains.get(stop.chainId);
    if (!chain) continue;
    const origin = chain.nodeIds.indexOf(attachment.nodeId);
    if (origin < 0) continue;
    const end = Math.max(0, Math.min(chain.coordinates.length - 1, stop.position));
    // This side is already at/past the boundary: do not extend both sides.
    if (backwards ? end >= origin : end <= origin)
      return {
        coordinates: [chain.coordinates[origin]],
        nodeIds: [chain.nodeIds[origin]],
      };
    const i = Math.min(chain.coordinates.length - 2, Math.floor(end));
    const last = interpolate(chain.coordinates[i], chain.coordinates[i + 1], end - i);
    const interior = backwards
      ? chain.coordinates.slice(Math.floor(end) + 1, origin).toReversed()
      : chain.coordinates.slice(origin + 1, Math.ceil(end));
    const indices = backwards
      ? Array.from({ length: interior.length }, (_, j) => origin - j - 1)
      : Array.from({ length: interior.length }, (_, j) => origin + j + 1);
    const coordinates = [chain.coordinates[origin], ...interior, last];
    const nodeIds = [
      chain.nodeIds[origin],
      ...indices.map((j) => chain.nodeIds[j]),
      Number.isInteger(end) ? chain.nodeIds[end] : `source-position:${chain.id}:${end}`,
    ];
    const kept = coordinates
      .map((_, j) => j)
      .filter(
        (j) =>
          j === 0 || geodesicDistanceMeters(coordinates[j - 1], coordinates[j]) > 0.01,
      );
    return {
      coordinates: kept.map((j) => coordinates[j]),
      nodeIds: kept.map((j) => nodeIds[j]),
    };
  }
  return null;
}
