import { Popup } from 'maplibre-gl';
import { z } from 'zod';
import seatsData from '../../data/north-america-government-seats.json';
import circlesUrl from '../../data/north-america-government-seats.geojson?url';
import connectionsUrl from '../../data/north-america-government-connections.geojson?url';
import connectionStatuses from '../../data/north-america-government-connection-status.json';
import { map } from './context.js';

const connectionRecords = z
  .array(
    z.object({
      id: z.string(),
      status: z.enum([
        'connected',
        'already-reached',
        'not-traversed',
        'no-eligible-connection',
      ]),
      lengthMeters: z.number().nonnegative().optional(),
    }),
  )
  .parse(connectionStatuses);
const SOURCE = 'highway-government-seats';
const LAYERS = {
  fill: 'government-seat-fill',
  ring: 'government-seat-ring',
  marker: 'government-seat-marker',
  label: 'government-seat-label',
  routeCasing: 'government-seat-route-casing',
  route: 'government-seat-route',
  rampCasing: 'government-seat-ramp-casing',
  ramp: 'government-seat-ramp',
};
const toggle = document.querySelector<HTMLInputElement>('#toggle-government-seats');
const controls = document.querySelector<HTMLElement>('#government-seat-controls');
const toggleLabel = document.querySelector<HTMLElement>(
  '#government-seat-toggle-label',
);
const select = document.querySelector<HTMLSelectElement>('#government-seat-select');
let active = false;
let installed = false;
let popup: Popup | null = null;

type Seat = (typeof seatsData.seats)[number];

function seatPosition(seat: Seat): [number, number] {
  const [longitude, latitude] = seat.coordinates;
  if (longitude === undefined || latitude === undefined)
    throw new Error(`Missing coordinates for ${seat.id}`);
  return [longitude, latitude];
}

function showSeat(seat: Seat, anchor: [number, number] = seatPosition(seat)): void {
  popup?.remove();
  const content = document.createElement('div');
  content.className = 'government-seat-popup';
  const heading = document.createElement('strong');
  heading.textContent = seat.building;
  const place = document.createElement('p');
  place.textContent = `${seat.subdivision} · ${seat.country}`;
  const description = document.createElement('p');
  description.textContent = `${seat.role}. Circle: 10 km diameter (5 km radius).`;
  content.append(heading, place, description);
  const connection = connectionRecords.find((entry) => entry.id === seat.id);
  if (connection) {
    const status = document.createElement('p');
    status.textContent =
      connection.status === 'connected'
        ? `${((connection.lengthMeters ?? 0) / 1000).toFixed(1)} km freeway connection to the circle edge. Both directions of the circumference are served at the same interchange.`
        : connection.status === 'already-reached'
          ? 'The circumference already reaches this circle.'
          : connection.status === 'not-traversed'
            ? 'The circumference does not pass through this subdivision.'
            : 'No qualifying freeway connection with access to both circumference directions was found in the road dataset.';
    content.append(status);
  }
  if (seat.note) {
    const note = document.createElement('p');
    note.textContent = seat.note;
    content.append(note);
  }
  for (const { label, url } of [
    { label: 'Building source', url: seat.sourceUrl },
    { label: 'Location source', url: seat.coordinateSourceUrl },
  ]) {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    content.append(link, document.createTextNode(' · '));
  }
  const checked = document.createElement('p');
  checked.className = 'government-seat-checked';
  checked.textContent = `Dataset reviewed ${seatsData.reviewedAt}`;
  content.append(checked);
  popup = new Popup({ maxWidth: '320px', offset: 10 })
    .setLngLat(anchor)
    .setDOMContent(content)
    .addTo(map);
}

function install(): void {
  if (installed) return;
  installed = true;
  map.addSource('highway-government-connections', {
    type: 'geojson',
    data: connectionsUrl,
    attribution: 'Freeway connections: © OpenStreetMap contributors',
  });
  const routeLayers = [
    { role: 'mainline', casingId: LAYERS.routeCasing, lineId: LAYERS.route },
    { role: 'connector', casingId: LAYERS.rampCasing, lineId: LAYERS.ramp },
  ];
  for (const { role, casingId, lineId } of routeLayers) {
    const ramp = role === 'connector';
    map.addLayer({
      id: casingId,
      type: 'line',
      source: 'highway-government-connections',
      filter: ['==', ['get', 'role'], role],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fffaf2',
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          3,
          ramp ? 4.8 : 5.8,
          7,
          ramp ? 7.2 : 8.5,
          12,
          ramp ? 12 : 14,
        ],
        'line-opacity': 0.96,
      },
    });
    map.addLayer({
      id: lineId,
      type: 'line',
      source: 'highway-government-connections',
      filter: ['==', ['get', 'role'], role],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#0878b8',
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          3,
          ramp ? 2.8 : 3.4,
          7,
          ramp ? 4.8 : 5.8,
          12,
          ramp ? 8 : 10,
        ],
        'line-opacity': 0.96,
        ...(ramp ? { 'line-dasharray': [1.4, 1.2] } : {}),
      },
    });
    map.on('click', lineId, (event) => {
      const id: unknown = event.features?.[0]?.properties['id'];
      const seat = seatsData.seats.find((entry) => entry.id === id);
      if (seat) showSeat(seat, event.lngLat.toArray());
    });
  }
  map.addSource(SOURCE, {
    type: 'geojson',
    data: circlesUrl,
    attribution:
      'Government seats: <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> / <a href="https://en.wikipedia.org/">Wikipedia contributors</a>',
  });
  map.addLayer({
    id: LAYERS.fill,
    type: 'fill',
    source: SOURCE,
    filter: ['==', ['geometry-type'], 'Polygon'],
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#177bba', 'fill-opacity': 0.07 },
  });
  map.addLayer({
    id: LAYERS.ring,
    type: 'line',
    source: SOURCE,
    filter: ['==', ['geometry-type'], 'Polygon'],
    layout: { visibility: 'none' },
    paint: { 'line-color': '#0878b8', 'line-width': 1.7, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: LAYERS.marker,
    type: 'circle',
    source: SOURCE,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#0878b8',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 10, 6],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: LAYERS.label,
    type: 'symbol',
    source: SOURCE,
    minzoom: 6,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'subdivision'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-anchor': 'top',
      'text-offset': [0, 0.9],
    },
    paint: { 'text-color': '#075783', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.on('click', LAYERS.marker, (event) => {
    const id: unknown = event.features?.[0]?.properties['id'];
    const seat = seatsData.seats.find((entry) => entry.id === id);
    if (seat) showSeat(seat, event.lngLat.toArray());
  });
  map.on('mouseenter', LAYERS.marker, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', LAYERS.marker, () => {
    map.getCanvas().style.cursor = '';
  });
}

export function syncGovernmentSeats(highwayMode: boolean): void {
  active = highwayMode;
  if (controls) controls.hidden = !active;
  if (toggleLabel) toggleLabel.hidden = !active;
  const visible = active && (toggle?.checked ?? true);
  if (visible && map.getLayer('highway-circumference-route-line')) install();
  for (const layer of Object.values(LAYERS)) {
    if (map.getLayer(layer))
      map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
  }
  if (!visible) popup?.remove();
}

toggle?.addEventListener('change', () => {
  syncGovernmentSeats(active);
});
if (select) {
  for (const country of ['Canada', 'United States', 'Mexico']) {
    const group = document.createElement('optgroup');
    group.label = country;
    for (const seat of seatsData.seats
      .filter((seat) => seat.country === country)
      .sort((a, b) => a.subdivision.localeCompare(b.subdivision))) {
      const option = document.createElement('option');
      option.value = seat.id;
      option.textContent = seat.subdivision;
      group.append(option);
    }
    select.append(group);
  }
  select.addEventListener('change', () => {
    const seat = seatsData.seats.find((entry) => entry.id === select.value);
    if (!seat || !active) return;
    if (toggle) toggle.checked = true;
    syncGovernmentSeats(active);
    const [longitude, latitude] = seatPosition(seat);
    // View bounds only; the rendered circles use precomputed WGS84 geometry.
    const latitudePadding = 5000 / 110000;
    const longitudePadding = latitudePadding / Math.cos((latitude * Math.PI) / 180);
    map.fitBounds(
      [
        [longitude - longitudePadding, latitude - latitudePadding],
        [longitude + longitudePadding, latitude + latitudePadding],
      ],
      { padding: 60, maxZoom: 13, duration: 650 },
    );
    showSeat(seat);
  });
}
