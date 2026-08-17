import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  MapLayerMouseEvent,
  Map as MapLibreMap,
} from 'maplibre-gl';

import { triangulateGlobePolygons } from '../globe-polygon-mesh.js';
import {
  timezoneCountryPropertiesSchema,
  type TimezoneCountryCollection,
  type TimezoneCountryFeature,
  type TimezoneCountryProperties,
} from '../timezone-countries.js';
import {
  describeSolarNoonSkew,
  formatLongitude,
  formatSolarNoon,
  solarNoonSkewMinutes,
  TIMEZONE_SKEW_LIMIT_MINUTES,
  timezoneSkewPropertiesSchema,
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
const HIT_LAYER_ID = 'timezone-skew-hit';
const COUNTRY_OVERRIDE_LAYER_ID = 'timezone-country-override';
const COUNTRY_BOUNDARY_LAYER_ID = 'timezone-country-override-boundary';
const COUNTRY_HIT_LAYER_ID = 'timezone-country-override-hit';

function timezoneVisualBeforeLayerId(): string | undefined {
  return map.getLayer('water') ? 'water' : firstSymbolLayerId();
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create timezone skew shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  shaderData: CustomRenderMethodInput['shaderData'],
  alpha = 0.82,
): TimezoneSkewProgram {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `
      precision highp float;
      ${shaderData.define}
      ${shaderData.vertexShaderPrelude}
      attribute vec2 a_position;
      attribute float a_skew;
      varying float v_skew;
      void main() {
        gl_Position = projectTile(a_position);
        v_skew = a_skew;
      }
    `,
  );
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
      precision highp float;
      varying float v_skew;
      void main() {
        vec3 neutral = vec3(0.965, 0.961, 0.949);
        vec3 late = vec3(1.0, 0.18, 0.21);
        vec3 early = vec3(0.08, 0.60, 0.34);
        float intensity = clamp(abs(v_skew) / ${TIMEZONE_SKEW_LIMIT_MINUTES.toFixed(1)}, 0.0, 1.0);
        vec3 color = mix(neutral, v_skew >= 0.0 ? late : early, intensity);
        float alpha = ${alpha.toFixed(2)};
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `,
  );
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create timezone skew program');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown shader link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return {
    program,
    positionLocation: gl.getAttribLocation(program, 'a_position'),
    skewLocation: gl.getAttribLocation(program, 'a_skew'),
    projectionMatrixLocation: gl.getUniformLocation(program, 'u_projection_matrix'),
    tileMercatorCoordsLocation: gl.getUniformLocation(
      program,
      'u_projection_tile_mercator_coords',
    ),
    clippingPlaneLocation: gl.getUniformLocation(
      program,
      'u_projection_clipping_plane',
    ),
    projectionTransitionLocation: gl.getUniformLocation(
      program,
      'u_projection_transition',
    ),
    fallbackMatrixLocation: gl.getUniformLocation(
      program,
      'u_projection_fallback_matrix',
    ),
  };
}

interface TimezoneSkewProgram {
  readonly program: WebGLProgram;
  readonly positionLocation: number;
  readonly skewLocation: number;
  readonly projectionMatrixLocation: WebGLUniformLocation | null;
  readonly tileMercatorCoordsLocation: WebGLUniformLocation | null;
  readonly clippingPlaneLocation: WebGLUniformLocation | null;
  readonly projectionTransitionLocation: WebGLUniformLocation | null;
  readonly fallbackMatrixLocation: WebGLUniformLocation | null;
}

interface TimezoneSkewMesh {
  readonly vertices: Float32Array;
  readonly longitudes: Float32Array;
  readonly timezoneIndices: Uint16Array;
  readonly timezones: readonly string[];
  readonly fallbackOffsets: Float32Array;
}

function triangulateTimezoneData(
  data: TimezoneSkewCollection,
  offsets: ReadonlyMap<string, number>,
): TimezoneSkewMesh {
  const vertices: number[] = [];
  const longitudes: number[] = [];
  const timezoneIndices: number[] = [];
  const timezones = data.features.map(({ properties }) => properties.timezone_name);
  const fallbackOffsets = new Float32Array(
    data.features.map(({ properties }) => properties.offset_hours),
  );
  for (const [timezoneIndex, feature] of data.features.entries()) {
    const offsetHours =
      offsets.get(feature.properties.timezone_name) ?? feature.properties.offset_hours;
    const { coordinates } = triangulateGlobePolygons(feature.geometry.coordinates);
    for (let index = 0; index < coordinates.length; index += 3) {
      const x = coordinates[index];
      const y = coordinates[index + 1];
      const longitude = coordinates[index + 2];
      if (x === undefined || y === undefined || longitude === undefined) continue;
      vertices.push(x, y, solarNoonSkewMinutes(longitude, offsetHours));
      longitudes.push(longitude);
      timezoneIndices.push(timezoneIndex);
    }
  }
  return {
    vertices: new Float32Array(vertices),
    longitudes: new Float32Array(longitudes),
    timezoneIndices: new Uint16Array(timezoneIndices),
    timezones,
    fallbackOffsets,
  };
}

class TimezoneSkewLayer implements CustomLayerInterface {
  readonly id = FILL_LAYER_ID;
  readonly type = 'custom' satisfies CustomLayerInterface['type'];
  readonly renderingMode = '2d' satisfies CustomLayerInterface['renderingMode'];
  private buffer: WebGLBuffer | null = null;
  private map: MapLibreMap | null = null;
  private readonly programs = new Map<string, TimezoneSkewProgram>();
  private visible = false;
  private dirty = false;

  constructor(private readonly mesh: TimezoneSkewMesh) {}

  setOffsets(offsets: ReadonlyMap<string, number>): void {
    for (let index = 0; index < this.mesh.timezoneIndices.length; index += 1) {
      const timezoneIndex = this.mesh.timezoneIndices[index] ?? 0;
      const timezone = this.mesh.timezones[timezoneIndex] ?? '';
      const offsetHours =
        offsets.get(timezone) ?? this.mesh.fallbackOffsets[timezoneIndex] ?? 0;
      const longitude = this.mesh.longitudes[index] ?? 0;
      this.mesh.vertices[index * 3 + 2] = solarNoonSkewMinutes(longitude, offsetHours);
    }
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  onAdd(
    mapInstance: MapLibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    this.map = mapInstance;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertices, gl.DYNAMIC_DRAW);
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    if (!this.visible || !this.buffer) return;
    let bindings = this.programs.get(options.shaderData.variantName);
    if (!bindings) {
      bindings = createProgram(gl, options.shaderData);
      this.programs.set(options.shaderData.variantName, bindings);
    }
    gl.useProgram(bindings.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dirty) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.vertices);
      this.dirty = false;
    }
    gl.enableVertexAttribArray(bindings.positionLocation);
    gl.vertexAttribPointer(bindings.positionLocation, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(bindings.skewLocation);
    gl.vertexAttribPointer(bindings.skewLocation, 1, gl.FLOAT, false, 12, 8);

    const projection = options.defaultProjectionData;
    if (bindings.projectionMatrixLocation) {
      gl.uniformMatrix4fv(
        bindings.projectionMatrixLocation,
        false,
        projection.mainMatrix,
      );
    }
    if (bindings.tileMercatorCoordsLocation) {
      gl.uniform4fv(bindings.tileMercatorCoordsLocation, projection.tileMercatorCoords);
    }
    if (bindings.clippingPlaneLocation) {
      gl.uniform4fv(bindings.clippingPlaneLocation, projection.clippingPlane);
    }
    if (bindings.projectionTransitionLocation) {
      gl.uniform1f(
        bindings.projectionTransitionLocation,
        projection.projectionTransition,
      );
    }
    if (bindings.fallbackMatrixLocation) {
      gl.uniformMatrix4fv(
        bindings.fallbackMatrixLocation,
        false,
        projection.fallbackMatrix,
      );
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.mesh.vertices.length / 3);
  }

  onRemove(
    _mapInstance: MapLibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    for (const bindings of this.programs.values()) {
      gl.deleteProgram(bindings.program);
    }
    this.programs.clear();
    this.buffer = null;
    this.map = null;
  }
}

function triangulateCountryFeature(
  feature: TimezoneCountryFeature | null,
  offsetHours: number,
): Float32Array {
  if (!feature) return new Float32Array();
  const vertices: number[] = [];
  const { coordinates } = triangulateGlobePolygons(feature.geometry.coordinates);
  for (let index = 0; index < coordinates.length; index += 3) {
    const x = coordinates[index];
    const y = coordinates[index + 1];
    const longitude = coordinates[index + 2];
    if (x === undefined || y === undefined || longitude === undefined) continue;
    vertices.push(x, y, solarNoonSkewMinutes(longitude, offsetHours));
  }
  return new Float32Array(vertices);
}

class CountryTimezoneOverrideLayer implements CustomLayerInterface {
  readonly id = COUNTRY_OVERRIDE_LAYER_ID;
  readonly type = 'custom' satisfies CustomLayerInterface['type'];
  readonly renderingMode = '2d' satisfies CustomLayerInterface['renderingMode'];
  private buffer: WebGLBuffer | null = null;
  private map: MapLibreMap | null = null;
  private readonly programs = new Map<string, TimezoneSkewProgram>();
  private vertices: Float32Array<ArrayBufferLike> = new Float32Array();
  private visible = false;
  private dirty = false;

  setCountry(feature: TimezoneCountryFeature | null, offsetHours: number): void {
    this.vertices = triangulateCountryFeature(feature, offsetHours);
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  onAdd(
    mapInstance: MapLibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    this.map = mapInstance;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    if (!this.visible || !this.buffer || this.vertices.length === 0) return;
    let bindings = this.programs.get(options.shaderData.variantName);
    if (!bindings) {
      bindings = createProgram(gl, options.shaderData, 0.94);
      this.programs.set(options.shaderData.variantName, bindings);
    }
    gl.useProgram(bindings.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    gl.enableVertexAttribArray(bindings.positionLocation);
    gl.vertexAttribPointer(bindings.positionLocation, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(bindings.skewLocation);
    gl.vertexAttribPointer(bindings.skewLocation, 1, gl.FLOAT, false, 12, 8);

    const projection = options.defaultProjectionData;
    if (bindings.projectionMatrixLocation) {
      gl.uniformMatrix4fv(
        bindings.projectionMatrixLocation,
        false,
        projection.mainMatrix,
      );
    }
    if (bindings.tileMercatorCoordsLocation) {
      gl.uniform4fv(bindings.tileMercatorCoordsLocation, projection.tileMercatorCoords);
    }
    if (bindings.clippingPlaneLocation) {
      gl.uniform4fv(bindings.clippingPlaneLocation, projection.clippingPlane);
    }
    if (bindings.projectionTransitionLocation) {
      gl.uniform1f(
        bindings.projectionTransitionLocation,
        projection.projectionTransition,
      );
    }
    if (bindings.fallbackMatrixLocation) {
      gl.uniformMatrix4fv(
        bindings.fallbackMatrixLocation,
        false,
        projection.fallbackMatrix,
      );
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertices.length / 3);
  }

  onRemove(
    _mapInstance: MapLibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    for (const bindings of this.programs.values()) {
      gl.deleteProgram(bindings.program);
    }
    this.programs.clear();
    this.buffer = null;
    this.map = null;
  }
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
  if (map.getLayer(COUNTRY_HIT_LAYER_ID)) {
    map.setFilter(COUNTRY_HIT_LAYER_ID, ['==', ['id'], countryId]);
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

function inspectTimezone(event: MapLayerMouseEvent): void {
  if (runtime.activeProduct !== 'timezone') return;
  const properties = timezoneSkewPropertiesSchema.safeParse(
    event.features?.[0]?.properties,
  );
  if (!properties.success) return;
  const countryProperties = timezoneCountryPropertiesSchema.safeParse(
    map.queryRenderedFeatures(event.point, { layers: [COUNTRY_HIT_LAYER_ID] })[0]
      ?.properties,
  );
  const overrideCountry = countryProperties.success ? countryProperties.data : null;
  lastInspectedTimezone = {
    properties: properties.data,
    longitude: event.lngLat.lng,
    overrideCountry,
  };
  renderTimezoneDetails(properties.data, event.lngLat.lng, overrideCountry);
}

function installTimezoneHover(): void {
  if (hoverInstalled) return;
  hoverInstalled = true;
  map.on('mousemove', HIT_LAYER_ID, (event) => {
    inspectTimezone(event);
    map.getCanvas().style.cursor = 'crosshair';
  });
  map.on('mouseleave', HIT_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
  map.on('click', HIT_LAYER_ID, inspectTimezone);
}

export function installTimezoneSkew(
  data: TimezoneSkewCollection,
  countries: TimezoneCountryCollection,
): void {
  if (map.getSource('timezone-skew-zones')) return;
  installTimezonePeriodControl(data);
  installCountrySimulatorControl(countries);
  map.addSource('timezone-skew-zones', {
    type: 'geojson',
    data,
    attribution:
      'Time zones: <a href="https://github.com/evansiroky/timezone-boundary-builder">timezone-boundary-builder</a> / © OpenStreetMap contributors, ODbL · land mask: <a href="https://www.naturalearthdata.com/">Natural Earth</a>, public domain',
    promoteId: 'id',
  });
  map.addSource('timezone-countries', {
    type: 'geojson',
    data: countries,
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
  map.addLayer(
    {
      id: COUNTRY_HIT_LAYER_ID,
      type: 'fill',
      source: 'timezone-countries',
      filter: ['==', ['id'], -1],
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 },
    },
    firstSymbolLayerId(),
  );
  map.addLayer(
    {
      id: HIT_LAYER_ID,
      type: 'fill',
      source: 'timezone-skew-zones',
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 },
    },
    firstSymbolLayerId(),
  );
  syncCountryOverride();
  installTimezoneHover();
  syncTimezoneSkewVisibility();
}

export function positionTimezoneSkewLayers(): void {
  const visualBeforeLayerId = timezoneVisualBeforeLayerId();
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
  const hitBeforeLayerId = firstSymbolLayerId();
  if (map.getLayer(COUNTRY_HIT_LAYER_ID)) {
    map.moveLayer(COUNTRY_HIT_LAYER_ID, hitBeforeLayerId);
  }
  if (map.getLayer(HIT_LAYER_ID)) map.moveLayer(HIT_LAYER_ID, hitBeforeLayerId);
}

export function syncTimezoneSkewVisibility(): void {
  const active = runtime.activeProduct === 'timezone';
  const overrideActive = countryOverrideActive();
  timezoneLayer?.setVisible(active && timezoneColorsToggle.checked);
  countryOverrideLayer?.setVisible(
    active && timezoneColorsToggle.checked && overrideActive,
  );
  setLayerVisibility(BOUNDARY_LAYER_ID, active && timezoneBoundariesToggle.checked);
  setLayerVisibility(COUNTRY_BOUNDARY_LAYER_ID, active && overrideActive);
  setLayerVisibility(COUNTRY_HIT_LAYER_ID, active && overrideActive);
  setLayerVisibility(HIT_LAYER_ID, active);
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
