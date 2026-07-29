import { geodesicPolygonAreaSquareMeters } from '../src/geodesy.ts';

export function readPolygonRings(buffer) {
  const rings = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthBytes = buffer.readInt32BE(offset + 4) * 2;
    offset += 8;
    const recordEnd = offset + contentLengthBytes;
    const shapeType = buffer.readInt32LE(offset);
    if (shapeType === 5) {
      const partCount = buffer.readInt32LE(offset + 36);
      const pointCount = buffer.readInt32LE(offset + 40);
      const partStarts = [];
      let cursor = offset + 44;
      for (let index = 0; index < partCount; index += 1) {
        partStarts.push(buffer.readInt32LE(cursor + index * 4));
      }
      cursor += partCount * 4;
      const points = [];
      for (let index = 0; index < pointCount; index += 1) {
        points.push([
          buffer.readDoubleLE(cursor + index * 16),
          buffer.readDoubleLE(cursor + index * 16 + 8),
        ]);
      }
      for (const [partIndex, start] of partStarts.entries()) {
        rings.push(points.slice(start, partStarts[partIndex + 1] ?? pointCount));
      }
    }
    offset = recordEnd;
  }
  return rings;
}

export function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = ring.length - 1;
    currentIndex < ring.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    if (
      current[1] > latitude !== previous[1] > latitude &&
      longitude <
        ((previous[0] - current[0]) * (latitude - current[1])) /
          (previous[1] - current[1]) +
          current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function multiPolygonAreaSquareMeters(multiPolygon) {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal +
          geodesicPolygonAreaSquareMeters(ring) * (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

export function roundCoordinate([longitude, latitude], decimalPlaces = 6) {
  return [
    Number(longitude.toFixed(decimalPlaces)),
    Number(latitude.toFixed(decimalPlaces)),
  ];
}
