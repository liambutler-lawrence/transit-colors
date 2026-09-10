import {
  assignAutomaticTimezones,
  automaticTimezoneDataSchema,
  type AutomaticTimezoneAssignment,
} from '../automatic-timezones.js';
import { fetchParsed } from '../parse.js';
import { PolygonHitIndex } from '../polygon-hit-index.js';
import { formatUtcOffset } from '../timezone-seasons.js';
import {
  describeSolarNoonSkew,
  formatLongitude,
  formatSolarNoon,
  solarNoonSkewMinutes,
  type TimezoneSkewCollection,
} from '../timezone-skew.js';
import {
  map,
  requiredElement,
  runtime,
  timezoneBoundariesToggle,
  timezoneColorsToggle,
  timezoneMetadataEl,
  timezoneNameEl,
  timezoneSelectionTypeEl,
  timezoneSummaryEl,
} from './context.js';
import {
  firstSymbolLayerId,
  replaceMetadata,
  setLayerVisibility,
} from './map-ui-utils.js';
import { TimezoneSkewLayer, triangulateTimezoneData } from './timezone-skew-layer.js';

const rules = requiredElement('#timezone-rules', HTMLSelectElement);
const info = requiredElement('#timezone-automatic-info', HTMLElement);
const summary = requiredElement('#timezone-automatic-summary', HTMLElement);
const exceptions = requiredElement(
  '#timezone-automatic-exceptions',
  HTMLDetailsElement,
);
const exceptionSummary = requiredElement(
  '#timezone-automatic-exceptions-summary',
  HTMLElement,
);
const exceptionList = requiredElement(
  '#timezone-automatic-exceptions-list',
  HTMLElement,
);
const officialMethodNote = requiredElement('.timezone-method-note', HTMLElement);
const officialControls = ['history', 'season', 'simulator'].map((name) =>
  requiredElement(`#timezone-${name}-control`, HTMLFieldSetElement),
);
const FILL_ID = 'timezone-automatic-fill';
const BORDER_ID = 'timezone-automatic-borders';
let layer: TimezoneSkewLayer | null = null;
let hitIndex: PolygonHitIndex<AutomaticTimezoneAssignment> | null = null;
let loading: Promise<void> | null = null;
let installed = false;

export function automaticTimezoneActive(): boolean {
  return rules.value === 'automatic';
}

function fallbackDescription(assignment: AutomaticTimezoneAssignment): string {
  if (assignment.fallback === 'too-wide')
    return 'Second-level region still exceeds the strict ±60-minute limit; temporary UTC+0.';
  if (assignment.fallback === 'uncovered-area') return assignment.region.coverage_note;
  return 'No usable child subdivisions in the boundary sources; temporary UTC+0.';
}

function renderSummary(assignments: readonly AutomaticTimezoneAssignment[]): void {
  const strict = assignments.filter(({ fit }) => fit?.toleranceMinutes === 30).length;
  const relaxed = assignments.filter(({ fit }) => fit?.toleranceMinutes === 60).length;
  const fallbacks = assignments.filter(({ fallback }) => fallback);
  const tooWide = fallbacks.filter(({ fallback }) => fallback === 'too-wide').length;
  const gaps = fallbacks.filter(({ fallback }) => fallback === 'uncovered-area').length;
  const missing = fallbacks.length - tooWide - gaps;
  summary.textContent = `${strict} regions fit ±30 min; ${relaxed} fit ±60 min. ${tooWide} second-level regions use UTC+0 because they are still too wide. ${missing} regions lack usable subdivisions; ${gaps} boundary coverage gaps also use UTC+0.`;
  exceptions.hidden = fallbacks.length === 0;
  exceptionSummary.textContent = `UTC+0 exceptions (${fallbacks.length})`;
  exceptionList.replaceChildren(
    ...fallbacks
      .sort(
        (a, b) =>
          Number(a.fallback === 'uncovered-area') -
            Number(b.fallback === 'uncovered-area') ||
          a.region.country_name.localeCompare(b.region.country_name) ||
          a.region.name.localeCompare(b.region.name),
      )
      .map((assignment) => {
        const li = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = `${assignment.region.naming?.timezone_name ?? assignment.region.name} — ${assignment.region.country_name} / ${assignment.region.name}`;
        const reason = document.createElement('span');
        reason.className = 'timezone-country-change-regions';
        reason.textContent = fallbackDescription(assignment);
        li.append(title, reason);
        return li;
      }),
  );
}

async function loadAutomaticTimezones(): Promise<void> {
  if (layer) return;
  const data = await fetchParsed(
    'data/timezone-automatic-regions.json?v=20260910b',
    automaticTimezoneDataSchema,
  );
  const assignments = assignAutomaticTimezones(data.regions);
  const features: TimezoneSkewCollection['features'] = assignments.map(
    ({ region, offsetHours }, id) => ({
      type: 'Feature',
      id,
      geometry: region.geometry,
      properties: {
        id,
        timezone_name: region.naming?.timezone_name ?? region.id,
        offset_hours: offsetHours,
        offset_label: formatUtcOffset(offsetHours),
        places: region.name,
        dst_places: '',
      },
    }),
  );
  const mesh = triangulateTimezoneData({ features }, new Map());
  hitIndex = new PolygonHitIndex(
    assignments.map((assignment) => ({
      polygons: assignment.region.geometry.coordinates,
      value: assignment,
    })),
  );
  map.addSource('timezone-automatic-regions', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
    // Subpixel tile simplification keeps world-view lines inexpensive while
    // retaining detailed edges alongside the fill/hit polygons as users zoom in.
    tolerance: 0.1,
    maxzoom: 18,
    attribution:
      'Automatic regions: <a href="https://www.naturalearthdata.com/">Natural Earth</a> · <a href="https://www.geoboundaries.org/">geoBoundaries</a> / © OpenStreetMap contributors · <a href="https://www.inegi.org.mx/">INEGI</a> · <a href="https://www.statcan.gc.ca/">Statistics Canada</a> · Place names: <a href="https://www.geonames.org/">GeoNames</a>, CC BY 4.0',
  });
  layer = new TimezoneSkewLayer(mesh, FILL_ID);
  const before = map.getLayer('water') ? 'water' : firstSymbolLayerId();
  map.addLayer(layer, before);
  map.addLayer(
    {
      id: BORDER_ID,
      type: 'line',
      source: 'timezone-automatic-regions',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#8b4b20',
        'line-opacity': 0.8,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 5, 1.1],
      },
    },
    before,
  );
  renderSummary(assignments);
}

export function installAutomaticTimezoneControl(onChange: () => void): void {
  if (installed) return;
  installed = true;
  rules.disabled = false;
  rules.addEventListener('change', () => {
    const active = automaticTimezoneActive();
    info.hidden = !active;
    officialMethodNote.hidden = active;
    for (const control of officialControls) {
      control.disabled = active;
      control.hidden = active;
    }
    timezoneSelectionTypeEl.textContent = 'Nothing selected';
    timezoneNameEl.textContent = 'Move over a region';
    timezoneSummaryEl.textContent =
      'Hover or click colored land to inspect its UTC offset and solar noon.';
    timezoneMetadataEl.replaceChildren();
    onChange();
    if (!active) return;
    if (!loading) {
      summary.textContent = 'Loading boundaries and calculating automatic time zones…';
      loading = loadAutomaticTimezones().catch((error: unknown) => {
        loading = null;
        summary.textContent =
          'Automatic boundaries could not be loaded. Choose Official time zones, then Automatic to retry.';
        console.error('Automatic time zones failed to load', error);
      });
    }
    void loading.then(onChange);
  });
}

export function syncAutomaticTimezoneVisibility(): void {
  const active = runtime.activeProduct === 'timezone' && automaticTimezoneActive();
  layer?.setVisible(active && timezoneColorsToggle.checked);
  // Custom WebGL layers cannot reference a source. Keep the source-backed layer
  // active (with transparent lines) so its attribution survives hiding borders.
  setLayerVisibility(
    BORDER_ID,
    active && (timezoneColorsToggle.checked || timezoneBoundariesToggle.checked),
  );
  if (map.getLayer(BORDER_ID)) {
    map.setPaintProperty(
      BORDER_ID,
      'line-opacity',
      timezoneBoundariesToggle.checked ? 0.8 : 0,
    );
  }
}

export function positionAutomaticTimezoneLayers(before: string | undefined): void {
  for (const id of [FILL_ID, BORDER_ID])
    if (map.getLayer(id)) map.moveLayer(id, before);
}

export function inspectAutomaticTimezone(longitude: number, latitude: number): boolean {
  const assignment = hitIndex?.find(longitude, latitude);
  if (!assignment) return false;
  const { region, fit, offsetHours } = assignment;
  const skew = solarNoonSkewMinutes(longitude, offsetHours);
  timezoneSelectionTypeEl.textContent = assignment.fallback
    ? 'Automatic · UTC+0 fallback'
    : 'Automatic time zone';
  timezoneNameEl.textContent = `${region.naming?.timezone_name ?? region.name} · ${formatUtcOffset(offsetHours)}`;
  timezoneSummaryEl.textContent = `Solar noon here would fall near ${formatSolarNoon(skew)}—${describeSolarNoonSkew(skew)}.`;
  replaceMetadata(timezoneMetadataEl, [
    { label: 'Geographic region', value: region.name },
    { label: 'Country or territory', value: region.country_name },
    {
      label: 'Region level',
      value:
        assignment.fallback === 'uncovered-area'
          ? 'Boundary coverage gap'
          : ['Country', 'First-level subdivision', 'Second-level subdivision'][
              region.level
            ],
    },
    { label: 'Named after', value: region.naming?.metro_name ?? undefined },
    {
      label: 'Naming basis',
      value:
        region.naming?.method === 'metro'
          ? 'Largest metropolitan population estimate in the naming source'
          : region.naming?.method === 'settlement'
            ? 'Largest mapped settlement; metro estimate unavailable'
            : 'No matching populated place; geographic region name used',
    },
    {
      label: 'Naming population estimate',
      value: region.naming?.population
        ? region.naming.population.toLocaleString('en')
        : undefined,
    },
    {
      label: 'Naming source',
      value:
        region.naming?.source === 'natural-earth-populated-places'
          ? 'Natural Earth'
          : region.naming?.source === 'geonames-cities500'
            ? 'GeoNames'
            : undefined,
    },
    { label: 'ISO code (source)', value: region.iso_code },
    { label: 'Longitude', value: formatLongitude(longitude) },
    { label: 'Calculated UTC offset', value: formatUtcOffset(offsetHours) },
    { label: 'Solar noon', value: formatSolarNoon(skew) },
    {
      label: 'Rule',
      value: fit
        ? `Entire region strictly within ±${fit.toleranceMinutes} min`
        : fallbackDescription(assignment),
    },
    {
      label: 'Maximum region skew',
      value: fit ? `${fit.maximumSkewMinutes.toFixed(2)} min` : undefined,
    },
    { label: 'Time of year', value: 'Fixed year-round; no daylight saving' },
    { label: 'Boundary source', value: region.source },
    {
      label: 'Boundary detail',
      value: region.source.startsWith('natural-earth')
        ? 'Generalized 1:10 million outlines; local borders may differ.'
        : region.source === 'geoboundaries-MEX1'
          ? 'Detailed INEGI state boundaries (2020).'
          : undefined,
    },
    { label: 'Source region ID', value: region.id },
  ]);
  return true;
}
