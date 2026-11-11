// Step 6, recognition benchmarking: dataset validation, per-card and table
// scoring, numeric errors, detection matching, confidence categories,
// tracking metrics, the runner (concurrency, deduplication, cancellation,
// failures), aggregation, run comparison, and JSON/CSV export. Deterministic;
// no API credentials. Expected scores are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinDataset, builtinSvg, physicalTruth, screenshotTruth } from '../dist/benchmark/builtin.js';
import { DatasetError, groundTruthProblems, parseDataset, parseSample, serializeDataset } from '../dist/benchmark/dataset.js';
import { cardOutcome, iou, matchBoxes, matchSeats, scoreSample } from '../dist/benchmark/metrics.js';
import { cardSummary, compareRuns, csvCell, numericSummary, parseRun, ratio, runToCsv, runToJson, summarize } from '../dist/benchmark/report.js';
import { mockPredictor, runBenchmark, selectSamples } from '../dist/benchmark/runner.js';
import { DATASET_KIND } from '../dist/benchmark/types.js';
import { corrected, correctedCard } from '../dist/vision/screenshot.js';
import { SCREENSHOT_FIXTURES } from '../dist/vision/screenshot-fixtures.js';

const field = (value, confidence = 'high') => ({ value, confidence: value === null ? null : confidence, source: 'observed' });
const card = (value, confidence = 'high', hidden = false) => ({ value, confidence: value ? confidence : null, source: 'observed', hidden });
const truthCard = code => ({ card: code === 'back' ? { kind: 'face_down' } : code === '?' ? { kind: 'unreadable' } : { kind: 'card', card: code } });
const player = (name, cards, stack = 100, bet = 0, folded = false) => ({ name, cards: cards.map(truthCard), stack, bet, folded });

function recognition(players, board, extra = {}) {
  return {
    providerId: 'test', modelId: 'm', potIncludesBets: false,
    players: players.map(p => ({
      name: field(p.name), stack: field(p.stack ?? null), bet: field(p.bet ?? null), status: field(p.folded ? 'folded' : 'active'),
      cards: p.cards.map(c => (c === 'back' ? card(null, null, true) : c === '?' ? card(null) : card(c, p.conf ?? 'high'))),
    })),
    communityCards: board.map(c => (c === '?' ? card(null) : card(c))),
    pot: field(extra.pot ?? null), smallBlind: field(null), bigBlind: field(null),
    dealerSeat: field(extra.dealer ?? null), heroSeat: field(extra.hero ?? null), street: field(extra.street ?? null), warnings: extra.warnings ?? [],
  };
}

function sample(groundTruth, extra = {}) {
  return {
    id: extra.id ?? 's1', sourceType: extra.sourceType ?? 'digital_screenshot', image: { kind: 'synthetic', fixture: 'none' },
    groundTruth, tags: extra.tags ?? [], metadata: {}, annotationStatus: 'verified',
  };
}

const recognized = rec => ({ kind: 'recognized', recognition: rec, latencyMs: 10, providerId: 'test', modelId: 'm', attempts: 1 });

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

test('the built-in dataset validates, is deterministic, and matches the committed manifest', () => {
  const ds = builtinDataset();
  assert.equal(ds.kind, DATASET_KIND);
  assert.equal(ds.samples.length, 34);
  assert.equal(ds.sequences.length, 7);
  assert.deepEqual(parseDataset(serializeDataset(ds)), ds);
  assert.equal(serializeDataset(builtinDataset()), serializeDataset(ds), 'building twice gives the same dataset');
  const committed = readFileSync(new URL('../benchmarks/datasets/synthetic-1.json', import.meta.url), 'utf8');
  assert.equal(committed.trim(), serializeDataset(ds), 'run `npm run benchmark -- --write-dataset benchmarks/datasets/synthetic-1.json` after changing fixtures');
  for (const s of ds.samples) assert.ok(s.image.kind !== 'synthetic' || builtinSvg(s.image.fixture), s.id + ' has a drawing');
});

test('ground truth comes from the drawings, not the stored readings', () => {
  const hidden = screenshotTruth(SCREENSHOT_FIXTURES.find(f => f.id === 'partially-hidden').table);
  assert.deepEqual(hidden.board.map(s => s.card.kind === 'card' ? s.card.card : s.card.kind), ['Ac', '6d', 'unreadable', '5c']);
  assert.deepEqual(hidden.players[0].cards.map(s => s.card.kind === 'card' ? s.card.card : s.card.kind), ['8s', 'unreadable']);
  const blurred = screenshotTruth(SCREENSHOT_FIXTURES.find(f => f.id === 'unreadable-text').table);
  assert.ok(blurred.players.every(p => p.name === null && p.stack === null), 'blurred text is not visible truth');
  const ds = builtinDataset();
  const uncertain = ds.samples.find(s => s.id === 'photo-uncertain-card').groundTruth;
  assert.equal(uncertain.board[2].card.card, '9s', 'the truth is the drawn 9♠, not the reader’s 6♠');
  assert.deepEqual(uncertain.board[2].tags, ['blurred']);
  assert.ok(uncertain.board.every(s => s.box), 'photo truth has measured boxes');
});

test('annotations are validated: impossible cards, boards, streets, seats, and paths are rejected', () => {
  const good = { players: [player('A', ['As', 'Kd']), player('B', ['back', 'back'])], board: [], pot: 0, dealerSeat: 0, heroSeat: 0, street: 'preflop', smallBlind: 5, bigBlind: 10 };
  assert.deepEqual(groundTruthProblems(good), []);
  const problem = change => groundTruthProblems({ ...structuredClone(good), ...change })[0] ?? '';
  assert.match(problem({ players: [player('A', ['As', 'As']), player('B', [])] }), /As appears twice/);
  assert.deepEqual(groundTruthProblems({ ...good, players: [player('A', ['As', 'As']), player('B', [])] }, true), [], 'allowed only for malformed-input tests');
  assert.match(problem({ board: [truthCard('2c'), truthCard('3c')] }), /0, 3, 4, or 5 cards/);
  assert.match(problem({ street: 'flop' }), /street is flop but the board has 0/);
  assert.match(problem({ dealerSeat: 5 }), /dealer/);
  assert.match(problem({ players: [player('A', ['As'])] , }), /2 to 10 seats|zero or two/);
  assert.match(problem({ players: [player('A', ['Zz', 'Kd']), player('B', [])] }), /invalid card code/);
  assert.match(problem({ pot: -1 }), /Pot/);
  assert.match(problem({ smallBlind: 20 }), /small blind is larger/);
  const s = sample(good);
  assert.throws(() => parseSample({ ...s, image: { kind: 'file', path: '../secret.png' } }), /relative/);
  assert.throws(() => parseSample({ ...s, image: { kind: 'file', path: 'a.gif' } }), /PNG, JPEG, or WebP/);
  assert.throws(() => parseSample({ ...s, tags: ['spooky'] }), /difficulty tags/);
  assert.throws(() => parseSample({ ...s, annotationStatus: 'ai' }), /draft or verified/);
  const ds = { kind: DATASET_KIND, schemaVersion: 1, name: 'x', datasetVersion: '1', samples: [s, s], sequences: [] };
  assert.throws(() => parseDataset(ds), /used twice/);
  assert.throws(() => parseDataset({ ...ds, samples: [s], sequences: [{ id: 'q', sampleIds: ['s1', 'nope'] }] }), /missing sample/);
  assert.throws(() => parseDataset('{'), DatasetError);
});

// ---------------------------------------------------------------------------
// Card scoring
// ---------------------------------------------------------------------------

test('each card position is classified against the truth at that position', () => {
  const t = code => truthCard(code);
  assert.equal(cardOutcome(t('As'), card('As')), 'exact');
  assert.equal(cardOutcome(t('As'), card('Ad')), 'rank_only');
  assert.equal(cardOutcome(t('As'), card('Ks')), 'suit_only');
  assert.equal(cardOutcome(t('As'), card('Kd')), 'wrong');
  assert.equal(cardOutcome(t('As'), card(null)), 'missing');
  assert.equal(cardOutcome(t('As'), undefined), 'missing');
  assert.equal(cardOutcome(undefined, card('As')), 'extra');
  assert.equal(cardOutcome(undefined, card(null)), null);
  assert.equal(cardOutcome(t('back'), card(null, null, true)), 'correct_hidden');
  assert.equal(cardOutcome(t('back'), card('As')), 'extra');
  assert.equal(cardOutcome(t('back'), undefined), 'hidden_missed');
  assert.equal(cardOutcome(t('?'), card(null)), 'correct_unknown');
  assert.equal(cardOutcome(t('?'), card('As')), 'invented');
});

test('a card found in the wrong place is not counted as correct', () => {
  const truth = { players: [player('You', ['As', 'Kd']), player('Bo', ['back', 'back'])], board: [truthCard('2c'), truthCard('7h'), truthCard('9d')], pot: 30, dealerSeat: 1, heroSeat: 0, street: 'flop', smallBlind: null, bigBlind: null };
  // The reader put the A♠ on the board and missed it in your hand.
  const rec = recognition([{ name: 'You', cards: ['?', 'Kd'], stack: 100, bet: 0 }, { name: 'Bo', cards: ['back', 'back'], stack: 100, bet: 0 }], ['As', '7h', '9d'], { pot: 30, dealer: 1, hero: 0, street: 'flop' });
  const r = scoreSample(sample(truth), recognized(rec));
  const by = loc => r.cards.find(c => c.location === loc).outcome;
  assert.equal(by('board.0'), 'wrong');
  assert.equal(by('seat.0.card.0'), 'missing');
  const s = cardSummary(r.cards);
  assert.deepEqual([s.exact.numerator, s.exact.denominator], [3, 5]);
  assert.deepEqual([s.rank.numerator, s.suit.numerator], [3, 3]);
  assert.deepEqual([s.missing.numerator, s.falsePositive.numerator, s.falsePositive.denominator], [1, 0, 4]);
  assert.deepEqual([s.hiddenHandled.numerator, s.hiddenHandled.denominator], [2, 2]);
});

test('seats are matched by name; a wrong order lowers seat-assignment accuracy but not card accuracy', () => {
  const truth = { players: [player('A', ['As', 'Kd']), player('B', ['Qh', 'Jh']), player('C', [])], board: [], pot: 0, dealerSeat: 2, heroSeat: 0, street: 'preflop', smallBlind: null, bigBlind: null };
  const rec = recognition([{ name: 'A', cards: ['As', 'Kd'] }, { name: 'C', cards: [] }, { name: 'B', cards: ['Qh', 'Jh'] }], [], { dealer: 1, hero: 0, street: 'preflop', pot: 0 });
  assert.deepEqual(matchSeats(truth, rec), [0, 2, 1]);
  const r = scoreSample(sample(truth), recognized(rec));
  assert.deepEqual(r.table.seatsInPlace, { correct: 1, total: 3 });
  assert.equal(cardSummary(r.cards).exact.value, 1);
  assert.equal(r.table.dealer, 'correct', 'the dealer is the same player even though the seat index differs');
  const wrongDealer = scoreSample(sample(truth), recognized({ ...rec, dealerSeat: field(0) }));
  assert.equal(wrongDealer.table.dealer, 'wrong');
  const missingPlayer = scoreSample(sample(truth), recognized(recognition([{ name: 'A', cards: ['As', 'Kd'] }, { name: 'B', cards: ['Qh', 'Jh'] }], [])));
  assert.deepEqual([missingPlayer.table.missingPlayers, missingPlayer.table.playerCount], [1, { truth: 3, predicted: 2 }]);
});

test('pot and chip errors: exact, mean absolute error, missing, invented, and unknown kept apart from zero', () => {
  const summary = numericSummary([
    { truth: 100, predicted: 100 }, { truth: 0, predicted: 5 }, { truth: 50, predicted: null }, { truth: null, predicted: 20 }, { truth: null, predicted: null },
  ]);
  assert.deepEqual(summary.exact, ratio(1, 2));
  assert.equal(summary.meanAbsoluteError, 2.5, 'a true 0 is scored by absolute error, never as a percentage');
  assert.deepEqual(summary.missing, ratio(1, 3));
  assert.equal(summary.invented, 1);
  assert.equal(summary.correctlyUnknown, 1);
  assert.equal(numericSummary([]).meanAbsoluteError, null);
});

test('failed and cancelled recognitions are recorded but not scored', () => {
  const truth = builtinDataset().samples[0].groundTruth;
  const failed = scoreSample(sample(truth), { kind: 'failed', reason: 'Recognition took too long.', latencyMs: 90000, attempts: 1, timedOut: true });
  assert.deepEqual([failed.status, failed.cards.length, failed.timedOut, failed.errors[0].category], ['failed', 0, true, 'recognition_failed']);
  const s = summarize([failed, scoreSample(sample(truth, { id: 's2' }), { kind: 'cancelled' })]);
  assert.deepEqual(s.samples, { total: 2, evaluated: 0, failed: 1, cancelled: 1, timedOut: 1 });
  assert.equal(s.cards.exact.value, null, 'no accuracy without eligible samples');
  assert.equal(s.latency.maxMs, 90000);
});

test('an empty dataset produces no fake percentages', () => {
  const s = summarize([]);
  for (const r of [s.cards.exact, s.cards.rank, s.table.seatAssignment, s.physical.recall, s.tracking.identity, s.pot.exact]) assert.equal(r.value, null);
  assert.equal(s.latency, null);
  assert.equal(JSON.stringify(s).includes('NaN'), false);
});

// ---------------------------------------------------------------------------
// Physical detection
// ---------------------------------------------------------------------------

test('boxes are matched one-to-one by intersection over union', () => {
  assert.equal(iou({ x: 0, y: 0, width: 0.2, height: 0.2 }, { x: 0.1, y: 0, width: 0.2, height: 0.2 }), 1 / 3);
  const truth = [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }];
  const predicted = [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, { x: 0.11, y: 0.1, width: 0.1, height: 0.1 }, { x: 0.8, y: 0.8, width: 0.1, height: 0.1 }];
  const pairs = matchBoxes(truth, predicted);
  assert.deepEqual(pairs.map(([t, p]) => [t, p]), [[0, 1], [1, 0]]);
  assert.equal(matchBoxes(truth, [{ x: 0.3, y: 0.3, width: 0.05, height: 0.05 }]).length, 0);
});

test('photo detection metrics, and localization is unsupported when positions are missing', async () => {
  const ds = builtinDataset();
  const photo = ds.samples.find(s => s.id === 'photo-angled-photo');
  const p = await mockPredictor().predict(photo, new AbortController().signal);
  const r = scoreSample(photo, p);
  assert.deepEqual(r.physical.localization.truthBoxes, 9);
  assert.equal(r.physical.localization.matched, 9);
  assert.deepEqual(r.physical.grouping, { correct: 9, total: 9 });
  // A reading without boxes cannot be scored for localization.
  const noBoxes = { ...p, physical: { ...p.physical, cards: p.physical.cards.map(c => ({ ...c, box: null })) } };
  assert.equal(scoreSample(photo, noBoxes).physical.localization, 'unsupported');
  // Moving one card's box off target lowers recall and precision.
  const moved = { ...p, physical: { ...p.physical, cards: p.physical.cards.map((c, i) => (i === 0 ? { ...c, box: { x: 0, y: 0, width: 0.05, height: 0.05 } } : c)) } };
  const m = scoreSample(photo, moved).physical.localization;
  assert.deepEqual([m.matched, m.truthBoxes, m.predictedBoxes], [8, 9, 9]);
});

// ---------------------------------------------------------------------------
// The built-in mock run: known expected scores
// ---------------------------------------------------------------------------

const fixedClock = () => new Date('2026-11-11T12:00:00.000Z');
const mockRun = () => runBenchmark(builtinDataset(), mockPredictor(), { clock: fixedClock, now: () => 0, commit: 'abc1234' });

test('the mock run reproduces the deliberate mistakes in the stored readings', async () => {
  const run = await mockRun();
  const s = run.summary;
  assert.deepEqual(s.samples, { total: 34, evaluated: 34, failed: 0, cancelled: 0, timedOut: 0 });
  assert.deepEqual([s.cards.exact.numerator, s.cards.exact.denominator], [175, 180]);
  assert.deepEqual([s.cards.counts.rank_only, s.cards.counts.suit_only, s.cards.counts.missing, s.cards.counts.correct_unknown], [2, 1, 2, 2]);
  assert.deepEqual(s.errorsByCategory, { bet: 1, missing_card: 2, stack: 1, card: 3 });
  const wrong = run.results.flatMap(r => r.cards.filter(c => c.outcome === 'rank_only' || c.outcome === 'suit_only').map(c => r.sampleId + ' ' + c.truth + '→' + c.predicted));
  assert.deepEqual(wrong.sort(), ['photo-uncertain-card 9s→6s', 'seq-demo-track-4 Kh→Kd', 'seq-recognition-error-2 7c→7s']);
  assert.deepEqual([s.confidence.categories.find(c => c.label === 'low').exact.numerator, s.confidence.categories.find(c => c.label === 'low').exact.denominator], [0, 2]);
  assert.equal(s.confidence.numeric, 'unavailable');
  assert.deepEqual(s.physical.byCardTag.find(t => t.tag === 'occluded').exact, ratio(0, 2));
  assert.ok(s.difficulty.every(d => d.smallSample === d.samples < 5));
  assert.equal(run.usage.cost, 'unavailable');
  assert.ok(run.warnings.some(w => /Mock run/.test(w)));
});

test('tracking metrics on the built-in sequences', async () => {
  const run = await mockRun();
  const t = run.summary.tracking;
  assert.deepEqual([t.sequences, t.scored], [7, 7]);
  assert.deepEqual(t.identity, ratio(19, 19));
  assert.deepEqual(t.streets, ratio(15, 15));
  assert.equal(t.falseContradictions, 0, 'contradictions only appear where a reading was wrong');
  assert.equal(t.justifiedContradictions, 3);
  assert.deepEqual(t.revealRecall, ratio(4, 4));
  const complete = run.tracking.find(x => x.sequenceId === 'complete-hand');
  assert.deepEqual(complete.unresolved, { truePositive: 3, falsePositive: 0, falseNegative: 0, undetermined: 0 }, 'chip movement stays an open gap, never invented actions');
  // Marking frames as different hands that the engine does not flag counts as missed.
  const ds = builtinDataset();
  const split = { ...ds, sequences: ds.sequences.map(q => (q.id === 'complete-hand' ? { ...q, sameHand: [true, false, true, true] } : q)) };
  const splitRun = await runBenchmark(split, mockPredictor(), { clock: fixedClock, now: () => 0 });
  assert.equal(splitRun.tracking.find(x => x.sequenceId === 'complete-hand').contradictions.missed, 1);
});

test('runs are deterministic for fixed predictions and clock', async () => {
  const a = runToJson(await mockRun());
  const b = runToJson(await mockRun());
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

test('the runner bounds concurrency, recognizes each image once, honours limits, and reports progress', async () => {
  const ds = builtinDataset();
  const doubled = { ...ds, samples: [...ds.samples.slice(0, 4), { ...ds.samples[0], id: 'copy-of-first' }], sequences: [] };
  let active = 0;
  let peak = 0;
  const calls = [];
  const progress = [];
  const predictor = {
    id: 'slow', kind: 'mock',
    async predict(s, signal) {
      calls.push(s.id);
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return mockPredictor().predict(s, signal);
    },
  };
  const run = await runBenchmark(doubled, predictor, { concurrency: 2, onProgress: p => progress.push(p.done) });
  assert.equal(peak, 2);
  assert.equal(calls.length, 4, 'the copy reuses the first image’s reading');
  assert.equal(run.usage.requests, 4);
  assert.equal(run.results.length, 5);
  assert.equal(progress.at(-1), 5);
  assert.equal(selectSamples(ds, { limit: 3 }).length, 3);
  assert.ok(selectSamples(ds, { sources: ['physical_photo'] }).every(s => s.sourceType === 'physical_photo'));
  const limited = await runBenchmark(ds, mockPredictor(), { limit: 3, clock: fixedClock });
  assert.equal(limited.results.length, 3);
  assert.equal(limited.tracking.length, 0, 'sequences are scored only when all their frames ran');
});

test('a benchmark can be cancelled; finished samples are kept and the rest marked cancelled', async () => {
  const controller = new AbortController();
  let n = 0;
  const predictor = {
    id: 'cancel', kind: 'real',
    async predict(s, signal) {
      if (++n === 3) controller.abort();
      await new Promise(r => setTimeout(r, 2));
      return signal.aborted ? { kind: 'cancelled' } : mockPredictor().predict(s, signal);
    },
  };
  const run = await runBenchmark(builtinDataset(), predictor, { concurrency: 1, signal: controller.signal });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.summary.samples.evaluated, 2);
  assert.equal(run.summary.samples.cancelled, 32);
  assert.ok(n < 5, 'no new requests start after cancelling');
});

test('recognition failures and thrown errors become failed results', async () => {
  const run = await runBenchmark(builtinDataset(), {
    id: 'flaky', kind: 'real',
    async predict(s) {
      if (s.id.endsWith('flop')) throw new Error('network down');
      if (s.sourceType === 'physical_photo') return { kind: 'failed', reason: 'Recognition took too long.', latencyMs: 5, attempts: 2, timedOut: true };
      return mockPredictor().predict(s, new AbortController().signal);
    },
  }, { clock: fixedClock });
  assert.ok(run.results.some(r => r.failure === 'network down'));
  assert.equal(run.usage.timeouts, 9);
  assert.equal(run.usage.retries, 9);
  assert.ok(run.tracking.find(t => t.sequenceId === 'physical-sequence').skipped);
});

// ---------------------------------------------------------------------------
// Comparison and export
// ---------------------------------------------------------------------------

test('runs on the same dataset compare metric by metric; different setups are flagged', async () => {
  const base = await mockRun();
  const better = JSON.parse(runToJson(base));
  better.id = 'newer';
  better.summary.cards.exact = ratio(180, 180);
  better.summary.cards.missing = ratio(0, 180);
  better.summary.pot.meanAbsoluteError = 3;
  const c = compareRuns(base, parseRun(better));
  assert.equal(c.equivalent, true);
  const change = key => c.metrics.find(m => m.key === key).change;
  assert.equal(change('cards.exact'), 'improved');
  assert.equal(change('cards.missing'), 'improved', 'fewer missing cards is better');
  assert.equal(change('pot.mae'), 'regressed', 'a larger error is worse');
  assert.equal(change('cards.rank'), 'unchanged');
  const other = { ...parseRun(better), dataset: { ...base.dataset, version: 'synthetic-2' }, config: { ...base.config, limit: 5 } };
  const d = compareRuns(base, other);
  assert.equal(d.equivalent, false);
  assert.ok(d.reasons.some(r => /Different datasets/.test(r)) && d.reasons.some(r => /sample selection/.test(r)));
  assert.ok(compareRuns(base, { ...base, provider: { ...base.provider, id: 'claude-browser', modelIds: ['claude-opus-5-5'] } }).notes.length === 2);
});

test('CSV escapes special characters and neutralises formulas; reports carry no images or secrets', async () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell(null), '');
  const run = await mockRun();
  const csv = runToCsv(run);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'section,key,value,numerator,denominator,detail');
  assert.ok(lines.some(l => l.startsWith('metric,cards.exact,0.97222') && l.includes(',175,180,')));
  assert.ok(lines.some(l => l.startsWith('sample,photo-uncertain-card,evaluated')));
  assert.ok(lines.some(l => l.startsWith('error,photo-uncertain-card:board.2,card')));
  assert.ok(lines.some(l => l.startsWith('run,cost,unavailable')));
  const json = runToJson(run);
  assert.doesNotMatch(json, /data:image|<svg|sk-ant-|ANTHROPIC_API_KEY/);
  assert.equal(JSON.parse(json).results.some(r => 'raw' in r), false, 'raw readings only when asked for');
  const withRaw = await runBenchmark(builtinDataset(), mockPredictor(), { keepRaw: true, limit: 1 });
  assert.ok('raw' in withRaw.results[0]);
});

test('the physical truth uses the scene’s own chip values and visible empty areas', () => {
  const ds = builtinDataset();
  const chips = ds.samples.find(s => s.id === 'photo-chip-stacks').groundTruth;
  assert.deepEqual(chips.players.map(p => [p.stack, p.bet]), [[500, 100], [450, 100], [700, 0]]);
  assert.equal(chips.pot, 150);
  assert.deepEqual(physicalTruth({ ...ds.samples[0] && { id: 'x', label: 'x', description: '', seats: [{ label: 'A', x: 600, y: 650 }, { label: 'B', x: 600, y: 150 }], cards: [], chips: [], dealer: null, chipConfig: { denominations: [] } } }).players.map(p => p.stack), [null, null]);
});
