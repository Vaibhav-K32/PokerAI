// Event-driven Texas Hold'em hand reducer. Pure TypeScript with no browser or
// UI dependencies, so the same rules can validate events from manual entry,
// imported histories, or a future recognition pipeline.
import { standardDeck } from '../core/cards.js';
import type { Card } from '../core/types.js';
import { holdem } from '../rules/holdem.js';
import {
  HAND_EVENT_TYPES, HAND_SCHEMA_VERSION, HandRuleError,
  type EventOf, type GameState, type HandEvent, type HandSetup, type PlayerState, type Pot, type Street,
} from './types.js';

const MAX_PLAYERS = 10;
const MAX_CHIPS = 1_000_000_000;
const NEXT_STREET: Record<Street, Street | null> = { preflop: 'flop', flop: 'turn', turn: 'river', river: null };

const fail = (message: string): never => { throw new HandRuleError(message); };
const isChips = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_CHIPS;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Validate a hand setup and build the state before HAND_STARTED. */
export function createHandState(setup: HandSetup): GameState {
  if (typeof setup.handId !== 'string' || !setup.handId) fail('A hand needs an ID.');
  const { players } = setup;
  if (!Array.isArray(players) || players.length < 2 || players.length > MAX_PLAYERS) {
    fail('A hand needs 2 to ' + MAX_PLAYERS + ' players.');
  }
  if (!isChips(setup.smallBlind) || !isChips(setup.bigBlind) || !isChips(setup.ante)) {
    fail('Blinds and ante must be whole chip amounts.');
  }
  if (setup.bigBlind <= 0 || setup.smallBlind <= 0 || setup.smallBlind > setup.bigBlind) {
    fail('Use 0 < small blind ≤ big blind.');
  }
  if (!Number.isSafeInteger(setup.dealer) || setup.dealer < 0 || setup.dealer >= players.length) {
    fail('The dealer must be one of the seats.');
  }
  const ids = new Set<string>();
  const known: Card[] = [];
  const seats: PlayerState[] = players.map((p, seat) => {
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id)) fail('Each player needs a unique ID.');
    ids.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim()) fail('Each player needs a name.');
    if (!isChips(p.stack) || p.stack <= 0) fail(p.name + ' needs a positive whole-chip stack.');
    const cards = p.cards ?? [null, null];
    if (!Array.isArray(cards) || cards.length !== 2) fail(p.name + ' needs two card slots (use null for unknown).');
    for (const card of cards) {
      if (card === null) continue;
      if (!standardDeck.includes(card)) fail('Use valid cards such as As, Td, or 7h.');
      known.push(card);
    }
    return {
      id: p.id, name: p.name, seat, startingStack: p.stack, stack: p.stack, committed: 0, total: 0,
      status: 'active', cards: [...cards], shown: false, hasActed: false, lastActedLevel: 0, won: 0,
    };
  });
  if (new Set(known).size !== known.length) fail('Each card can appear only once.');
  return {
    schemaVersion: HAND_SCHEMA_VERSION,
    handId: setup.handId,
    step: 'start',
    phase: 'preflop',
    street: 'preflop',
    smallBlind: setup.smallBlind,
    bigBlind: setup.bigBlind,
    ante: setup.ante,
    dealer: setup.dealer,
    players: seats,
    board: [],
    currentBet: 0,
    lastFullRaise: setup.bigBlind,
    actor: null,
    pots: [],
    returned: [],
    posted: { antes: [], small: false, big: false },
    eventCount: 0,
    eventIds: [],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const seatAfter = (state: GameState, seat: number, steps = 1) => (seat + steps) % state.players.length;

/** Seat that posts the small blind: the dealer heads-up, otherwise the next seat. */
export function smallBlindSeat(state: GameState): number {
  return state.players.length === 2 ? state.dealer : seatAfter(state, state.dealer);
}

export function bigBlindSeat(state: GameState): number {
  return seatAfter(state, smallBlindSeat(state));
}

/** Chips in the middle that have not been awarded yet. */
export function potTotal(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.total - p.won, 0);
}

/** Every chip at the table; constant through a hand. */
export function chipsInPlay(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.stack, 0) + potTotal(state);
}

/** Cards visible to the record: the board and every known hole card. */
export function knownCards(state: GameState): Card[] {
  return [...state.board, ...state.players.flatMap(p => p.cards.filter((c): c is Card => c !== null))];
}

const live = (state: GameState) => state.players.filter(p => p.status !== 'folded');
const canAct = (p: PlayerState) => p.status === 'active';

/** The next forced post, or null once antes and blinds are in. */
export function nextPost(state: GameState): { type: 'ANTE_POSTED' | 'SMALL_BLIND_POSTED' | 'BIG_BLIND_POSTED'; seat: number; amount: number } | null {
  if (state.ante > 0) {
    // Antes go around from the seat left of the dealer.
    for (let i = 1; i <= state.players.length; i++) {
      const seat = seatAfter(state, state.dealer, i);
      const p = state.players[seat];
      if (!state.posted.antes.includes(p.id) && p.stack > 0) return { type: 'ANTE_POSTED', seat, amount: Math.min(state.ante, p.stack) };
    }
  }
  if (!state.posted.small) {
    const seat = smallBlindSeat(state);
    const amount = Math.min(state.smallBlind, state.players[seat].stack);
    if (amount > 0) return { type: 'SMALL_BLIND_POSTED', seat, amount };
  }
  if (!state.posted.big) {
    const seat = bigBlindSeat(state);
    const amount = Math.min(state.bigBlind, state.players[seat].stack);
    if (amount > 0) return { type: 'BIG_BLIND_POSTED', seat, amount };
  }
  return null;
}

/** May this player raise? Only once action is reopened by a full raise. */
export function canRaise(state: GameState, p: PlayerState): boolean {
  if (!canAct(p) || p.stack + p.committed <= state.currentBet) return false;
  // Someone else must be able to respond.
  if (!state.players.some(o => o.id !== p.id && canAct(o))) return false;
  return !p.hasActed || state.currentBet - p.lastActedLevel >= state.lastFullRaise;
}

export interface ActionOptions {
  readonly playerId: string;
  readonly toCall: number;
  readonly canCheck: boolean;
  /** Chips a call adds (all-in when short). */
  readonly callAmount: number;
  readonly canBet: boolean;
  readonly canRaise: boolean;
  /** Smallest full bet or raise total; a smaller all-in is also allowed. */
  readonly minTo: number;
  /** All-in total. */
  readonly maxTo: number;
}

/** Legal choices for the player to act, or null when no action is due. */
export function actionOptions(state: GameState): ActionOptions | null {
  if (state.step !== 'act' || state.actor === null) return null;
  const p = state.players[state.actor];
  const toCall = state.currentBet - p.committed;
  const maxTo = p.committed + p.stack;
  const opening = state.currentBet === 0;
  const raise = !opening && canRaise(state, p);
  const bet = opening && state.players.some(o => o.id !== p.id && canAct(o));
  return {
    playerId: p.id,
    toCall,
    canCheck: toCall === 0,
    callAmount: Math.min(toCall, p.stack),
    canBet: bet,
    canRaise: raise,
    minTo: Math.min(maxTo, opening ? state.bigBlind : state.currentBet + state.lastFullRaise),
    maxTo,
  };
}

// ---------------------------------------------------------------------------
// Pots and settlement
// ---------------------------------------------------------------------------

/**
 * Split everything put in this hand into a main pot and side pots by each
 * live player's total. Folded chips count toward the pots up to their level;
 * anything above the deepest live player's total joins the last pot.
 */
export function buildPots(state: GameState): Pot[] {
  const contenders = live(state);
  const levels = [...new Set(contenders.map(p => p.total))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    const amount = state.players.reduce((sum, p) => sum + Math.max(0, Math.min(p.total, level) - previous), 0);
    const eligible = contenders.filter(p => p.total >= level).map(p => p.id);
    previous = level;
    if (amount === 0) continue;
    const last = pots.at(-1);
    // Merge layers with the same eligible players.
    if (last && last.eligible.join() === eligible.join()) pots[pots.length - 1] = { ...last, amount: last.amount + amount };
    else pots.push({ amount, eligible, awards: null });
  }
  const extra = state.players.reduce((sum, p) => sum + Math.max(0, p.total - previous), 0);
  if (extra > 0 && pots.length) pots[pots.length - 1] = { ...pots[pots.length - 1], amount: pots[pots.length - 1].amount + extra };
  return pots;
}

/**
 * Split a pot evenly among winners. Odd chips go one at a time to winners in
 * seat order starting left of the dealer.
 */
export function splitPot(state: GameState, amount: number, winners: readonly string[]): { playerId: string; amount: number }[] {
  const order = [...winners].sort((a, b) => leftOfDealer(state, a) - leftOfDealer(state, b));
  const share = Math.floor(amount / order.length);
  let odd = amount - share * order.length;
  return order.map(playerId => ({ playerId, amount: share + (odd-- > 0 ? 1 : 0) }));
}

function leftOfDealer(state: GameState, playerId: string): number {
  const seat = state.players.findIndex(p => p.id === playerId);
  return (seat - state.dealer - 1 + state.players.length) % state.players.length;
}

/**
 * Winners of a pot when they can be determined: a single eligible player, or
 * every eligible hand known on a complete board. Returns null otherwise.
 */
export function potWinners(state: GameState, pot: Pot): string[] | null {
  if (pot.eligible.length === 1) return [...pot.eligible];
  if (state.board.length !== 5) return null;
  const hands = pot.eligible.map(id => state.players.find(p => p.id === id)!);
  if (hands.some(p => p.cards.some(c => c === null))) return null;
  const scores = hands.map(p => holdem.score!(p.cards as Card[], state.board));
  const best = Math.max(...scores);
  return hands.filter((_, i) => scores[i] === best).map(p => p.id);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Draft = { -readonly [K in keyof GameState]: K extends 'players' ? PlayerState[] : GameState[K] };
type PlayerDraft = { -readonly [K in keyof PlayerState]: PlayerState[K] };

function playerIndex(state: GameState, playerId: unknown): number {
  const index = state.players.findIndex(p => p.id === playerId);
  if (index < 0) fail('Unknown player: ' + String(playerId) + '.');
  return index;
}

function validCards(cards: unknown, count: number, label: string): Card[] {
  if (!Array.isArray(cards) || cards.length !== count) fail(label + ' needs exactly ' + count + ' card' + (count === 1 ? '' : 's') + '.');
  for (const card of cards as unknown[]) {
    if (typeof card !== 'string' || !standardDeck.includes(card)) fail('Use valid cards such as As, Td, or 7h.');
  }
  return [...cards as Card[]];
}

function assertUnseen(state: GameState, cards: readonly Card[]) {
  const seen = new Set(knownCards(state));
  for (const card of cards) if (seen.has(card)) fail('Each card can appear only once: ' + card + ' is already in the hand.');
  if (new Set(cards).size !== cards.length) fail('Each card can appear only once.');
}

/** Move chips from a player's stack into the pot. */
function put(player: PlayerDraft, chips: number, street = true) {
  player.stack -= chips;
  player.total += chips;
  if (street) player.committed += chips;
  if (player.stack === 0) player.status = 'all-in';
}

/** Find the next player who must act after `from`, or null when betting is closed. */
function nextActor(state: Draft, from: number): number | null {
  const able = state.players.filter(canAct);
  if (live(state).length <= 1) return null;
  // One player left with chips who has already matched the bet: nothing to do.
  if (able.length === 0) return null;
  if (able.length === 1 && able[0].committed >= state.currentBet) return null;
  for (let i = 1; i <= state.players.length; i++) {
    const seat = seatAfter(state, from, i);
    const p = state.players[seat];
    if (canAct(p) && (!p.hasActed || p.committed < state.currentBet)) return seat;
  }
  return null;
}

/** Return any uncalled part of the top bet on this street. */
function returnUncalled(state: Draft) {
  const commits = state.players.map(p => p.committed).sort((a, b) => b - a);
  const excess = commits[0] - (commits[1] ?? 0);
  if (excess <= 0) return;
  const top = state.players.findIndex(p => p.committed === commits[0]);
  const p = { ...state.players[top] };
  p.committed -= excess;
  p.total -= excess;
  p.stack += excess;
  if (p.status === 'all-in' && p.stack > 0) p.status = 'active';
  state.players[top] = p;
  state.returned = [...state.returned, { playerId: p.id, amount: excess, street: state.street }];
}

/** Betting on this street is over: settle, then move to the next step. */
function closeBetting(state: Draft) {
  returnUncalled(state);
  state.players = state.players.map(p => ({ ...p, committed: 0, hasActed: false, lastActedLevel: 0 }));
  state.currentBet = 0;
  state.lastFullRaise = state.bigBlind;
  state.actor = null;
  if (live(state).length === 1) {
    state.pots = buildPots(state);
    state.step = 'award';
    return;
  }
  if (NEXT_STREET[state.street] === null) {
    state.step = 'showdown';
    return;
  }
  state.step = 'deal';
}

/** Start betting on a street, or skip it when fewer than two players can bet. */
function openBetting(state: Draft, first: number) {
  state.step = 'act';
  state.actor = nextActor(state, first - 1 + state.players.length);
  if (state.actor === null) closeBetting(state);
}

function applyWager(state: Draft, seat: number, to: number) {
  const p = { ...state.players[seat] } as PlayerDraft;
  put(p, to - p.committed);
  if (to > state.currentBet) {
    const increment = to - state.currentBet;
    const full = state.currentBet === 0 ? to >= state.bigBlind : increment >= state.lastFullRaise;
    if (full) state.lastFullRaise = state.currentBet === 0 ? to : increment;
    state.currentBet = to;
  }
  p.hasActed = true;
  p.lastActedLevel = state.currentBet;
  state.players[seat] = p;
}

function afterAction(state: Draft, seat: number) {
  if (live(state).length === 1) {
    closeBetting(state);
    return;
  }
  const next = nextActor(state, seat);
  if (next === null) closeBetting(state);
  else state.actor = next;
}

function checkEnvelope(state: GameState, event: HandEvent) {
  if (!event || typeof event !== 'object') fail('An event must be an object.');
  if (event.schemaVersion !== HAND_SCHEMA_VERSION) fail('Unsupported event schema version: ' + String(event.schemaVersion) + '.');
  if (!(HAND_EVENT_TYPES as readonly string[]).includes(event.type)) fail('Unknown event type: ' + String(event.type) + '.');
  if (typeof event.id !== 'string' || !event.id) fail('Each event needs an ID.');
  if (state.eventIds.includes(event.id)) fail('Duplicate event ID: ' + event.id + '.');
  if (event.handId !== state.handId) fail('This event belongs to another hand.');
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) fail('Each event needs an ISO timestamp.');
  if (!event.payload || typeof event.payload !== 'object') fail('Each event needs a payload.');
}

function expectStep(state: GameState, ...steps: GameState['step'][]) {
  if (!steps.includes(state.step)) {
    const wanted: Record<GameState['step'], string> = {
      start: 'the hand to start', post: 'antes and blinds', act: 'a player action', deal: 'the next street to be dealt',
      showdown: 'the showdown', reveal: 'reveals or pot awards', award: 'the pot to be awarded', done: 'the hand to complete',
      complete: 'nothing (the hand is complete)', cancelled: 'nothing (the hand was cancelled)',
    };
    fail('Out of order: expected ' + wanted[state.step] + '.');
  }
}

function expectActor(state: GameState, playerId: unknown): number {
  const seat = playerIndex(state, playerId);
  if (seat !== state.actor) {
    const p = state.players[seat];
    fail(p.status === 'folded' ? p.name + ' has folded.' : p.status === 'all-in' ? p.name + ' is all-in.'
      : 'Out of turn: ' + state.players[state.actor!].name + ' is to act.');
  }
  return seat;
}

/**
 * Apply one event and return the next state. Never mutates `state`; throws a
 * HandRuleError, leaving `state` intact, when the event is not legal.
 */
export function applyHandEvent(state: GameState, event: HandEvent): GameState {
  checkEnvelope(state, event);
  const next: Draft = {
    ...state,
    players: [...state.players],
    eventCount: state.eventCount + 1,
    eventIds: [...state.eventIds, event.id],
  };

  switch (event.type) {
    case 'HAND_STARTED':
      expectStep(state, 'start');
      next.step = 'post';
      if (!nextPost(next)) openBetting(next, seatAfter(next, bigBlindSeat(next)));
      return next;

    case 'ANTE_POSTED':
    case 'SMALL_BLIND_POSTED':
    case 'BIG_BLIND_POSTED': {
      expectStep(state, 'post');
      const due = nextPost(state)!;
      const seat = playerIndex(state, event.payload.playerId);
      if (due.type !== event.type) fail('Out of order: post the ' + label(due.type) + ' first.');
      if (seat !== due.seat) fail(state.players[due.seat].name + ' posts the ' + label(due.type) + '.');
      if (event.payload.amount !== due.amount) fail('The ' + label(due.type) + ' is ' + due.amount + ' chips.');
      const p = { ...next.players[seat] } as PlayerDraft;
      put(p, due.amount, event.type !== 'ANTE_POSTED');
      next.players[seat] = p;
      next.posted = {
        antes: event.type === 'ANTE_POSTED' ? [...state.posted.antes, p.id] : state.posted.antes,
        small: state.posted.small || event.type === 'SMALL_BLIND_POSTED',
        big: state.posted.big || event.type === 'BIG_BLIND_POSTED',
      };
      if (!nextPost(next)) {
        // The big blind sets the price even when it is posted short.
        next.currentBet = next.bigBlind;
        next.lastFullRaise = next.bigBlind;
        next.posted = { ...next.posted, small: true, big: true };
        openBetting(next, seatAfter(next, bigBlindSeat(next)));
      }
      return next;
    }

    case 'PLAYER_FOLDED': {
      expectStep(state, 'act');
      const seat = expectActor(state, event.payload.playerId);
      next.players[seat] = { ...next.players[seat], status: 'folded', hasActed: true, lastActedLevel: state.currentBet };
      afterAction(next, seat);
      return next;
    }

    case 'PLAYER_CHECKED': {
      expectStep(state, 'act');
      const seat = expectActor(state, event.payload.playerId);
      const p = state.players[seat];
      if (p.committed < state.currentBet) fail('Cannot check facing a bet of ' + (state.currentBet - p.committed) + ' chips.');
      next.players[seat] = { ...p, hasActed: true, lastActedLevel: state.currentBet };
      afterAction(next, seat);
      return next;
    }

    case 'PLAYER_CALLED': {
      expectStep(state, 'act');
      const seat = expectActor(state, event.payload.playerId);
      const p = state.players[seat];
      const owed = Math.min(state.currentBet - p.committed, p.stack);
      if (owed <= 0) fail('There is nothing to call; check instead.');
      if (event.payload.amount !== owed) fail('A call adds ' + owed + ' chips.');
      applyWager(next, seat, p.committed + owed);
      afterAction(next, seat);
      return next;
    }

    case 'PLAYER_BET':
    case 'PLAYER_RAISED':
    case 'PLAYER_ALL_IN': {
      expectStep(state, 'act');
      const seat = expectActor(state, event.payload.playerId);
      const p = state.players[seat];
      const maxTo = p.committed + p.stack;
      let to: number;
      if (event.type === 'PLAYER_ALL_IN') {
        if (event.payload.amount !== p.stack) fail('All-in adds the whole stack: ' + p.stack + ' chips.');
        to = maxTo;
      } else {
        to = event.payload.to;
        if (!isChips(to)) fail('Use a whole-chip total.');
        if (to > maxTo) fail(p.name + ' has only ' + maxTo + ' chips to commit on this street.');
      }
      const opening = state.currentBet === 0;
      if (event.type === 'PLAYER_BET' && !opening) fail('There is already a bet; raise instead.');
      if (event.type === 'PLAYER_RAISED' && opening) fail('There is no bet to raise; bet instead.');
      if (to > state.currentBet) {
        if (!state.players.some(o => o.id !== p.id && canAct(o))) fail('No one is left to respond; call instead.');
        if (!opening && !canRaise(state, p)) fail('Betting was not reopened for ' + p.name + '; only call or fold.');
        const minTo = opening ? state.bigBlind : state.currentBet + state.lastFullRaise;
        if (to < minTo && to !== maxTo) {
          fail('A full ' + (opening ? 'bet' : 'raise') + ' is at least ' + minTo + ' chips; less is allowed only all-in.');
        }
      } else if (event.type !== 'PLAYER_ALL_IN') {
        fail((opening ? 'A bet' : 'A raise') + ' must go above ' + state.currentBet + ' chips.');
      }
      applyWager(next, seat, to);
      afterAction(next, seat);
      return next;
    }

    case 'FLOP_DEALT':
    case 'TURN_DEALT':
    case 'RIVER_DEALT': {
      expectStep(state, 'deal');
      const street = NEXT_STREET[state.street]!;
      const wanted = street === 'flop' ? 'FLOP_DEALT' : street === 'turn' ? 'TURN_DEALT' : 'RIVER_DEALT';
      if (event.type !== wanted) fail('Out of order: deal the ' + street + ' next.');
      const cards = event.type === 'FLOP_DEALT'
        ? validCards(event.payload.cards, 3, 'The flop')
        : validCards([event.payload.card], 1, 'The ' + street);
      assertUnseen(state, cards);
      next.board = [...state.board, ...cards];
      next.street = street;
      next.phase = street;
      openBetting(next, seatAfter(next, next.dealer));
      return next;
    }

    case 'SHOWDOWN_STARTED':
      expectStep(state, 'showdown');
      next.step = 'reveal';
      next.phase = 'showdown';
      next.pots = buildPots(next);
      return next;

    case 'PLAYER_CARDS_REVEALED': {
      expectStep(state, 'reveal');
      const seat = playerIndex(state, event.payload.playerId);
      const p = state.players[seat];
      if (p.status === 'folded') fail(p.name + ' folded and has no cards to show.');
      const cards = validCards(event.payload.cards, 2, 'A reveal');
      for (const known of p.cards) {
        if (known !== null && !cards.includes(known)) fail(p.name + '’s recorded card ' + known + ' does not match the reveal.');
      }
      const others = { ...state, players: state.players.map((o, i) => (i === seat ? { ...o, cards: [null, null] } : o)) };
      assertUnseen(others, cards);
      next.players[seat] = { ...p, cards, shown: true };
      return next;
    }

    case 'POT_AWARDED': {
      expectStep(state, 'reveal', 'award');
      const { potIndex, awards } = event.payload;
      const pot = state.pots[potIndex];
      if (!Number.isSafeInteger(potIndex) || !pot) fail('No pot ' + String(potIndex) + '.');
      if (pot.awards) fail('Pot ' + potIndex + ' was already awarded.');
      if (!Array.isArray(awards) || !awards.length) fail('Award the pot to at least one player.');
      const ids = awards.map(a => a.playerId);
      if (new Set(ids).size !== ids.length) fail('List each winner once.');
      for (const a of awards) {
        if (!pot.eligible.includes(a.playerId)) fail(nameOf(state, a.playerId) + ' cannot win pot ' + potIndex + '.');
        if (!isChips(a.amount)) fail('Award whole chips.');
      }
      if (awards.reduce((sum, a) => sum + a.amount, 0) !== pot.amount) fail('Pot ' + potIndex + ' holds ' + pot.amount + ' chips.');
      const known = potWinners(state, pot);
      if (known && [...known].sort().join() !== [...ids].sort().join()) {
        fail('Pot ' + potIndex + ' goes to ' + known.map(id => nameOf(state, id)).join(' and ') + '.');
      }
      const expected = splitPot(state, pot.amount, ids);
      for (const a of awards) {
        const share = expected.find(e => e.playerId === a.playerId)!.amount;
        if (a.amount !== share) fail(nameOf(state, a.playerId) + ' gets ' + share + ' chips (odd chips go left of the dealer).');
      }
      awards.forEach(a => {
        const seat = playerIndex(state, a.playerId);
        next.players[seat] = { ...next.players[seat], stack: next.players[seat].stack + a.amount, won: next.players[seat].won + a.amount };
      });
      next.pots = state.pots.map((p, i) => (i === potIndex ? { ...p, awards: awards.map(a => ({ ...a })) } : p));
      if (next.pots.every(p => p.awards)) next.step = 'done';
      return next;
    }

    case 'HAND_COMPLETED':
      expectStep(state, 'done');
      next.step = 'complete';
      next.phase = 'complete';
      return next;

    case 'HAND_CANCELLED': {
      if (state.step === 'complete' || state.step === 'cancelled') fail('The hand is already over.');
      if (state.pots.some(p => p.awards)) fail('A hand cannot be cancelled after a pot was awarded.');
      // Everyone gets back what they put in.
      next.players = state.players.map(p => ({ ...p, stack: p.stack + p.total, total: 0, committed: 0 }));
      next.step = 'cancelled';
      next.phase = 'cancelled';
      next.actor = null;
      next.currentBet = 0;
      next.pots = [];
      return next;
    }
  }
  return fail('Unknown event type.');
}

function label(type: 'ANTE_POSTED' | 'SMALL_BLIND_POSTED' | 'BIG_BLIND_POSTED') {
  return type === 'ANTE_POSTED' ? 'ante' : type === 'SMALL_BLIND_POSTED' ? 'small blind' : 'big blind';
}

function nameOf(state: GameState, playerId: string) {
  return state.players.find(p => p.id === playerId)?.name ?? playerId;
}

/**
 * Rebuild the state after a list of events. Deterministic: the same inputs
 * always give the same state. Errors name the failing event's position.
 */
export function replayHand(initial: GameState, events: readonly HandEvent[]): GameState {
  return events.reduce((state, event, index) => {
    try {
      return applyHandEvent(state, event);
    } catch (error) {
      if (error instanceof HandRuleError) throw new HandRuleError('Event ' + (index + 1) + ' (' + event?.type + '): ' + error.message, index);
      throw error;
    }
  }, initial);
}

/** Every state from the start through each event: states[i] follows i events. */
export function replaySteps(initial: GameState, events: readonly HandEvent[]): GameState[] {
  const states = [initial];
  for (const event of events) states.push(applyHandEvent(states.at(-1)!, event));
  return states;
}
