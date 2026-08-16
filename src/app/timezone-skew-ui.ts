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
  compactPanelQuery,
  map,
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

function triangulateTimezoneData(data: TimezoneSkewCollection): Float32Array {
  const vertices: number[] = [];
  for (const feature of data.features) {
    const offsetHours = feature.properties.offset_hours;
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
      }
    }
  }
  return new Float32Array(vertices);
}

class TimezoneSkewLayer implements CustomLayerInterface {
  readonly id = FILL_LAYER_ID;
  readonly type = 'custom' satisfies CustomLayerInterface['type'];
  readonly renderingMode = '2d' satisfies CustomLayerInterface['renderingMode'];
  private buffer: WebGLBuffer | null = null;
  private map: MapLibreMap | null = null;
  private readonly programs = new Map<string, TimezoneSkewProgram>();
  private visible = false;

  constructor(private readonly vertices: Float32Array) {}

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
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.STATIC_DRAW);
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
let hoverInstalled = false;

function renderTimezoneDetails(
  properties: TimezoneSkewProperties,
  longitude: number,
): void {
  const skewMinutes = solarNoonSkewMinutes(longitude, properties.offset_hours);
  timezoneSelectionTypeEl.textContent = 'Mean solar time';
  timezoneNameEl.textContent = properties.offset_label;
  timezoneSummaryEl.textContent = `Solar noon here falls near ${formatSolarNoon(skewMinutes)}—${describeSolarNoonSkew(skewMinutes)}.`;
  replaceMetadata(timezoneMetadataEl, [
    { label: 'Longitude', value: formatLongitude(longitude) },
    { label: 'UTC offset', value: properties.offset_label },
    { label: 'Solar noon', value: formatSolarNoon(skewMinutes) },
    { label: 'Clock skew', value: describeSolarNoonSkew(skewMinutes) },
    { label: 'Places', value: properties.places },
    { label: 'Example zone', value: properties.timezone_name },
  ]);
}

function inspectTimezone(event: MapLayerMouseEvent): void {
  if (runtime.activeProduct !== 'timezone') return;
  const properties = timezoneSkewPropertiesSchema.safeParse(
    event.features?.[0]?.properties,
  );
  if (!properties.success) return;
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
  map.addSource('timezone-skew-zones', {
    type: 'geojson',
    data,
    attribution: 'Timezone and land boundaries: Natural Earth (public domain)',
    promoteId: 'id',
  });

  timezoneLayer = new TimezoneSkewLayer(triangulateTimezoneData(data));
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
