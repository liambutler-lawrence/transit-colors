import { geodesicDistanceMeters as distance } from './wgs84-geodesy.mjs';

// A source junction may be the shared end of several paired source intervals.
// Keep those representations interchangeable without joining nearby geometry.
export function rampAttachmentAliases(parts) {
  const byKey = new Map();
  const terminals = parts.map((part, partIndex) =>
    [false, true].map((atEnd) => {
      const entry = {
        partIndex,
        coordinate: atEnd ? part.coordinates.at(-1) : part.coordinates[0],
        segmentIndex: atEnd ? part.coordinates.length - 2 : 0,
        atEnd,
        keys: part[atEnd ? 'endTopologyKeys' : 'startTopologyKeys'] ?? [],
      };
      for (const key of entry.keys) {
        const entries = byKey.get(key) ?? [];
        entries.push(entry);
        byKey.set(key, entries);
      }
      return entry;
    }),
  );
  const lengths = new Map();
  return (attachment) => {
    const candidates = new Map([[attachment.partIndex, attachment]]);
    for (const terminal of terminals[attachment.partIndex] ?? []) {
      if (distance(terminal.coordinate, attachment.coordinate) > 0.25) continue;
      for (const key of terminal.keys)
        for (const other of byKey.get(key) ?? []) {
          if (
            candidates.has(other.partIndex) ||
            distance(other.coordinate, attachment.coordinate) > 0.25
          )
            continue;
          const points = parts[other.partIndex].coordinates;
          if (!lengths.has(other.partIndex))
            lengths.set(
              other.partIndex,
              points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0),
            );
          candidates.set(other.partIndex, {
            ...attachment,
            partIndex: other.partIndex,
            coordinate: other.coordinate,
            segmentIndex: other.segmentIndex,
            distanceAlongMeters: other.atEnd
              ? distance(points.at(-2), points.at(-1))
              : 0,
            distanceAlongPartMeters: other.atEnd ? lengths.get(other.partIndex) : 0,
          });
        }
    }
    return [...candidates.values()];
  };
}
