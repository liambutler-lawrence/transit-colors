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

const UTC_HISTORY_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const UTC_HISTORY_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
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

export interface HistoricalTimezonePeriod extends TimezonePeriod {
  readonly isPresent: boolean;
}

export interface TimezoneOffsetChange {
  readonly timezone: string;
  readonly fromOffsetHours: number;
  readonly toOffsetHours: number;
}

export interface TimezoneRule {
  readonly initialOffsetSeconds: number;
  readonly initialStandardOffsetSeconds: number;
  readonly transitions: readonly (readonly [number, number])[];
  readonly standardTransitions: readonly (readonly [number, number])[];
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
  const absoluteSeconds = Math.round(Math.abs(offsetHours) * 3_600);
  const hours = Math.floor(absoluteSeconds / 3_600);
  const minutes = Math.floor((absoluteSeconds % 3_600) / 60);
  const seconds = absoluteSeconds % 60;
  const secondsText = seconds === 0 ? '' : `:${String(seconds).padStart(2, '0')}`;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${secondsText}`;
}

export function timezoneRuleOffsetHours(
  rule: TimezoneRule,
  epochMs: number,
  standard = false,
): number {
  const transitions = standard ? rule.standardTransitions : rule.transitions;
  let lower = 0;
  let upper = transitions.length;
  const epochSeconds = Math.floor(epochMs / 1_000);
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const transition = transitions[middle];
    if (transition && transition[0] <= epochSeconds) lower = middle + 1;
    else upper = middle;
  }
  const transition = transitions[lower - 1];
  const offsetSeconds =
    transition?.[1] ??
    (standard ? rule.initialStandardOffsetSeconds : rule.initialOffsetSeconds);
  return offsetSeconds / 3_600;
}

export function timezoneOffsetsFromRulesAt(
  rules: Readonly<Record<string, TimezoneRule>>,
  epochMs: number,
  standard = false,
): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(rules).map(([timezone, rule]) => [
      timezone,
      timezoneRuleOffsetHours(rule, epochMs, standard),
    ]),
  );
}

export function timezoneOffsetChangesAtBoundary(
  rules: Readonly<Record<string, TimezoneRule>>,
  boundaryMs: number,
  timezones: readonly string[],
  standard = false,
): readonly TimezoneOffsetChange[] {
  return timezones.flatMap((timezone) => {
    const rule = rules[timezone];
    if (!rule) return [];
    const fromOffsetHours = timezoneRuleOffsetHours(rule, boundaryMs - 1_000, standard);
    const toOffsetHours = timezoneRuleOffsetHours(rule, boundaryMs, standard);
    return fromOffsetHours === toOffsetHours
      ? []
      : [{ timezone, fromOffsetHours, toOffsetHours }];
  });
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

export function buildTimezonePeriodsFromRules(
  rules: Readonly<Record<string, TimezoneRule>>,
  year: number,
): readonly TimezonePeriod[] {
  const yearStart = Date.UTC(year, 0, 1);
  const yearEnd = Date.UTC(year + 1, 0, 1);
  const changesByInstant = new Map<number, string[]>();
  for (const [timezone, rule] of Object.entries(rules).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const [transitionSeconds] of rule.transitions) {
      const transitionMs = transitionSeconds * 1_000;
      if (transitionMs < yearStart || transitionMs >= yearEnd) continue;
      const changedTimezones = changesByInstant.get(transitionMs) ?? [];
      changedTimezones.push(timezone);
      changesByInstant.set(transitionMs, changedTimezones);
    }
  }
  return buildPeriodsFromChanges(changesByInstant, yearStart, yearEnd, (start, end) =>
    formatTimezonePeriod(start, end, year),
  );
}

function formatHistoricalBoundary(epochMs: number): string {
  const date = new Date(epochMs);
  const dateText = UTC_HISTORY_DATE_FORMATTER.format(date);
  const isMidnight =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0;
  return isMidnight
    ? dateText
    : `${dateText}, ${UTC_HISTORY_TIME_FORMATTER.format(date)} UTC`;
}

export function formatHistoricalTimezonePeriod(
  startMs: number,
  endMs: number,
  isPresent: boolean,
): string {
  return `${formatHistoricalBoundary(startMs)} → ${isPresent ? 'present' : formatHistoricalBoundary(endMs)}`;
}

function buildPeriodsFromChanges(
  changesByInstant: ReadonlyMap<number, string[]>,
  startMs: number,
  endMs: number,
  label: (periodStartMs: number, periodEndMs: number, index: number) => string,
): readonly TimezonePeriod[] {
  const boundaries = [
    startMs,
    ...[...changesByInstant.keys()].filter(
      (transitionMs) => transitionMs > startMs && transitionMs < endMs,
    ),
    endMs,
  ].sort((left, right) => left - right);
  return boundaries.slice(0, -1).map((periodStartMs, index) => {
    const periodEndMs = boundaries[index + 1] ?? endMs;
    return {
      startMs: periodStartMs,
      endMs: periodEndMs,
      representativeMs: Math.min(periodStartMs + 1_000, periodEndMs - 1),
      label: label(periodStartMs, periodEndMs, index),
      changedTimezones: changesByInstant.get(periodStartMs) ?? [],
      nextChangedTimezones: changesByInstant.get(periodEndMs) ?? [],
    };
  });
}

export function buildHistoricalTimezonePeriods(
  rules: Readonly<Record<string, TimezoneRule>>,
  startMs: number,
  endMs: number = Date.now(),
): readonly HistoricalTimezonePeriod[] {
  const changesByInstant = new Map<number, string[]>();
  for (const [timezone, rule] of Object.entries(rules).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const [transitionSeconds] of rule.standardTransitions) {
      const transitionMs = transitionSeconds * 1_000;
      if (transitionMs <= startMs || transitionMs >= endMs) continue;
      const changedTimezones = changesByInstant.get(transitionMs) ?? [];
      changedTimezones.push(timezone);
      changesByInstant.set(transitionMs, changedTimezones);
    }
  }
  const periods = buildPeriodsFromChanges(
    changesByInstant,
    startMs,
    endMs,
    (periodStartMs, periodEndMs, index) =>
      formatHistoricalTimezonePeriod(
        periodStartMs,
        periodEndMs,
        index === changesByInstant.size,
      ),
  );
  return periods.map((period, index) => ({
    ...period,
    isPresent: index === periods.length - 1,
  }));
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
