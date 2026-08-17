import type { TimezoneSkewCollection } from '../timezone-skew.js';
import {
  formatTimezonePeriodDateRange,
  formatUtcOffset,
  timezoneOffsetChangesAtBoundary,
  type TimezonePeriod,
} from '../timezone-seasons.js';
import {
  timezonePeriodChangesEl,
  timezonePeriodChangesListEl,
  timezonePeriodChangesSummaryEl,
  timezonePeriodMenu,
  timezonePeriodSummaryEl,
  timezonePeriodTrigger,
} from './context.js';

interface CountryOffsetChange {
  readonly country: string;
  readonly fromOffsetHours: number;
  readonly timezones: readonly string[];
  readonly toOffsetHours: number;
}

export interface TimezonePeriodPicker {
  setDisabled(disabled: boolean): void;
  setSelected(index: number): void;
}

interface TimezonePeriodPickerOptions {
  readonly data: TimezoneSkewCollection;
  readonly onSelect: (index: number) => void;
  readonly periods: readonly TimezonePeriod[];
  readonly selectedIndex: number;
  readonly year: number;
}

const UTC_CALENDAR_MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
});

const UTC_CALENDAR_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const UTC_CHANGE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function readableTimezone(timezone: string): string {
  return timezone.replaceAll('_', ' ').replace('/', ' / ');
}

function countryOffsetChanges(
  data: TimezoneSkewCollection,
  period: TimezonePeriod,
): readonly CountryOffsetChange[] {
  const grouped = new Map<string, CountryOffsetChange>();
  for (const change of timezoneOffsetChangesAtBoundary(
    data.metadata.timezone_rules,
    period.endMs,
    period.nextChangedTimezones,
  )) {
    const countries = data.metadata.timezone_countries[change.timezone] ?? [
      readableTimezone(change.timezone),
    ];
    for (const country of countries) {
      const key = `${country}\u0000${change.fromOffsetHours}\u0000${change.toOffsetHours}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        country,
        fromOffsetHours: change.fromOffsetHours,
        timezones: [...(existing?.timezones ?? []), change.timezone],
        toOffsetHours: change.toOffsetHours,
      });
    }
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.country.localeCompare(right.country) ||
      left.fromOffsetHours - right.fromOffsetHours ||
      left.toOffsetHours - right.toOffsetHours,
  );
}

function uniqueChangedCountryCount(changes: readonly CountryOffsetChange[]): number {
  return new Set(changes.map(({ country }) => country)).size;
}

function nextChangeDescription(
  data: TimezoneSkewCollection,
  period: TimezonePeriod,
  year: number,
): string {
  const changes = countryOffsetChanges(data, period);
  const countryCount = uniqueChangedCountryCount(changes);
  if (countryCount === 0) return `No more clock changes in ${year}.`;
  const boundary = UTC_CHANGE_FORMATTER.format(new Date(period.endMs));
  return `${countryCount} ${countryCount === 1 ? 'country changes' : 'countries change'} clocks on ${boundary} UTC.`;
}

function calendarCard(epochMs: number): HTMLElement {
  const date = new Date(epochMs);
  const card = document.createElement('span');
  card.className = 'timezone-calendar-card';
  card.setAttribute('aria-hidden', 'true');

  const header = document.createElement('span');
  header.className = 'timezone-calendar-header';
  const month = document.createElement('span');
  month.textContent = UTC_CALENDAR_MONTH_FORMATTER.format(date).toUpperCase();
  const year = document.createElement('span');
  year.textContent = String(date.getUTCFullYear());
  header.append(month, year);

  const day = document.createElement('strong');
  day.textContent = String(date.getUTCDate());
  const time = document.createElement('span');
  time.className = 'timezone-calendar-time';
  time.textContent = UTC_CALENDAR_TIME_FORMATTER.format(date);
  card.append(header, day, time);
  return card;
}

function calendarRange(period: TimezonePeriod): HTMLElement {
  const range = document.createElement('span');
  range.className = 'timezone-calendar-range';
  const arrow = document.createElement('span');
  arrow.className = 'timezone-calendar-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  range.append(calendarCard(period.startMs), arrow, calendarCard(period.endMs));
  return range;
}

export function createTimezonePeriodPicker({
  data,
  onSelect,
  periods,
  selectedIndex,
  year,
}: TimezonePeriodPickerOptions): TimezonePeriodPicker {
  let activeIndex = selectedIndex;

  function options(): readonly HTMLButtonElement[] {
    return [
      ...timezonePeriodMenu.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
  }

  function setOpen(open: boolean, focusSelected = false): void {
    const shouldOpen = open && !timezonePeriodTrigger.disabled;
    timezonePeriodMenu.hidden = !shouldOpen;
    timezonePeriodTrigger.setAttribute('aria-expanded', String(shouldOpen));
    if (!shouldOpen || !focusSelected) return;
    const selected = options()[activeIndex] ?? options()[0];
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'center' });
  }

  function updateChanges(period: TimezonePeriod): void {
    const changes = countryOffsetChanges(data, period);
    const countryCount = uniqueChangedCountryCount(changes);
    if (changes.length === 0) {
      timezonePeriodChangesEl.hidden = true;
      timezonePeriodChangesEl.open = false;
      timezonePeriodChangesListEl.replaceChildren();
      return;
    }
    timezonePeriodChangesEl.hidden = false;
    timezonePeriodChangesSummaryEl.textContent = `${countryCount} ${countryCount === 1 ? 'country' : 'countries'} changing on ${UTC_CHANGE_FORMATTER.format(new Date(period.endMs))} UTC`;
    timezonePeriodChangesListEl.replaceChildren(
      ...changes.map((change) => {
        const item = document.createElement('li');
        const country = document.createElement('strong');
        country.textContent = change.country;
        const offset = document.createElement('span');
        offset.className = 'timezone-country-offset-change';
        offset.textContent = `${formatUtcOffset(change.fromOffsetHours)} → ${formatUtcOffset(change.toOffsetHours)}`;
        const regions = document.createElement('span');
        regions.className = 'timezone-country-change-regions';
        regions.textContent = [...new Set(change.timezones)]
          .map(readableTimezone)
          .join(', ');
        item.append(country, offset, regions);
        return item;
      }),
    );
  }

  function setSelected(index: number): void {
    const period = periods[index];
    if (!period) return;
    activeIndex = index;
    const description = nextChangeDescription(data, period, year);
    const copy = document.createElement('span');
    copy.className = 'timezone-period-trigger-copy';
    const title = document.createElement('strong');
    title.textContent = `Pattern ${index + 1} of ${periods.length}`;
    const detail = document.createElement('span');
    detail.textContent = description;
    copy.append(title, detail);

    const chevron = document.createElement('span');
    chevron.className = 'timezone-period-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    timezonePeriodTrigger.replaceChildren(calendarRange(period), copy, chevron);
    timezonePeriodTrigger.setAttribute('aria-label', `${period.label}. ${description}`);
    options().forEach((option, optionIndex) => {
      option.setAttribute('aria-selected', String(optionIndex === index));
      option.classList.toggle('is-selected', optionIndex === index);
    });
    const range = formatTimezonePeriodDateRange(period.startMs, period.endMs);
    timezonePeriodSummaryEl.textContent = `${year} · ${range} · ${description}`;
    updateChanges(period);
  }

  timezonePeriodMenu.replaceChildren(
    ...periods.map((period, index) => {
      const description = nextChangeDescription(data, period, year);
      const option = document.createElement('button');
      option.id = `timezone-period-option-${index}`;
      option.className = 'timezone-period-option';
      option.type = 'button';
      option.role = 'option';
      option.tabIndex = -1;
      option.dataset['periodIndex'] = String(index);
      option.setAttribute('aria-selected', String(index === activeIndex));
      option.setAttribute('aria-label', `${period.label}. ${description}`);

      const copy = document.createElement('span');
      copy.className = 'timezone-period-option-copy';
      const title = document.createElement('strong');
      title.textContent = `Pattern ${index + 1}`;
      const detail = document.createElement('span');
      detail.textContent = description;
      copy.append(title, detail);
      option.append(calendarRange(period), copy);
      return option;
    }),
  );

  timezonePeriodTrigger.addEventListener('click', () => {
    setOpen(timezonePeriodMenu.hasAttribute('hidden'), true);
  });
  timezonePeriodTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true, true);
  });
  timezonePeriodMenu.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const option = event.target.closest<HTMLButtonElement>('[data-period-index]');
    if (!option) return;
    onSelect(Number(option.dataset['periodIndex']));
    setOpen(false);
    timezonePeriodTrigger.focus();
  });
  timezonePeriodMenu.addEventListener('keydown', (event) => {
    const periodOptions = options();
    const focusedIndex = periodOptions.findIndex(
      (option) => option === document.activeElement,
    );
    const baseIndex = focusedIndex < 0 ? activeIndex : focusedIndex;
    if ((event.key === 'Enter' || event.key === ' ') && focusedIndex >= 0) {
      event.preventDefault();
      periodOptions[focusedIndex]?.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      timezonePeriodTrigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = Math.max(
        0,
        Math.min(periodOptions.length - 1, baseIndex + direction),
      );
      periodOptions[nextIndex]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      periodOptions[event.key === 'Home' ? 0 : periodOptions.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (
      event.target instanceof Node &&
      !timezonePeriodMenu.parentElement?.contains(event.target)
    ) {
      setOpen(false);
    }
  });

  setSelected(activeIndex);
  return {
    setDisabled(disabled) {
      timezonePeriodTrigger.disabled = disabled;
      setOpen(false);
      if (!disabled) return;
      timezonePeriodChangesEl.hidden = true;
      timezonePeriodChangesEl.open = false;
    },
    setSelected,
  };
}
