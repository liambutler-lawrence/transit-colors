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
  buildTimezonePeriods,
  formatTimezonePeriodDateRange,
  formatUtcOffset,
  timezoneOffsetHours,
  timezoneOffsetsAt,
  type TimezoneOffsetResolver,
  type TimezonePeriod,
} from '../timezone-seasons.js';
import {
  compactPanelQuery,
  map,
  runtime,
  timezoneBoundariesToggle,
  timezoneColorsToggle,
  timezoneMetadataEl,
  timezoneNameEl,
  timezonePeriodSelect,
  timezonePeriodSummaryEl,
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
let timezonePeriods: readonly TimezonePeriod[] = [];
let timezoneNames: readonly string[] = [];
let timezonePeriodYear = new Date().getUTCFullYear();
let resolveTimezoneOffset: TimezoneOffsetResolver = timezoneOffsetHours;
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
  if (!period) return;
  activeTimezonePeriod = period;
  activeTimezoneOffsets = timezoneOffsetsAt(
    timezoneNames,
    period.representativeMs,
    resolveTimezoneOffset,
  );
  timezonePeriodSelect.value = String(index);
  updatePeriodSummary(period, index);
  timezoneLayer?.setOffsets(activeTimezoneOffsets);
  if (lastInspectedTimezone) {
    renderTimezoneDetails(
      lastInspectedTimezone.properties,
      lastInspectedTimezone.longitude,
    );
  }
}

function installTimezonePeriodControl(data: TimezoneSkewCollection): void {
  timezoneNames = data.features.map(({ properties }) => properties.timezone_name);
  const fallbackOffsets = new Map(
    data.features.map(({ properties }) => [
      properties.timezone_name,
      properties.offset_hours,
    ]),
  );
  const supportedTimezones = new Set(
    timezoneNames.filter((timezone) => {
      try {
        timezoneOffsetHours(timezone, Date.now());
        return true;
      } catch {
        return false;
      }
    }),
  );
  resolveTimezoneOffset = (timezone, epochMs) =>
    supportedTimezones.has(timezone)
      ? timezoneOffsetHours(timezone, epochMs)
      : (fallbackOffsets.get(timezone) ?? 0);

  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  timezonePeriodYear = year;
  timezonePeriods = buildTimezonePeriods(timezoneNames, year, resolveTimezoneOffset);
  timezonePeriodSelect.replaceChildren(
    ...timezonePeriods.map((period, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = period.label;
      return option;
    }),
  );
  timezonePeriodSelect.disabled = false;
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
  }
}

function renderTimezoneDetails(
  properties: TimezoneSkewProperties,
  longitude: number,
): void {
  const offsetHours =
    activeTimezoneOffsets.get(properties.timezone_name) ?? properties.offset_hours;
  const offsetLabel = formatUtcOffset(offsetHours);
  const periodLabel = activeTimezonePeriod
    ? `${formatTimezonePeriodDateRange(
        activeTimezonePeriod.startMs,
        activeTimezonePeriod.endMs,
      )}, ${timezonePeriodYear}`
    : 'Current offset pattern';
  timezoneSelectionTypeEl.textContent = 'Mean solar time';
  timezoneNameEl.textContent = offsetLabel;
  const skewMinutes = solarNoonSkewMinutes(longitude, offsetHours);
  timezoneSummaryEl.textContent = `Solar noon here falls near ${formatSolarNoon(skewMinutes)}—${describeSolarNoonSkew(skewMinutes)}.`;
  replaceMetadata(timezoneMetadataEl, [
    { label: 'Longitude', value: formatLongitude(longitude) },
    { label: 'UTC offset', value: offsetLabel },
    { label: 'Solar noon', value: formatSolarNoon(skewMinutes) },
    { label: 'Clock skew', value: describeSolarNoonSkew(skewMinutes) },
    { label: 'Time of year', value: periodLabel },
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
