// Tracking metrics: run the Step 4 engine on a sequence of predicted frames
// and compare what it reports with sequence-level truth. Only directly
// observable changes are scored (identities, card reveals, street changes,
// contradictions, open gaps); betting actions that no frame shows are never
// counted as correct. Deterministic for fixed predictions.
import { createObservation, middleChips } from '../reconstruction/observation.js';
import { reconstructHand } from '../reconstruction/reconstruct.js';
import type { ScreenshotRecognition } from '../vision/screenshot.js';
import { matchSeats } from './metrics.js';
import type { BenchmarkSample, BenchmarkSequence, GroundTruth, SampleResult } from './types.js';

export interface TrackingResult {
  readonly sequenceId: string;
  readonly frames: number;
  /** Why the sequence was not scored (a frame was not recognized), if it was not. */
  readonly skipped?: string;
  /** Named players tracked with one ID across frames, not shared with anyone else. */
  readonly identity: { readonly consistent: number; readonly total: number };
  /** True hole-card reveals found, and reveals reported that did not happen. */
  readonly reveals: { readonly detected: number; readonly truth: number; readonly falsePositives: number };
  /** Intervals whose board change (from → to card count) matches the truth. */
  readonly streets: { readonly correct: number; readonly total: number };
  /** "Out of order" warnings on a correctly ordered sequence. */
  readonly falseOrderFlags: number;
  readonly contradictions: {
    /** Flagged where the frames are one hand and both were read without errors. */
    readonly false: number;
    /** Flagged where a reading error made the frames disagree. */
    readonly justified: number;
    /** Different hands that were not flagged. */
    readonly missed: number;
    /** Different hands that were flagged. */
    readonly caught: number;
  };
  /** Gaps where chips moved (truth) versus gaps the engine left unresolved. */
  readonly unresolved: { readonly truePositive: number; readonly falsePositive: number; readonly falseNegative: number; readonly undetermined: number };
  /** Frames whose checkpoint board and stacks match the truth. */
  readonly checkpoints: { readonly consistent: number; readonly total: number };
}

const empty = (sequenceId: string, frames: number, skipped: string): TrackingResult => ({
  sequenceId, frames, skipped,
  identity: { consistent: 0, total: 0 }, reveals: { detected: 0, truth: 0, falsePositives: 0 }, streets: { correct: 0, total: 0 }, falseOrderFlags: 0,
  contradictions: { false: 0, justified: 0, missed: 0, caught: 0 }, unresolved: { truePositive: 0, falsePositive: 0, falseNegative: 0, undetermined: 0 },
  checkpoints: { consistent: 0, total: 0 },
});

const name = (s: string | null) => s?.trim().toLowerCase() || null;
const hasCard = (truth: GroundTruth, seat: number) => truth.players[seat].cards.some(c => c.card.kind === 'card');

/** Did chips move between two true frames? `null` when the truth does not show enough. */
function truthChipsMoved(a: GroundTruth, b: GroundTruth): boolean | null {
  const middle = (t: GroundTruth) => (t.pot === null || t.players.some(p => p.bet === null) ? null : t.pot + t.players.reduce((s, p) => s + p.bet!, 0));
  const ma = middle(a);
  const mb = middle(b);
  let unknown = ma === null || mb === null;
  let moved = !unknown && ma !== mb;
  for (const p of a.players) {
    const q = b.players.find(x => name(x.name) && name(x.name) === name(p.name));
    if (!q) continue;
    if (p.stack === null || q.stack === null) unknown = true;
    else if (p.stack !== q.stack) moved = true;
  }
  return moved ? true : unknown ? null : false;
}

const SCORED_ERRORS = new Set(['card', 'missing_card', 'extra_card', 'invented', 'player', 'dealer', 'pot', 'stack', 'bet']);

export function scoreSequence(
  sequence: BenchmarkSequence,
  samples: ReadonlyMap<string, BenchmarkSample>,
  recognitions: ReadonlyMap<string, ScreenshotRecognition>,
  results: ReadonlyMap<string, SampleResult>,
): TrackingResult {
  const ids = sequence.sampleIds;
  const missing = ids.filter(id => !recognitions.has(id));
  if (missing.length) return empty(sequence.id, ids.length, missing.length + ' frame(s) were not recognized.');
  const truths = ids.map(id => samples.get(id)!.groundTruth);
  const recs = ids.map(id => recognitions.get(id)!);
  const observations = ids.map((id, i) => createObservation('bench-' + id, i, recs[i], { source: samples.get(id)!.sourceType === 'physical_photo' ? 'physical_photo' : 'screenshot' }));
  const result = reconstructHand(observations);
  const seatMaps = truths.map((t, i) => matchSeats(t, recs[i]));
  /** Truth seat → tracked player ID in frame i. */
  const trackedId = (i: number, seat: number) => {
    const k = seatMaps[i][seat];
    return k === null ? null : result.identity.frames[i]?.seats[k]?.playerId ?? null;
  };

  // Identity: every named player keeps one tracked ID, which no other player has.
  const idsByName = new Map<string, Set<string | null>>();
  const framesByName = new Map<string, number>();
  truths.forEach((t, i) => t.players.forEach((p, seat) => {
    const n = name(p.name);
    if (!n) return;
    idsByName.set(n, new Set([...(idsByName.get(n) ?? []), trackedId(i, seat)]));
    framesByName.set(n, (framesByName.get(n) ?? 0) + 1);
  }));
  const owners = new Map<string, Set<string>>();
  for (const [n, set] of idsByName) for (const id of set) if (id) owners.set(id, new Set([...(owners.get(id) ?? []), n]));
  let consistent = 0;
  let identityTotal = 0;
  for (const [n, set] of idsByName) {
    if ((framesByName.get(n) ?? 0) < 2) continue;
    identityTotal++;
    const [only] = [...set];
    if (set.size === 1 && only && owners.get(only)!.size === 1) consistent++;
  }

  let revealTruth = 0;
  let revealDetected = 0;
  let revealFalse = 0;
  let streetsCorrect = 0;
  let falseOrderFlags = 0;
  const contradictions = { false: 0, justified: 0, missed: 0, caught: 0 };
  const unresolved = { truePositive: 0, falsePositive: 0, falseNegative: 0, undetermined: 0 };
  result.intervals.forEach((interval, k) => {
    const [a, b] = [truths[k], truths[k + 1]];
    // Card reveals, matched to players through the tracked IDs of the later frame.
    const predictedReveals = new Set(interval.differences.filter(d => d.kind === 'hole-cards-visible' && d.playerId).map(d => d.playerId!));
    const truthReveals = new Set<string>();
    b.players.forEach((p, seat) => {
      const before = a.players.findIndex(x => name(x.name) && name(x.name) === name(p.name));
      if (hasCard(b, seat) && !(before >= 0 && hasCard(a, before))) {
        const id = trackedId(k + 1, seat);
        if (id) truthReveals.add(id);
        revealTruth++;
        if (id && predictedReveals.has(id)) revealDetected++;
      }
    });
    for (const id of predictedReveals) if (!truthReveals.has(id)) revealFalse++;
    // Street transitions as board-count changes.
    if (recs[k].communityCards.length === a.board.length && recs[k + 1].communityCards.length === b.board.length) streetsCorrect++;
    if (interval.consistencyReasons.some(r => /out of order/.test(r))) falseOrderFlags++;
    // Contradictions.
    const sameHand = sequence.sameHand?.[k] ?? true;
    const flagged = interval.consistency === 'contradictory';
    const readingError = [ids[k], ids[k + 1]].some(id => (results.get(id)?.errors ?? []).some(e => SCORED_ERRORS.has(e.category)));
    if (flagged && sameHand) {
      if (readingError) contradictions.justified++;
      else contradictions.false++;
    } else if (!flagged && !sameHand) contradictions.missed++;
    else if (flagged && !sameHand) contradictions.caught++;
    // Unresolved gaps: chips moved in truth and no actions were entered, so the gap should stay open.
    if (sameHand) {
      const moved = truthChipsMoved(a, b);
      const open = interval.status === 'unresolved' || interval.status === 'acknowledged' || interval.status === 'partial' || interval.consistency === 'ambiguous';
      if (moved === null) unresolved.undetermined++;
      else if (moved && open) unresolved.truePositive++;
      else if (!moved && open) unresolved.falsePositive++;
      else if (moved && !open) unresolved.falseNegative++;
    }
  });

  // Checkpoints: the frame's board and the stacks of matched seats agree with the truth.
  let checkpointsOk = 0;
  truths.forEach((t, i) => {
    const boardOk = t.board.length === recs[i].communityCards.length
      && t.board.every((s, j) => (s.card.kind === 'card' ? recs[i].communityCards[j].value === s.card.card : recs[i].communityCards[j].value === null));
    const stacksOk = t.players.every((p, seat) => {
      const k = seatMaps[i][seat];
      return k === null ? p.stack === null : recs[i].players[k].stack.value === p.stack;
    });
    if (boardOk && stacksOk && middleChips(recs[i]) !== undefined) checkpointsOk++;
  });

  return {
    sequenceId: sequence.id, frames: ids.length,
    identity: { consistent, total: identityTotal },
    reveals: { detected: revealDetected, truth: revealTruth, falsePositives: revealFalse },
    streets: { correct: streetsCorrect, total: result.intervals.length },
    falseOrderFlags, contradictions, unresolved,
    checkpoints: { consistent: checkpointsOk, total: truths.length },
  };
}
