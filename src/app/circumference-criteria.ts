import {
  gradeDescription,
  gradeLabel,
  gradeOptions,
  readGradeOptions,
  type CircumferenceNetworkMode,
  type GradeOption,
} from '../circumference/grades.js';
import {
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
      text.textContent = gradeLabel(grade);
      label.append(input, text);
      gradeInputs.append(label);

      const term = document.createElement('dt');
      term.textContent = gradeLabel(grade);
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
        ? 'The published motorway circle has unclassified segments. Road grade coverage is incomplete.'
        : 'Grade coverage starts with parts of Singapore. Include Unclassified to use other mapped metro segments.';
  }

  routeCriterionSelect.addEventListener('change', () => {
    renderGrades();
    onChange();
  });
  renderGrades();
}
