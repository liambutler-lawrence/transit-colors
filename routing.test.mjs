import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WALKING_METERS_PER_MINUTE,
  assignNearestStations,
  attachScheduleGraph,
  buildTransitGraph,
  calculateTransitTimes,
  distanceMeters,
  scheduledWaitForService,
  scheduledWaitForStation,
  streetTravelTime,
  timeScaleStops,
} from './routing.js';

function station(id, name, mode, coordinates, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      id,
      name,
      mode,
      status: 'open',
      ...extra,
    },
  };
}

const stations = [
  station('a', 'Alpha', 'subway', [-99.14, 19.43]),
  station('b', 'Bravo', 'subway', [-99.13, 19.43]),
  station('c', 'Central', 'subway', [-99.12, 19.43]),
  station('c-brt', 'Central', 'brt', [-99.1199, 19.4301]),
  station('d', 'Delta', 'brt', [-99.11, 19.43], { route_ref: 'L1' }),
];

assert.ok(Math.abs(distanceMeters(stations[0].geometry.coordinates, stations[1].geometry.coordinates) - 1_050) < 30);

assert.deepEqual(timeScaleStops(10), {
  yellowMinutes: 10,
  orangeMinutes: 20,
  redMinutes: 40,
});
assert.deepEqual(timeScaleStops(45), {
  yellowMinutes: 45,
  orangeMinutes: 90,
  redMinutes: 180,
});

const schedules = {
  stations: {
    a: {
      r: ['line-1'],
      p: {
        'line-1/0': [
          [[300, 600, 20]],
          [],
          [],
          [],
          [],
          [],
          [],
        ],
      },
      d: [
        [[300, 600, 10]],
        [],
        [],
        [],
        [],
        [],
        [],
      ],
    },
    overnight: {
      r: ['night-line'],
      d: [
        [],
        [],
        [],
        [],
        [],
        [],
        [[1_440, 1_740, 12]],
      ],
    },
  },
};
assert.deepEqual(scheduledWaitForStation(schedules, 'a', 0, 360), {
  minutes: 5,
  scheduled: true,
  routeCount: 1,
});
assert.equal(scheduledWaitForStation(schedules, 'a', 0, 280).minutes, 20);
assert.equal(scheduledWaitForStation(schedules, 'overnight', 0, 60).minutes, 6);
assert.equal(scheduledWaitForStation(schedules, 'missing', 0, 360).minutes, 4);
assert.deepEqual(scheduledWaitForService(schedules, 'a', 'line-1/0', 0, 360), {
  minutes: 10,
  scheduled: true,
  routeCount: 1,
});

const streets = [
  {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-99.1402, 19.4299],
        [-99.1402, 19.4301],
      ],
    },
    properties: { d: 20 },
  },
];

await assignNearestStations(streets, stations, {
  batchSize: 1,
  yieldControl: async () => {},
});
assert.equal(streets[0].properties.s, 'a');
assert.ok(streets[0].properties.d < 30);
assert.equal(streets[0].properties.s2, 'b');

const graph = buildTransitGraph(stations);
const transitTimes = calculateTransitTimes(graph, 'd', {
  waitMinutesByStation: new Map([['a', 12]]),
});
assert.equal(transitTimes.get('d'), 0);
assert.ok(transitTimes.get('a') > transitTimes.get('c-brt'));

const trip = streetTravelTime(streets[0].properties, transitTimes);
assert.equal(trip.walkingMinutes, streets[0].properties.d / WALKING_METERS_PER_MINUTE);
assert.ok(trip.totalMinutes > trip.walkingMinutes);

const scheduledGraph = attachScheduleGraph(buildTransitGraph(stations), {
  graph: {
    e: {
      a: [['b', 5, 'line-a/0']],
      b: [
        ['c', 5, 'line-a/0'],
        ['d', 4, 'line-b/0'],
      ],
    },
    t: {},
  },
});
const waitMinutesByService = new Map([
  ['a\u0000line-a/0', 2],
  ['b\u0000line-a/0', 2],
  ['b\u0000line-b/0', 7],
]);
const scheduledTimes = calculateTransitTimes(scheduledGraph, 'd', {
  waitMinutesByService,
});
assert.equal(scheduledTimes.get('d'), 0);
assert.equal(scheduledTimes.get('b'), 11);
assert.equal(scheduledTimes.get('a'), 18);
assert.equal(scheduledTimes.serviceByStation.get('a'), 'line-a/0');

const multiDestinationTimes = calculateTransitTimes(scheduledGraph, ['c', 'd'], {
  waitMinutesByService,
});
assert.equal(multiDestinationTimes.get('c'), 0);
assert.equal(multiDestinationTimes.get('d'), 0);
assert.equal(multiDestinationTimes.get('a'), 12);

const multiAccessStreet = {
  s: 'a',
  d: 20,
  s2: 'b',
  d2: 80,
};
const bestAccess = streetTravelTime(multiAccessStreet, scheduledTimes);
assert.equal(bestAccess.stationId, 'b');
assert.equal(bestAccess.distance, 80);

// Regression for the original audit: Bedford Av is one continuous L-train
// ride from the Union Square complex, not a disconnected cross-network trip.
const nycStations = JSON.parse(
  await readFile(new URL('./data/nyc-stations.geojson', import.meta.url), 'utf8'),
);
const nycSchedules = JSON.parse(
  await readFile(new URL('./data/nyc-schedules.json', import.meta.url), 'utf8'),
);
assert.ok(
  nycSchedules.graph.e['gtfs/mta-subway/L08'].some(
    ([toStationId, , serviceKey]) =>
      toStationId === 'gtfs/mta-subway/L06' && serviceKey === 'mta-subway/L/0',
  ),
);
const nycGraph = attachScheduleGraph(
  buildTransitGraph(nycStations.features),
  nycSchedules,
);
const nycWaitsByStation = new Map();
const nycWaitsByService = new Map();
for (const node of nycGraph.nodes) {
  nycWaitsByStation.set(
    node.id,
    scheduledWaitForStation(nycSchedules, node.id, 1, 16 * 60 + 38).minutes,
  );
  for (const serviceKey of nycGraph.scheduleGraph.servicesByStation.get(node.id)) {
    nycWaitsByService.set(
      `${node.id}\u0000${serviceKey}`,
      scheduledWaitForService(
        nycSchedules,
        node.id,
        serviceKey,
        1,
        16 * 60 + 38,
      ).minutes,
    );
  }
}
const unionSquareIds = nycStations.features
  .filter(
    (feature) =>
      feature.properties.mode === 'subway' &&
      feature.properties.name === '14 St-Union Sq',
  )
  .map((feature) => feature.properties.id);
assert.deepEqual(unionSquareIds.sort(), [
  'gtfs/mta-subway/635',
  'gtfs/mta-subway/L03',
  'gtfs/mta-subway/R20',
]);
const unionSquareTimes = calculateTransitTimes(nycGraph, unionSquareIds, {
  waitMinutesByStation: nycWaitsByStation,
  waitMinutesByService: nycWaitsByService,
});
const firstAvenueMinutes = unionSquareTimes.get('gtfs/mta-subway/L06');
const bedfordMinutes = unionSquareTimes.get('gtfs/mta-subway/L08');
assert.ok(bedfordMinutes < 15);
assert.ok(bedfordMinutes - firstAvenueMinutes < 6);

console.log('routing tests passed');
