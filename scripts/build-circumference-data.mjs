import { readFile, writeFile } from 'node:fs/promises';

import {
  activeCircumferenceService,
  buildCircumferenceCandidates,
  candidateFromNetworkPath,
  filterCircumferenceNetwork,
  selectIndependentCircumferenceCandidates,
} from '../src/circumference.ts';
import {
  isValidSimpleCircumferenceCycle,
  solveExactMaximumAreaCycle,
} from './exact-circumference-solver.mjs';

const areaKeys = process.argv.slice(2);
const supportedAreaKeys = ['cdmx', 'nyc', 'singapore', 'atlanta', 'athens'];
const selectedAreaKeys = areaKeys.length > 0 ? areaKeys : supportedAreaKeys;
const independentCompositeLimits = {
  singapore: 2,
};
const nativeCircularLines = {
  singapore: new Set(['CC']),
};

function networkSegmentIds(network) {
  return new Set(network.segments.map((segment) => segment.id));
}

function isSubset(subset, superset) {
  return [...subset].every((value) => superset.has(value));
}

function segmentEdgeKey(segment) {
  return [segment.from.id, segment.to.id].sort().join('\u0000');
}

function networkWithoutCycleRideSegments(network, nodeIds) {
  const segmentByEdge = new Map(
    network.segments.map((segment) => [segmentEdgeKey(segment), segment]),
  );
  const removedRideEdges = new Set();
  for (const [index, fromId] of nodeIds.entries()) {
    const toId = nodeIds[(index + 1) % nodeIds.length];
    const segment = segmentByEdge.get([fromId, toId].sort().join('\u0000'));
    if (segment?.type === 'ride') removedRideEdges.add(segmentEdgeKey(segment));
  }
  return {
    stations: network.stations,
    segments: network.segments.filter(
      (segment) =>
        segment.type !== 'ride' || !removedRideEdges.has(segmentEdgeKey(segment)),
    ),
  };
}

function scheduleTopologies(network, schedules) {
  const result = new Map();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let minute = 0; minute < 1_440; minute += 1) {
      const activeService = activeCircumferenceService(schedules, weekday, minute);
      const filteredNetwork = filterCircumferenceNetwork(network, activeService);
      const key = [...networkSegmentIds(filteredNetwork)].sort().join('\u0000');
      if (!result.has(key)) {
        result.set(key, {
          activeService,
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

async function exactIndependentPaths(
  areaKey,
  network,
  { exactProofs, label, maximumPathCount = 1, noCycleProofs, onIteration },
) {
  const paths = [];
  let remainingNetwork = network;
  let rank = 1;

  while (paths.length < maximumPathCount) {
    const edgeIds = networkSegmentIds(remainingNetwork);
    const inheritedProof = exactProofs.find(
      (proof) =>
        isSubset(edgeIds, proof.edgeIds) &&
        isValidSimpleCircumferenceCycle(remainingNetwork, proof.nodeIds),
    );
    if (inheritedProof) {
      paths.push(inheritedProof.nodeIds);
      remainingNetwork = networkWithoutCycleRideSegments(
        remainingNetwork,
        inheritedProof.nodeIds,
      );
      rank += 1;
      continue;
    }
    if (noCycleProofs.some((proofEdgeIds) => isSubset(edgeIds, proofEdgeIds))) {
      break;
    }

    const solveLabel = `${areaKey}: ${label} independent circle ${rank}`;
    console.time(solveLabel);
    try {
      const exact = await solveExactMaximumAreaCycle(remainingNetwork, {
        onIteration,
      });
      exactProofs.push({ ...exact, edgeIds });
      paths.push(exact.nodeIds);
      remainingNetwork = networkWithoutCycleRideSegments(
        remainingNetwork,
        exact.nodeIds,
      );
      rank += 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Exact circumference solve found no valid cycle.'
      ) {
        noCycleProofs.push(edgeIds);
        break;
      }
      throw error;
    } finally {
      console.timeEnd(solveLabel);
    }
  }

  return paths;
}

async function exactSingleLinePaths(areaKey, network, lineNames) {
  const paths = [];

  for (const lineName of [...lineNames].sort()) {
    const segments = network.segments.filter(
      (segment) => segment.type === 'ride' && segment.lines.includes(lineName),
    );
    const stationIds = new Set(
      segments.flatMap((segment) => [segment.from.id, segment.to.id]),
    );
    const lineNetwork = {
      stations: network.stations.filter((station) => stationIds.has(station.id)),
      segments,
    };
    try {
      const exact = await solveExactMaximumAreaCycle(lineNetwork);
      paths.push(exact.nodeIds);
      console.log(
        `${areaKey}: ${lineName} native circle ${(exact.areaSquareMeters / 1_000_000).toFixed(3)} km²`,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Exact circumference solve found no valid cycle.'
      ) {
        throw error;
      }
    }
  }

  return paths;
}

async function exactSchedulePaths(
  areaKey,
  network,
  schedules,
  exactProofs,
  maximumPathCount,
  noCycleProofs,
) {
  const exactPaths = exactProofs.map((proof) => proof.nodeIds);
  const topologies = scheduleTopologies(network, schedules);
  console.log(`${areaKey}: ${topologies.length} distinct weekly service topologies`);

  for (const [topologyIndex, topology] of topologies.entries()) {
    const label =
      `${areaKey}: schedule topology ${topologyIndex + 1}/${topologies.length} ` +
      `(weekday ${topology.weekday}, ${String(Math.floor(topology.minute / 60)).padStart(2, '0')}:${String(topology.minute % 60).padStart(2, '0')}, ` +
      `${topology.activeService?.lineNames.size ?? 0} lines)`;
    exactPaths.push(
      ...(await exactIndependentPaths(areaKey, topology.filteredNetwork, {
        exactProofs,
        label,
        maximumPathCount,
        noCycleProofs,
      })),
    );
  }

  return exactPaths;
}

for (const areaKey of selectedAreaKeys) {
  if (!supportedAreaKeys.includes(areaKey)) {
    throw new Error(`Unknown circumference area: ${areaKey}`);
  }
  const [stations, schedules] = await Promise.all([
    readFile(new URL(`../data/${areaKey}-stations.geojson`, import.meta.url), 'utf8'),
    readFile(new URL(`../data/${areaKey}-schedules.json`, import.meta.url), 'utf8'),
  ]).then((files) => files.map((file) => JSON.parse(file)));

  console.time(`${areaKey}: network and alternatives`);
  const generated = buildCircumferenceCandidates(stations.features, schedules);
  console.timeEnd(`${areaKey}: network and alternatives`);

  // MARTA Rail is a branched cross: its colored services share long trunks but
  // do not form a geographically meaningful closed passenger route. Preserve
  // and display its complete network without manufacturing a zero-area loop
  // from parallel services on the same tracks.
  if (areaKey === 'atlanta') {
    const geometryVariants = Object.fromEntries(
      Object.entries(generated.geometryVariants).map(([mode, variant]) => [
        mode,
        {
          ...variant,
          candidates: [],
          routeCandidates: [],
          scheduleCandidates: [],
        },
      ]),
    );
    const outputUrl = new URL(`../data/${areaKey}-circumference.json`, import.meta.url);
    await writeFile(outputUrl, `${JSON.stringify(geometryVariants)}\n`);
    console.log(`Wrote ${outputUrl.pathname} (complete network; no closed loop)`);
    continue;
  }

  const exactProofs = [];
  const noCycleProofs = [];
  const maximumPathCount = independentCompositeLimits[areaKey] ?? 1;
  const fullExactPaths = await exactIndependentPaths(
    areaKey,
    generated.geometryVariants.straight.network,
    {
      exactProofs,
      label: 'full network',
      maximumPathCount,
      noCycleProofs,
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
  const exact = exactProofs[0];
  if (!exact || fullExactPaths.length === 0) {
    throw new Error(
      `${areaKey}: the exact solver did not return a full-network cycle.`,
    );
  }
  const singleLinePaths = await exactSingleLinePaths(
    areaKey,
    generated.geometryVariants.straight.network,
    nativeCircularLines[areaKey] ?? new Set(),
  );
  const nativeCircularCandidateIds = new Set(
    singleLinePaths.map(
      (nodeIds) =>
        candidateFromNetworkPath(generated.geometryVariants.straight.network, nodeIds, {
          useTrackGeometry: false,
        }).id,
    ),
  );

  const scheduleExactPaths = await exactSchedulePaths(
    areaKey,
    generated.geometryVariants.straight.network,
    schedules,
    exactProofs,
    maximumPathCount,
    noCycleProofs,
  );
  scheduleExactPaths.push(...singleLinePaths);
  const exactStraightCandidate = candidateFromNetworkPath(
    generated.geometryVariants.straight.network,
    fullExactPaths[0],
    { useTrackGeometry: false },
  );
  const unsortedCandidatePaths = [
    ...fullExactPaths,
    ...singleLinePaths,
    ...generated.geometryVariants.straight.routeCandidates
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
  const candidatePaths = unsortedCandidatePaths
    .filter((nodeIds, index, paths) => {
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
    })
    .sort(
      (first, second) =>
        candidateFromNetworkPath(generated.geometryVariants.straight.network, second, {
          useTrackGeometry: false,
        }).areaSquareMeters -
        candidateFromNetworkPath(generated.geometryVariants.straight.network, first, {
          useTrackGeometry: false,
        }).areaSquareMeters,
    );
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
  const routeCandidatesByMode = {};
  for (const mode of ['track', 'straight']) {
    const baseVariant = generated.geometryVariants[mode];
    routeCandidatesByMode[mode] = candidatePaths.map((nodeIds) =>
      candidateFromNetworkPath(baseVariant.network, nodeIds, {
        independentCircleKind: nativeCircularCandidateIds.has(
          candidateFromNetworkPath(
            generated.geometryVariants.straight.network,
            nodeIds,
            { useTrackGeometry: false },
          ).id,
        )
          ? 'native-line'
          : undefined,
        useTrackGeometry: mode === 'track',
      }),
    );
  }
  const trackCandidateById = new Map(
    routeCandidatesByMode.track.map((candidate) => [candidate.id, candidate]),
  );
  const selectedCandidateIds = selectIndependentCircumferenceCandidates(
    routeCandidatesByMode.straight,
    { spatialCandidatesById: trackCandidateById },
  ).map((candidate) => candidate.id);
  const geometryVariants = {};
  for (const mode of ['track', 'straight']) {
    const baseVariant = generated.geometryVariants[mode];
    const routeCandidates = routeCandidatesByMode[mode];
    const candidateById = new Map(
      routeCandidates.map((candidate) => [candidate.id, candidate]),
    );
    const candidates = selectedCandidateIds.map((candidateId) => {
      const candidate = candidateById.get(candidateId);
      if (!candidate) {
        throw new Error(
          `${areaKey} ${mode} geometry is missing candidate ${candidateId}`,
        );
      }
      return candidate;
    });
    geometryVariants[mode] = {
      ...baseVariant,
      candidates,
      routeCandidates,
      scheduleCandidates: uniqueScheduleExactPaths.map((nodeIds) =>
        candidateFromNetworkPath(baseVariant.network, nodeIds, {
          independentCircleKind: nativeCircularCandidateIds.has(
            candidateFromNetworkPath(
              generated.geometryVariants.straight.network,
              nodeIds,
              { useTrackGeometry: false },
            ).id,
          )
            ? 'native-line'
            : undefined,
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
