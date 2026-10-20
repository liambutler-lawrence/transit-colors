import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

// Finalize source-derived identities after all midpoint geometry edits. Only
// explicitly identified connections may share a vertex; proximity alone never
// establishes connectivity. The 1 m bound is the existing metadata tolerance.
export function finalizeMidpointTopology(parts) {
  const parents = new Map();
  const locations = new Map();
  const owners = new Map();
  const byId = new Map(parts.map((p, i) => [p.id, i]));
  const root = (id) => {
    if (parents.get(id) !== id) parents.set(id, root(parents.get(id)));
    return parents.get(id);
  };
  const vertex = (i, v) => {
    const id = `${i}:${v}`;
    if (!parents.has(id)) {
      parents.set(id, id);
      locations.set(id, [i, v]);
    }
    return id;
  };
  const point = (id) => {
    const [i, v] = locations.get(id);
    return parts[i].coordinates[v];
  };
  const join = (a, b) => {
    if (geodesicDistanceMeters(point(a), point(b)) > 1)
      throw new Error(`Midpoint topology disagrees by more than 1 m: ${a}, ${b}.`);
    a = root(a);
    b = root(b);
    if (a !== b) parents.set(a < b ? b : a, a < b ? a : b);
  };
  const register = (key, id) => {
    if (owners.has(key)) join(owners.get(key), id);
    else owners.set(key, id);
  };
  const locate = (i, coordinate) => {
    const part = parts[i];
    if (!part || part.role !== 'mainline' || part.explicitMainlineMerge)
      throw new Error(`Missing parent midpoint ${i}.`);
    const exact = part.coordinates.findIndex(
      (point) => point[0] === coordinate[0] && point[1] === coordinate[1],
    );
    if (exact >= 0) return vertex(i, exact);
    let best = -1;
    let distance = Infinity;
    for (const [v, p] of part.coordinates.entries()) {
      const d = geodesicDistanceMeters(p, coordinate);
      if (d < distance) {
        best = v;
        distance = d;
      }
    }
    if (distance > 1)
      throw new Error(
        `Midpoint attachment missing on ${part.id}: ${distance.toFixed(3)} m.`,
      );
    return vertex(i, best);
  };
  const references = [];
  for (const [i, p] of parts.entries()) {
    if (p.role !== 'mainline' || p.explicitMainlineMerge) continue;
    for (const key of p.startTopologyKeys ?? []) register(key, vertex(i, 0));
    for (const key of p.endTopologyKeys ?? [])
      register(key, vertex(i, p.coordinates.length - 1));
    for (const entry of p.topologyCoordinates ?? []) {
      const id = locate(i, entry.coordinate);
      register(entry.key, id);
      references.push([entry, 'coordinate', id]);
    }
    for (const [neighbor, v, last] of [
      [p.continuationEndpoints?.beforeId, 0, true],
      [p.continuationEndpoints?.afterId, p.coordinates.length - 1, false],
    ]) {
      if (neighbor === undefined) continue;
      const j = byId.get(neighbor);
      if (j === undefined)
        throw new Error(`Missing midpoint continuation ${neighbor}.`);
      join(vertex(i, v), vertex(j, last ? parts[j].coordinates.length - 1 : 0));
    }
  }
  // Bind ramp endpoints before canonicalizing any shared mainline vertices.
  for (const p of parts) {
    if (p.role !== 'connector' && !p.explicitMainlineMerge) continue;
    for (const [side, v] of [
      ['start', 0],
      ['end', p.coordinates.length - 1],
    ]) {
      const id = locate(p[`${side}MainlinePartIndex`], p.coordinates[v]);
      references.push([p.coordinates, v, id]);
    }
  }
  for (const id of locations.keys()) {
    if (geodesicDistanceMeters(point(id), point(root(id))) > 1)
      throw new Error(`Transitive midpoint seam exceeds 1 m: ${id}.`);
  }
  for (const [id, [i, v]] of locations) {
    parts[i].coordinates[v] = point(root(id));
  }
  for (const [object, key, id] of references) object[key] = point(root(id));
  return parts;
}
