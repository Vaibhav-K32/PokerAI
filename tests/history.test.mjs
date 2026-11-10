// Hand history and replay engine: rules, side pots, settlement, immutability,
// serialization, import validation, navigation, and adapters. Expected chip
// amounts were worked out by hand from each hand's actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import {
  actionOptions, applyHandEvent, chipsInPlay, createHandState, potTotal, replayHand, replaySteps,
} from '../dist/history/engine.js';
import { buildEvents, createHistory, eventFactory, parseHistory, serializeHistory, settlementSpecs } from '../dist/history/history.js';
import { demoHand, headsUpFixture, sidePotFixture, splitPotFixture } from '../dist/history/demo.js';
import { describeEvent } from '../dist/history/describe.js';
import { toAnalysisSnapshot } from '../dist/history/snapshot.js';
import { expectedNext, validateCandidate } from '../dist/history/observation.js';
import { moveCursor, playbackDelay } from '../dist/history/cursor.js';

const fixtures = () => [demoHand(), headsUpFixture(), sidePotFixture(), splitPotFixture()];

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Replay a setup through `specs` and return the final state. */
function play(setup, specs) {
  return replayHand(createHandState(setup), buildEvents(setup, specs));
}

const fourMax = {
  handId: 't4', smallBlind: 5, bigBlind: 10, ante: 0, dealer: 0,
  players: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase(), stack: 1000 })),
};
const blinds4 = [['HAND_STARTED', {}], ['SMALL_BLIND_POSTED', { playerId: 'b', amount: 5 }], ['BIG_BLIND_POSTED', { playerId: 'c', amount: 10 }]];

// ---------------------------------------------------------------------------
// Fixtures and settlement
// ---------------------------------------------------------------------------

test('demo hand: blinds, every street, showdown, and the winner take the 355 pot', () => {
  const hand = demoHand();
  assert.equal(hand.result.status, 'complete');
  assert.deepEqual(hand.finalState.board, ['As', 'Kd', '7h', '2c', '9s']);
  assert.deepEqual(hand.result.pots, [{ amount: 355, eligible: ['avery', 'devon'], awards: [{ playerId: 'avery', amount: 355 }] }]);
  assert.deepEqual(hand.result.net, [
    { playerId: 'avery', amount: 195 }, { playerId: 'blake', amount: -5 },
    { playerId: 'casey', amount: -30 }, { playerId: 'devon', amount: -160 },
  ]);
  assert.deepEqual(hand.result.winners, ['avery']);
  // Unknown cards stay unknown.
  assert.deepEqual(hand.finalState.players[1].cards, [null, null]);
  const types = new Set(hand.events.map(e => e.type));
  for (const type of ['SMALL_BLIND_POSTED', 'BIG_BLIND_POSTED', 'FLOP_DEALT', 'TURN_DEALT', 'RIVER_DEALT', 'SHOWDOWN_STARTED', 'POT_AWARDED', 'HAND_COMPLETED']) {
    assert.ok(types.has(type), type);
  }
});

test('heads-up: the button posts the small blind, acts first preflop and last after the flop', () => {
  const hand = headsUpFixture();
  const states = replaySteps(createHandState(hand.setup), hand.events);
  const afterBlinds = states[3];
  assert.equal(afterBlinds.players[afterBlinds.actor].id, 'bo'); // button first preflop
  const flop = states[hand.events.findIndex(e => e.type === 'FLOP_DEALT') + 1];
  assert.equal(flop.players[flop.actor].id, 'ann'); // big blind first after the flop
  // Bo folds to the flop bet: the uncalled 20 goes back and Ann wins 36.
  assert.deepEqual(hand.finalState.returned, [{ playerId: 'ann', amount: 20, street: 'flop' }]);
  assert.deepEqual(hand.result.pots, [{ amount: 36, eligible: ['ann'], awards: [{ playerId: 'ann', amount: 36 }] }]);
});

test('multiway all-ins build a main pot and two side pots and return the uncalled river bet', () => {
  const hand = sidePotFixture();
  assert.deepEqual(hand.result.pots.map(p => [p.amount, p.eligible, p.awards]), [
    [240, ['p1', 'p2', 'p3'], [{ playerId: 'p2', amount: 240 }]],
    [270, ['p1', 'p3'], [{ playerId: 'p3', amount: 270 }]],
    [100, ['p1'], [{ playerId: 'p1', amount: 100 }]],
  ]);
  assert.deepEqual(hand.finalState.returned, [{ playerId: 'p1', amount: 100, street: 'river' }]);
  assert.deepEqual(hand.result.net.map(n => n.amount), [-100, 180, 120, -200]);
  assert.deepEqual(hand.finalState.players.map(p => p.status), ['active', 'all-in', 'all-in', 'folded']);
});

test('split pots share evenly and the odd chip goes to the first winner left of the dealer', () => {
  const hand = splitPotFixture();
  assert.deepEqual(hand.result.pots, [{ amount: 23, eligible: ['s', 'b'], awards: [{ playerId: 's', amount: 12 }, { playerId: 'b', amount: 11 }] }]);
  // Awarding the odd chip to the wrong player is rejected.
  const before = replayHand(createHandState(hand.setup), hand.events.slice(0, -2));
  const make = eventFactory(hand.setup.handId, '2026-02-01T00:00:00.000Z', 5, 'x1-');
  assert.throws(() => applyHandEvent(before, make('POT_AWARDED', { potIndex: 0, awards: [{ playerId: 's', amount: 11 }, { playerId: 'b', amount: 12 }] })), /odd chips go left of the dealer/);
});

test('chips are conserved after every event of every fixture', () => {
  for (const hand of fixtures()) {
    const total = hand.setup.players.reduce((sum, p) => sum + p.stack, 0);
    const states = replaySteps(createHandState(hand.setup), hand.events);
    states.forEach((state, i) => {
      assert.equal(chipsInPlay(state), total, hand.name + ' after event ' + i);
      assert.ok(state.players.every(p => p.stack >= 0 && p.total >= 0 && p.committed >= 0), hand.name + ' after event ' + i);
    });
    assert.equal(potTotal(states.at(-1)), 0, hand.name + ' ends with an empty pot');
  }
});

// ---------------------------------------------------------------------------
// Determinism, immutability, serialization
// ---------------------------------------------------------------------------

test('replay is deterministic and never mutates its inputs', () => {
  for (const hand of fixtures()) {
    const initial = deepFreeze(createHandState(hand.setup));
    const events = deepFreeze(structuredClone(hand.events));
    const first = replayHand(initial, events);
    assert.deepEqual(replayHand(initial, events), first);
    assert.deepEqual(first, hand.finalState);
    // Intermediate states are untouched by later events.
    const steps = replaySteps(initial, events);
    steps.forEach(deepFreeze);
    assert.deepEqual(replaySteps(initial, events), steps);
  }
});

test('histories round-trip through JSON with unknown cards kept as null', () => {
  for (const hand of fixtures()) {
    const text = serializeHistory(hand);
    const parsed = parseHistory(text);
    assert.deepEqual(parsed, hand);
    assert.equal(serializeHistory(parsed), text);
  }
  assert.match(serializeHistory(demoHand()), /"cards": \[\s*null,\s*null\s*\]/);
});

test('import rejects malformed, foreign, newer, or tampered files', () => {
  const good = JSON.parse(serializeHistory(demoHand()));
  assert.throws(() => parseHistory('{not json'), /not valid JSON/);
  assert.throws(() => parseHistory({ ...good, kind: 'other' }), /not a Poker Study hand history/);
  assert.throws(() => parseHistory({ ...good, schemaVersion: 99 }), /newer schema/);
  assert.throws(() => parseHistory({ ...good, schemaVersion: 0 }), /no valid schema version/);
  assert.throws(() => parseHistory({ ...good, name: '' }), /needs a name/);
  assert.throws(() => parseHistory({ ...good, playerCount: 3 }), /player count/);
  assert.throws(() => parseHistory({ ...good, id: 'other' }), /hand ID/);
  // A stack edited in the stored final state no longer matches the replay.
  const edited = structuredClone(good);
  edited.finalState.players[0].stack += 1;
  assert.throws(() => parseHistory(edited), /final state does not match/);
  // An edited event amount is caught by the rules.
  const cheat = structuredClone(good);
  cheat.events[3].payload.to = 15;
  assert.throws(() => parseHistory(cheat), /Event 4 \(PLAYER_RAISED\): A full raise is at least 20/);
  // A file without the stored state still imports by replaying.
  const { finalState, result, ...bare } = good;
  assert.deepEqual(parseHistory(bare).finalState, demoHand().finalState);
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test('action order: blinds, first to act preflop and after the flop, big blind option', () => {
  let state = createHandState(fourMax);
  assert.equal(state.step, 'start');
  state = replayHand(state, buildEvents(fourMax, blinds4));
  assert.equal(state.players[state.actor].id, 'd'); // seat after the big blind
  assert.deepEqual(actionOptions(state), { playerId: 'd', toCall: 10, canCheck: false, callAmount: 10, canBet: false, canRaise: true, minTo: 20, maxTo: 1000 });
  // Everyone limps: the big blind still gets an option.
  const limped = play(fourMax, [...blinds4,
    ['PLAYER_CALLED', { playerId: 'd', amount: 10 }], ['PLAYER_CALLED', { playerId: 'a', amount: 10 }],
    ['PLAYER_CALLED', { playerId: 'b', amount: 5 }]]);
  assert.equal(limped.players[limped.actor].id, 'c');
  assert.equal(actionOptions(limped).canCheck, true);
  const flop = play(fourMax, [...blinds4,
    ['PLAYER_CALLED', { playerId: 'd', amount: 10 }], ['PLAYER_CALLED', { playerId: 'a', amount: 10 }],
    ['PLAYER_CALLED', { playerId: 'b', amount: 5 }], ['PLAYER_CHECKED', { playerId: 'c' }],
    ['FLOP_DEALT', { cards: ['2c', '3d', '4h'] }]]);
  assert.equal(flop.phase, 'flop');
  assert.equal(flop.players[flop.actor].id, 'b'); // first live seat left of the button
  assert.equal(potTotal(flop), 40);
  assert.ok(flop.players.every(p => p.committed === 0));
});

test('illegal events are rejected with clear errors and leave the state unchanged', () => {
  const state = deepFreeze(replayHand(createHandState(fourMax), buildEvents(fourMax, blinds4)));
  const make = eventFactory('t4', '2026-03-01T00:00:00.000Z', 5, 'x2-');
  const cases = [
    [make('PLAYER_CALLED', { playerId: 'a', amount: 10 }), /Out of turn: D is to act/],
    [make('PLAYER_CHECKED', { playerId: 'd' }), /Cannot check facing a bet of 10/],
    [make('PLAYER_RAISED', { playerId: 'd', to: 15 }), /full raise is at least 20/],
    [make('PLAYER_RAISED', { playerId: 'd', to: 1001 }), /only 1000 chips/],
    [make('PLAYER_BET', { playerId: 'd', to: 50 }), /already a bet; raise instead/],
    [make('PLAYER_CALLED', { playerId: 'd', amount: 7 }), /call adds 10/],
    [make('FLOP_DEALT', { cards: ['2c', '3d', '4h'] }), /expected a player action/],
    [make('HAND_COMPLETED', {}), /expected a player action/],
    [make('PLAYER_FOLDED', { playerId: 'zz' }), /Unknown player/],
    [{ ...make('PLAYER_FOLDED', { playerId: 'd' }), handId: 'other' }, /another hand/],
    [{ ...make('PLAYER_FOLDED', { playerId: 'd' }), schemaVersion: 2 }, /schema version/],
    [{ ...make('PLAYER_FOLDED', { playerId: 'd' }), id: state.eventIds[0] }, /Duplicate event ID/],
    [{ ...make('PLAYER_FOLDED', { playerId: 'd' }), type: 'PLAYER_DANCED' }, /Unknown event type/],
    [{ ...make('PLAYER_FOLDED', { playerId: 'd' }), timestamp: 'yesterday' }, /ISO timestamp/],
  ];
  for (const [event, pattern] of cases) assert.throws(() => applyHandEvent(state, event), pattern, event.type);

  // Blinds must come from the right seat, in order, at the right size.
  const start = applyHandEvent(createHandState(fourMax), make('HAND_STARTED', {}));
  assert.throws(() => applyHandEvent(start, make('SMALL_BLIND_POSTED', { playerId: 'a', amount: 5 })), /B posts the small blind/);
  assert.throws(() => applyHandEvent(start, make('SMALL_BLIND_POSTED', { playerId: 'b', amount: 4 })), /small blind is 5/);
  assert.throws(() => applyHandEvent(start, make('BIG_BLIND_POSTED', { playerId: 'c', amount: 10 })), /post the small blind first/);
});

test('folded and all-in players are skipped, and acting for them is rejected', () => {
  const state = play(fourMax, [...blinds4, ['PLAYER_FOLDED', { playerId: 'd' }], ['PLAYER_ALL_IN', { playerId: 'a', amount: 1000 }]]);
  assert.equal(state.players[3].status, 'folded');
  assert.equal(state.players[0].status, 'all-in');
  assert.equal(state.players[state.actor].id, 'b');
  const make = eventFactory('t4', '2026-03-02T00:00:00.000Z', 5, 'x3-');
  assert.throws(() => applyHandEvent(state, make('PLAYER_CHECKED', { playerId: 'd' })), /D has folded/);
  assert.throws(() => applyHandEvent(state, make('PLAYER_CHECKED', { playerId: 'a' })), /A is all-in/);
});

test('a short all-in raise does not reopen betting; a full raise does', () => {
  const setup = {
    handId: 'short', smallBlind: 5, bigBlind: 10, ante: 0, dealer: 0,
    players: [{ id: 'a', name: 'A', stack: 1000 }, { id: 'b', name: 'B', stack: 1000 }, { id: 'c', name: 'C', stack: 65 }, { id: 'd', name: 'D', stack: 1000 }],
  };
  const start = [['HAND_STARTED', {}], ['SMALL_BLIND_POSTED', { playerId: 'b', amount: 5 }], ['BIG_BLIND_POSTED', { playerId: 'c', amount: 10 }]];
  // D raises to 50 (increment 40). A calls. B folds. C (big blind) is all-in for 65: only 15 more.
  const facing = play(setup, [...start, ['PLAYER_RAISED', { playerId: 'd', to: 50 }], ['PLAYER_CALLED', { playerId: 'a', amount: 50 }],
    ['PLAYER_FOLDED', { playerId: 'b' }], ['PLAYER_ALL_IN', { playerId: 'c', amount: 55 }]]);
  assert.equal(facing.currentBet, 65);
  assert.equal(facing.lastFullRaise, 40);
  assert.equal(facing.players[facing.actor].id, 'd');
  const options = actionOptions(facing);
  assert.equal(options.canRaise, false);
  assert.equal(options.callAmount, 15);
  const make = eventFactory('short', '2026-03-03T00:00:00.000Z', 5, 'x4-');
  assert.throws(() => applyHandEvent(facing, make('PLAYER_RAISED', { playerId: 'd', to: 200 })), /not reopened for D/);
  // A full raise does reopen: in the side-pot fixture Tess and Pat face a re-raise.
  const hand = sidePotFixture();
  const states = replaySteps(createHandState(hand.setup), hand.events);
  const afterFull = states[hand.events.findIndex(e => e.payload.playerId === 'p3' && e.type === 'PLAYER_ALL_IN') + 1];
  assert.equal(afterFull.players[afterFull.actor].id, 'p4');
  assert.equal(actionOptions(afterFull).canRaise, true);
});

test('when only all-in players remain, the board runs out without betting', () => {
  const hand = sidePotFixture();
  const short = {
    ...hand.setup, handId: 'runout',
    players: hand.setup.players.map(p => ({ ...p, stack: p.id === 'p1' ? 149 + 1 : p.stack })),
  };
  // Everyone ends up all-in or matched preflop: Pat calls all-in.
  const state = play(short, [
    ['HAND_STARTED', {}],
    ['ANTE_POSTED', { playerId: 'p2', amount: 1 }], ['ANTE_POSTED', { playerId: 'p3', amount: 1 }],
    ['ANTE_POSTED', { playerId: 'p4', amount: 1 }], ['ANTE_POSTED', { playerId: 'p1', amount: 1 }],
    ['SMALL_BLIND_POSTED', { playerId: 'p2', amount: 5 }], ['BIG_BLIND_POSTED', { playerId: 'p3', amount: 10 }],
    ['PLAYER_ALL_IN', { playerId: 'p4', amount: 299 }], ['PLAYER_ALL_IN', { playerId: 'p1', amount: 149 }],
    ['PLAYER_ALL_IN', { playerId: 'p2', amount: 54 }], ['PLAYER_ALL_IN', { playerId: 'p3', amount: 139 }],
  ]);
  // Tess's chips above Pat's and Sam's 149 come back uncalled.
  assert.deepEqual(state.returned, [{ playerId: 'p4', amount: 150, street: 'preflop' }]);
  assert.equal(state.step, 'deal');
  const make = eventFactory('runout', '2026-03-04T00:00:00.000Z', 5, 'x5-');
  let next = applyHandEvent(state, make('FLOP_DEALT', { cards: ['2c', '7d', '9h'] }));
  assert.equal(next.step, 'deal');
  next = applyHandEvent(next, make('TURN_DEALT', { card: '3s' }));
  next = applyHandEvent(next, make('RIVER_DEALT', { card: '4c' }));
  assert.equal(next.step, 'showdown');
});

test('duplicate cards are rejected in setup, deals, and reveals', () => {
  assert.throws(() => createHandState({ ...fourMax, players: fourMax.players.map((p, i) => ({ ...p, cards: i < 2 ? ['As', 'Kd'] : [null, null] })) }), /only once/);
  const hand = demoHand();
  const preFlop = replayHand(createHandState(hand.setup), hand.events.slice(0, 7));
  const make = eventFactory('demo-4max', '2026-03-05T00:00:00.000Z', 5, 'x6-');
  assert.throws(() => applyHandEvent(preFlop, make('FLOP_DEALT', { cards: ['Ks', '2d', '3d'] })), /Ks is already in the hand/);
  assert.throws(() => applyHandEvent(preFlop, make('FLOP_DEALT', { cards: ['2d', '2d', '3d'] })), /only once/);
  assert.throws(() => applyHandEvent(preFlop, make('FLOP_DEALT', { cards: ['2d', '3d'] })), /exactly 3 cards/);
  assert.throws(() => applyHandEvent(preFlop, make('FLOP_DEALT', { cards: ['2d', '3d', 'Zz'] })), /valid cards/);
  const showdown = replayHand(createHandState(hand.setup), hand.events.slice(0, 20));
  assert.equal(showdown.step, 'reveal');
  assert.throws(() => applyHandEvent(showdown, make('PLAYER_CARDS_REVEALED', { playerId: 'devon', cards: ['Ah', 'As'] })), /does not match|already in the hand/);
  assert.throws(() => applyHandEvent(showdown, make('PLAYER_CARDS_REVEALED', { playerId: 'blake', cards: ['Qh', 'Qd'] })), /folded/);
});

test('unknown cards: a showdown against an unknown hand accepts the declared winner', () => {
  const setup = { ...headsUpFixture().setup, handId: 'unknown', players: [{ id: 'x', name: 'X', stack: 100 }, { id: 'y', name: 'Y', stack: 100, cards: ['Ah', 'Ad'] }] };
  const specs = [['HAND_STARTED', {}], ['SMALL_BLIND_POSTED', { playerId: 'x', amount: 1 }], ['BIG_BLIND_POSTED', { playerId: 'y', amount: 2 }],
    ['PLAYER_CALLED', { playerId: 'x', amount: 1 }], ['PLAYER_CHECKED', { playerId: 'y' }],
    ['FLOP_DEALT', { cards: ['2c', '7d', '9h'] }], ['PLAYER_CHECKED', { playerId: 'y' }], ['PLAYER_CHECKED', { playerId: 'x' }],
    ['TURN_DEALT', { card: '3s' }], ['PLAYER_CHECKED', { playerId: 'y' }], ['PLAYER_CHECKED', { playerId: 'x' }],
    ['RIVER_DEALT', { card: '4c' }], ['PLAYER_CHECKED', { playerId: 'y' }], ['PLAYER_CHECKED', { playerId: 'x' }],
    ['SHOWDOWN_STARTED', {}]];
  const state = play(setup, specs);
  assert.throws(() => settlementSpecs(state), /needs known hands/);
  // X mucks unseen; Y is declared the winner and the award is accepted.
  const history = createHistory(setup, buildEvents(setup, [...specs, ['POT_AWARDED', { potIndex: 0, awards: [{ playerId: 'y', amount: 4 }] }], ['HAND_COMPLETED', {}]]));
  assert.deepEqual(history.finalState.players[0].cards, [null, null]);
  assert.deepEqual(history.result.winners, ['y']);
  // Revealing X's cards later lets the engine check the winner.
  const shown = applyHandEvent(state, eventFactory('unknown', '2026-04-01T00:00:00.000Z', 5, 'x7-')('PLAYER_CARDS_REVEALED', { playerId: 'x', cards: ['5s', '6s'] }));
  assert.throws(() => applyHandEvent(shown, eventFactory('unknown', '2026-04-02T00:00:00.000Z', 5, 'x8-')('POT_AWARDED', { potIndex: 0, awards: [{ playerId: 'y', amount: 4 }] })), /goes to X/);
});

test('cancelling a hand returns every chip', () => {
  const state = play(fourMax, [...blinds4, ['PLAYER_RAISED', { playerId: 'd', to: 40 }], ['HAND_CANCELLED', { reason: 'misdeal' }]]);
  assert.equal(state.step, 'cancelled');
  assert.deepEqual(state.players.map(p => p.stack), [1000, 1000, 1000, 1000]);
  assert.equal(potTotal(state), 0);
  assert.throws(() => applyHandEvent(state, eventFactory('t4', '2026-05-01T00:00:00.000Z', 5, 'x9-')('HAND_STARTED', {})), /already over|expected nothing/);
});

// ---------------------------------------------------------------------------
// Timeline, navigation, adapters
// ---------------------------------------------------------------------------

test('the timeline reads like a hand history', () => {
  const hand = demoHand();
  const states = replaySteps(createHandState(hand.setup), hand.events);
  const lines = hand.events.map((e, i) => describeEvent(states[i], e));
  assert.deepEqual(lines.slice(1, 7).map(l => l.text), [
    'Blake posts small blind: 5', 'Casey posts big blind: 10', 'Devon raises to 30',
    'Avery calls 30', 'Blake folds', 'Casey calls 20',
  ]);
  assert.deepEqual(lines[7], { section: 'flop', text: 'Community cards: A♠ K♦ 7♥' });
  assert.equal(lines.at(-2).text, 'Avery wins 355 from the pot');
});

test('replay navigation clamps moves and states match prefixes', () => {
  assert.equal(moveCursor(0, 10, 'previous'), 0);
  assert.equal(moveCursor(10, 10, 'next'), 10);
  assert.equal(moveCursor(4, 10, 'first'), 0);
  assert.equal(moveCursor(4, 10, 'last'), 10);
  assert.equal(moveCursor(4, 10, 'next'), 5);
  assert.equal(moveCursor(4, 10, 7.4), 7);
  assert.equal(moveCursor(4, 10, -3), 0);
  assert.equal(moveCursor(4, 10, Number.NaN), 4);
  assert.equal(playbackDelay(2), 600);
  assert.equal(playbackDelay(0), 1200);
  const hand = demoHand();
  const steps = replaySteps(createHandState(hand.setup), hand.events);
  assert.equal(steps.length, hand.events.length + 1);
  for (const i of [0, 5, 12, hand.events.length]) {
    assert.deepEqual(steps[i], replayHand(createHandState(hand.setup), hand.events.slice(0, i)));
  }
});

test('a recorded decision becomes an analyzer snapshot', () => {
  const hand = demoHand();
  // Avery faces Devon's flop bet of 40 with a set of kings.
  const index = hand.events.findIndex(e => e.type === 'PLAYER_BET' && e.payload.playerId === 'devon');
  const state = replayHand(createHandState(hand.setup), hand.events.slice(0, index + 1));
  const snapshot = toAnalysisSnapshot(state);
  assert.deepEqual(snapshot, {
    version: 2, ruleset: 'holdem-nl', purpose: 'completed',
    hero: ['Ks', 'Kc'], board: ['As', 'Kd', '7h'],
    opponents: [{ stack: 970, committed: 0, cards: [] }, { stack: 930, committed: 40, cards: ['Ah', 'Jd'] }],
    pot: 135, heroStack: 970, committed: 0, increment: 40,
  });
  const result = analyze(snapshot);
  assert.equal(result.actions[1].kind, 'call');
  // Blake's cards are unknown, so his decision cannot be analyzed.
  const blakeTurn = replayHand(createHandState(hand.setup), hand.events.slice(0, 5));
  assert.throws(() => toAnalysisSnapshot(blakeTurn), /unknown/);
});

test('recognition candidates are validated by the engine without changing state', () => {
  const hand = demoHand();
  const state = deepFreeze(replayHand(createHandState(hand.setup), hand.events.slice(0, 7)));
  assert.deepEqual(expectedNext(state), { types: ['FLOP_DEALT', 'HAND_CANCELLED'], playerId: null, street: 'flop' });
  const make = eventFactory('demo-4max', '2026-06-01T00:00:00.000Z', 5, 'x10-');
  const good = validateCandidate(state, { event: make('FLOP_DEALT', { cards: ['As', 'Kd', '7h'] }), source: 'screenshot', confidence: 0.9 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.state.board, ['As', 'Kd', '7h']);
  const bad = validateCandidate(state, { event: make('TURN_DEALT', { card: '2c' }), source: 'camera' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /deal the flop next/);
  const acting = replayHand(createHandState(hand.setup), hand.events.slice(0, 3));
  assert.deepEqual(expectedNext(acting), { types: ['PLAYER_FOLDED', 'PLAYER_CALLED', 'PLAYER_RAISED', 'PLAYER_ALL_IN', 'HAND_CANCELLED'], playerId: 'devon' });
});
