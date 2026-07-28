import type { Coordinate } from './domain.js';
import { metersPerDegreeAtLatitude } from './geodesy.js';
import type { BoundsTuple } from './circumference-gradient-source.js';
import type { Point } from './routing/types.js';

export const CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID = 'water';
export const CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE = 1024;
export const CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS = 10_000;
const CIRCUMFERENCE_GRADIENT_TRANSPARENT_PADDING_METERS = 500;

type Color = [number, number, number];

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (deltaX === 0 && deltaY === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const position = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        (deltaX ** 2 + deltaY ** 2),
    ),
  );
  return Math.hypot(
    point.x - (start.x + deltaX * position),
    point.y - (start.y + deltaY * position),
  );
}

function simplifyOpenLine(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return [];

  let maximumDistance = 0;
  let splitIndex = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (!point) continue;
    const distance = pointToSegmentDistance(point, first, last);
    if (distance > maximumDistance) {
      maximumDistance = distance;
      splitIndex = index;
    }
  }
  if (maximumDistance <= tolerance || splitIndex === -1) {
    return [first, last];
  }
  return [
    ...simplifyOpenLine(points.slice(0, splitIndex + 1), tolerance).slice(0, -1),
    ...simplifyOpenLine(points.slice(splitIndex), tolerance),
  ];
}

function simplifyClosedLine(points: readonly Point[], tolerance: number): Point[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return [];
  const ring =
    points.length > 2 && first.x === last.x && first.y === last.y
      ? points.slice(0, -1)
      : [...points];
  const ringFirst = ring[0];
  if (!ringFirst) return [];
  if (ring.length <= 3) return [...ring, ringFirst];

  let oppositeIndex = 1;
  let maximumDistance = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const point = ring[index];
    if (!point) continue;
    const distance = Math.hypot(point.x - ringFirst.x, point.y - ringFirst.y);
    if (distance > maximumDistance) {
      maximumDistance = distance;
      oppositeIndex = index;
    }
  }
  const firstHalf = simplifyOpenLine(ring.slice(0, oppositeIndex + 1), tolerance);
  const secondHalf = simplifyOpenLine(
    [...ring.slice(oppositeIndex), ringFirst],
    tolerance,
  );
  return [...firstHalf.slice(0, -1), ...secondHalf];
}

function blend(first: Color, second: Color, amount: number): Color {
  return [
    Math.round(first[0] + (second[0] - first[0]) * amount),
    Math.round(first[1] + (second[1] - first[1]) * amount),
    Math.round(first[2] + (second[2] - first[2]) * amount),
  ];
}

function gradientColor(amount: number): Color {
  const routeColor: Color = [238, 91, 56];
  const middleColor: Color = [241, 184, 67];
  const coastColor: Color = [23, 145, 135];
  return amount < 0.45
    ? blend(routeColor, middleColor, amount / 0.45)
    : blend(middleColor, coastColor, (amount - 0.45) / 0.55);
}

function canvasCoordinate(
  [longitude, latitude]: Coordinate,
  bounds: BoundsTuple,
  width: number,
  height: number,
): Coordinate {
  const [west, south, east, north] = bounds;
  return [
    ((longitude - west) / (east - west)) * width,
    ((north - latitude) / (north - south)) * height,
  ];
}

/**
 * Produces a route-relative texture envelope with a fully transparent border.
 * The image source remains finite, but the visible field has no rectangular
 * edge because every boundary lies beyond the 10 km fade distance.
 */
export function circumferenceGradientBounds(
  routeCoordinates: readonly Coordinate[],
  maxDistanceMeters = CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
): BoundsTuple {
  const first = routeCoordinates[0];
  if (!first) throw new Error('A route is required to position its gradient.');

  let west = first[0];
  let south = first[1];
  let east = first[0];
  let north = first[1];
  for (const [longitude, latitude] of routeCoordinates.slice(1)) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  const paddingMeters =
    maxDistanceMeters + CIRCUMFERENCE_GRADIENT_TRANSPARENT_PADDING_METERS;
  const southernScale = metersPerDegreeAtLatitude(south);
  const northernScale = metersPerDegreeAtLatitude(north);
  const latitudeScale = Math.min(southernScale.latitude, northernScale.latitude);
  const longitudeScale = Math.max(
    1,
    Math.min(southernScale.longitude, northernScale.longitude),
  );

  return [
    Math.max(-180, west - paddingMeters / longitudeScale),
    Math.max(-90, south - paddingMeters / latitudeScale),
    Math.min(180, east + paddingMeters / longitudeScale),
    Math.min(90, north + paddingMeters / latitudeScale),
  ];
}

export function circumferenceGradientOpacity(
  distanceMeters: number,
  maxDistanceMeters = CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
): number {
  if (distanceMeters >= maxDistanceMeters) return 0;
  const amount = Math.max(0, distanceMeters) / maxDistanceMeters;
  return Math.max(1, Math.round(116 * (1 - amount)));
}

/**
 * Renders an unsigned route-distance field into a MapLibre canvas source. The
 * optional land rings are applied as one alpha mask so the texture radiates
 * across nearby land on both sides of the route and terminates at every coast.
 */
export function renderCircumferenceGradient(
  canvas: HTMLCanvasElement,
  routeCoordinates: readonly Coordinate[],
  bounds: BoundsTuple,
  landmassPolygons: readonly Coordinate[][][],
  maxDistanceMeters = CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
): void {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D rendering is unavailable.');
  const width = canvas.width;
  const height = canvas.height;
  const [west, south, east, north] = bounds;
  const referenceLatitude = (south + north) / 2;
  const metricScale = metersPerDegreeAtLatitude(referenceLatitude);
  const metersPerLongitudeDegree = metricScale.longitude;
  const metersPerLatitudeDegree = metricScale.latitude;
  const project = ([longitude, latitude]: Coordinate): Point => ({
    x: (longitude - west) * metersPerLongitudeDegree,
    y: (latitude - south) * metersPerLatitudeDegree,
  });
  const route = simplifyClosedLine(
    routeCoordinates.map(project),
    Math.max(
      ((east - west) * metersPerLongitudeDegree) / width,
      ((north - south) * metersPerLatitudeDegree) / height,
    ) * 0.65,
  );
  const segments = route.slice(1).flatMap((end, index) => {
    const start = route[index];
    return start ? [{ end, start }] : [];
  });
  const image = context.createImageData(width, height);

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const latitude = north - ((pixelY + 0.5) / height) * (north - south);
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const longitude = west + ((pixelX + 0.5) / width) * (east - west);
      const point = project([longitude, latitude]);

      let distance = Number.POSITIVE_INFINITY;
      for (const segment of segments) {
        distance = Math.min(
          distance,
          pointToSegmentDistance(point, segment.start, segment.end),
        );
      }
      const opacity = circumferenceGradientOpacity(distance, maxDistanceMeters);
      if (opacity === 0) continue;
      const amount = Math.min(1, distance / maxDistanceMeters);
      const [red, green, blue] = gradientColor(amount);
      const offset = (pixelY * width + pixelX) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = opacity;
    }
  }

  context.clearRect(0, 0, width, height);
  context.putImageData(image, 0, 0);

  if (landmassPolygons.length > 0) {
    context.save();
    context.globalCompositeOperation = 'destination-in';
    context.beginPath();
    for (const polygon of landmassPolygons) {
      for (const ring of polygon) {
        for (const [index, coordinate] of ring.entries()) {
          const [x, y] = canvasCoordinate(coordinate, bounds, width, height);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
      }
    }
    context.fill('evenodd');
    context.restore();
  }
}
