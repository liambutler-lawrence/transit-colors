export const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
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
// Full sample-grid dynamic programming, bounded independently on each side.
// The bound is disclosed in the UI; no corridor or tangent pruning is applied.
export function orderedMidline(first, second, spacing, penalty = 1, taper = 0) {
  const start = performance.now();
  const a = curve(first),
    b = curve(second);
  const spacingA = Math.max(spacing, a.length / 1599);
  const spacingB = Math.max(spacing, b.length / 1599);
  const aa = samples(a, spacingA),
    bb = samples(b, spacingB);
  const n = aa.length,
    m = bb.length;
  const parents = new Uint8Array(n * m);
  let previous = new Float64Array(m).fill(Infinity);
  let row = new Float64Array(m);
  let previousGaps = new Float64Array(m);
  let gaps = new Float64Array(m);
  const transitions = [
    [1, 1, 1],
    [1, 0, 2],
    [0, 1, 3],
  ];
  for (let i = 0; i < n; i++) {
    row.fill(Infinity);
    for (let j = 0; j < m; j++) gaps[j] = distance(aa[i].point, bb[j].point);
    for (let j = 0; j < m; j++) {
      if (!i && !j) {
        row[j] = 0;
        continue;
      }
      const gap = gaps[j];
      let best = Infinity,
        direction = 0;
      for (const [di, dj, code] of transitions) {
        if (i < di || j < dj) continue;
        const pi = i - di,
          pj = j - dj;
        const base = di ? previous[pj] : row[pj];
        const advance = (aa[i].s - aa[pi].s + bb[j].s - bb[pj].s) / 2;
        if (!advance) continue;
        const oldGap = di ? previousGaps[pj] : gaps[pj];
        const dx =
          aa[i].point[0] - bb[j].point[0] - (aa[pi].point[0] - bb[pj].point[0]);
        const dy =
          aa[i].point[1] - bb[j].point[1] - (aa[pi].point[1] - bb[pj].point[1]);
        // Distance integrated over progress, plus cross-link change and stalling.
        const cost =
          base +
          ((gap + oldGap) / 2) * advance +
          penalty * (dx * dx + dy * dy + (!di || !dj ? advance * advance : 0));
        if (cost < best) {
          best = cost;
          direction = code;
        }
      }
      row[j] = best;
      parents[i * m + j] = direction;
    }
    [previous, row] = [row, previous];
    [previousGaps, gaps] = [gaps, previousGaps];
  }
  const matches = [];
  let i = n - 1,
    j = m - 1;
  while (true) {
    matches.push({
      i,
      j,
      sa: aa[i].s,
      sb: bb[j].s,
      points: [aa[i].point, bb[j].point],
    });
    if (!i && !j) break;
    const code = parents[i * m + j];
    if (code === 1 || code === 2) i--;
    if (code === 1 || code === 3) j--;
  }
  matches.reverse();
  const rawMatches = matches.slice();
  if (taper > 0)
    matches.splice(0, matches.length, ...taperMatches(matches, a, b, taper));
  const coordinates = matches.map(({ points: [a, b] }) => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ]);
  return {
    coordinates,
    matches,
    rawMatches,
    taper: Math.min(taper, a.length + b.length),
    spacingA,
    spacingB,
    cost: previous[m - 1],
    gridCells: n * m,
    milliseconds: performance.now() - start,
  };
}
// Smooth source progress, not map coordinates. A box average of a monotone
// correspondence stays monotone. Odd endpoint reflection preserves endpoints.
export function taperMatches(matches, a, b, width) {
  const ts = matches.map((p) => (p.sa + p.sb) / 2);
  const end = ts.at(-1),
    radius = Math.min(width / 2, end);
  if (!radius) return matches;
  const values = matches.map((p) => p.sa);
  const integral = [0];
  for (let i = 1; i < ts.length; i++)
    integral.push(
      integral.at(-1) + ((values[i - 1] + values[i]) / 2) * (ts[i] - ts[i - 1]),
    );
  const segment = (xs, t) => {
    let lo = 0,
      hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  function primitive(t) {
    if (t < 0) return primitive(-t);
    if (t > end) return 2 * values.at(-1) * (t - end) + primitive(2 * end - t);
    const i = segment(ts, t),
      dx = t - ts[i];
    return (
      integral[i] +
      values[i] * dx +
      ((values[i + 1] - values[i]) * dx * dx) / (2 * (ts[i + 1] - ts[i]))
    );
  }
  const at = (line, s) => {
    const i = segment(line.along, s),
      d = line.along[i + 1] - line.along[i];
    const f = d ? (s - line.along[i]) / d : 0;
    return line.points[i].map((v, k) => v + f * (line.points[i + 1][k] - v));
  };
  return matches.map((p, i) => {
    const t = ts[i];
    const sa =
      i === 0
        ? 0
        : i === matches.length - 1
          ? a.length
          : Math.max(
              0,
              Math.min(
                a.length,
                (primitive(t + radius) - primitive(t - radius)) / (2 * radius),
              ),
            );
    const sb = Math.max(0, Math.min(b.length, 2 * t - sa));
    return { sa, sb, points: [at(a, sa), at(b, sb)] };
  });
}
