// The seam for future recognition modules. A recognizer (screenshot or
// camera) proposes candidate events with its confidence; the rules engine
// decides whether each is legal. Nothing here infers events from pixels, and
// accepted candidates are only added to a history by an explicit caller.
import { actionOptions, applyHandEvent, nextPost } from './engine.js';
import { HandRuleError, type GameState, type HandEvent, type HandEventType, type Street } from './types.js';

export type CandidateSource = 'manual' | 'screenshot' | 'camera' | 'import';

export interface EventCandidate {
  readonly event: HandEvent;
  readonly source: CandidateSource;
  /** Recognizer confidence from 0 to 1, when the source reports one. Not a probability. */
  readonly confidence?: number;
  readonly note?: string;
}

export type CandidateResult =
  | { readonly ok: true; readonly state: GameState; readonly candidate: EventCandidate }
  | { readonly ok: false; readonly error: string; readonly candidate: EventCandidate };

/** Check a proposed event against the rules without changing `state`. */
export function validateCandidate(state: GameState, candidate: EventCandidate): CandidateResult {
  try {
    return { ok: true, state: applyHandEvent(state, candidate.event), candidate };
  } catch (error) {
    if (error instanceof HandRuleError) return { ok: false, error: error.message, candidate };
    throw error;
  }
}

export interface Expectation {
  /** Event types the engine would accept now. */
  readonly types: readonly HandEventType[];
  /** Player expected to post or act, if any. */
  readonly playerId: string | null;
  /** Street to deal next, when dealing. */
  readonly street?: Street;
}

/** What the engine expects next, so a recognizer knows what to look for. */
export function expectedNext(state: GameState): Expectation {
  switch (state.step) {
    case 'start': return { types: ['HAND_STARTED', 'HAND_CANCELLED'], playerId: null };
    case 'post': {
      const due = nextPost(state);
      return { types: due ? [due.type, 'HAND_CANCELLED'] : ['HAND_CANCELLED'], playerId: due ? state.players[due.seat].id : null };
    }
    case 'act': {
      const options = actionOptions(state)!;
      const types: HandEventType[] = ['PLAYER_FOLDED'];
      if (options.canCheck) types.push('PLAYER_CHECKED');
      else types.push('PLAYER_CALLED');
      if (options.canBet) types.push('PLAYER_BET');
      if (options.canRaise) types.push('PLAYER_RAISED');
      types.push('PLAYER_ALL_IN', 'HAND_CANCELLED');
      return { types, playerId: options.playerId };
    }
    case 'deal': {
      const street = state.street === 'preflop' ? 'flop' : state.street === 'flop' ? 'turn' : 'river';
      return { types: [street === 'flop' ? 'FLOP_DEALT' : street === 'turn' ? 'TURN_DEALT' : 'RIVER_DEALT', 'HAND_CANCELLED'], playerId: null, street };
    }
    case 'showdown': return { types: ['SHOWDOWN_STARTED', 'HAND_CANCELLED'], playerId: null };
    case 'reveal': return { types: ['PLAYER_CARDS_REVEALED', 'POT_AWARDED'], playerId: null };
    case 'award': return { types: ['POT_AWARDED'], playerId: null };
    case 'done': return { types: ['HAND_COMPLETED'], playerId: null };
    default: return { types: [], playerId: null };
  }
}

// ---------------------------------------------------------------------------
// Observed table states (screenshots, photos) against recorded hands
// ---------------------------------------------------------------------------

/** One seat as observed. `null` fields were not visible. */
export interface ObservedSeat {
  readonly name: string | null;
  /** Two entries; `null` for unknown or face-down cards. */
  readonly cards: readonly (string | null)[];
  readonly stack: number | null;
  /** Chips in front of the seat on the current street. */
  readonly bet: number | null;
  readonly folded: boolean | null;
}

/** A single observed table state. It proves nothing about earlier actions. */
export interface TableObservation {
  /** Board positions left to right; `null` for unreadable cards. */
  readonly board: readonly (string | null)[];
  readonly pot: number | null;
  /** True when `pot` already includes current-street bets. */
  readonly potIncludesBets: boolean;
  /** Seats in clockwise order. */
  readonly players: readonly ObservedSeat[];
}

export interface ObservationMatch {
  /** Replay position: the state after this many events. */
  readonly position: number;
  /** Observed seat k is engine seat (k + rotation) mod n. */
  readonly rotation: number;
}

/**
 * Every replay position and seat rotation where the recorded hand agrees with
 * everything the observation shows: seat count, names when visible, board,
 * known cards, stacks, bets, folds, and the pot. Unknown observed fields match
 * anything. An empty result means the observation is not compatible.
 */
export function matchObservation(states: readonly GameState[], observation: TableObservation): ObservationMatch[] {
  const matches: ObservationMatch[] = [];
  const first = states[0];
  if (!first || observation.players.length !== first.players.length) return matches;
  const n = first.players.length;
  const rotations = Array.from({ length: n }, (_, r) => r).filter(r => observation.players.every((seat, k) => {
    const name = seat.name?.trim().toLowerCase();
    return !name || first.players[(k + r) % n].name.trim().toLowerCase() === name;
  }));
  states.forEach((state, position) => {
    if (state.step === 'start' || state.step === 'post' && state.eventCount === 0) return;
    if (state.board.length !== observation.board.length) return;
    if (observation.board.some((card, i) => card !== null && card !== state.board[i])) return;
    const bets = state.players.reduce((sum, p) => sum + p.committed, 0);
    const middle = state.players.reduce((sum, p) => sum + p.total - p.won, 0);
    if (observation.pot !== null && observation.pot !== (observation.potIncludesBets ? middle : middle - bets)) return;
    for (const rotation of rotations) {
      const fits = observation.players.every((seat, k) => {
        const p = state.players[(k + rotation) % n];
        if (seat.stack !== null && seat.stack !== p.stack) return false;
        if (seat.bet !== null && seat.bet !== p.committed) return false;
        if (seat.folded !== null && seat.folded !== (p.status === 'folded')) return false;
        return seat.cards.every(card => card === null || p.cards.includes(card) || p.cards.some(c => c === null));
      });
      if (fits) matches.push({ position, rotation });
    }
  });
  return matches;
}
