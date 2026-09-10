import {
  AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES,
  assignAutomaticTimezones,
  automaticTimezoneDataSchema,
  automaticTimezoneOptions,
  customizeAutomaticTimezone,
  type AutomaticTimezoneAssignment,
} from '../automatic-timezones.js';
import { fetchParsed } from '../parse.js';
import { PolygonHitIndex } from '../polygon-hit-index.js';
import { polygonOutlines } from '../polygon-outlines.js';
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

// Vite emits a content-hashed URL, binding the pruned hierarchy to this build.
// A query string on an overwritten static path still let old tabs fetch new data.
const automaticDataUrl = new URL(
  '../../data/timezone-automatic-regions.json',
  import.meta.url,
).href;
const rules = requiredElement('#timezone-rules', HTMLSelectElement);
const info = requiredElement('#timezone-automatic-info', HTMLElement);
const summary = requiredElement('#timezone-automatic-summary', HTMLElement);
const reloadButton = requiredElement('#timezone-automatic-reload', HTMLButtonElement);
const customization = requiredElement(
  '#timezone-automatic-customization',
  HTMLFieldSetElement,
);
const offsetSelect = requiredElement('#timezone-automatic-offset', HTMLSelectElement);
const resetButton = requiredElement('#timezone-automatic-reset', HTMLButtonElement);
const offsetNote = requiredElement('#timezone-automatic-offset-note', HTMLElement);
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
const POLAR_FILL_ID = 'timezone-automatic-fill-polar';
const BORDER_ID = 'timezone-automatic-borders';
const SELECTED_BORDER_ID = 'timezone-automatic-selected-border';
const STORAGE_KEY = 'transit-colors:automatic-timezone-offsets:v1';
const overrides = new Map<string, number>();
let assignments: AutomaticTimezoneAssignment[] = [];
let selected: { assignment: AutomaticTimezoneAssignment; longitude: number } | null =
  null;
let layer: TimezoneSkewLayer | null = null;
let polarLayer: TimezoneSkewLayer | null = null;
let hitIndex: PolygonHitIndex<AutomaticTimezoneAssignment> | null = null;
let loading: Promise<void> | null = null;
let installed = false;

export function automaticTimezoneActive(): boolean {
  return rules.value === 'automatic';
}

function fallbackDescription(assignment: AutomaticTimezoneAssignment): string {
  if (assignment.fallback === 'too-wide')
    return `The best whole-hour UTC offset still leaves more than ${AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES} minutes of maximum skew in this second-level region; temporary UTC+0.`;
  if (assignment.fallback === 'uncovered-area') return assignment.region.coverage_note;
  return 'No usable child subdivisions in the boundary sources; temporary UTC+0.';
}

function renderSummary(assignments: readonly AutomaticTimezoneAssignment[]): void {
  const accepted = assignments.filter(({ fit }) => fit).length;
  const fallbacks = assignments.filter(({ fallback }) => fallback);
  const tooWide = fallbacks.filter(({ fallback }) => fallback === 'too-wide').length;
  const gaps = fallbacks.filter(({ fallback }) => fallback === 'uncovered-area').length;
  const missing = fallbacks.length - tooWide - gaps;
  summary.textContent = `${accepted} regions have a maximum skew of ${AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES} minutes or less. ${tooWide} second-level regions use UTC+0 because their best maximum skew still exceeds ${AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES} minutes. ${missing} regions lack usable subdivisions; ${gaps} boundary coverage gaps also use UTC+0.${overrides.size ? ` ${overrides.size} custom ${overrides.size === 1 ? 'offset' : 'offsets'} applied.` : ''}`;
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

function effectiveAssignment(
  assignment: AutomaticTimezoneAssignment,
): AutomaticTimezoneAssignment {
  return customizeAutomaticTimezone(
    assignment,
    overrides.get(assignment.region.id) ?? null,
  );
}

function restoreOverrides(): void {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    );
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const assignment of assignments) {
      const offset: unknown = Reflect.get(stored, assignment.region.id);
      if (typeof offset !== 'number' || offset === assignment.offsetHours) continue;
      try {
        // Revalidate against current leaves and boundaries after every data update.
        customizeAutomaticTimezone(assignment, offset);
        overrides.set(assignment.region.id, offset);
      } catch {
        // A formerly valid choice may no longer fit this region.
      }
    }
  } catch {
    // Unavailable storage or invalid saved data leaves automatic choices intact.
  }
}

function changeSelectedOffset(offset: number | null): void {
  if (!selected) return;
  const base = selected.assignment;
  const effective = customizeAutomaticTimezone(base, offset);
  if (effective === base) overrides.delete(base.region.id);
  else overrides.set(base.region.id, effective.offsetHours);
  layer?.setOffsets(overrides);
  polarLayer?.setOffsets(overrides);
  renderSummary(assignments.map(effectiveAssignment));
  renderAutomaticTimezoneDetails(base, selected.longitude);
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(overrides)),
    );
    offsetNote.textContent += ' Saved in this browser.';
  } catch {
    offsetNote.textContent +=
      ' Applied for this session; browser storage is unavailable.';
  }
}

function renderCustomization(base: AutomaticTimezoneAssignment): void {
  customization.hidden = selected === null;
  if (!selected) return;
  const alternatives = automaticTimezoneOptions(base.region.longitude_ranges).filter(
    ({ offsetHours }) => offsetHours !== base.offsetHours,
  );
  const defaultDetail = base.fit
    ? ` · max ${base.fit.maximumSkewMinutes.toFixed(2)} min`
    : ' · fallback';
  offsetSelect.replaceChildren(
    new Option(`Automatic · ${formatUtcOffset(base.offsetHours)}${defaultDetail}`, ''),
    ...alternatives.map(
      ({ offsetHours, maximumSkewMinutes }) =>
        new Option(
          `${formatUtcOffset(offsetHours)} · max ${maximumSkewMinutes.toFixed(2)} min`,
          String(offsetHours),
        ),
    ),
  );
  const override = overrides.get(base.region.id);
  offsetSelect.value = override === undefined ? '' : String(override);
  offsetSelect.disabled = alternatives.length === 0;
  resetButton.disabled = override === undefined;
  offsetNote.textContent = alternatives.length
    ? 'Each alternative keeps the entire region’s maximum skew below 45 minutes. Boundaries and the region name stay the same.'
    : 'No alternative whole-hour UTC offset keeps this region’s maximum skew below 45 minutes.';
}

async function loadAutomaticTimezones(): Promise<void> {
  if (layer) return;
  const data = await fetchParsed(automaticDataUrl, automaticTimezoneDataSchema);
  assignments = assignAutomaticTimezones(data.regions);
  restoreOverrides();
  const features: TimezoneSkewCollection['features'] = assignments.map(
    ({ region, offsetHours }, id) => ({
      type: 'Feature',
      id,
      geometry: region.geometry,
      properties: {
        id,
        // Stable region IDs keep offsets independent even if display names change.
        timezone_name: region.id,
        offset_hours: offsetHours,
        offset_label: formatUtcOffset(offsetHours),
        places: region.name,
        dst_places: '',
      },
    }),
  );
  const polarFeatures = features.filter(({ geometry }) =>
    geometry.coordinates.some((polygon) =>
      polygon.some((ring) => ring.some(([, latitude]) => Math.abs(latitude) === 90)),
    ),
  );
  const polarIds = new Set(polarFeatures.map(({ id }) => id));
  const mesh = triangulateTimezoneData(
    { features: features.filter(({ id }) => !polarIds.has(id)) },
    overrides,
  );
  hitIndex = new PolygonHitIndex(
    assignments.map((assignment) => ({
      polygons: assignment.region.geometry.coordinates,
      value: assignment,
    })),
  );
  map.addSource('timezone-automatic-regions', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: features.map((feature) => ({
        ...feature,
        geometry: {
          type: 'MultiLineString',
          coordinates: polygonOutlines(feature.geometry.coordinates),
        },
      })),
    },
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
  // Mercator basemap water tiles can stretch a coastal opening all the way to
  // the pole. Draw whole polar land regions above them, on a neutral land base,
  // so neither a water slit nor a differently colored circular cap shows through.
  polarLayer = new TimezoneSkewLayer(
    triangulateTimezoneData({ features: polarFeatures }, overrides),
    POLAR_FILL_ID,
    true,
  );
  map.addLayer(polarLayer, firstSymbolLayerId());
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
    firstSymbolLayerId(),
  );
  map.addLayer(
    {
      id: SELECTED_BORDER_ID,
      type: 'line',
      source: 'timezone-automatic-regions',
      filter: ['==', ['get', 'timezone_name'], ''],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#244f8f', 'line-width': 2.2 },
    },
    firstSymbolLayerId(),
  );
  renderSummary(assignments.map(effectiveAssignment));
}

export function installAutomaticTimezoneControl(onChange: () => void): void {
  if (installed) return;
  installed = true;
  rules.disabled = false;
  reloadButton.addEventListener('click', () => {
    window.location.reload();
  });
  offsetSelect.addEventListener('change', () => {
    changeSelectedOffset(offsetSelect.value === '' ? null : Number(offsetSelect.value));
  });
  resetButton.addEventListener('click', () => {
    changeSelectedOffset(null);
  });
  rules.addEventListener('change', () => {
    const active = automaticTimezoneActive();
    selected = null;
    customization.hidden = true;
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
      reloadButton.hidden = true;
      summary.textContent = 'Loading boundaries and calculating automatic time zones…';
      loading = loadAutomaticTimezones().catch((error: unknown) => {
        loading = null;
        summary.textContent =
          'Automatic regions could not be loaded. Reload the map to get the current version and try again.';
        reloadButton.hidden = false;
        console.error('Automatic time zones failed to load', error);
      });
    }
    void loading.then(onChange);
  });
}

export function syncAutomaticTimezoneVisibility(): void {
  const active = runtime.activeProduct === 'timezone' && automaticTimezoneActive();
  layer?.setVisible(active && timezoneColorsToggle.checked);
  polarLayer?.setVisible(active && timezoneColorsToggle.checked);
  // Custom WebGL layers cannot reference a source. Keep the source-backed layer
  // active (with transparent lines) so its attribution survives hiding borders.
  setLayerVisibility(
    BORDER_ID,
    active && (timezoneColorsToggle.checked || timezoneBoundariesToggle.checked),
  );
  setLayerVisibility(
    SELECTED_BORDER_ID,
    active && selected !== null && timezoneBoundariesToggle.checked,
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
  if (map.getLayer(FILL_ID)) map.moveLayer(FILL_ID, before);
  for (const id of [POLAR_FILL_ID, BORDER_ID, SELECTED_BORDER_ID])
    if (map.getLayer(id)) map.moveLayer(id, firstSymbolLayerId());
}

export function inspectAutomaticTimezone(
  longitude: number,
  latitude: number,
  pin = false,
): boolean {
  const assignment = hitIndex?.find(longitude, latitude);
  if (pin) {
    selected = assignment ? { assignment, longitude } : null;
    customization.hidden = !selected;
    if (map.getLayer(SELECTED_BORDER_ID))
      map.setFilter(SELECTED_BORDER_ID, [
        '==',
        ['get', 'timezone_name'],
        assignment?.region.id ?? '',
      ]);
    syncAutomaticTimezoneVisibility();
  } else if (selected) {
    // Keep the clicked target stable while the pointer travels to the sidebar.
    return Boolean(assignment);
  }
  if (!assignment) return false;
  renderAutomaticTimezoneDetails(assignment, longitude);
  return true;
}

function renderAutomaticTimezoneDetails(
  base: AutomaticTimezoneAssignment,
  longitude: number,
): void {
  const assignment = effectiveAssignment(base);
  const { region, fit, offsetHours } = assignment;
  const customized = overrides.has(region.id);
  const skew = solarNoonSkewMinutes(longitude, offsetHours);
  timezoneSelectionTypeEl.textContent = customized
    ? 'Automatic · Custom offset'
    : assignment.fallback
      ? 'Automatic · UTC+0 fallback'
      : 'Automatic time zone';
  timezoneNameEl.textContent = `${region.naming?.timezone_name ?? region.name} · ${formatUtcOffset(offsetHours)}`;
  timezoneSummaryEl.textContent = `Solar noon here would fall near ${formatSolarNoon(skew)}—${describeSolarNoonSkew(skew)}.`;
  renderCustomization(base);
  replaceMetadata(timezoneMetadataEl, [
    { label: 'Geographic region', value: region.name },
    { label: 'Country or territory', value: region.country_name },
    {
      label: 'Region level',
      value:
        base.fallback === 'uncovered-area'
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
    {
      label: customized ? 'Custom UTC offset' : 'Calculated UTC offset',
      value: formatUtcOffset(offsetHours),
    },
    { label: 'Solar noon', value: formatSolarNoon(skew) },
    {
      label: 'Rule',
      value: customized
        ? 'Custom whole-hour offset with maximum skew below 45 minutes'
        : fit
          ? `Smallest maximum skew is at most ${AUTOMATIC_TIMEZONE_MAX_SKEW_MINUTES} minutes`
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
}
