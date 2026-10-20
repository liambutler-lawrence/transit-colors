import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildOsmHighwayCenterlines,
  classifyOsmMotorwayWay,
  parseOplLine,
  prepareWays,
  selectShortestAuxiliaryRampOptions,
} from './osm-highway-network.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

// Actual Osmium syntax, including the closing delimiter before route digits.
// https://osmcode.org/opl-file-format/#encoding
// URL-style escapes in the old test concealed corrupted names and refs.
test('OPL decodes complete Unicode escapes once without consuming following text', () => {
  const way = parseOplLine(
    'w474860255 Thighway=motorway,lanes=2,name=East%20%Beltway%20%Express%20%Lanes,ref=I%20%295,alt_name=%1f680%%20%%25%20%25%,note=a%2c%b%3d%c Nn1,n2',
  );
  assert.equal(way.tags.name, 'East Beltway Express Lanes');
  assert.equal(way.tags.ref, 'I 295');
  assert.equal(way.tags.alt_name, '🚀 %20%');
  assert.equal(way.tags.note, 'a,b=c');
  assert.equal(classifyOsmMotorwayWay(way), 'connector');
  const node = parseOplLine('n1 Tname=Calle%20%Lázaro%20%Cárdenas x-81.5 y30.2');
  assert.equal(node.tags.name, 'Calle Lázaro Cárdenas');
});

test('separate express, managed and collector carriageways use reciprocal connector rules regardless of lane count', () => {
  const auxiliaryTags = [
    { name: 'East Beltway Express Lanes' },
    { name: 'I-10 Metro ExpressLanes' },
    { name: 'I-95 Express Toll Lanes' },
    { name: 'I 635 TEXpress' },
    { name: 'I-4 Express', toll: 'yes' },
    { name: 'Highway 401 Collector' },
    { name: 'Collector-Distributor Road' },
    { name: 'US 59 HOV/HOT lane' },
    { hov: 'designated' },
    { express_lanes: 'yes' },
    { managed_lane: 'yes' },
  ];
  for (const designation of auxiliaryTags)
    for (const lanes of ['1', '2', '4', undefined]) {
      const tags = { highway: 'motorway', oneway: 'yes', lanes, ...designation };
      assert.equal(classifyOsmMotorwayWay({ tags }), 'connector', JSON.stringify(tags));
      for (const closure of [
        { access: 'no' },
        { motor_vehicle: 'no' },
        { construction: 'yes' },
      ])
        assert.equal(classifyOsmMotorwayWay({ tags: { ...tags, ...closure } }), null);
    }
});

test('tolls, expressway names, express destinations and mixed lane guidance do not demote mainlines', () => {
  for (const attributes of [
    {
      name: 'East Beltway',
      'destination:lanes': 'Express Lane|East Beltway|East Beltway',
    },
    { name: 'Long Island Expressway', expressway: 'yes' },
    { name: 'First Coast Expressway', toll: 'yes' },
    { name: 'Highway 401 Express' },
    { name: 'Raceland-M C Express' },
    { toll: 'yes' },
    { hov: 'yes' },
    { hov: 'designated', 'hov:lanes': 'designated|yes|yes' },
    { destination: 'Express Lanes' },
    { 'destination:ref': 'I 295 Express' },
    { express_lanes: 'no' },
  ])
    assert.equal(
      classifyOsmMotorwayWay({
        tags: { highway: 'motorway', lanes: '3', ...attributes },
      }),
      'mainline',
      JSON.stringify(attributes),
    );
});

test('I-295 north of SR 9B pairs the general lanes continuously and retains all four Butler interchange movements', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/i295-express-lanes.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const prepared = prepareWays(osm);
  const expressIds = new Set(
    fixture.ways
      .filter((way) => way.tags.name === 'East Beltway Express Lanes')
      .map((way) => way.id),
  );
  assert.equal(expressIds.size, 17);
  assert.equal(
    prepared.mainlines.some((way) => expressIds.has(way.id)),
    false,
  );
  assert.equal(prepared.connectors.filter((way) => expressIds.has(way.id)).length, 17);
  const built = buildOsmHighwayCenterlines(osm);
  const mainlines = built.parts.filter((part) => part.role === 'mainline');
  const i295 = mainlines.filter((part) => part.tokens.includes('I295'));
  assert.equal(i295.length, 1, 'one continuous general-purpose I-295 centerline');
  assert.equal(mainlines.length, 4, 'I-295, I-95, SR 9B and SR 202 only');
  assert.equal(
    mainlines.some((part) => part.sourceWayIds.some((id) => expressIds.has(id))),
    false,
  );
  assert.ok(i295[0].coordinates.some((point) => point[1] < 30.17));
  assert.ok(i295[0].coordinates.some((point) => point[1] > 30.28));
  for (const part of mainlines)
    assert.equal(hasProperSelfIntersection(part.coordinates), false, part.id);
  const butler = built.parts.filter(
    (part) => part.role === 'connector' && part.tokens.includes('SR202'),
  );
  assert.equal(butler.length, 4, 'all four reciprocal general-lane ramp pairs survive');
  for (const part of butler) {
    assert.equal(
      part.sourceWayIds.some((id) => expressIds.has(id)),
      false,
      'short interchange ramps beat the express-lane detour',
    );
    assert.equal(part.pairedDirectionCount, 2);
  }
  const auxiliary = built.parts.filter((part) =>
    part.sourceWayIds.some((id) => expressIds.has(id)),
  );
  assert.equal(
    auxiliary.length,
    0,
    'the reciprocal general-lane merge beats the 9 km express-lane detour',
  );
  const sr9b = mainlines.find((part) => part.tokens.includes('SR9B'));
  const junctionKeys = new Set(i295[0].topologyCoordinates.map((entry) => entry.key));
  assert.ok(
    sr9b.topologyCoordinates.some((entry) => junctionKeys.has(entry.key)),
    'the local general-lane connection remains in the midpoint graph',
  );
  assert.equal(built.statistics.restoredConnectorCount, 0);
  assert.equal(built.statistics.directConnectorCount, 8);
  assert.equal(
    built.parts.filter(
      (part) =>
        part.role === 'connector' &&
        part.tokens.includes('I95') &&
        part.tokens.includes('SR9B'),
    ).length,
    4,
  );
});

function auxiliaryOptions() {
  const chains = [
    { id: 'a', nodeIds: ['a0', 'a1', 'north'] },
    { id: 'b', nodeIds: ['north', 'b1', 'b2'] },
    { id: 'c', nodeIds: ['c0', 'c1', 'south'] },
    { id: 'd', nodeIds: ['south', 'd1', 'd2'] },
  ];
  const nodes = new Map(
    chains.flatMap((chain) => chain.nodeIds).map((id) => [id, { tags: {} }]),
  );
  const attachment = (nodeId, partIndex, chain) => ({
    nodeId,
    partIndex,
    carriagewayIds: [chain],
  });
  const pair = (inner, sourceWayId, meters) => [
    {
      firstAttachment: attachment(inner ? 'a1' : 'a0', 0, 'a'),
      secondAttachment: attachment(inner ? 'b1' : 'b2', 1, 'b'),
      sourceWayIds: [sourceWayId],
      distanceMeters: meters,
    },
    {
      firstAttachment: attachment(inner ? 'c1' : 'c0', 1, 'c'),
      secondAttachment: attachment(inner ? 'd1' : 'd2', 0, 'd'),
      sourceWayIds: [sourceWayId],
      distanceMeters: meters,
    },
  ];
  return {
    long: pair(false, 'aux', 9000),
    short: pair(true, 'ramp', 500),
    groups: new Map([
      [0, 0],
      [1, 1],
    ]),
    context: {
      chains,
      osm: { nodes },
      parts: [{}, {}],
      connectorWays: [{ id: 'aux', tags: { name: 'Express Lanes' } }],
    },
  };
}

test('shorter reciprocal options beat an express detour across different source merge nodes', () => {
  const { long, short, groups, context } = auxiliaryOptions();
  for (const options of [
    [long, short],
    [short, long],
  ])
    assert.deepEqual(selectShortestAuxiliaryRampOptions(options, groups, context), [
      short,
    ]);
  assert.deepEqual(
    selectShortestAuxiliaryRampOptions([long], groups, context),
    [long],
    'express lanes remain eligible when there is no shorter movement',
  );
  short.forEach((path) => {
    path.distanceMeters = 10000;
  });
  assert.deepEqual(
    selectShortestAuxiliaryRampOptions([long, short], groups, context),
    [long, short],
    'lane designation alone does not disqualify the shortest express option',
  );
});

test('a nearby option on a different carriageway is not the same reciprocal movement', () => {
  const { long, short, groups, context } = auxiliaryOptions();
  short[1].firstAttachment.carriagewayIds = ['another-highway-leg'];
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long, short], groups, context), [
    long,
    short,
  ]);
});

test('an auxiliary option can win when it is the shorter reciprocal movement', () => {
  const { long, short, groups, context } = auxiliaryOptions();
  long.forEach((path) => {
    path.sourceWayIds = ['ramp'];
  });
  short.forEach((path) => {
    path.sourceWayIds = ['aux'];
  });
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long, short], groups, context), [
    short,
  ]);
});

test('direct mainline merges supersede an auxiliary detour only with both source directions and midpoint connectivity', () => {
  const { long, groups, context } = auxiliaryOptions();
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long], groups, context), [long]);
  context.parts.forEach((part) => {
    part.startTopologyKeys = ['real-mainline-junction'];
  });
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long], groups, context), []);
  context.chains[3].nodeIds[0] = 'different-node';
  assert.deepEqual(
    selectShortestAuxiliaryRampOptions([long], groups, context),
    [long],
    'one directional source merge is insufficient',
  );
});

test('a mainline merge behind the departure or beyond the arrival cannot supersede a ramp', () => {
  const { long, groups, context } = auxiliaryOptions();
  context.parts.forEach((part) => {
    part.startTopologyKeys = ['real-mainline-junction'];
  });
  context.chains[0].nodeIds = ['north', 'a0', 'a1'];
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long], groups, context), [long]);
});

test('a blocked mainline is not a shorter eligible option', () => {
  const { long, short, groups, context } = auxiliaryOptions();
  context.parts.forEach((part) => {
    part.startTopologyKeys = ['real-mainline-junction'];
  });
  context.osm.nodes.get('a1').tags.highway = 'traffic_signals';
  assert.deepEqual(selectShortestAuxiliaryRampOptions([long, short], groups, context), [
    long,
    short,
  ]);
});
