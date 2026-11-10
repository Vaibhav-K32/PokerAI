// Checking actions the user enters for an interval. The earlier screenshot
// becomes a checkpoint state, and each action goes through the hand history
// engine's own reducer, so the betting rules are not relaxed. The result says
// how much of the observed change the actions explain; the rest stays unknown.
import { applyHandEvent } from '../history/engine.js';
import { HAND_SCHEMA_VERSION, HandRuleError, type GameState, type HandEvent, type PlayerState } from '../history/types.js';
import type { ScreenshotRecognition } from '../vision/screenshot.js';
import { alignSeats } from './compare.js';
import { middleChips, possessive, seatName, subjectVerb } from './observation.js';
import type { ActionCheck, HandObservation, ManualAction, ManualActionType } from './types.js';

export const ACTION_LABELS: Record<ManualActionType, string> = {
  fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet to', raise: 'Raise to', 'all-in': 'All-in',
};

/**
 * The betting state shown in one screenshot, for checking actions. Needs every
 * live seat's stack and bet. What a screenshot cannot show is set to the most
 * permissive legal value: nobody has acted yet on the street, and the last
 * raise size is the big blind (or 1 chip when the blind is unknown). Earlier
 * streets' contributions are not known, so pots are not built from it.
 */
export function checkpointState(observation: HandObservation): GameState | { error: string } {
  const rec = observation.recognition;
  if (rec.players.length < 2) return { error: 'The screenshot needs at least two seats.' };
  for (let i = 0; i < rec.players.length; i++) {
    const p = rec.players[i];
    if (p.status.value === null) return { error: 'Mark whether ' + seatName(rec, i) + ' is in the hand in screenshot ' + (observation.sequenceIndex + 1) + '.' };
    if (p.status.value === 'folded') continue;
    if (p.stack.value === null || p.bet.value === null) {
      return { error: 'Enter ' + possessive(seatName(rec, i)).replace(/^Your$/, 'your') + ' stack and bet in screenshot ' + (observation.sequenceIndex + 1) + ' to check actions.' };
    }
  }
  const board = rec.communityCards.map(c => c.value);
  const street = rec.street.value ?? (['preflop', null, null, 'flop', 'turn', 'river'] as const)[board.length] ?? null;
  if (!street) return { error: 'The street of screenshot ' + (observation.sequenceIndex + 1) + ' is unknown.' };
  const bigBlind = rec.bigBlind.value && rec.bigBlind.value > 0 ? rec.bigBlind.value : 1;
  const players: PlayerState[] = rec.players.map((p, i) => {
    const stack = p.stack.value ?? 0;
    const bet = p.bet.value ?? 0;
    const folded = p.status.value === 'folded';
    return {
      id: 'seat-' + (i + 1), name: seatName(rec, i), seat: i,
      startingStack: stack + bet, stack, committed: bet, total: bet,
      status: folded ? 'folded' : stack === 0 ? 'all-in' : 'active',
      cards: p.cards.length === 2 ? p.cards.map(c => c.value) : [null, null],
      shown: false, hasActed: false, lastActedLevel: 0, won: 0,
    };
  });
  return {
    schemaVersion: HAND_SCHEMA_VERSION,
    handId: 'recon-' + observation.id,
    step: 'act',
    phase: street,
    street,
    smallBlind: Math.min(rec.smallBlind.value && rec.smallBlind.value > 0 ? rec.smallBlind.value : 1, bigBlind),
    bigBlind,
    ante: 0,
    dealer: rec.dealerSeat.value ?? 0,
    players,
    board: board.every(c => c !== null) ? board as string[] : [],
    currentBet: Math.max(0, ...players.filter(p => p.status !== 'folded').map(p => p.committed)),
    lastFullRaise: bigBlind,
    actor: null,
    pots: [],
    returned: [],
    posted: { antes: players.map(p => p.id), small: true, big: true },
    eventCount: 0,
    eventIds: [],
  };
}

function event(state: GameState, id: string, timestamp: string, type: HandEvent['type'], payload: unknown): HandEvent {
  return { schemaVersion: HAND_SCHEMA_VERSION, id, type, timestamp, handId: state.handId, payload } as HandEvent;
}

/** The deal event for the next street, using only board cards the later screenshot shows. */
function dealFrom(state: GameState, next: ScreenshotRecognition, id: string, timestamp: string): HandEvent | string {
  const board = next.communityCards.map(c => c.value);
  if (state.street === 'preflop') {
    if (board.length < 3 || board.slice(0, 3).some(c => c === null)) return 'The betting round closed, but the flop is not known from the later screenshot.';
    return event(state, id, timestamp, 'FLOP_DEALT', { cards: board.slice(0, 3) });
  }
  const index = state.street === 'flop' ? 3 : 4;
  if (state.board.length !== index) return 'The board in the earlier screenshot is incomplete, so the next card cannot be dealt.';
  const card = board[index];
  if (!card) return 'The betting round closed, but the next board card is not known from the later screenshot.';
  return event(state, id, timestamp, index === 3 ? 'TURN_DEALT' : 'RIVER_DEALT', { card });
}

/**
 * Apply the user's actions for an interval through the hand engine. The actor
 * is set to each action's seat, because the screenshots do not show whose
 * turn it was; amounts, stacks, and raise sizes are checked by the reducer.
 * When an action closes the betting round and the later screenshot shows the
 * next street's cards, that observed deal is applied before the next action.
 */
export function checkActions(previous: HandObservation, next: HandObservation, actions: readonly ManualAction[]): ActionCheck {
  const start = checkpointState(previous);
  const fail = (actionId: string, message: string, states: GameState[] = [], events: HandEvent[] = []): ActionCheck =>
    ({ events, states, error: { actionId, message }, unexplained: [], explains: false });
  if ('error' in start) return actions.length ? fail(actions[0].id, start.error) : { events: [], states: [], error: null, unexplained: [], explains: false };

  const states: GameState[] = [start];
  const events: HandEvent[] = [];
  let state = start;
  for (const action of actions) {
    if (state.step === 'deal') {
      const deal = dealFrom(state, next.recognition, action.id + '-deal', action.confirmedAt);
      if (typeof deal === 'string') return fail(action.id, deal, states, events);
      try {
        state = applyHandEvent(state, deal);
      } catch (error) {
        return fail(action.id, error instanceof Error ? error.message : 'The deal is not valid.', states, events);
      }
      events.push(deal);
      states.push(state);
    }
    if (state.step !== 'act') return fail(action.id, 'Betting is already over at this point, so no more actions fit.', states, events);
    const p = state.players[action.seat];
    if (!p) return fail(action.id, 'That seat is not at this table.', states, events);
    if (p.status !== 'active') return fail(action.id, p.name + (p.status === 'folded' ? ' has folded.' : ' is all-in.'), states, events);
    const turn: GameState = { ...state, actor: action.seat };
    const owed = Math.min(turn.currentBet - p.committed, p.stack);
    const payloads: Record<ManualActionType, [HandEvent['type'], unknown]> = {
      fold: ['PLAYER_FOLDED', { playerId: p.id }],
      check: ['PLAYER_CHECKED', { playerId: p.id }],
      call: ['PLAYER_CALLED', { playerId: p.id, amount: owed }],
      bet: ['PLAYER_BET', { playerId: p.id, to: action.to }],
      raise: ['PLAYER_RAISED', { playerId: p.id, to: action.to }],
      'all-in': ['PLAYER_ALL_IN', { playerId: p.id, amount: p.stack }],
    };
    const [type, payload] = payloads[action.type];
    const made = event(turn, action.id, action.confirmedAt, type, payload);
    try {
      state = applyHandEvent(turn, made);
    } catch (error) {
      if (error instanceof HandRuleError) return fail(action.id, error.message, states, events);
      throw error;
    }
    events.push(made);
    states.push(state);
  }
  const { unexplained, conflicts } = remaining(previous.recognition, next.recognition, start, state);
  if (conflicts.length && actions.length) {
    return { events, states, error: { actionId: actions[actions.length - 1].id, message: conflicts.join(' ') }, unexplained, explains: false };
  }
  return { events, states, error: null, unexplained, explains: actions.length > 0 && unexplained.length === 0 };
}

/** What the confirmed actions leave unexplained, and anything they contradict. */
function remaining(prev: ScreenshotRecognition, next: ScreenshotRecognition, start: GameState, end: GameState) {
  const unexplained: string[] = [];
  const conflicts: string[] = [];
  const rotation = alignSeats(prev, next);
  if (rotation === null) return { unexplained: ['The seats do not line up, so the actions cannot be compared.'], conflicts };
  const n = prev.players.length;
  let put = 0;
  for (let k = 0; k < n; k++) {
    const i = (k + rotation) % n;
    const before = start.players[i];
    const after = end.players[i];
    put += before.stack - after.stack;
    const seen = next.players[k];
    if (before.status === 'folded') continue;
    if (seen.stack.value !== null) {
      if (after.stack > seen.stack.value) unexplained.push(subjectVerb(after.name, 'put').replace(/puts$/, 'put') + ' in ' + (after.stack - seen.stack.value) + ' more chips than the confirmed actions show.');
      if (after.stack < seen.stack.value) unexplained.push((after.name.toLowerCase() === 'you' ? 'You have ' : after.name + ' has ') + (seen.stack.value - after.stack) + ' more chips than the confirmed actions leave (a pot award or returned bet?).');
    } else {
      unexplained.push(possessive(after.name) + ' later stack is unknown.');
    }
    if (seen.status.value === 'folded' && after.status !== 'folded') unexplained.push(after.name + ' folded, which is not entered.');
    if (seen.status.value === 'active' && after.status === 'folded') conflicts.push(after.name + (after.name.toLowerCase() === 'you' ? ' are entered as folded but are' : ' is entered as folded but is') + ' still in the hand in the later screenshot.');
  }
  const before = middleChips(prev);
  const after = middleChips(next);
  if (before !== null && after !== null && before + put !== after) {
    unexplained.push('The middle has ' + (after - before - put) + ' chips the confirmed actions do not account for.');
  } else if (before === null || after === null) {
    unexplained.push('The pot or a bet is unknown, so the middle cannot be checked.');
  }
  return { unexplained, conflicts };
}
