// Per-sample scoring: compares one prediction with its ground truth, card by
// card at the same location, seat by seat, and value by value. A card is
// correct only where the truth has it; finding the same card elsewhere in the
// image does not count. Pure and deterministic.
import { hasBlockingIssues, needsReview, reviewScreenshot, type RecognizedCard, type ScreenshotRecognition } from '../vision/screenshot.js';
import type { PhysicalTableObservation } from '../physical/types.js';
import type {
  BenchmarkSample, CardOutcome, CardOutcomeKind, CardTag, DetectionResult, ErrorEntry, GroundTruth, NumberOutcome, Prediction, SampleResult, TruthBox, TruthSlot,
} from './types.js';

/** Minimum intersection over union for a predicted box to match a true card. */
export const IOU_THRESHOLD = 0.5;

const norm = (s: string | null | undefined) => s?.trim().toLowerCase() || null;

const truthLabel = (slot: TruthSlot | undefined) => (!slot ? 'none' : slot.card.kind === 'card' ? slot.card.card : slot.card.kind);
const predLabel = (c: RecognizedCard | undefined) => (!c ? 'none' : c.value ?? (c.hidden ? 'hidden' : 'unknown'));

/** Classify one card position. `null` when there is nothing to score (no card in truth or prediction). */
export function cardOutcome(slot: TruthSlot | undefined, predicted: RecognizedCard | undefined): CardOutcomeKind | null {
  const value = predicted?.value ?? null;
  if (!slot) return value ? 'extra' : null;
  const truth = slot.card;
  if (truth.kind === 'card') {
    if (!value) return 'missing';
    if (value === truth.card) return 'exact';
    if (value[0] === truth.card[0]) return 'rank_only';
    if (value[1] === truth.card[1]) return 'suit_only';
    return 'wrong';
  }
  if (truth.kind === 'face_down') return value ? 'extra' : predicted ? 'correct_hidden' : 'hidden_missed';
  return value ? 'invented' : 'correct_unknown';
}

/**
 * Pair true seats with predicted seats: first by visible name, then by
 * position where names do not conflict. Returns, for each true seat, the
 * predicted seat index or `null`.
 */
export function matchSeats(truth: GroundTruth, rec: ScreenshotRecognition): (number | null)[] {
  const map: (number | null)[] = truth.players.map(() => null);
  const taken = new Set<number>();
  truth.players.forEach((p, i) => {
    const name = norm(p.name);
    if (!name) return;
    const j = rec.players.findIndex((q, k) => !taken.has(k) && norm(q.name.value) === name);
    if (j >= 0) {
      map[i] = j;
      taken.add(j);
    }
  });
  truth.players.forEach((p, i) => {
    if (map[i] !== null || i >= rec.players.length || taken.has(i)) return;
    const a = norm(p.name);
    const b = norm(rec.players[i].name.value);
    if (a && b && a !== b) return;
    map[i] = i;
    taken.add(i);
  });
  return map;
}

export function iou(a: TruthBox, b: TruthBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy one-to-one matching by IoU (highest first) at `threshold`. Returns
 * pairs of [truth index, predicted index, IoU].
 */
export function matchBoxes(truth: readonly TruthBox[], predicted: readonly TruthBox[], threshold = IOU_THRESHOLD): [number, number, number][] {
  const candidates: [number, number, number][] = [];
  truth.forEach((t, i) => predicted.forEach((p, j) => {
    const v = iou(t, p);
    if (v >= threshold) candidates.push([i, j, v]);
  }));
  candidates.sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1]);
  const usedT = new Set<number>();
  const usedP = new Set<number>();
  const pairs: [number, number, number][] = [];
  for (const c of candidates) {
    if (usedT.has(c[0]) || usedP.has(c[1])) continue;
    usedT.add(c[0]);
    usedP.add(c[1]);
    pairs.push(c);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

function detection(truth: GroundTruth, physical: PhysicalTableObservation | undefined, seatMap: readonly (number | null)[], rec: ScreenshotRecognition): DetectionResult | null {
  const truthBoxes: { box: TruthBox; location: string }[] = [
    ...truth.board.flatMap((s, i) => (s.box ? [{ box: s.box, location: 'board' }] : [])),
    ...truth.players.flatMap((p, i) => p.cards.flatMap(s => (s.box ? [{ box: s.box, location: 'seat.' + i }] : []))),
  ];
  if (!truthBoxes.length) return null;
  const predicted = (physical?.cards ?? []).filter(c => c.box);
  if (!physical || !predicted.length) return { localization: 'unsupported', grouping: { correct: 0, total: 0 } };
  const pairs = matchBoxes(truthBoxes.map(t => t.box), predicted.map(c => c.box!));
  // A predicted seat zone is compared through the seat pairing: predicted seat k is true seat i when seatMap[i] === k.
  const predSeatIndex = (seatId: string) => physical.seats.findIndex(s => s.id === seatId);
  const truthSeatOf = (k: number) => seatMap.findIndex(m => m === k);
  let correct = 0;
  for (const [ti, pi] of pairs) {
    const zone = predicted[pi].zone;
    const where = zone.kind === 'board' ? 'board' : zone.kind === 'seat' ? 'seat.' + truthSeatOf(predSeatIndex(zone.seatId)) : 'unassigned';
    if (where === truthBoxes[ti].location) correct++;
  }
  void rec;
  return {
    localization: {
      truthBoxes: truthBoxes.length, predictedBoxes: predicted.length, matched: pairs.length,
      meanIoU: pairs.length ? pairs.reduce((s, p) => s + p[2], 0) / pairs.length : null,
    },
    grouping: { correct, total: pairs.length },
  };
}

const roleOf = (truth: number | null, predicted: number | null, map: readonly (number | null)[]) => {
  if (truth === null) return predicted === null ? 'n/a' as const : 'invented' as const;
  if (predicted === null) return 'missing' as const;
  return map[truth] === predicted ? 'correct' as const : 'wrong' as const;
};

/** Score one sample. Failed or cancelled predictions get a result with no scores. */
export function scoreSample(sample: BenchmarkSample, prediction: Prediction): SampleResult {
  const base = {
    sampleId: sample.id, sourceType: sample.sourceType, tags: sample.tags,
    cards: [], table: null, physical: null, invalidState: false, ambiguousFields: 0, warnings: [],
  };
  if (prediction.kind === 'cancelled') return { ...base, status: 'cancelled', latencyMs: null, providerId: null, modelId: null, attempts: 0, timedOut: false, errors: [] };
  if (prediction.kind === 'failed') {
    return {
      ...base, status: 'failed', latencyMs: prediction.latencyMs, providerId: null, modelId: null, attempts: prediction.attempts, timedOut: prediction.timedOut,
      failure: prediction.reason, errors: [{ category: 'recognition_failed', location: 'image', expected: 'a reading', actual: prediction.reason }],
    };
  }
  const truth = sample.groundTruth;
  const rec = prediction.recognition;
  const map = matchSeats(truth, rec);
  const cards: CardOutcome[] = [];
  const errors: ErrorEntry[] = [];
  const add = (location: string, area: CardOutcome['area'], slot: TruthSlot | undefined, pred: RecognizedCard | undefined, tags: readonly CardTag[] = []) => {
    const outcome = cardOutcome(slot, pred);
    if (!outcome) return;
    const entry: CardOutcome = { location, area, truth: truthLabel(slot), predicted: predLabel(pred), outcome, confidence: pred?.value ? pred.confidence : null, tags: slot?.tags ?? tags };
    cards.push(entry);
    const category = outcome === 'missing' ? 'missing_card' : outcome === 'extra' ? 'extra_card' : outcome === 'invented' ? 'invented'
      : outcome === 'rank_only' || outcome === 'suit_only' || outcome === 'wrong' ? 'card' : null;
    if (category) errors.push({ category, location, expected: entry.truth, actual: entry.predicted });
  };
  const boardLength = Math.max(truth.board.length, rec.communityCards.length);
  for (let i = 0; i < boardLength; i++) add('board.' + i, 'community', truth.board[i], rec.communityCards[i]);
  truth.players.forEach((p, i) => {
    const k = map[i];
    const predCards = k === null ? [] : rec.players[k].cards;
    for (let j = 0; j < Math.max(p.cards.length, predCards.length); j++) add('seat.' + i + '.card.' + j, 'player', p.cards[j], predCards[j]);
  });
  const extraSeats = rec.players.map((_, k) => k).filter(k => !map.includes(k));
  for (const k of extraSeats) rec.players[k].cards.forEach((c, j) => add('extra.seat.' + k + '.card.' + j, 'player', undefined, c));

  const numbers: NumberOutcome[] = [{ field: 'pot', truth: truth.pot, predicted: rec.pot.value }];
  let foldedCorrect = 0;
  let foldedTotal = 0;
  truth.players.forEach((p, i) => {
    const q = map[i] === null ? null : rec.players[map[i]!];
    numbers.push({ field: 'seat.' + i + '.stack', truth: p.stack, predicted: q?.stack.value ?? null });
    numbers.push({ field: 'seat.' + i + '.bet', truth: p.bet, predicted: q?.bet.value ?? null });
    if (p.folded !== null) {
      foldedTotal++;
      const predicted = q?.status.value ?? null;
      if (predicted !== null && (predicted === 'folded') === p.folded) foldedCorrect++;
    }
  });
  for (const n of numbers) {
    if (n.truth !== n.predicted) {
      const category = n.field === 'pot' ? 'pot' : n.field.endsWith('.stack') ? 'stack' : 'bet';
      errors.push({ category, location: n.field, expected: n.truth === null ? 'not visible' : String(n.truth), actual: n.predicted === null ? 'unknown' : String(n.predicted) });
    }
  }
  const missingPlayers = map.filter(m => m === null).length;
  const table: NonNullable<SampleResult['table']> = {
    playerCount: { truth: truth.players.length, predicted: rec.players.length },
    seatsInPlace: { correct: map.filter((m, i) => m === i).length, total: truth.players.length },
    missingPlayers,
    extraPlayers: extraSeats.length,
    dealer: roleOf(truth.dealerSeat, rec.dealerSeat.value, map),
    hero: roleOf(truth.heroSeat, rec.heroSeat.value, map),
    street: truth.street === null ? 'n/a' : rec.street.value === null ? 'missing' : rec.street.value === truth.street ? 'correct' : 'wrong',
    folded: { correct: foldedCorrect, total: foldedTotal },
    numbers,
  };
  if (missingPlayers) errors.push({ category: 'player', location: 'players', expected: truth.players.length + ' seats', actual: rec.players.length + ' seats, ' + missingPlayers + ' not found' });
  if (extraSeats.length) errors.push({ category: 'player', location: 'players', expected: truth.players.length + ' seats', actual: extraSeats.length + ' extra seat(s)' });
  if (table.dealer !== 'correct' && table.dealer !== 'n/a') errors.push({ category: 'dealer', location: 'dealer', expected: truth.dealerSeat === null ? 'none' : 'seat ' + (truth.dealerSeat + 1), actual: rec.dealerSeat.value === null ? 'unknown' : 'seat ' + (rec.dealerSeat.value + 1) });
  if (table.street === 'wrong' || table.street === 'missing') errors.push({ category: 'street', location: 'street', expected: truth.street ?? 'none', actual: rec.street.value ?? 'unknown' });
  const invalidState = hasBlockingIssues(reviewScreenshot(rec));
  if (invalidState) errors.push({ category: 'invalid_state', location: 'state', expected: 'a valid table state', actual: reviewScreenshot(rec).filter(i => i.severity === 'error').map(i => i.message).join(' ') });
  const ambiguousFields = [
    rec.pot, rec.street, rec.dealerSeat, ...rec.communityCards, ...rec.players.flatMap(p => [p.stack, p.bet, p.name, ...p.cards]),
  ].filter(f => f.value !== null && needsReview(f)).length;

  return {
    ...base,
    status: 'evaluated',
    latencyMs: prediction.latencyMs,
    providerId: prediction.providerId,
    modelId: prediction.modelId,
    attempts: prediction.attempts,
    timedOut: false,
    cards,
    table,
    physical: sample.sourceType === 'physical_photo' ? detection(truth, prediction.physical, map, rec) : null,
    invalidState,
    ambiguousFields,
    warnings: [...rec.warnings],
    errors,
    ...(prediction.raw !== undefined ? { raw: prediction.raw } : {}),
  };
}
