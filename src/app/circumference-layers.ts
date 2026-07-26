import { map } from './context.js';
import { expressionSpecificationSchema } from './types.js';

const routeLineOffset = expressionSpecificationSchema.parse([
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  ['*', ['get', 'line_position'], 3.2],
  12,
  ['*', ['get', 'line_position'], 5.2],
  15,
  ['*', ['get', 'line_position'], 7.5],
]);

const networkLineOffset = expressionSpecificationSchema.parse([
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  ['*', ['get', 'line_position'], 1.8],
  12,
  ['*', ['get', 'line_position'], 3.2],
  15,
  ['*', ['get', 'line_position'], 5.2],
]);

export function installCircumferenceLayers(): void {
  map.addLayer({
    id: 'circumference-area',
    type: 'fill',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'inside'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#fff4df',
      'fill-opacity': 0.46,
    },
  });

  map.addLayer({
    id: 'circumference-network-casing',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'network-segment'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.8, 12, 5, 15, 7],
      'line-offset': networkLineOffset,
      'line-opacity': 0.68,
    },
  });

  map.addLayer({
    id: 'circumference-network-line',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'network-segment'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 12, 2.8, 15, 4.6],
      'line-offset': networkLineOffset,
      'line-opacity': 0.68,
    },
  });

  map.addLayer({
    id: 'circumference-network-transfer-line',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'network-transfer'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#6f625b',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 12, 2, 15, 3.2],
      'line-dasharray': [1, 1.6],
      'line-opacity': 0.62,
    },
  });

  map.addLayer({
    id: 'circumference-network-stations',
    type: 'circle',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'network-station'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#fffdf8',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 12, 3.5, 15, 5],
      'circle-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'circumference-network-labels',
    type: 'symbol',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'network-station'],
    minzoom: 11.8,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'label'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11.8, 9, 15, 11],
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: {
      'text-color': '#3f2a24',
      'text-halo-color': '#fffaf2',
      'text-halo-width': 1.3,
      'text-opacity': 0.78,
    },
  });

  map.addLayer({
    id: 'circumference-route-casing',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'segment'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5.5, 12, 9, 15, 13],
      'line-offset': routeLineOffset,
      'line-opacity': 0.94,
    },
  });

  map.addLayer({
    id: 'circumference-route-line',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'segment'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 6, 15, 10],
      'line-offset': routeLineOffset,
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.92],
      'line-blur': 0.05,
    },
  });

  map.addLayer({
    id: 'circumference-transfer-line',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'transfer'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#5e271f',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 12, 4, 15, 7],
      'line-dasharray': [1, 1.3],
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.9],
    },
  });

  map.addLayer({
    id: 'circumference-route-stations',
    type: 'circle',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'station'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fffaf2',
      'circle-stroke-width': 2,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.6, 12, 5.2],
    },
  });

  map.addLayer({
    id: 'circumference-route-labels',
    type: 'symbol',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'station'],
    minzoom: 10.6,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'label'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10.6, 10, 14, 12],
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: {
      'text-color': '#5e271f',
      'text-halo-color': '#fffaf2',
      'text-halo-width': 1.4,
    },
  });
}
