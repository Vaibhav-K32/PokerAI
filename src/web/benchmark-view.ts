// Recognition Benchmarks: a developer evaluation tool. Runs a labeled dataset
// through a predictor (stored fixture readings, or Claude after an explicit
// confirmation), shows metrics with their counts, explores samples, compares
// saved runs, exports JSON and CSV, and annotates ground truth by hand. It
// measures this dataset only; it is not a guarantee of recognition accuracy.
import type { Card } from '../core/types.js';
import { builtinDataset, builtinSvg } from '../benchmark/builtin.js';
import { DatasetError, parseDataset, parseSample, serializeDataset } from '../benchmark/dataset.js';
import { compareRuns, parseRun, runToCsv, runToJson, SMALL_SAMPLE, type BenchmarkRun, type Summary } from '../benchmark/report.js';
import { mockPredictor, runBenchmark, selectSamples, type Predictor } from '../benchmark/runner.js';
import {
  DATASET_KIND, DATASET_SCHEMA_VERSION, DIFFICULTY_TAGS,
  type BenchmarkDataset, type BenchmarkSample, type DifficultyTag, type GroundTruth, type Prediction, type Ratio, type SampleSource, type TruthSlot,
} from '../benchmark/types.js';
import { physicalToRecognition } from '../physical/convert.js';
import { claudePhysicalProvider, claudeScreenshotProvider } from '../vision/providers.js';
import type { Street } from '../vision/screenshot.js';
import { pickCard } from './card-picker.js';
import { cardName, renderCardFace } from './cards-view.js';
import { decodeImage, prepareUpload, svgToPng } from './image.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: ' + id);
  return node as T;
}

function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function button(parent: HTMLElement, text: string, className = 'secondary') {
  const b = add(parent, 'button', text, className);
  b.type = 'button';
  return b;
}

const RUNS_KEY = 'poker-study:benchmark-runs';
const ANNOTATIONS_KEY = 'poker-study:annotations';
const MAX_SAVED_RUNS = 10;

const pct = (r: Ratio) => (r.value === null ? 'n/a' : (r.value * 100).toFixed(1) + '%');
const counts = (r: Ratio) => r.numerator + ' / ' + r.denominator;
const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;

function loadRuns(): BenchmarkRun[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.flatMap(r => { try { return [parseRun(r)]; } catch { return []; } }) : [];
  } catch {
    return [];
  }
}

function loadAnnotations(): BenchmarkSample[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ANNOTATIONS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.flatMap(s => { try { return [parseSample(s)]; } catch { return []; } }) : [];
  } catch {
    return [];
  }
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initBenchmarks() {
  const status = element('bench-status');
  const progress = element('bench-progress');
  const datasetInfo = element('bench-dataset-info');
  const runButton = element<HTMLButtonElement>('bench-run');
  const cancelButton = element<HTMLButtonElement>('bench-cancel');
  const results = element('bench-results');

  let dataset: BenchmarkDataset = builtinDataset();
  /** Images for file-based samples, matched by file name. */
  const files = new Map<string, File>();
  let run: BenchmarkRun | null = null;
  let controller: AbortController | null = null;
  let runs = loadRuns();

  // -------------------------------------------------------------------------
  // Dataset
  // -------------------------------------------------------------------------
  function showDataset() {
    const bySource = (s: SampleSource) => dataset.samples.filter(x => x.sourceType === s).length;
    const missingImages = dataset.samples.filter(s => s.image.kind === 'file' && !files.has(baseName(s.image.path))).length;
    datasetInfo.textContent = dataset.name + ' · version ' + dataset.datasetVersion + ' · ' + dataset.samples.length + ' samples ('
      + bySource('digital_screenshot') + ' screenshots, ' + bySource('physical_photo') + ' photos) · ' + dataset.sequences.length + ' sequences'
      + (dataset.samples.some(s => s.annotationStatus === 'draft') ? ' · includes draft annotations' : '')
      + (missingImages ? ' · ' + missingImages + ' image file(s) not loaded yet' : '');
  }
  element<HTMLSelectElement>('bench-dataset').addEventListener('change', event => {
    const v = (event.target as HTMLSelectElement).value;
    if (v === 'builtin') dataset = builtinDataset();
    else if (v === 'annotations') {
      const samples = loadAnnotations();
      if (!samples.length) {
        status.textContent = 'There are no saved annotations yet. Create some in the annotation tool below.';
        (event.target as HTMLSelectElement).value = 'builtin';
        dataset = builtinDataset();
      } else {
        dataset = { kind: DATASET_KIND, schemaVersion: DATASET_SCHEMA_VERSION, name: 'My annotations', datasetVersion: 'local-' + samples.length, samples, sequences: [] };
      }
    }
    showDataset();
  });
  element<HTMLInputElement>('bench-dataset-file').addEventListener('change', async event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      dataset = parseDataset(await file.text());
      element<HTMLSelectElement>('bench-dataset').value = 'imported';
      status.textContent = 'Loaded and validated “' + dataset.name + '”. Add its image files if it uses any.';
    } catch (error) {
      status.textContent = 'Not loaded: ' + (error instanceof Error ? error.message : 'invalid dataset.');
    }
    showDataset();
  });
  element<HTMLInputElement>('bench-images').addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    for (const f of input.files ?? []) files.set(f.name, f);
    input.value = '';
    showDataset();
  });

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------
  async function imageFor(sample: BenchmarkSample): Promise<Blob | null> {
    if (sample.image.kind === 'synthetic') {
      const svg = builtinSvg(sample.image.fixture);
      return svg ? svgToPng(svg, sample.id + '.png') : null;
    }
    return files.get(baseName(sample.image.path)) ?? null;
  }

  /** Claude through the app server, the same endpoints the app uses; the key stays on the server. */
  function claudePredictor(): Predictor {
    return {
      id: 'claude-browser',
      kind: 'real',
      async predict(sample, signal): Promise<Prediction> {
        const image = await imageFor(sample);
        if (!image) return { kind: 'failed', reason: 'The image for this sample is not loaded.', latencyMs: 0, attempts: 0, timedOut: false };
        const bitmap = await decodeImage(image);
        const upload = await prepareUpload(bitmap);
        bitmap.close();
        const t0 = performance.now();
        if (sample.sourceType === 'physical_photo') {
          const outcome = await claudePhysicalProvider().recognizePhysicalTable(upload, signal);
          const latencyMs = performance.now() - t0;
          if (outcome.kind === 'cancelled') return outcome;
          if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason, latencyMs, attempts: 1, timedOut: /too long/i.test(outcome.reason) };
          return {
            kind: 'recognized', recognition: physicalToRecognition(outcome.observation, sample.chipConfig ?? { denominations: [] }), physical: outcome.observation,
            latencyMs, providerId: outcome.observation.providerId, modelId: outcome.observation.modelId, attempts: 1,
          };
        }
        const outcome = await claudeScreenshotProvider().recognize(upload, signal);
        const latencyMs = performance.now() - t0;
        if (outcome.kind === 'cancelled') return outcome;
        if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason, latencyMs, attempts: 1, timedOut: /too long/i.test(outcome.reason) };
        return { kind: 'recognized', recognition: outcome.recognition, latencyMs, providerId: outcome.recognition.providerId, modelId: outcome.recognition.modelId, attempts: 1 };
      },
    };
  }

  runButton.addEventListener('click', async () => {
    const mode = element<HTMLSelectElement>('bench-mode').value;
    const sources = (['digital_screenshot', 'physical_photo'] as const).filter(s => element<HTMLInputElement>('bench-src-' + s).checked);
    if (!sources.length) {
      status.textContent = 'Choose at least one source.';
      return;
    }
    const limitText = element<HTMLInputElement>('bench-limit').value.trim();
    const limit = limitText ? Math.max(1, Math.floor(Number(limitText))) : null;
    const keepRaw = element<HTMLInputElement>('bench-raw').checked;
    const chosen = selectSamples(dataset, { limit, sources });
    if (!chosen.length) {
      status.textContent = 'No samples match these settings.';
      return;
    }
    if (mode === 'real' && !confirm('This sends ' + chosen.length + ' image(s) to the Claude API through this app’s server. Each is a paid request, and the API key stays on the server. Continue?')) {
      status.textContent = 'Not started; nothing was sent.';
      return;
    }
    controller = new AbortController();
    runButton.disabled = true;
    cancelButton.hidden = false;
    status.textContent = mode === 'real' ? 'Running with Claude, two images at a time…' : 'Running with stored fixture readings (no API calls)…';
    try {
      run = await runBenchmark(dataset, mode === 'real' ? claudePredictor() : mockPredictor(), {
        limit, sources, keepRaw, concurrency: 2, signal: controller.signal,
        onProgress: p => {
          progress.textContent = p.done + ' of ' + p.total + ' done · ' + p.failed + ' failed' + (p.running.length ? ' · running: ' + p.running.join(', ') : '');
        },
      });
      saveRun(run);
      status.textContent = run.status === 'cancelled' ? 'Cancelled. Finished samples were scored and saved.' : 'Done. The run is saved in this browser.';
      showRun(run);
    } catch (error) {
      status.textContent = 'The run failed: ' + (error instanceof Error ? error.message : 'unknown error');
    } finally {
      controller = null;
      runButton.disabled = false;
      cancelButton.hidden = true;
    }
  });
  cancelButton.addEventListener('click', () => controller?.abort());

  function saveRun(r: BenchmarkRun) {
    const stored = r.config.keepRaw ? r : { ...r, results: r.results.map(({ raw: _raw, ...rest }) => rest) };
    runs = [stored as BenchmarkRun, ...runs.filter(x => x.id !== r.id)].slice(0, MAX_SAVED_RUNS);
    try {
      localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
    } catch {
      status.textContent += ' (Browser storage is full, so this run was not saved; export it instead.)';
    }
    renderRuns();
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  function metricTable(parent: HTMLElement, title: string, rows: [string, Ratio | string | number | null][]) {
    const box = add(parent, 'div', '', 'bench-table-box');
    add(box, 'h4', title);
    const table = add(box, 'table', '', 'bench-table');
    const head = add(add(table, 'thead'), 'tr');
    for (const h of ['Metric', 'Value', 'Count']) add(head, 'th', h);
    const body = add(table, 'tbody');
    for (const [label, v] of rows) {
      const tr = add(body, 'tr');
      add(tr, 'td', label);
      if (v && typeof v === 'object') {
        add(tr, 'td', pct(v));
        add(tr, 'td', counts(v));
      } else {
        add(tr, 'td', v === null ? 'n/a' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);
        add(tr, 'td', '');
      }
    }
  }

  function cardRows(s: Summary['cards']): [string, Ratio | number][] {
    return [['Exact card', s.exact], ['Rank', s.rank], ['Suit', s.suit], ['Missing', s.missing], ['False positives', s.falsePositive],
      ['Unreadable left unknown', s.unknownHandled], ['Card backs left hidden', s.hiddenHandled]];
  }

  function showRun(r: BenchmarkRun) {
    results.hidden = false;
    const s = r.summary;
    const overview = element('bench-overview');
    overview.replaceChildren();
    const meta = add(overview, 'p', '', 'fine-print');
    meta.textContent = r.dataset.name + ' (' + r.dataset.version + ') · ' + r.provider.id + (r.provider.modelIds.length ? ' · ' + r.provider.modelIds.join(', ') : '')
      + ' · ' + new Date(r.startedAt).toLocaleString() + (r.commit ? ' · commit ' + r.commit : '') + ' · ' + r.status;
    const tiles = add(overview, 'dl', '', 'recon-metrics');
    const tile = (k: string, v: string) => {
      const d = add(tiles, 'div');
      add(d, 'dt', k);
      add(d, 'dd', v);
    };
    tile('Dataset size', String(r.dataset.samples));
    tile('Evaluated', String(s.samples.evaluated));
    tile('Recognized', String(r.usage.successes));
    tile('Failed', String(s.samples.failed));
    tile('Exact card', pct(s.cards.exact) + ' (' + counts(s.cards.exact) + ')');
    tile('Rank', pct(s.cards.rank));
    tile('Suit', pct(s.cards.suit));
    tile('Seat assignment', pct(s.table.seatAssignment));
    tile('Mean latency', s.latency ? Math.round(s.latency.meanMs) + ' ms' : 'n/a');
    tile('Cost', 'unavailable');
    const warn = add(overview, 'ul', '', 'shot-warnings');
    for (const w of r.warnings) add(warn, 'li', w);

    const breakdown = element('bench-breakdown');
    breakdown.replaceChildren();
    for (const [source, label] of [['digital_screenshot', 'Digital screenshots'], ['physical_photo', 'Physical photos']] as const) {
      const b = s.bySource[source];
      if (b) metricTable(breakdown, label + ' (' + b.samples + ' samples)', cardRows(b.cards));
    }
    metricTable(breakdown, 'Community cards', cardRows(s.community));
    metricTable(breakdown, 'Player cards', cardRows(s.player));
    metricTable(breakdown, 'Table state', [
      ['Player count', s.table.playerCount], ['Seat assignment', s.table.seatAssignment], ['Missing players', s.table.missingPlayers], ['Extra players', s.table.extraPlayers],
      ['Dealer position', s.table.dealer], ['Your seat', s.table.hero], ['Street', s.table.street], ['Folded status', s.table.folded], ['Invalid states', s.table.invalidState],
    ]);
    metricTable(breakdown, 'Chips and pot', [
      ['Pot exact', s.pot.exact], ['Pot mean absolute error', s.pot.meanAbsoluteError], ['Pot missing', s.pot.missing], ['Pot invented', s.pot.invented],
      ['Stack exact', s.stacks.exact], ['Stack mean absolute error', s.stacks.meanAbsoluteError], ['Stack missing', s.stacks.missing], ['Stacks correctly unknown', s.stacks.correctlyUnknown],
      ['Bet exact', s.bets.exact], ['Bet missing', s.bets.missing],
    ]);
    metricTable(breakdown, 'Physical detection (' + s.physical.samples + ' photos; outlines unsupported in ' + s.physical.localizationUnsupported + ')', [
      ['Detection recall (IoU ≥ 0.5)', s.physical.recall], ['Detection precision', s.physical.precision], ['Mean IoU of matches', s.physical.meanIoU],
      ['Correct board/seat grouping', s.physical.grouping], ...s.physical.byCardTag.map(t => [t.tag[0].toUpperCase() + t.tag.slice(1) + ' cards, exact', t.exact] as [string, Ratio]),
    ]);

    const difficulty = element('bench-difficulty');
    difficulty.replaceChildren();
    metricTable(difficulty, 'By difficulty (tags can overlap)', s.difficulty.map(d => [
      d.tag.replace('_', ' ') + ' · ' + d.samples + ' sample' + (d.samples === 1 ? '' : 's') + (d.smallSample ? ' · too few to compare' : ''), d.exact,
    ]));
    add(difficulty, 'p', 'Categories with fewer than ' + SMALL_SAMPLE + ' samples are shown for reference only.', 'fine-print');

    const confidence = element('bench-confidence');
    confidence.replaceChildren();
    metricTable(confidence, 'Exact card by the reader’s confidence label', [
      ...s.confidence.categories.map(c => [c.label === 'unrated' ? 'Not rated' : c.label[0].toUpperCase() + c.label.slice(1), c.exact] as [string, Ratio]),
      ['High-confidence errors', s.confidence.highConfidenceError], ['Low-confidence but correct', s.confidence.lowConfidenceCorrect],
    ]);
    add(confidence, 'p', 'The labels are the model’s own categories, not probabilities, so reliability curves and expected calibration error are unavailable. These rows are measured accuracy within each label.', 'fine-print');

    const tracking = element('bench-tracking');
    tracking.replaceChildren();
    metricTable(tracking, 'Tracking (' + s.tracking.scored + ' of ' + s.tracking.sequences + ' sequences scored)', [
      ['Player identity consistency', s.tracking.identity], ['Card reveals found', s.tracking.revealRecall], ['Reveals reported that did not happen', s.tracking.revealFalsePositives],
      ['Street transitions', s.tracking.streets], ['False out-of-order warnings', s.tracking.falseOrderFlags],
      ['False contradictions', s.tracking.falseContradictions], ['Contradictions caused by reading errors', s.tracking.justifiedContradictions],
      ['Missed contradictions', s.tracking.missedContradictions], ['Open gaps found (recall)', s.tracking.unresolvedRecall], ['Open gaps correct (precision)', s.tracking.unresolvedPrecision],
      ['Checkpoints matching the truth', s.tracking.checkpoints],
    ]);

    const failures = element('bench-failures');
    failures.replaceChildren();
    add(failures, 'h4', 'Failure analysis');
    const cats = add(failures, 'p', Object.entries(s.errorsByCategory).map(([k, v]) => k.replace(/_/g, ' ') + ': ' + v).join(' · ') || 'No errors.', 'fine-print');
    cats.setAttribute('aria-label', 'Errors by category');
    if (s.ambiguousFields) add(failures, 'p', s.ambiguousFields + ' recognized field(s) were marked medium, low, or not rated (ambiguous).', 'fine-print');
    const list = add(failures, 'ul', '', 'bench-errors');
    for (const res of r.results) for (const e of res.errors) {
      const li = add(list, 'li');
      const b = button(li, res.sampleId, 'secondary link-button');
      b.addEventListener('click', () => explore(res.sampleId));
      li.append(' ' + e.category.replace(/_/g, ' ') + ' at ' + e.location + ': expected ' + e.expected + ', got ' + e.actual);
    }

    const pick = element<HTMLSelectElement>('bench-sample');
    pick.replaceChildren();
    for (const res of r.results) {
      const o = add(pick, 'option', res.sampleId + (res.errors.length ? ' · ' + res.errors.length + ' error(s)' : '') + (res.status !== 'evaluated' ? ' · ' + res.status : ''));
      o.value = res.sampleId;
    }
    explore(r.results.find(x => x.errors.length)?.sampleId ?? r.results[0]?.sampleId);
  }

  async function explore(sampleId: string | undefined) {
    if (!run || !sampleId) return;
    element<HTMLSelectElement>('bench-sample').value = sampleId;
    const res = run.results.find(r => r.sampleId === sampleId);
    const sample = dataset.samples.find(s => s.id === sampleId);
    const box = element('bench-explorer');
    box.replaceChildren();
    if (!res) return;
    const grid = add(box, 'div', '', 'review-grid');
    const left = add(grid, 'div');
    const right = add(grid, 'div');
    if (sample) {
      try {
        const image = await imageFor(sample);
        if (image) {
          const img = add(left, 'img', '', 'bench-image');
          const url = URL.createObjectURL(image);
          img.src = url;
          img.alt = 'Sample ' + sampleId;
          img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        } else add(left, 'p', 'Image not loaded.', 'fine-print');
      } catch {
        add(left, 'p', 'Image could not be drawn.', 'fine-print');
      }
      add(left, 'p', sample.sourceType.replace('_', ' ') + ' · tags: ' + (sample.tags.join(', ') || 'none') + ' · annotation ' + sample.annotationStatus + (sample.notes ? ' · ' + sample.notes : ''), 'fine-print');
    }
    add(right, 'p', 'Status: ' + res.status + (res.latencyMs !== null ? ' · ' + Math.round(res.latencyMs) + ' ms' : '') + (res.modelId ? ' · ' + res.modelId : '') + (res.failure ? ' · ' + res.failure : ''));
    const table = add(right, 'table', '', 'bench-table');
    const head = add(add(table, 'thead'), 'tr');
    for (const h of ['Field', 'Ground truth', 'Recognized', 'Result', 'Confidence']) add(head, 'th', h);
    const body = add(table, 'tbody');
    for (const c of res.cards) {
      const tr = add(body, 'tr', '', c.outcome === 'exact' || c.outcome.startsWith('correct') ? '' : 'bench-bad');
      for (const v of [c.location, c.truth, c.predicted, c.outcome.replace(/_/g, ' '), c.confidence ?? '—']) add(tr, 'td', v);
    }
    if (res.table) {
      for (const n of res.table.numbers) {
        const tr = add(body, 'tr', '', n.truth === n.predicted ? '' : 'bench-bad');
        for (const v of [n.field, n.truth === null ? 'not visible' : String(n.truth), n.predicted === null ? 'unknown' : String(n.predicted), n.truth === n.predicted ? 'match' : 'differs', '']) add(tr, 'td', v);
      }
      for (const [k, v] of [['dealer', res.table.dealer], ['your seat', res.table.hero], ['street', res.table.street]] as const) {
        const tr = add(body, 'tr', '', v === 'correct' || v === 'n/a' ? '' : 'bench-bad');
        for (const x of [k, '', '', v, '']) add(tr, 'td', x);
      }
    }
    if (res.warnings.length) add(right, 'p', 'Recognizer notes: ' + res.warnings.join(' '), 'fine-print');
    if (res.invalidState) add(right, 'p', 'The recognized state breaks the app’s own checks (invalid state).', 'issue-error');
  }
  element<HTMLSelectElement>('bench-sample').addEventListener('change', event => void explore((event.target as HTMLSelectElement).value));

  element('bench-export-json').addEventListener('click', () => { if (run) download(runToJson(run), run.id + '.json', 'application/json'); });
  element('bench-export-csv').addEventListener('click', () => { if (run) download(runToCsv(run), run.id + '.csv', 'text/csv'); });

  // -------------------------------------------------------------------------
  // Saved runs and comparison
  // -------------------------------------------------------------------------
  function renderRuns() {
    const list = element('bench-runs');
    list.replaceChildren();
    const a = element<HTMLSelectElement>('bench-compare-a');
    const b = element<HTMLSelectElement>('bench-compare-b');
    for (const sel of [a, b]) sel.replaceChildren();
    if (!runs.length) add(list, 'li', 'No saved runs yet.', 'empty-list');
    runs.forEach((r, i) => {
      const li = add(list, 'li', '', 'hand-item');
      const open = button(li, new Date(r.startedAt).toLocaleString() + ' · ' + r.provider.id + ' · ' + r.dataset.version + ' · exact ' + pct(r.summary.cards.exact), 'hand-open');
      open.addEventListener('click', () => {
        run = r;
        showRun(r);
      });
      for (const sel of [a, b]) {
        const o = add(sel, 'option', new Date(r.startedAt).toLocaleString() + ' · ' + r.provider.id);
        o.value = String(i);
      }
    });
    if (runs.length > 1) {
      a.value = '1';
      b.value = '0';
    }
  }
  element('bench-compare').addEventListener('click', () => {
    const out = element('bench-compare-result');
    out.replaceChildren();
    const before = runs[Number(element<HTMLSelectElement>('bench-compare-a').value)];
    const after = runs[Number(element<HTMLSelectElement>('bench-compare-b').value)];
    if (!before || !after) {
      add(out, 'p', 'Save at least two runs to compare.');
      return;
    }
    const c = compareRuns(before, after);
    add(out, 'p', c.equivalent ? 'These runs are directly comparable.' : 'Not equivalent: ' + c.reasons.join(' '), c.equivalent ? '' : 'recon-warn');
    for (const n of c.notes) add(out, 'p', n, 'fine-print');
    const table = add(out, 'table', '', 'bench-table');
    const head = add(add(table, 'thead'), 'tr');
    for (const h of ['Metric', 'Baseline', 'Current', 'Change']) add(head, 'th', h);
    const body = add(table, 'tbody');
    const fmt = (v: number | null, key: string) => (v === null ? 'n/a' : key.endsWith('mae') || key.startsWith('latency') ? v.toFixed(1) : (v * 100).toFixed(1) + '%');
    for (const m of c.metrics) {
      const tr = add(body, 'tr', '', 'change-' + m.change);
      for (const v of [m.label, fmt(m.before, m.key), fmt(m.after, m.key), m.change]) add(tr, 'td', v);
    }
  });
  element<HTMLInputElement>('bench-import-run').addEventListener('change', async event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const imported = parseRun(await file.text());
      saveRun(imported);
      run = imported;
      showRun(imported);
      status.textContent = 'Imported run ' + imported.id + '.';
    } catch (error) {
      status.textContent = 'Not imported: ' + (error instanceof Error ? error.message : 'invalid run.');
    }
  });

  // -------------------------------------------------------------------------
  // Annotation tool
  // -------------------------------------------------------------------------
  type Slot = { kind: 'card'; card: Card | null } | { kind: 'face_down' } | { kind: 'unreadable' };
  interface Seat { name: string; cards: Slot[]; stack: string; bet: string; folded: '' | 'yes' | 'no' }
  interface Draft { id: string; source: SampleSource; seats: Seat[]; board: Slot[]; pot: string; street: '' | Street; dealer: number | null; hero: number | null; sb: string; bb: string; tags: Set<DifficultyTag>; notes: string; verified: boolean }
  const blankSeat = (): Seat => ({ name: '', cards: [{ kind: 'face_down' }, { kind: 'face_down' }], stack: '', bet: '', folded: '' });
  let draft: Draft = { id: '', source: 'digital_screenshot', seats: [blankSeat(), blankSeat()], board: [], pot: '', street: '', dealer: null, hero: null, sb: '', bb: '', tags: new Set(), notes: '', verified: false };
  let annotationImage: File | null = null;
  const annotateBox = element('bench-annotate-form');
  const annotateStatus = element('bench-annotate-status');

  element<HTMLInputElement>('bench-annotate-image').addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    annotationImage = file;
    files.set(file.name, file);
    const img = element<HTMLImageElement>('bench-annotate-preview');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(file);
    img.hidden = false;
    if (!draft.id) draft.id = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 60);
    renderAnnotation();
  });

  const chips = (text: string) => (text.trim() === '' ? null : Number(text));

  function toTruth(d: Draft): GroundTruth {
    const slot = (s: Slot): TruthSlot => ({ card: s.kind === 'card' ? (s.card ? { kind: 'card', card: s.card } : { kind: 'unreadable' }) : { kind: s.kind } });
    return {
      players: d.seats.map(s => ({ name: s.name.trim() || null, cards: s.cards.map(slot), stack: chips(s.stack), bet: chips(s.bet), folded: s.folded === '' ? null : s.folded === 'yes' })),
      board: d.board.map(slot), pot: chips(d.pot), dealerSeat: d.dealer, heroSeat: d.hero, street: d.street || null, smallBlind: chips(d.sb), bigBlind: chips(d.bb),
    };
  }

  /** Card slots left blank: ground truth needs a card, or an explicit face down or unreadable. */
  function unpicked(d: Draft): string[] {
    return [
      ...d.board.flatMap((s, i) => (s.kind === 'card' && !s.card ? ['board card ' + (i + 1)] : [])),
      ...d.seats.flatMap((seat, i) => seat.cards.flatMap((s, j) => (s.kind === 'card' && !s.card ? ['seat ' + (i + 1) + ' card ' + (j + 1)] : []))),
    ];
  }

  function toSample(d: Draft) {
    const blank = unpicked(d);
    if (blank.length) throw new Error('Pick ' + blank.join(', ') + ', or set ' + (blank.length === 1 ? 'it' : 'them') + ' to Face down or Unreadable.');
    return {
      id: d.id, sourceType: d.source, image: { kind: 'file', path: annotationImage?.name ?? (d.id + '.png') },
      groundTruth: toTruth(d), tags: [...d.tags], metadata: {}, annotationStatus: d.verified ? 'verified' : 'draft', ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    };
  }

  function slotEditor(parent: HTMLElement, label: string, slot: Slot, set: (s: Slot) => void) {
    const wrap = add(parent, 'div', '', 'bench-slot');
    const kind = add(wrap, 'select');
    kind.setAttribute('aria-label', label + ' state');
    for (const [v, t] of [['card', 'Card'], ['face_down', 'Face down'], ['unreadable', 'Unreadable']]) {
      const o = add(kind, 'option', t);
      o.value = v;
    }
    kind.value = slot.kind === 'card' && !slot.card ? 'card' : slot.kind;
    kind.addEventListener('change', () => { set(kind.value === 'card' ? { kind: 'card', card: null } : { kind: kind.value as 'face_down' | 'unreadable' }); renderAnnotation(); });
    if (slot.kind === 'card') {
      const pickButton = button(wrap, '', 'card-slot' + (slot.card ? ' filled' : ''));
      if (slot.card) renderCardFace(add(pickButton, 'span', '', 'face'), slot.card);
      else add(pickButton, 'span', 'Pick', 'hint');
      pickButton.setAttribute('aria-label', label + ': ' + (slot.card ? cardName(slot.card) : 'not chosen') + '. Pick the card.');
      pickButton.addEventListener('click', async () => {
        const used = new Set<Card>([...draft.board, ...draft.seats.flatMap(s => s.cards)].flatMap(s => (s.kind === 'card' && s.card && s !== slot ? [s.card] : [])));
        const result = await pickCard({ title: label, note: 'Pick the card you can see in the image. This is ground truth, so check it carefully.', current: slot.card, used, canConfirm: false, clearLabel: 'Clear' });
        if (result.kind === 'card') set({ kind: 'card', card: result.card });
        else if (result.kind === 'clear') set({ kind: 'card', card: null });
        renderAnnotation();
      });
    }
  }

  function renderAnnotation() {
    annotateBox.replaceChildren();
    const d = draft;
    const top = add(annotateBox, 'div', '', 'review-row');
    const idWrap = add(top, 'label', '', 'review-field');
    add(idWrap, 'span', 'Sample ID', 'review-label');
    const id = add(idWrap, 'input');
    id.value = d.id;
    id.maxLength = 80;
    id.addEventListener('change', () => { d.id = id.value.trim(); });
    const srcWrap = add(top, 'label', '', 'review-field');
    add(srcWrap, 'span', 'Source', 'review-label');
    const src = add(srcWrap, 'select');
    for (const [v, t] of [['digital_screenshot', 'Digital screenshot'], ['physical_photo', 'Physical photo']]) {
      const o = add(src, 'option', t);
      o.value = v;
    }
    src.value = d.source;
    src.addEventListener('change', () => { d.source = src.value as SampleSource; });

    const boardBox = add(annotateBox, 'fieldset', '', 'review-section');
    add(boardBox, 'legend', 'Community cards');
    const count = add(boardBox, 'select');
    count.setAttribute('aria-label', 'Number of board cards');
    for (const n of [0, 3, 4, 5]) {
      const o = add(count, 'option', n + ' cards');
      o.value = String(n);
    }
    count.value = String(d.board.length);
    count.addEventListener('change', () => {
      const n = Number(count.value);
      d.board = Array.from({ length: n }, (_, i) => d.board[i] ?? { kind: 'card', card: null });
      renderAnnotation();
    });
    const slots = add(boardBox, 'div', '', 'bench-slots');
    d.board.forEach((s, i) => slotEditor(slots, 'Board card ' + (i + 1), s, next => { d.board[i] = next; }));

    const seatsBox = add(annotateBox, 'fieldset', '', 'review-section');
    add(seatsBox, 'legend', 'Seats, clockwise from the bottom of the image');
    d.seats.forEach((s, i) => {
      const seat = add(seatsBox, 'fieldset', '', 'review-seat');
      add(seat, 'legend', 'Seat ' + (i + 1));
      const row = add(seat, 'div', '', 'review-row');
      const field = (label: string, value: string, set: (v: string) => void, numeric = true) => {
        const w = add(row, 'label', '', 'review-field');
        add(w, 'span', label, 'review-label');
        const input = add(w, 'input');
        if (numeric) {
          input.type = 'number';
          input.min = '0';
          input.step = '1';
          input.placeholder = 'not visible';
        } else input.placeholder = 'no visible name';
        input.value = value;
        input.addEventListener('change', () => set(input.value));
      };
      field('Name', s.name, v => { s.name = v; }, false);
      field('Stack', s.stack, v => { s.stack = v; });
      field('Bet', s.bet, v => { s.bet = v; });
      const foldWrap = add(row, 'label', '', 'review-field');
      add(foldWrap, 'span', 'Folded', 'review-label');
      const fold = add(foldWrap, 'select');
      for (const [v, t] of [['', 'Not visible'], ['no', 'In the hand'], ['yes', 'Folded']]) {
        const o = add(fold, 'option', t);
        o.value = v;
      }
      fold.value = s.folded;
      fold.addEventListener('change', () => { s.folded = fold.value as Seat['folded']; });
      const roles = add(seat, 'div', '', 'review-row roles');
      for (const [label, key] of [['This is the user', 'hero'], ['Dealer button', 'dealer']] as const) {
        const w = add(roles, 'label', '', 'checkbox');
        const r = add(w, 'input');
        r.type = 'radio';
        r.name = 'bench-' + key;
        r.checked = d[key] === i;
        w.append(' ' + label);
        r.addEventListener('change', () => { d[key] = i; });
      }
      const cards = add(seat, 'div', '', 'bench-slots');
      if (s.cards.length) s.cards.forEach((c, j) => slotEditor(cards, 'Seat ' + (i + 1) + ' card ' + (j + 1), c, next => { s.cards[j] = next; }));
      const toggle = button(cards, s.cards.length ? 'No cards shown' : 'Shows two cards');
      toggle.addEventListener('click', () => { s.cards = s.cards.length ? [] : [{ kind: 'face_down' }, { kind: 'face_down' }]; renderAnnotation(); });
      const remove = button(seat, 'Remove seat');
      remove.disabled = d.seats.length <= 2;
      remove.addEventListener('click', () => {
        d.seats.splice(i, 1);
        if (d.hero === i) d.hero = null;
        if (d.dealer === i) d.dealer = null;
        renderAnnotation();
      });
    });
    const addSeat = button(seatsBox, 'Add seat');
    addSeat.disabled = d.seats.length >= 10;
    addSeat.addEventListener('click', () => { d.seats.push(blankSeat()); renderAnnotation(); });

    const table = add(annotateBox, 'fieldset', '', 'review-section');
    add(table, 'legend', 'Table and difficulty');
    const row = add(table, 'div', '', 'review-row');
    const num = (label: string, value: string, set: (v: string) => void) => {
      const w = add(row, 'label', '', 'review-field');
      add(w, 'span', label, 'review-label');
      const input = add(w, 'input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.placeholder = 'not visible';
      input.value = value;
      input.addEventListener('change', () => set(input.value));
    };
    num('Pot shown', d.pot, v => { d.pot = v; });
    num('Small blind', d.sb, v => { d.sb = v; });
    num('Big blind', d.bb, v => { d.bb = v; });
    const streetWrap = add(row, 'label', '', 'review-field');
    add(streetWrap, 'span', 'Street', 'review-label');
    const street = add(streetWrap, 'select');
    for (const [v, t] of [['', 'Not determinable'], ['preflop', 'Preflop'], ['flop', 'Flop'], ['turn', 'Turn'], ['river', 'River']]) {
      const o = add(street, 'option', t);
      o.value = v;
    }
    street.value = d.street;
    street.addEventListener('change', () => { d.street = street.value as Draft['street']; });
    const tagBox = add(table, 'div', '', 'bench-tags');
    for (const tag of DIFFICULTY_TAGS) {
      const w = add(tagBox, 'label', '', 'checkbox');
      const c = add(w, 'input');
      c.type = 'checkbox';
      c.checked = d.tags.has(tag);
      w.append(' ' + tag.replace(/_/g, ' '));
      c.addEventListener('change', () => { if (c.checked) d.tags.add(tag); else d.tags.delete(tag); });
    }
    const notesWrap = add(table, 'label', '', 'review-field');
    add(notesWrap, 'span', 'Notes', 'review-label');
    const notes = add(notesWrap, 'input');
    notes.value = d.notes;
    notes.maxLength = 500;
    notes.addEventListener('change', () => { d.notes = notes.value; });
    const verify = add(table, 'label', '', 'checkbox');
    const v = add(verify, 'input');
    v.type = 'checkbox';
    v.checked = d.verified;
    verify.append(' I checked every field against the image myself (verified). Leave unticked to save as a draft.');
    v.addEventListener('change', () => { d.verified = v.checked; });
  }

  element('bench-annotate-validate').addEventListener('click', () => {
    try {
      parseSample(toSample(draft));
      annotateStatus.textContent = 'Valid.' + (draft.verified ? '' : ' It will be saved as a draft until you tick “verified”.');
    } catch (error) {
      annotateStatus.textContent = 'Not valid: ' + (error instanceof Error ? error.message : 'unknown problem');
    }
  });
  element('bench-annotate-save').addEventListener('click', () => {
    let sample: BenchmarkSample;
    try {
      sample = parseSample(toSample(draft));
    } catch (error) {
      annotateStatus.textContent = 'Not saved: ' + (error instanceof Error ? error.message : 'invalid annotation') + (error instanceof DatasetError ? '' : '');
      return;
    }
    const existing = loadAnnotations();
    if (existing.some(s => s.id === sample.id) && !confirm('An annotation with ID “' + sample.id + '” already exists. Replace it?')) {
      annotateStatus.textContent = 'Not saved; the existing annotation is unchanged. Change the sample ID to keep both.';
      return;
    }
    try {
      localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify([...existing.filter(s => s.id !== sample.id), sample]));
      annotateStatus.textContent = 'Saved “' + sample.id + '” as ' + sample.annotationStatus + '. ' + (existing.length + (existing.some(s => s.id === sample.id) ? 0 : 1)) + ' annotation(s) in this browser.';
    } catch {
      annotateStatus.textContent = 'Browser storage refused the annotation; export it instead.';
    }
  });
  element('bench-annotate-export').addEventListener('click', () => {
    const samples = loadAnnotations();
    if (!samples.length) {
      annotateStatus.textContent = 'There are no saved annotations to export.';
      return;
    }
    const exported: BenchmarkDataset = { kind: DATASET_KIND, schemaVersion: DATASET_SCHEMA_VERSION, name: 'My annotations', datasetVersion: 'local-' + new Date().toISOString().slice(0, 10), samples, sequences: [] };
    const text = serializeDataset(parseDataset(serializeDataset(exported)));
    download(text, 'benchmark-dataset.json', 'application/json');
    annotateStatus.textContent = 'Exported ' + samples.length + ' annotation(s). Put the image files next to the JSON; images are not included.';
  });
  element('bench-annotate-new').addEventListener('click', () => {
    draft = { id: '', source: 'digital_screenshot', seats: [blankSeat(), blankSeat()], board: [], pot: '', street: '', dealer: null, hero: null, sb: '', bb: '', tags: new Set(), notes: '', verified: false };
    annotationImage = null;
    element<HTMLImageElement>('bench-annotate-preview').hidden = true;
    annotateStatus.textContent = '';
    renderAnnotation();
  });

  showDataset();
  renderRuns();
  renderAnnotation();
  return {
    leave() {
      controller?.abort();
    },
  };
}
