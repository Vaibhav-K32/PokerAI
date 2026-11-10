// Bet sizing under the opponent response model. Expected values come from
// closed-form expressions for hands whose equity is the same against every
// opponent holding, so the sampled strength order does not matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze as analyzeSnapshot } from '../dist/core/analyze.js';
import { betAdvice as adviceFor, foldFrequency } from '../dist/core/sizing.js';
import { headsUp } from './helpers.mjs';

const analyze = s => analyzeSnapshot(headsUp(s));
const betAdvice = (s, rules) => adviceFor(headsUp(s), rules);
import { holdem } from '../dist/rules/holdem.js';

const spot = {
  version: 1, ruleset: holdem.id, purpose: 'simulation',
  hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d', '2s', '9c'], opponent: [],
  pot: 100, heroStack: 1000, opponentStack: 1000, committed: 0, faced: 0, increment: 2,
};
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, label + ': ' + actual + ' vs ' + expected);
const option = (advice, style, to) => advice.byStyle[style].options.find(o => o.to === to);

test('fold frequency follows minimum defense, scaled by style and capped', () => {
  assert.equal(foldFrequency(100, 200, 'balanced'), 0.5); // pot-size bet
  assert.equal(foldFrequency(50, 150, 'balanced'), 1 / 3); // half-pot bet
  assert.equal(foldFrequency(100, 200, 'loose'), 0.25);
  assert.equal(foldFrequency(100, 200, 'tight'), 0.8);
  assert.equal(foldFrequency(1000, 1100, 'tight'), 0.95);
  assert.equal(foldFrequency(0, 100, 'balanced'), 0);
});

test('river nuts: value bets follow P + P·x/(P+x) against a balanced opponent', () => {
  // A-high flush with no pair on board: it beats every opponent holding.
  const advice = betAdvice(spot, holdem);
  assert.equal(advice.holdings, 990);
  assert.equal(advice.streetsLeft, 0);
  const balanced = advice.byStyle.balanced;
  near(balanced.options[0].ev, 100, 'check');
  near(option(advice, 'balanced', 100).ev, 150, 'pot-size bet');
  near(option(advice, 'balanced', 50).ev, 100 + 100 * 50 / 150, 'half-pot bet');
  near(option(advice, 'balanced', 1000).ev, 100 + 100 * 1000 / 1100, 'all-in');
  // Every extra chip earns more against callers, so the biggest bet is best.
  assert.equal(balanced.options[balanced.best].to, 1000);
  assert.equal(balanced.options[balanced.best].allIn, true);
  // Loose players fold half as often: EV = fold·P + (1 − fold)(P + x).
  const fold = 0.25;
  near(option(advice, 'loose', 100).ev, fold * 100 + (1 - fold) * 200, 'loose pot-size bet');
});

test('board-locked split: betting gains only the folds', () => {
  // A royal flush on the board: every showdown splits.
  const advice = betAdvice({ ...spot, hero: ['2c', '3c'], board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }, holdem);
  near(advice.byStyle.balanced.options[0].ev, 50, 'check');
  // fold·P + call·(½(P + 2x) − x) with fold = x/(P + x).
  near(option(advice, 'balanced', 100).ev, 0.5 * 100 + 0.5 * 50, 'pot-size bet');
  for (const o of advice.byStyle.balanced.options) near(o.equityWhenCalled, 0.5, o.kind + ' ' + o.to);
});

test('facing a bet: call matches the existing call study, and fold is zero', () => {
  const facing = { ...spot, hero: ['Qh', 'Td'], pot: 140, faced: 40, increment: 40 };
  const advice = betAdvice(facing, holdem);
  const [fold, call] = advice.byStyle.balanced.options;
  assert.deepEqual([fold.kind, fold.ev], ['fold', 0]);
  assert.equal(call.kind, 'call');
  assert.equal(call.put, 40);
  near(call.ev, analyze(facing).study.callValue, 'call EV');
  assert.ok(advice.byStyle.balanced.options.slice(2).every(o => o.kind === 'raise' && o.to >= 80));
});

test('sizes stop where the opponent is all-in, and an all-in opponent leaves no raises', () => {
  const short = betAdvice({ ...spot, opponentStack: 110 }, holdem);
  const bets = short.byStyle.balanced.options.filter(o => o.kind === 'bet');
  assert.ok(bets.every(o => o.to <= 110));
  assert.equal(bets.at(-1).to, 110);
  assert.equal(bets.at(-1).coversOpponent, true);
  assert.equal(bets.at(-1).allIn, false);

  const allIn = betAdvice({ ...spot, pot: 1100, faced: 1000, opponentStack: 0, increment: 1000 }, holdem);
  assert.deepEqual(allIn.byStyle.balanced.options.map(o => o.kind), ['fold', 'call']);
});

test('known opponent hand either calls or folds outright', () => {
  const advice = betAdvice({ ...spot, opponent: ['Qh', 'Qd'] }, holdem);
  assert.equal(advice.opponent, 'known');
  for (const o of advice.byStyle.balanced.options.filter(o => o.kind === 'bet')) {
    assert.ok(o.foldChance === 0 || o.foldChance === 1, String(o.foldChance));
  }
});

test('a weak hand checks unless the opponent folds too much, and results repeat', () => {
  const air = { ...spot, hero: ['7c', '2d'], board: ['Qs', 'Js', '4d', 'Ah'], pot: 120, heroStack: 150, opponentStack: 150 };
  const advice = betAdvice(air, holdem);
  const best = style => advice.byStyle[style].options[advice.byStyle[style].best];
  assert.equal(best('balanced').kind, 'check');
  assert.equal(best('loose').kind, 'check');
  assert.equal(best('tight').kind, 'bet');
  assert.equal(advice.sensitive, true);
  assert.deepEqual(advice, betAdvice(air, holdem));
  assert.ok(analyze(air).sizing.byStyle.balanced.options.length > 1);
});

test('near-identical choices across styles are not flagged as sensitive', () => {
  // Facing 40 with the nuts: styles pick raises within a few chips of each other.
  const advice = betAdvice({ ...spot, pot: 120, faced: 40, increment: 40, heroStack: 150, opponentStack: 110 }, holdem);
  const picks = ['loose', 'balanced', 'tight'].map(s => advice.byStyle[s].options[advice.byStyle[s].best].kind);
  assert.deepEqual(picks, ['raise', 'raise', 'raise']);
  assert.equal(advice.sensitive, false);
});
