// Subtract a node potential from each edge cost to reduce numerical cancellation.
// Potentials telescope to zero around every closed cycle, so this changes neither
// its area nor the optimizer's preference for any road or connector.
export function balancedHighwayAreaCoefficients(nodes, arcs) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const edges = arcs
    .filter((_, i) => i % 2 === 0)
    .map((arc) => [index.get(arc.fromId), index.get(arc.toId), arc.area]);
  const size = nodes.length,
    potential = new Float64Array(size),
    residual = new Float64Array(size);
  for (const [a, b, c] of edges) {
    residual[a] -= c;
    residual[b] += c;
  }
  const direction = residual.slice();
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  let norm = dot(residual, residual);
  const tolerance = Math.max(1e-12, norm * 1e-16);
  for (let iteration = 0; iteration < 2000 && norm > tolerance; iteration++) {
    const product = new Float64Array(size);
    for (const [a, b] of edges) {
      const value = direction[a] - direction[b];
      product[a] += value;
      product[b] -= value;
    }
    const denominator = dot(direction, product);
    if (denominator <= 0) break;
    const alpha = norm / denominator;
    for (let i = 0; i < size; i++) {
      potential[i] += alpha * direction[i];
      residual[i] -= alpha * product[i];
    }
    const next = dot(residual, residual),
      beta = next / norm;
    for (let i = 0; i < size; i++) direction[i] = residual[i] + beta * direction[i];
    norm = next;
  }
  return arcs.map(
    (arc) =>
      arc.area + potential[index.get(arc.fromId)] - potential[index.get(arc.toId)],
  );
}
