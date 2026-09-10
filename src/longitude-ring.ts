type Position = readonly [number, number];

/** Keep date-line polygons local without collapsing a full-width pole closure. */
export function unwrapLongitudeRing(
  ring: readonly Position[],
  reference: number,
): Position[] {
  if (ring.length === 0) return [];
  const nearest = (longitude: number, previous: number): number =>
    longitude + 360 * Math.round((previous - longitude) / 360);
  let previousLongitude = nearest(ring[0]?.[0] ?? 0, reference);
  return ring.map(([longitude, latitude], index) => {
    if (index > 0) {
      const previous = ring[index - 1];
      // Antarctica closes from +180 to -180 at the pole. Preserve that edge's
      // full longitude span so the rest of its coast stays in the same world.
      previousLongitude =
        Math.abs(latitude) === 90 && previous?.[1] === latitude
          ? previousLongitude + longitude - previous[0]
          : nearest(longitude, previousLongitude);
    }
    return [previousLongitude, latitude];
  });
}
