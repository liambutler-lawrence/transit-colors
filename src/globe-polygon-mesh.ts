import earcut, { flatten } from 'earcut';

const MAX_MERCATOR_LATITUDE = 85.051129;

// MapLibre subdivides globe fills into an effective 128 × 128 world grid.
// Custom layers do not receive that subdivision automatically, so keep our
// triangles at the same maximum scale before the nonlinear globe projection.
export const GLOBE_MESH_MAX_MERCATOR_SPAN = 1 / 128;

type Position = readonly [number, number];
type LinearRing = readonly Position[];
type PolygonCoordinates = readonly LinearRing[];

interface MeshVertex {
  readonly longitude: number;
  readonly x: number;
  readonly y: number;
}

export interface GlobePolygonMesh {
  /** Repeated x, y, unwrapped-longitude triples for non-indexed triangles. */
  readonly coordinates: Float32Array;
}

function mercatorX(longitude: number): number {
  return (longitude + 180) / 360;
}

function mercatorY(latitude: number): number {
  const clampedLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude),
  );
  const radians = (clampedLatitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
}

function longitudeNearest(longitude: number, reference: number): number {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

function unwrapRing(ring: LinearRing, firstReference: number): Position[] {
  if (ring.length === 0) return [];
  let previousLongitude = longitudeNearest(ring[0]?.[0] ?? 0, firstReference);
  return ring.map(([longitude, latitude], index) => {
    if (index > 0) {
      previousLongitude = longitudeNearest(longitude, previousLongitude);
    }
    return [previousLongitude, latitude];
  });
}

function unwrapPolygon(polygon: PolygonCoordinates): Position[][] {
  const outerRing = polygon[0];
  if (!outerRing || outerRing.length === 0) return [];
  const unwrappedOuterRing = unwrapRing(outerRing, outerRing[0]?.[0] ?? 0);
  const outerLongitudes = unwrappedOuterRing.map(([longitude]) => longitude);
  const outerCenter = (Math.min(...outerLongitudes) + Math.max(...outerLongitudes)) / 2;
  return [
    unwrappedOuterRing,
    ...polygon.slice(1).map((ring) => unwrapRing(ring, outerCenter)),
  ];
}

function edgeSpan(left: MeshVertex, right: MeshVertex): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function midpoint(left: MeshVertex, right: MeshVertex): MeshVertex {
  return {
    longitude: (left.longitude + right.longitude) / 2,
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

function appendSubdividedTriangle(
  output: number[],
  first: MeshVertex,
  second: MeshVertex,
  third: MeshVertex,
  maximumSpan: number,
): void {
  const stack: (readonly [MeshVertex, MeshVertex, MeshVertex])[] = [
    [first, second, third],
  ];
  while (stack.length > 0) {
    const triangle = stack.pop();
    if (!triangle) continue;
    const [a, b, c] = triangle;
    const spans = [edgeSpan(a, b), edgeSpan(b, c), edgeSpan(c, a)];
    const largestSpan = Math.max(...spans);
    if (largestSpan <= maximumSpan) {
      output.push(a.x, a.y, a.longitude, b.x, b.y, b.longitude, c.x, c.y, c.longitude);
      continue;
    }
    const edgeIndex = spans.indexOf(largestSpan);
    if (edgeIndex === 0) {
      const middle = midpoint(a, b);
      stack.push([a, middle, c], [middle, b, c]);
    } else if (edgeIndex === 1) {
      const middle = midpoint(b, c);
      stack.push([a, b, middle], [a, middle, c]);
    } else {
      const middle = midpoint(c, a);
      stack.push([a, b, middle], [middle, b, c]);
    }
  }
}

export function triangulateGlobePolygons(
  polygons: readonly PolygonCoordinates[],
  maximumSpan = GLOBE_MESH_MAX_MERCATOR_SPAN,
): GlobePolygonMesh {
  if (!(maximumSpan > 0)) throw new Error('Globe mesh span must be positive');
  const output: number[] = [];
  for (const polygon of polygons) {
    const unwrappedPolygon = unwrapPolygon(polygon);
    if (unwrappedPolygon.length === 0) continue;
    const flattened = flatten(unwrappedPolygon);
    const triangleIndices = earcut(
      flattened.vertices,
      flattened.holes,
      flattened.dimensions,
    );
    const meshVertices = Array.from(
      { length: flattened.vertices.length / flattened.dimensions },
      (_, index): MeshVertex => {
        const coordinateIndex = index * flattened.dimensions;
        const longitude = flattened.vertices[coordinateIndex] ?? 0;
        const latitude = flattened.vertices[coordinateIndex + 1] ?? 0;
        return {
          longitude,
          x: mercatorX(longitude),
          y: mercatorY(latitude),
        };
      },
    );
    for (let index = 0; index < triangleIndices.length; index += 3) {
      const first = meshVertices[triangleIndices[index] ?? -1];
      const second = meshVertices[triangleIndices[index + 1] ?? -1];
      const third = meshVertices[triangleIndices[index + 2] ?? -1];
      if (!first || !second || !third) continue;
      appendSubdividedTriangle(output, first, second, third, maximumSpan);
    }
  }
  return { coordinates: new Float32Array(output) };
}
