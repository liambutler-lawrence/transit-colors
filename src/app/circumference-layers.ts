import { map } from './context.js';
import { expressionSpecificationSchema } from './types.js';

const featureLineOffset = expressionSpecificationSchema.parse([
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  ['get', 'line_offset_8'],
  12,
  ['get', 'line_offset_12'],
  15,
  ['get', 'line_offset_15'],
]);

export function installCircumferenceLayers(): void {
  map.addLayer({
    id: 'highway-circumference-area',
    type: 'fill',
    source: 'highway-circumference',
    filter: ['==', ['get', 'kind'], 'highway-inside'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#fff1d8',
      'fill-opacity': 0.34,
    },
  });

  map.addLayer({
    id: 'highway-circumference-network-casing',
    type: 'line',
    source: 'highway-network',
    'source-layer': 'highways',
    filter: ['==', ['get', 'role'], 'mainline'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.8, 7, 3.2, 12, 6],
      'line-opacity': 0.78,
    },
  });

  map.addLayer({
    id: 'highway-circumference-network-line',
    type: 'line',
    source: 'highway-network',
    'source-layer': 'highways',
    filter: ['==', ['get', 'role'], 'mainline'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#52616c',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.78, 7, 1.55, 12, 3],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.95,
        0.68,
      ],
    },
  });

  map.addLayer({
    id: 'highway-circumference-network-connector-casing',
    type: 'line',
    source: 'highway-network',
    'source-layer': 'highways',
    filter: ['==', ['get', 'role'], 'connector'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.8, 7, 3.2, 12, 6],
      'line-opacity': 0.84,
    },
  });

  map.addLayer({
    id: 'highway-circumference-network-connector-line',
    type: 'line',
    source: 'highway-network',
    'source-layer': 'highways',
    filter: ['==', ['get', 'role'], 'connector'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#c36c2f',
      'line-dasharray': [1.2, 1.4],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 7, 1.35, 12, 2.6],
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.84],
    },
  });

  map.addLayer({
    id: 'highway-circumference-route-casing',
    type: 'line',
    source: 'highway-circumference',
    filter: ['==', ['get', 'kind'], 'highway-route-mainline'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 5.8, 7, 8.5, 12, 14],
      'line-opacity': 0.96,
    },
  });

  map.addLayer({
    id: 'highway-circumference-route-line',
    type: 'line',
    source: 'highway-circumference',
    filter: ['==', ['get', 'kind'], 'highway-route-mainline'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#aa311f',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3.4, 7, 5.8, 12, 10],
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.94],
    },
  });

  map.addLayer({
    id: 'highway-circumference-route-connector-casing',
    type: 'line',
    source: 'highway-circumference',
    filter: ['==', ['get', 'kind'], 'highway-route-connector'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4.8, 7, 7.2, 12, 12],
      'line-opacity': 0.96,
    },
  });

  map.addLayer({
    id: 'highway-circumference-route-connector-line',
    type: 'line',
    source: 'highway-circumference',
    filter: ['==', ['get', 'kind'], 'highway-route-connector'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#d2692e',
      'line-dasharray': [1.4, 1.2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.8, 7, 4.8, 12, 8],
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.96],
    },
  });

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
      'line-offset': featureLineOffset,
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
      'line-offset': featureLineOffset,
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
    id: 'circumference-route-alternative-casing',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'segment-alternative'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#fffaf2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.8, 12, 5, 15, 7],
      'line-offset': featureLineOffset,
      'line-opacity': 0.82,
    },
  });

  map.addLayer({
    id: 'circumference-route-alternative-line',
    type: 'line',
    source: 'circumference-route',
    filter: ['==', ['get', 'kind'], 'segment-alternative'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 12, 2.8, 15, 4.6],
      'line-offset': featureLineOffset,
      'line-opacity': 0.78,
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
      'line-offset': featureLineOffset,
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
      'line-offset': featureLineOffset,
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
