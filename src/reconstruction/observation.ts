// Observations: a recognized screenshot placed in the reconstruction's order.
// Helpers here read chip totals and confidence without filling in unknowns.
import {
  restoreRecognition, type ConfidenceLabel, type RecognizedField, type ScreenshotRecognition,
} from '../vision/screenshot.js';
import type { HandObservation, ReviewStatus } from './types.js';

export class ReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconstructionError';
  }
}

/** Every field of a recognition with its path, for counting and confidence. */
export function recognitionFields(rec: ScreenshotRecognition): [string, RecognizedField<unknown>][] {
  const fields: [string, RecognizedField<unknown>][] = [
    ['pot', rec.pot], ['smallBlind', rec.smallBlind], ['bigBlind', rec.bigBlind],
    ['dealerSeat', rec.dealerSeat], ['heroSeat', rec.heroSeat], ['street', rec.street],
  ];
  rec.communityCards.forEach((c, i) => fields.push(['board.' + i, c]));
  rec.players.forEach((p, i) => {
    fields.push(['players.' + i + '.name', p.name], ['players.' + i + '.stack', p.stack], ['players.' + i + '.bet', p.bet], ['players.' + i + '.status', p.status]);
    p.cards.forEach((c, j) => fields.push(['players.' + i + '.cards.' + j, c]));
  });
  return fields;
}

/** The reader's confidence label per field; `null` where none is usable. Labels are not probabilities. */
export function fieldConfidence(rec: ScreenshotRecognition): Record<string, ConfidenceLabel | null> {
  return Object.fromEntries(recognitionFields(rec).map(([path, f]) => [path, f.confidence]));
}

export function correctedFieldCount(rec: ScreenshotRecognition): number {
  return recognitionFields(rec).filter(([, f]) => f.source === 'corrected').length;
}

/** `corrected` once any field was edited; otherwise what the user marked. */
export function reviewStatusOf(rec: ScreenshotRecognition, marked: ReviewStatus): ReviewStatus {
  return correctedFieldCount(rec) > 0 ? 'corrected' : marked === 'corrected' ? 'reviewed' : marked;
}

export function createObservation(screenshotId: string, sequenceIndex: number, recognition: ScreenshotRecognition): HandObservation {
  return {
    id: 'obs-' + screenshotId,
    screenshotId,
    sequenceIndex,
    timestamp: null,
    recognition,
    reviewStatus: reviewStatusOf(recognition, 'pending'),
    source: 'screenshot',
  };
}

/** A copy with a corrected recognition; the review status follows the edits. */
export function withRecognition(observation: HandObservation, recognition: ScreenshotRecognition): HandObservation {
  return { ...observation, recognition, reviewStatus: reviewStatusOf(recognition, observation.reviewStatus === 'pending' ? 'reviewed' : observation.reviewStatus) };
}

/** Possessive of a seat label: Your, Riley’s, Seat 2’s. */
export const possessive = (label: string) => (label.trim().toLowerCase() === 'you' ? 'Your' : label + '’s');
/** “You are” or “Riley is”. */
export const subjectIs = (label: string) => (label.trim().toLowerCase() === 'you' ? label + ' are' : label + ' is');
/** “You show” or “Riley shows”. */
export const subjectVerb = (label: string, verb: string) => (label.trim().toLowerCase() === 'you' ? label + ' ' + verb : label + ' ' + verb + 's');
export const seatName = (rec: ScreenshotRecognition, seat: number) => rec.players[seat]?.name.value ?? 'Seat ' + (seat + 1);

/** Chips in the middle: the pot plus bets in front of players. `null` when any part is unknown. */
export function middleChips(rec: ScreenshotRecognition): number | null {
  if (rec.pot.value === null) return null;
  if (rec.potIncludesBets) return rec.pot.value;
  let bets = 0;
  for (const p of rec.players) {
    if (p.bet.value === null) return null;
    bets += p.bet.value;
  }
  return rec.pot.value + bets;
}

/** Every chip on the table: stacks plus the middle. `null` when any part is unknown. */
export function tableChips(rec: ScreenshotRecognition): number | null {
  const middle = middleChips(rec);
  if (middle === null) return null;
  let stacks = 0;
  for (const p of rec.players) {
    if (p.stack.value === null) return null;
    stacks += p.stack.value;
  }
  return middle + stacks;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUSES: readonly ReviewStatus[] = ['pending', 'reviewed', 'corrected'];

/** Validate an observation from a saved or imported file. */
export function restoreObservation(raw: unknown): HandObservation {
  if (!isRecord(raw)) throw new ReconstructionError('An observation is not an object.');
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.screenshotId !== 'string' || !raw.screenshotId) {
    throw new ReconstructionError('An observation needs an ID and a screenshot ID.');
  }
  if (!Number.isSafeInteger(raw.sequenceIndex) || (raw.sequenceIndex as number) < 0) throw new ReconstructionError('An observation needs a sequence position.');
  if (raw.timestamp !== null && (typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp)))) {
    throw new ReconstructionError('An observation time must be an ISO time or null.');
  }
  if (!STATUSES.includes(raw.reviewStatus as ReviewStatus)) throw new ReconstructionError('An observation has an unknown review status.');
  if (raw.source !== 'screenshot') throw new ReconstructionError('An observation must come from a screenshot.');
  let recognition: ScreenshotRecognition;
  try {
    recognition = restoreRecognition(raw.recognition);
  } catch (error) {
    throw new ReconstructionError('Observation ' + raw.id + ': ' + (error instanceof Error ? error.message : 'invalid recognition'));
  }
  return {
    id: raw.id, screenshotId: raw.screenshotId, sequenceIndex: raw.sequenceIndex as number,
    timestamp: raw.timestamp as string | null, recognition,
    reviewStatus: reviewStatusOf(recognition, raw.reviewStatus as ReviewStatus), source: 'screenshot',
  };
}
