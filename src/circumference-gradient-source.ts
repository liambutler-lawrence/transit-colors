import type { ImageSourceSpecification } from 'maplibre-gl';

export type BoundsTuple = [number, number, number, number];

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
