import {
  metadataSchema,
  stationCollectionSchema,
  type Metadata,
  type Mode,
  type StationCollection,
} from './domain.js';
import { fetchParsed } from './parse.js';
import { transitCoverageArea } from './transit-coverage.js';

export interface TransitAreaData {
  readonly stations: StationCollection;
  readonly metadata: Metadata;
  readonly coverageAreaSquareMeters: number;
}

/** A single shared load for the entire atlas. Camera movement and focus changes
 * never replace or refetch its datasets. Failed loads can be retried.
 */
export function createTransitAtlasLoader<Key extends string>(
  areas: Readonly<
    Record<Key, { readonly stations: string; readonly metadata: string }>
  >,
  keys: readonly Key[],
): () => Promise<Map<Key, TransitAreaData>> {
  let pending: Promise<Map<Key, TransitAreaData>> | null = null;
  return () => {
    pending ??= Promise.all(
      keys.map(async (key): Promise<[Key, TransitAreaData]> => {
        const [collection, metadata] = await Promise.all([
          fetchParsed(areas[key].stations, stationCollectionSchema),
          fetchParsed(areas[key].metadata, metadataSchema),
        ]);
        const stations = collection;
        for (const station of stations.features) station.properties['area_key'] = key;
        return [
          key,
          {
            stations,
            metadata,
            coverageAreaSquareMeters: transitCoverageArea(stations.features),
          },
        ];
      }),
    )
      .then((entries) => new Map(entries))
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  };
}

export function atlasStationMetadata(stations: StationCollection): Metadata {
  const open: Partial<Record<Mode, number>> = {};
  const future: Partial<Record<Mode, number>> = {};
  const all: Partial<Record<Mode, number>> = {};
  let openCount = 0;
  for (const { properties } of stations.features) {
    const counts = properties.status === 'open' ? open : future;
    counts[properties.mode] = (counts[properties.mode] ?? 0) + 1;
    all[properties.mode] = (all[properties.mode] ?? 0) + 1;
    if (properties.status === 'open') openCount += 1;
  }
  return {
    city: 'All metro networks',
    bbox: { west: -180, east: 180, south: -85, north: 85 },
    max_distance_m: 5_000,
    station_count: stations.features.length,
    open_station_count: openCount,
    future_station_count: stations.features.length - openCount,
    station_modes: all,
    station_modes_open: open,
    station_modes_future: future,
  };
}
