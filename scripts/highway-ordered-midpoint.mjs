import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { pointInRing } from './natural-earth-land.mjs';
import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const SPACING_METERS = 50;
const MATCH_SPACING_METERS = 10;
const MIN_ALIGNMENT = 0.25;

function direction(first, second) {
  const x = (second[0] - first[0]) * Math.cos(((first[1] + second[1]) * Math.PI) / 360);
  const y = second[1] - first[1];
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function alignment(first, second) {
  return first[0] * second[0] + first[1] * second[1];
}

function sourceCurve(coordinates) {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    distances.push(
      distances.at(-1) +
        geodesicDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  return { coordinates, distances, length: distances.at(-1) };
}

function pointAlong(curve, distance) {
  let index = 1;
  while (index < curve.distances.length - 1 && curve.distances[index] < distance)
    index += 1;
  const fraction = Math.max(
    0,
    Math.min(
      1,
      (distance - curve.distances[index - 1]) /
        (curve.distances[index] - curve.distances[index - 1] || 1),
    ),
  );
  const first = curve.coordinates[index - 1];
  const second = curve.coordinates[index];
  return {
    coordinate: first.map((value, axis) => value + fraction * (second[axis] - value)),
    direction: direction(first, second),
    distance,
  };
}

function samples(curve) {
  const count = Math.max(1, Math.ceil(curve.length / MATCH_SPACING_METERS));
  return Array.from({ length: count + 1 }, (_, index) =>
    pointAlong(curve, (curve.length * index) / count),
  );
}

function orderedCorrespondence(first, second, maximumWidthMeters, corridor) {
  const rows = first.length;
  const columns = second.length;
  const parents = new Uint8Array(rows * columns);
  const longitudeScale = 111_320 * Math.cos((first[0].coordinate[1] * Math.PI) / 180);
  let previous = new Float64Array(columns).fill(Infinity);
  for (let row = 0; row < rows; row += 1) {
    const current = new Float64Array(columns).fill(Infinity);
    const firstStep = row ? first[row].distance - first[row - 1].distance : 0;
    for (let column = 0; column < columns; column += 1) {
      const a = first[row];
      const b = second[column];
      if (alignment(a.direction, b.direction) < MIN_ALIGNMENT) continue;
      const squaredDistance =
        ((a.coordinate[0] - b.coordinate[0]) * longitudeScale) ** 2 +
        ((a.coordinate[1] - b.coordinate[1]) * 110_574) ** 2;
      if (squaredDistance > maximumWidthMeters ** 2) continue;
      // A close pair around a hairpin can still put its midpoint across one
      // roadway. Keep the correspondence inside the two bounded source sides.
      if (
        (row || column) &&
        (row !== rows - 1 || column !== columns - 1) &&
        !pointInRing(
          a.coordinate.map((value, axis) => (value + b.coordinate[axis]) / 2),
          corridor,
        )
      )
        continue;
      if (row === 0 && column === 0) {
        current[0] = 0;
        continue;
      }
      const secondStep = column
        ? second[column].distance - second[column - 1].distance
        : 0;
      let score = Infinity;
      let parent = 0;
      // Integrate separation over distance travelled on BOTH roads. Equal
      // per-cell costs would bias the result toward equal sample indices.
      if (row && column) {
        score = previous[column - 1] + squaredDistance * (firstStep + secondStep);
        parent = 3;
      }
      if (row && previous[column] + squaredDistance * firstStep < score) {
        score = previous[column] + squaredDistance * firstStep;
        parent = 1;
      }
      if (column && current[column - 1] + squaredDistance * secondStep < score) {
        score = current[column - 1] + squaredDistance * secondStep;
        parent = 2;
      }
      current[column] = score;
      parents[row * columns + column] = parent;
    }
    previous = current;
  }
  if (!Number.isFinite(previous.at(-1))) return null;
  const matches = [];
  let row = rows - 1;
  let column = columns - 1;
  while (row || column) {
    matches.push([first[row].distance, second[column].distance]);
    const parent = parents[row * columns + column];
    if (parent & 1) row -= 1;
    if (parent & 2) column -= 1;
  }
  matches.push([0, 0]);
  return matches.reverse();
}

function correspondenceKnots(matches) {
  const total = matches.at(-1)[0] + matches.at(-1)[1];
  const count = Math.max(1, Math.ceil(total / (4 * SPACING_METERS)));
  const knots = [];
  let index = 1;
  for (let sample = 0; sample <= count; sample += 1) {
    const distance = (total * sample) / count;
    while (
      index < matches.length - 1 &&
      matches[index][0] + matches[index][1] < distance
    )
      index += 1;
    const first = matches[index - 1];
    const last = matches[index];
    const fraction =
      (distance - first[0] - first[1]) / (last[0] + last[1] - first[0] - first[1]);
    knots.push([
      distance,
      ...first.map((value, axis) => value + fraction * (last[axis] - value)),
    ]);
  }
  return knots;
}

function monotoneSlopes(knots, axis) {
  const slopes = knots
    .slice(1)
    .map(
      (point, index) =>
        (point[axis] - knots[index][axis]) / (point[0] - knots[index][0]),
    );
  return knots.map((_, index) => {
    if (!index) return slopes[0];
    if (index === knots.length - 1) return slopes.at(-1);
    const before = slopes[index - 1];
    const after = slopes[index];
    return before * after > 0 ? (2 * before * after) / (before + after) : 0;
  });
}

/**
 * Follow both source roads monotonically, minimizing their integrated separation.
 * Inputs run in the same direction and already have proven paired endpoints.
 * Interpolation removes sampling-grid stair steps in SOURCE correspondence;
 * every output vertex is still the WGS84 midpoint of two points on those roads.
 */
export function orderedCarriagewayMidpoints(
  firstCoordinates,
  secondCoordinates,
  maximumWidthMeters,
) {
  const first = sourceCurve(firstCoordinates);
  const second = sourceCurve(secondCoordinates);
  if (first.length < 1 || second.length < 1) return null;
  const corridor = [
    ...firstCoordinates,
    ...secondCoordinates.toReversed(),
    firstCoordinates[0],
  ];
  if (hasProperSelfIntersection(corridor)) return null;
  const matches = orderedCorrespondence(
    samples(first),
    samples(second),
    maximumWidthMeters,
    corridor,
  );
  if (!matches) return null;
  const knots = correspondenceKnots(matches);
  const slopes = [monotoneSlopes(knots, 1), monotoneSlopes(knots, 2)];
  const total = knots.at(-1)[0];
  const count = Math.ceil(total / SPACING_METERS);
  const coordinates = [];
  const pairs = [];
  let index = 1;
  for (let sample = 0; sample <= count; sample += 1) {
    const distance = (total * sample) / count;
    while (index < knots.length - 1 && knots[index][0] < distance) index += 1;
    const span = knots[index][0] - knots[index - 1][0];
    const t = (distance - knots[index - 1][0]) / span;
    const sourceDistances = [1, 2].map(
      (axis, side) =>
        (2 * t ** 3 - 3 * t ** 2 + 1) * knots[index - 1][axis] +
        (t ** 3 - 2 * t ** 2 + t) * span * slopes[side][index - 1] +
        (-2 * t ** 3 + 3 * t ** 2) * knots[index][axis] +
        (t ** 3 - t ** 2) * span * slopes[side][index],
    );
    const a = pointAlong(first, sourceDistances[0]);
    const b = pointAlong(second, sourceDistances[1]);
    if (
      // Interpolation can straddle a source corner between sampled tangents,
      // but it must never pair points travelling in opposite directions.
      alignment(a.direction, b.direction) < 0 ||
      geodesicDistanceMeters(a.coordinate, b.coordinate) > maximumWidthMeters
    )
      return null;
    const coordinate = geodesicMidpoint(a.coordinate, b.coordinate).map((value) =>
      Number(value.toFixed(7)),
    );
    if (
      coordinates.length &&
      geodesicDistanceMeters(coordinates.at(-1), coordinate) > SPACING_METERS * 2.8
    )
      return null;
    if (
      coordinates.length > 1 &&
      alignment(
        direction(coordinates.at(-2), coordinates.at(-1)),
        direction(coordinates.at(-1), coordinate),
      ) < 0
    )
      return null;
    coordinates.push(coordinate);
    pairs.push({
      first: a.coordinate,
      second: b.coordinate,
      firstDistance: sourceDistances[0],
      secondDistance: sourceDistances[1],
    });
  }
  if (hasProperSelfIntersection(coordinates)) return null;
  // Validate interpolated correspondence too: it must not cut across a source
  // bend between the discrete matches or cross a cap at either paired endpoint.
  for (const side of [firstCoordinates, secondCoordinates]) {
    if (hasProperSelfIntersection([...side, ...coordinates.toReversed(), side[0]]))
      return null;
  }
  return { coordinates, pairs };
}
