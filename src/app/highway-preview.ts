import { Popup } from 'maplibre-gl';
import type { HighwayCircumferenceSummary } from '../highway-circumference.js';
import { map } from './context.js';

const layers: readonly [string, string] = [
  'highway-preview-contacts',
  'highway-preview-interchanges',
];
export function installHighwayPreview(data: HighwayCircumferenceSummary): void {
  if (
    !import.meta.env.DEV ||
    !data.preview ||
    map.getSource('highway-preview-junctions')
  )
    return;
  map.addSource('highway-preview-junctions', {
    type: 'geojson',
    data: 'data/highway-preview-junctions.geojson',
    tolerance: 0,
  });
  const categories: readonly { id: string; kind: string; color: string }[] = [
    { id: layers[0], kind: 'geometric-contact', color: '#7c3aed' },
    { id: layers[1], kind: 'interchange-movement', color: '#db2580' },
  ];
  for (const { id, kind, color } of categories) {
    map.addLayer({
      id,
      type: 'circle',
      source: 'highway-preview-junctions',
      filter: ['==', ['get', 'kind'], kind],
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 10, 5, 15, 7],
        'circle-stroke-color': 'white',
        'circle-stroke-width': 1.5,
      },
    });
    map.on('click', id, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const p = feature.properties;
      const content = document.createElement('div');
      content.textContent = `Point ${p['number']} · ${kind === 'interchange-movement' ? 'Interchange conflict' : 'Geometric contact'} · ${p['occurrences']} forbidden turn(s). The unrestricted working boundary changes roads here without a legal connection.`;
      const [longitude, latitude] = feature.geometry.coordinates;
      if (typeof longitude !== 'number' || typeof latitude !== 'number') return;
      new Popup().setLngLat([longitude, latitude]).setDOMContent(content).addTo(map);
    });
  }
}

export function highwayPreviewControls(
  data: HighwayCircumferenceSummary,
): HTMLElement | null {
  if (!import.meta.env.DEV || !data.preview) return null;
  const controls = document.createElement('div');
  controls.dataset['highwayPreview'] = 'unrestricted';
  const categories: readonly {
    id: string;
    label: string;
    count: number;
    color: string;
  }[] = [
    {
      id: layers[1],
      label: 'interchange conflicts',
      count: data.preview.interchangeConflicts,
      color: '#db2580',
    },
    {
      id: layers[0],
      label: 'geometric contacts',
      count: data.preview.geometricContacts,
      color: '#7c3aed',
    },
  ];
  for (const { id, label, count, color } of categories) {
    const row = document.createElement('label'),
      input = document.createElement('input'),
      text = document.createElement('span');
    input.type = 'checkbox';
    input.checked = true;
    input.setAttribute('aria-label', `Show ${label}`);
    text.textContent = ` ${count} ${label}`;
    text.style.color = color;
    input.onchange = () => {
      if (map.getLayer(id))
        map.setLayoutProperty(id, 'visibility', input.checked ? 'visible' : 'none');
    };
    row.append(input, text);
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '6px';
    row.style.marginTop = '8px';
    controls.append(row);
  }
  return controls;
}

export function syncHighwayPreviewVisibility(visible: boolean): void {
  for (const id of layers)
    if (map.getLayer(id)) {
      const input = document.querySelector<HTMLInputElement>(
        `[data-highway-preview] input[aria-label="Show ${id.endsWith('contacts') ? 'geometric contacts' : 'interchange conflicts'}"]`,
      );
      map.setLayoutProperty(
        id,
        'visibility',
        visible && input?.checked !== false ? 'visible' : 'none',
      );
    }
}
