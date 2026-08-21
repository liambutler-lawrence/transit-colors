import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyJerseyCityParcel,
  storiesFromBuildingDescription,
} from './land-use.ts';

test('extracts the tallest story count from compact tax descriptions', () => {
  assert.equal(storiesFromBuildingDescription('5-18S-1S-483U'), 18);
  assert.equal(storiesFromBuildingDescription('3S-B-C-4U-H'), 3);
});

test('separates vacant industrial land from other vacant parcels', () => {
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: 'VACANT LAND',
      taxClass: '1',
      zoneCode: 'I',
    }).category,
    'vacant_industrial',
  );
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: 'VACANT LAND',
      taxClass: '1',
      zoneCode: 'R-1',
    }).category,
    'vacant_other',
  );
});

test('recognizes active industrial and auto-oriented commercial parcels', () => {
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: '2S-CB-IN-O',
      taxClass: '4B',
    }).category,
    'industrial_active',
  );
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: '1S-A&P-STRIPMAL',
      taxClass: '4A',
    }).category,
    'retail_auto',
  );
});

test('splits mixed-use parcels by historic evidence', () => {
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: '3S-F-C-4U-H',
      taxClass: '4A',
      yearBuilt: '1880',
    }).category,
    'mixed_use_historic',
  );
  assert.equal(
    classifyJerseyCityParcel({
      buildingDescription: '7S-B-C-128U',
      taxClass: '4C',
      yearBuilt: '2022',
    }).category,
    'mixed_use_modern',
  );
});

test('keeps a high-rise without commercial evidence in the tower class', () => {
  const result = classifyJerseyCityParcel({
    buildingDescription: '17S-BA-271UHE',
    taxClass: '2',
    yearBuilt: '1961',
  });
  assert.equal(result.category, 'tower_no_retail');
  assert.equal(result.stories, 17);
});

test('keeps commercial, residential, civic, and unknown uses distinct', () => {
  const cases = [
    [{ buildingDescription: '2S-CB-C-STORE', taxClass: '4A' }, 'commercial_active'],
    [{ buildingDescription: '3S-F-D-6U-H', taxClass: '2' }, 'housing'],
    [{ buildingDescription: 'PUBLIC SCHOOL', taxClass: '15A' }, 'civic_open_space'],
    [{ buildingDescription: 'RAILROAD', taxClass: '5A' }, 'other'],
  ];
  for (const [input, expectedCategory] of cases) {
    assert.equal(classifyJerseyCityParcel(input).category, expectedCategory);
  }
});
