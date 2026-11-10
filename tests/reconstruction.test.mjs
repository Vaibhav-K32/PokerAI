// Multi-screenshot hand reconstruction: ordering, batch recognition, the
// difference engine, reconstruction of intervals, manual resolution through
// the hand engine, timeline navigation, sessions, and history compatibility.
// Every recognition comes from deterministic fixtures; no paid API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCursor } from '../dist/history/cursor.js';
import { applyHandEvent, createHandState, replayHand, replaySteps } from '../dist/history/engine.js';
import { buildEvents, createHistory, settlementSpecs } from '../dist/history/history.js';
import { fixtureProvider } from '../dist/vision/providers.js';
import { drawTable } from '../dist/vision/screenshot-fixtures.js';
import { corrected, correctedCard, moveSeat, parseScreenshotResponse, seatMoveMap } from '../dist/vision/screenshot.js';
import { alignSeats, compareObservations } from '../dist/reconstruction/compare.js';
import { SEQUENCE_FIXTURES, sequenceById } from '../dist/reconstruction/fixtures.js';
import {
  createObservation, fieldConfidence, middleChips, restoreObservation, tableChips, withRecognition,
} from '../dist/reconstruction/observation.js';
import { RecognitionQueue } from '../dist/reconstruction/queue.js';
import { matchHistory, reconstructHand } from '../dist/reconstruction/reconstruct.js';
import { checkActions, checkpointState } from '../dist/reconstruction/resolve.js';
import {
  addScreenshots, createSession, liveResolutions, moveScreenshot, parseSession, remapActionSeats, removeScreenshot, sequenceObservations,
  serializeSession, setResolution, uploadOrder,
} from '../dist/reconstruction/session.js';
import { MAX_SCREENSHOTS } from '../dist/reconstruction/types.js';

const recognitionOf = frame => parseScreenshotResponse(frame.response, 'fixture');
const observationsOf = id => sequenceById(id).frames.map((f, i) => createObservation('shot-' + id + '-' + i, i, recognitionOf(f)));
const at = '2026-03-01T10:00:00.000Z';
const action = (id, seat, type, to) => ({ id, seat, type, ...(to !== undefined ? { to } : {}), confirmedAt: at });
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
const setPlayer = (rec, i, change) => ({ ...rec, players: rec.players.map((p, k) => (k === i ? change(p) : p)) });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

test('five synthetic sequences cover the required scenarios and draw self-contained frames', () => {
  assert.deepEqual(SEQUENCE_FIXTURES.map(s => s.id), ['complete-hand', 'missing-street', 'ambiguous-betting', 'recognition-error', 'multiway-all-in']);
  assert.equal(sequenceById('complete-hand').frames.length, 5);
  for (const seq of SEQUENCE_FIXTURES) {
    for (const frame of seq.frames) {
      assert.doesNotMatch(drawTable(frame.table), /href=|<image|<script/);
      assert.doesNotThrow(() => recognitionOf(frame));
    }
  }
});

test('the multiway all-in fixture matches the hand engine’s side-pot settlement', () => {
  const setup = {
    handId: 'allin', smallBlind: 10, bigBlind: 20, ante: 0, dealer: 2,
    players: [
      { id: 'you', name: 'You', stack: 500, cards: ['Kc', 'Kh'] },
      { id: 'ash', name: 'Ash', stack: 200, cards: ['Qs', 'Qd'] },
      { id: 'blake', name: 'Blake', stack: 1000, cards: ['9c', '9d'] },
    ],
  };
  const specs = [
    ['HAND_STARTED', {}], ['SMALL_BLIND_POSTED', { playerId: 'you', amount: 10 }], ['BIG_BLIND_POSTED', { playerId: 'ash', amount: 20 }],
    ['PLAYER_RAISED', { playerId: 'blake', to: 60 }], ['PLAYER_ALL_IN', { playerId: 'you', amount: 490 }],
    ['PLAYER_ALL_IN', { playerId: 'ash', amount: 180 }], ['PLAYER_CALLED', { playerId: 'blake', amount: 440 }],
    ['FLOP_DEALT', { cards: ['2s', '5h', 'Qc'] }], ['TURN_DEALT', { card: '8d' }], ['RIVER_DEALT', { card: '3c' }],
  ];
  const state = replayHand(createHandState(setup), buildEvents(setup, specs));
  const final = replayHand(createHandState(setup), buildEvents(setup, [...specs, ...settlementSpecs(state)]));
  const last = recognitionOf(sequenceById('multiway-all-in').frames[2]);
  assert.deepEqual(final.players.map(p => p.stack), last.players.map(p => p.stack.value));
  assert.deepEqual(final.pots.map(p => p.amount), [600, 600]);
});

// ---------------------------------------------------------------------------
// Upload and ordering
// ---------------------------------------------------------------------------

test('multi-image upload assigns stable IDs, keeps upload order, and stops at the limit', () => {
  let n = 0;
  const makeId = () => 'id-' + ++n;
  const first = addScreenshots([], ['z-last.png', 'a-first.png', 'm.png'], makeId);
  assert.deepEqual(first.list.map(s => [s.id, s.label, s.uploadIndex]), [['id-1', 'z-last.png', 0], ['id-2', 'a-first.png', 1], ['id-3', 'm.png', 2]]);
  assert.equal(first.skipped, 0);
  const many = addScreenshots(first.list, Array.from({ length: 30 }, (_, i) => 'f' + i + '.png'), makeId);
  assert.equal(many.list.length, MAX_SCREENSHOTS);
  assert.equal(many.skipped, 30 - (MAX_SCREENSHOTS - 3));
  assert.equal(addScreenshots(first.list, ['x', 'y'], makeId, 4).list.length, 4);
});

test('screenshots can be reordered and removed without relying on filenames, and upload order is recoverable', () => {
  const { list } = addScreenshots([], ['3.png', '1.png', '2.png'], (() => { let n = 0; return () => 's' + n++; })());
  const moved = moveScreenshot(list, 's1', 0);
  assert.deepEqual(moved.map(s => s.label), ['1.png', '3.png', '2.png']);
  assert.deepEqual(moveScreenshot(moved, 's2', 99).map(s => s.id), ['s1', 's0', 's2']);
  assert.deepEqual(uploadOrder(moved).map(s => s.id), ['s0', 's1', 's2']);
  assert.deepEqual(removeScreenshot(moved, 's0').map(s => s.id), ['s1', 's2']);
  assert.deepEqual(list.map(s => s.id), ['s0', 's1', 's2'], 'inputs are not mutated');

  const obs = new Map(list.map((s, i) => [s.id, createObservation(s.id, i, recognitionOf(sequenceById('complete-hand').frames[i]))]));
  const sequenced = sequenceObservations(moved, obs);
  assert.deepEqual(sequenced.map(o => [o.screenshotId, o.sequenceIndex]), [['s1', 0], ['s0', 1], ['s2', 2]]);
  assert.equal(sequenced[2], obs.get('s2'), 'unchanged observations keep their identity');
});

// ---------------------------------------------------------------------------
// Batch recognition
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('batch recognition runs with bounded concurrency and reports progress', async () => {
  const pending = new Map();
  let running = 0;
  let peak = 0;
  const results = [];
  const queue = new RecognitionQueue({
    concurrency: 2,
    run: async id => {
      running++;
      peak = Math.max(peak, running);
      const d = deferred();
      pending.set(id, d);
      const outcome = await d.promise;
      running--;
      return outcome;
    },
    onRecognized: id => results.push(id),
  });
  queue.enqueue(['a', 'b', 'c', 'd']);
  await tick();
  assert.deepEqual(queue.progress().processing, ['a', 'b']);
  assert.equal(queue.progress().queued, 2);
  const rec = recognitionOf(sequenceById('complete-hand').frames[0]);
  for (const id of ['a', 'b', 'c', 'd']) {
    while (!pending.has(id)) await tick();
    pending.get(id).resolve({ kind: 'recognized', recognition: rec });
    await tick();
  }
  await tick();
  assert.equal(peak, 2);
  assert.deepEqual(results, ['a', 'b', 'c', 'd']);
  assert.deepEqual({ ...queue.progress(), processing: [] }, { total: 4, done: 4, queued: 0, processing: [], failed: 0, cancelled: 0 });
  assert.equal(queue.busy, false);
});

test('a failed screenshot can be retried alone, and recognized ones are never sent again', async () => {
  const calls = [];
  let failB = true;
  const rec = recognitionOf(sequenceById('complete-hand').frames[0]);
  const queue = new RecognitionQueue({
    run: async id => {
      calls.push(id);
      if (id === 'b' && failB) return { kind: 'failed', reason: 'Recognition took too long. Try again.', retryable: true };
      return { kind: 'recognized', recognition: rec };
    },
    onRecognized: () => {},
  });
  queue.enqueue(['a', 'b', 'c']);
  while (queue.busy) await tick();
  assert.deepEqual(queue.status('b'), { status: 'failed', attempts: 1, error: 'Recognition took too long. Try again.', retryable: true });
  assert.equal(queue.progress().failed, 1);
  queue.enqueue(['a', 'b', 'c']); // unchanged screenshots: no duplicate requests
  await tick();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  failB = false;
  queue.retry('b');
  queue.retry('a'); // already recognized: ignored
  while (queue.busy) await tick();
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
  assert.equal(queue.status('b').status, 'done');
  assert.equal(queue.status('b').attempts, 2);
});

test('stale results are dropped after a screenshot is removed or the batch is cancelled', async () => {
  const gates = new Map();
  const seen = [];
  const rec = recognitionOf(sequenceById('complete-hand').frames[0]);
  const queue = new RecognitionQueue({
    concurrency: 3,
    run: id => { const d = deferred(); gates.set(id, d); return d.promise; },
    onRecognized: id => seen.push(id),
  });
  queue.enqueue(['a', 'b', 'c']);
  await tick();
  queue.remove('a');
  queue.cancelAll();
  for (const d of gates.values()) d.resolve({ kind: 'recognized', recognition: rec });
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(queue.status('a'), undefined);
  assert.equal(queue.status('b').status, 'cancelled');
  queue.retry('b');
  await tick();
  gates.get('b').resolve({ kind: 'recognized', recognition: rec });
  await tick();
  assert.deepEqual(seen, ['b']);
});

test('the fixture provider plugs into the batch queue', async () => {
  const frames = sequenceById('missing-street').frames;
  const got = new Map();
  const queue = new RecognitionQueue({
    run: (id, signal) => fixtureProvider(frames[Number(id)].response).recognize(new Blob(['x']), signal),
    onRecognized: (id, recognition) => got.set(id, recognition),
  });
  queue.enqueue(['0', '1']);
  while (queue.busy) await tick();
  assert.deepEqual([...got.keys()].sort(), ['0', '1']);
  assert.equal(got.get('1').communityCards.length, 4);
});

// ---------------------------------------------------------------------------
// Observations and the difference engine
// ---------------------------------------------------------------------------

test('observations keep unknowns, confidence labels, sources, and sequence; no timestamps are invented', () => {
  const [a, b] = observationsOf('ambiguous-betting');
  assert.equal(b.timestamp, null);
  assert.equal(b.reviewStatus, 'pending');
  assert.equal(b.sequenceIndex, 1);
  assert.equal(b.recognition.players[1].stack.value, null);
  const conf = fieldConfidence(b.recognition);
  assert.equal(conf['players.0.stack'], 'high');
  assert.equal(conf['players.1.stack'], null);
  assert.equal(middleChips(a.recognition), 60);
  assert.equal(tableChips(b.recognition), null, 'unknown stacks are not filled in');
  const edited = withRecognition(b, setPlayer(b.recognition, 1, p => ({ ...p, stack: corrected(950) })));
  assert.equal(edited.reviewStatus, 'corrected');
  assert.equal(edited.recognition.players[1].stack.source, 'corrected');
});

test('community cards progress street by street, and skipped streets are flagged', () => {
  const obs = observationsOf('complete-hand');
  const flop = compareObservations(obs[0], obs[1]).find(d => d.kind === 'board-dealt');
  assert.equal(flop.label, 'Flop dealt: 7s 8d 2c.');
  assert.equal(flop.evidence, 'observed');
  assert.equal(compareObservations(obs[1], obs[2]).find(d => d.kind === 'board-dealt').label, 'Turn dealt: Kh.');
  assert.equal(compareObservations(obs[2], obs[3]).find(d => d.kind === 'board-dealt').label, 'River dealt: 3d.');
  const [pre, turn] = observationsOf('missing-street');
  const skipped = compareObservations(pre, turn).find(d => d.kind === 'board-dealt');
  assert.equal(skipped.label, 'Flop and turn dealt: As 7d 2h 9c.');
  assert.match(skipped.warning, /betting on the skipped street is not shown/);
});

test('pot and stack differences carry previous and new values, observation IDs, and confidence', () => {
  const obs = observationsOf('complete-hand');
  const diffs = compareObservations(obs[1], obs[2]);
  const pot = diffs.find(d => d.kind === 'pot-changed');
  assert.deepEqual([pot.previous, pot.next, pot.fromObservation, pot.toObservation], [30, 70, obs[1].id, obs[2].id]);
  const riley = diffs.find(d => d.field === 'players.1.stack');
  assert.deepEqual([riley.previous, riley.next, riley.label], [990, 970, 'Riley’s stack fell from 990 to 970 (−20).']);
  assert.deepEqual(riley.confidence, { previous: 'high', next: 'high' });
  assert.ok(diffs.some(d => d.kind === 'status-changed' && d.label === 'Sam is shown as folded.'));
  const win = compareObservations(obs[3], obs[4]).find(d => d.field === 'players.0.stack');
  assert.equal(win.severity, 'review');
});

test('missing values are not changes: they are only reported as becoming visible or hidden', () => {
  const [a, b] = observationsOf('ambiguous-betting');
  const diffs = compareObservations(a, b);
  assert.ok(!diffs.some(d => d.kind === 'stack-changed'));
  assert.deepEqual(diffs.filter(d => d.kind === 'value-hidden').map(d => d.field), ['players.1.stack', 'players.2.stack']);
  const back = compareObservations(b, a).filter(d => d.kind === 'value-visible').map(d => d.field);
  assert.deepEqual(back, ['players.1.stack', 'players.2.stack']);
  // An unknown status is not a fold.
  const unknownStatus = { ...b, recognition: setPlayer(b.recognition, 2, p => ({ ...p, status: corrected(null) })) };
  assert.ok(!compareObservations(a, unknownStatus).some(d => d.kind === 'status-changed'));
});

test('seats are aligned by name, and a rotated view is reported rather than read as changes', () => {
  const [a, b] = observationsOf('complete-hand');
  const rotated = { ...b, recognition: { ...b.recognition, players: [b.recognition.players[1], b.recognition.players[2], b.recognition.players[0]], dealerSeat: corrected(1), heroSeat: corrected(2) } };
  assert.equal(alignSeats(a.recognition, rotated.recognition), 1);
  const diffs = compareObservations(a, rotated);
  assert.ok(diffs.some(d => d.kind === 'seats-moved' && d.severity === 'review'));
  assert.ok(!diffs.some(d => d.kind === 'dealer-moved'));
  assert.deepEqual(diffs.filter(d => d.kind === 'stack-changed').map(d => d.field), ['players.0.stack', 'players.2.stack']);
});

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

test('a complete hand reconstructs into checkpoints and intervals without inventing actions', () => {
  const result = reconstructHand(observationsOf('complete-hand'));
  assert.equal(result.checkpoints.length, 5);
  assert.deepEqual(result.timeline.map(e => e.kind), ['checkpoint', 'interval', 'checkpoint', 'interval', 'checkpoint', 'interval', 'checkpoint', 'interval', 'checkpoint']);
  assert.deepEqual(result.intervals.map(i => i.status), ['unresolved', 'unresolved', 'verified', 'unresolved']);
  assert.ok(result.intervals[2].confirmed.some(f => /only checks/.test(f.text)));
  assert.equal(result.intervals[1].middleChange, 40);
  for (const i of result.intervals) assert.equal(i.actionCheck, null);
  assert.equal(result.metrics.contradictions, 0);
  assert.deepEqual(result.globalContradictions, []);
});

test('ambiguous betting stays unresolved, with the required explanation and no events', () => {
  const result = reconstructHand(observationsOf('ambiguous-betting'));
  const [interval] = result.intervals;
  assert.equal(interval.status, 'unresolved');
  assert.equal(interval.possible[0].text, 'An additional 60 chips appear in the middle between these screenshots. The contributing actions are unknown.');
  assert.ok(interval.possible[0].alternatives.some(a => /Pat, Kim/.test(a)));
  assert.equal(interval.actionCheck, null);
  assert.equal(result.metrics.unresolvedIntervals, 1);
});

test('a missing street is reported as skipped betting, not filled in', () => {
  const [interval] = reconstructHand(observationsOf('missing-street')).intervals;
  assert.equal(interval.status, 'unresolved');
  assert.ok(interval.possible.some(p => p.text === 'More than one street was dealt between these screenshots.'));
  assert.equal(interval.middleChange, 65);
});

test('a misread card is a contradiction, and correcting it clears the contradiction', () => {
  const [a, b] = observationsOf('recognition-error');
  const result = reconstructHand([a, b]);
  assert.equal(result.intervals[0].status, 'contradiction');
  assert.match(result.intervals[0].contradictions[0].text, /Board card 3 changed from 7c to 7s/);
  assert.equal(result.metrics.contradictions, 1);
  const fixed = withRecognition(b, { ...b.recognition, communityCards: b.recognition.communityCards.map((c, i) => (i === 2 ? correctedCard('7c') : c)) });
  const after = reconstructHand([a, fixed]);
  assert.equal(after.intervals[0].status, 'verified');
  assert.equal(after.metrics.contradictions, 0);
  assert.equal(after.metrics.correctedFields, 1);
  assert.equal(fixed.reviewStatus, 'corrected');
});

test('duplicate cards are caught within a screenshot and across screenshots', () => {
  const [a, b] = observationsOf('complete-hand');
  const dup = { ...b, recognition: setPlayer(b.recognition, 0, p => ({ ...p, cards: [correctedCard('7s'), p.cards[1]] })) };
  const result = reconstructHand([a, dup]);
  assert.ok(result.checkpoints[1].contradictions.some(c => /7s appears 2 times/.test(c.text)));
  const later = { ...b, recognition: setPlayer(b.recognition, 1, p => ({ ...p, cards: [correctedCard('Qh'), correctedCard('2d')] })) };
  const cross = reconstructHand([a, later]);
  assert.ok(cross.globalContradictions.some(c => /Qh appears in your hand in frame 1 and in Riley’s hand in frame 2/.test(c.text)));
});

test('different-hand signs and chip conservation are flagged for review', () => {
  const [a, b] = observationsOf('complete-hand');
  const moved = { ...b, recognition: { ...b.recognition, dealerSeat: corrected(0), bigBlind: corrected(20) } };
  const interval = reconstructHand([a, moved]).intervals[0];
  assert.equal(interval.status, 'contradiction');
  assert.ok(interval.differentHandSigns.some(s => /dealer button moved/.test(s)));
  assert.ok(interval.differentHandSigns.some(s => /Blinds changed/.test(s)));
  const unfold = reconstructHand([observationsOf('complete-hand')[2], { ...b, sequenceIndex: 3, id: 'x' }]).intervals[0];
  assert.ok(unfold.contradictions.some(c => /was folded and is now shown in the hand/.test(c.text)));
  const extra = { ...b, recognition: setPlayer(b.recognition, 2, p => ({ ...p, stack: corrected(1500) })) };
  const chips = reconstructHand([a, extra]).intervals[0];
  assert.ok(chips.contradictions.some(c => c.field === 'chips' && /changed from 3000 to 3510/.test(c.text)));
  const split = reconstructHand([a, moved], { resolutions: [{ from: a.id, to: moved.id, mark: 'different-hands', actions: [] }] });
  assert.equal(split.intervals[0].status, 'different-hands');
  assert.equal(split.metrics.contradictions, 0);
});

test('an all-in runout is confirmed as having no further betting', () => {
  const result = reconstructHand(observationsOf('multiway-all-in'));
  assert.ok(result.intervals[1].confirmed.some(f => /ran out with no more betting/.test(f.text)));
  assert.ok(!result.intervals[1].possible.some(p => /More than one street/.test(p.text)));
  assert.ok(result.intervals[1].possible.some(p => /1200 chips left the middle/.test(p.text)));
});

// ---------------------------------------------------------------------------
// Manual resolution
// ---------------------------------------------------------------------------

test('confirmed actions are validated by the hand engine and can fully explain an interval', () => {
  const obs = observationsOf('complete-hand');
  // Flop: You check, Riley bets 20, Sam folds, You call.
  const actions = [action('a1', 0, 'check'), action('a2', 1, 'bet', 20), action('a3', 2, 'fold'), action('a4', 0, 'call')];
  const check = checkActions(obs[1], obs[2], actions);
  assert.equal(check.error, null);
  assert.deepEqual(check.unexplained, []);
  assert.equal(check.explains, true);
  assert.deepEqual(check.events.map(e => e.type), ['PLAYER_CHECKED', 'PLAYER_BET', 'PLAYER_FOLDED', 'PLAYER_CALLED']);
  assert.ok(check.events.every(e => e.timestamp === at), 'events carry the time they were confirmed');
  assert.equal(check.states.length, 5);
  const result = reconstructHand(obs, { resolutions: [{ from: obs[1].id, to: obs[2].id, mark: 'none', actions }] });
  assert.equal(result.intervals[1].status, 'resolved');
  assert.equal(result.metrics.verifiedTransitions, 2);
});

test('an invalid confirmed action is rejected with the engine’s reason', () => {
  const obs = observationsOf('complete-hand');
  const check = checkActions(obs[1], obs[2], [action('b1', 1, 'bet', 20), action('b2', 0, 'check')]);
  assert.equal(check.error.actionId, 'b2');
  assert.match(check.error.message, /Cannot check facing a bet of 20 chips/);
  assert.equal(check.events.length, 1);
  const tooSmall = checkActions(obs[1], obs[2], [action('c1', 1, 'bet', 5)]);
  assert.match(tooSmall.error.message, /at least 10 chips/);
  const result = reconstructHand(obs, { resolutions: [{ from: obs[1].id, to: obs[2].id, mark: 'none', actions: [action('b1', 1, 'bet', 20), action('b2', 0, 'check')] }] });
  assert.equal(result.intervals[1].status, 'partial');
});

test('partial actions leave the rest unexplained, and marking unresolved is allowed', () => {
  const obs = observationsOf('complete-hand');
  const check = checkActions(obs[1], obs[2], [action('d1', 1, 'bet', 20)]);
  assert.equal(check.error, null);
  assert.equal(check.explains, false);
  assert.ok(check.unexplained.some(u => /You put in 20 more chips/.test(u)));
  assert.ok(check.unexplained.some(u => /Sam folded, which is not entered/.test(u)));
  const marked = reconstructHand(obs, { resolutions: [{ from: obs[0].id, to: obs[1].id, mark: 'unresolved', actions: [] }] });
  assert.equal(marked.intervals[0].status, 'acknowledged');
  assert.equal(marked.intervals[0].summary, 'Marked as unresolved: the actions stay unknown.');
});

test('actions that close the round deal the next street from the later screenshot', () => {
  const obs = observationsOf('complete-hand');
  // Preflop: Sam calls, You complete, Riley checks. Then the flop from screenshot 2.
  const check = checkActions(obs[0], obs[1], [action('e1', 2, 'call'), action('e2', 0, 'call'), action('e3', 1, 'check')]);
  assert.equal(check.error, null);
  assert.equal(check.explains, true);
  const state = checkpointState(obs[1]);
  assert.equal(state.step, 'act');
  assert.equal(state.currentBet, 0);
  assert.equal(checkpointState(observationsOf('ambiguous-betting')[1]).error, 'Enter Pat’s stack and bet in screenshot 2 to check actions.');
});

test('resolved intervals produce events the history engine replays', () => {
  const obs = observationsOf('complete-hand');
  const check = checkActions(obs[1], obs[2], [action('a1', 0, 'check'), action('a2', 1, 'bet', 20), action('a3', 2, 'fold'), action('a4', 0, 'call')]);
  const start = checkpointState(obs[1]);
  let state = start;
  for (const e of check.events) {
    const actor = state.players.findIndex(p => p.id === e.payload.playerId);
    state = applyHandEvent({ ...state, actor }, e);
  }
  assert.deepEqual(state.players.map(p => p.stack), [970, 970, 990]);
});

// ---------------------------------------------------------------------------
// Timeline, determinism, immutability
// ---------------------------------------------------------------------------

test('timeline navigation moves between checkpoints', () => {
  const result = reconstructHand(observationsOf('complete-hand'));
  const last = result.checkpoints.length - 1;
  assert.equal(moveCursor(0, last, 'next'), 1);
  assert.equal(moveCursor(2, last, 'previous'), 1);
  assert.equal(moveCursor(2, last, 'first'), 0);
  assert.equal(moveCursor(2, last, 'last'), 4);
  assert.equal(moveCursor(2, last, 9), 4);
  const entry = result.timeline[2 * 3];
  assert.equal(entry.kind, 'checkpoint');
  assert.equal(entry.checkpoint.street, 'river');
});

test('reconstruction is deterministic and never mutates its inputs', () => {
  const obs = deepFreeze(observationsOf('complete-hand'));
  const resolutions = deepFreeze([{ from: obs[1].id, to: obs[2].id, mark: 'none', actions: [action('a1', 0, 'check')] }]);
  const shuffled = [obs[3], obs[0], obs[4], obs[2], obs[1]];
  const one = reconstructHand(shuffled, { resolutions });
  const two = reconstructHand(obs, { resolutions });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(one), JSON.stringify(reconstructHand(obs, { resolutions })));
});

// ---------------------------------------------------------------------------
// History compatibility
// ---------------------------------------------------------------------------

test('a reconstruction matches the recorded hand it came from, in order', () => {
  const setup = {
    handId: 'complete', smallBlind: 5, bigBlind: 10, ante: 0, dealer: 2,
    players: [
      { id: 'you', name: 'You', stack: 1000, cards: ['Qh', 'Qc'] },
      { id: 'riley', name: 'Riley', stack: 1000, cards: ['As', '9s'] },
      { id: 'sam', name: 'Sam', stack: 1000, cards: [null, null] },
    ],
  };
  const specs = [
    ['HAND_STARTED', {}], ['SMALL_BLIND_POSTED', { playerId: 'you', amount: 5 }], ['BIG_BLIND_POSTED', { playerId: 'riley', amount: 10 }],
    ['PLAYER_CALLED', { playerId: 'sam', amount: 10 }], ['PLAYER_CALLED', { playerId: 'you', amount: 5 }], ['PLAYER_CHECKED', { playerId: 'riley' }],
    ['FLOP_DEALT', { cards: ['7s', '8d', '2c'] }],
    ['PLAYER_CHECKED', { playerId: 'you' }], ['PLAYER_BET', { playerId: 'riley', to: 20 }], ['PLAYER_FOLDED', { playerId: 'sam' }], ['PLAYER_CALLED', { playerId: 'you', amount: 20 }],
    ['TURN_DEALT', { card: 'Kh' }], ['PLAYER_CHECKED', { playerId: 'you' }], ['PLAYER_CHECKED', { playerId: 'riley' }],
    ['RIVER_DEALT', { card: '3d' }], ['PLAYER_CHECKED', { playerId: 'you' }], ['PLAYER_BET', { playerId: 'riley', to: 50 }], ['PLAYER_CALLED', { playerId: 'you', amount: 50 }],
  ];
  let events = buildEvents(setup, specs);
  const settle = replayHand(createHandState(setup), events);
  events = buildEvents(setup, [...specs, ...settlementSpecs(settle)]);
  const history = createHistory(setup, events);
  const states = replaySteps(createHandState(setup), history.events);
  const obs = observationsOf('complete-hand');
  const match = matchHistory(states, obs);
  assert.ok(match);
  assert.equal(match.rotation, 0);
  assert.deepEqual(match.positions, [...match.positions].sort((x, y) => x - y));
  assert.equal(states[match.positions[1]].street, 'flop');
  assert.equal(match.positions.length, 5);
  // Out of order, the same screenshots cannot fit one hand.
  const swapped = [{ ...obs[3], sequenceIndex: 0 }, { ...obs[0], sequenceIndex: 1 }];
  assert.equal(matchHistory(states, swapped), null);
});

// ---------------------------------------------------------------------------
// Sessions: persistence, import, and export
// ---------------------------------------------------------------------------

function sessionFixture(extra = {}) {
  const obs = observationsOf('complete-hand');
  const screenshots = obs.map((o, i) => ({ id: o.screenshotId, label: 'frame ' + i + '.png', uploadIndex: i, image: 'data:image/jpeg;base64,AAAA' }));
  return createSession({
    id: 'rec-1', title: '  Study hand  ', createdAt: at, screenshots, observations: obs,
    resolutions: [{ from: obs[0].id, to: obs[1].id, mark: 'unresolved', actions: [], note: 'Missed the preflop action' }],
    ...extra,
  });
}

test('sessions round-trip through JSON and keep corrections, resolutions, and order', () => {
  const session = sessionFixture({ imagesSaved: true });
  assert.equal(session.title, 'Study hand');
  assert.equal(session.imagesSaved, true);
  const text = serializeSession(session);
  const back = parseSession(text);
  assert.deepEqual(back, session);
  assert.equal(back.resolutions[0].note, 'Missed the preflop action');
  assert.ok(back.warnings.length >= 0);
});

test('images are kept only when the user saves them', () => {
  const session = sessionFixture();
  assert.equal(session.imagesSaved, false);
  assert.ok(session.screenshots.every(s => s.image === undefined));
  assert.equal(parseSession(serializeSession(session)).screenshots.length, 5);
});

test('imported sessions are validated', () => {
  const good = JSON.parse(serializeSession(sessionFixture()));
  const reject = (change, pattern) => {
    const copy = structuredClone(good);
    change(copy);
    assert.throws(() => parseSession(copy), pattern);
  };
  assert.throws(() => parseSession('{not json'), /not valid JSON/);
  reject(c => { c.kind = 'other'; }, /not a Poker Study reconstruction/);
  reject(c => { c.schemaVersion = 99; }, /newer format/);
  reject(c => { c.screenshots[1].id = c.screenshots[0].id; }, /unique/);
  reject(c => { c.observations[0].recognition.players[0].stack.value = -5; }, /malformed/);
  reject(c => { c.observations[0].sequenceIndex = 3; }, /out of order/);
  reject(c => { c.observations[0].timestamp = 'yesterday'; }, /ISO time/);
  reject(c => { c.resolutions[0].actions.push({ id: 'x', seat: 0, type: 'teleport', confirmedAt: at }); }, /unknown type/);
  reject(c => { c.screenshots[0].image = 'javascript:alert(1)'; }, /JPEG data URL/);
  reject(c => { c.screenshots = Array.from({ length: 21 }, (_, i) => ({ id: 's' + i, label: 'x', uploadIndex: i })); }, /at most 20/);
});

test('resolutions follow reordering: a pair that is no longer adjacent is dropped', () => {
  const obs = observationsOf('complete-hand');
  let resolutions = setResolution([], { from: obs[0].id, to: obs[1].id, mark: 'unresolved', actions: [] });
  resolutions = setResolution(resolutions, { from: obs[1].id, to: obs[2].id, mark: 'different-hands', actions: [] });
  assert.equal(resolutions.length, 2);
  assert.equal(setResolution(resolutions, { from: obs[0].id, to: obs[1].id, mark: 'none', actions: [] }).length, 1);
  const reordered = [{ ...obs[1], sequenceIndex: 0 }, { ...obs[0], sequenceIndex: 1 }, obs[2]];
  assert.deepEqual(liveResolutions(reordered, resolutions), []);
  const restored = restoreObservation(JSON.parse(JSON.stringify(obs[0])));
  assert.deepEqual(restored, obs[0]);
});

test('reordering seats keeps confirmed actions on the same players and counts as a correction', () => {
  const obs = observationsOf('complete-hand');
  const actions = [action('a1', 0, 'check'), action('a2', 1, 'bet', 20), action('a3', 2, 'fold'), action('a4', 0, 'call')];
  const resolutions = [{ from: obs[1].id, to: obs[2].id, mark: 'none', actions }];
  // Move You (seat 0) to the end of screenshot 2's seat list.
  const map = seatMoveMap(3, 0, 2);
  const moved = withRecognition(obs[1], moveSeat(obs[1].recognition, 0, 2));
  assert.deepEqual(moved.recognition.players.map(p => p.name.value), ['Riley', 'Sam', 'You']);
  assert.equal(moved.reviewStatus, 'corrected');
  const remapped = remapActionSeats(resolutions, obs[1].id, map);
  assert.deepEqual(remapped[0].actions.map(a => moved.recognition.players[a.seat].name.value), ['You', 'Riley', 'Sam', 'You']);
  assert.deepEqual(remapActionSeats(resolutions, 'other', map), resolutions, 'other intervals are untouched');
  const result = reconstructHand([obs[0], moved, obs[2]], { resolutions: remapped });
  assert.equal(result.metrics.correctedFields, 1);
  // Screenshot 2 is now in a different seat order from its neighbours; the names line it up again.
  assert.ok(result.intervals[1].differences.some(d => d.kind === 'seats-moved' && d.severity === 'review'));
  assert.equal(result.intervals[1].status, 'resolved', 'the same actions still explain the change');
});
