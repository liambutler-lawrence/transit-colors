import type { Coordinate } from './domain.js';
import type { Point } from './routing/types.js';

const EARTH_RADIUS_M = 6_371_008.8;

export const CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID = 'water';
export const CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE = 1024;

type BoundsTuple = [number, number, number, number];
type Color = [number, number, number];

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    if (!current || !previous) continue;
    if (
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) +
          current.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

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
 * Renders an outward distance field into a MapLibre canvas source. The optional
 * landmass rings are applied as one alpha mask so the texture terminates at
 * every touched coastline instead of selecting only the largest landmass.
 */
export function renderCircumferenceGradient(
  canvas: HTMLCanvasElement,
  routeCoordinates: readonly Coordinate[],
  bounds: BoundsTuple,
  landmassPolygons: readonly Coordinate[][][],
): void {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D rendering is unavailable.');
  const width = canvas.width;
  const height = canvas.height;
  const [west, south, east, north] = bounds;
  const referenceLatitude = (south + north) / 2;
  const metersPerLongitudeDegree =
    toRadians(1) * EARTH_RADIUS_M * Math.cos(toRadians(referenceLatitude));
  const metersPerLatitudeDegree = toRadians(1) * EARTH_RADIUS_M;
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
  const distanceScaleMeters = Math.max(
    20_000,
    Math.min(
      55_000,
      Math.hypot(
        (east - west) * metersPerLongitudeDegree,
        (north - south) * metersPerLatitudeDegree,
      ) * 0.32,
    ),
  );

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const latitude = north - ((pixelY + 0.5) / height) * (north - south);
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const longitude = west + ((pixelX + 0.5) / width) * (east - west);
      const point = project([longitude, latitude]);
      if (pointInPolygon(point, route)) continue;

      let distance = Number.POSITIVE_INFINITY;
      for (const segment of segments) {
        distance = Math.min(
          distance,
          pointToSegmentDistance(point, segment.start, segment.end),
        );
      }
      const amount = Math.min(1, distance / distanceScaleMeters);
      const [red, green, blue] = gradientColor(amount);
      const offset = (pixelY * width + pixelX) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = Math.round(116 - amount * 62);
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
