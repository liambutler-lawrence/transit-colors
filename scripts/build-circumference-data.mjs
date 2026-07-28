import { readFile, writeFile } from 'node:fs/promises';

import {
  activeCircumferenceLines,
  buildCircumferenceCandidates,
  candidateFromNetworkPath,
  filterCircumferenceNetwork,
} from '../src/circumference.ts';
import {
  isValidSimpleCircumferenceCycle,
  solveExactMaximumAreaCycle,
} from './exact-circumference-solver.mjs';

const areaKeys = process.argv.slice(2);
const selectedAreaKeys = areaKeys.length > 0 ? areaKeys : ['cdmx', 'nyc'];

function networkSegmentIds(network) {
  return new Set(network.segments.map((segment) => segment.id));
}

function isSubset(subset, superset) {
  return [...subset].every((value) => superset.has(value));
}

function scheduleTopologies(network, schedules) {
  const result = new Map();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let minute = 0; minute < 1_440; minute += 1) {
      const activeLines = activeCircumferenceLines(schedules, weekday, minute);
      const filteredNetwork = filterCircumferenceNetwork(network, activeLines);
      const key = [...networkSegmentIds(filteredNetwork)].sort().join('\u0000');
      if (!result.has(key)) {
        result.set(key, {
          activeLines,
          filteredNetwork,
          minute,
          weekday,
        });
      }
    }
  }
  return [...result.values()].sort(
    (first, second) =>
      second.filteredNetwork.segments.length - first.filteredNetwork.segments.length,
  );
}

async function exactSchedulePaths(areaKey, network, schedules, fullExact) {
  const exactProofs = [
    {
      edgeIds: networkSegmentIds(network),
      nodeIds: fullExact.nodeIds,
    },
  ];
  const noCycleProofs = [];
  const exactPaths = [fullExact.nodeIds];
  const topologies = scheduleTopologies(network, schedules);
  console.log(`${areaKey}: ${topologies.length} distinct weekly service topologies`);

  for (const [topologyIndex, topology] of topologies.entries()) {
    const edgeIds = networkSegmentIds(topology.filteredNetwork);
    const inheritedProof = exactProofs.find(
      (proof) =>
        isSubset(edgeIds, proof.edgeIds) &&
        isValidSimpleCircumferenceCycle(topology.filteredNetwork, proof.nodeIds),
    );
    if (inheritedProof) continue;
    if (noCycleProofs.some((proofEdgeIds) => isSubset(edgeIds, proofEdgeIds))) {
      continue;
    }

    const label =
      `${areaKey}: schedule topology ${topologyIndex + 1}/${topologies.length} ` +
      `(weekday ${topology.weekday}, ${String(Math.floor(topology.minute / 60)).padStart(2, '0')}:${String(topology.minute % 60).padStart(2, '0')}, ` +
      `${topology.activeLines?.size ?? 0} lines)`;
    console.time(label);
    try {
      const exact = await solveExactMaximumAreaCycle(topology.filteredNetwork);
      exactProofs.push({ edgeIds, nodeIds: exact.nodeIds });
      exactPaths.push(exact.nodeIds);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Exact circumference solve found no valid cycle.'
      ) {
        noCycleProofs.push(edgeIds);
      } else {
        throw error;
      }
    } finally {
      console.timeEnd(label);
    }
  }

  return exactPaths;
}

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

  const scheduleExactPaths = await exactSchedulePaths(
    areaKey,
    generated.geometryVariants.straight.network,
    schedules,
    exact,
  );
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
  const uniqueScheduleExactPaths = scheduleExactPaths.filter(
    (nodeIds, index, paths) => {
      const candidateId = candidateFromNetworkPath(
        generated.geometryVariants.straight.network,
        nodeIds,
        { useTrackGeometry: false },
      ).id;
      return (
        paths.findIndex(
          (candidatePath) =>
            candidateFromNetworkPath(
              generated.geometryVariants.straight.network,
              candidatePath,
              { useTrackGeometry: false },
            ).id === candidateId,
        ) === index
      );
    },
  );
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
      scheduleCandidates: uniqueScheduleExactPaths.map((nodeIds) =>
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
