import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { triangulateGlobePolygons } from '../globe-polygon-mesh.js';
import type { TimezoneCountryFeature } from '../timezone-countries.js';
import {
  solarNoonSkewMinutes,
  TIMEZONE_SKEW_LIMIT_MINUTES,
  type TimezoneSkewCollection,
} from '../timezone-skew.js';

const FILL_LAYER_ID = 'timezone-skew-fill';
const COUNTRY_OVERRIDE_LAYER_ID = 'timezone-country-override';

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
  opaqueLand = false,
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
        gl_Position = projectTile(a_position, a_position);
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
        ${opaqueLand ? 'color = mix(neutral, color, alpha); alpha = 1.0;' : ''}
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

export function triangulateTimezoneData(
  data: Pick<TimezoneSkewCollection, 'features'>,
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

export class TimezoneSkewLayer implements CustomLayerInterface {
  readonly type = 'custom' satisfies CustomLayerInterface['type'];
  readonly renderingMode = '2d' satisfies CustomLayerInterface['renderingMode'];
  private buffer: WebGLBuffer | null = null;
  private map: MapLibreMap | null = null;
  private readonly programs = new Map<string, TimezoneSkewProgram>();
  private visible = false;
  private dirty = false;

  constructor(
    private readonly mesh: TimezoneSkewMesh,
    readonly id = FILL_LAYER_ID,
    private readonly opaqueLand = false,
  ) {}

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
      bindings = createProgram(gl, options.shaderData, 0.82, this.opaqueLand);
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

export class CountryTimezoneOverrideLayer implements CustomLayerInterface {
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
