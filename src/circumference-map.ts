import type { Coordinate } from './domain.js';
import { metersPerDegreeAtLatitude } from './geodesy.js';
import type { BoundsTuple } from './circumference-gradient-source.js';
import type { Point } from './routing/types.js';
import type { GradientView } from './gradient-render-protocol.js';
import { RouteDistanceIndex } from './route-distance-index.js';

export const CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID = 'water';
export const CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE = 1024;
export const CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS = 10_000;
const CIRCUMFERENCE_GRADIENT_TRANSPARENT_PADDING_METERS = 500;

type Color = [number, number, number];

const MERCATOR_RADIUS_METERS = 6_378_137;
const MAX_MERCATOR_LATITUDE = 85.051129;
const routeIndexes = new WeakMap<readonly Coordinate[], RouteDistanceIndex>();

type GradientContext = Pick<
  CanvasRenderingContext2D,
  | 'createImageData'
  | 'getImageData'
  | 'putImageData'
  | 'clearRect'
  | 'fillRect'
  | 'fillStyle'
  | 'save'
  | 'restore'
  | 'globalCompositeOperation'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
>;
interface GradientCanvas {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d', options: { readonly alpha: boolean }): GradientContext | null;
}

function mercatorY(latitude: number): number {
  const radians =
    (Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude)) *
      Math.PI) /
    180;
  return MERCATOR_RADIUS_METERS * Math.asinh(Math.tan(radians));
}

function latitudeFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(y / MERCATOR_RADIUS_METERS)) * 180) / Math.PI;
}

function project([longitude, latitude]: Coordinate): Point {
  return {
    x: ((longitude * Math.PI) / 180) * MERCATOR_RADIUS_METERS,
    y: mercatorY(latitude),
  };
}

/** 10 km per decade of enclosed square kilometers, continuous down to zero. */
export function circumferenceGradientDistanceForArea(areaSquareMeters: number): number {
  if (!Number.isFinite(areaSquareMeters) || areaSquareMeters < 0) {
    throw new Error('Gradient area must be finite and nonnegative.');
  }
  return 10_000 * Math.log10(1 + areaSquareMeters / 1_000_000);
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

export function circumferenceGradientCanvasCoordinate(
  [longitude, latitude]: Coordinate,
  bounds: BoundsTuple,
  width: number,
  height: number,
): Coordinate {
  const [west, south, east, north] = bounds;
  return [
    ((longitude - west) / (east - west)) * width,
    ((mercatorY(north) - mercatorY(latitude)) / (mercatorY(north) - mercatorY(south))) *
      height,
  ];
}

/**
 * Produces a route-relative texture envelope with a fully transparent border.
 * The image source remains finite, but the visible field has no rectangular
 * edge because every boundary lies beyond the selected fade distance.
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
    Math.max(-MAX_MERCATOR_LATITUDE, south - paddingMeters / latitudeScale),
    Math.min(180, east + paddingMeters / longitudeScale),
    Math.min(MAX_MERCATOR_LATITUDE, north + paddingMeters / latitudeScale),
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

/** Crop the texture to the visible region so close zooms retain boundary detail. */
export function circumferenceGradientViewportBounds(
  envelope: BoundsTuple,
  viewport: BoundsTuple,
  padding = 0.2,
): BoundsTuple | null {
  const [west, south, east, north] = viewport;
  const xPadding = (east - west) * padding;
  const yPadding = (mercatorY(north) - mercatorY(south)) * padding;
  const bounds: BoundsTuple = [
    Math.max(envelope[0], west - xPadding),
    Math.max(envelope[1], latitudeFromMercatorY(mercatorY(south) - yPadding)),
    Math.min(envelope[2], east + xPadding),
    Math.min(envelope[3], latitudeFromMercatorY(mercatorY(north) + yPadding)),
  ];
  return bounds[0] < bounds[2] && bounds[1] < bounds[3] ? bounds : null;
}

/**
 * Render in the same Web Mercator coordinates as the image source. Ground
 * distance uses the local latitude scale, including across continental bounds.
 * The optional outside-only mask leaves the full interior to the polygon fill.
 */
function* circumferenceGradientSteps(
  canvas: GradientCanvas,
  routeCoordinates: readonly Coordinate[],
  bounds: BoundsTuple,
  landmassPolygons: readonly Coordinate[][][],
  maxDistanceMeters = CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
  outsideOnly = false,
): Generator<void, void> {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D rendering is unavailable.');
  const width = canvas.width;
  const height = canvas.height;
  const [west, south, east, north] = bounds;
  const northY = mercatorY(north);
  const southY = mercatorY(south);
  let routeIndex = routeIndexes.get(routeCoordinates);
  if (!routeIndex) {
    routeIndex = new RouteDistanceIndex(routeCoordinates.map(project));
    routeIndexes.set(routeCoordinates, routeIndex);
  }
  const image = context.createImageData(width, height);
  const masked = landmassPolygons.length > 0 || outsideOnly;
  let mask: Uint8ClampedArray<ArrayBufferLike> | null = null;
  if (masked) {
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    if (landmassPolygons.length > 0) {
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.beginPath();
      for (const polygon of landmassPolygons) {
        for (const ring of polygon) {
          for (const [index, coordinate] of ring.entries()) {
            const [x, y] = circumferenceGradientCanvasCoordinate(
              coordinate,
              bounds,
              width,
              height,
            );
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.closePath();
        }
      }
      context.fill('evenodd');
      context.restore();
    }
    if (outsideOnly) {
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.beginPath();
      for (const [index, coordinate] of routeCoordinates.entries()) {
        const [x, y] = circumferenceGradientCanvasCoordinate(
          coordinate,
          bounds,
          width,
          height,
        );
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill('evenodd');
      context.restore();
    }
    mask = context.getImageData(0, 0, width, height).data;
  }

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const y = northY - ((pixelY + 0.5) / height) * (northY - southY);
    const latitude = latitudeFromMercatorY(y);
    const groundScale =
      metersPerDegreeAtLatitude(latitude).longitude /
      ((Math.PI / 180) * MERCATOR_RADIUS_METERS);
    const projectedLimit = maxDistanceMeters / groundScale;
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const offset = (pixelY * width + pixelX) * 4;
      const maskAlpha = mask ? (mask[offset + 3] ?? 0) : 255;
      if (maskAlpha === 0) continue;
      const longitude = west + ((pixelX + 0.5) / width) * (east - west);
      const point = { x: ((longitude * Math.PI) / 180) * MERCATOR_RADIUS_METERS, y };
      const projectedDistance = routeIndex.distance(point, projectedLimit);
      // Keep rounding at the search cutoff from exposing a faint texture edge.
      if (projectedDistance >= projectedLimit) continue;
      const distance = projectedDistance * groundScale;
      const opacity = circumferenceGradientOpacity(distance, maxDistanceMeters);
      if (opacity === 0) continue;
      const amount = Math.min(1, distance / maxDistanceMeters);
      const [red, green, blue] = gradientColor(amount);
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = Math.round((opacity * maskAlpha) / 255);
    }
    if (pixelY % 8 === 7) yield;
  }

  context.clearRect(0, 0, width, height);
  context.putImageData(image, 0, 0);
}

/** Reuse padded images only while they cover the view at adequate resolution. */
export function circumferenceGradientViewReusable(
  rendered: GradientView,
  requested: GradientView,
  visible: BoundsTuple,
): boolean {
  const [west, south, east, north] = rendered.bounds;
  const epsilon = 1e-9;
  return (
    west <= visible[0] + epsilon &&
    south <= visible[1] + epsilon &&
    east >= visible[2] - epsilon &&
    north >= visible[3] - epsilon &&
    (east - west) / rendered.width <=
      (1.25 * (requested.bounds[2] - requested.bounds[0])) / requested.width &&
    (mercatorY(north) - mercatorY(south)) / rendered.height <=
      (1.25 * (mercatorY(requested.bounds[3]) - mercatorY(requested.bounds[1]))) /
        requested.height
  );
}

/** Synchronous reference renderer used by offline checks. Browser code uses the worker. */
export function renderCircumferenceGradient(
  canvas: GradientCanvas,
  routeCoordinates: readonly Coordinate[],
  bounds: BoundsTuple,
  landmassPolygons: readonly Coordinate[][][],
  maxDistanceMeters = CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
  outsideOnly = false,
): void {
  const steps = circumferenceGradientSteps(
    canvas,
    routeCoordinates,
    bounds,
    landmassPolygons,
    maxDistanceMeters,
    outsideOnly,
  );
  while (!steps.next().done) {
    /* Complete the same pixels as the worker renderer. */
  }
}

/** Yield in the worker so obsolete viewport requests can be cancelled promptly. */
export async function renderCircumferenceGradientAsync(
  canvas: GradientCanvas,
  routeCoordinates: readonly Coordinate[],
  bounds: BoundsTuple,
  landmassPolygons: readonly Coordinate[][][],
  maxDistanceMeters: number,
  outsideOnly: boolean,
  cancelled: () => boolean,
): Promise<boolean> {
  const steps = circumferenceGradientSteps(
    canvas,
    routeCoordinates,
    bounds,
    landmassPolygons,
    maxDistanceMeters,
    outsideOnly,
  );
  let deadline = performance.now() + 8;
  while (!cancelled()) {
    if (steps.next().done) return true;
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      deadline = performance.now() + 8;
    }
  }
  steps.return(undefined);
  return false;
}
