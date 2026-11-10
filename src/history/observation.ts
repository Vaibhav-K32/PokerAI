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
