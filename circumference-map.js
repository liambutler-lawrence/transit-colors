const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    if (
      (current.y > point.y) !== (previous.y > point.y) &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointToSegmentDistance(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (deltaX === 0 && deltaY === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const position = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        (deltaX ** 2 + deltaY ** 2),
    ),
  );
  return Math.hypot(
    point.x - (start.x + deltaX * position),
    point.y - (start.y + deltaY * position),
  );
}

function blend(first, second, amount) {
  return first.map((value, index) =>
    Math.round(value + (second[index] - value) * amount),
  );
}

function gradientColor(amount) {
  const routeColor = [238, 91, 56];
  const middleColor = [241, 184, 67];
  const coastColor = [23, 145, 135];
  return amount < 0.45
    ? blend(routeColor, middleColor, amount / 0.45)
    : blend(middleColor, coastColor, (amount - 0.45) / 0.55);
}

function canvasCoordinate([longitude, latitude], bounds, width, height) {
  const [west, south, east, north] = bounds;
  return [
    ((longitude - west) / (east - west)) * width,
    ((north - latitude) / (north - south)) * height,
  ];
}

/**
 * Renders an outward distance field into a MapLibre canvas source. The optional
 * landmass rings are applied as one alpha mask so the texture terminates at
 * every touched coastline instead of selecting only the largest landmass.
 */
export function renderCircumferenceGradient(
  canvas,
  routeCoordinates,
  bounds,
  landmassRings,
) {
  const context = canvas.getContext('2d', { alpha: true });
  const width = canvas.width;
  const height = canvas.height;
  const [west, south, east, north] = bounds;
  const referenceLatitude = (south + north) / 2;
  const metersPerLongitudeDegree =
    toRadians(1) * EARTH_RADIUS_M * Math.cos(toRadians(referenceLatitude));
  const metersPerLatitudeDegree = toRadians(1) * EARTH_RADIUS_M;
  const project = ([longitude, latitude]) => ({
    x: (longitude - west) * metersPerLongitudeDegree,
    y: (latitude - south) * metersPerLatitudeDegree,
  });
  const route = routeCoordinates.map(project);
  const segments = route.slice(1).map((end, index) => ({
    start: route[index],
    end,
  }));
  const image = context.createImageData(width, height);
  const distanceScaleMeters = Math.max(
    20_000,
    Math.min(
      55_000,
      Math.hypot(
        (east - west) * metersPerLongitudeDegree,
        (north - south) * metersPerLatitudeDegree,
      ) * 0.32,
    ),
  );

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const latitude = north - ((pixelY + 0.5) / height) * (north - south);
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const longitude = west + ((pixelX + 0.5) / width) * (east - west);
      const point = project([longitude, latitude]);
      if (pointInPolygon(point, route)) continue;

      let distance = Number.POSITIVE_INFINITY;
      for (const segment of segments) {
        distance = Math.min(
          distance,
          pointToSegmentDistance(point, segment.start, segment.end),
        );
      }
      const amount = Math.min(1, distance / distanceScaleMeters);
      const [red, green, blue] = gradientColor(amount);
      const offset = (pixelY * width + pixelX) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = Math.round(116 - amount * 62);
    }
  }

  context.clearRect(0, 0, width, height);
  context.putImageData(image, 0, 0);

  const rings = Array.isArray(landmassRings?.[0]?.[0])
    ? landmassRings
    : Array.isArray(landmassRings)
      ? [landmassRings]
      : [];
  if (rings.length > 0) {
    context.save();
    context.globalCompositeOperation = 'destination-in';
    context.beginPath();
    for (const ring of rings) {
      for (const [index, coordinate] of ring.entries()) {
        const [x, y] = canvasCoordinate(coordinate, bounds, width, height);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
    }
    context.fill();
    context.restore();
  }
}
