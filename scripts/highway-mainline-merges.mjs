function includesRange(outer, inner) {
  return (
    Math.min(...outer) <= Math.min(...inner) + 1e-9 &&
    Math.max(...outer) >= Math.max(...inner) - 1e-9
  );
}

function pathCoversRange(chain, positions, pathNodes) {
  const start = Math.floor(Math.min(...positions) + 1e-9);
  const end = Math.ceil(Math.max(...positions) - 1e-9);
  for (let index = start; index <= end; index += 1) {
    if (!pathNodes.has(chain.nodeIds[index])) return false;
  }
  return true;
}

/**
 * A one-lane merge can leave two nearby, unrelated mainline directions paired
 * across the junction. Remove that pair only when its entire source interval
 * is already covered on one side by an explicit reciprocal merge and on the
 * other by the continuing, separately paired mainline. Geometry alone is not
 * evidence that a branch is redundant.
 */
export function coveredMainlineMergePairs(originalParts, connectors, parts, chains) {
  const chainById = new Map(chains.map((chain) => [chain.id, chain]));
  const originals = new Map(originalParts.map((part) => [part.id, part]));
  const topologyOwners = new Map();
  const topologyKeys = (part) => [
    ...(part.startTopologyKeys ?? []),
    ...(part.endTopologyKeys ?? []),
    ...(part.topologyCoordinates ?? []).map((entry) => entry.key),
  ];
  const joinedParts = new Map(parts.map((part) => [part.id, part]));
  for (const part of parts)
    for (const key of topologyKeys(part)) {
      const owners = topologyOwners.get(key) ?? new Set();
      owners.add(part.id);
      topologyOwners.set(key, owners);
    }
  // A displayed connection with its own attachments must survive even if
  // part of its pavement also participates in another reciprocal movement.
  const protectedIds = new Set([
    ...connectors.flatMap((connector) => [
      parts[connector.startMainlinePartIndex].id,
      parts[connector.endMainlinePartIndex].id,
    ]),
    ...originalParts.flatMap((part) =>
      part.continuationEndpoints
        ? [part.continuationEndpoints.beforeId, part.continuationEndpoints.afterId]
        : [],
    ),
  ]);
  const byChain = new Map();
  for (const part of originalParts) {
    if (part.continuationEndpoints || part.sourceRanges?.length !== 2) continue;
    for (const range of part.sourceRanges) {
      const entries = byChain.get(range.chainId) ?? [];
      entries.push(part);
      byChain.set(range.chainId, entries);
    }
  }
  const covered = new Map();
  for (const connector of connectors) {
    if (!connector.mixedMainline) continue;
    const ends = [connector.startMainlinePartIndex, connector.endMainlinePartIndex].map(
      (index) => originals.get(parts[index].id),
    );
    if (ends.some((part) => part?.sourceRanges?.length !== 2)) continue;
    const pathNodes = new Set(connector.sourceNodeIds);
    for (const [branch, through] of [ends, ends.toReversed()]) {
      for (const branchRange of branch.sourceRanges) {
        for (const candidate of byChain.get(branchRange.chainId) ?? []) {
          if (protectedIds.has(candidate.id)) continue;
          if (
            topologyKeys(joinedParts.get(candidate.id) ?? candidate).some((key) =>
              [...(topologyOwners.get(key) ?? [])].some(
                (id) => id !== candidate.id && id !== branch.id && id !== through.id,
              ),
            )
          )
            continue;
          const paired = candidate.sourceRanges.find(
            (range) => range.chainId === branchRange.chainId,
          );
          const other = candidate.sourceRanges.find((range) => range !== paired);
          const trunkRange = through.sourceRanges.find(
            (range) => range.chainId === other.chainId,
          );
          if (!trunkRange || !includesRange(trunkRange.positions, other.positions))
            continue;
          if (
            !pathCoversRange(chainById.get(paired.chainId), paired.positions, pathNodes)
          )
            continue;
          covered.set(candidate.id, {
            partId: candidate.id,
            branchId: branch.id,
            throughId: through.id,
            connectorSourceWayIds: connector.sourceWayIds,
            sourceRanges: candidate.sourceRanges,
          });
        }
      }
    }
  }
  return [...covered.values()].filter(
    (entry) => !covered.has(entry.branchId) && !covered.has(entry.throughId),
  );
}
