// Predefined hands with fictional players and simulated chips: the demo the
// replay view loads, plus fixtures for tests. Every hand is built through the
// rules engine, so an illegal step fails loudly here.
import { applyHandEvent, createHandState } from './engine.js';
import { buildEvents, createHistory, eventFactory, settlementSpecs, type EventSpec, type HandHistory } from './history.js';
import type { HandSetup } from './types.js';

function finish(setup: HandSetup, specs: EventSpec[], name: string, createdAt: string): HandHistory {
  const make = eventFactory(setup.handId, createdAt);
  const events = buildEvents(setup, specs, make);
  let state = createHandState(setup);
  for (const event of events) state = applyHandEvent(state, event);
  const rest = buildEvents(setup, [...specs, ...settlementSpecs(state)], eventFactory(setup.handId, createdAt)).slice(events.length);
  return createHistory(setup, [...events, ...rest], { name, createdAt });
}

/**
 * Four-handed demo with blinds 5/10: preflop raise and calls, a flop bet, a
 * turn bet and call, a checked river, and a showdown won by a set of kings.
 * Two players' cards stay unknown.
 */
export function demoHand(): HandHistory {
  const setup: HandSetup = {
    handId: 'demo-4max', smallBlind: 5, bigBlind: 10, ante: 0, dealer: 0,
    players: [
      { id: 'avery', name: 'Avery', stack: 1000, cards: ['Ks', 'Kc'] },
      { id: 'blake', name: 'Blake', stack: 1000, cards: [null, null] },
      { id: 'casey', name: 'Casey', stack: 1000, cards: [null, null] },
      { id: 'devon', name: 'Devon', stack: 1000, cards: ['Ah', 'Jd'] },
    ],
  };
  return finish(setup, [
    ['HAND_STARTED', {}],
    ['SMALL_BLIND_POSTED', { playerId: 'blake', amount: 5 }],
    ['BIG_BLIND_POSTED', { playerId: 'casey', amount: 10 }],
    ['PLAYER_RAISED', { playerId: 'devon', to: 30 }],
    ['PLAYER_CALLED', { playerId: 'avery', amount: 30 }],
    ['PLAYER_FOLDED', { playerId: 'blake' }],
    ['PLAYER_CALLED', { playerId: 'casey', amount: 20 }],
    ['FLOP_DEALT', { cards: ['As', 'Kd', '7h'] }],
    ['PLAYER_CHECKED', { playerId: 'casey' }],
    ['PLAYER_BET', { playerId: 'devon', to: 40 }],
    ['PLAYER_CALLED', { playerId: 'avery', amount: 40 }],
    ['PLAYER_FOLDED', { playerId: 'casey' }],
    ['TURN_DEALT', { card: '2c' }],
    ['PLAYER_CHECKED', { playerId: 'devon' }],
    ['PLAYER_BET', { playerId: 'avery', to: 90 }],
    ['PLAYER_CALLED', { playerId: 'devon', amount: 90 }],
    ['RIVER_DEALT', { card: '9s' }],
    ['PLAYER_CHECKED', { playerId: 'devon' }],
    ['PLAYER_CHECKED', { playerId: 'avery' }],
  ], 'Demo: four-handed showdown', '2026-01-01T12:00:00.000Z');
}

/**
 * Heads-up, blinds 1/2: the button (small blind) opens, the big blind
 * three-bets, the button calls, then folds to a flop bet. The uncalled flop
 * bet goes back.
 */
export function headsUpFixture(): HandHistory {
  const setup: HandSetup = {
    handId: 'fixture-heads-up', smallBlind: 1, bigBlind: 2, ante: 0, dealer: 0,
    players: [
      { id: 'bo', name: 'Bo', stack: 200 },
      { id: 'ann', name: 'Ann', stack: 200 },
    ],
  };
  return finish(setup, [
    ['HAND_STARTED', {}],
    ['SMALL_BLIND_POSTED', { playerId: 'bo', amount: 1 }],
    ['BIG_BLIND_POSTED', { playerId: 'ann', amount: 2 }],
    ['PLAYER_RAISED', { playerId: 'bo', to: 6 }],
    ['PLAYER_RAISED', { playerId: 'ann', to: 18 }],
    ['PLAYER_CALLED', { playerId: 'bo', amount: 12 }],
    ['FLOP_DEALT', { cards: ['8c', '8d', '3s'] }],
    ['PLAYER_BET', { playerId: 'ann', to: 20 }],
    ['PLAYER_FOLDED', { playerId: 'bo' }],
  ], 'Fixture: heads-up fold on the flop', '2026-01-02T12:00:00.000Z');
}

/**
 * Four players, ante 1, blinds 5/10, uneven stacks. A short all-in raise does
 * not reopen betting; a full all-in raise does. Three pots form: the main pot
 * (all four), a side pot (three), and a flop side pot (two). The river bet is
 * uncalled and returned.
 */
export function sidePotFixture(): HandHistory {
  const setup: HandSetup = {
    handId: 'fixture-side-pots', smallBlind: 5, bigBlind: 10, ante: 1, dealer: 0,
    players: [
      { id: 'p1', name: 'Pat', stack: 500, cards: ['Qc', 'Jc'] },
      { id: 'p2', name: 'Riley', stack: 60, cards: ['As', 'Ad'] },
      { id: 'p3', name: 'Sam', stack: 150, cards: ['Kh', 'Kd'] },
      { id: 'p4', name: 'Tess', stack: 300, cards: [null, null] },
    ],
  };
  return finish(setup, [
    ['HAND_STARTED', {}],
    ['ANTE_POSTED', { playerId: 'p2', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'p3', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'p4', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'p1', amount: 1 }],
    ['SMALL_BLIND_POSTED', { playerId: 'p2', amount: 5 }],
    ['BIG_BLIND_POSTED', { playerId: 'p3', amount: 10 }],
    ['PLAYER_RAISED', { playerId: 'p4', to: 40 }],
    ['PLAYER_CALLED', { playerId: 'p1', amount: 40 }],
    ['PLAYER_ALL_IN', { playerId: 'p2', amount: 54 }],
    ['PLAYER_ALL_IN', { playerId: 'p3', amount: 139 }],
    ['PLAYER_CALLED', { playerId: 'p4', amount: 109 }],
    ['PLAYER_CALLED', { playerId: 'p1', amount: 109 }],
    ['FLOP_DEALT', { cards: ['2c', '7d', '9h'] }],
    ['PLAYER_BET', { playerId: 'p4', to: 50 }],
    ['PLAYER_CALLED', { playerId: 'p1', amount: 50 }],
    ['TURN_DEALT', { card: '3s' }],
    ['PLAYER_CHECKED', { playerId: 'p4' }],
    ['PLAYER_CHECKED', { playerId: 'p1' }],
    ['RIVER_DEALT', { card: '4c' }],
    ['PLAYER_CHECKED', { playerId: 'p4' }],
    ['PLAYER_BET', { playerId: 'p1', to: 100 }],
    ['PLAYER_FOLDED', { playerId: 'p4' }],
  ], 'Fixture: multiway all-in with side pots', '2026-01-03T12:00:00.000Z');
}

/**
 * Three players with ante 1. The board is a royal flush, so the two players
 * left split a 23-chip pot; the odd chip goes to the first winner left of the
 * dealer.
 */
export function splitPotFixture(): HandHistory {
  const setup: HandSetup = {
    handId: 'fixture-split', smallBlind: 5, bigBlind: 10, ante: 1, dealer: 0,
    players: [
      { id: 'd', name: 'Dana', stack: 100, cards: ['2c', '3c'] },
      { id: 's', name: 'Sky', stack: 100, cards: ['4d', '5d'] },
      { id: 'b', name: 'Bea', stack: 100, cards: ['6h', '7h'] },
    ],
  };
  return finish(setup, [
    ['HAND_STARTED', {}],
    ['ANTE_POSTED', { playerId: 's', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'b', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'd', amount: 1 }],
    ['SMALL_BLIND_POSTED', { playerId: 's', amount: 5 }],
    ['BIG_BLIND_POSTED', { playerId: 'b', amount: 10 }],
    ['PLAYER_FOLDED', { playerId: 'd' }],
    ['PLAYER_CALLED', { playerId: 's', amount: 5 }],
    ['PLAYER_CHECKED', { playerId: 'b' }],
    ['FLOP_DEALT', { cards: ['As', 'Ks', 'Qs'] }],
    ['PLAYER_CHECKED', { playerId: 's' }],
    ['PLAYER_CHECKED', { playerId: 'b' }],
    ['TURN_DEALT', { card: 'Js' }],
    ['PLAYER_CHECKED', { playerId: 's' }],
    ['PLAYER_CHECKED', { playerId: 'b' }],
    ['RIVER_DEALT', { card: 'Ts' }],
    ['PLAYER_CHECKED', { playerId: 's' }],
    ['PLAYER_CHECKED', { playerId: 'b' }],
  ], 'Fixture: split pot with an odd chip', '2026-01-04T12:00:00.000Z');
}
