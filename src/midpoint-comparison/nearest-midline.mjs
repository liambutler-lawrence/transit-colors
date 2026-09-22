// Local metric coordinates. There is deliberately no tangent, monotonicity,
// corridor, smoothing, or endpoint constraint in the experimental matcher.
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function curve(points) {
  const along = [0];
  for (let i = 1; i < points.length; i++)
    along.push(along.at(-1) + distance(points[i - 1], points[i]));
  return { points, along, length: along.at(-1) };
}
export function samples(line, spacing) {
  if (!(spacing > 0)) throw new Error('Spacing must be positive');
  const result = [];
  let segment = 1;
  for (let s = 0; s < line.length; s += spacing) {
    while (segment < line.points.length - 1 && line.along[segment] < s) segment++;
    const t =
      (s - line.along[segment - 1]) /
      (line.along[segment] - line.along[segment - 1] || 1);
    result.push({
      point: line.points[segment - 1].map(
        (v, axis) => v + t * (line.points[segment][axis] - v),
      ),
      s,
    });
  }
  result.push({ point: line.points.at(-1), s: line.length });
  return result;
}
const bounds = (items) =>
  items.reduce(
    (b, item) => [
      Math.min(b[0], item.bounds[0]),
      Math.min(b[1], item.bounds[1]),
      Math.max(b[2], item.bounds[2]),
      Math.max(b[3], item.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
function tree(items) {
  const box = bounds(items);
  if (items.length <= 8) return { bounds: box, items };
  const axis = box[2] - box[0] > box[3] - box[1] ? 0 : 1;
  items.sort((a, b) => a.a[axis] + a.b[axis] - (b.a[axis] + b.b[axis]));
  const middle = Math.floor(items.length / 2);
  return {
    bounds: box,
    children: [tree(items.slice(0, middle)), tree(items.slice(middle))],
  };
}
export function segmentIndex(lines) {
  const segments = lines.flatMap((points) => {
    const line = curve(points);
    return points.slice(1).map((b, i) => ({
      a: points[i],
      b,
      s: line.along[i],
      length: line.along[i + 1] - line.along[i],
      bounds: [
        Math.min(points[i][0], b[0]),
        Math.min(points[i][1], b[1]),
        Math.max(points[i][0], b[0]),
        Math.max(points[i][1], b[1]),
      ],
    }));
  });
  return tree(segments);
}
const boxDistance = (p, b) =>
  Math.max(b[0] - p[0], 0, p[0] - b[2]) ** 2 +
  Math.max(b[1] - p[1], 0, p[1] - b[3]) ** 2;
export function nearest(point, index) {
  let best = { squared: Infinity };
  function visit(node) {
    if (boxDistance(point, node.bounds) > best.squared) return;
    if (node.children) {
      const [a, b] = node.children;
      if (boxDistance(point, a.bounds) < boxDistance(point, b.bounds)) {
        visit(a);
        visit(b);
      } else {
        visit(b);
        visit(a);
      }
      return;
    }
    for (const segment of node.items) {
      const dx = segment.b[0] - segment.a[0],
        dy = segment.b[1] - segment.a[1];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point[0] - segment.a[0]) * dx + (point[1] - segment.a[1]) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      );
      const q = [segment.a[0] + t * dx, segment.a[1] + t * dy];
      const squared = (point[0] - q[0]) ** 2 + (point[1] - q[1]) ** 2;
      if (squared < best.squared)
        best = { point: q, s: segment.s + t * segment.length, squared };
    }
  }
  visit(index);
  return best;
}
export function nearestMidline(first, second, spacing) {
  const start = performance.now(),
    a = curve(first),
    b = curve(second);
  const ai = segmentIndex([first]),
    bi = segmentIndex([second]);
  const match = (side, other, index, from) =>
    samples(side, spacing).map(({ point, s }) => {
      const hit = nearest(point, index);
      return {
        coordinate: point.map((v, axis) => (v + hit.point[axis]) / 2),
        a: from === 0 ? point : hit.point,
        b: from === 0 ? hit.point : point,
        progress: (s / side.length + hit.s / other.length) / 2,
        from,
        opposite: hit.s,
      };
    });
  const ab = match(a, b, bi, 0),
    ba = match(b, a, ai, 1);
  // Connecting a union of two point sequences needs an ordering convention.
  // This symmetric progress key changes only order, never the nearest pairs.
  const combined = [...ab, ...ba].sort(
    (x, y) =>
      x.progress - y.progress ||
      x.coordinate[0] - y.coordinate[0] ||
      x.coordinate[1] - y.coordinate[1],
  );
  const coordinates = combined
    .map((p) => p.coordinate)
    .filter((p, i, all) => !i || distance(p, all[i - 1]) > 0.000001);
  let reversals = 0,
    maxStep = 0;
  for (let i = 1; i < coordinates.length; i++) {
    maxStep = Math.max(maxStep, distance(coordinates[i - 1], coordinates[i]));
    if (i + 1 === coordinates.length) continue;
    const [p, q, r] = coordinates.slice(i - 1, i + 2),
      u = distance(p, q),
      v = distance(q, r);
    if (
      u > 0.1 &&
      v > 0.1 &&
      ((q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) / (u * v) < -0.5
    )
      reversals++;
  }
  const backwards = (list) =>
    list.slice(1).filter((p, i) => p.opposite < list[i].opposite - 0.1).length;
  return {
    coordinates,
    first: ab.map((p) => p.coordinate),
    second: ba.map((p) => p.coordinate),
    pairs: combined
      .filter((_, i) => i % Math.max(1, Math.ceil(combined.length / 240)) === 0)
      .map((p) => [p.a, p.b]),
    count: ab.length + ba.length,
    reversals,
    backwards: backwards(ab) + backwards(ba),
    maxStep,
    milliseconds: performance.now() - start,
  };
}
