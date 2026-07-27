function orientation(first, second, third) {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function segmentsProperlyIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  return (
    firstOrientation * secondOrientation < -1e-16 &&
    thirdOrientation * fourthOrientation < -1e-16
  );
}

export function polylinesProperlyIntersect(first, second) {
  for (let firstIndex = 1; firstIndex < first.length; firstIndex += 1) {
    for (let secondIndex = 1; secondIndex < second.length; secondIndex += 1) {
      if (
        segmentsProperlyIntersect(
          first[firstIndex - 1],
          first[firstIndex],
          second[secondIndex - 1],
          second[secondIndex],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hasSelfIntersection(coordinates, closed = true) {
  const segmentCount = coordinates.length - 1;
  for (let firstIndex = 0; firstIndex < segmentCount; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 2;
      secondIndex < segmentCount;
      secondIndex += 1
    ) {
      if (closed && firstIndex === 0 && secondIndex === segmentCount - 1) continue;
      if (
        segmentsProperlyIntersect(
          coordinates[firstIndex],
          coordinates[firstIndex + 1],
          coordinates[secondIndex],
          coordinates[secondIndex + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
