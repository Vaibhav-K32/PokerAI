import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import { parseCards, compareRank } from '../dist/core/cards.js';
import { holdem } from '../dist/rules/holdem.js';
import { localRecognizer } from '../dist/vision/recognizer.js';

const base = {
  version: 1, ruleset: holdem.id, purpose: 'simulation',
  hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d', '2s', '9c'], opponent: [],
  pot: 120, heroStack: 150, opponentStack: 110, committed: 0, faced: 40, increment: 40,
};

test('card parser normalizes ranks, suits, commas and tens', () => {
  assert.deepEqual(parseCards(' as, 10D  jH '), ['As', 'Td', 'Jh']);
});

test('ranks all nine hand categories from lowest to highest', () => {
  const hands = [
    'As Kd 8d 5c 2h', 'As Ad 8d 5c 2h', 'As Ad 8d 8c 2h', 'As Ad Ac 5c 2h',
    'As 2d 3c 4h 5s', 'As Ks 8s 5s 2s', 'As Ad Ac 5c 5h', 'As Ad Ac Ah 2h',
    'As Ks Qs Js Ts',
  ];
  hands.forEach((hand, category) => {
    assert.equal(holdem.rank([], parseCards(hand)).value[0], category);
  });
  const wheel = holdem.rank([], parseCards(hands[4]));
  assert.deepEqual(wheel.value, [4, 5]);
  assert.ok(compareRank([1, 14, 13, 7, 6], [1, 14, 12, 11, 10]) > 0);
});

test('rejects duplicates, invalid street sizes and inconsistent chip inputs', () => {
  assert.throws(() => analyze({ ...base, opponent: ['As', '2d'] }), /only once/);
  assert.throws(() => analyze({ ...base, board: ['3c'] }), /board cards/);
  assert.throws(() => analyze({ ...base, faced: -1 }), /whole chip/);
  assert.throws(() => analyze({ ...base, pot: 39 }), /commitments/);
  assert.throws(() => analyze({ ...base, purpose: '' }), /study context/);
});

test('sizes full and short raises and caps calls at the stack', () => {
  assert.deepEqual(holdem.legalActions({ ...base, committed: 10 }).at(-1),
    { kind: 'raise', minTo: 90, maxTo: 160, short: false });
  assert.deepEqual(holdem.legalActions({ ...base, heroStack: 50 }).at(-1),
    { kind: 'raise', minTo: 50, maxTo: 50, short: true });
  assert.deepEqual(holdem.legalActions({ ...base, heroStack: 20 }),
    [{ kind: 'fold' }, { kind: 'call', cost: 20 }]);
  assert.deepEqual(holdem.legalActions({ ...base, opponentStack: 0 }),
    [{ kind: 'fold' }, { kind: 'call', cost: 40 }]);
  assert.deepEqual(holdem.legalActions({ ...base, faced: 0 }),
    [{ kind: 'check' }, { kind: 'bet', minTo: 40, maxTo: 150, short: false }]);
});

test('enumerates all river combinations and splits a board lock', () => {
  const r = analyze({ ...base, hero: ['2c', '3c'], board: parseCards('As Ks Qs Js Ts') });
  assert.equal(r.equity.trials, 990);
  assert.equal(r.equity.tie, 1);
  assert.equal(r.equity.share, 0.5);
  assert.equal(r.study.callValue, 40);
});

test('uses exact known hands and refunds the unmatched part of a wager', () => {
  const r = analyze({ ...base, opponent: ['3d', '3c'], heroStack: 20 });
  assert.equal(r.equity.trials, 1);
  assert.equal(r.equity.win, 1);
  assert.equal(r.study.threshold, 1 / 6);
  assert.equal(r.study.callValue, 100);
});

test('returns pot odds when future betting is possible', () => {
  const scenario = { ...base, board: base.board.slice(0, 4), opponent: ['3d', '3c'] };
  const r = analyze(scenario);
  assert.equal(r.equity.trials, 44);
  assert.equal(r.study.title, 'Pot odds only');
  assert.equal(r.study.threshold, 0.25);
  assert.equal(r.study.callValue, undefined);
});

test('samples reproducibly and reports a bounded interval', () => {
  const scenario = { ...base, board: [] };
  const first = analyze(scenario).equity;
  assert.equal(first.method, 'sampled');
  assert.equal(first.trials, 2500);
  assert.deepEqual(first, analyze(scenario).equity);
  assert.ok(Math.abs(first.win + first.tie + first.loss - 1) < 1e-10);
  assert.ok(first.interval[0] <= first.share && first.interval[1] >= first.share);
});

test('recognizer abstains in the starter', async () => {
  const result = await localRecognizer.recognize(new Blob());
  assert.equal(result.kind, 'unavailable');
});
