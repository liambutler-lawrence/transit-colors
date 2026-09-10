import {
  CountryTimezoneOverrideLayer,
  TimezoneSkewLayer,
  triangulateTimezoneData,
} from './timezone-skew-layer.js';
import type { MapMouseEvent } from 'maplibre-gl';
import {
  automaticTimezoneActive,
  inspectAutomaticTimezone,
  installAutomaticTimezoneControl,
  positionAutomaticTimezoneLayers,
  syncAutomaticTimezoneVisibility,
} from './automatic-timezone-ui.js';

import { PolygonHitIndex } from '../polygon-hit-index.js';
import type {
  TimezoneCountryCollection,
  TimezoneCountryFeature,
  TimezoneCountryProperties,
} from '../timezone-countries.js';
import {
  describeSolarNoonSkew,
  formatLongitude,
  formatSolarNoon,
  solarNoonSkewMinutes,
  type TimezoneSkewCollection,
  type TimezoneSkewProperties,
} from '../timezone-skew.js';
import {
  buildHistoricalTimezonePeriods,
  buildTimezonePeriodsFromRules,
  formatTimezonePeriodDateRange,
  formatUtcOffset,
  timezoneOffsetsFromRulesAt,
  type HistoricalTimezonePeriod,
  type TimezonePeriod,
} from '../timezone-seasons.js';
import {
  compactPanelQuery,
  map,
  runtime,
  timezoneBoundariesToggle,
  timezoneColorsToggle,
  timezoneCountryResetButton,
  timezoneCountrySelect,
  timezoneCountrySummaryEl,
  timezoneCountryZoneSelect,
  timezoneHistoryPeriodSelect,
  timezoneHistorySummaryEl,
  timezoneMetadataEl,
  timezoneNameEl,
  timezonePeriodSummaryEl,
  timezoneResultNoteEl,
  timezoneSelectionTypeEl,
  timezoneSummaryEl,
} from './context.js';
import {
  firstSymbolLayerId,
  replaceMetadata,
  setLayerVisibility,
} from './map-ui-utils.js';
import {
  createTimezonePeriodPicker,
  type TimezonePeriodPicker,
} from './timezone-period-menu.js';

const FILL_LAYER_ID = 'timezone-skew-fill';
const BOUNDARY_LAYER_ID = 'timezone-skew-boundaries';
const COUNTRY_OVERRIDE_LAYER_ID = 'timezone-country-override';
const COUNTRY_BOUNDARY_LAYER_ID = 'timezone-country-override-boundary';
const TIMEZONE_SOURCE_LAYER = 'timezone_zones';
const COUNTRY_SOURCE_LAYER = 'timezone_countries';

function timezoneVisualBeforeLayerId(): string | undefined {
  return map.getLayer('water') ? 'water' : firstSymbolLayerId();
}

let timezoneLayer: TimezoneSkewLayer | null = null;
let countryOverrideLayer: CountryTimezoneOverrideLayer | null = null;
let hoverInstalled = false;
let periodControlInstalled = false;
let activeTimezoneOffsets: ReadonlyMap<string, number> = new Map();
let activeTimezonePeriod: TimezonePeriod | null = null;
let activeHistoricalPeriod: HistoricalTimezonePeriod | null = null;
let timezonePeriods: readonly TimezonePeriod[] = [];
let historicalTimezonePeriods: readonly HistoricalTimezonePeriod[] = [];
let timezonePeriodYear = new Date().getUTCFullYear();
let selectedTimezonePeriodIndex = 0;
let timezonePeriodPicker: TimezonePeriodPicker | null = null;
let timezoneData: TimezoneSkewCollection | null = null;
let timezoneCountryData: TimezoneCountryCollection | null = null;
let timezoneHitIndex: PolygonHitIndex<TimezoneSkewProperties> | null = null;
let timezoneCountryHitIndex: PolygonHitIndex<TimezoneCountryProperties> | null = null;
let activeCountryFeature: TimezoneCountryFeature | null = null;
let activeCountryTimezone = '';
let lastInspectedTimezone: {
  readonly properties: TimezoneSkewProperties;
  readonly longitude: number;
  readonly overrideCountry: TimezoneCountryProperties | null;
} | null = null;

function countryOverrideActive(): boolean {
  return Boolean(
    activeCountryFeature &&
    activeCountryTimezone &&
    activeTimezoneOffsets.has(activeCountryTimezone),
  );
}

function updateTimezoneResultNote(): void {
  if (automaticTimezoneActive()) {
    timezoneResultNoteEl.textContent =
      'Color uses each region’s whole-hour UTC offset, including your custom choices. UTC+0 exceptions are listed above.';
    return;
  }
  const baseNote = activeHistoricalPeriod
    ? 'Historical color uses standard UTC offsets, excluding recurring daylight-saving changes.'
    : "Color is calculated continuously from each timezone's UTC offset and every point's longitude.";
  timezoneResultNoteEl.textContent = countryOverrideActive()
    ? `${baseNote} The outlined country uses the simulated offset.`
    : baseNote;
}

function updateCountryTimezoneOptions(): void {
  if (!timezoneData) return;
  const selectedTimezone = activeCountryTimezone;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = activeCountryFeature
    ? 'Choose a timekeeping region…'
    : 'Choose a country first';
  const options = Object.keys(timezoneData.metadata.timezone_rules)
    .map((timezone) => ({
      timezone,
      offset: activeTimezoneOffsets.get(timezone) ?? 0,
    }))
    .sort(
      (left, right) =>
        left.offset - right.offset || left.timezone.localeCompare(right.timezone),
    )
    .map(({ timezone, offset }) => {
      const option = document.createElement('option');
      option.value = timezone;
      option.textContent = `${formatUtcOffset(offset)} · ${readableTimezone(timezone)}`;
      return option;
    });
  timezoneCountryZoneSelect.replaceChildren(placeholder, ...options);
  timezoneCountryZoneSelect.value = selectedTimezone;
  timezoneCountryZoneSelect.disabled = !activeCountryFeature;
}

function syncCountryOverride(): void {
  updateCountryTimezoneOptions();
  const active = countryOverrideActive();
  const offsetHours = active
    ? (activeTimezoneOffsets.get(activeCountryTimezone) ?? 0)
    : 0;
  countryOverrideLayer?.setCountry(active ? activeCountryFeature : null, offsetHours);
  const countryId = activeCountryFeature?.properties.id ?? -1;
  if (map.getLayer(COUNTRY_BOUNDARY_LAYER_ID)) {
    map.setFilter(COUNTRY_BOUNDARY_LAYER_ID, ['==', ['id'], countryId]);
  }
  timezoneCountryResetButton.disabled =
    !activeCountryFeature && activeCountryTimezone === '';
  updateTimezoneResultNote();
  if (!activeCountryFeature) {
    timezoneCountrySummaryEl.textContent =
      'Choose a country and give all of it another time zone to compare its clock with the Sun.';
  } else if (!active) {
    timezoneCountrySummaryEl.textContent = `Choose a new timekeeping region for ${activeCountryFeature.properties.name}.`;
  } else {
    const offsetLabel = formatUtcOffset(offsetHours);
    const offsetKind = activeHistoricalPeriod ? 'standard offset' : 'offset';
    timezoneCountrySummaryEl.textContent = `${activeCountryFeature.properties.name} now follows ${readableTimezone(activeCountryTimezone)} (${offsetLabel} ${offsetKind}) for this map slice.`;
  }
  syncTimezoneSkewVisibility();
  if (lastInspectedTimezone) {
    const overrideCountry =
      active &&
      lastInspectedTimezone.overrideCountry?.id === activeCountryFeature?.properties.id
        ? lastInspectedTimezone.overrideCountry
        : null;
    renderTimezoneDetails(
      lastInspectedTimezone.properties,
      lastInspectedTimezone.longitude,
      overrideCountry,
    );
  }
}

function installCountrySimulatorControl(data: TimezoneCountryCollection): void {
  timezoneCountryData = data;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a country or territory…';
  timezoneCountrySelect.replaceChildren(
    placeholder,
    ...data.features.map((feature) => {
      const option = document.createElement('option');
      option.value = String(feature.properties.id);
      option.textContent = feature.properties.name;
      return option;
    }),
  );
  timezoneCountrySelect.disabled = false;
  updateCountryTimezoneOptions();

  timezoneCountrySelect.addEventListener('change', () => {
    const countryId = Number(timezoneCountrySelect.value);
    activeCountryFeature = timezoneCountrySelect.value
      ? (timezoneCountryData?.features.find(
          ({ properties }) => properties.id === countryId,
        ) ?? null)
      : null;
    syncCountryOverride();
  });
  timezoneCountryZoneSelect.addEventListener('change', () => {
    activeCountryTimezone = timezoneCountryZoneSelect.value;
    syncCountryOverride();
  });
  timezoneCountryResetButton.addEventListener('click', () => {
    activeCountryFeature = null;
    activeCountryTimezone = '';
    timezoneCountrySelect.value = '';
    syncCountryOverride();
  });
}

function applyTimezonePeriod(index: number): void {
  const period = timezonePeriods[index];
  if (!period || !timezoneData || timezoneHistoryPeriodSelect.value !== '') return;
  selectedTimezonePeriodIndex = index;
  activeTimezonePeriod = period;
  activeTimezoneOffsets = timezoneOffsetsFromRulesAt(
    timezoneData.metadata.timezone_rules,
    period.representativeMs,
  );
  timezonePeriodPicker?.setSelected(index);
  timezoneLayer?.setOffsets(activeTimezoneOffsets);
  syncCountryOverride();
}

function readableTimezone(timezone: string): string {
  return timezone.replaceAll('_', ' ').replace('/', ' / ');
}

function describeChangedTimezones(timezones: readonly string[]): string {
  if (timezones.length === 0) return 'Baseline at Jan 1, 1970.';
  const visible = timezones.slice(0, 2).map(readableTimezone).join(' and ');
  const remainder = timezones.length - 2;
  return `${visible}${remainder > 0 ? ` and ${remainder} more` : ''} ${timezones.length === 1 ? 'starts' : 'start'} this era.`;
}

function applyHistoricalTimezonePeriod(index: number): void {
  const period = historicalTimezonePeriods[index];
  if (!period || !timezoneData) return;
  activeHistoricalPeriod = period;
  activeTimezonePeriod = null;
  activeTimezoneOffsets = timezoneOffsetsFromRulesAt(
    timezoneData.metadata.timezone_rules,
    period.representativeMs,
    true,
  );
  timezoneHistoryPeriodSelect.value = String(index);
  timezonePeriodPicker?.setDisabled(true);
  timezonePeriodSummaryEl.textContent =
    'Time of year is downstream from official history and is paused for this standard-offset era.';
  const nextCount = period.nextChangedTimezones.length;
  const nextText = period.isPresent
    ? 'This is the latest completed era.'
    : `${nextCount} ${nextCount === 1 ? 'region changes' : 'regions change'} at the next boundary.`;
  timezoneHistorySummaryEl.textContent = `${describeChangedTimezones(period.changedTimezones)} ${nextText}`;
  timezoneLayer?.setOffsets(activeTimezoneOffsets);
  syncCountryOverride();
}

function applyCurrentTimezoneHistory(): void {
  activeHistoricalPeriod = null;
  timezoneHistoryPeriodSelect.value = '';
  timezoneHistorySummaryEl.textContent =
    'Current map follows the selected time of year. Choose an era to compare standard time since 1970.';
  timezonePeriodPicker?.setDisabled(false);
  applyTimezonePeriod(selectedTimezonePeriodIndex);
}

function historicalOptions(
  periods: readonly HistoricalTimezonePeriod[],
): readonly HTMLOptGroupElement[] {
  const groups = new Map<
    number,
    { period: HistoricalTimezonePeriod; index: number }[]
  >();
  periods.forEach((period, index) => {
    const year = new Date(period.startMs).getUTCFullYear();
    const decade = Math.floor(year / 10) * 10;
    const group = groups.get(decade) ?? [];
    group.push({ period, index });
    groups.set(decade, group);
  });
  return [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .map(([decade, entries]) => {
      const group = document.createElement('optgroup');
      group.label = `${decade}s`;
      group.append(
        ...entries.reverse().map(({ period, index }) => {
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = period.label;
          return option;
        }),
      );
      return group;
    });
}

function installTimezonePeriodControl(data: TimezoneSkewCollection): void {
  timezoneData = data;
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  timezonePeriodYear = year;
  timezonePeriods = buildTimezonePeriodsFromRules(data.metadata.timezone_rules, year);
  historicalTimezonePeriods = buildHistoricalTimezonePeriods(
    data.metadata.timezone_rules,
    data.metadata.rules_start_epoch_seconds * 1_000,
    Math.min(now, data.metadata.rules_end_epoch_seconds * 1_000),
  );
  const currentOption = document.createElement('option');
  currentOption.value = '';
  currentOption.textContent = 'Current map · use time of year';
  timezoneHistoryPeriodSelect.replaceChildren(
    currentOption,
    ...historicalOptions(historicalTimezonePeriods),
  );
  timezoneHistoryPeriodSelect.disabled = false;
  const currentIndex = Math.max(
    0,
    timezonePeriods.findIndex(({ startMs, endMs }) => now >= startMs && now < endMs),
  );
  selectedTimezonePeriodIndex = currentIndex;
  timezonePeriodPicker ??= createTimezonePeriodPicker({
    data,
    onSelect: applyTimezonePeriod,
    periods: timezonePeriods,
    selectedIndex: currentIndex,
    year,
  });
  applyCurrentTimezoneHistory();

  if (!periodControlInstalled) {
    periodControlInstalled = true;
    timezoneHistoryPeriodSelect.addEventListener('change', () => {
      if (timezoneHistoryPeriodSelect.value === '') {
        applyCurrentTimezoneHistory();
        return;
      }
      applyHistoricalTimezonePeriod(Number(timezoneHistoryPeriodSelect.value));
    });
  }
}

function renderTimezoneDetails(
  properties: TimezoneSkewProperties,
  longitude: number,
  overrideCountry: TimezoneCountryProperties | null = null,
): void {
  const simulated = Boolean(overrideCountry && countryOverrideActive());
  const offsetHours = simulated
    ? (activeTimezoneOffsets.get(activeCountryTimezone) ?? properties.offset_hours)
    : (activeTimezoneOffsets.get(properties.timezone_name) ?? properties.offset_hours);
  const offsetLabel = formatUtcOffset(offsetHours);
  const periodLabel = activeHistoricalPeriod
    ? activeHistoricalPeriod.label
    : activeTimezonePeriod
      ? `${formatTimezonePeriodDateRange(
          activeTimezonePeriod.startMs,
          activeTimezonePeriod.endMs,
        )}, ${timezonePeriodYear}`
      : 'Current offset pattern';
  const periodMetadataLabel = activeHistoricalPeriod
    ? 'Official timezone era'
    : 'Time of year';
  const offsetMetadataLabel = simulated
    ? 'Simulated UTC offset'
    : activeHistoricalPeriod
      ? 'Standard UTC offset'
      : 'UTC offset';
  timezoneSelectionTypeEl.textContent = simulated
    ? `${overrideCountry?.name} simulation`
    : 'Mean solar time';
  timezoneNameEl.textContent = offsetLabel;
  const skewMinutes = solarNoonSkewMinutes(longitude, offsetHours);
  timezoneSummaryEl.textContent = simulated
    ? `With ${readableTimezone(activeCountryTimezone)}, solar noon here would fall near ${formatSolarNoon(skewMinutes)}—${describeSolarNoonSkew(skewMinutes)}.`
    : `Solar noon here falls near ${formatSolarNoon(skewMinutes)}—${describeSolarNoonSkew(skewMinutes)}.`;
  const metadata = [
    { label: 'Longitude', value: formatLongitude(longitude) },
    { label: offsetMetadataLabel, value: offsetLabel },
    { label: 'Solar noon', value: formatSolarNoon(skewMinutes) },
    { label: 'Clock skew', value: describeSolarNoonSkew(skewMinutes) },
    { label: periodMetadataLabel, value: periodLabel },
  ];
  if (simulated && overrideCountry) {
    metadata.push(
      { label: 'Country or territory', value: overrideCountry.name },
      { label: 'Simulated region', value: activeCountryTimezone },
      { label: 'Underlying region', value: properties.timezone_name },
    );
  } else {
    metadata.push({ label: 'Timekeeping region', value: properties.timezone_name });
  }
  replaceMetadata(timezoneMetadataEl, metadata);
}

function inspectTimezone(event: MapMouseEvent, pin = false): boolean {
  if (runtime.activeProduct !== 'timezone') return false;
  if (automaticTimezoneActive())
    return inspectAutomaticTimezone(event.lngLat.lng, event.lngLat.lat, pin);
  const properties = timezoneHitIndex?.find(event.lngLat.lng, event.lngLat.lat);
  if (!properties) return false;
  const countryId = activeCountryFeature?.properties.id;
  const overrideCountry =
    countryId === undefined
      ? null
      : (timezoneCountryHitIndex?.find(
          event.lngLat.lng,
          event.lngLat.lat,
          (country) => country.id === countryId,
        ) ?? null);
  lastInspectedTimezone = {
    properties,
    longitude: event.lngLat.lng,
    overrideCountry,
  };
  renderTimezoneDetails(properties, event.lngLat.lng, overrideCountry);
  return true;
}

function installTimezoneHover(): void {
  if (hoverInstalled) return;
  hoverInstalled = true;
  let pendingEvent: MapMouseEvent | null = null;
  let animationFrame: number | null = null;
  map.on('mousemove', (event) => {
    if (runtime.activeProduct !== 'timezone') return;
    pendingEvent = event;
    if (animationFrame !== null) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = null;
      if (!pendingEvent) return;
      map.getCanvas().style.cursor = inspectTimezone(pendingEvent) ? 'crosshair' : '';
      pendingEvent = null;
    });
  });
  map.on('click', (event) => {
    inspectTimezone(event, true);
  });
}

export function installTimezoneSkew(
  data: TimezoneSkewCollection,
  countries: TimezoneCountryCollection,
): void {
  if (map.getSource('timezone-skew-zones')) return;
  timezoneHitIndex = new PolygonHitIndex(
    data.features.map(({ geometry, properties }) => ({
      polygons: geometry.coordinates,
      value: properties,
    })),
  );
  timezoneCountryHitIndex = new PolygonHitIndex(
    countries.features.map(({ geometry, properties }) => ({
      polygons: geometry.coordinates,
      value: properties,
    })),
  );
  installTimezonePeriodControl(data);
  installCountrySimulatorControl(countries);
  map.addSource('timezone-skew-zones', {
    type: 'vector',
    url: 'pmtiles://data/timezone-skew-zones.pmtiles',
    attribution:
      'Time zones: <a href="https://github.com/evansiroky/timezone-boundary-builder">timezone-boundary-builder</a> / © OpenStreetMap contributors, ODbL · land mask: <a href="https://www.naturalearthdata.com/">Natural Earth</a>, public domain',
    promoteId: 'id',
  });
  map.addSource('timezone-countries', {
    type: 'vector',
    url: 'pmtiles://data/timezone-skew-countries.pmtiles',
    attribution:
      'Countries: <a href="https://www.naturalearthdata.com/">Natural Earth</a>, public domain',
    promoteId: 'id',
  });

  timezoneLayer = new TimezoneSkewLayer(
    triangulateTimezoneData(data, activeTimezoneOffsets),
  );
  map.addLayer(timezoneLayer, timezoneVisualBeforeLayerId());
  countryOverrideLayer = new CountryTimezoneOverrideLayer();
  map.addLayer(countryOverrideLayer, timezoneVisualBeforeLayerId());
  map.addLayer(
    {
      id: BOUNDARY_LAYER_ID,
      type: 'line',
      source: 'timezone-skew-zones',
      'source-layer': TIMEZONE_SOURCE_LAYER,
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#8b4b20',
        'line-opacity': 0.8,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 5, 1.1],
      },
    },
    timezoneVisualBeforeLayerId(),
  );
  map.addLayer(
    {
      id: COUNTRY_BOUNDARY_LAYER_ID,
      type: 'line',
      source: 'timezone-countries',
      'source-layer': COUNTRY_SOURCE_LAYER,
      filter: ['==', ['id'], -1],
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#17233b',
        'line-opacity': 0.95,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.15, 5, 2.2],
      },
    },
    timezoneVisualBeforeLayerId(),
  );
  syncCountryOverride();
  installAutomaticTimezoneControl(() => {
    lastInspectedTimezone = null;
    updateTimezoneResultNote();
    syncTimezoneSkewVisibility();
  });
  installTimezoneHover();
  syncTimezoneSkewVisibility();
}

export function positionTimezoneSkewLayers(): void {
  const visualBeforeLayerId = timezoneVisualBeforeLayerId();
  positionAutomaticTimezoneLayers(visualBeforeLayerId);
  if (map.getLayer(FILL_LAYER_ID)) {
    map.moveLayer(FILL_LAYER_ID, visualBeforeLayerId);
  }
  if (map.getLayer(COUNTRY_OVERRIDE_LAYER_ID)) {
    map.moveLayer(COUNTRY_OVERRIDE_LAYER_ID, visualBeforeLayerId);
  }
  if (map.getLayer(BOUNDARY_LAYER_ID)) {
    map.moveLayer(BOUNDARY_LAYER_ID, visualBeforeLayerId);
  }
  if (map.getLayer(COUNTRY_BOUNDARY_LAYER_ID)) {
    map.moveLayer(COUNTRY_BOUNDARY_LAYER_ID, visualBeforeLayerId);
  }
}

export function syncTimezoneSkewVisibility(): void {
  const active = runtime.activeProduct === 'timezone' && !automaticTimezoneActive();
  syncAutomaticTimezoneVisibility();
  const overrideActive = countryOverrideActive();
  timezoneLayer?.setVisible(active && timezoneColorsToggle.checked);
  countryOverrideLayer?.setVisible(
    active && timezoneColorsToggle.checked && overrideActive,
  );
  setLayerVisibility(BOUNDARY_LAYER_ID, active && timezoneBoundariesToggle.checked);
  setLayerVisibility(COUNTRY_BOUNDARY_LAYER_ID, active && overrideActive);
  if (!active) map.getCanvas().style.cursor = '';
}

export function focusTimezoneWorld(): void {
  map.setMaxBounds(null);
  map.fitBounds(
    [
      [-179.5, -58],
      [179.5, 78],
    ],
    {
      padding: compactPanelQuery.matches ? 18 : 42,
      duration: 0,
    },
  );
}
