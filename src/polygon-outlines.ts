type Position = readonly [number, number];

/** Omit the artificial date-line/pole closure of a whole polar landmass. */
export function polygonOutlines(
  polygons: readonly (readonly (readonly Position[])[])[],
): [number, number][][] {
  return polygons.flatMap((polygon) =>
    polygon.flatMap((ring) => {
      const closesAcrossPole = ring.some((point, index) => {
        const previous = ring[(index + ring.length - 1) % ring.length];
        return (
          Math.abs(point[1]) === 90 &&
          previous?.[1] === point[1] &&
          Math.abs(point[0] - previous[0]) === 360
        );
      });
      if (!closesAcrossPole) return [ring.map(([x, y]): [number, number] => [x, y])];

      const lines: [number, number][][] = [];
      let line: [number, number][] = [];
      for (const [longitude, latitude] of ring) {
        if (Math.abs(latitude) === 90) {
          if (line.length > 1) lines.push(line);
          line = [];
        } else {
          line.push([longitude, latitude]);
        }
      }
      if (line.length > 1) lines.push(line);
      return lines;
    }),
  );
}
