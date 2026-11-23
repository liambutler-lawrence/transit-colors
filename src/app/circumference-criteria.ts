import {
  gradeDescription,
  gradeOptions,
  readGradeOptions,
  type CircumferenceNetworkMode,
  type GradeOption,
} from '../circumference/grades.js';
import {
  AREA_KEYS,
  circumferenceStates,
  initialCircumferenceCriterion,
  initialSearchParams,
  requiredElement,
  routeCriterionSelect,
} from './context.js';

const gradeInputs = requiredElement('#route-grades', HTMLElement);
const gradeKey = requiredElement('#route-grade-key', HTMLElement);
const coverage = requiredElement('#route-grade-coverage', HTMLElement);
const selections = {
  road: readGradeOptions('road', null),
  transit: readGradeOptions('transit', null),
};
selections[initialCircumferenceCriterion] = readGradeOptions(
  initialCircumferenceCriterion,
  initialSearchParams.get('grades'),
);

export function circumferenceNetworkMode(): CircumferenceNetworkMode {
  return routeCriterionSelect.value === 'road' ? 'road' : 'transit';
}

export function allowedCircumferenceGrades(): ReadonlySet<GradeOption> {
  return selections[circumferenceNetworkMode()];
}

export function showTransitGradeCoverage(): void {
  const rides = AREA_KEYS.flatMap((areaKey) =>
    (
      circumferenceStates[areaKey].geometryVariants?.track.network.segments ?? []
    ).filter((segment) => segment.type === 'ride'),
  );
  const reviewed = rides.filter((segment) => segment.grade !== undefined).length;
  coverage.textContent = `${reviewed.toLocaleString('en-US')} of ${rides.length.toLocaleString('en-US')} transit ride segments have a grade. The search uses reviewed segments only.`;
  if (reviewed < rides.length) {
    const reviewGaps = document.createElement('a');
    reviewGaps.href =
      'https://github.com/liambutler-lawrence/transit-colors/blob/main/docs/circumference-transit-grade-gaps.md';
    reviewGaps.textContent = 'See segments awaiting verification';
    coverage.append(' ', reviewGaps);
  }
}

export function showRoadGradeCoverage(total: number, pending: number): void {
  const reviewed = (total - pending).toLocaleString('en-US');
  coverage.textContent = `${reviewed} of ${total.toLocaleString('en-US')} road segments have a grade. The search uses reviewed segments only.`;
}

export function writeCircumferenceCriteria(url: URL): void {
  url.searchParams.delete('criterion');
  url.searchParams.delete('network');
  url.searchParams.delete('grades');
  if (url.searchParams.get('product') !== 'circumference') return;

  const mode = circumferenceNetworkMode();
  const grades = selections[mode];
  if (mode === 'road') url.searchParams.set('network', mode);
  if (grades.size !== gradeOptions(mode).length) {
    url.searchParams.set('grades', [...grades].sort().join(','));
  }
}

export function installCircumferenceCriteria(onChange: () => void): void {
  function renderGrades(): void {
    const mode = circumferenceNetworkMode();
    const grades = selections[mode];
    gradeInputs.replaceChildren();
    gradeKey.replaceChildren();
    for (const grade of gradeOptions(mode)) {
      const description = gradeDescription(mode, grade);
      const label = document.createElement('label');
      label.title = description;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = grades.has(grade);
      const text = document.createElement('span');
      text.textContent = grade;
      label.append(input, text);
      gradeInputs.append(label);

      const term = document.createElement('dt');
      term.textContent = grade;
      const definition = document.createElement('dd');
      definition.textContent = description;
      gradeKey.append(term, definition);
      input.addEventListener('change', () => {
        if (input.checked) grades.add(grade);
        else grades.delete(grade);
        onChange();
      });
    }
    coverage.textContent =
      mode === 'road'
        ? 'Only reviewed road segments enter the search.'
        : 'Only reviewed ride segments enter the search. Coverage expands as tracks are classified.';
  }

  routeCriterionSelect.addEventListener('change', () => {
    renderGrades();
    onChange();
  });
  renderGrades();
}
