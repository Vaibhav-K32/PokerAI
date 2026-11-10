// Step 4, frame-to-frame tracking: video frame selection, stable player
// identity, identity-aware comparison, temporal consistency, replay steps,
// session format v2, and the demo sequence. Deterministic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHandEvent } from '../dist/history/engine.js';
import { compareFrameStates } from '../dist/reconstruction/compare.js';
import { classifyInterval, CONSISTENCY_LABELS, worstConsistency } from '../dist/reconstruction/consistency.js';
import { DEMO_CONFIRMED_ACTIONS, DEMO_SEQUENCE, sequenceById } from '../dist/reconstruction/fixtures.js';
import { NEW_PLAYER, pairByOrder, remapOverrides, seatPairing, setOverride, trackPlayers } from '../dist/reconstruction/identity.js';
import { createObservation, restoreObservation, withRecognition } from '../dist/reconstruction/observation.js';
import { differenceKey, reconstructFrameSequence, reconstructHand } from '../dist/reconstruction/reconstruct.js';
import { buildReplaySteps, checkpointStep, moveStep } from '../dist/reconstruction/replay-steps.js';
import { createSession, parseSession, serializeSession } from '../dist/reconstruction/session.js';
import { corrected, correctedCard, moveSeat, parseScreenshotResponse, seatMoveMap } from '../dist/vision/screenshot.js';
import { durationProblem, formatVideoTime, MAX_SAMPLED_FRAMES, sampleTimes, videoProblem } from '../dist/vision/video.js';

const at = '2026-03-01T10:00:00.000Z';
const recOf = frame => parseScreenshotResponse(frame.response, 'fixture');
const framesOf = seq => seq.frames.map((f, i) => createObservation('f' + i, i, recOf(f)));
const demo = () => framesOf(DEMO_SEQUENCE);
const complete = () => framesOf(sequenceById('complete-hand'));
const setPlayer = (rec, i, change) => ({ ...rec, players: rec.players.map((p, k) => (k === i ? change(p) : p)) });
const withRec = (o, rec) => ({ ...o, recognition: rec });
const demoResolution = obs => ({
  from: obs[DEMO_CONFIRMED_ACTIONS.intervalIndex].id, to: obs[DEMO_CONFIRMED_ACTIONS.intervalIndex + 1].id, mark: 'none',
  actions: DEMO_CONFIRMED_ACTIONS.actions.map((a, k) => ({ id: 'd' + k, ...a, confirmedAt: at })),
});
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Video input
// ---------------------------------------------------------------------------

test('video uploads are checked by type, size, and length', () => {
  assert.equal(videoProblem({ type: 'video/mp4', size: 10_000 }), null);
  assert.equal(videoProblem({ type: 'video/webm', size: 10_000 }), null);
  assert.match(videoProblem({ type: 'image/png', size: 10 }), /MP4, WebM/);
  assert.match(videoProblem({ type: 'video/mp4', size: 0 }), /empty/);
  assert.match(videoProblem({ type: 'video/mp4', size: 600 * 1024 * 1024 }), /500 MB/);
  assert.match(durationProblem(NaN), /no readable length/);
  assert.match(durationProblem(31 * 60 * 1000), /30 minutes/);
  assert.equal(durationProblem(90_000), null);
});

test('frames are sampled at an interval, never every frame, and capped', () => {
  assert.deepEqual(sampleTimes(10_000, 2000), { times: [0, 2000, 4000, 6000, 8000], intervalMs: 2000, capped: false });
  const long = sampleTimes(20 * 60 * 1000, 500);
  assert.equal(long.times.length, MAX_SAMPLED_FRAMES);
  assert.equal(long.capped, true);
  assert.ok(long.intervalMs >= 10_000);
  assert.deepEqual(sampleTimes(NaN, 1000).times, []);
  assert.deepEqual(sampleTimes(5000, 0).times, []);
  assert.equal(formatVideoTime(65_240), '1:05.2');
  assert.equal(formatVideoTime(0), '0:00.0');
});

test('video frames keep their source and real timestamp; screenshots get none', () => {
  const rec = recOf(DEMO_SEQUENCE.frames[0]);
  const fromVideo = createObservation('v1', 0, rec, { source: 'video', timestampMs: 12_400 });
  assert.deepEqual([fromVideo.source, fromVideo.timestampMs, fromVideo.timestamp], ['video', 12_400, null]);
  const shot = createObservation('s1', 0, rec, { timestampMs: 5 });
  assert.deepEqual([shot.source, shot.timestampMs], ['screenshot', null], 'a screenshot never gets a frame time');
  assert.deepEqual(restoreObservation(JSON.parse(JSON.stringify(fromVideo))), fromVideo);
  assert.throws(() => restoreObservation({ ...JSON.parse(JSON.stringify(shot)), timestampMs: 100 }), /only video frames/);
  assert.throws(() => restoreObservation({ ...JSON.parse(JSON.stringify(fromVideo)), source: 'camera' }), /screenshot or a video/);
});

// ---------------------------------------------------------------------------
// Player identity
// ---------------------------------------------------------------------------

test('players keep one ID across frames, matched by name, and an unreadable name is matched by position', () => {
  const identity = trackPlayers(demo());
  assert.deepEqual(identity.players.map(p => p.id), ['name:you', 'name:riley', 'name:sam']);
  const third = identity.frames[2];
  assert.deepEqual(third.seats.map(s => [s.playerId, s.basis]), [['name:you', 'name'], ['name:riley', 'position'], ['name:sam', 'name']]);
  assert.equal(third.dealer, 'name:sam');
  assert.equal(third.hero, 'name:you');
  assert.ok(identity.frames.every(f => f.dealer === null || f.dealer === 'name:sam'), 'the dealer is tracked as a player');
});

test('reordered seats do not change identities, dealer, or hero', () => {
  const obs = complete();
  const moved = withRec(obs[1], moveSeat(obs[1].recognition, 2, 0)); // Sam, You, Riley
  assert.deepEqual(moved.recognition.players.map(p => p.name.value), ['Sam', 'You', 'Riley']);
  const identity = trackPlayers([obs[0], moved, obs[2]]);
  assert.deepEqual(identity.frames[1].seats.map(s => s.playerId), ['name:sam', 'name:you', 'name:riley']);
  assert.equal(identity.frames[1].dealer, 'name:sam');
  assert.equal(identity.frames[1].hero, 'name:you');
  const pairing = seatPairing(identity, obs[0].id, moved.id);
  assert.deepEqual(pairing.pairs.map(p => [p.prev, p.next, p.playerId]), [[0, 1, 'name:you'], [1, 2, 'name:riley'], [2, 0, 'name:sam']]);
  const diffs = compareFrameStates(obs[0], moved, pairing);
  assert.ok(!diffs.some(d => d.kind === 'dealer-moved'));
  assert.equal(diffs.find(d => d.field === 'players.2.stack').playerId, 'name:sam');
});

test('a player missing from a frame is hidden, not folded, and can be marked as not visible', () => {
  const obs = demo();
  const identity = trackPlayers(obs);
  assert.deepEqual(identity.frames[3].missing, [{ playerId: 'name:sam', acknowledged: false }]);
  assert.ok(identity.issues.some(i => i.kind === 'missing' && /Sam is not visible in frame 4. That is not a fold/.test(i.text)));
  const pairing = seatPairing(identity, obs[2].id, obs[3].id);
  const diffs = compareFrameStates(obs[2], obs[3], pairing);
  const gone = diffs.find(d => d.kind === 'player-hidden');
  assert.equal(gone.playerId, 'name:sam');
  assert.match(gone.warning, /Not counted as a fold/);
  assert.ok(!diffs.some(d => d.kind === 'status-changed'));
  const marked = trackPlayers(obs, { hidden: [{ observationId: obs[3].id, playerId: 'name:sam' }] });
  assert.deepEqual(marked.frames[3].missing, [{ playerId: 'name:sam', acknowledged: true }]);
  assert.ok(!marked.issues.some(i => i.kind === 'missing'));
  assert.deepEqual(seatPairing(trackPlayers(obs), obs[3].id, obs[4].id).arrived, [{ seat: 2, playerId: 'name:sam', firstSeen: false }]);
});

test('ambiguous seats stay unmatched with candidates until the user decides; nothing is merged silently', () => {
  const obs = complete();
  // Frame 2 drops a seat and loses every name: position cannot be used (table size changed).
  const anonymous = withRec(obs[1], {
    ...obs[1].recognition,
    players: obs[1].recognition.players.slice(1).map(p => ({ ...p, name: corrected(null) })),
    heroSeat: corrected(null), dealerSeat: corrected(null),
  });
  const identity = trackPlayers([obs[0], anonymous]);
  assert.deepEqual(identity.frames[1].seats.map(s => [s.playerId, s.basis]), [[null, 'unmatched'], [null, 'unmatched']]);
  assert.equal(identity.frames[1].seats[0].candidates.length, 3);
  assert.equal(identity.issues.filter(i => i.kind === 'ambiguous').length, 2);
  assert.equal(identity.players.length, 3, 'no players were invented or merged');
  // The user matches one seat to Riley and marks the other as someone new.
  let overrides = setOverride([], anonymous.id, 0, 'name:riley');
  overrides = setOverride(overrides, anonymous.id, 1, NEW_PLAYER);
  const settled = trackPlayers([obs[0], anonymous], { overrides });
  assert.deepEqual(settled.frames[1].seats.map(s => [s.playerId, s.basis]), [['name:riley', 'user'], ['new:' + anonymous.id + ':1', 'user']]);
  assert.equal(settled.issues.filter(i => i.kind === 'ambiguous').length, 0);
  assert.deepEqual(setOverride(overrides, anonymous.id, 0, null).length, 1, 'clearing a match returns the seat to automatic matching');
});

test('a user match to an already-used player is reported as a conflict', () => {
  const obs = complete();
  const identity = trackPlayers(obs.slice(0, 2), { overrides: [{ observationId: obs[1].id, seat: 1, playerId: 'name:you' }] });
  assert.ok(identity.issues.some(i => i.kind === 'conflict' && /matched to two seats/.test(i.text)));
});

test('a name first read later attaches to the player matched by position', () => {
  const obs = complete();
  const unnamed = withRec(obs[0], setPlayer(obs[0].recognition, 1, p => ({ ...p, name: corrected(null) })));
  const identity = trackPlayers([unnamed, obs[1], obs[2]]);
  const riley = identity.frames[0].seats[1].playerId;
  assert.equal(identity.frames[1].seats[1].playerId, riley);
  assert.equal(identity.frames[1].seats[1].basis, 'position');
  assert.equal(identity.frames[2].seats[1].playerId, riley, 'later frames find Riley by name');
  assert.equal(identity.players.find(p => p.id === riley).label, 'Riley');
  assert.equal(identity.players.length, 3);
});

test('seat matches follow a seat reorder in their frame', () => {
  const map = seatMoveMap(3, 0, 2);
  assert.deepEqual(remapOverrides([{ observationId: 'o', seat: 0, playerId: 'p' }, { observationId: 'x', seat: 0, playerId: 'q' }], 'o', map),
    [{ observationId: 'o', seat: 2, playerId: 'p' }, { observationId: 'x', seat: 0, playerId: 'q' }]);
});

test('ordering-only pairing is used for standalone comparisons', () => {
  const [a, b] = complete();
  assert.equal(pairByOrder(a.recognition, b.recognition).pairs.length, 3);
  assert.equal(pairByOrder(a.recognition, { ...b.recognition, players: b.recognition.players.slice(1) }), null);
});

// ---------------------------------------------------------------------------
// State differences
// ---------------------------------------------------------------------------

test('unknown is not zero: a stack becoming 0 is all-in, a stack becoming unreadable is not', () => {
  const obs = framesOf(sequenceById('multiway-all-in'));
  const identity = trackPlayers(obs);
  const diffs = compareFrameStates(obs[0], obs[1], seatPairing(identity, obs[0].id, obs[1].id));
  assert.deepEqual(diffs.filter(d => d.kind === 'all-in').map(d => d.playerId), ['name:you', 'name:ash']);
  const blurred = withRec(obs[1], setPlayer(obs[1].recognition, 0, p => ({ ...p, stack: corrected(null) })));
  const blurredDiffs = compareFrameStates(obs[0], blurred, seatPairing(trackPlayers([obs[0], blurred]), obs[0].id, blurred.id));
  assert.ok(!blurredDiffs.some(d => d.kind === 'all-in' && d.playerId === 'name:you'));
  assert.ok(blurredDiffs.some(d => d.kind === 'value-hidden' && d.playerId === 'name:you'));
});

test('board progression, hole-card reveals, and contradictory readings are detected with player IDs', () => {
  const obs = demo();
  const result = reconstructHand(obs);
  const kinds = result.intervals.map(i => i.differences.map(d => d.kind));
  assert.ok(kinds[0].includes('board-dealt') && kinds[1].includes('board-dealt') && kinds[2].includes('board-dealt'));
  const reveal = result.intervals[3].differences.find(d => d.kind === 'hole-cards-visible');
  assert.equal(reveal.playerId, 'name:riley');
  assert.match(result.intervals[2].contradictions[0].text, /Board card 4 changed from Kh to Kd/);
  assert.equal(result.intervals[2].differences.find(d => d.kind === 'board-card-changed').confidence.next, 'low');
});

// ---------------------------------------------------------------------------
// Temporal consistency
// ---------------------------------------------------------------------------

test('intervals are classified as consistent, missing information, ambiguous, contradictory, or split', () => {
  const obs = demo();
  const result = reconstructHand(obs, { resolutions: [demoResolution(obs)] });
  assert.deepEqual(result.intervals.map(i => i.consistency), ['ambiguous', 'consistent', 'contradictory', 'contradictory']);
  // Correct the misread card: frame 4 is consistent with missing information (Sam hidden), and the pot award stays ambiguous.
  const fixed = withRecognition(obs[3], { ...obs[3].recognition, communityCards: obs[3].recognition.communityCards.map((c, i) => (i === 3 ? correctedCard('Kh') : c)) });
  const after = reconstructHand([obs[0], obs[1], obs[2], fixed, obs[4]], { resolutions: [demoResolution(obs)] });
  assert.deepEqual(after.intervals.map(i => i.consistency), ['ambiguous', 'consistent', 'consistent-missing', 'ambiguous']);
  assert.ok(after.intervals[2].consistencyReasons.some(r => /Sam is not visible/.test(r)));
  assert.equal(worstConsistency(after.intervals.map(i => i.consistency)), 'ambiguous');
  assert.equal(CONSISTENCY_LABELS['consistent-missing'], 'Consistent, with missing information');
  assert.equal(classifyInterval({ status: 'different-hands', differences: [], contradictions: [{ text: 'x' }], possible: [], middleChange: 0, identityIssues: [] }).consistency, 'split');
});

test('frames in the wrong order are contradictory and say so', () => {
  const obs = complete();
  const swapped = [{ ...obs[2], sequenceIndex: 0 }, { ...obs[1], sequenceIndex: 1 }];
  const [interval] = reconstructHand(swapped).intervals;
  assert.equal(interval.consistency, 'contradictory');
  assert.ok(interval.consistencyReasons.some(r => /out of order/.test(r)));
});

test('missing intermediate frames are not rejected: the gap stays open', () => {
  const obs = complete();
  const [interval] = reconstructHand([obs[0], { ...obs[3], sequenceIndex: 1 }]).intervals;
  assert.equal(interval.consistency, 'ambiguous');
  assert.equal(interval.contradictions.length, 0);
  assert.ok(interval.possible.some(p => /More than one street/.test(p.text)));
});

test('hidden players do not trigger false chip-conservation contradictions', () => {
  const obs = demo();
  const fixed = withRecognition(obs[3], { ...obs[3].recognition, communityCards: obs[3].recognition.communityCards.map((c, i) => (i === 3 ? correctedCard('Kh') : c)) });
  const interval = reconstructHand([obs[2], { ...fixed, sequenceIndex: 1 }]).intervals[0];
  assert.ok(!interval.contradictions.some(c => c.field === 'chips'));
});

test('a sequence can be split into separate hands', () => {
  const obs = complete();
  const result = reconstructHand(obs, { resolutions: [{ from: obs[2].id, to: obs[3].id, mark: 'different-hands', actions: [] }] });
  assert.deepEqual(result.hands, [[obs[0].id, obs[1].id, obs[2].id], [obs[3].id, obs[4].id]]);
  assert.equal(result.intervals[2].consistency, 'split');
  assert.ok(result.warnings.some(w => /split into 2 hands/.test(w)));
});

// ---------------------------------------------------------------------------
// Reconstruction, evidence, and replay
// ---------------------------------------------------------------------------

test('observed, inferred, and confirmed evidence stay separate; user-confirmed changes are marked', () => {
  const obs = complete();
  const plain = reconstructHand(obs);
  const fact = plain.intervals[1].confirmed.find(f => /Riley’s stack fell/.test(f.text));
  assert.equal(fact.evidence, 'observed');
  assert.ok(plain.intervals[0].possible.length > 0, 'possible transitions are listed as alternatives, not facts');
  assert.equal(plain.intervals[0].actionCheck, null, 'no events are inferred from chip changes');
  const key = differenceKey(plain.intervals[1].differences.find(d => d.field === 'players.1.stack'));
  const confirmed = reconstructHand(obs, { resolutions: [{ from: obs[1].id, to: obs[2].id, mark: 'none', actions: [], confirmedChanges: [key] }] });
  assert.equal(confirmed.intervals[1].confirmed.find(f => /Riley’s stack fell/.test(f.text)).evidence, 'confirmed');
});

test('replay steps separate observed frames, verified events, and unresolved intervals', () => {
  const obs = demo();
  const result = reconstructHand(obs, { resolutions: [demoResolution(obs)] });
  const steps = buildReplaySteps(result);
  assert.deepEqual(steps.map(s => s.kind), [
    'checkpoint', 'unresolved', 'checkpoint', 'event', 'event', 'event', 'event', 'checkpoint', 'unresolved', 'checkpoint', 'unresolved', 'checkpoint',
  ]);
  assert.deepEqual(steps.filter(s => s.kind === 'event').map(s => s.label), ['You checks', 'Riley bets 20', 'Sam folds', 'You calls 20']);
  const lastEvent = steps.filter(s => s.kind === 'event').at(-1);
  assert.deepEqual(lastEvent.state.players.map(p => p.stack), [970, 970, 990]);
  assert.equal(checkpointStep(steps, obs[2].id), 7);
  assert.equal(moveStep(0, steps, 'last'), steps.length - 1);
  assert.equal(moveStep(3, steps, 'previous'), 2);
  const split = buildReplaySteps(reconstructHand(obs, { resolutions: [{ from: obs[0].id, to: obs[1].id, mark: 'different-hands', actions: [] }] }));
  assert.equal(split[1].kind, 'split');
});

test('verified events replay through the existing immutable reducer', () => {
  const obs = demo();
  const check = reconstructHand(obs, { resolutions: [demoResolution(obs)] }).intervals[1].actionCheck;
  let state = check.states[0];
  const before = JSON.stringify(state);
  for (const e of check.events) {
    const actor = state.players.findIndex(p => p.id === e.payload.playerId);
    state = applyHandEvent({ ...state, actor }, e);
  }
  assert.equal(JSON.stringify(check.states[0]), before, 'states are not mutated');
  assert.deepEqual(state.players.map(p => p.stack), check.states.at(-1).players.map(p => p.stack));
});

test('a manual action cannot bypass the rules', () => {
  const obs = demo();
  const bad = { ...demoResolution(obs), actions: [{ id: 'x', seat: 1, type: 'bet', to: 3, confirmedAt: at }] };
  const interval = reconstructHand(obs, { resolutions: [bad] }).intervals[1];
  assert.equal(interval.status, 'partial');
  assert.match(interval.actionCheck.error.message, /at least 10 chips/);
  assert.equal(interval.actionCheck.events.length, 0);
});

test('tracking is deterministic and does not mutate its inputs', () => {
  const obs = deepFreeze(demo());
  const options = deepFreeze({ resolutions: [demoResolution(obs)], identity: { overrides: [], hidden: [{ observationId: obs[3].id, playerId: 'name:sam' }] } });
  const a = reconstructFrameSequence(obs, options);
  const b = reconstructFrameSequence([...obs].reverse(), options);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function trackedSession() {
  const obs = demo().map((o, i) => (i === 1 ? { ...o, source: 'video', timestampMs: 4000 } : o));
  const screenshots = obs.map((o, i) => ({ id: o.screenshotId, label: 'frame ' + i, uploadIndex: i, ...(i === 1 ? { source: 'video', timestampMs: 4000 } : {}) }));
  return createSession({
    id: 'track-1', title: 'Demo', createdAt: at, screenshots, observations: obs,
    resolutions: [demoResolution(obs)],
    identity: { overrides: [{ observationId: obs[2].id, seat: 1, playerId: 'name:riley' }], hidden: [{ observationId: obs[3].id, playerId: 'name:sam' }] },
  });
}

test('sessions save player matches, hidden marks, source type, and validation results', () => {
  const session = trackedSession();
  assert.equal(session.schemaVersion, 2);
  assert.equal(session.sourceType, 'mixed');
  assert.equal(session.identity.overrides.length, 1);
  assert.equal(session.identity.hidden.length, 1);
  assert.deepEqual(session.validation.map(v => v.consistency), ['ambiguous', 'consistent', 'contradictory', 'contradictory']);
  assert.deepEqual(parseSession(serializeSession(session)), session);
});

test('version 1 sessions are upgraded, and bad identity data is rejected', () => {
  const v1 = JSON.parse(serializeSession(trackedSession()));
  v1.schemaVersion = 1;
  delete v1.identity;
  delete v1.validation;
  delete v1.sourceType;
  v1.screenshots[1] = { id: v1.screenshots[1].id, label: 'x', uploadIndex: 1 };
  v1.observations[1] = { ...v1.observations[1], source: 'screenshot', timestampMs: null };
  v1.observations.forEach(o => { delete o.timestampMs; });
  const upgraded = parseSession(v1);
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.identity, { overrides: [], hidden: [] });
  assert.equal(upgraded.sourceType, 'screenshots');

  const good = JSON.parse(serializeSession(trackedSession()));
  const reject = (change, pattern) => {
    const copy = structuredClone(good);
    change(copy);
    assert.throws(() => parseSession(copy), pattern);
  };
  reject(c => { c.identity.overrides[0].observationId = 'nope'; }, /missing frame/);
  reject(c => { c.identity.hidden.push({ observationId: c.observations[0].id }); }, /hidden-player mark/);
  reject(c => { c.identity = 'all'; }, /overrides and hidden/);
  reject(c => { c.screenshots[1].timestampMs = 5000; }, /does not match its frame/);
  reject(c => { c.screenshots[0].timestampMs = 10; }, /Only video frames/);
  reject(c => { c.resolutions[0].confirmedChanges = [42]; }, /change keys/);
  reject(c => { c.schemaVersion = 3; }, /newer format/);
});

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

test('the demo sequence covers the required workflow without an API', () => {
  assert.equal(DEMO_SEQUENCE.frames.length, 5);
  const obs = demo();
  assert.deepEqual(obs.map(o => o.recognition.street.value), ['preflop', 'flop', 'turn', 'river', 'river']);
  assert.ok(obs.every(o => o.recognition.providerId === 'fixture'));
  const result = reconstructHand(obs, { resolutions: [demoResolution(obs)] });
  assert.equal(result.intervals.filter(i => i.status === 'resolved').length, 1, 'one interval is explained by confirmed actions');
  assert.ok(result.intervals.some(i => i.status === 'unresolved'), 'and at least one stays unresolved');
  assert.ok(result.intervals.some(i => i.status === 'contradiction'), 'with one correctable recognition error');
  assert.equal(result.identity.players.length, 3);
  assert.ok(result.checkpoints.every(c => c.pot !== null));
});
