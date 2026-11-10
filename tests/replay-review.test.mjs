// Independent review coverage for the heads-up Hold’em replay reducer.
// The expectations below were traced by hand or come from a separate reference
// model in this file. They do not reuse the reducer's internal helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/core/analyze.js';
import { holdem } from '../dist/rules/holdem.js';
import {
  amountToCall, applyHoldemEvent, replayHoldem, startHoldemReplay, toHoldemSnapshot,
} from '../dist/rules/holdem-replay.js';

const act = (kind, seat) => ({ kind, seat });
const raise = (seat, to) => ({ kind: 'raise', seat, to });
const bet = (seat, to) => ({ kind: 'bet', seat, to });
const deal = (...cards) => ({ kind: 'deal', cards });

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function view(state) {
  return {
    street: state.street, phase: state.phase, actor: state.actor, pot: state.pot,
    stacks: [...state.stacks], committed: [...state.committed], minIncrement: state.minIncrement,
    toCall: amountToCall(state),
  };
}

// ---------------------------------------------------------------------------
// Hand traced by hand: button on seat 1, blinds 1/2, 200 chips each.
// Seat 1 is button and small blind. Seat 0 is big blind and acts first after the flop.
// ---------------------------------------------------------------------------
const reversedConfig = {
  purpose: 'simulation', button: 1, startingStack: 200, smallBlind: 1, bigBlind: 2,
  holeCards: [['Qd', 'Qc'], ['Ah', 'Kh']],
};

const tracedHand = [
  // [event, expected state after the event]
  [null, { street: 'preflop', phase: 'betting', actor: 1, pot: 3, stacks: [198, 199], committed: [2, 1], minIncrement: 2, toCall: 1 }],
  [raise(1, 6), { street: 'preflop', phase: 'betting', actor: 0, pot: 8, stacks: [198, 194], committed: [2, 6], minIncrement: 4, toCall: 4 }],
  [raise(0, 18), { street: 'preflop', phase: 'betting', actor: 1, pot: 24, stacks: [182, 194], committed: [18, 6], minIncrement: 12, toCall: 12 }],
  [act('call', 1), { street: 'preflop', phase: 'awaiting-board', actor: null, pot: 36, stacks: [182, 182], committed: [18, 18], minIncrement: 12, toCall: null }],
  [deal('Kc', '7s', '2d'), { street: 'flop', phase: 'betting', actor: 0, pot: 36, stacks: [182, 182], committed: [0, 0], minIncrement: 2, toCall: 0 }],
  [act('check', 0), { street: 'flop', phase: 'betting', actor: 1, pot: 36, stacks: [182, 182], committed: [0, 0], minIncrement: 2, toCall: 0 }],
  [bet(1, 20), { street: 'flop', phase: 'betting', actor: 0, pot: 56, stacks: [182, 162], committed: [0, 20], minIncrement: 20, toCall: 20 }],
  [raise(0, 60), { street: 'flop', phase: 'betting', actor: 1, pot: 116, stacks: [122, 162], committed: [60, 20], minIncrement: 40, toCall: 40 }],
  [act('call', 1), { street: 'flop', phase: 'awaiting-board', actor: null, pot: 156, stacks: [122, 122], committed: [60, 60], minIncrement: 40, toCall: null }],
  [deal('9s'), { street: 'turn', phase: 'betting', actor: 0, pot: 156, stacks: [122, 122], committed: [0, 0], minIncrement: 2, toCall: 0 }],
  [bet(0, 2), { street: 'turn', phase: 'betting', actor: 1, pot: 158, stacks: [120, 122], committed: [2, 0], minIncrement: 2, toCall: 2 }],
  [raise(1, 4), { street: 'turn', phase: 'betting', actor: 0, pot: 162, stacks: [120, 118], committed: [2, 4], minIncrement: 2, toCall: 2 }],
  [act('call', 0), { street: 'turn', phase: 'awaiting-board', actor: null, pot: 164, stacks: [118, 118], committed: [4, 4], minIncrement: 2, toCall: null }],
  [deal('3h'), { street: 'river', phase: 'betting', actor: 0, pot: 164, stacks: [118, 118], committed: [0, 0], minIncrement: 2, toCall: 0 }],
  [act('check', 0), { street: 'river', phase: 'betting', actor: 1, pot: 164, stacks: [118, 118], committed: [0, 0], minIncrement: 2, toCall: 0 }],
  [bet(1, 118), { street: 'river', phase: 'betting', actor: 0, pot: 282, stacks: [118, 0], committed: [0, 118], minIncrement: 118, toCall: 118 }],
  [act('call', 0), { street: 'river', phase: 'showdown', actor: null, pot: 400, stacks: [0, 0], committed: [118, 118], minIncrement: 118, toCall: null }],
];

test('hand-traced reversed-button hand matches at every step', () => {
  let state = startHoldemReplay(reversedConfig);
  const events = [];
  for (const [index, [event, expected]] of tracedHand.entries()) {
    if (event) {
      state = applyHoldemEvent(state, event);
      events.push(event);
    }
    assert.deepEqual(view(state), expected, 'step ' + index + ' ' + JSON.stringify(event));
    assert.equal(state.pot + state.stacks[0] + state.stacks[1], 400, 'chips conserved at step ' + index);
  }
  assert.deepEqual(state.board, ['Kc', '7s', '2d', '9s', '3h']);
  assert.equal(state.foldWinner, null);
  assert.deepEqual(replayHoldem(reversedConfig, events), state);
});

test('hand-traced hand rejects the near-miss sizes at each raise', () => {
  const states = [startHoldemReplay(reversedConfig)];
  for (const [event] of tracedHand.slice(1)) states.push(applyHoldemEvent(states.at(-1), event));
  // The preflop open to 6 has increment 4, so the smallest 3-bet is 10.
  assert.throws(() => applyHoldemEvent(states[1], raise(0, 9)), /full raise between 10 and 200/);
  assert.equal(applyHoldemEvent(states[1], raise(0, 10)).minIncrement, 4);
  // The 3-bet to 18 has increment 12, so the smallest 4-bet is 30.
  assert.throws(() => applyHoldemEvent(states[2], raise(1, 29)), /between 30 and 200/);
  assert.equal(applyHoldemEvent(states[2], raise(1, 30)).minIncrement, 12);
  // The flop bet of 20 means the smallest check-raise is 40.
  assert.throws(() => applyHoldemEvent(states[6], raise(0, 39)), /between 40 and 182/);
  // The flop raise to 60 has increment 40, so the smallest re-raise is 100.
  assert.throws(() => applyHoldemEvent(states[7], raise(1, 99)), /between 100 and 182/);
  // The minimum turn bet is one big blind.
  assert.throws(() => applyHoldemEvent(states[9], bet(0, 1)), /between 2 and 122/);
  assert.throws(() => applyHoldemEvent(states[9], raise(0, 2)), /Use bet/);
  // The river all-in leaves no raise for the caller.
  assert.throws(() => applyHoldemEvent(states[15], raise(0, 118)), /all-in opponent/);
  assert.throws(() => applyHoldemEvent(states[15], act('check', 0)), /facing a wager/);
});

test('analyzer snapshots take the acting seat perspective in the traced hand', () => {
  const states = [startHoldemReplay(reversedConfig)];
  for (const [event] of tracedHand.slice(1)) states.push(applyHoldemEvent(states.at(-1), event));

  // Preflop, seat 1 (button) faces the 3-bet.
  const facing3Bet = toHoldemSnapshot(states[2]);
  assert.deepEqual(facing3Bet, {
    version: 2, ruleset: 'holdem-nl', purpose: 'simulation',
    hero: ['Ah', 'Kh'], board: [],
    opponents: [{ stack: 182, committed: 18, cards: ['Qd', 'Qc'] }],
    pot: 24, heroStack: 194, committed: 6, increment: 12,
  });
  assert.deepEqual(holdem.legalActions(facing3Bet), [
    { kind: 'fold' }, { kind: 'call', cost: 12 },
    { kind: 'raise', minTo: 30, maxTo: 200, short: false },
  ]);

  // Flop, seat 0 (big blind) acts first with no wager.
  const flopLead = toHoldemSnapshot(states[4]);
  assert.deepEqual(flopLead.hero, ['Qd', 'Qc']);
  assert.deepEqual(flopLead.opponents[0].cards, ['Ah', 'Kh']);
  assert.equal(flopLead.opponents[0].committed - flopLead.committed, 0);
  assert.deepEqual(holdem.legalActions(flopLead), [
    { kind: 'check' }, { kind: 'bet', minTo: 2, maxTo: 182, short: false },
  ]);

  // River, seat 0 faces an all-in and can only fold or call.
  const facingShove = toHoldemSnapshot(states[15]);
  assert.equal(facingShove.heroStack, 118);
  assert.equal(facingShove.opponents[0].stack, 0);
  assert.equal(facingShove.opponents[0].committed - facingShove.committed, 118);
  assert.equal(facingShove.pot, 282);
  const result = analyze(facingShove);
  assert.deepEqual(result.actions, [{ kind: 'fold' }, { kind: 'call', cost: 118 }]);
  // QQ on Kc 7s 2d 9s 3h loses to AK, so call loses to fold.
  assert.equal(result.equity.share, 0);
  assert.equal(result.study.callValue, -118);
  assert.equal(result.study.title, 'Fold beats call under this model');

  // Snapshot hero matches the actor for both seats in every betting state.
  for (const state of states.filter(s => s.actor !== null)) {
    const snapshot = toHoldemSnapshot(state);
    assert.deepEqual(snapshot.hero, reversedConfig.holeCards[state.actor]);
    assert.equal(snapshot.heroStack, state.stacks[state.actor]);
    assert.equal(snapshot.committed, state.committed[state.actor]);
    assert.equal(snapshot.opponents[0].committed - snapshot.committed, amountToCall(state));
  }
});

// ---------------------------------------------------------------------------
// Big blind option after a limp, for both button seats and uneven blinds.
// ---------------------------------------------------------------------------
for (const button of [0, 1]) {
  const bb = 1 - button;
  const config = { purpose: 'completed', button, startingStack: 500, smallBlind: 2, bigBlind: 5 };

  test('button ' + button + ': limp gives the big blind an option, then the big blind leads postflop', () => {
    const limped = replayHoldem(config, [act('call', button)]);
    assert.equal(limped.phase, 'betting');
    assert.equal(limped.actor, bb);
    assert.equal(amountToCall(limped), 0);
    assert.deepEqual(limped.committed, [5, 5]);
    assert.equal(limped.pot, 10);
    assert.throws(() => applyHoldemEvent(limped, act('fold', bb)), /only when facing a wager/);
    assert.throws(() => applyHoldemEvent(limped, bet(bb, 10)), /Use raise/);
    assert.throws(() => applyHoldemEvent(limped, raise(bb, 9)), /between 10 and 500/);
    assert.throws(() => applyHoldemEvent(limped, act('check', button)), /out of turn/);

    const checked = applyHoldemEvent(limped, act('check', bb));
    assert.equal(checked.phase, 'awaiting-board');
    const flop = applyHoldemEvent(checked, deal('2c', '3d', '4h'));
    assert.equal(flop.actor, bb);
    assert.throws(() => applyHoldemEvent(flop, act('check', button)), /out of turn/);
    const flopChecked = applyHoldemEvent(applyHoldemEvent(flop, act('check', bb)), act('check', button));
    assert.equal(flopChecked.phase, 'awaiting-board');
    assert.equal(flopChecked.pot, 10);
  });

  test('button ' + button + ': option raise, minimum re-raise, and a call that closes preflop', () => {
    const optionRaise = replayHoldem(config, [act('call', button), raise(bb, 10)]);
    assert.equal(optionRaise.actor, button);
    assert.equal(optionRaise.minIncrement, 5);
    assert.equal(amountToCall(optionRaise), 5);
    // The button's raise must be at least 10 + 5 = 15.
    assert.throws(() => applyHoldemEvent(optionRaise, raise(button, 14)), /between 15 and 500/);
    const reRaise = applyHoldemEvent(optionRaise, raise(button, 15));
    assert.equal(reRaise.minIncrement, 5);
    assert.equal(reRaise.actor, bb);
    // The big blind's call must close preflop. It is not a limp.
    const closed = applyHoldemEvent(reRaise, act('call', bb));
    assert.equal(closed.phase, 'awaiting-board');
    assert.equal(closed.pot, 30);
    // The button's call of the option raise must also close preflop.
    const called = applyHoldemEvent(optionRaise, act('call', button));
    assert.equal(called.phase, 'awaiting-board');
    assert.equal(called.pot, 20);
    assert.equal(called.stacks[0] + called.stacks[1] + called.pot, 1000);
  });

  test('button ' + button + ': uneven blinds use the big blind as the first full raise increment', () => {
    const start = startHoldemReplay(config);
    assert.equal(amountToCall(start), 3);
    assert.throws(() => applyHoldemEvent(start, raise(button, 9)), /between 10 and 500/);
    const opened = applyHoldemEvent(start, raise(button, 10));
    assert.equal(opened.minIncrement, 5);
    assert.equal(opened.pot, 15);
    assert.equal(opened.stacks[button], 490);
    assert.equal(opened.stacks[bb], 495);
  });
}

// ---------------------------------------------------------------------------
// Separate reference model, written from TDA-style rules rather than the reducer.
// Betting closes when both seats have acted since the last aggression and
// commitments match. Blinds do not count as acting.
// ---------------------------------------------------------------------------
function refStart({ button, startingStack, smallBlind, bigBlind }) {
  const bb = 1 - button;
  const contributed = [0, 0];
  contributed[button] = smallBlind;
  contributed[bb] = bigBlind;
  return {
    button, startingStack, bigBlind, street: 0, phase: 'betting', actor: button,
    contributed, streetIn: [...contributed], acted: [false, false], increment: bigBlind,
    board: [], foldWinner: null,
  };
}

const streetNames = ['preflop', 'flop', 'turn', 'river'];
const refStack = (r, seat) => r.startingStack - r.contributed[seat];
const refPot = r => r.contributed[0] + r.contributed[1];

function refLegal(r) {
  const seat = r.actor;
  const opp = 1 - seat;
  const faced = r.streetIn[opp] - r.streetIn[seat];
  const legal = { fold: faced > 0, check: faced === 0, call: faced > 0, aggressive: null };
  const min = r.streetIn[opp] + r.increment;
  const max = r.streetIn[seat] + refStack(r, seat);
  if (refStack(r, opp) > 0 && min <= max) {
    legal.aggressive = { kind: r.streetIn[opp] > 0 ? 'raise' : 'bet', min, max };
  }
  return legal;
}

function refCloseIfDone(r) {
  if (r.acted[0] && r.acted[1] && r.streetIn[0] === r.streetIn[1]) {
    r.actor = null;
    r.phase = r.street === 3 ? 'showdown' : 'awaiting-board';
  }
}

function refApply(r0, event) {
  const r = structuredClone(r0);
  if (event.kind === 'deal') {
    r.street += 1;
    r.board.push(...event.cards);
    r.streetIn = [0, 0];
    r.acted = [false, false];
    r.increment = r.bigBlind;
    r.actor = 1 - r.button;
    r.phase = 'betting';
    if (refStack(r, 0) === 0 || refStack(r, 1) === 0) {
      r.actor = null;
      r.phase = r.street === 3 ? 'showdown' : 'awaiting-board';
    }
    return r;
  }
  const seat = event.seat;
  const opp = 1 - seat;
  const pay = to => {
    r.contributed[seat] += to - r.streetIn[seat];
    r.streetIn[seat] = to;
  };
  r.acted[seat] = true;
  switch (event.kind) {
    case 'fold':
      r.phase = 'folded';
      r.actor = null;
      r.foldWinner = opp;
      return r;
    case 'check':
      break;
    case 'call':
      pay(r.streetIn[opp]);
      break;
    default:
      r.increment = event.to - r.streetIn[opp];
      pay(event.to);
      r.acted[opp] = false;
  }
  r.actor = opp;
  refCloseIfDone(r);
  return r;
}

function refView(r) {
  return {
    street: streetNames[r.street], phase: r.phase, actor: r.actor, pot: refPot(r),
    stacks: [refStack(r, 0), refStack(r, 1)], committed: [...r.streetIn], minIncrement: r.increment,
    toCall: r.actor === null ? null : r.streetIn[1 - r.actor] - r.streetIn[r.actor],
  };
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(cards, random) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function chooseEvent(r, random) {
  const legal = refLegal(r);
  const seat = r.actor;
  const options = [];
  if (legal.check) options.push(act('check', seat), act('check', seat));
  if (legal.call) options.push(act('call', seat), act('call', seat));
  if (legal.fold && random() < 0.3) options.push(act('fold', seat));
  if (legal.aggressive) {
    const { kind, min, max } = legal.aggressive;
    const pick = random();
    const to = pick < 0.4 ? min : pick < 0.6 ? max : min + Math.floor(random() * (max - min + 1));
    options.push({ kind, seat, to });
  }
  return options[Math.floor(random() * options.length)];
}

function illegalProbes(r) {
  const seat = r.actor;
  const opp = 1 - seat;
  const legal = refLegal(r);
  const probes = [act('check', opp), deal('2c')];
  if (!legal.check) probes.push(act('check', seat));
  if (!legal.call) probes.push(act('call', seat));
  if (!legal.fold) probes.push(act('fold', seat));
  const wrongKind = r.streetIn[opp] > 0 ? 'bet' : 'raise';
  const rightKind = wrongKind === 'bet' ? 'raise' : 'bet';
  probes.push({ kind: wrongKind, seat, to: r.streetIn[seat] + refStack(r, seat) });
  if (legal.aggressive) {
    probes.push({ kind: rightKind, seat, to: legal.aggressive.min - 1 });
    probes.push({ kind: rightKind, seat, to: legal.aggressive.max + 1 });
    probes.push({ kind: rightKind, seat, to: legal.aggressive.min + 0.5 });
  } else {
    probes.push({ kind: rightKind, seat, to: r.streetIn[seat] + refStack(r, seat) });
  }
  return probes;
}

const structures = [
  { startingStack: 100, smallBlind: 1, bigBlind: 2 },
  { startingStack: 1000, smallBlind: 5, bigBlind: 10 },
  { startingStack: 37, smallBlind: 2, bigBlind: 5 },
  { startingStack: 3, smallBlind: 1, bigBlind: 2 },
  { startingStack: 7, smallBlind: 1, bigBlind: 3 },
];

test('seeded random hands match the reference model, conserve chips, and reject illegal events', () => {
  const random = mulberry32(20261109);
  let hands = 0;
  let events = 0;
  const terminals = { folded: 0, showdown: 0 };
  for (let round = 0; round < 60; round++) {
    for (const structure of structures) {
      for (const button of [0, 1]) {
        const deck = shuffled(holdem.deck, random);
        const holeCards = [deck.slice(0, 2), deck.slice(2, 4)];
        let next = 4;
        const config = { purpose: 'simulation', button, holeCards, ...structure };
        const total = 2 * structure.startingStack;
        let state = startHoldemReplay(config);
        let ref = refStart(config);
        const history = [];
        while (state.phase !== 'folded' && state.phase !== 'showdown') {
          let event;
          if (ref.phase === 'awaiting-board') {
            const count = ref.street === 0 ? 3 : 1;
            event = deal(...deck.slice(next, next + count));
            next += count;
          } else {
            const frozen = deepFreeze(structuredClone(state));
            for (const probe of illegalProbes(ref)) {
              assert.throws(() => applyHoldemEvent(frozen, probe), Error, JSON.stringify(probe));
            }
            assert.deepEqual(frozen, state);
            // The acting seat's analyzer view mirrors the reducer state.
            const snapshot = toHoldemSnapshot(state);
            assert.deepEqual(snapshot.hero, holeCards[state.actor]);
            assert.deepEqual(snapshot.opponents[0].cards, holeCards[1 - state.actor]);
            assert.equal(snapshot.opponents[0].committed - snapshot.committed, amountToCall(state));
            assert.equal(snapshot.pot, refPot(ref));
            event = chooseEvent(ref, random);
          }
          state = applyHoldemEvent(state, event);
          ref = refApply(ref, event);
          history.push(event);
          events++;
          const context = JSON.stringify({ config, history });
          assert.deepEqual(view(state), refView(ref), context);
          assert.equal(state.foldWinner, ref.foldWinner, context);
          assert.deepEqual(state.board, ref.board, context);
          assert.equal(state.pot + state.stacks[0] + state.stacks[1], total, context);
          assert.ok(state.stacks.every(stack => stack >= 0), context);
          assert.ok(state.committed.every(c => c >= 0 && c <= state.pot), context);
        }
        assert.deepEqual(replayHoldem(config, history), state);
        terminals[state.phase]++;
        hands++;
      }
    }
  }
  assert.equal(hands, 600);
  assert.ok(events > 3000, 'enough events exercised: ' + events);
  assert.ok(terminals.folded > 50 && terminals.showdown > 50, JSON.stringify(terminals));
});

// ---------------------------------------------------------------------------
// Documented limits from REPLAY.md. These pin current behavior so a future
// change to these limits is deliberate. They are not bugs.
// ---------------------------------------------------------------------------
test('documented limit: a short stack cannot move all-in below a full raise', () => {
  // 100 chips, 1/2. Button raises to 65, so a full re-raise needs 128 but the
  // big blind has only 100 total.
  const config = { purpose: 'simulation', button: 0, startingStack: 100, smallBlind: 1, bigBlind: 2 };
  const facing = replayHoldem(config, [raise(0, 65)]);
  assert.throws(() => applyHoldemEvent(facing, raise(1, 100)), /between 128 and 100/);
  // After a preflop call to 99, a single chip each cannot open the flop.
  const flop = replayHoldem(config, [raise(0, 99), act('call', 1), deal('2c', '3d', '4h')]);
  assert.equal(flop.phase, 'betting');
  assert.deepEqual(flop.stacks, [1, 1]);
  assert.throws(() => applyHoldemEvent(flop, bet(1, 1)), /between 2 and 1/);
});

test('documented limit: the analyzer still lists a short all-in raise that replay rejects', () => {
  const config = {
    purpose: 'simulation', button: 0, startingStack: 100, smallBlind: 1, bigBlind: 2,
    holeCards: [['As', 'Ks'], ['Qh', 'Qd']],
  };
  const facing = replayHoldem(config, [raise(0, 65)]);
  const raiseAction = holdem.legalActions(toHoldemSnapshot(facing)).find(a => a.kind === 'raise');
  assert.deepEqual(raiseAction, { kind: 'raise', minTo: 100, maxTo: 100, short: true });
});

test('documented limit: uncalled chips stay in the pot after a fold', () => {
  const config = { purpose: 'completed', button: 1, startingStack: 100, smallBlind: 1, bigBlind: 2 };
  const folded = replayHoldem(config, [raise(1, 6), act('fold', 0)]);
  assert.equal(folded.foldWinner, 1);
  assert.equal(folded.pot, 8);
  assert.deepEqual(folded.stacks, [98, 94]);
  assert.equal(folded.pot + folded.stacks[0] + folded.stacks[1], 200);
});

test('documented limit: blind all-ins and unequal stacks are rejected at the start', () => {
  const base = { purpose: 'simulation', button: 0, smallBlind: 1, bigBlind: 2 };
  assert.throws(() => startHoldemReplay({ ...base, startingStack: 2 }), /small blind < big blind < starting stack/);
  assert.throws(() => startHoldemReplay({ ...base, startingStack: 100, smallBlind: 2 }), /small blind < big blind/);
  assert.throws(() => startHoldemReplay({ ...base, startingStack: 100, button: 2 }), /button seat/);
});
