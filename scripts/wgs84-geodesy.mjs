import geographicLib from 'geographiclib-geodesic';

const { Geodesic } = geographicLib;
const WGS84 = Geodesic.WGS84;
const referenceAreaPerRadianCache = new Map();

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function normalizeLongitudeDelta(delta) {
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
}

function referenceAreaPerRadian(referenceLatitudeRadians) {
  const cached = referenceAreaPerRadianCache.get(referenceLatitudeRadians);
  if (cached !== undefined) return cached;
  const latitude = (referenceLatitudeRadians * 180) / Math.PI;
  const oneDegreeArea = WGS84.Inverse(latitude, 0, latitude, 1, Geodesic.AREA).S12;
  if (!Number.isFinite(oneDegreeArea)) {
    throw new Error('GeographicLib did not return a WGS84 reference-strip area.');
  }
  const result = oneDegreeArea / toRadians(1);
  referenceAreaPerRadianCache.set(referenceLatitudeRadians, result);
  return result;
}

export function geodesicDistanceMeters(
  [longitudeA, latitudeA],
  [longitudeB, latitudeB],
) {
  const result = WGS84.Inverse(
    latitudeA,
    longitudeA,
    latitudeB,
    longitudeB,
    Geodesic.DISTANCE,
  );
  if (!Number.isFinite(result.s12)) {
    throw new Error('GeographicLib did not return a WGS84 distance.');
  }
  return result.s12;
}

export function geodesicMidpoint([longitudeA, latitudeA], [longitudeB, latitudeB]) {
  const inverse = WGS84.Inverse(
    latitudeA,
    longitudeA,
    latitudeB,
    longitudeB,
    Geodesic.DISTANCE | Geodesic.AZIMUTH,
  );
  if (!Number.isFinite(inverse.s12) || !Number.isFinite(inverse.azi1)) {
    throw new Error('GeographicLib did not return a WGS84 midpoint inverse.');
  }
  const direct = WGS84.Direct(
    latitudeA,
    longitudeA,
    inverse.azi1,
    inverse.s12 / 2,
    Geodesic.LATITUDE | Geodesic.LONGITUDE,
  );
  if (!Number.isFinite(direct.lat2) || !Number.isFinite(direct.lon2)) {
    throw new Error('GeographicLib did not return a WGS84 midpoint.');
  }
  return [direct.lon2, direct.lat2];
}

export function signedAreaContributionSquareMeters(
  coordinates,
  referenceLatitudeRadians = 0,
) {
  let accumulator = 0;
  const referenceArea = referenceAreaPerRadian(referenceLatitudeRadians);
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (!previous || !current) continue;
    const longitudeDelta = normalizeLongitudeDelta(
      toRadians(current[0]) - toRadians(previous[0]),
    );
    const inverse = WGS84.Inverse(
      previous[1],
      previous[0],
      current[1],
      current[0],
      Geodesic.AREA,
    );
    if (!Number.isFinite(inverse.S12)) {
      throw new Error('GeographicLib did not return a signed WGS84 edge area.');
    }
    // The reference strip cancels around every closed cycle. Subtracting it
    // keeps MILP coefficients near the metro-scale area while preserving the
    // exact WGS84 objective.
    accumulator += inverse.S12 - longitudeDelta * referenceArea;
  }
  return accumulator;
}
