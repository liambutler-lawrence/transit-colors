import earcut, { flatten } from 'earcut';
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  MapLayerMouseEvent,
  Map as MapLibreMap,
} from 'maplibre-gl';

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
  timezoneHistoryPeriodSelect,
  timezoneHistorySummaryEl,
  timezoneMetadataEl,
  timezoneNameEl,
  timezonePeriodSelect,
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

const FILL_LAYER_ID = 'timezone-skew-fill';
const BOUNDARY_LAYER_ID = 'timezone-skew-boundaries';
const HIT_LAYER_ID = 'timezone-skew-hit';
const MAX_MERCATOR_LATITUDE = 85.051129;

function mercatorX(longitude: number): number {
  return (longitude + 180) / 360;
}

function mercatorY(latitude: number): number {
  const clampedLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude),
  );
  const radians = (clampedLatitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
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
        vec3 early = vec3(0.19, 0.41, 0.93);
        float intensity = clamp(abs(v_skew) / ${TIMEZONE_SKEW_LIMIT_MINUTES.toFixed(1)}, 0.0, 1.0);
        vec3 color = mix(neutral, v_skew >= 0.0 ? late : early, intensity);
        float alpha = 0.82;
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
    for (const polygon of feature.geometry.coordinates) {
      const flattened = flatten(polygon);
      const triangleIndices = earcut(
        flattened.vertices,
        flattened.holes,
        flattened.dimensions,
      );
      for (const vertexIndex of triangleIndices) {
        const coordinateIndex = vertexIndex * flattened.dimensions;
        const longitude = flattened.vertices[coordinateIndex];
        const latitude = flattened.vertices[coordinateIndex + 1];
        if (longitude === undefined || latitude === undefined) continue;
        vertices.push(
          mercatorX(longitude),
          mercatorY(latitude),
          solarNoonSkewMinutes(longitude, offsetHours),
        );
        longitudes.push(longitude);
        timezoneIndices.push(timezoneIndex);
      }
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

let timezoneLayer: TimezoneSkewLayer | null = null;
let hoverInstalled = false;
let periodControlInstalled = false;
let activeTimezoneOffsets: ReadonlyMap<string, number> = new Map();
let activeTimezonePeriod: TimezonePeriod | null = null;
let activeHistoricalPeriod: HistoricalTimezonePeriod | null = null;
let timezonePeriods: readonly TimezonePeriod[] = [];
let historicalTimezonePeriods: readonly HistoricalTimezonePeriod[] = [];
let timezonePeriodYear = new Date().getUTCFullYear();
let timezoneData: TimezoneSkewCollection | null = null;
let lastInspectedTimezone: {
  readonly properties: TimezoneSkewProperties;
  readonly longitude: number;
} | null = null;

function updatePeriodSummary(period: TimezonePeriod, index: number): void {
  const range = formatTimezonePeriodDateRange(period.startMs, period.endMs);
  const nextCount = period.nextChangedTimezones.length;
  const nextChange =
    nextCount === 0
      ? 'No later offset change occurs this year.'
      : `${nextCount} timekeeping ${nextCount === 1 ? 'region changes' : 'regions change'} at the next boundary.`;
  timezonePeriodSummaryEl.textContent = `${timezonePeriodYear} · ${range} · Pattern ${index + 1} of ${timezonePeriods.length}. ${nextChange}`;
}

function applyTimezonePeriod(index: number): void {
  const period = timezonePeriods[index];
  if (!period || !timezoneData) return;
  activeTimezonePeriod = period;
  activeHistoricalPeriod = null;
  activeTimezoneOffsets = timezoneOffsetsFromRulesAt(
    timezoneData.metadata.timezone_rules,
    period.representativeMs,
  );
  timezonePeriodSelect.value = String(index);
  timezonePeriodSelect.disabled = false;
  timezoneHistoryPeriodSelect.value = '';
  updatePeriodSummary(period, index);
  timezoneHistorySummaryEl.textContent =
    'Current map follows the selected time of year. Choose an era to compare standard time since 1970.';
  timezoneResultNoteEl.textContent =
    "Color is calculated continuously from each timezone's UTC offset and every point's longitude.";
  timezoneLayer?.setOffsets(activeTimezoneOffsets);
  if (lastInspectedTimezone) {
    renderTimezoneDetails(
      lastInspectedTimezone.properties,
      lastInspectedTimezone.longitude,
    );
  }
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
  timezonePeriodSelect.disabled = true;
  timezonePeriodSummaryEl.textContent =
    'Time-of-year choices are paused while an official-history era is selected.';
  const nextCount = period.nextChangedTimezones.length;
  const nextText = period.isPresent
    ? 'This is the latest completed era.'
    : `${nextCount} ${nextCount === 1 ? 'region changes' : 'regions change'} at the next boundary.`;
  timezoneHistorySummaryEl.textContent = `${describeChangedTimezones(period.changedTimezones)} ${nextText}`;
  timezoneResultNoteEl.textContent =
    'Historical color uses standard UTC offsets, excluding recurring daylight-saving changes.';
  timezoneLayer?.setOffsets(activeTimezoneOffsets);
  if (lastInspectedTimezone) {
    renderTimezoneDetails(
      lastInspectedTimezone.properties,
      lastInspectedTimezone.longitude,
    );
  }
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
  timezonePeriodSelect.replaceChildren(
    ...timezonePeriods.map((period, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = period.label;
      return option;
    }),
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
  applyTimezonePeriod(currentIndex);

  if (!periodControlInstalled) {
    periodControlInstalled = true;
    timezonePeriodSelect.addEventListener('change', () => {
      applyTimezonePeriod(Number(timezonePeriodSelect.value));
    });
    timezoneHistoryPeriodSelect.addEventListener('change', () => {
      if (timezoneHistoryPeriodSelect.value === '') {
        applyTimezonePeriod(Number(timezonePeriodSelect.value));
        return;
      }
      applyHistoricalTimezonePeriod(Number(timezoneHistoryPeriodSelect.value));
    });
  }
}

function renderTimezoneDetails(
  properties: TimezoneSkewProperties,
  longitude: number,
): void {
  const offsetHours =
    activeTimezoneOffsets.get(properties.timezone_name) ?? properties.offset_hours;
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
  const offsetMetadataLabel = activeHistoricalPeriod
    ? 'Standard UTC offset'
    : 'UTC offset';
  timezoneSelectionTypeEl.textContent = 'Mean solar time';
  timezoneNameEl.textContent = offsetLabel;
  const skewMinutes = solarNoonSkewMinutes(longitude, offsetHours);
  timezoneSummaryEl.textContent = `Solar noon here falls near ${formatSolarNoon(skewMinutes)}—${describeSolarNoonSkew(skewMinutes)}.`;
  replaceMetadata(timezoneMetadataEl, [
    { label: 'Longitude', value: formatLongitude(longitude) },
    { label: offsetMetadataLabel, value: offsetLabel },
    { label: 'Solar noon', value: formatSolarNoon(skewMinutes) },
    { label: 'Clock skew', value: describeSolarNoonSkew(skewMinutes) },
    { label: periodMetadataLabel, value: periodLabel },
    { label: 'Timekeeping region', value: properties.timezone_name },
  ]);
}

function inspectTimezone(event: MapLayerMouseEvent): void {
  if (runtime.activeProduct !== 'timezone') return;
  const properties = timezoneSkewPropertiesSchema.safeParse(
    event.features?.[0]?.properties,
  );
  if (!properties.success) return;
  lastInspectedTimezone = {
    properties: properties.data,
    longitude: event.lngLat.lng,
  };
  renderTimezoneDetails(properties.data, event.lngLat.lng);
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

export function installTimezoneSkew(data: TimezoneSkewCollection): void {
  if (map.getSource('timezone-skew-zones')) return;
  installTimezonePeriodControl(data);
  map.addSource('timezone-skew-zones', {
    type: 'geojson',
    data,
    attribution:
      'Time zones: <a href="https://github.com/evansiroky/timezone-boundary-builder">timezone-boundary-builder</a> / © OpenStreetMap contributors, ODbL',
    promoteId: 'id',
  });

  timezoneLayer = new TimezoneSkewLayer(
    triangulateTimezoneData(data, activeTimezoneOffsets),
  );
  map.addLayer(timezoneLayer, firstSymbolLayerId());
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
  installTimezoneHover();
  syncTimezoneSkewVisibility();
}

export function positionTimezoneSkewLayers(): void {
  const beforeLayerId = firstSymbolLayerId();
  if (map.getLayer(FILL_LAYER_ID)) map.moveLayer(FILL_LAYER_ID, beforeLayerId);
  if (map.getLayer(BOUNDARY_LAYER_ID)) map.moveLayer(BOUNDARY_LAYER_ID, beforeLayerId);
  if (map.getLayer(HIT_LAYER_ID)) map.moveLayer(HIT_LAYER_ID, beforeLayerId);
}

export function syncTimezoneSkewVisibility(): void {
  const active = runtime.activeProduct === 'timezone';
  timezoneLayer?.setVisible(active && timezoneColorsToggle.checked);
  setLayerVisibility(BOUNDARY_LAYER_ID, active && timezoneBoundariesToggle.checked);
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
