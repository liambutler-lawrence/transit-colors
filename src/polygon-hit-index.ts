type Position = readonly [number, number];
type LinearRing = readonly Position[];
type PolygonCoordinates = readonly LinearRing[];

export interface PolygonHitEntry<T> {
  readonly polygons: readonly PolygonCoordinates[];
  readonly value: T;
}

interface IndexedPolygon<T> {
  readonly maxLatitude: number;
  readonly maxLongitude: number;
  readonly minLatitude: number;
  readonly minLongitude: number;
  readonly rings: readonly LinearRing[];
  readonly value: T;
}

const CELL_SIZE = 10;
const LONGITUDE_CELLS = 360 / CELL_SIZE;
const LATITUDE_CELLS = 180 / CELL_SIZE;

function longitudeNearest(longitude: number, reference: number): number {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

function unwrapRing(ring: LinearRing, reference: number): Position[] {
  if (ring.length === 0) return [];
  let previousLongitude = longitudeNearest(ring[0]?.[0] ?? 0, reference);
  return ring.map(([longitude, latitude], index) => {
    if (index > 0) previousLongitude = longitudeNearest(longitude, previousLongitude);
    return [previousLongitude, latitude];
  });
}

function indexPolygon<T>(polygon: PolygonCoordinates, value: T): IndexedPolygon<T> {
  const outerRing = unwrapRing(polygon[0] ?? [], polygon[0]?.[0]?.[0] ?? 0);
  const longitudes = outerRing.map(([longitude]) => longitude);
  const latitudes = outerRing.map(([, latitude]) => latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const centerLongitude = (minLongitude + maxLongitude) / 2;
  return {
    minLongitude,
    maxLongitude,
    minLatitude: Math.min(...latitudes),
    maxLatitude: Math.max(...latitudes),
    rings: [
      outerRing,
      ...polygon.slice(1).map((ring) => unwrapRing(ring, centerLongitude)),
    ],
    value,
  };
}

function pointInRing(longitude: number, latitude: number, ring: LinearRing): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [x, y] = ring[index] ?? [0, 0];
    const [previousX, previousY] = ring[previous] ?? [0, 0];
    if (
      y > latitude !== previousY > latitude &&
      longitude < ((previousX - x) * (latitude - y)) / (previousY - y) + x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon<T>(
  longitude: number,
  latitude: number,
  polygon: IndexedPolygon<T>,
): boolean {
  const outerRing = polygon.rings[0];
  if (!outerRing || !pointInRing(longitude, latitude, outerRing)) return false;
  return polygon.rings
    .slice(1)
    .every((ring) => !pointInRing(longitude, latitude, ring));
}

function bucketKey(longitudeCell: number, latitudeCell: number): number {
  return latitudeCell * LONGITUDE_CELLS + longitudeCell;
}

function overlapsLongitudeCell<T>(
  polygon: IndexedPolygon<T>,
  cellMinimum: number,
): boolean {
  const cellMaximum = cellMinimum + CELL_SIZE;
  return [-360, 0, 360].some(
    (shift) =>
      polygon.minLongitude <= cellMaximum + shift &&
      polygon.maxLongitude >= cellMinimum + shift,
  );
}

export class PolygonHitIndex<T> {
  private readonly buckets = new Map<number, IndexedPolygon<T>[]>();

  constructor(entries: readonly PolygonHitEntry<T>[]) {
    for (const entry of entries) {
      for (const polygonCoordinates of entry.polygons) {
        const polygon = indexPolygon(polygonCoordinates, entry.value);
        const firstLatitudeCell = Math.max(
          0,
          Math.floor((polygon.minLatitude + 90) / CELL_SIZE),
        );
        const lastLatitudeCell = Math.min(
          LATITUDE_CELLS - 1,
          Math.floor((polygon.maxLatitude + 90) / CELL_SIZE),
        );
        for (
          let latitudeCell = firstLatitudeCell;
          latitudeCell <= lastLatitudeCell;
          latitudeCell += 1
        ) {
          for (
            let longitudeCell = 0;
            longitudeCell < LONGITUDE_CELLS;
            longitudeCell += 1
          ) {
            const cellMinimum = longitudeCell * CELL_SIZE - 180;
            if (!overlapsLongitudeCell(polygon, cellMinimum)) continue;
            const key = bucketKey(longitudeCell, latitudeCell);
            const bucket = this.buckets.get(key) ?? [];
            bucket.push(polygon);
            this.buckets.set(key, bucket);
          }
        }
      }
    }
  }

  find(
    longitude: number,
    latitude: number,
    predicate?: (value: T) => boolean,
  ): T | null {
    const normalizedLongitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
    const longitudeCell = Math.min(
      LONGITUDE_CELLS - 1,
      Math.floor((normalizedLongitude + 180) / CELL_SIZE),
    );
    const latitudeCell = Math.max(
      0,
      Math.min(
        LATITUDE_CELLS - 1,
        Math.floor((Math.max(-90, Math.min(90, latitude)) + 90) / CELL_SIZE),
      ),
    );
    const candidates = this.buckets.get(bucketKey(longitudeCell, latitudeCell)) ?? [];
    for (const polygon of candidates) {
      if (
        (predicate && !predicate(polygon.value)) ||
        latitude < polygon.minLatitude ||
        latitude > polygon.maxLatitude
      ) {
        continue;
      }
      for (const shiftedLongitude of [
        normalizedLongitude,
        normalizedLongitude - 360,
        normalizedLongitude + 360,
      ]) {
        if (
          shiftedLongitude >= polygon.minLongitude &&
          shiftedLongitude <= polygon.maxLongitude &&
          pointInPolygon(shiftedLongitude, latitude, polygon)
        ) {
          return polygon.value;
        }
      }
    }
    return null;
  }
}
