// Three- and four-player snapshots: validation, side pots, equity, the call
// study, the hand outlook, and bet sizing. Known-hand fixtures are exact and
// were worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import { handOutlook } from '../dist/core/outlook.js';
import { betAdvice } from '../dist/core/sizing.js';
import { heroPayout } from '../dist/core/table.js';
import { holdem } from '../dist/rules/holdem.js';

const seat = (stack, committed = 0, cards = []) => ({ stack, committed, cards });
const snapshot = extra => ({
  version: 2, ruleset: holdem.id, purpose: 'simulation',
  hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d', '2s', '9c'],
  opponents: [seat(500), seat(500)],
  pot: 90, heroStack: 500, committed: 0, increment: 10,
  ...extra,
});
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-9, label + ' ' + actual + ' vs ' + expected);

test('side pots: each layer goes to the best eligible hand', () => {
  // Hero all-in for 50; two opponents put in 100; 30 dead. Main pot 180, side 100.
  near(heroPayout([9, 5, 4], [50, 100, 100], 30), 180, 'hero best');
  near(heroPayout([5, 9, 4], [50, 100, 100], 30), 0, 'hero second');
  near(heroPayout([9, 4, 9], [50, 100, 100], 30), 90, 'hero splits the main pot');
  // Hero covers a short all-in: the unmatched 40 comes back even when losing.
  near(heroPayout([1, 9], [100, 60], 0), 40, 'uncalled chips return');
  // A folded opponent's chips are dead money in the main pot.
  near(heroPayout([9, null, 4], [20, 50, 20], 10), 100, 'folded chips are dead');
  // Everyone checks: dead money goes to the best hand.
  near(heroPayout([9, 4, 5], [0, 0, 0], 60), 60, 'checked down');
});

test('validation and legal actions with several opponents', () => {
  assert.throws(() => analyze(snapshot({ opponents: [seat(1), seat(1), seat(1), seat(1)] })), /one to three opponents/);
  assert.throws(() => analyze(snapshot({ opponents: [] })), /one to three opponents/);
  // A player all-in on an earlier street is accepted; their limit is checked.
  assert.ok(analyze(snapshot({ opponents: [seat(0), seat(500)] })).equity.trials > 0);
  assert.throws(() => analyze(snapshot({ opponents: [{ ...seat(0), eligiblePot: 91 }, seat(500)] })), /at most the pot from earlier/);
  assert.throws(() => analyze(snapshot({ opponents: [{ ...seat(0), eligiblePot: 0 }, seat(500)] })), /whole number/);
  assert.throws(() => analyze(snapshot({ opponents: [{ ...seat(500), eligiblePot: 50 }, seat(500)] })), /Only a player all-in/);
  assert.throws(() => analyze(snapshot({ committed: 20, opponents: [seat(500, 10), seat(500)], pot: 120 })), /cannot be larger/);
  assert.throws(() => analyze(snapshot({ opponents: [seat(500, 60), seat(500, 60)], pot: 100 })), /current street commitments/);
  assert.throws(() => analyze(snapshot({ opponents: [seat(500, 0, ['As', 'Kd']), seat(500)] })), /only once/);

  // The biggest bet sets the price; a raise needs a full increment above it.
  const facing = snapshot({ opponents: [seat(460, 40), seat(420, 80)], pot: 210, increment: 40 });
  assert.deepEqual(holdem.legalActions(facing), [
    { kind: 'fold' }, { kind: 'call', cost: 80 },
    { kind: 'raise', minTo: 120, maxTo: 500, short: false },
  ]);
  // Nobody left with chips: no raise.
  assert.deepEqual(holdem.legalActions(snapshot({ opponents: [seat(0, 40), seat(0, 80)], pot: 210 })),
    [{ kind: 'fold' }, { kind: 'call', cost: 80 }]);
});

test('three-way equity splits ties three ways and enumerates known hands exactly', () => {
  // A royal flush on the board: everyone splits.
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
  const split = analyze(snapshot({
    hero: ['2c', '3c'], board, opponents: [seat(500, 0, ['4c', '5c']), seat(500, 0, ['6c', '7c'])],
  }));
  assert.equal(split.equity.method, 'exact');
  assert.equal(split.equity.trials, 1);
  assert.equal(split.equity.tie, 1);
  near(split.equity.share, 1 / 3);

  // Known hands on the turn: every river is counted.
  const turn = snapshot({
    board: ['Qs', 'Js', '4d', '2c'],
    opponents: [seat(500, 0, ['Qh', 'Qd']), seat(500, 0, ['Tc', '9c'])],
  });
  const equity = analyze(turn).equity;
  assert.equal(equity.method, 'exact');
  assert.equal(equity.trials, 42);
  // The outlook counts the same rivers and must agree exactly.
  const outlook = handOutlook(turn, holdem);
  assert.equal(outlook.opponent.players, 2);
  assert.equal(outlook.opponent.model, 'known');
  assert.equal(outlook.opponent.method, 'exact');
  near(outlook.yourEquity, equity.share, 'outlook equity');
  near(outlook.opponent.equity + outlook.yourEquity, 1, 'equity adds up');
});

test('the call study pays side pots: a short all-in winner leaves you the side pot', () => {
  // River. You hold a set of kings. A short stack is all-in for 30 with a
  // straight; a deep opponent bets 100 holding a pair of aces. 50 was already in.
  const spot = snapshot({
    hero: ['Kh', 'Kd'], board: ['2c', '7d', 'Jc', 'Ks', '9h'],
    opponents: [seat(0, 30, ['Qh', 'Td']), seat(200, 100, ['Ah', 'Ac'])],
    pot: 180, heroStack: 500, increment: 70,
  });
  const result = analyze(spot);
  // You lose the 140 main pot to the straight but win the 140 side pot.
  assert.equal(result.equity.loss, 1);
  assert.equal(result.equity.callWinnings, 140);
  assert.equal(result.study.callValue, 40);
  assert.equal(result.study.threshold, 100 / 280);
  assert.equal(result.study.title, 'Call beats fold under this model');
});

test('the call study waits when another player still has to act', () => {
  const spot = snapshot({ opponents: [seat(440, 60), seat(500, 0)], pot: 150, increment: 60 });
  const study = analyze(spot).study;
  assert.equal(study.title, 'Pot odds only');
  assert.match(study.detail, /still to act/);
});

test('multiway bet sizing: the table folds together at the balanced rate', () => {
  // Nut flush on the river against two random hands: checking wins the pot.
  const spot = snapshot({ pot: 100, opponents: [seat(1000), seat(1000)], heroStack: 1000 });
  const advice = betAdvice(spot, holdem);
  assert.equal(advice.players, 2);
  assert.equal(advice.method, 'sampled');
  const { options, best } = advice.byStyle.balanced;
  near(options[0].ev, 100, 'check');
  const potBet = options.find(o => o.to === 100);
  // Each folds at √(1/2), so both fold about half the time.
  assert.ok(Math.abs(potBet.foldChance - 0.5) < 0.03, String(potBet.foldChance));
  assert.ok(potBet.ev > options[0].ev);
  assert.equal(options[best].kind, 'bet');
  assert.deepEqual(advice, betAdvice(spot, holdem));

  // Folding too much makes a bluff with nothing profitable three-handed too.
  const air = snapshot({ hero: ['7c', '2d'], board: ['Qs', 'Js', '4d', 'Ah', '9c'], pot: 100, opponents: [seat(1000), seat(1000)] });
  const bluff = betAdvice(air, holdem);
  const pick = style => bluff.byStyle[style].options[bluff.byStyle[style].best];
  assert.equal(pick('loose').kind, 'check');
  assert.equal(pick('tight').kind, 'bet');
});

test('four players: the full analysis runs and stays repeatable', () => {
  const spot = snapshot({
    board: ['Qs', 'Js', '4d'],
    opponents: [seat(300, 20), seat(300, 20), seat(300, 20, ['7h', '7d'])],
    pot: 120, committed: 0, increment: 20,
  });
  const first = analyze(spot);
  assert.equal(first.equity.method, 'sampled');
  assert.ok(first.equity.callWinnings > 0);
  assert.equal(first.outlook.opponent.players, 3);
  assert.equal(first.sizing.players, 3);
  assert.deepEqual(first.actions.map(a => a.kind), ['fold', 'call', 'raise']);
  assert.deepEqual(analyze(spot), first);
});

// ---------------------------------------------------------------------------
// Players all-in on an earlier street
// ---------------------------------------------------------------------------
test('earlier-street pots: capped players win only up to their limit', () => {
  // 150 from earlier streets; player 1 went all-in earlier and can win 100 of it.
  // Hero best: wins everything, 150 earlier plus 100 this street.
  near(heroPayout([9, 5, 4], [50, 0, 50], 150, [undefined, 100, undefined]), 250, 'hero best');
  // Earlier all-in player best: they take their 100; hero beats the other for the rest.
  near(heroPayout([7, 9, 4], [50, 0, 50], 150, [undefined, 100, undefined]), 150, 'capped player best');
  // With no cap they would take the whole 150 earlier pot.
  near(heroPayout([7, 9, 4], [50, 0, 50], 150), 100, 'uncapped');
  // Two earlier all-ins with different limits: 60 to the shortest, 30 more to the next.
  near(heroPayout([5, 9, 7], [0, 0, 0], 120, [undefined, 60, 90]), 30, 'nested caps');
});

test('a player all-in earlier: the call study pays the earlier side pot correctly', () => {
  // River. 150 in from earlier streets, of which the earlier all-in player can
  // win 100. They hold a straight, you a set of kings, the bettor aces; the
  // bettor puts in 50 now.
  const spot = cap => snapshot({
    hero: ['Kh', 'Kd'], board: ['2c', '7d', 'Jc', 'Ks', '9h'],
    opponents: [{ ...seat(0, 0, ['Qh', 'Td']), ...(cap ? { eligiblePot: cap } : {}) }, seat(300, 50, ['Ah', 'Ac'])],
    pot: 200, heroStack: 500, increment: 50,
  });
  // With a 100 limit you win the earlier 50 side pot and this street's 100.
  const capped = analyze(spot(100));
  assert.equal(capped.equity.callWinnings, 150);
  assert.equal(capped.study.callValue, 100);
  assert.equal(capped.study.title, 'Call beats fold under this model');
  // Without a limit they can win the whole earlier pot, so you only win this street.
  const whole = analyze(spot());
  assert.equal(whole.equity.callWinnings, 100);
  assert.equal(whole.study.callValue, 50);
  // They cannot act: raising is still open against the bettor, and sizing runs.
  assert.deepEqual(whole.actions.map(a => a.kind), ['fold', 'call', 'raise']);
  assert.equal(whole.sizing.players, 2);
});

test('a player all-in earlier stays in when you check or bet', () => {
  // Flop, no bet yet: one opponent all-in earlier, one with chips.
  const spot = snapshot({
    board: ['Qs', 'Js', '4d'],
    opponents: [seat(0, 0), seat(400, 0)],
    pot: 120, heroStack: 400, increment: 10,
  });
  const result = analyze(spot);
  assert.equal(result.study.title, 'Check is the baseline');
  const balanced = result.sizing.byStyle.balanced;
  // Only the player with chips can fold, so everyone folding never happens.
  assert.ok(balanced.options.filter(o => o.kind === 'bet').every(o => o.foldChance === 0));
  // A heads-up spot with the only opponent all-in earlier has no decision.
  assert.throws(() => analyze(snapshot({ opponents: [seat(0)] })), /no decision/);
});
