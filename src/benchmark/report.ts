// Benchmark runs and reports: aggregate metrics (always with numerators and
// denominators), difficulty and confidence breakdowns, latency and usage,
// comparison between runs, and JSON and CSV export. Pure.
import type { TrackingResult } from './tracking.js';
import {
  METRICS_VERSION, RUN_KIND, RUN_SCHEMA_VERSION,
  type BenchmarkDataset, type CardOutcome, type CardOutcomeKind, type CardTag, type DifficultyTag, type NumericSummary, type Ratio, type SampleResult, type SampleSource,
} from './types.js';

/** Categories with fewer evaluated samples than this are reported but not ranked or compared. */
export const SMALL_SAMPLE = 5;

export const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, value: denominator > 0 ? numerator / denominator : null });
const sumRatios = (list: readonly { correct: number; total: number }[]) => ratio(list.reduce((s, x) => s + x.correct, 0), list.reduce((s, x) => s + x.total, 0));

export interface CardSummary {
  readonly counts: Readonly<Record<CardOutcomeKind, number>>;
  /** Over positions where the truth has a readable card. */
  readonly exact: Ratio;
  readonly rank: Ratio;
  readonly suit: Ratio;
  readonly missing: Ratio;
  /** Values given where the truth has no card, a card back, or an unreadable card, over all values given. */
  readonly falsePositive: Ratio;
  /** Unreadable cards correctly left unknown. */
  readonly unknownHandled: Ratio;
  /** Card backs left without a value. */
  readonly hiddenHandled: Ratio;
}

export interface TableSummary {
  readonly playerCount: Ratio;
  readonly seatAssignment: Ratio;
  readonly missingPlayers: Ratio;
  readonly extraPlayers: number;
  readonly dealer: Ratio;
  readonly hero: Ratio;
  readonly street: Ratio;
  readonly folded: Ratio;
  readonly invalidState: Ratio;
}

export interface Summary {
  readonly samples: { readonly total: number; readonly evaluated: number; readonly failed: number; readonly cancelled: number; readonly timedOut: number };
  readonly cards: CardSummary;
  readonly community: CardSummary;
  readonly player: CardSummary;
  readonly bySource: Readonly<Partial<Record<SampleSource, { readonly samples: number; readonly cards: CardSummary; readonly table: TableSummary }>>>;
  readonly table: TableSummary;
  readonly pot: NumericSummary;
  readonly stacks: NumericSummary;
  readonly bets: NumericSummary;
  readonly physical: {
    readonly samples: number;
    readonly localizationSupported: number;
    readonly localizationUnsupported: number;
    readonly recall: Ratio;
    readonly precision: Ratio;
    readonly meanIoU: number | null;
    readonly grouping: Ratio;
    readonly byCardTag: readonly { readonly tag: CardTag; readonly exact: Ratio }[];
  };
  readonly confidence: {
    /** Recognizers here give labels, not numbers, so numeric calibration (reliability curves, ECE) is unavailable. */
    readonly numeric: 'unavailable';
    readonly categories: readonly { readonly label: string; readonly exact: Ratio }[];
    readonly highConfidenceError: Ratio;
    readonly lowConfidenceCorrect: Ratio;
  };
  readonly difficulty: readonly { readonly tag: DifficultyTag; readonly samples: number; readonly exact: Ratio; readonly invalidState: Ratio; readonly smallSample: boolean }[];
  readonly latency: { readonly count: number; readonly meanMs: number; readonly medianMs: number; readonly p95Ms: number; readonly maxMs: number } | null;
  readonly errorsByCategory: Readonly<Record<string, number>>;
  readonly ambiguousFields: number;
  readonly tracking: {
    readonly sequences: number;
    readonly scored: number;
    readonly identity: Ratio;
    readonly revealRecall: Ratio;
    readonly revealFalsePositives: number;
    readonly streets: Ratio;
    readonly falseOrderFlags: number;
    readonly falseContradictions: number;
    readonly justifiedContradictions: number;
    readonly missedContradictions: number;
    readonly unresolvedRecall: Ratio;
    readonly unresolvedPrecision: Ratio;
    readonly checkpoints: Ratio;
  };
}

const KINDS: readonly CardOutcomeKind[] = ['exact', 'rank_only', 'suit_only', 'wrong', 'missing', 'extra', 'correct_hidden', 'hidden_missed', 'correct_unknown', 'invented'];

export function cardSummary(outcomes: readonly CardOutcome[]): CardSummary {
  const counts = Object.fromEntries(KINDS.map(k => [k, 0])) as Record<CardOutcomeKind, number>;
  for (const o of outcomes) counts[o.outcome]++;
  const known = counts.exact + counts.rank_only + counts.suit_only + counts.wrong + counts.missing;
  const valued = counts.exact + counts.rank_only + counts.suit_only + counts.wrong + counts.extra + counts.invented;
  const backs = outcomes.filter(o => o.truth === 'face_down');
  return {
    counts,
    exact: ratio(counts.exact, known),
    rank: ratio(counts.exact + counts.rank_only, known),
    suit: ratio(counts.exact + counts.suit_only, known),
    missing: ratio(counts.missing, known),
    falsePositive: ratio(counts.extra + counts.invented, valued),
    unknownHandled: ratio(counts.correct_unknown, counts.correct_unknown + counts.invented),
    hiddenHandled: ratio(backs.filter(o => o.outcome === 'correct_hidden').length, backs.length),
  };
}

export function numericSummary(pairs: readonly { truth: number | null; predicted: number | null }[]): NumericSummary {
  const compared = pairs.filter(p => p.truth !== null && p.predicted !== null);
  const known = pairs.filter(p => p.truth !== null);
  return {
    compared: compared.length,
    exact: ratio(compared.filter(p => p.truth === p.predicted).length, compared.length),
    meanAbsoluteError: compared.length ? compared.reduce((s, p) => s + Math.abs(p.truth! - p.predicted!), 0) / compared.length : null,
    missing: ratio(known.filter(p => p.predicted === null).length, known.length),
    invented: pairs.filter(p => p.truth === null && p.predicted !== null).length,
    correctlyUnknown: pairs.filter(p => p.truth === null && p.predicted === null).length,
  };
}

function tableSummary(results: readonly SampleResult[]): TableSummary {
  const t = results.flatMap(r => (r.table ? [{ r, t: r.table }] : []));
  const role = (key: 'dealer' | 'hero') => ratio(t.filter(x => x.t[key] === 'correct').length, t.filter(x => x.t[key] !== 'n/a').length);
  return {
    playerCount: ratio(t.filter(x => x.t.playerCount.truth === x.t.playerCount.predicted).length, t.length),
    seatAssignment: sumRatios(t.map(x => x.t.seatsInPlace)),
    missingPlayers: ratio(t.reduce((s, x) => s + x.t.missingPlayers, 0), t.reduce((s, x) => s + x.t.playerCount.truth, 0)),
    extraPlayers: t.reduce((s, x) => s + x.t.extraPlayers, 0),
    dealer: role('dealer'),
    hero: role('hero'),
    street: ratio(t.filter(x => x.t.street === 'correct').length, t.filter(x => x.t.street !== 'n/a').length),
    folded: sumRatios(t.map(x => x.t.folded)),
    invalidState: ratio(t.filter(x => x.r.invalidState).length, t.length),
  };
}

function percentile(sorted: readonly number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function summarize(results: readonly SampleResult[], tracking: readonly TrackingResult[] = []): Summary {
  const evaluated = results.filter(r => r.status === 'evaluated');
  const allCards = evaluated.flatMap(r => r.cards);
  const bySource: Partial<Record<SampleSource, { samples: number; cards: CardSummary; table: TableSummary }>> = {};
  for (const source of ['digital_screenshot', 'physical_photo'] as const) {
    const rs = evaluated.filter(r => r.sourceType === source);
    if (rs.length) bySource[source] = { samples: rs.length, cards: cardSummary(rs.flatMap(r => r.cards)), table: tableSummary(rs) };
  }
  const numbers = evaluated.flatMap(r => r.table?.numbers ?? []);
  const physicalResults = evaluated.filter(r => r.physical);
  const supported = physicalResults.filter(r => r.physical!.localization !== 'unsupported');
  const loc = supported.map(r => r.physical!.localization as Exclude<NonNullable<SampleResult['physical']>['localization'], 'unsupported'>);
  const matchedTotal = loc.reduce((s, l) => s + l.matched, 0);
  const iouWeighted = loc.reduce((s, l) => s + (l.meanIoU ?? 0) * l.matched, 0);
  const tagged = (tag: CardTag) => cardSummary(allCards.filter(c => c.tags.includes(tag))).exact;

  // Confidence: by the reader's label, over predicted values at positions with a readable true card.
  const valued = allCards.filter(c => c.predicted !== 'hidden' && c.predicted !== 'unknown' && c.predicted !== 'none' && /^[2-9TJQKA][cdhs]$/.test(c.truth));
  const byLabel = (label: string) => valued.filter(c => (c.confidence ?? 'unrated') === label);
  const categories = ['high', 'medium', 'low', 'unrated'].map(label => ({ label, exact: ratio(byLabel(label).filter(c => c.outcome === 'exact').length, byLabel(label).length) }));
  const high = byLabel('high');
  const low = byLabel('low');

  const tags = [...new Set(results.flatMap(r => r.tags))].sort();
  const difficulty = tags.map(tag => {
    const rs = evaluated.filter(r => r.tags.includes(tag));
    return {
      tag, samples: rs.length,
      exact: cardSummary(rs.flatMap(r => r.cards)).exact,
      invalidState: ratio(rs.filter(r => r.invalidState).length, rs.length),
      smallSample: rs.length < SMALL_SAMPLE,
    };
  });

  const latencies = results.flatMap(r => (r.latencyMs === null ? [] : [r.latencyMs])).sort((a, b) => a - b);
  const errorsByCategory: Record<string, number> = {};
  for (const r of results) for (const e of r.errors) errorsByCategory[e.category] = (errorsByCategory[e.category] ?? 0) + 1;

  const scored = tracking.filter(t => !t.skipped);
  const tr = (f: (t: TrackingResult) => number) => scored.reduce((s, t) => s + f(t), 0);
  return {
    samples: {
      total: results.length, evaluated: evaluated.length,
      failed: results.filter(r => r.status === 'failed').length, cancelled: results.filter(r => r.status === 'cancelled').length,
      timedOut: results.filter(r => r.timedOut).length,
    },
    cards: cardSummary(allCards),
    community: cardSummary(allCards.filter(c => c.area === 'community')),
    player: cardSummary(allCards.filter(c => c.area === 'player')),
    bySource,
    table: tableSummary(evaluated),
    pot: numericSummary(numbers.filter(n => n.field === 'pot')),
    stacks: numericSummary(numbers.filter(n => n.field.endsWith('.stack'))),
    bets: numericSummary(numbers.filter(n => n.field.endsWith('.bet'))),
    physical: {
      samples: physicalResults.length,
      localizationSupported: supported.length,
      localizationUnsupported: physicalResults.length - supported.length,
      recall: ratio(matchedTotal, loc.reduce((s, l) => s + l.truthBoxes, 0)),
      precision: ratio(matchedTotal, loc.reduce((s, l) => s + l.predictedBoxes, 0)),
      meanIoU: matchedTotal ? iouWeighted / matchedTotal : null,
      grouping: sumRatios(supported.map(r => r.physical!.grouping)),
      byCardTag: (['rotated', 'occluded', 'blurred'] as const).map(tag => ({ tag, exact: tagged(tag) })),
    },
    confidence: {
      numeric: 'unavailable',
      categories,
      highConfidenceError: ratio(high.filter(c => c.outcome !== 'exact').length, high.length),
      lowConfidenceCorrect: ratio(low.filter(c => c.outcome === 'exact').length, low.length),
    },
    difficulty,
    latency: latencies.length ? {
      count: latencies.length,
      meanMs: latencies.reduce((s, v) => s + v, 0) / latencies.length,
      medianMs: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: latencies[latencies.length - 1],
    } : null,
    errorsByCategory,
    ambiguousFields: evaluated.reduce((s, r) => s + r.ambiguousFields, 0),
    tracking: {
      sequences: tracking.length, scored: scored.length,
      identity: ratio(tr(t => t.identity.consistent), tr(t => t.identity.total)),
      revealRecall: ratio(tr(t => t.reveals.detected), tr(t => t.reveals.truth)),
      revealFalsePositives: tr(t => t.reveals.falsePositives),
      streets: ratio(tr(t => t.streets.correct), tr(t => t.streets.total)),
      falseOrderFlags: tr(t => t.falseOrderFlags),
      falseContradictions: tr(t => t.contradictions.false),
      justifiedContradictions: tr(t => t.contradictions.justified),
      missedContradictions: tr(t => t.contradictions.missed),
      unresolvedRecall: ratio(tr(t => t.unresolved.truePositive), tr(t => t.unresolved.truePositive + t.unresolved.falseNegative)),
      unresolvedPrecision: ratio(tr(t => t.unresolved.truePositive), tr(t => t.unresolved.truePositive + t.unresolved.falsePositive)),
      checkpoints: ratio(tr(t => t.checkpoints.consistent), tr(t => t.checkpoints.total)),
    },
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunConfig {
  readonly limit: number | null;
  readonly concurrency: number;
  readonly sources: readonly SampleSource[];
  readonly keepRaw: boolean;
}

export interface BenchmarkRun {
  readonly kind: typeof RUN_KIND;
  readonly schemaVersion: typeof RUN_SCHEMA_VERSION;
  readonly metricsVersion: typeof METRICS_VERSION;
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: 'complete' | 'cancelled';
  /** Git commit of the code that ran, when known. */
  readonly commit: string | null;
  readonly dataset: { readonly name: string; readonly version: string; readonly samples: number };
  readonly provider: { readonly id: string; readonly kind: 'mock' | 'real'; readonly modelIds: readonly string[] };
  readonly config: RunConfig;
  readonly usage: {
    readonly requests: number;
    readonly successes: number;
    readonly failures: number;
    readonly timeouts: number;
    readonly retries: number;
    /** Token or cost figures are not returned to the app, so they are not reported. */
    readonly cost: 'unavailable';
  };
  readonly results: readonly SampleResult[];
  readonly tracking: readonly TrackingResult[];
  readonly summary: Summary;
  readonly warnings: readonly string[];
}

export interface MetricChange {
  readonly key: string;
  readonly label: string;
  readonly before: number | null;
  readonly after: number | null;
  readonly higherIsBetter: boolean;
  readonly change: 'improved' | 'regressed' | 'unchanged' | 'n/a';
}

/** The metrics compared between runs, with which direction is better. */
export function headlineMetrics(s: Summary): { key: string; label: string; value: number | null; higherIsBetter: boolean }[] {
  const r = (key: string, label: string, x: Ratio, higherIsBetter = true) => ({ key, label, value: x.value, higherIsBetter });
  return [
    r('cards.exact', 'Exact card', s.cards.exact), r('cards.rank', 'Rank', s.cards.rank), r('cards.suit', 'Suit', s.cards.suit),
    r('community.exact', 'Community cards exact', s.community.exact), r('player.exact', 'Player cards exact', s.player.exact),
    r('cards.missing', 'Missing cards', s.cards.missing, false), r('cards.falsePositive', 'False-positive cards', s.cards.falsePositive, false),
    r('cards.unknownHandled', 'Unreadable cards left unknown', s.cards.unknownHandled),
    r('table.seatAssignment', 'Seat assignment', s.table.seatAssignment), r('table.dealer', 'Dealer position', s.table.dealer),
    r('table.street', 'Street', s.table.street), r('table.invalidState', 'Invalid states', s.table.invalidState, false),
    r('pot.exact', 'Pot exact', s.pot.exact), { key: 'pot.mae', label: 'Pot mean absolute error', value: s.pot.meanAbsoluteError, higherIsBetter: false },
    r('stacks.exact', 'Stack exact', s.stacks.exact), { key: 'stacks.mae', label: 'Stack mean absolute error', value: s.stacks.meanAbsoluteError, higherIsBetter: false },
    r('stacks.missing', 'Stacks missing', s.stacks.missing, false),
    r('physical.recall', 'Detection recall', s.physical.recall), r('physical.precision', 'Detection precision', s.physical.precision),
    r('physical.grouping', 'Card grouping', s.physical.grouping),
    r('tracking.identity', 'Identity consistency', s.tracking.identity), r('tracking.checkpoints', 'Checkpoint consistency', s.tracking.checkpoints),
    { key: 'latency.mean', label: 'Mean latency (ms)', value: s.latency?.meanMs ?? null, higherIsBetter: false },
  ];
}

/**
 * Compare a baseline run with a newer one. Results are directly comparable
 * only on the same dataset version with the same metric definitions and
 * sample selection; anything else is reported as non-equivalent.
 */
export function compareRuns(before: BenchmarkRun, after: BenchmarkRun): { equivalent: boolean; reasons: string[]; notes: string[]; metrics: MetricChange[] } {
  const reasons: string[] = [];
  if (before.dataset.name !== after.dataset.name || before.dataset.version !== after.dataset.version) reasons.push('Different datasets (' + before.dataset.version + ' vs ' + after.dataset.version + ').');
  if (before.metricsVersion !== after.metricsVersion) reasons.push('Different metric definitions (version ' + before.metricsVersion + ' vs ' + after.metricsVersion + ').');
  if (before.config.limit !== after.config.limit || before.config.sources.join() !== after.config.sources.join()) reasons.push('Different sample selection (limit or sources).');
  if (before.summary.samples.evaluated !== after.summary.samples.evaluated) reasons.push('Different numbers of evaluated samples (' + before.summary.samples.evaluated + ' vs ' + after.summary.samples.evaluated + ').');
  if (before.status !== 'complete' || after.status !== 'complete') reasons.push('A run was cancelled before finishing.');
  const notes: string[] = [];
  if (before.provider.id !== after.provider.id) notes.push('Providers differ: ' + before.provider.id + ' → ' + after.provider.id + '.');
  if (before.provider.modelIds.join() !== after.provider.modelIds.join()) notes.push('Models differ: ' + (before.provider.modelIds.join(', ') || 'none') + ' → ' + (after.provider.modelIds.join(', ') || 'none') + '.');
  const a = headlineMetrics(before.summary);
  const b = headlineMetrics(after.summary);
  const metrics = a.map((m, i) => {
    const x = m.value;
    const y = b[i].value;
    const change: MetricChange['change'] = x === null || y === null ? 'n/a'
      : Math.abs(x - y) < 1e-9 ? 'unchanged' : (y > x) === m.higherIsBetter ? 'improved' : 'regressed';
    return { key: m.key, label: m.label, before: x, after: y, higherIsBetter: m.higherIsBetter, change };
  });
  return { equivalent: reasons.length === 0, reasons, notes, metrics };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The run as JSON. Raw provider output is included only if the run kept it; images are never included. */
export const runToJson = (run: BenchmarkRun) => JSON.stringify(run, null, 2);

/** Quote a CSV cell; neutralise leading formula characters so spreadsheets do not execute them. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** One CSV table with a `section` column: run metadata, metrics, per-sample results, and errors. */
export function runToCsv(run: BenchmarkRun): string {
  const rows: unknown[][] = [['section', 'key', 'value', 'numerator', 'denominator', 'detail']];
  const meta: [string, unknown][] = [
    ['run_id', run.id], ['started_at', run.startedAt], ['finished_at', run.finishedAt], ['status', run.status], ['commit', run.commit],
    ['dataset', run.dataset.name], ['dataset_version', run.dataset.version], ['metrics_version', run.metricsVersion],
    ['provider', run.provider.id], ['provider_kind', run.provider.kind], ['models', run.provider.modelIds.join(' ')],
    ['limit', run.config.limit], ['concurrency', run.config.concurrency], ['sources', run.config.sources.join(' ')],
    ['requests', run.usage.requests], ['failures', run.usage.failures], ['timeouts', run.usage.timeouts], ['retries', run.usage.retries], ['cost', run.usage.cost],
  ];
  for (const [k, v] of meta) rows.push(['run', k, v, '', '', '']);
  for (const m of headlineMetrics(run.summary)) {
    const r = findRatio(run.summary, m.key);
    rows.push(['metric', m.key, m.value, r?.numerator ?? '', r?.denominator ?? '', m.label]);
  }
  if (run.summary.latency) for (const [k, v] of Object.entries(run.summary.latency)) rows.push(['latency', k, v, '', '', '']);
  for (const r of run.results) {
    const known = r.cards.filter(c => /^[2-9TJQKA][cdhs]$/.test(c.truth)).length;
    rows.push(['sample', r.sampleId, r.status, r.cards.filter(c => c.outcome === 'exact').length, known,
      [r.sourceType, r.tags.join(' '), r.latencyMs === null ? '' : Math.round(r.latencyMs) + ' ms', r.failure ?? '', r.warnings.join(' | ')].join('; ')]);
    for (const e of r.errors) rows.push(['error', r.sampleId + ':' + e.location, e.category, '', '', 'expected ' + e.expected + ', got ' + e.actual]);
  }
  for (const w of run.warnings) rows.push(['warning', '', w, '', '', '']);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function findRatio(s: Summary, key: string): Ratio | null {
  const [group, field] = key.split('.');
  const value = (s as unknown as Record<string, Record<string, unknown>>)[group]?.[field];
  return value && typeof value === 'object' && 'denominator' in (value as object) ? value as Ratio : null;
}

/** Validate a stored run enough to display and compare it. */
export function parseRun(input: unknown): BenchmarkRun {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object' || raw.kind !== RUN_KIND || raw.schemaVersion !== RUN_SCHEMA_VERSION || !Array.isArray(raw.results) || !raw.summary || !raw.dataset) {
    throw new Error('This is not a Poker Study benchmark run.');
  }
  return raw as BenchmarkRun;
}

export function datasetWarnings(dataset: BenchmarkDataset): string[] {
  const warnings: string[] = [];
  const drafts = dataset.samples.filter(s => s.annotationStatus === 'draft').length;
  if (drafts) warnings.push(drafts + ' sample(s) have draft annotations that no one has verified.');
  if (dataset.samples.every(s => s.image.kind === 'synthetic')) warnings.push('Every sample is a synthetic drawing; scores do not measure accuracy on real images.');
  return warnings;
}
