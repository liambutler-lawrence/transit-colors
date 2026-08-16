import {
  timezoneCountryCollectionSchema,
  type TimezoneCountryCollection,
} from '../timezone-countries.js';
import {
  timezoneSkewCollectionSchema,
  type TimezoneSkewCollection,
} from '../timezone-skew.js';
import { fetchParsed } from '../parse.js';

export async function fetchTimezoneMapData(): Promise<{
  countries: TimezoneCountryCollection;
  zones: TimezoneSkewCollection;
}> {
  const [zones, countries] = await Promise.all([
    fetchParsed(
      'data/timezone-skew-zones.geojson?v=20260816d',
      timezoneSkewCollectionSchema,
    ),
    fetchParsed(
      'data/timezone-skew-countries.geojson?v=20260816a',
      timezoneCountryCollectionSchema,
    ),
  ]);
  return { countries, zones };
}
