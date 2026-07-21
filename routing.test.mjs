import assert from 'node:assert/strict';
import {
  WALKING_METERS_PER_MINUTE,
  assignNearestStations,
  bestStreetTravelTime,
  buildTransitGraph,
  calculateTransitTimes,
  distanceMeters,
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
await assignNearestStations(streets, stations, {
  batchSize: 1,
  propertyKey: 'brtAccess',
  stationFilter: (feature) => feature.properties.mode === 'brt',
  yieldControl: async () => {},
});
assert.equal(streets[0].properties.brtAccess, 'c-brt');

const graph = buildTransitGraph(stations);
const transitTimes = calculateTransitTimes(graph, 'd', {
  waitMinutesByStation: new Map([['a', 12]]),
});
assert.equal(transitTimes.get('d'), 0);
assert.ok(transitTimes.get('a') > transitTimes.get('c-brt'));

const trip = streetTravelTime(streets[0].properties, transitTimes);
assert.equal(trip.walkingMinutes, streets[0].properties.d / WALKING_METERS_PER_MINUTE);
assert.ok(trip.totalMinutes > trip.walkingMinutes);

const bestTrip = bestStreetTravelTime(
  [
    { stationId: 'a', distanceMeters: 100, mode: 'subway' },
    { stationId: 'd', distanceMeters: 500, mode: 'brt' },
  ],
  new Map([
    ['a', 30],
    ['d', 5],
  ]),
);
assert.equal(bestTrip.stationId, 'd');
assert.equal(bestTrip.mode, 'brt');

const futureStation = station('future', 'Future', 'subway', [-99.1, 19.43], {
  status: 'construction',
});
assert.equal(buildTransitGraph([...stations, futureStation]).nodeById.has('future'), false);
assert.equal(
  buildTransitGraph([...stations, futureStation], { includeFuture: true }).nodeById.has(
    'future',
  ),
  true,
);

console.log('routing tests passed');
