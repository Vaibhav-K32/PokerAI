import { standardDeck } from '../core/cards.js';
import type { Card } from '../core/types.js';

export type Confidence = 'high' | 'medium' | 'low';
export type SlotGroup = 'hero' | 'opponent' | 'board';

export interface CardObservation {
  /** Slot ID such as `hero-1`, `board-3`, or `opponent-2-1`. */
  slot: string;
  group: SlotGroup;
  /** Opponent seat from 1 to 3, left to right in the photo. */
  seat?: number;
  index: number;
  /** Empty when the card is visible but unreadable. */
  candidates: readonly { card: Card; score: number }[];
  /** Model-reported label. It is not a calibrated probability. */
  confidence: Confidence;
  /** True when another slot reports the same card. */
  duplicate: boolean;
}

export type Recognition =
  | { kind: 'unavailable'; reason: string }
  | {
    kind: 'observations';
    modelId: string;
    slots: readonly CardObservation[];
    issues: readonly string[];
    /** Opponent positions in the photo, including face-down hands. */
    opponentSeats: number;
  };

export interface Recognizer {
  recognize(image: Blob, signal?: AbortSignal): Promise<Recognition>;
}

export const localRecognizer: Recognizer = {
  async recognize() {
    return { kind: 'unavailable', reason: 'Recognition is unavailable in this starter. Enter the visible cards and confirm them below.' };
  },
};

const limits: Record<SlotGroup, number> = { opponent: 2, board: 5, hero: 2 };
const MAX_OPPONENTS = 3;
const scores: Record<Confidence, number> = { high: 1, medium: 0.5, low: 0.25 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted recognition payload and map it to observations.
 * Throws when the shape is wrong or a group has too many cards.
 */
export function toRecognition(payload: unknown): Recognition {
  if (!isRecord(payload) || typeof payload.modelId !== 'string' || !isRecord(payload.result)) {
    throw new Error('The recognition response was malformed.');
  }
  const result = payload.result;
  const slots: CardObservation[] = [];
  const addGroup = (group: SlotGroup, entries: unknown, seat?: number) => {
    if (!Array.isArray(entries)) throw new Error('The recognition response was malformed.');
    if (entries.length > limits[group]) {
      throw new Error((seat ? 'An opponent pair in the photo has more than ' + limits[group] + ' cards' : 'The photo shows more than ' + limits[group] + ' ' + group + ' cards') + '. Check the layout and try again.');
    }
    entries.forEach((entry: unknown, index) => {
      if (!isRecord(entry) || typeof entry.card !== 'string'
        || !(entry.confidence === 'high' || entry.confidence === 'medium' || entry.confidence === 'low')) {
        throw new Error('The recognition response was malformed.');
      }
      const known = standardDeck.includes(entry.card);
      if (!known && entry.card !== 'unknown') throw new Error('The recognition response named an invalid card.');
      const observation: CardObservation = {
        slot: group + (seat ? '-' + seat : '') + '-' + (index + 1),
        group,
        index,
        candidates: known ? [{ card: entry.card, score: scores[entry.confidence] }] : [],
        confidence: entry.confidence,
        duplicate: false,
      };
      if (seat) observation.seat = seat;
      slots.push(observation);
    });
  };
  const opponents = result.opponents;
  if (!Array.isArray(opponents)) throw new Error('The recognition response was malformed.');
  if (opponents.length > MAX_OPPONENTS) {
    throw new Error('The photo shows more than ' + MAX_OPPONENTS + ' opponents. The table seats at most four players.');
  }
  // One entry per opponent, left to right; face-down hands are empty lists.
  opponents.forEach((pair, i) => addGroup('opponent', pair, i + 1));
  addGroup('board', result.board);
  addGroup('hero', result.hero);
  const counts = new Map<Card, number>();
  for (const { candidates } of slots) {
    if (candidates[0]) counts.set(candidates[0].card, (counts.get(candidates[0].card) ?? 0) + 1);
  }
  for (const observation of slots) {
    const card = observation.candidates[0]?.card;
    if (card && (counts.get(card) ?? 0) > 1) observation.duplicate = true;
  }
  const issues = Array.isArray(result.issues)
    ? result.issues.filter((issue): issue is string => typeof issue === 'string').slice(0, 6)
    : [];
  return { kind: 'observations', modelId: payload.modelId, slots, issues, opponentSeats: opponents.length };
}

/** Sends one still to the app server, which forwards it to the Claude API. */
export function cloudRecognizer(endpoint = './api/recognize'): Recognizer {
  return {
    async recognize(image, signal) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST', body: image, signal, credentials: 'same-origin',
          headers: { 'Content-Type': image.type },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return { kind: 'unavailable', reason: 'The recognition server could not be reached. Enter the cards by hand.' };
      }
      if (response.status === 404 || response.status === 405) {
        return { kind: 'unavailable', reason: 'Cloud recognition is not available on this server. Enter the cards by hand.' };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Fall through to the generic message.
      }
      if (!response.ok) {
        const reason = isRecord(body) && typeof body.error === 'string' ? body.error : 'Recognition failed. Enter the cards by hand.';
        return { kind: 'unavailable', reason };
      }
      return toRecognition(body);
    },
  };
}
