import {
  nearestMidline,
  nearest,
  segmentIndex,
  samples,
  curve,
} from './nearest-midline.mjs';
self.onmessage = ({ data: { cases, spacing, id } }) => {
  for (const [index, item] of cases.entries()) {
    const result = nearestMidline(item.first, item.second, spacing);
    const current = segmentIndex(item.current);
    const deviations = result.coordinates
      .map((p) => Math.sqrt(nearest(p, current).squared))
      .sort((a, b) => a - b);
    const candidate = segmentIndex([result.coordinates]);
    const reverse = item.current
      .flatMap((points) => samples(curve(points), 5))
      .map(({ point }) => Math.sqrt(nearest(point, candidate).squared));
    result.p95Deviation = deviations[Math.floor(deviations.length * 0.95)];
    result.maxDeviation = Math.max(deviations.at(-1), ...reverse);
    self.postMessage({ id, index, result });
  }
};
