// The reconstruction engine. Turns ordered observations into checkpoints,
// intervals between them, and a timeline. Every interval separates what the
// screenshots show (confirmed), what could explain it (possible, never
// treated as fact), and what cannot happen in one hand (contradictions).
// Pure and deterministic: the same observations and resolutions always give
// the same result.
import { matchObservation } from '../history/observation.js';
import type { GameState } from '../history/types.js';
import { reviewScreenshot, toTableObservation, type ScreenshotRecognition } from '../vision/screenshot.js';
import { alignSeats, compareObservations, DIFFERENT_HAND_KINDS } from './compare.js';
import { correctedFieldCount, middleChips, possessive, seatName, subjectIs, tableChips } from './observation.js';
import { checkActions } from './resolve.js';
import type {
  Checkpoint, ConfirmedFact, Contradiction, HandObservation, Interval, IntervalResolution, IntervalStatus,
  PossibleTransition, ReconstructionMetrics, ReconstructionOptions, ReconstructionResult, StateDifference, TimelineEntry,
} from './types.js';

const shot = (o: HandObservation) => 'screenshot ' + (o.sequenceIndex + 1);
const plural = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');

/** Observations in chronological order. */
export const ordered = (observations: readonly HandObservation[]) => [...observations].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

function checkpointOf(o: HandObservation, index: number): Checkpoint {
  const rec = o.recognition;
  const issues = reviewScreenshot(rec);
  const confirmed: ConfirmedFact[] = [];
  const fact = (text: string) => confirmed.push({ observationId: o.id, text });
  const board = rec.communityCards.map(c => c.value);
  if (board.length) fact('The board shows ' + plural(board.length, 'card') + ': ' + board.map(c => c ?? '?').join(' ') + '.');
  else fact('No community cards are showing.');
  if (rec.street.value) fact('Street: ' + rec.street.value + (rec.street.source === 'inferred' ? ' (inferred from the board)' : '') + '.');
  if (rec.pot.value !== null) fact('The pot shows ' + rec.pot.value + '.');
  rec.players.forEach((p, i) => {
    if (p.status.value === 'folded') fact(subjectIs(seatName(rec, i)) + ' shown as folded.');
    const shown = p.cards.map(c => c.value).filter((c): c is string => c !== null);
    if (shown.length) fact(possessive(seatName(rec, i)) + ' cards: ' + shown.join(' ') + '.');
  });
  return {
    observationId: o.id,
    screenshotId: o.screenshotId,
    index,
    street: rec.street.value,
    streetSource: rec.street.source,
    board,
    pot: rec.pot.value,
    stacks: rec.players.map((p, i) => ({ label: seatName(rec, i), stack: p.stack.value, folded: p.status.value === null ? null : p.status.value === 'folded' })),
    confirmed,
    contradictions: issues.filter(i => i.severity === 'error').map(i => ({ observationIds: [o.id], field: i.field, text: 'In ' + shot(o) + ': ' + i.message })),
    reviewCount: issues.filter(i => i.severity === 'review').length,
    reviewStatus: o.reviewStatus,
  };
}

const CONFIRMED_KINDS = new Set<StateDifference['kind']>([
  'board-dealt', 'board-card-visible', 'stack-changed', 'bet-changed', 'status-changed', 'hole-cards-visible', 'pot-changed', 'street-changed', 'value-visible',
]);

function stackChanges(a: ScreenshotRecognition, b: ScreenshotRecognition) {
  const rotation = alignSeats(a, b);
  if (rotation === null) return null;
  const n = a.players.length;
  return a.players.map((p, i) => {
    const q = b.players[(i - rotation + n) % n];
    return {
      name: seatName(a, i),
      before: p.stack.value,
      after: q.stack.value,
      delta: p.stack.value !== null && q.stack.value !== null ? q.stack.value - p.stack.value : null,
      folded: p.status.value === 'folded',
    };
  });
}

function intervalOf(a: HandObservation, b: HandObservation, fromIndex: number, resolution: IntervalResolution | null): Interval {
  const differences = compareObservations(a, b);
  const confirmed: ConfirmedFact[] = differences
    .filter(d => d.severity !== 'contradiction' && CONFIRMED_KINDS.has(d.kind))
    .map(d => ({ observationId: b.id, text: d.label }));
  const contradictions: Contradiction[] = differences
    .filter(d => d.severity === 'contradiction')
    .map(d => ({ observationIds: [a.id, b.id], field: d.field, text: d.label + (d.warning ? ' ' + d.warning : '') }));
  const possible: PossibleTransition[] = [];
  const differentHandSigns = differences.filter(d => DIFFERENT_HAND_KINDS.includes(d.kind)).map(d => d.label);

  // Chip conservation: no sequence of actions creates or destroys chips.
  const totalA = tableChips(a.recognition);
  const totalB = tableChips(b.recognition);
  if (totalA !== null && totalB !== null && totalA !== totalB) {
    contradictions.push({
      observationIds: [a.id, b.id], field: 'chips',
      text: 'The chips on the table changed from ' + totalA + ' to ' + totalB + '. No sequence of actions creates or removes chips (rake is not modeled); a stack, bet, or the pot was misread.',
    });
  }

  const ma = middleChips(a.recognition);
  const mb = middleChips(b.recognition);
  const middleChange = ma !== null && mb !== null ? mb - ma : null;
  const stacks = stackChanges(a.recognition, b.recognition);
  const boardDealt = differences.find(d => d.kind === 'board-dealt');
  const streetsSkipped = boardDealt?.warning !== undefined;
  const chipsMoved = (middleChange !== null && middleChange !== 0) || (stacks?.some(s => s.delta !== null && s.delta !== 0) ?? false);
  const chipsKnown = middleChange !== null && (stacks?.every(s => s.folded || s.delta !== null) ?? false);

  if (middleChange !== null && middleChange > 0) {
    const payers = stacks?.filter(s => s.delta !== null && s.delta < 0) ?? [];
    const unknownStacks = stacks?.filter(s => !s.folded && s.delta === null) ?? [];
    const alternatives: string[] = [];
    for (const s of payers) alternatives.push(s.name + ' put in ' + -s.delta! + ' chips: a call, bet, raise, or all-in, or several of them.');
    if (unknownStacks.length) alternatives.push('Seats with an unknown stack may also have contributed: ' + unknownStacks.map(s => s.name).join(', ') + '.');
    if (boardDealt) alternatives.push('The chips may have gone in before or after the new board cards were dealt.');
    alternatives.push('The order of the actions is not shown.');
    possible.push({
      text: 'An additional ' + middleChange + ' chips appear in the middle between these screenshots. The contributing actions are unknown.',
      alternatives,
    });
  } else if (middleChange !== null && middleChange < 0) {
    const gainers = stacks?.filter(s => s.delta !== null && s.delta > 0) ?? [];
    possible.push({
      text: -middleChange + ' chips left the middle.',
      alternatives: [
        ...gainers.map(s => s.name + ' may have won a pot or had an uncalled bet returned (+' + s.delta + ').'),
        'A pot, bet, or stack may have been misread.',
      ],
    });
  } else if (middleChange === null && chipsMoved) {
    possible.push({
      text: 'Stacks changed, but the pot or a bet is unknown, so the chip movement cannot be checked.',
      alternatives: ['Enter the missing pot or bet values to compare the totals.'],
    });
  }
  // With at most one live player holding chips, no one can bet on later streets.
  const canBet = a.recognition.players.filter((p, i) => p.status.value !== 'folded' && (p.stack.value === null || p.stack.value > 0)).length;
  const allInRunout = boardDealt && canBet <= 1;
  if (allInRunout) {
    confirmed.push({ observationId: b.id, text: 'At most one player still had chips, so the board ran out with no more betting.' });
  } else if (streetsSkipped) {
    possible.push({
      text: 'More than one street was dealt between these screenshots.',
      alternatives: ['Everyone may have checked on the skipped street.', 'There may have been bets and calls on it.', 'The chips that went in cannot be split by street.'],
    });
  }
  if (!chipsMoved && chipsKnown && boardDealt) {
    confirmed.push({ observationId: b.id, text: 'No chips moved while the board advanced, so the betting in between was only checks' + (differences.some(d => d.kind === 'status-changed') ? ' and folds.' : '.') });
  }
  if (!chipsKnown && !chipsMoved && (boardDealt || differences.some(d => d.kind === 'status-changed'))) {
    possible.push({
      text: 'Some stacks or the pot are unknown, so it is not known whether chips moved.',
      alternatives: ['Only checks and folds may have happened.', 'Bets and calls may have happened.'],
    });
  }

  const actionCheck = resolution?.actions.length ? checkActions(a, b, resolution.actions) : null;
  let status: IntervalStatus;
  if (resolution?.mark === 'different-hands') status = 'different-hands';
  else if (contradictions.length) status = 'contradiction';
  else if (actionCheck) status = !actionCheck.error && actionCheck.explains ? 'resolved' : 'partial';
  else if (chipsMoved || possible.length) status = resolution?.mark === 'unresolved' ? 'acknowledged' : 'unresolved';
  else status = differences.length ? 'verified' : 'unchanged';

  const summaries: Record<IntervalStatus, string> = {
    unchanged: 'No visible change.',
    verified: 'Every visible change is accounted for.',
    unresolved: middleChange !== null && middleChange > 0
      ? '+' + middleChange + ' chips in the middle; the actions are unknown.'
      : 'Some changes cannot be explained from the screenshots alone.',
    acknowledged: 'Marked as unresolved: the actions stay unknown.',
    resolved: 'Your confirmed actions explain every visible change.',
    partial: actionCheck?.error ? 'A confirmed action is not valid: ' + actionCheck.error.message : 'Your confirmed actions explain part of the change.',
    contradiction: plural(contradictions.length, 'contradiction') + ' to review.',
    'different-hands': 'Marked as different hands.',
  };
  return {
    from: a.id, to: b.id, fromIndex, differences, confirmed, possible, contradictions, middleChange,
    differentHandSigns, resolution, actionCheck, status, summary: summaries[status],
  };
}

type Location = { key: string; label: string; observationId: string };

/** One card in two places, or more than two cards for one player, across the sequence. */
function crossContradictions(list: readonly HandObservation[]): Contradiction[] {
  const byCard = new Map<string, Location[]>();
  const bySeat = new Map<string, { cards: Set<string>; ids: Set<string>; label: string }>();
  for (const o of list) {
    const rec = o.recognition;
    rec.communityCards.forEach((c, i) => {
      if (c.value) byCard.set(c.value, [...(byCard.get(c.value) ?? []), { key: 'board', label: 'on the board in ' + shot(o), observationId: o.id }]);
    });
    rec.players.forEach((p, i) => {
      const name = rec.players[i].name.value?.trim().toLowerCase() ?? 'seat ' + (i + 1);
      const seat = bySeat.get(name) ?? { cards: new Set<string>(), ids: new Set<string>(), label: seatName(rec, i) };
      for (const c of p.cards) {
        if (!c.value) continue;
        seat.cards.add(c.value);
        seat.ids.add(o.id);
        byCard.set(c.value, [...(byCard.get(c.value) ?? []), { key: 'seat:' + name, label: 'in ' + possessive(seatName(rec, i)).replace(/^Your$/, 'your') + ' hand in ' + shot(o), observationId: o.id }]);
      }
      bySeat.set(name, seat);
    });
  }
  const out: Contradiction[] = [];
  for (const [card, places] of byCard) {
    const keys = [...new Set(places.map(p => p.key))];
    if (keys.length < 2) continue;
    const first = places[0];
    const other = places.find(p => p.key !== first.key)!;
    out.push({
      observationIds: [...new Set(places.map(p => p.observationId))], field: 'card:' + card,
      text: card + ' appears ' + first.label + ' and ' + other.label + '. A card can be in only one place.',
    });
  }
  for (const seat of bySeat.values()) {
    if (seat.cards.size > 2) {
      out.push({ observationIds: [...seat.ids], field: 'cards:' + seat.label, text: seat.label + ' is shown with ' + seat.cards.size + ' different hole cards (' + [...seat.cards].join(' ') + ') across the screenshots.' });
    }
  }
  return out;
}

/**
 * Reconstruct a hand from ordered observations and the user's resolutions.
 * Possible transitions stay alternatives; actions become executable events
 * only when the user entered them and the hand engine accepted them.
 */
export function reconstructHand(observations: readonly HandObservation[], options: ReconstructionOptions = {}): ReconstructionResult {
  const list = ordered(observations);
  const checkpoints = list.map(checkpointOf);
  const intervals: Interval[] = [];
  for (let i = 1; i < list.length; i++) {
    const resolution = options.resolutions?.find(r => r.from === list[i - 1].id && r.to === list[i].id) ?? null;
    intervals.push(intervalOf(list[i - 1], list[i], i - 1, resolution));
  }
  const globalContradictions = crossContradictions(list);
  const timeline: TimelineEntry[] = [];
  checkpoints.forEach((checkpoint, i) => {
    timeline.push({ kind: 'checkpoint', checkpoint });
    if (intervals[i]) timeline.push({ kind: 'interval', interval: intervals[i] });
  });

  const counted = intervals.filter(i => i.status !== 'different-hands');
  const metrics: ReconstructionMetrics = {
    screenshots: Math.max(options.screenshotCount ?? list.length, list.length),
    checkpoints: list.length,
    correctedFields: list.reduce((sum, o) => sum + correctedFieldCount(o.recognition), 0),
    verifiedTransitions: intervals.filter(i => i.status === 'verified' || i.status === 'resolved').length,
    unresolvedIntervals: intervals.filter(i => i.status === 'unresolved' || i.status === 'acknowledged' || i.status === 'partial').length,
    contradictions: checkpoints.reduce((sum, c) => sum + c.contradictions.length, 0)
      + counted.reduce((sum, i) => sum + i.contradictions.length, 0) + globalContradictions.length,
    pendingReview: list.filter(o => o.reviewStatus === 'pending').length,
  };

  const warnings: string[] = [];
  if (metrics.screenshots > list.length) warnings.push(plural(metrics.screenshots - list.length, 'screenshot') + ' not recognized yet.');
  if (list.length === 1) warnings.push('Add a second screenshot to compare states.');
  for (const c of checkpoints) if (c.contradictions.length) warnings.push('Screenshot ' + (c.index + 1) + ' has ' + plural(c.contradictions.length, 'problem') + ' to fix.');
  for (const i of intervals) {
    if (i.status === 'contradiction') warnings.push('Screenshots ' + (i.fromIndex + 1) + '–' + (i.fromIndex + 2) + ': ' + i.summary);
    if (i.differentHandSigns.length && i.status !== 'different-hands') warnings.push('Screenshots ' + (i.fromIndex + 1) + ' and ' + (i.fromIndex + 2) + ' may be from different hands.');
  }
  for (const c of globalContradictions) warnings.push(c.text);
  if (list.some(o => o.recognition.providerId === 'claude')) warnings.push('Confidence labels are the reader’s own estimates, not measured accuracy.');
  return { checkpoints, intervals, timeline, globalContradictions, warnings, metrics };
}

/**
 * Where a reconstruction fits a recorded hand: one replay position per
 * observation, in order, with one seat rotation. Uses the hand history
 * engine's matcher. Returns `null` when no consistent placement exists.
 */
export function matchHistory(states: readonly GameState[], observations: readonly HandObservation[]): { positions: number[]; rotation: number } | null {
  const list = ordered(observations);
  if (!list.length) return null;
  const matches = list.map(o => matchObservation(states, toTableObservation(o.recognition)));
  const rotations = [...new Set(matches[0].map(m => m.rotation))];
  for (const rotation of rotations) {
    const positions: number[] = [];
    let floor = 0;
    let ok = true;
    for (const found of matches) {
      const at = found.filter(m => m.rotation === rotation && m.position >= floor).map(m => m.position).sort((x, y) => x - y)[0];
      if (at === undefined) {
        ok = false;
        break;
      }
      positions.push(at);
      floor = at;
    }
    if (ok) return { positions, rotation };
  }
  return null;
}
