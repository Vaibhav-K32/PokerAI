import type { Card, Snapshot } from '../core/types.js';
import { holdem } from './holdem.js';

export type Seat = 0 | 1;
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
type Seats<T> = readonly [T, T];

export interface HoldemReplayConfig {
  readonly purpose: Snapshot['purpose'];
  readonly button: Seat;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  // An empty entry means that seat's cards are unknown.
  readonly holeCards?: Seats<readonly Card[]>;
}

export type HoldemEvent =
  | { readonly kind: 'check' | 'call' | 'fold'; readonly seat: Seat }
  | { readonly kind: 'bet' | 'raise'; readonly seat: Seat; readonly to: number }
  | { readonly kind: 'deal'; readonly cards: readonly Card[] };

export interface HoldemReplayState {
  readonly purpose: Snapshot['purpose'];
  readonly button: Seat;
  readonly bigBlind: number;
  readonly holeCards: Seats<readonly Card[]>;
  readonly board: readonly Card[];
  readonly street: Street;
  readonly phase: 'betting' | 'awaiting-board' | 'folded' | 'showdown';
  readonly actor: Seat | null;
  readonly foldWinner: Seat | null;
  // The pot includes the current street commitments.
  readonly pot: number;
  readonly stacks: Seats<number>;
  readonly committed: Seats<number>;
  readonly minIncrement: number;
}

function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function bySeat<T>(seat: Seat, value: T, opponentValue: T): Seats<T> {
  return seat === 0 ? [value, opponentValue] : [opponentValue, value];
}

function validateCards(cards: readonly Card[]) {
  if (cards.some(card => !holdem.deck.includes(card))) throw new Error('Use valid Hold’em cards.');
  if (new Set(cards).size !== cards.length) throw new Error('Each card can appear only once.');
}

export function startHoldemReplay(config: HoldemReplayConfig): HoldemReplayState {
  const { purpose, button, startingStack, smallBlind, bigBlind } = config;
  if (purpose !== 'simulation' && purpose !== 'completed') throw new Error('Choose a study context.');
  if (button !== 0 && button !== 1) throw new Error('Choose button seat 0 or 1.');
  if (![startingStack, smallBlind, bigBlind].every(Number.isSafeInteger)
    || smallBlind <= 0 || smallBlind >= bigBlind || bigBlind >= startingStack
    || startingStack > 500_000_000) {
    throw new Error('Use whole chips with 0 < small blind < big blind < starting stack, up to 500 million per seat.');
  }

  const holeCards = config.holeCards ?? [[], []];
  if (holeCards.length !== 2 || holeCards.some(cards => cards.length !== 0 && cards.length !== 2)) {
    throw new Error('Give each seat two hole cards or leave them unknown.');
  }
  validateCards([...holeCards[0], ...holeCards[1]]);

  return {
    purpose,
    button,
    bigBlind,
    holeCards: [[...holeCards[0]], [...holeCards[1]]],
    board: [],
    street: 'preflop',
    phase: 'betting',
    actor: button,
    foldWinner: null,
    pot: smallBlind + bigBlind,
    stacks: bySeat(button, startingStack - smallBlind, startingStack - bigBlind),
    committed: bySeat(button, smallBlind, bigBlind),
    minIncrement: bigBlind,
  };
}

/** Chips owed by the acting seat, or null when the hand has no decision. */
export function amountToCall(state: HoldemReplayState): number | null {
  const seat = state.actor;
  return seat === null ? null : state.committed[other(seat)] - state.committed[seat];
}

function commit(state: HoldemReplayState, seat: Seat, to: number): HoldemReplayState {
  const opponent = other(seat);
  const cost = to - state.committed[seat];
  return {
    ...state,
    actor: opponent,
    pot: state.pot + cost,
    stacks: bySeat(seat, state.stacks[seat] - cost, state.stacks[opponent]),
    committed: bySeat(seat, to, state.committed[opponent]),
  };
}

function closeBetting(state: HoldemReplayState): HoldemReplayState {
  return { ...state, actor: null, phase: state.street === 'river' ? 'showdown' : 'awaiting-board' };
}

function deal(state: HoldemReplayState, cards: readonly Card[]): HoldemReplayState {
  if (state.phase !== 'awaiting-board' || state.street === 'river') {
    throw new Error('Wait for the betting round to close before dealing.');
  }
  const street = { preflop: 'flop', flop: 'turn', turn: 'river' } as const;
  const count = state.street === 'preflop' ? 3 : 1;
  if (cards.length !== count) throw new Error('Deal exactly ' + count + ' board card(s).');
  const board = [...state.board, ...cards];
  validateCards([...state.holeCards[0], ...state.holeCards[1], ...board]);

  const next: HoldemReplayState = {
    ...state,
    board,
    street: street[state.street],
    committed: [0, 0],
    minIncrement: state.bigBlind,
    actor: other(state.button),
    phase: 'betting',
  };
  // Equal starting stacks mean a matched all-in leaves both stacks empty.
  return state.stacks[0] === 0 ? closeBetting(next) : next;
}

/** Apply one event without mutating the prior state. Invalid events throw. */
export function applyHoldemEvent(state: HoldemReplayState, event: HoldemEvent): HoldemReplayState {
  if (event.kind === 'deal') return deal(state, event.cards);
  if (state.phase !== 'betting' || state.actor === null) throw new Error('There is no betting action now.');
  const { seat } = event;
  if (seat !== state.actor) throw new Error('Acting out of turn.');
  const opponent = other(seat);
  const wager = state.committed[opponent];
  const faced = wager - state.committed[seat];

  switch (event.kind) {
    case 'fold':
      if (faced === 0) throw new Error('This replay supports folding only when facing a wager.');
      return { ...state, phase: 'folded', actor: null, foldWinner: opponent };
    case 'check':
      if (faced > 0) throw new Error('Cannot check when facing a wager.');
      if (state.street === 'preflop' || seat === state.button) return closeBetting(state);
      return { ...state, actor: opponent };
    case 'call': {
      if (faced === 0) throw new Error('There is no wager to call.');
      const called = commit(state, seat, wager);
      // A limp matches the blind, but the big blind still has an option.
      const limp = state.street === 'preflop' && seat === state.button && wager === state.bigBlind;
      return limp ? called : closeBetting(called);
    }
    case 'bet':
    case 'raise': {
      const expected = wager === 0 ? 'bet' : 'raise';
      if (event.kind !== expected) throw new Error('Use ' + expected + ' at this decision.');
      if (state.stacks[opponent] === 0) throw new Error('Cannot wager against an all-in opponent.');
      const minimum = wager + state.minIncrement;
      const maximum = state.committed[seat] + state.stacks[seat];
      if (!Number.isSafeInteger(event.to) || event.to < minimum || event.to > maximum) {
        throw new Error('Use a full ' + expected + ' between ' + minimum + ' and ' + maximum + ' total street chips.');
      }
      return { ...commit(state, seat, event.to), minIncrement: event.to - wager };
    }
    default:
      throw new Error('Unknown replay event.');
  }
}

export function replayHoldem(config: HoldemReplayConfig, events: readonly HoldemEvent[]): HoldemReplayState {
  return events.reduce(applyHoldemEvent, startHoldemReplay(config));
}

/** Project the current actor's decision into the existing study analyzer. */
export function toHoldemSnapshot(state: HoldemReplayState): Snapshot {
  const seat = state.actor;
  if (seat === null) throw new Error('There is no betting decision to analyze.');
  const opponent = other(seat);
  const snapshot: Snapshot = {
    version: 1,
    ruleset: holdem.id,
    purpose: state.purpose,
    hero: [...state.holeCards[seat]],
    opponent: [...state.holeCards[opponent]],
    board: [...state.board],
    pot: state.pot,
    heroStack: state.stacks[seat],
    opponentStack: state.stacks[opponent],
    committed: state.committed[seat],
    faced: state.committed[opponent] - state.committed[seat],
    increment: state.minIncrement,
  };
  holdem.validate(snapshot);
  return snapshot;
}
