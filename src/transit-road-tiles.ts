import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { fromVectorTileJs, type VectorTileFeatureLike } from '@maplibre/vt-pbf';
import type {
  AddProtocolAction,
  LayerSpecification,
  LineLayerSpecification,
} from 'maplibre-gl';
import Pbf from 'pbf';

import type { Coordinate, StationFeature, StreetFeature } from './domain.js';
import { createStreetAccessScorer } from './routing.js';
import type { StreetAccessScorer } from './routing/types.js';

export const ROAD_SOURCE = 'openmaptiles';
export const ROAD_SOURCE_LAYER = 'transportation';

export function isHeatmapRoadLayer(
  layer: LayerSpecification,
): layer is LineLayerSpecification {
  return (
    layer.type === 'line' &&
    layer.source === ROAD_SOURCE &&
    layer['source-layer'] === ROAD_SOURCE_LAYER &&
    /^(road|bridge|tunnel)_/.test(layer.id) &&
    !layer.id.includes('rail')
  );
}

type TilePoint = ReturnType<VectorTileFeature['loadGeometry']>[number][number];
type TilePosition = { readonly z: number; readonly x: number; readonly y: number };

function coordinate(point: TilePoint, tile: TilePosition, extent: number): Coordinate {
  const scale = 2 ** tile.z;
  const longitude = ((tile.x + point.x / extent) / scale) * 360 - 180;
  const mercatorY = Math.PI * (1 - (2 * (tile.y + point.y / extent)) / scale);
  return [longitude, (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI];
}

// Split inside the shared vector tile. Both the ordinary map and its heatmap
// therefore draw exactly the same vertices, tile clipping, and zoom hierarchy.
function splitLine(
  line: TilePoint[],
  maxLength: number,
  junctions: Set<string>,
): TilePoint[][] {
  const first = line[0];
  if (!first) return [];
  const segments: TilePoint[][] = [];
  let segment = [first];
  let length = 0;
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1];
    const end = line[index];
    if (!start || !end) continue;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / maxLength));
    for (let step = 1; step <= steps; step += 1) {
      const point = end.clone();
      point.x = Math.round(start.x + ((end.x - start.x) * step) / steps);
      point.y = Math.round(start.y + ((end.y - start.y) * step) / steps);
      const previous = segment[segment.length - 1];
      if (!previous || (previous.x === point.x && previous.y === point.y)) continue;
      segment.push(point);
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
      if (length >= maxLength || junctions.has(`${point.x},${point.y}`)) {
        segments.push(segment);
        segment = [point];
        length = 0;
      }
    }
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}

export async function scoreRoadTile(
  data: ArrayBuffer,
  position: TilePosition,
  scorer: StreetAccessScorer | null,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const tile = new VectorTile(new Pbf(data));
  const layer = tile.layers[ROAD_SOURCE_LAYER];
  if (!layer) return data;
  const originals = Array.from({ length: layer.length }, (_, index) =>
    layer.feature(index),
  );
  const junctions = new Set<string>();
  const seen = new Set<string>();
  for (const feature of originals) {
    if (
      feature.type !== 2 ||
      /^(rail|transit)$/.test(String(feature.properties['class']))
    )
      continue;
    for (const line of feature.loadGeometry()) {
      for (const point of line) {
        const key = `${point.x},${point.y}`;
        if (seen.has(key)) junctions.add(key);
        seen.add(key);
      }
    }
  }
  const features: VectorTileFeatureLike[] = [];
  const streets: StreetFeature[] = [];
  for (const feature of originals) {
    const roadClass = String(feature.properties['class'] ?? '');
    if (feature.type !== 2 || /^(rail|transit)$/.test(roadClass)) {
      features.push(feature);
      continue;
    }
    for (const line of feature.loadGeometry()) {
      const first = line[0];
      if (!first) continue;
      const latitude = coordinate(first, position, layer.extent)[1];
      const metersPerUnit =
        (40075016.686 * Math.cos((latitude * Math.PI) / 180)) /
        (2 ** position.z * layer.extent);
      // At world scale, cap subdivision at two screen pixels per segment.
      const maxLength = Math.max(16, (position.z < 12 ? 400 : 200) / metersPerUnit);
      for (const segment of splitLine(line, maxLength, junctions)) {
        const properties: Record<string, string | number | boolean> = {
          ...feature.properties,
          n: String(
            feature.properties['name'] ?? feature.properties['name:latin'] ?? '',
          ),
          h: roadClass,
          i: `${position.z}/${position.x}/${position.y}/${features.length}`,
          d: 5000,
        };
        features.push({
          type: 2,
          id: features.length,
          extent: layer.extent,
          properties,
          loadGeometry: () => [segment],
        });
        streets.push({
          type: 'Feature',
          properties,
          geometry: {
            type: 'LineString',
            coordinates: segment.map((point) =>
              coordinate(point, position, layer.extent),
            ),
          },
        });
      }
    }
  }
  signal?.throwIfAborted();
  if (scorer) {
    await scorer.scoreAsync(streets, {
      candidateCount: 5,
      batchSize: 500,
      yieldControl: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        signal?.throwIfAborted();
      },
    });
  }
  signal?.throwIfAborted();
  return fromVectorTileJs({
    layers: {
      ...tile.layers,
      [ROAD_SOURCE_LAYER]: {
        name: layer.name,
        version: layer.version,
        extent: layer.extent,
        length: features.length,
        feature: (index) => {
          const feature = features[index];
          if (!feature) throw new Error('Missing road tile feature');
          return feature;
        },
      },
    },
  }).slice().buffer;
}

export function createTransitRoadTiles(): {
  readonly load: AddProtocolAction;
  readonly urls: (templates: readonly string[]) => string[];
  readonly setStations: (stations: readonly StationFeature[]) => boolean;
} {
  let revision = 0;
  let stationKey = '';
  let scorer: StreetAccessScorer | null = null;
  const load: AddProtocolAction = async (request, controller) => {
    const url = request.url.replace(/^transit-roads:\/\/\d+\//, '');
    const match = /\/(\d+)\/(\d+)\/(\d+)\.pbf(?:\?.*)?$/.exec(url);
    if (!match) throw new Error('Invalid transit road tile URL');
    const tileScorer = scorer;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Road tile request failed: ${response.status}`);
    const data = await scoreRoadTile(
      await response.arrayBuffer(),
      {
        z: Number(match[1]),
        x: Number(match[2]),
        y: Number(match[3]),
      },
      tileScorer,
      controller.signal,
    );
    return { data };
  };
  return {
    load,
    urls: (templates) => templates.map((url) => `transit-roads://${revision}/${url}`),
    setStations: (stations) => {
      const nextKey = JSON.stringify(
        stations.map((station) => [
          station.properties.id,
          station.geometry.coordinates,
        ]),
      );
      if (stationKey === nextKey) return false;
      stationKey = nextKey;
      revision += 1;
      scorer = stations.length
        ? createStreetAccessScorer(stations, {
            exhaustive: true,
            stationFilter: () => true,
          })
        : null;
      return true;
    },
  };
}
