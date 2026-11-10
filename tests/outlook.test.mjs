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

// ---------------------------------------------------------------------------
// Opponent matchups and suggestions
// ---------------------------------------------------------------------------
import { compareRank } from '../dist/core/cards.js';

test('the fast score orders hands exactly like the full ranker', () => {
  let seed = 20261109;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const deal = n => {
    const deck = [...holdem.deck];
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck.slice(0, n);
  };
  for (let i = 0; i < 5000; i++) {
    const size = 5 + (i % 3);
    const a = deal(size);
    const b = deal(size);
    const order = Math.sign(holdem.score([], a) - holdem.score([], b));
    assert.equal(order, Math.sign(compareRank(holdem.rank([], a).value, holdem.rank([], b).value)), a + ' vs ' + b);
    assert.equal(Math.floor(holdem.score([], a) / 16 ** 5), holdem.rank([], a).value[0]);
  }
  // Wheel, steel wheel, and a full house built from two sets.
  assert.equal(Math.floor(holdem.score(['As', '2d'], ['3c', '4h', '5s']) / 16 ** 5), 4);
  assert.equal(Math.floor(holdem.score(['As', '2s'], ['3s', '4s', '5s', 'Kd']) / 16 ** 5), 8);
  assert.ok(holdem.score(['Kh', 'Kd'], ['Kc', '7s', '7d', '7h', '2c'])
    > holdem.score(['Qh', 'Qd'], ['Qc', '7s', '7d', '7h', '2c']));
});

// A K of spades against a set of queens on the turn. Rivers counted by hand
// from the 44 unseen cards: Ts makes a royal flush; seven other spades make a
// winning flush; 2s and 4s make a flush but pair the board for the opponent's
// full house; Tc Td Th make a winning straight; everything else loses.
const setOverDraw = { ...base, board: ['Qs', 'Js', '4d', '2c'], opponent: ['Qh', 'Qd'] };

test('known opponent: per-hand matchups match a hand count', () => {
  const outlook = handOutlook(setOverDraw, holdem);
  assert.equal(outlook.opponent.model, 'known');
  assert.equal(outlook.opponent.method, 'exact');
  assert.equal(outlook.runouts, 44);
  assert.equal(outlook.yourEquity, 10 / 44);
  assert.equal(outlook.yourEquity, analyze(setOverDraw).equity.share);

  const royal = row(outlook, 'Straight flush');
  assert.equal(royal.byRiver, 1 / 44);
  assert.deepEqual(royal.matchup, { win: 1, tie: 0, loss: 0, beatenBy: [] });

  const flush = row(outlook, 'Flush');
  assert.equal(flush.byRiver, 8 / 44);
  assert.equal(flush.matchup.win, 6 / 8);
  assert.deepEqual(flush.matchup.beatenBy, [{ name: 'Full house', chance: 2 / 8 }]);
  assert.equal(flush.equityShare, 6 / 44);

  assert.equal(row(outlook, 'Straight').matchup.win, 1);
  assert.equal(row(outlook, 'One pair').matchup.win, 0);
  const shares = outlook.rows.reduce((sum, r) => sum + r.equityShare, 0);
  assert.ok(Math.abs(shares - 10 / 44) < 1e-12);
});

test('known opponent: their hand chances and wins add up', () => {
  const { opponent } = handOutlook(setOverDraw, holdem);
  assert.ok(Math.abs(opponent.rows.reduce((sum, r) => sum + r.chance, 0) - 1) < 1e-12);
  assert.equal(opponent.beatsYou, 34 / 44);
  assert.ok(Math.abs(opponent.equity - 34 / 44) < 1e-12);
  // Qc gives them quads; the other non-winning rivers leave them a set or better.
  assert.equal(opponent.rows.find(r => r.name === 'Four of a kind').chance, 1 / 44);
  assert.ok(opponent.rows.every(r => r.category >= 3));
});

test('suggestion names the hands carrying equity and warns about losing ones', () => {
  const { suggestion } = handOutlook(setOverDraw, holdem);
  assert.deepEqual(suggestion.playFor.map(h => h.name), ['Flush', 'Straight']);
  assert.equal(suggestion.playFor[0].winWhenMade, 0.75);
  assert.equal(suggestion.playFor[0].equityShare, 6 / 44);
  assert.ok(suggestion.caution.some(h => h.name === 'One pair' && h.winWhenMade === 0));
  assert.equal(suggestion.holding, null);

  // A flopped set is already likely to hold up.
  const set = handOutlook({ ...base, hero: ['Qh', 'Qd'], opponent: [] }, holdem);
  assert.equal(set.suggestion.holding.name, 'Three of a kind');
  assert.ok(set.suggestion.holding.winWhenMade >= 0.75);
});

test('random opponent: turn matchups are exact and agree with equity; flop samples are repeatable', () => {
  const turn = { ...base, board: ['Qs', 'Js', '4d', '2c'] };
  const outlook = handOutlook(turn, holdem);
  assert.equal(outlook.opponent.model, 'random');
  assert.equal(outlook.opponent.method, 'exact');
  assert.equal(outlook.opponent.matchups, 46 * 990); // 46 rivers × C(45, 2) opponent hands
  // Exact equity counts every opponent hand and river, so the two agree.
  const equity = analyze(turn).equity;
  assert.equal(equity.method, 'sampled');
  assert.ok(Math.abs(outlook.yourEquity - equity.share) <= equity.share - equity.interval[0] + 1e-9);

  const flop = handOutlook(base, holdem);
  assert.equal(flop.opponent.method, 'sampled');
  assert.ok(flop.opponent.matchups >= 100000);
  assert.deepEqual(flop, handOutlook(base, holdem));
  for (const r of flop.rows.filter(r => r.matchup)) {
    assert.ok(Math.abs(r.matchup.win + r.matchup.tie + r.matchup.loss - 1) < 1e-12, r.name);
  }
});
