import type { Card } from '../core/types.js';

/** Version of the event and history formats. Bump with a migration. */
export const HAND_SCHEMA_VERSION = 1;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** One seat at the start of a hand. `null` cards are unknown, never guessed. */
export interface SeatSetup {
  readonly id: string;
  readonly name: string;
  /** Whole chips at the start of the hand. */
  readonly stack: number;
  /** Two hole cards when known; `null` entries are unknown. */
  readonly cards?: readonly (Card | null)[];
}

/** Everything fixed before the first event. Seats are listed clockwise. */
export interface HandSetup {
  readonly handId: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Per-player ante; 0 for none. */
  readonly ante: number;
  /** Index into `players` of the dealer button. */
  readonly dealer: number;
  readonly players: readonly SeatSetup[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HandEventPayloads {
  HAND_STARTED: Record<string, never>;
  HAND_COMPLETED: Record<string, never>;
  HAND_CANCELLED: { readonly reason: string };
  SMALL_BLIND_POSTED: { readonly playerId: string; readonly amount: number };
  BIG_BLIND_POSTED: { readonly playerId: string; readonly amount: number };
  ANTE_POSTED: { readonly playerId: string; readonly amount: number };
  PLAYER_FOLDED: { readonly playerId: string };
  PLAYER_CHECKED: { readonly playerId: string };
  /** `amount` is the chips added by the call. */
  PLAYER_CALLED: { readonly playerId: string; readonly amount: number };
  /** `to` is the total street commitment after the bet. */
  PLAYER_BET: { readonly playerId: string; readonly to: number };
  /** `to` is the total street commitment after the raise. */
  PLAYER_RAISED: { readonly playerId: string; readonly to: number };
  /** `amount` is the chips added: the player's whole remaining stack. */
  PLAYER_ALL_IN: { readonly playerId: string; readonly amount: number };
  FLOP_DEALT: { readonly cards: readonly Card[] };
  TURN_DEALT: { readonly card: Card };
  RIVER_DEALT: { readonly card: Card };
  SHOWDOWN_STARTED: Record<string, never>;
  PLAYER_CARDS_REVEALED: { readonly playerId: string; readonly cards: readonly Card[] };
  /** Awards one pot (0 is the main pot) to one or more players. */
  POT_AWARDED: { readonly potIndex: number; readonly awards: readonly { readonly playerId: string; readonly amount: number }[] };
}

export type HandEventType = keyof HandEventPayloads;
export const HAND_EVENT_TYPES = [
  'HAND_STARTED', 'HAND_COMPLETED', 'HAND_CANCELLED',
  'SMALL_BLIND_POSTED', 'BIG_BLIND_POSTED', 'ANTE_POSTED',
  'PLAYER_FOLDED', 'PLAYER_CHECKED', 'PLAYER_CALLED', 'PLAYER_BET', 'PLAYER_RAISED', 'PLAYER_ALL_IN',
  'FLOP_DEALT', 'TURN_DEALT', 'RIVER_DEALT',
  'SHOWDOWN_STARTED', 'PLAYER_CARDS_REVEALED', 'POT_AWARDED',
] as const satisfies readonly HandEventType[];

export type HandEvent = {
  [T in HandEventType]: {
    readonly schemaVersion: typeof HAND_SCHEMA_VERSION;
    /** Unique within the hand. */
    readonly id: string;
    readonly type: T;
    /** ISO 8601 time the event was recorded. */
    readonly timestamp: string;
    readonly handId: string;
    readonly payload: HandEventPayloads[T];
  }
}[HandEventType];

export type EventOf<T extends HandEventType> = Extract<HandEvent, { type: T }>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type PlayerStatus = 'active' | 'folded' | 'all-in';

export interface PlayerState {
  readonly id: string;
  readonly name: string;
  /** Seat index, clockwise. */
  readonly seat: number;
  readonly startingStack: number;
  /** Chips behind. */
  readonly stack: number;
  /** Chips committed on the current street (blinds and bets, not antes). */
  readonly committed: number;
  /** Chips put in this hand, antes included, after uncalled returns. */
  readonly total: number;
  readonly status: PlayerStatus;
  /** Hole cards; `null` entries are unknown. */
  readonly cards: readonly (Card | null)[];
  /** True once the cards were shown at showdown. */
  readonly shown: boolean;
  /** Acted voluntarily on this street (posting a blind does not count). */
  readonly hasActed: boolean;
  /** The street's bet level when this player last acted. */
  readonly lastActedLevel: number;
  /** Chips won from pots this hand. */
  readonly won: number;
}

export interface Pot {
  readonly amount: number;
  /** Players who can win it, in seat order. */
  readonly eligible: readonly string[];
  readonly awards: readonly { readonly playerId: string; readonly amount: number }[] | null;
}

/**
 * What the reducer expects next:
 * `start` HAND_STARTED · `post` antes and blinds · `act` a player action by
 * `actor` · `deal` the next street · `showdown` SHOWDOWN_STARTED · `reveal`
 * reveals and awards · `award` awards after everyone else folded · `done`
 * HAND_COMPLETED · `complete` / `cancelled` nothing more.
 */
export type HandStep = 'start' | 'post' | 'act' | 'deal' | 'showdown' | 'reveal' | 'award' | 'done' | 'complete' | 'cancelled';

export type HandPhase = Street | 'showdown' | 'complete' | 'cancelled';

export interface GameState {
  readonly schemaVersion: typeof HAND_SCHEMA_VERSION;
  readonly handId: string;
  readonly step: HandStep;
  readonly phase: HandPhase;
  readonly street: Street;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly dealer: number;
  readonly players: readonly PlayerState[];
  readonly board: readonly Card[];
  /** The street's bet level everyone must match. */
  readonly currentBet: number;
  /** Size of the last full bet or raise on this street; the minimum raise increment. */
  readonly lastFullRaise: number;
  /** Seat index of the player to act, when `step` is `act`. */
  readonly actor: number | null;
  /** Pots, filled in once betting ends. */
  readonly pots: readonly Pot[];
  /** Uncalled chips returned at the end of betting. */
  readonly returned: readonly { readonly playerId: string; readonly amount: number; readonly street: Street }[];
  /** Antes and blinds already posted. */
  readonly posted: { readonly antes: readonly string[]; readonly small: boolean; readonly big: boolean };
  /** Number of events applied. */
  readonly eventCount: number;
  /** Event IDs seen, to reject duplicates. */
  readonly eventIds: readonly string[];
}

/** Thrown for any event that cannot be applied. The input state is untouched. */
export class HandRuleError extends Error {
  constructor(message: string, readonly eventIndex?: number) {
    super(message);
    this.name = 'HandRuleError';
  }
}
