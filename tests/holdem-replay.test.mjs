import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import {
  amountToCall, applyHoldemEvent, replayHoldem, startHoldemReplay, toHoldemSnapshot,
} from '../dist/rules/holdem-replay.js';

const config = {
  purpose: 'completed',
  button: 0,
  startingStack: 100,
  smallBlind: 1,
  bigBlind: 2,
  holeCards: [['As', 'Ks'], ['Ad', 'Kd']],
};

const act = (kind, seat) => ({ kind, seat });
const raise = (seat, to) => ({ kind: 'raise', seat, to });
const bet = (seat, to) => ({ kind: 'bet', seat, to });
const deal = (...cards) => ({ kind: 'deal', cards });
const flop = deal('Qs', 'Js', '4d');
const limp = [act('call', 0), act('check', 1)];

test('posts blinds and gives either button the first preflop turn', () => {
  for (const button of [0, 1]) {
    const state = startHoldemReplay({ ...config, button });
    assert.equal(state.street, 'preflop');
    assert.equal(state.phase, 'betting');
    assert.equal(state.actor, button);
    assert.equal(state.pot, 3);
    assert.equal(state.committed[button], 1);
    assert.equal(state.committed[1 - button], 2);
    assert.equal(state.stacks[button], 99);
    assert.equal(state.stacks[1 - button], 98);
    assert.equal(amountToCall(state), 1);
  }
});

test('a limp preserves the big blind option to check or raise', () => {
  const option = replayHoldem(config, [act('call', 0)]);
  assert.equal(option.actor, 1);
  assert.equal(option.pot, 4);
  assert.equal(amountToCall(option), 0);
  assert.throws(() => applyHoldemEvent(option, flop), /before dealing/);
  const raised = applyHoldemEvent(option, raise(1, 4));
  assert.equal(raised.actor, 0);
  assert.equal(amountToCall(raised), 2);
  assert.equal(applyHoldemEvent(option, act('check', 1)).phase, 'awaiting-board');
});

test('full raises update the minimum and a call closes betting', () => {
  const opened = replayHoldem(config, [raise(0, 6)]);
  assert.equal(opened.minIncrement, 4);
  assert.equal(amountToCall(opened), 4);
  assert.throws(() => applyHoldemEvent(opened, raise(1, 9)), /full raise/);
  const reraised = applyHoldemEvent(opened, raise(1, 10));
  assert.equal(amountToCall(reraised), 4);
  const called = applyHoldemEvent(reraised, act('call', 0));
  assert.equal(called.phase, 'awaiting-board');
  assert.equal(called.actor, null);
  assert.equal(amountToCall(called), null);
  assert.equal(called.pot, 20);
  assert.deepEqual(called.committed, [10, 10]);
  assert.deepEqual(called.stacks, [90, 90]);
});

test('dealing a street resets commitments and the minimum and starts with the big blind', () => {
  const state = replayHoldem(config, [raise(0, 6), act('call', 1), flop]);
  assert.equal(state.street, 'flop');
  assert.equal(state.actor, 1);
  assert.equal(state.pot, 12);
  assert.deepEqual(state.committed, [0, 0]);
  assert.deepEqual(state.stacks, [94, 94]);
  assert.deepEqual(state.board, ['Qs', 'Js', '4d']);
  assert.equal(state.minIncrement, 2);

  const checked = applyHoldemEvent(state, act('check', 1));
  assert.equal(checked.actor, 0);
  assert.equal(checked.phase, 'betting');
  const turn = applyHoldemEvent(applyHoldemEvent(checked, act('check', 0)), deal('2s'));
  assert.equal(turn.street, 'turn');
  assert.equal(turn.actor, 1);
});

test('rejects illegal events without mutating the current state', () => {
  const state = startHoldemReplay(config);
  const before = structuredClone(state);
  Object.freeze(state.stacks);
  Object.freeze(state.committed);
  Object.freeze(state);
  assert.throws(() => applyHoldemEvent(state, act('call', 1)), /out of turn/);
  assert.throws(() => applyHoldemEvent(state, act('check', 0)), /facing a wager/);
  assert.throws(() => applyHoldemEvent(state, raise(0, 101)), /full raise/);
  assert.throws(() => applyHoldemEvent(state, raise(0, 4.5)), /full raise/);
  assert.throws(() => applyHoldemEvent(state, flop), /before dealing/);
  assert.deepEqual(state, before);
  const next = applyHoldemEvent(state, raise(0, 4));
  assert.deepEqual(next.committed, [4, 2]);
  assert.deepEqual(state, before);
});

test('rejects invalid card deals and copies caller-owned card arrays', () => {
  const awaiting = replayHoldem(config, limp);
  assert.throws(() => applyHoldemEvent(awaiting, deal('Qs')), /exactly 3/);
  assert.throws(() => applyHoldemEvent(awaiting, deal('As', 'Js', '4d')), /only once/);
  assert.throws(() => applyHoldemEvent(awaiting, deal('Qs', 'Js', 'Zz')), /valid Hold’em cards/);
  const cards = ['Qs', 'Js', '4d'];
  const next = applyHoldemEvent(awaiting, { kind: 'deal', cards });
  cards[0] = '9c';
  assert.deepEqual(next.board, ['Qs', 'Js', '4d']);
  assert.deepEqual(awaiting.board, []);
});

test('the existing analyzer accepts the acting seat snapshot and only sees dealt board cards', () => {
  const history = [...limp, flop, act('check', 1), bet(0, 8)];
  const state = replayHoldem(config, history);
  const snapshot = toHoldemSnapshot(state);
  assert.deepEqual(snapshot, {
    version: 2, ruleset: 'holdem-nl', purpose: 'completed',
    hero: ['Ad', 'Kd'], board: ['Qs', 'Js', '4d'],
    opponents: [{ stack: 90, committed: 8, cards: ['As', 'Ks'] }],
    pot: 12, heroStack: 98, committed: 0, increment: 8,
  });
  const result = analyze(snapshot);
  assert.deepEqual(result.actions, [
    { kind: 'fold' }, { kind: 'call', cost: 8 },
    { kind: 'raise', minTo: 16, maxTo: 98, short: false },
  ]);
  assert.equal(result.equity.method, 'exact');
});

test('a fold stops replay and leaves the pot available for future settlement', () => {
  const folded = replayHoldem(config, [act('fold', 0)]);
  assert.equal(folded.phase, 'folded');
  assert.equal(folded.foldWinner, 1);
  assert.equal(folded.actor, null);
  assert.equal(folded.pot, 3);
  assert.deepEqual(folded.stacks, [99, 98]);
  assert.throws(() => applyHoldemEvent(folded, act('check', 1)), /no betting action/);
  assert.throws(() => toHoldemSnapshot(folded), /no betting decision/);
});

test('a matched full all-in runs out only the explicitly dealt board', () => {
  const awaiting = replayHoldem(config, [raise(0, 100), act('call', 1), flop, deal('2s')]);
  assert.equal(awaiting.phase, 'awaiting-board');
  assert.equal(awaiting.actor, null);
  assert.deepEqual(awaiting.stacks, [0, 0]);
  assert.equal(awaiting.pot, 200);
  const showdown = applyHoldemEvent(awaiting, deal('9c'));
  assert.equal(showdown.phase, 'showdown');
  assert.equal(showdown.street, 'river');
  assert.equal(showdown.board.length, 5);
});

test('a normal river closes at showdown with all chips accounted for', () => {
  const history = [...limp, flop, bet(1, 4), act('call', 0), deal('2s'),
    act('check', 1), act('check', 0), deal('9c'), act('check', 1), act('check', 0)];
  const state = replayHoldem(config, history);
  assert.equal(state.phase, 'showdown');
  assert.equal(state.actor, null);
  assert.equal(state.pot, 12);
  assert.deepEqual(state.stacks, [94, 94]);
  assert.equal(state.pot + state.stacks[0] + state.stacks[1], 200);
  assert.throws(() => applyHoldemEvent(state, deal('7h')), /before dealing/);
});

test('rejects a short all-in raise and aggression against an all-in opponent', () => {
  const facing = replayHoldem(config, [raise(0, 65)]);
  assert.throws(() => applyHoldemEvent(facing, raise(1, 100)), /full raise/);
  const allIn = replayHoldem(config, [raise(0, 100)]);
  assert.throws(() => applyHoldemEvent(allIn, raise(1, 100)), /all-in opponent/);
});

test('allows unknown seats during replay and requires the acting hand for analysis', () => {
  const state = startHoldemReplay({ ...config, holeCards: [[], ['Ad', 'Kd']] });
  assert.throws(() => toHoldemSnapshot(state), /two hero cards/);
  const snapshot = toHoldemSnapshot(applyHoldemEvent(state, raise(0, 6)));
  assert.deepEqual(snapshot.hero, ['Ad', 'Kd']);
  assert.deepEqual(snapshot.opponents, [{ stack: 94, committed: 6, cards: [] }]);
});
