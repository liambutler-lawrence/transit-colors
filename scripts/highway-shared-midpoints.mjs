import { orderedCarriagewayMidpoints } from './highway-ordered-midpoint.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { createHash } from 'node:crypto';

const append = (to, points) => {
  for (const p of points)
    if (!to.length || p[0] !== to.at(-1)[0] || p[1] !== to.at(-1)[1]) to.push(p);
};
const edgeKey = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

// Reuse only two explicitly shared source sequences. Geographic proximity
// never identifies a shared road or establishes a junction.
export function sharedRampMidpoints(movements, average) {
  const owners = new Map(),
    paths = [];
  for (const [movement, entry] of movements.entries())
    for (const [side, path] of [entry.first, entry.second].entries()) {
      const row = { movement, side, ...path, keys: [] };
      paths.push(row);
      for (let i = 1; i < path.nodeIds.length; i++) {
        const a = path.nodeIds[i - 1],
          b = path.nodeIds[i];
        const key = a && b && a !== b ? edgeKey(a, b) : null;
        row.keys.push(key);
        if (!key) continue;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(movement);
      }
    }
  const runs = new Map();
  for (const path of paths) {
    for (let start = 0; start < path.keys.length;) {
      const members = [...(owners.get(path.keys[start]) ?? [])].sort((a, b) => a - b);
      if (members.length < 2) {
        start++;
        continue;
      }
      const signature = members.join(',');
      let end = start + 1;
      while (
        end < path.keys.length &&
        [...(owners.get(path.keys[end]) ?? [])].sort((a, b) => a - b).join(',') ===
          signature
      )
        end++;
      const nodes = path.nodeIds.slice(start, end + 1);
      const forward = JSON.stringify(nodes),
        backward = JSON.stringify(nodes.toReversed());
      const reverse = backward < forward;
      const key = reverse ? backward : forward;
      const coordinates = path.coordinates.slice(start, end + 1);
      if (!runs.has(key))
        runs.set(key, {
          key,
          members,
          signature,
          coordinates: reverse ? coordinates.toReversed() : coordinates,
          occurrences: [],
        });
      runs.get(key).occurrences.push({
        movement: path.movement,
        side: path.side,
        start,
        end,
        reverse,
      });
      start = end;
    }
  }
  const groups = new Map();
  for (const run of runs.values()) {
    if (!groups.has(run.signature)) groups.set(run.signature, []);
    groups.get(run.signature).push(run);
  }
  const sections = movements.map(() => []);
  const statistics = { sharedSections: 0, reusedMovements: 0, conflictingSections: 0 };
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i],
          b = group[j];
        const occurrences = a.members.map((m) => [
          a.occurrences.find((o) => o.movement === m),
          b.occurrences.find((o) => o.movement === m),
        ]);
        if (occurrences.some(([x, y]) => !x || !y || x.side === y.side)) continue;
        const [x, y] = occurrences[0];
        const first = (x.side === 0 ? a : b).coordinates;
        const second = (x.side === 0 ? b : a).coordinates;
        const firstReverse = (x.side === 0 ? x : y).reverse;
        const secondReverse = (x.side === 0 ? y : x).reverse;
        const aa = firstReverse ? first.toReversed() : first;
        const bb = secondReverse ? second.toReversed() : second;
        // Opposing shared runs may be staggered, but their overlapping pavement
        // must agree with this orientation. Reject distant unrelated runs.
        const distance = (p, line) => {
          const scale = Math.cos((p[1] * Math.PI) / 180);
          let best = Infinity,
            point;
          for (let k = 1; k < line.length; k++) {
            const a = line[k - 1],
              b = line[k],
              dx = (b[0] - a[0]) * scale,
              dy = b[1] - a[1];
            const t = Math.max(
              0,
              Math.min(
                1,
                ((p[0] - a[0]) * scale * dx + (p[1] - a[1]) * dy) /
                  (dx * dx + dy * dy || 1),
              ),
            );
            const q = a.map((v, j) => v + t * (b[j] - v)),
              d = ((p[0] - q[0]) * scale) ** 2 + (p[1] - q[1]) ** 2;
            if (d < best) {
              best = d;
              point = q;
            }
          }
          return geodesicDistanceMeters(p, point);
        };
        if (
          Math.min(
            ...[0, 0.25, 0.5, 0.75, 1].map((t) =>
              distance(aa[Math.round(t * (aa.length - 1))], bb),
            ),
          ) > 160
        )
          continue;
        const result = orderedCarriagewayMidpoints(aa, bb);
        if (!result) continue;
        // A shared run reaching a movement terminal inherits its already
        // computed mainline attachment. Otherwise its raw midpoint could pass
        // that attachment, then reverse back to it at the final stitch.
        const fixedStart = [],
          fixedEnd = [];
        for (const [u, v] of occurrences) {
          const f = u.side === 0 ? u : v,
            s = u.side === 0 ? v : u,
            entry = movements[u.movement];
          const reversed = f.reverse !== (u.side === 0 ? x.reverse : y.reverse);
          if (f.start === 0 && s.start === 0)
            (reversed ? fixedEnd : fixedStart).push(entry.start);
          if (
            f.end === entry.first.nodeIds.length - 1 &&
            s.end === entry.second.nodeIds.length - 1
          )
            (reversed ? fixedStart : fixedEnd).push(entry.end);
        }
        if (
          [fixedStart, fixedEnd].some((points) =>
            points.some((p) => p.join() !== points[0].join()),
          )
        ) {
          statistics.conflictingSections++;
          continue;
        }
        const sharedCoordinates =
          fixedStart.length || fixedEnd.length
            ? average(
                aa,
                bb,
                fixedStart[0] ?? result.coordinates[0],
                fixedEnd[0] ?? result.coordinates.at(-1),
              )
            : result.coordinates;
        const id = `shared-ramp:${createHash('sha256').update(`${a.key}|${b.key}`).digest('hex')}`;
        if (
          occurrences.some(([u, v]) => {
            const f = u.side === 0 ? u : v,
              s = u.side === 0 ? v : u;
            return sections[u.movement].some(
              (p) =>
                (f.start < p.end0 && f.end > p.start0) ||
                (s.start < p.end1 && s.end > p.start1),
            );
          })
        ) {
          statistics.conflictingSections++;
          continue;
        }
        let used = 0;
        for (const [u, v] of occurrences) {
          const f = u.side === 0 ? u : v,
            s = u.side === 0 ? v : u;
          const reference = u.side === 0 ? x.reverse : y.reverse;
          const reversed = f.reverse !== reference;
          const list = sections[u.movement];
          list.push({
            id,
            start0: f.start,
            end0: f.end,
            start1: s.start,
            end1: s.end,
            coordinates: reversed ? sharedCoordinates.toReversed() : sharedCoordinates,
          });
          used++;
        }
        if (used > 1) {
          statistics.sharedSections++;
          statistics.reusedMovements += used;
        }
      }
  }
  const results = movements.map((entry, i) => {
    const pieces = sections[i].sort((a, b) => a.start0 - b.start0);
    if (!pieces.length)
      return {
        coordinates: average(
          entry.first.coordinates,
          entry.second.coordinates,
          entry.start,
          entry.end,
        ),
        sharedSections: [],
      };
    const coordinates = [];
    let start0 = 0,
      start1 = 0,
      start = entry.start;
    for (const piece of pieces) {
      if (piece.start1 < start1)
        throw Error('Shared source sections change movement order');
      const end = piece.coordinates[0];
      append(
        coordinates,
        average(
          entry.first.coordinates.slice(start0, piece.start0 + 1),
          entry.second.coordinates.slice(start1, piece.start1 + 1),
          start,
          end,
        ),
      );
      append(coordinates, piece.coordinates);
      start0 = piece.end0;
      start1 = piece.end1;
      start = piece.coordinates.at(-1);
    }
    append(
      coordinates,
      average(
        entry.first.coordinates.slice(start0),
        entry.second.coordinates.slice(start1),
        start,
        entry.end,
      ),
    );
    return {
      coordinates,
      sharedSections: pieces.map(({ id, coordinates }) => ({ id, coordinates })),
    };
  });
  return { results, statistics };
}
