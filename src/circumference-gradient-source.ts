import type { ImageSourceSpecification } from 'maplibre-gl';

export type BoundsTuple = [number, number, number, number];

export const EMPTY_CIRCUMFERENCE_GRADIENT_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

type ImageCoordinates = ImageSourceSpecification['coordinates'];

export function circumferenceGradientCoordinates([
  west,
  south,
  east,
  north,
]: BoundsTuple): ImageCoordinates {
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

export function createCircumferenceGradientSource(
  url: string,
  bounds: BoundsTuple,
): ImageSourceSpecification {
  return {
    coordinates: circumferenceGradientCoordinates(bounds),
    type: 'image',
    url,
  };
}
