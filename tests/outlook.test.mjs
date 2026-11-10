// Hand outlook ("hands to play for"). Expected counts were worked out by hand
// from the unseen deck, independently of the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import { handOutlook } from '../dist/core/outlook.js';
import { holdem } from '../dist/rules/holdem.js';

const base = {
  version: 1, ruleset: holdem.id, purpose: 'simulation',
  hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d'], opponent: [],
  pot: 120, heroStack: 150, opponentStack: 110, committed: 0, faced: 40, increment: 40,
};
const row = (outlook, name) => outlook.rows.find(r => r.name === name);
const sorted = cards => [...cards].sort();

test('flop: next-card outs for a royal flush draw match a hand count', () => {
  const outlook = handOutlook(base, holdem);
  assert.equal(outlook.method, 'exact');
  assert.equal(outlook.unseen, 47);
  assert.equal(outlook.cardsToCome, 2);
  assert.equal(outlook.runouts, 1081); // C(47, 2)
  assert.deepEqual(outlook.current, { category: 0, name: 'High card' });

  // Ts makes a royal flush; the other eight spades make a flush.
  assert.deepEqual(row(outlook, 'Straight flush').nextCard.outs, ['Ts']);
  assert.deepEqual(sorted(row(outlook, 'Flush').nextCard.outs), sorted(['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s']));
  assert.deepEqual(sorted(row(outlook, 'Straight').nextCard.outs), sorted(['Tc', 'Td', 'Th']));
  // Non-spade A, K, Q, J (3 each) plus 4c and 4h pair a card.
  assert.equal(row(outlook, 'One pair').nextCard.outs.length, 14);
  assert.equal(row(outlook, 'One pair').nextCard.chance, 14 / 47);
  assert.deepEqual(row(outlook, 'High card').nextCard.outs, []);
});

test('flop: by-river chances match closed-form counts', () => {
  const outlook = handOutlook(base, holdem);
  // Ts on either card: 46 of 1081 runouts.
  assert.equal(row(outlook, 'Straight flush').byRiver, 46 / 1081);
  // At least one spade: 1081 - C(38, 2) = 378 runouts, minus the 46 straight flushes.
  assert.equal(row(outlook, 'Flush').byRiver, 332 / 1081);
  // No full house or quads is possible from A K Q J plus two cards.
  assert.equal(row(outlook, 'Full house'), undefined);
  assert.equal(row(outlook, 'Four of a kind'), undefined);
  const total = outlook.rows.reduce((sum, r) => sum + r.byRiver, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(Math.abs(outlook.improveByRiver - (1 - row(outlook, 'High card').byRiver)) < 1e-12);
  // Rows run from strongest to weakest and flag improvements.
  assert.deepEqual(outlook.rows.map(r => r.category), [...outlook.rows.map(r => r.category)].sort((a, b) => b - a));
  assert.ok(outlook.rows.every(r => r.improves === r.category > 0));
});

test('turn: one card to come, so next card and by the river agree', () => {
  const outlook = handOutlook({ ...base, board: ['Qs', 'Js', '4d', '2c'] }, holdem);
  assert.equal(outlook.runouts, 46);
  assert.equal(outlook.cardsToCome, 1);
  // Non-spade A K Q J, plus 4c 4h and 2d 2h.
  assert.equal(row(outlook, 'One pair').nextCard.outs.length, 16);
  for (const r of outlook.rows.filter(r => r.improves)) {
    assert.equal(r.byRiver, r.nextCard.outs.length / 46, r.name);
  }
});

test('known opponent cards leave the deck and remove outs', () => {
  const outlook = handOutlook({ ...base, opponent: ['Ts', '9s'] }, holdem);
  assert.equal(outlook.unseen, 45);
  assert.deepEqual(row(outlook, 'Straight flush')?.nextCard.outs ?? [], []);
  assert.equal(row(outlook, 'Flush').nextCard.outs.length, 7);
});

test('a made hand reports improvement from its own category', () => {
  // Two pair on the flop: only full house or better improves the hand type.
  const outlook = handOutlook({ ...base, hero: ['Qh', 'Jh'] }, holdem);
  assert.equal(outlook.current.name, 'Two pair');
  // Two queens and two jacks remain for a full house.
  assert.deepEqual(sorted(row(outlook, 'Full house').nextCard.outs), sorted(['Qc', 'Qd', 'Jc', 'Jd']));
  assert.equal(row(outlook, 'Two pair').improves, false);
  assert.equal(row(outlook, 'One pair'), undefined);
});

test('preflop samples full boards deterministically and the river has no outlook', () => {
  const preflop = handOutlook({ ...base, board: [] }, holdem);
  assert.equal(preflop.method, 'sampled');
  assert.equal(preflop.runouts, 2500);
  assert.equal(preflop.current, null);
  assert.equal(preflop.improveByRiver, null);
  assert.ok(preflop.rows.every(r => r.nextCard === undefined && r.improves));
  assert.deepEqual(preflop, handOutlook({ ...base, board: [] }, holdem));
  assert.ok(Math.abs(preflop.rows.reduce((sum, r) => sum + r.byRiver, 0) - 1) < 1e-12);
  assert.equal(handOutlook({ ...base, board: ['Qs', 'Js', '4d', '2c', '9h'] }, holdem), null);
  assert.equal(analyze({ ...base, board: ['Qs', 'Js', '4d', '2c', '9h'] }).outlook, null);
  assert.equal(analyze(base).outlook.runouts, 1081);
});
