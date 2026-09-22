import './style.css';
import catalog from '../../data/midpoint-comparison.json';
const $ = (id) => document.getElementById(id);
const cases = catalog.cases,
  results = new Map();
let selected = Math.max(
    0,
    Math.min(
      cases.length - 1,
      Number(new URLSearchParams(location.search).get('case')) || 0,
    ),
  ),
  generation = 0,
  view;
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
const number = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const path = (points) =>
  points
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(3)},${(-p[1]).toFixed(3)}`)
    .join(' ');
const line = (points, color, width = 2, dash = '') =>
  `<path d="${path(points)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
function fit() {
  const c = cases[selected],
    points = [...c.first, ...c.second, ...c.current.flat()],
    xs = points.map((p) => p[0]),
    ys = points.map((p) => -p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys),
    ratio = $('current').clientWidth / $('current').clientHeight;
  const height = Math.max(maxY - minY, (maxX - minX) / ratio, 100) * 1.18,
    width = height * ratio;
  view = [(minX + maxX - width) / 2, (minY + maxY - height) / 2, width, height];
  render();
}
function overview() {
  $('overview').innerHTML = cases
    .map((c, i) => {
      const r = results.get(i);
      return `<tr class="${i === selected ? 'selected' : ''}"><td><button data-case="${i}">${String(i + 1).padStart(2, '0')} · ${c.name}</button></td>${r ? [number(r.count), r.backwards, r.reversals, number(r.maxStep) + ' m', number(r.maxDeviation) + ' m', number(r.milliseconds) + ' ms'].map((t) => `<td>${t}</td>`).join('') : '<td colspan="6" class="pending">Calculating…</td>'}</tr>`;
    })
    .join('');
}
function render() {
  if (!view) return;
  const c = cases[selected],
    r = results.get(selected),
    trace = $('trace').value;
  const sources = line(c.first, '#62746e', 3) + line(c.second, '#9ba9a2', 3, '7 4');
  const pairs =
    r && $('pairs').checked ? r.pairs.map((p) => line(p, '#d1c1e5', 0.8)).join('') : '';
  let proposed = '',
    points = [];
  if (r) {
    const lines =
      trace === 'both'
        ? [r.first, r.second]
        : [trace === 'first' ? r.first : trace === 'second' ? r.second : r.coordinates];
    proposed = lines.map((p, i) => line(p, i ? '#be6192' : '#6e42ba', 2)).join('');
    points = lines.flat();
  }
  if (trace === 'cloud') proposed = '';
  const dots =
    $('points').checked || trace === 'cloud'
      ? `<path d="${points.map((p) => `M${p[0]},${-p[1]}h0.000001`).join(' ')}" fill="none" stroke="#6e42ba" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      : '';
  $('current').innerHTML =
    sources + c.current.map((p) => line(p, '#b45b25', 2.5)).join('');
  $('proposed').innerHTML = pairs + sources + proposed + dots;
  for (const id of ['current', 'proposed'])
    $(id).setAttribute('viewBox', view.join(' '));
  $('scale').textContent =
    `Panel width ${view[2] > 1000 ? number(view[2] / 1000) + ' km' : number(view[2]) + ' m'}`;
  $('metrics').innerHTML = r
    ? [
        [
          'Matched pairs',
          number(r.count),
          `${$('spacing').value} m sample spacing`,
          false,
        ],
        [
          'Nearest matches reversing',
          number(r.backwards),
          'Opposite-side progress decreases >10 cm',
          r.backwards > 0,
        ],
        [
          'Combined-line sharp turns',
          number(r.reversals),
          'Turns >120° with steps >10 cm',
          r.reversals > 0,
        ],
        [
          'Largest disagreement',
          number(r.maxDeviation) + ' m',
          'Sampled distance between old and new',
          false,
        ],
      ]
        .map(
          ([label, value, note, warn]) =>
            `<div class="metric ${warn ? 'warn' : ''}"><small>${label}</small><strong>${value}</strong><small>${note}</small></div>`,
        )
        .join('')
    : '<p>Computing nearest matches in a background worker…</p>';
}
function select(index) {
  selected = (index + cases.length) % cases.length;
  const c = cases[selected];
  $('kind').textContent = c.kind;
  $('name').textContent = c.name;
  $('note').textContent = c.note;
  $('fixture').textContent =
    `Source fixture: ${c.fixture}. ${c.synthetic ? 'Synthetic geometry.' : 'Real source-road geometry; existing paired paths are held fixed.'}`;
  document.querySelectorAll('nav button').forEach((b, i) => {
    b.classList.toggle('active', i === selected);
    b.setAttribute('aria-current', String(i === selected));
  });
  const url = new URL(location.href);
  url.searchParams.set('case', String(selected));
  history.replaceState(null, '', url);
  fit();
  overview();
}
$('cases').innerHTML = cases
  .map(
    (c, i) =>
      `<button data-case="${i}"><span class="number">${String(i + 1).padStart(2, '0')}</span><span>${c.name}<small>${c.kind}${c.synthetic ? ' · SYNTHETIC' : ''}</small></span></button>`,
  )
  .join('');
for (const id of ['cases', 'overview'])
  $(id).addEventListener('click', (event) => {
    const b = event.target.closest('button[data-case]');
    if (b) select(Number(b.dataset.case));
  });
$('previous').onclick = () => select(selected - 1);
$('next').onclick = () => select(selected + 1);
$('fit').onclick = fit;
for (const id of ['trace', 'pairs', 'points']) $(id).onchange = render;
function calculate() {
  results.clear();
  generation++;
  worker.postMessage({ id: generation, cases, spacing: Number($('spacing').value) });
  overview();
  render();
}
$('spacing').onchange = calculate;
worker.onmessage = ({ data }) => {
  if (data.id !== generation) return;
  results.set(data.index, data.result);
  overview();
  if (data.index === selected) render();
  window.midpointComparison = {
    count: results.size,
    spacing: Number($('spacing').value),
    metrics: [...results].map(([index, r]) => ({
      name: cases[index].name,
      count: r.count,
      reversals: r.reversals,
      backwards: r.backwards,
      maxDeviation: r.maxDeviation,
      maxStep: r.maxStep,
      milliseconds: r.milliseconds,
    })),
  };
};
worker.onerror = () => {
  $('metrics').textContent = 'The comparison worker failed. Reload to retry.';
};
for (const id of ['current', 'proposed']) {
  const svg = $(id);
  let drag;
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect(),
        fx = (event.clientX - rect.left) / rect.width,
        fy = (event.clientY - rect.top) / rect.height,
        factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015)));
      if (view[2] * factor < 2 || view[2] * factor > 1e6) return;
      view = [
        view[0] + fx * view[2] * (1 - factor),
        view[1] + fy * view[3] * (1 - factor),
        view[2] * factor,
        view[3] * factor,
      ];
      render();
    },
    { passive: false },
  );
  svg.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, view: [...view] };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    view = [
      drag.view[0] - ((event.clientX - drag.x) / svg.clientWidth) * drag.view[2],
      drag.view[1] - ((event.clientY - drag.y) / svg.clientHeight) * drag.view[3],
      drag.view[2],
      drag.view[3],
    ];
    render();
  });
  svg.addEventListener('pointerup', () => (drag = null));
  svg.addEventListener('pointercancel', () => (drag = null));
}
window.addEventListener('resize', fit);
select(selected);
calculate();
