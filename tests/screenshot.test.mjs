// Screenshot recognition: parsing provider output, confidence, review checks,
// corrections, conversion to the study snapshot, providers (mocked, no paid
// calls), the server's screenshot layout, and matching saved hand histories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { analyze } from '../dist/core/analyze.js';
import { createHandState, replaySteps } from '../dist/history/engine.js';
import { demoHand } from '../dist/history/demo.js';
import { parseHistory, serializeHistory, withAttachment } from '../dist/history/history.js';
import { matchObservation } from '../dist/history/observation.js';
import { claudeScreenshotProvider, fixtureProvider, localScreenshotProvider } from '../dist/vision/providers.js';
import { drawTable, fixtureById, SCREENSHOT_FIXTURES } from '../dist/vision/screenshot-fixtures.js';
import {
  corrected, correctedCard, indicator, parseScreenshotResponse, restoreRecognition, reviewScreenshot,
  toStudySnapshot, toTableObservation,
} from '../dist/vision/screenshot.js';
import { createRecognizeHandler, SCREENSHOT_SCHEMA } from '../scripts/recognize.mjs';

const recognize = id => parseScreenshotResponse(fixtureById(id).response, 'fixture');
const errors = rec => reviewScreenshot(rec).filter(i => i.severity === 'error');
const reviews = rec => reviewScreenshot(rec).filter(i => i.severity === 'review');
const setCard = (rec, path, card) => {
  const [group, i, , j] = path.split('.');
  if (group === 'board') return { ...rec, communityCards: rec.communityCards.map((c, k) => (k === Number(i) ? correctedCard(card) : c)) };
  return { ...rec, players: rec.players.map((p, k) => (k === Number(i) ? { ...p, cards: p.cards.map((c, m) => (m === Number(j) ? correctedCard(card) : c)) } : p)) };
};

// ---------------------------------------------------------------------------
// Fixtures and extraction
// ---------------------------------------------------------------------------

test('six synthetic fixtures cover the required scenarios and draw self-contained SVG', () => {
  assert.deepEqual(SCREENSHOT_FIXTURES.map(f => f.id), [
    'heads-up-preflop', 'three-player-flop', 'four-player-turn', 'river-complete-board', 'partially-hidden', 'unreadable-text',
  ]);
  for (const f of SCREENSHOT_FIXTURES) {
    const svg = drawTable(f.table);
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /href=|<image|<script/);
    assert.ok(svg.includes('Practice table · play money'));
  }
});

test('extracts cards, seats, chips, and the dealer from a river screenshot', () => {
  const rec = recognize('river-complete-board');
  assert.deepEqual(rec.communityCards.map(c => c.value), ['Jh', '9c', '4s', '2d', '7h']);
  assert.deepEqual(rec.players.map(p => p.name.value), ['You', 'Ash']);
  assert.deepEqual(rec.players[0].cards.map(c => c.value), ['Tc', 'Td']);
  assert.deepEqual(rec.players[1].cards.map(c => c.value), ['Ks', 'Qs']);
  assert.deepEqual(rec.players.map(p => [p.stack.value, p.bet.value, p.status.value]), [[500, 0, 'active'], [350, 100, 'active']]);
  assert.deepEqual([rec.pot.value, rec.dealerSeat.value, rec.heroSeat.value, rec.street.value, rec.street.source], [300, 0, 0, 'river', 'observed']);
  assert.deepEqual(errors(rec), []);
});

test('face-down and unreadable cards stay unknown, never guessed', () => {
  const flop = recognize('three-player-flop');
  assert.deepEqual(flop.players[1].cards.map(c => [c.value, c.hidden]), [[null, true], [null, true]]);
  assert.deepEqual(flop.players[2].cards, []); // folded seat shows no cards
  const hidden = recognize('partially-hidden');
  assert.deepEqual([hidden.communityCards[2].value, hidden.communityCards[2].hidden], [null, false]);
  assert.deepEqual([hidden.players[0].cards[1].value, hidden.players[0].cards[1].hidden], [null, false]);
  assert.deepEqual(hidden.warnings, ['A chat box covers part of the board and part of your second card.']);
  const messages = reviews(hidden).map(i => i.message);
  assert.ok(messages.includes('Board card 3 could not be read.'));
  assert.ok(messages.includes('Your card 2 could not be read.'));
  assert.ok(messages.includes('Your card 1 (8s) is ambiguous.'));
  const blocked = toStudySnapshot(hidden, 'completed');
  assert.deepEqual(blocked.problems, ['Enter both of your hole cards.', 'Enter every board card.']);
});

test('unreadable text: missing stacks, pot, and blinds are flagged, not filled in', () => {
  const rec = recognize('unreadable-text');
  assert.ok(rec.players.every(p => p.stack.value === null && p.name.value === null));
  assert.equal(rec.pot.value, null);
  assert.equal(indicator(rec.players[1].bet), 'review'); // low confidence
  assert.equal(indicator(rec.players[2].bet), 'unknown');
  const fields = reviews(rec).map(i => i.field);
  for (const field of ['players.0.stack', 'players.1.stack', 'players.2.stack', 'pot', 'bigBlind', 'players.2.bet', 'players.1.bet']) {
    assert.ok(fields.includes(field), field);
  }
  assert.deepEqual(errors(rec), []);
  assert.ok('problems' in toStudySnapshot(rec, 'completed'));
});

// ---------------------------------------------------------------------------
// Confidence and validation
// ---------------------------------------------------------------------------

test('confidence indicators: high, needs review, unknown; inferred and corrected values', () => {
  assert.equal(indicator({ value: 5, confidence: 'high', source: 'observed' }), 'high');
  assert.equal(indicator({ value: 5, confidence: 'medium', source: 'observed' }), 'review');
  assert.equal(indicator({ value: 5, confidence: null, source: 'observed' }), 'review'); // no estimate, not a fake score
  assert.equal(indicator({ value: null, confidence: null, source: 'observed' }), 'unknown');
  assert.equal(indicator({ value: 'flop', confidence: null, source: 'inferred' }), 'review');
  assert.equal(indicator(corrected(7)), 'high');
  assert.equal(indicator(corrected(null)), 'unknown');
  // A missing value never carries a confidence, even if the provider sent one.
  const rec = parseScreenshotResponse({ modelId: 'm', result: { ...fixtureById('heads-up-preflop').response.result, pot: { value: null, confidence: 'high' } } }, 'x');
  assert.deepEqual(rec.pot, { value: null, confidence: null, source: 'observed' });
  // The street is inferred from the board when the screen does not state it.
  assert.deepEqual(recognize('three-player-flop').street, { value: 'flop', confidence: null, source: 'inferred' });
});

test('duplicate cards, impossible boards, and conflicting streets are blocking errors', () => {
  const dup = setCard(recognize('river-complete-board'), 'board.0', 'Tc');
  const dupErrors = errors(dup);
  assert.deepEqual(dupErrors.map(e => e.field).sort(), ['board.0', 'players.0.cards.0']);
  assert.match(dupErrors[0].message, /Tc appears 2 times/);
  assert.deepEqual(toStudySnapshot(dup, 'completed').problems[0], 'Fix the problems marked as blocking first.');

  const twoCards = { ...recognize('three-player-flop'), communityCards: recognize('three-player-flop').communityCards.slice(0, 2) };
  assert.match(errors(twoCards).find(e => e.field === 'board').message, /0, 3, 4, or 5 cards; this one has 2/);
  const conflict = { ...recognize('four-player-turn'), street: corrected('flop') };
  assert.match(errors(conflict).find(e => e.field === 'street').message, /says flop but the board has 4/);

  const oneSeat = { ...recognize('river-complete-board'), players: recognize('river-complete-board').players.slice(0, 1), heroSeat: corrected(0), dealerSeat: corrected(0) };
  assert.ok(errors(oneSeat).some(e => /at least two seats/.test(e.message)));
  const allFolded = { ...recognize('three-player-flop') };
  allFolded.players = allFolded.players.map((p, i) => (i === 0 ? p : { ...p, status: corrected('folded') }));
  assert.ok(errors(allFolded).some(e => /two seats must still be in the hand/.test(e.message)));
  const potSmall = { ...recognize('four-player-turn'), potIncludesBets: true, pot: corrected(50) };
  assert.ok(errors(potSmall).some(e => /smaller than the bets/.test(e.message)));
});

test('malformed or structurally impossible provider responses are rejected', () => {
  const good = fixtureById('river-complete-board').response.result;
  const bad = result => () => parseScreenshotResponse({ modelId: 'm', result }, 'x');
  assert.throws(() => parseScreenshotResponse(null, 'x'), /malformed/);
  assert.throws(() => parseScreenshotResponse({ modelId: 'm' }, 'x'), /malformed \(no result\)/);
  assert.throws(bad({ ...good, players: 'two' }), /players/);
  assert.throws(bad({ ...good, board: [{ card: 'Zz', confidence: 'high' }] }), /card code/);
  assert.throws(bad({ ...good, board: Array(6).fill({ card: 'unknown', confidence: 'none' }) }), /more than five community cards/);
  assert.throws(bad({ ...good, players: Array(11).fill(good.players[0]) }), /more than 10 seats/);
  assert.throws(bad({ ...good, players: [{ ...good.players[0], cards: Array(3).fill({ card: 'hidden', confidence: 'none' }) }, good.players[1]] }), /more than two hole cards/);
  assert.throws(bad({ ...good, pot: { value: -5, confidence: 'high' } }), /pot/);
  assert.throws(bad({ ...good, pot: { value: 12.5, confidence: 'high' } }), /pot/);
  assert.throws(bad({ ...good, pot: { value: 300, confidence: 'certain' } }), /pot confidence/);
  assert.throws(bad({ ...good, dealerSeat: { value: 7, confidence: 'high' } }), /dealer seat/);
  assert.throws(bad({ ...good, street: { value: 'showdown', confidence: 'high' } }), /street/);
  assert.throws(bad({ ...good, players: [{ ...good.players[0], name: 'You' }, good.players[1]] }), /seat 1 name/);
});

// ---------------------------------------------------------------------------
// Corrections and conversion
// ---------------------------------------------------------------------------

test('corrections are marked, revalidated, and unlock the import', () => {
  let rec = recognize('partially-hidden');
  rec = setCard(rec, 'players.0.cards.1', '8h');
  assert.equal(rec.players[0].cards[1].source, 'corrected');
  assert.ok('problems' in toStudySnapshot(rec, 'completed'));
  rec = setCard(rec, 'board.2', '6s');
  const result = toStudySnapshot(rec, 'completed');
  assert.ok(result.snapshot, JSON.stringify(result.problems));
  assert.deepEqual(result.snapshot.hero, ['8s', '8h']);
  assert.deepEqual(result.snapshot.board, ['Ac', '6d', '6s', '5c']);
  // Correcting into a duplicate brings back a blocking error.
  const dup = setCard(rec, 'board.0', '8h');
  assert.ok(errors(dup).length > 0);
});

test('conversion to the study snapshot: pot, bets, folded seats, and analysis', () => {
  const heads = toStudySnapshot(recognize('heads-up-preflop'), 'simulation').snapshot;
  assert.deepEqual(heads, {
    version: 2, ruleset: 'holdem-nl', purpose: 'simulation',
    hero: ['As', 'Kd'], board: [], opponents: [{ stack: 990, committed: 10, cards: [] }],
    pot: 15, heroStack: 995, committed: 5, increment: 10,
  });
  assert.equal(analyze(heads).actions[1].kind, 'call');

  // Four seats, one folded: the study table gets three players.
  const four = toStudySnapshot(recognize('four-player-turn'), 'completed').snapshot;
  assert.equal(four.opponents.length, 2);
  assert.deepEqual(four.opponents.map(o => [o.stack, o.committed]), [[700, 60], [600, 0]]);
  assert.equal(four.pot, 300); // 240 shown plus the 60 bet
  assert.equal(four.increment, 20);
  // A pot already including bets is not counted twice.
  assert.equal(toStudySnapshot({ ...recognize('four-player-turn'), potIncludesBets: true, pot: corrected(300) }, 'completed').snapshot.pot, 300);
  // Known opponent cards carry over (a showdown screenshot).
  assert.deepEqual(toStudySnapshot(recognize('river-complete-board'), 'completed').snapshot.opponents[0].cards, ['Ks', 'Qs']);
  // Without a marked seat there is nothing to analyze.
  assert.deepEqual(toStudySnapshot({ ...recognize('heads-up-preflop'), heroSeat: corrected(null) }, 'completed').problems, ['Mark which seat is yours.']);
});

test('saved recognitions restore exactly and reject tampering', () => {
  for (const f of SCREENSHOT_FIXTURES) {
    const rec = parseScreenshotResponse(f.response, 'fixture');
    assert.deepEqual(restoreRecognition(JSON.parse(JSON.stringify(rec))), rec);
  }
  const rec = JSON.parse(JSON.stringify(recognize('river-complete-board')));
  rec.players[0].stack.source = 'guessed';
  assert.throws(() => restoreRecognition(rec), /malformed/);
});

// ---------------------------------------------------------------------------
// Providers (no paid calls)
// ---------------------------------------------------------------------------

const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

test('the fixture provider is deterministic and honours cancellation', async () => {
  const provider = fixtureProvider(fixtureById('four-player-turn').response, 'sample');
  const first = await provider.recognize(image);
  assert.equal(first.kind, 'recognized');
  assert.deepEqual(await provider.recognize(image), first);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await provider.recognize(image, aborted.signal), { kind: 'cancelled' });
  assert.equal((await fixtureProvider({ modelId: 'm', result: { players: 3 } }).recognize(image)).kind, 'failed');
  assert.deepEqual(await localScreenshotProvider.recognize(image), { kind: 'failed', reason: 'On-device screenshot recognition is not available yet.', retryable: false });
});

test('the Claude provider maps server failures, timeouts, and bad responses', async () => {
  const original = globalThis.fetch;
  const respond = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  try {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(fixtureById('river-complete-board').response), { status: 200 }); };
    const ok = await claudeScreenshotProvider().recognize(image);
    assert.equal(ok.kind, 'recognized');
    assert.equal(sent.url, './api/recognize?layout=screenshot');
    assert.equal(sent.init.headers['Content-Type'], 'image/jpeg');

    const cases = [
      [respond(503, { error: 'Cloud recognition is not set up. Start the server with ANTHROPIC_API_KEY set.' }), /ANTHROPIC_API_KEY/, false],
      [respond(429, { error: 'The Claude API is rate limited. Try again in a moment.' }), /rate limited/, true],
      [respond(504, { error: 'Recognition took too long.' }), /too long/, true],
      [respond(415, { error: 'Send a JPEG, PNG, or WebP image.' }), /JPEG, PNG, or WebP/, false],
      [respond(404, ''), /needs the app server/, false],
      [respond(500, 'not json'), /Recognition failed \(500\)/, true],
      [respond(200, { modelId: 'm', result: { players: 'x' } }), /malformed/, true],
      [async () => { throw new TypeError('offline'); }, /could not be reached/, true],
    ];
    for (const [fake, pattern, retryable] of cases) {
      globalThis.fetch = fake;
      const outcome = await claudeScreenshotProvider().recognize(image);
      assert.equal(outcome.kind, 'failed');
      assert.match(outcome.reason, pattern);
      assert.equal(outcome.retryable, retryable, outcome.reason);
    }

    // A hung request times out; a user cancel reports cancelled.
    globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const timedOut = await claudeScreenshotProvider('./api/recognize?layout=screenshot', 20).recognize(image);
    assert.deepEqual(timedOut, { kind: 'failed', reason: 'Recognition took too long. Try again.', retryable: true });
    const controller = new AbortController();
    const pending = claudeScreenshotProvider().recognize(image, controller.signal);
    controller.abort();
    assert.deepEqual(await pending, { kind: 'cancelled' });
  } finally {
    globalThis.fetch = original;
  }
});

test('the server reads screenshots through the same endpoint with their own schema', async () => {
  const calls = [];
  let reply = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fixtureById('three-player-flop').response.result) }] });
  const handler = createRecognizeHandler({ getClient: () => ({ beta: { messages: { create: async (params, options) => { calls.push({ params, options }); return reply(); } } } }) });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = path => fetch(base + path, { method: 'POST', body: new Uint8Array([1, 2]), headers: { 'Content-Type': 'image/png', Origin: base } });
  try {
    const response = await post('/api/recognize?layout=screenshot');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.layout, 'screenshot');
    assert.equal(parseScreenshotResponse(body, 'claude').players.length, 3);
    assert.deepEqual(calls[0].params.output_config.format.schema, SCREENSHOT_SCHEMA);
    assert.match(calls[0].params.system, /digital Texas Hold'em table/);
    assert.equal(calls[0].options.timeout, 90000);

    assert.equal((await post('/api/recognize?layout=webcam')).status, 400);
    // The existing photo layout is unchanged.
    await post('/api/recognize');
    assert.ok(calls[1].params.output_config.format.schema.required.includes('opponents'));

    reply = () => { throw new Anthropic.APIConnectionTimeoutError(); };
    const timeout = await post('/api/recognize?layout=screenshot');
    assert.equal(timeout.status, 504);
    assert.match((await timeout.json()).error, /took too long/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Saved hand histories
// ---------------------------------------------------------------------------

/** What a screenshot of the demo hand shows right after Devon's flop bet. */
function demoObservation(overrides = {}) {
  return {
    board: ['As', 'Kd', '7h'], pot: 95, potIncludesBets: false,
    players: [
      { name: 'Avery', cards: ['Ks', 'Kc'], stack: 970, bet: 0, folded: false },
      { name: 'Blake', cards: [null, null], stack: 995, bet: 0, folded: true },
      { name: 'Casey', cards: [null, null], stack: 970, bet: 0, folded: false },
      { name: 'Devon', cards: [null, null], stack: 930, bet: 40, folded: false },
    ],
    ...overrides,
  };
}

test('an observation matches only the replay positions it is consistent with', () => {
  const hand = demoHand();
  const states = replaySteps(createHandState(hand.setup), hand.events);
  assert.deepEqual(matchObservation(states, demoObservation()), [{ position: 10, rotation: 0 }]);
  // Seats listed from Blake round the table: same position, rotated.
  const obs = demoObservation();
  const rotated = { ...obs, players: [...obs.players.slice(1), obs.players[0]].map(p => ({ ...p, name: null })) };
  assert.ok(matchObservation(states, rotated).some(m => m.position === 10 && m.rotation === 1));
  // Any contradiction rules a position out.
  assert.deepEqual(matchObservation(states, demoObservation({ pot: 96 })), []);
  assert.deepEqual(matchObservation(states, demoObservation({ board: ['As', 'Kd', '7c'] })), []);
  const wrongStack = demoObservation();
  wrongStack.players[3] = { ...wrongStack.players[3], stack: 931 };
  assert.deepEqual(matchObservation(states, wrongStack), []);
  assert.deepEqual(matchObservation(states, demoObservation({ players: demoObservation().players.slice(0, 3) })), []);
  // Unknown fields match anything: board alone matches several flop positions.
  const loose = demoObservation({ pot: null, players: demoObservation().players.map(() => ({ name: null, cards: [null, null], stack: null, bet: null, folded: null })) });
  assert.ok(matchObservation(states, loose).length > 4);
});

test('attachments are stored on the hand, survive export, and must still match on import', () => {
  const hand = demoHand();
  const attachment = { id: 'shot-1', label: 'Flop screenshot', attachedAt: '2026-11-09T12:00:00.000Z', position: 10, rotation: 0, observation: demoObservation() };
  const updated = withAttachment(hand, attachment);
  assert.equal(hand.attachments, undefined); // the original is unchanged
  assert.deepEqual(updated.attachments, [attachment]);
  assert.deepEqual(updated.events, hand.events); // no events fabricated
  const round = parseHistory(serializeHistory(updated));
  assert.deepEqual(round, updated);
  const moved = JSON.parse(serializeHistory(updated));
  moved.attachments[0].position = 9;
  assert.throws(() => parseHistory(moved), /does not match the hand at event 9/);
  assert.throws(() => withAttachment(updated, attachment), /unique ID/);
});

test('a reviewed screenshot converts to an observation that finds its hand', () => {
  // A screenshot read of the demo hand's flop after Devon's bet, built through the parser.
  const result = {
    players: demoObservation().players.map(p => ({
      name: { value: p.name, confidence: 'high' }, stack: { value: p.stack, confidence: 'high' }, bet: { value: p.bet, confidence: 'high' },
      status: { value: p.folded ? 'folded' : 'active', confidence: 'high' },
      cards: p.cards.map(c => ({ card: c ?? 'hidden', confidence: c ? 'high' : 'none' })),
    })),
    board: ['As', 'Kd', '7h'].map(card => ({ card, confidence: 'high' })),
    pot: { value: 95, confidence: 'high' }, smallBlind: { value: 5, confidence: 'high' }, bigBlind: { value: 10, confidence: 'high' },
    dealerSeat: { value: 0, confidence: 'high' }, heroSeat: { value: 0, confidence: 'high' }, street: { value: 'flop', confidence: 'high' }, issues: [],
  };
  const rec = parseScreenshotResponse({ modelId: 'm', result }, 'fixture');
  const states = replaySteps(createHandState(demoHand().setup), demoHand().events);
  assert.deepEqual(matchObservation(states, toTableObservation(rec)), [{ position: 10, rotation: 0 }]);
  const snapshot = toStudySnapshot(rec, 'completed').snapshot;
  assert.equal(snapshot.pot, 135);
  assert.deepEqual(snapshot.opponents.map(o => o.committed), [0, 40]);
});
