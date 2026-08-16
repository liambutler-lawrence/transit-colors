const UTC_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const UTC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

const OFFSET_SAMPLE_STEP_MS = 6 * 60 * 60 * 1_000;

export interface TimezonePeriod {
  readonly startMs: number;
  readonly endMs: number;
  readonly representativeMs: number;
  readonly label: string;
  readonly changedTimezones: readonly string[];
  readonly nextChangedTimezones: readonly string[];
}

export type TimezoneOffsetResolver = (timezone: string, epochMs: number) => number;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    offsetFormatters.set(timezone, formatter);
  }
  return formatter;
}

export function parseGmtOffset(value: string): number {
  if (value === 'GMT' || value === 'UTC') return 0;
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Unsupported UTC offset: ${value}`);
  const [, sign, hoursText, minutesText = '00'] = match;
  const minutes = Number(hoursText) * 60 + Number(minutesText);
  return (sign === '-' ? -minutes : minutes) / 60;
}

export function timezoneOffsetHours(timezone: string, epochMs: number): number {
  const offsetPart = offsetFormatter(timezone)
    .formatToParts(new Date(epochMs))
    .find(({ type }) => type === 'timeZoneName')?.value;
  if (!offsetPart) throw new Error(`Could not resolve UTC offset for ${timezone}`);
  return parseGmtOffset(offsetPart);
}

export function formatUtcOffset(offsetHours: number): string {
  const sign = offsetHours < 0 ? '-' : '+';
  const absoluteMinutes = Math.round(Math.abs(offsetHours) * 60);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function findTransition(
  timezone: string,
  lowerMs: number,
  upperMs: number,
  offsetBefore: number,
  resolveOffset: TimezoneOffsetResolver,
): number {
  let lowerSecond = Math.floor(lowerMs / 1_000);
  let upperSecond = Math.ceil(upperMs / 1_000);
  while (upperSecond - lowerSecond > 1) {
    const middleSecond = Math.floor((lowerSecond + upperSecond) / 2);
    if (resolveOffset(timezone, middleSecond * 1_000) === offsetBefore) {
      lowerSecond = middleSecond;
    } else {
      upperSecond = middleSecond;
    }
  }
  return upperSecond * 1_000;
}

export function timezoneTransitionsForYear(
  timezone: string,
  year: number,
  resolveOffset: TimezoneOffsetResolver = timezoneOffsetHours,
): readonly number[] {
  const yearStart = Date.UTC(year, 0, 1);
  const yearEnd = Date.UTC(year + 1, 0, 1);
  const transitions: number[] = [];
  let previousMs = yearStart;
  let previousOffset = resolveOffset(timezone, previousMs);

  for (
    let sampleMs = Math.min(yearStart + OFFSET_SAMPLE_STEP_MS, yearEnd);
    previousMs < yearEnd;
    sampleMs = Math.min(sampleMs + OFFSET_SAMPLE_STEP_MS, yearEnd)
  ) {
    const sampleOffset = resolveOffset(timezone, sampleMs);
    if (sampleOffset !== previousOffset) {
      transitions.push(
        findTransition(timezone, previousMs, sampleMs, previousOffset, resolveOffset),
      );
    }
    previousMs = sampleMs;
    previousOffset = sampleOffset;
  }

  return transitions;
}

function formatBoundary(epochMs: number, year: number): string {
  const date = new Date(epochMs);
  const isYearEdge =
    date.getUTCMonth() === 0 &&
    date.getUTCDate() === 1 &&
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0;
  if (isYearEdge) {
    return date.getUTCFullYear() === year ? 'Jan 1' : `Jan 1, ${year + 1}`;
  }
  return `${UTC_YEAR_FORMATTER.format(date)} UTC`;
}

export function formatTimezonePeriod(
  startMs: number,
  endMs: number,
  year: number,
): string {
  return `${formatBoundary(startMs, year)} → ${formatBoundary(endMs, year)}`;
}

export function formatTimezonePeriodDateRange(startMs: number, endMs: number): string {
  return `${UTC_DATE_FORMATTER.format(new Date(startMs))}–${UTC_DATE_FORMATTER.format(new Date(endMs - 1))}`;
}

export function buildTimezonePeriods(
  timezones: readonly string[],
  year: number,
  resolveOffset: TimezoneOffsetResolver = timezoneOffsetHours,
): readonly TimezonePeriod[] {
  const changesByInstant = new Map<number, string[]>();
  for (const timezone of [...new Set(timezones)].sort()) {
    for (const transitionMs of timezoneTransitionsForYear(
      timezone,
      year,
      resolveOffset,
    )) {
      const changedTimezones = changesByInstant.get(transitionMs) ?? [];
      changedTimezones.push(timezone);
      changesByInstant.set(transitionMs, changedTimezones);
    }
  }

  const yearStart = Date.UTC(year, 0, 1);
  const yearEnd = Date.UTC(year + 1, 0, 1);
  const boundaries = [yearStart, ...changesByInstant.keys(), yearEnd].sort(
    (left, right) => left - right,
  );

  return boundaries.slice(0, -1).map((startMs, index) => {
    const endMs = boundaries[index + 1] ?? yearEnd;
    return {
      startMs,
      endMs,
      representativeMs: Math.min(startMs + 1_000, endMs - 1),
      label: formatTimezonePeriod(startMs, endMs, year),
      changedTimezones: changesByInstant.get(startMs) ?? [],
      nextChangedTimezones: changesByInstant.get(endMs) ?? [],
    };
  });
}

export function timezoneOffsetsAt(
  timezones: readonly string[],
  epochMs: number,
  resolveOffset: TimezoneOffsetResolver = timezoneOffsetHours,
): ReadonlyMap<string, number> {
  return new Map(
    [...new Set(timezones)].map((timezone) => [
      timezone,
      resolveOffset(timezone, epochMs),
    ]),
  );
}
