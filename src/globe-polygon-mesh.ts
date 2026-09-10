import earcut, { flatten } from 'earcut';
import { unwrapLongitudeRing } from './longitude-ring.js';

const MAX_MERCATOR_LATITUDE = 85.051129;
// MapLibre's two-argument projectTile overload maps these vertices to the exact
// poles and clips them out when transitioning back to the flat map.
export const GLOBE_NORTH_POLE_Y = -32768;
export const GLOBE_SOUTH_POLE_Y = 32767;

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
  /** Mercator x/y (or pole sentinel), longitude triples for each triangle. */
  readonly coordinates: Float32Array;
}

function mercatorX(longitude: number): number {
  return (longitude + 180) / 360;
}

function mercatorY(latitude: number): number {
  if (latitude >= 90) return GLOBE_NORTH_POLE_Y;
  if (latitude <= -90) return GLOBE_SOUTH_POLE_Y;
  const radians = (latitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
}

function unwrapPolygon(polygon: PolygonCoordinates): Position[][] {
  const outerRing = polygon[0];
  if (!outerRing || outerRing.length === 0) return [];
  const unwrappedOuterRing = unwrapLongitudeRing(outerRing, outerRing[0]?.[0] ?? 0);
  const outerLongitudes = unwrappedOuterRing.map(([longitude]) => longitude);
  const outerCenter = (Math.min(...outerLongitudes) + Math.max(...outerLongitudes)) / 2;
  return [
    unwrappedOuterRing,
    ...polygon.slice(1).map((ring) => unwrapLongitudeRing(ring, outerCenter)),
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
  polar: boolean,
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
      for (const vertex of triangle) {
        output.push(
          vertex.x,
          polar ? mercatorY(90 - vertex.y * 360) : vertex.y,
          vertex.longitude,
        );
      }
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
    // Mercator is infinite at the poles. Subdivide polar polygons in angular
    // coordinates, then project each finished vertex, preserving the coastline
    // beyond 85 degrees and reaching the actual pole without an artificial cap.
    const polar = unwrappedPolygon.some((ring) =>
      ring.some(([, latitude]) => Math.abs(latitude) > MAX_MERCATOR_LATITUDE),
    );
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
          y: polar ? (90 - latitude) / 360 : mercatorY(latitude),
        };
      },
    );
    for (let index = 0; index < triangleIndices.length; index += 3) {
      const first = meshVertices[triangleIndices[index] ?? -1];
      const second = meshVertices[triangleIndices[index + 1] ?? -1];
      const third = meshVertices[triangleIndices[index + 2] ?? -1];
      if (!first || !second || !third) continue;
      appendSubdividedTriangle(output, first, second, third, maximumSpan, polar);
    }
  }
  return { coordinates: new Float32Array(output) };
}
