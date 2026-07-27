import { readFile, writeFile } from 'node:fs/promises';

import {
  buildCircumferenceCandidates,
  candidateFromNetworkPath,
} from '../src/circumference.ts';
import {
  isValidSimpleCircumferenceCycle,
  solveExactMaximumAreaCycle,
} from './exact-circumference-solver.mjs';

const areaKeys = process.argv.slice(2);
const selectedAreaKeys = areaKeys.length > 0 ? areaKeys : ['cdmx', 'nyc'];

for (const areaKey of selectedAreaKeys) {
  if (areaKey !== 'cdmx' && areaKey !== 'nyc') {
    throw new Error(`Unknown circumference area: ${areaKey}`);
  }
  const [stations, schedules] = await Promise.all([
    readFile(new URL(`../data/${areaKey}-stations.geojson`, import.meta.url), 'utf8'),
    readFile(new URL(`../data/${areaKey}-schedules.json`, import.meta.url), 'utf8'),
  ]).then((files) => files.map((file) => JSON.parse(file)));

  console.time(`${areaKey}: network and alternatives`);
  const generated = buildCircumferenceCandidates(stations.features, schedules);
  console.timeEnd(`${areaKey}: network and alternatives`);

  console.time(`${areaKey}: exact topology solve`);
  const exact = await solveExactMaximumAreaCycle(
    generated.geometryVariants.straight.network,
    {
      onIteration: ({
        iteration,
        objectiveSquareKilometers,
        crossingCutCount,
        rootCount,
        rootNumber,
      }) => {
        console.log(
          `${areaKey}: certificate root ${rootNumber}/${rootCount}, ` +
            `solve ${iteration}, ${objectiveSquareKilometers.toFixed(3)} km², ` +
            `${crossingCutCount} crossing exclusions`,
        );
      },
    },
  );
  console.timeEnd(`${areaKey}: exact topology solve`);

  const exactStraightCandidate = candidateFromNetworkPath(
    generated.geometryVariants.straight.network,
    exact.nodeIds,
    { useTrackGeometry: false },
  );
  const candidatePaths = [
    exact.nodeIds,
    ...generated.geometryVariants.straight.candidates
      .filter(
        (candidate) =>
          candidate.id !== exactStraightCandidate.id &&
          isValidSimpleCircumferenceCycle(
            generated.geometryVariants.straight.network,
            candidate.nodeIds,
          ),
      )
      .map((candidate) => candidate.nodeIds),
  ];
  const geometryVariants = {};
  for (const mode of ['track', 'straight']) {
    const baseVariant = generated.geometryVariants[mode];
    geometryVariants[mode] = {
      ...baseVariant,
      candidates: candidatePaths.map((nodeIds) =>
        candidateFromNetworkPath(baseVariant.network, nodeIds, {
          useTrackGeometry: mode === 'track',
        }),
      ),
      methodology: {
        ...baseVariant.methodology,
        optimizationGeometry: 'straight-platform-edges',
        optimizationIterations: exact.optimizationIterations,
        optimizationMethod: 'exact-milp',
        optimizationMilliseconds: exact.solveMilliseconds,
        optimizationStatus: 'optimal',
      },
    };
  }

  const outputUrl = new URL(`../data/${areaKey}-circumference.json`, import.meta.url);
  await writeFile(outputUrl, `${JSON.stringify(geometryVariants)}\n`);
  console.log(`Wrote ${outputUrl.pathname}`);
}
