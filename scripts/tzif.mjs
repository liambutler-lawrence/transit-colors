const HEADER_SIZE = 44;
const SEASONAL_PAIR_WINDOW_SECONDS = 370 * 24 * 60 * 60;

function readHeader(buffer, offset) {
  if (buffer.subarray(offset, offset + 4).toString('ascii') !== 'TZif') {
    throw new Error('Invalid TZif header');
  }
  return {
    version: String.fromCharCode(buffer[offset + 4] ?? 0),
    ttisgmtcnt: buffer.readUInt32BE(offset + 20),
    ttisstdcnt: buffer.readUInt32BE(offset + 24),
    leapcnt: buffer.readUInt32BE(offset + 28),
    timecnt: buffer.readUInt32BE(offset + 32),
    typecnt: buffer.readUInt32BE(offset + 36),
    charcnt: buffer.readUInt32BE(offset + 40),
  };
}

function blockSize(header, timeSize) {
  return (
    header.timecnt * timeSize +
    header.timecnt +
    header.typecnt * 6 +
    header.charcnt +
    header.leapcnt * (timeSize + 4) +
    header.ttisstdcnt +
    header.ttisgmtcnt
  );
}

function readTime(buffer, offset, timeSize) {
  return timeSize === 8
    ? Number(buffer.readBigInt64BE(offset))
    : buffer.readInt32BE(offset);
}

function readBlock(buffer, offset, header, timeSize) {
  const transitionTimes = [];
  for (let index = 0; index < header.timecnt; index += 1) {
    transitionTimes.push(readTime(buffer, offset + index * timeSize, timeSize));
  }
  const typeIndexOffset = offset + header.timecnt * timeSize;
  const typeOffset = typeIndexOffset + header.timecnt;
  const types = [];
  for (let index = 0; index < header.typecnt; index += 1) {
    const entryOffset = typeOffset + index * 6;
    types.push({
      offsetSeconds: buffer.readInt32BE(entryOffset),
      isDst: buffer[entryOffset + 4] === 1,
    });
  }
  return {
    transitions: transitionTimes.map((atSeconds, index) => ({
      atSeconds,
      typeIndex: buffer[typeIndexOffset + index] ?? 0,
    })),
    types,
  };
}

export function parseTzif(buffer) {
  const firstHeader = readHeader(buffer, 0);
  if (!['2', '3', '4'].includes(firstHeader.version)) {
    return readBlock(buffer, HEADER_SIZE, firstHeader, 4);
  }
  const secondHeaderOffset = HEADER_SIZE + blockSize(firstHeader, 4);
  const secondHeader = readHeader(buffer, secondHeaderOffset);
  return readBlock(buffer, secondHeaderOffset + HEADER_SIZE, secondHeader, 8);
}

function typeIndexAt(parsed, epochSeconds) {
  let typeIndex = 0;
  for (const transition of parsed.transitions) {
    if (transition.atSeconds > epochSeconds) break;
    typeIndex = transition.typeIndex;
  }
  return typeIndex;
}

function normalizedEvents(parsed, startSeconds, endSeconds) {
  let previousTypeIndex = 0;
  const events = [];
  for (const transition of parsed.transitions) {
    const beforeTypeIndex = previousTypeIndex;
    previousTypeIndex = transition.typeIndex;
    if (
      transition.atSeconds < startSeconds - SEASONAL_PAIR_WINDOW_SECONDS ||
      transition.atSeconds >= endSeconds + SEASONAL_PAIR_WINDOW_SECONDS
    ) {
      continue;
    }
    const before = parsed.types[beforeTypeIndex];
    const after = parsed.types[transition.typeIndex];
    if (!before || !after) continue;
    events.push({
      atSeconds: transition.atSeconds,
      before,
      after,
    });
  }
  return events;
}

function recurringEventIndices(events) {
  const recurring = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.before.offsetSeconds === event.after.offsetSeconds ||
      event.before.isDst === event.after.isDst
    ) {
      continue;
    }
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const next = events[nextIndex];
      if (next.atSeconds - event.atSeconds > SEASONAL_PAIR_WINDOW_SECONDS) {
        break;
      }
      if (
        next.before.offsetSeconds === event.after.offsetSeconds &&
        next.before.isDst === event.after.isDst &&
        next.after.offsetSeconds === event.before.offsetSeconds &&
        next.after.isDst === event.before.isDst
      ) {
        recurring.add(index);
        recurring.add(nextIndex);
        break;
      }
    }
  }
  return recurring;
}

function permanentDstAdoptionEntries(events) {
  const entries = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.before.isDst || !event.after.isDst) continue;
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const next = events[nextIndex];
      if (next.atSeconds - event.atSeconds > SEASONAL_PAIR_WINDOW_SECONDS) {
        break;
      }
      if (
        next.before.offsetSeconds === event.after.offsetSeconds &&
        next.before.isDst &&
        next.after.offsetSeconds === event.after.offsetSeconds &&
        !next.after.isDst
      ) {
        entries.add(index);
        break;
      }
    }
  }
  return entries;
}

function standardOffsetNear(events, eventIndex, type, direction) {
  if (!type.isDst) return type.offsetSeconds;
  for (
    let index = eventIndex + direction;
    index >= 0 && index < events.length;
    index += direction
  ) {
    const event = events[index];
    const secondsAway = Math.abs(event.atSeconds - events[eventIndex].atSeconds);
    if (secondsAway > SEASONAL_PAIR_WINDOW_SECONDS) break;
    const candidate = direction < 0 ? event.after : event.before;
    if (!candidate.isDst) return candidate.offsetSeconds;
  }
  return type.offsetSeconds;
}

function initialStandardOffset(parsed, events, startSeconds) {
  const startType = parsed.types[typeIndexAt(parsed, startSeconds)];
  if (!startType) throw new Error('TZif file has no initial local-time type');
  if (!startType.isDst) return startType.offsetSeconds;
  const firstAfterStart = events.findIndex(
    ({ atSeconds }) => atSeconds >= startSeconds,
  );
  const anchorIndex = firstAfterStart >= 0 ? firstAfterStart : events.length - 1;
  return standardOffsetNear(events, anchorIndex, startType, -1);
}

export function buildTimezoneRule(parsed, startSeconds, endSeconds) {
  const events = normalizedEvents(parsed, startSeconds, endSeconds);
  const recurring = recurringEventIndices(events);
  const permanentDstEntries = permanentDstAdoptionEntries(events);
  const initialType = parsed.types[typeIndexAt(parsed, startSeconds)];
  if (!initialType) throw new Error('TZif file has no local-time types');
  const transitions = [];
  let activeOffsetSeconds = initialType.offsetSeconds;
  for (const event of events) {
    if (event.atSeconds <= startSeconds || event.atSeconds >= endSeconds) continue;
    if (event.after.offsetSeconds === activeOffsetSeconds) continue;
    activeOffsetSeconds = event.after.offsetSeconds;
    transitions.push([event.atSeconds, activeOffsetSeconds]);
  }

  const initialStandardOffsetSeconds = initialStandardOffset(
    parsed,
    events,
    startSeconds,
  );
  const standardTransitions = [];
  let activeStandardOffsetSeconds = initialStandardOffsetSeconds;
  for (const [index, event] of events.entries()) {
    if (
      recurring.has(index) ||
      permanentDstEntries.has(index) ||
      event.atSeconds <= startSeconds ||
      event.atSeconds >= endSeconds
    ) {
      continue;
    }
    const nextStandardOffsetSeconds = standardOffsetNear(events, index, event.after, 1);
    if (nextStandardOffsetSeconds === activeStandardOffsetSeconds) continue;
    activeStandardOffsetSeconds = nextStandardOffsetSeconds;
    standardTransitions.push([event.atSeconds, activeStandardOffsetSeconds]);
  }

  return {
    initialOffsetSeconds: initialType.offsetSeconds,
    initialStandardOffsetSeconds,
    transitions,
    standardTransitions,
  };
}
