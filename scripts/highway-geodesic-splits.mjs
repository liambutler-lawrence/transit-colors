import geographicLib from 'geographiclib-geodesic';
const { Geodesic } = geographicLib;
const earth = Geodesic.WGS84;

export function geodesicSegment(a, b) {
  const line = earth.InverseLine(a[1], a[0], b[1], b[0], Geodesic.ALL);
  return {
    length: line.s13,
    point(t) {
      if (t === 0) return a;
      if (t === 1) return b;
      const p = line.Position(t * line.s13, Geodesic.STANDARD | Geodesic.AREA);
      return [p.lon2, p.lat2];
    },
  };
}

// Solve in geodesic arclength parameters, never by moving a source road.
// The caller supplies a nearby planar candidate. Fail closed on nonconvergence.
export function refineGeodesicCrossing(a, b, c, d, t, u) {
  const first = geodesicSegment(a, b),
    second = geodesicSegment(c, d);
  const scale = Math.cos(((a[1] + b[1] + c[1] + d[1]) * Math.PI) / 720);
  for (let iteration = 0; iteration < 15; iteration++) {
    const p = first.point(t),
      q = second.point(u);
    const dx = (p[0] - q[0]) * scale,
      dy = p[1] - q[1];
    if (Math.hypot(dx, dy) < 1e-11) {
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
      return {
        t: Math.max(0, Math.min(1, t)),
        u: Math.max(0, Math.min(1, u)),
        point: p,
      };
    }
    const h = 1e-5;
    const pa = first.point(t - h),
      pb = first.point(t + h);
    const qa = second.point(u - h),
      qb = second.point(u + h);
    const x1 = ((pb[0] - pa[0]) * scale) / (2 * h),
      y1 = (pb[1] - pa[1]) / (2 * h);
    const x2 = ((qb[0] - qa[0]) * scale) / (2 * h),
      y2 = (qb[1] - qa[1]) / (2 * h);
    const determinant = x1 * y2 - y1 * x2;
    if (Math.abs(determinant) < 1e-20) return null;
    t -= (dx * y2 - dy * x2) / determinant;
    u -= (dx * y1 - dy * x1) / determinant;
    if (Math.abs(t) > 2 || Math.abs(u) > 2) return null;
  }
  throw new Error('Geodesic intersection did not converge');
}

export function geodesicWorkingCoordinates(points, check = () => {}) {
  const result = points.length ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    if (i % 1024 === 0) check();
    const a = points[i - 1],
      b = points[i];
    // Conservative angular estimate avoids constructing a geodesic for the
    // millions of already short source segments. Subdivision is broad phase only.
    const estimate = Math.hypot(b[0] - a[0], b[1] - a[1]) * 112000;
    if (estimate > 1000) {
      const line = geodesicSegment(a, b),
        count = Math.ceil(line.length / 1000);
      for (let j = 1; j < count; j++) result.push(line.point(j / count));
    }
    result.push(b);
  }
  return result;
}
