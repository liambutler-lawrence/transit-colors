import fs from 'node:fs';
import geographicLib from 'geographiclib-geodesic';
import {
  averageReciprocalPathCoordinates,
  buildOsmHighwayCenterlines,
  buildAveragedMainlines,
} from './osm-highway-network.mjs';
const earth = geographicLib.Geodesic.WGS84;
const read = (name) => JSON.parse(fs.readFileSync(`scripts/fixtures/${name}.json`));
const cases = [];
function add(name, kind, note, first, second, current, fixture, synthetic = false) {
  const origin = first[0];
  const project = (p) => {
    const g = earth.Inverse(origin[1], origin[0], p[1], p[0]);
    const angle = (g.azi1 * Math.PI) / 180;
    return [g.s12 * Math.sin(angle), g.s12 * Math.cos(angle)];
  };
  let a = first.map(project),
    b = second.map(project);
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  if (d(a[0], b[0]) + d(a.at(-1), b.at(-1)) > d(a[0], b.at(-1)) + d(a.at(-1), b[0]))
    b.reverse();
  cases.push({
    name,
    kind,
    note,
    fixture,
    synthetic,
    origin,
    first: a,
    second: b,
    current: current.map((line) => line.map(project)),
  });
}
function ramp(name, kind, note, f, fixture) {
  const first = f.firstCoordinates ?? f.first,
    second = f.secondCoordinates ?? f.second,
    start = f.startCoordinate ?? f.start,
    end = f.endCoordinate ?? f.end;
  add(
    name,
    kind,
    note,
    first,
    second,
    [averageReciprocalPathCoordinates(first, second, start, end)],
    fixture,
  );
}
const curves = read('ramp-curve-correspondence').cases;
ramp(
  'Sugarloaf · east movement',
  'Sweeping ramp bend',
  'The bend previously showed a tangent-cutoff kink. Source paths include mainline continuation at staggered joins.',
  curves['sugarloaf-east'],
  'ramp-curve-correspondence.json / sugarloaf-east',
);
ramp(
  'Sugarloaf · west movement',
  'Loop versus direct ramp',
  'Opposite directions take very different paths; a close point can lie on a different part of the loop.',
  curves['sugarloaf-west'],
  'ramp-curve-correspondence.json / sugarloaf-west',
);
ramp(
  'Seattle · short attachment',
  'Short merge attachment',
  'Tests behavior near the endpoints as well as the interior curve.',
  curves.seattle,
  'ramp-curve-correspondence.json / seattle',
);
ramp(
  'Brewster · asymmetric loop',
  'Asymmetric reciprocal ramps',
  'One side is much longer than the other; look for nearest matches jumping across the loop.',
  read('brewster-ramp-midpoints'),
  'brewster-ramp-midpoints.json',
);
for (const [i, label] of [
  'New Jersey · short collector',
  'Wisconsin · collector loop',
].entries())
  ramp(
    label,
    'Collector / distributor',
    'The saved source paths already include continuation along the mainline where the joins are staggered.',
    read('short-collector-midpoints').curves[i],
    `short-collector-midpoints.json / ${i}`,
  );
for (const f of read('ramp-attachment-overhangs').cases)
  ramp(
    f.name,
    'Staggered attachment',
    'The current algorithm preserves graph attachment endpoints. The experiment does not force or warp its endpoints to those nodes.',
    f,
    `ramp-attachment-overhangs.json / ${f.name}`,
  );
for (const [file, name, note] of [
  [
    'monteagle-carriageways',
    'I-24 · Monteagle',
    'Widely separated mountain carriageways with several winding bends.',
  ],
  [
    'coachochitlan-carriageways',
    'Coachochitlán · divided highway',
    'A wide median section that previously appeared as a gap.',
  ],
  [
    'memphis-curved-carriageways',
    'Memphis · Sam Cooper Boulevard',
    'Curved mainline pair with unequal source extents. One source continues beyond the available opposite side: current pairing stops, while unrestricted nearest matching keeps using the opposite endpoint.',
  ],
]) {
  const f = read(file),
    result = buildOsmHighwayCenterlines({ nodes: new Map(f.nodes), ways: f.ways });
  const selected = file.startsWith('memphis')
    ? result.chains.filter((c) => ['chain-1', 'chain-4'].includes(c.id))
    : result.chains;
  const current = result.parts
    .filter(
      (p) =>
        p.role === 'mainline' &&
        (!file.startsWith('memphis') || p.sourceChainId === 'chain-1'),
    )
    .map((p) => p.coordinates);
  add(
    name,
    'Mainline',
    note,
    selected[0].coordinates,
    selected[1].coordinates,
    current,
    file + '.json',
  );
}
const ll = (p) => [-90 + p[0] / 111320, p[1] / 110574];
for (const [name, kind, a, b] of [
  [
    'Parallel straight roads',
    'Synthetic control',
    [
      [0, 0],
      [2000, 0],
    ],
    [
      [0, 50],
      [2000, 50],
    ],
  ],
  [
    'Concentric 120° bend',
    'Synthetic control',
    Array.from({ length: 81 }, (_, i) => [
      400 * Math.cos((i * Math.PI) / 120),
      400 * Math.sin((i * Math.PI) / 120),
    ]),
    Array.from({ length: 81 }, (_, i) => [
      470 * Math.cos((i * Math.PI) / 120),
      470 * Math.sin((i * Math.PI) / 120),
    ]),
  ],
  [
    'Widening S-bend',
    'Synthetic stress case',
    Array.from({ length: 101 }, (_, i) => [
      i * 20,
      150 * Math.sin((i / 100) * Math.PI * 2),
    ]),
    Array.from({ length: 101 }, (_, i) => [
      i * 20,
      150 * Math.sin((i / 100) * Math.PI * 2) +
        40 +
        150 * Math.sin((i / 100) * Math.PI) ** 2,
    ]),
  ],
]) {
  const first = a.map(ll),
    second = b.map(ll),
    chains = [
      { id: 'a', coordinates: first, sourceWayIds: ['a'], tokens: new Set(['A']) },
      {
        id: 'b',
        coordinates: second.toReversed(),
        sourceWayIds: ['b'],
        tokens: new Set(['A']),
      },
    ];
  add(
    name,
    kind,
    'Constructed control, not an observed interchange. Current output is generated by the production mainline builder.',
    first,
    second,
    buildAveragedMainlines(chains).parts.map((p) => p.coordinates),
    'generated',
    true,
  );
}
fs.writeFileSync(
  'data/midpoint-comparison.json',
  JSON.stringify({
    description:
      'Frozen source pairs; current outputs regenerated from production algorithms. WGS84 azimuthal-equidistant local metric projection for the experiment.',
    cases,
  }) + '\n',
);
console.log(`Built ${cases.length} comparisons`);
