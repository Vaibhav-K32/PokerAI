// Step 5, physical table photos: parsing provider readings, table geometry,
// chips, photo quality, the camera controller, corrections, conversion to the
// shared table state, providers and the server layout, and Step 4 tracking.
// Deterministic fixtures and fakes only; no paid API calls, no real camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseChipConfig, chipConfigProblems, groupValue, sumGroups } from '../dist/physical/chips.js';
import { physicalIssues, physicalToRecognition } from '../dist/physical/convert.js';
import {
  addCard, addSeat, assignCard, assignChips, moveSeatArea, removeCard, removeSeat, setCardPart, setCardValue, setChipCount, setChipColor, setDealer,
  setHero, setSeatBet, setSeatStack, setPot, setBlinds, setTableCenter, setSeatPosition,
} from '../dist/physical/edits.js';
import { DEMO_CHIPS, drawPhysicalScene, PHYSICAL_FIXTURES, PHYSICAL_SEQUENCE, physicalFixtureById, readingFor } from '../dist/physical/fixtures.js';
import { boardOrder, clockwiseOrder, interpretTable, zoneAt } from '../dist/physical/geometry.js';
import { parsePhysicalResponse } from '../dist/physical/parse.js';
import { framingChecks, photoChecks, pixelMetrics } from '../dist/physical/quality.js';
import { createObservation } from '../dist/reconstruction/observation.js';
import { reconstructHand } from '../dist/reconstruction/reconstruct.js';
import { buildReplaySteps } from '../dist/reconstruction/replay-steps.js';
import { createSession, parseSession, serializeSession } from '../dist/reconstruction/session.js';
import { claudePhysicalProvider, fixturePhysicalProvider, physicalAsScreenshotProvider } from '../dist/vision/providers.js';
import { parseScreenshotResponse, reviewScreenshot, toStudySnapshot } from '../dist/vision/screenshot.js';
import { CameraController } from '../dist/web/camera.js';
import { createRecognizeHandler, PHYSICAL_SCHEMA } from '../scripts/recognize.mjs';

const scan = id => interpretTable(parsePhysicalResponse(physicalFixtureById(id).response, 'fixture', id));
const cardsIn = (obs, kind, seatId) => obs.cards.filter(c => c.zone.kind === kind && (!seatId || c.zone.seatId === seatId));
const code = c => (c.rank && c.suit ? c.rank + c.suit : c.visibility === 'face_down' ? 'back' : '?');
const errors = (obs, cfg = DEMO_CHIPS) => physicalIssues(obs, cfg).filter(i => i.severity === 'error');
const image = new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });

// ---------------------------------------------------------------------------
// Fixtures and parsing
// ---------------------------------------------------------------------------

test('six synthetic table photos cover the required demo scenarios and draw self-contained SVG', () => {
  assert.deepEqual(PHYSICAL_FIXTURES.map(f => f.scene.id), ['two-player-clear', 'four-player-board', 'angled-photo', 'partly-hidden', 'chip-stacks', 'uncertain-card']);
  for (const f of [...PHYSICAL_FIXTURES, ...PHYSICAL_SEQUENCE]) {
    const svg = drawPhysicalScene(f.scene);
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /href=|<image|<script/);
    assert.equal(f.response.modelId, 'fixture');
    assert.doesNotThrow(() => parsePhysicalResponse(f.response, 'fixture'));
  }
});

test('a clear photo reads cards, seats, the dealer, and chips with approximate positions', () => {
  const obs = scan('two-player-clear');
  assert.equal(obs.source, 'physical_photo');
  assert.deepEqual(obs.seats.map(s => s.label.value), ['You', 'Riley']);
  assert.equal(obs.heroSeatId, 'seat-1');
  assert.equal(obs.dealerSeatId, 'seat-1');
  assert.deepEqual(cardsIn(obs, 'seat', 'seat-1').map(code), ['As', 'Kd']);
  assert.deepEqual(cardsIn(obs, 'seat', 'seat-2').map(c => c.visibility), ['face_down', 'face_down']);
  for (const c of obs.cards) {
    assert.ok(c.box.x >= 0 && c.box.y >= 0 && c.box.x + c.box.width <= 1.001 && c.box.y + c.box.height <= 1.001, 'normalized box');
    assert.ok(c.center.x > c.box.x && c.center.x < c.box.x + c.box.width);
  }
  assert.ok(obs.chips.every(g => g.countStatus === 'confirmed'));
});

test('malformed or impossible readings are rejected', () => {
  const good = physicalFixtureById('two-player-clear').response;
  const bad = change => () => {
    const copy = structuredClone(good);
    change(copy.result);
    return parsePhysicalResponse(copy, 'x');
  };
  assert.throws(() => parsePhysicalResponse({ modelId: 'm' }, 'x'), /no result/);
  assert.throws(bad(r => { r.cards[0].card = 'Zz'; }), /card code/);
  assert.throws(bad(r => { r.cards[0] = { ...r.cards[0], card: 'unknown', rank: 'A', suit: 's' }; }), /cannot have both rank and suit/);
  assert.throws(bad(r => { r.cards[0].box = { x: 1.5, y: 0, width: 0.1, height: 0.1 }; }), /box/);
  assert.throws(bad(r => { r.cards[0].seat = 9; }), /seat/);
  assert.throws(bad(r => { r.seats[1].isUser = true; }), /two seats/);
  assert.throws(bad(r => { r.chips[0].count = -2; }), /count/);
  assert.throws(bad(r => { r.chips[0].countCertainty = 'guessed'; }), /certainty/);
  assert.throws(bad(r => { r.cards[2].visibility = 'face_up'; }), /face-down card marked face up/);
  assert.throws(bad(r => { r.seats = Array(11).fill(r.seats[0]).map(s => ({ ...s, isUser: false })); }), /more than 10 seats/);
});

// ---------------------------------------------------------------------------
// Card recognition and grouping
// ---------------------------------------------------------------------------

test('community cards are told apart from hole cards, and a rotated, angled board is ordered along its own axis', () => {
  const flat = scan('four-player-board');
  assert.deepEqual(physicalToRecognition(flat, DEMO_CHIPS).communityCards.map(c => c.value), ['Kh', '9h', '3d', '2s']);
  const angled = scan('angled-photo');
  const board = cardsIn(angled, 'board');
  assert.equal(board.length, 3);
  const ys = board.map(c => c.center.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.05, 'the board is not horizontal in this photo');
  assert.deepEqual(boardOrder(angled.cards).map(code), ['7c', '8c', '2h']);
  assert.ok(angled.cards.every(c => c.zoneSource === 'reader'), 'geometry agrees with the reading');
  assert.equal(angled.cards[0].orientationDegrees, 20);
});

test('partly hidden and unknown cards stay unknown; a readable rank is kept without a guessed suit', () => {
  const obs = scan('partly-hidden');
  const hero = cardsIn(obs, 'seat', 'seat-1');
  assert.deepEqual(hero.map(c => [c.rank, c.suit, c.visibility]), [['8', 's', 'face_up'], ['8', null, 'partially_visible']]);
  const rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.deepEqual(rec.players[0].cards.map(c => c.value), ['8s', null]);
  assert.deepEqual(rec.communityCards.map(c => c.value), ['Ac', '6d', null, '5c']);
  const issues = physicalIssues(obs, DEMO_CHIPS).map(i => i.message);
  assert.ok(issues.some(m => /Only part of this card was read: a 8 \(suit unknown\)/.test(m)));
  assert.ok(issues.some(m => /Part of an unreadable card is hidden/.test(m)));
});

test('duplicate cards are blocked, and rank and suit corrections fix them', () => {
  const obs = scan('uncertain-card');
  const blurred = obs.cards.find(c => code(c) === '6s');
  assert.equal(blurred.confidence, 'low');
  // Misread into a duplicate of the A♣ in your hand.
  const dup = setCardValue(obs, blurred.id, 'Ac');
  assert.equal(errors(dup).filter(e => /Ac is detected 2 times/.test(e.message)).length, 2);
  const rankFixed = setCardPart(obs, blurred.id, 'rank', '9');
  const fixed = rankFixed.cards.find(c => c.id === blurred.id);
  assert.deepEqual([fixed.rank, fixed.suit, fixed.source, fixed.confidence], ['9', 's', 'corrected', null]);
  const suitFixed = setCardPart(rankFixed, blurred.id, 'suit', 'c');
  assert.equal(code(suitFixed.cards.find(c => c.id === blurred.id)), '9c');
  assert.equal(physicalToRecognition(rankFixed, DEMO_CHIPS).communityCards[2].source, 'corrected');
  assert.equal(rankFixed.reviewStatus, 'corrected');
});

test('cards can be added, removed as false detections, and reassigned', () => {
  let obs = scan('four-player-board');
  const extra = addCard(obs, { kind: 'board' }, '5c');
  assert.equal(cardsIn(extra, 'board').length, 5);
  assert.equal(extra.cards.at(-1).box, null, 'added cards get no invented position');
  obs = assignCard(extra, extra.cards.at(-1).id, { kind: 'seat', seatId: 'seat-1' });
  assert.ok(errors(obs).some(e => /You has 3 cards/.test(e.message)));
  const rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.equal(rec.players[0].cards.length, 2, 'the shared state never holds more than two hole cards');
  obs = removeCard(obs, obs.cards.at(-1).id);
  assert.equal(errors(obs).length, 0);
});

// ---------------------------------------------------------------------------
// Table geometry
// ---------------------------------------------------------------------------

const seat = (id, x, y) => ({ id, label: { value: id, confidence: null, source: 'observed' }, center: { x, y }, status: { value: 'active', confidence: null, source: 'observed' }, stackOverride: { value: null, confidence: null, source: 'observed' }, betOverride: { value: null, confidence: null, source: 'observed' } });

test('seats are ordered clockwise from your seat, whichever way the camera faces', () => {
  const seats = [seat('n', 0.5, 0.1), seat('e', 0.9, 0.5), seat('s', 0.5, 0.9), seat('w', 0.1, 0.5)];
  const c = { x: 0.5, y: 0.5 };
  assert.deepEqual(clockwiseOrder(seats, c, null).map(s => s.id), ['s', 'w', 'n', 'e'], 'from the seat nearest the camera');
  assert.deepEqual(clockwiseOrder(seats, c, 'n').map(s => s.id), ['n', 'e', 's', 'w'], 'from your seat at the far side');
  // The same table photographed upside down keeps the same clockwise order.
  const flipped = seats.map(s => ({ ...s, center: { x: 1 - s.center.x, y: 1 - s.center.y } }));
  assert.deepEqual(clockwiseOrder(flipped, c, 's').map(s => s.id), ['s', 'w', 'n', 'e']);
});

test('cards are grouped by nearest seat; near-ties and disagreements stay unassigned with a reason', () => {
  const seats = [seat('a', 0.2, 0.5), seat('b', 0.8, 0.5)];
  assert.deepEqual(zoneAt({ x: 0.25, y: 0.5 }, seats, { x: 0.5, y: 0.5 }), { zone: { kind: 'seat', seatId: 'a' }, ambiguous: false });
  assert.deepEqual(zoneAt({ x: 0.5, y: 0.52 }, seats, { x: 0.5, y: 0.5 }), { zone: { kind: 'board' }, ambiguous: false });
  assert.equal(zoneAt({ x: 0.5, y: 0.9 }, seats, null).ambiguous, true);

  // The reader put one of Kim's cards with Pat: the geometry disagrees, so the card waits for the user.
  const wrong = structuredClone(physicalFixtureById('four-player-board').response);
  wrong.result.cards[4].seat = 1;
  let obs = interpretTable(parsePhysicalResponse(wrong, 'x'));
  const moved = obs.cards[4];
  assert.equal(moved.zone.kind, 'unassigned');
  assert.match(moved.zoneNote, /placed this card with Pat, but it lies closer to Kim/);
  obs = assignCard(obs, moved.id, { kind: 'seat', seatId: 'seat-4' });
  assert.deepEqual(obs.cards[4].zone, { kind: 'seat', seatId: 'seat-4' });
  assert.equal(obs.cards[4].zoneSource, 'user');
  // A user placement survives later geometry changes.
  obs = setTableCenter(obs, { x: 0.1, y: 0.1 });
  assert.deepEqual(obs.cards[4].zone, { kind: 'seat', seatId: 'seat-4' });
});

test('the reader’s ungrouped cards are placed by position, and the dealer by the button', () => {
  const raw = structuredClone(physicalFixtureById('four-player-board').response);
  for (const c of raw.result.cards) { c.zone = 'unknown'; c.seat = null; }
  raw.result.dealerButton.seat = null;
  const obs = interpretTable(parsePhysicalResponse(raw, 'x'));
  assert.deepEqual(cardsIn(obs, 'board').map(code), ['Kh', '9h', '3d', '2s']);
  assert.deepEqual(cardsIn(obs, 'seat', 'seat-1').map(code), ['Ah', 'Jc']);
  assert.ok(obs.cards.every(c => c.zoneSource === 'geometry'));
  assert.equal(obs.dealerSeatId, 'seat-3');
});

test('seat corrections: reorder, add, remove, mark yourself and the dealer, place on the photo', () => {
  let obs = scan('four-player-board');
  obs = moveSeatArea(obs, 'seat-4', 1);
  assert.deepEqual(obs.seats.map(s => s.label.value), ['You', 'Kim', 'Pat', 'Lee']);
  assert.equal(obs.seatOrderSource, 'user');
  const rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.equal(rec.seatOrderCorrected, true);
  assert.equal(rec.players[rec.dealerSeat.value].name.value, 'Lee', 'the dealer stays with the same player');
  assert.equal(setTableCenter(obs, { x: 0.5, y: 0.5 }).seats.map(s => s.id).join(), obs.seats.map(s => s.id).join(), 'a user order is never re-sorted');
  obs = setDealer(setHero(obs, 'seat-2'), 'seat-4');
  const changed = physicalToRecognition(obs, DEMO_CHIPS);
  assert.deepEqual([changed.heroSeat.value, changed.heroSeat.source, changed.dealerSeat.value], [2, 'corrected', 1]);
  obs = removeSeat(obs, 'seat-2');
  assert.ok(cardsIn(obs, 'unassigned').length === 2, 'a removed seat’s cards become unassigned, not lost');
  assert.equal(obs.heroSeatId, null);
  obs = addSeat(obs, 'Pat again');
  obs = setSeatPosition(obs, obs.seats.at(-1).id, { x: 0.14, y: 0.5 });
  assert.ok(obs.seats.at(-1).center);
});

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

test('chip values come from the user’s colours; unknown colours and counts stay unknown', () => {
  const cfg = { denominations: [{ colorLabel: 'Red', value: 5 }, { colorLabel: 'black', value: 100 }] };
  const g = (color, count, countStatus = 'confirmed') => ({ id: 'g', color, count, countStatus, source: 'observed', center: null, box: null, zone: { kind: 'pot' }, zoneSource: 'reader' });
  assert.deepEqual(groupValue(g('red', 4), cfg), { value: 20, status: 'confirmed', reasons: [] });
  assert.equal(groupValue(g('green', 4), cfg).value, null, 'no value is assumed for green');
  assert.equal(groupValue(g('red', null, 'unknown'), cfg).value, null);
  assert.deepEqual(sumGroups([g('red', 2), g('black', 3, 'estimated')], cfg), { value: 310, status: 'estimated', reasons: ['A chip count is estimated.'] });
  assert.deepEqual(sumGroups([], cfg), { value: null, status: 'unknown', reasons: ['No chips were found here.'] });
  assert.deepEqual(chipConfigProblems({ denominations: [{ colorLabel: 'red', value: 0 }, { colorLabel: ' Red ', value: 2.5 }, { colorLabel: '', value: 1 }] }).length, 4);
  assert.throws(() => parseChipConfig({ denominations: [{ colorLabel: 'red', value: -5 }] }), /whole number/);
  assert.throws(() => parseChipConfig('red=5'), /list of denominations/);
});

test('overlapping chips are estimated or unknown, and corrections confirm them', () => {
  let obs = scan('chip-stacks');
  let rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.deepEqual(rec.players.map(p => [p.stack.value, p.stack.confidence]), [[500, 'high'], [450, 'low'], [null, null]]);
  assert.deepEqual(rec.players.map(p => [p.bet.value, p.bet.confidence]), [[100, 'high'], [100, 'high'], [0, 'medium']], 'an empty bet area seen in the photo is an observed 0');
  assert.equal(rec.pot.value, 150);
  const messy = obs.chips.find(g => g.countStatus === 'estimated');
  const uncounted = obs.chips.find(g => g.countStatus === 'unknown');
  assert.equal(uncounted.count, null);
  obs = setChipCount(obs, messy.id, 6, 'confirmed');
  obs = setChipCount(obs, uncounted.id, 7, 'confirmed');
  rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.deepEqual(rec.players.map(p => [p.stack.value, p.stack.confidence]), [[500, 'high'], [450, 'high'], [700, 'high']]);
  // A colour with no value makes the amount unknown again, and is flagged.
  obs = setChipColor(obs, uncounted.id, 'purple');
  assert.equal(physicalToRecognition(obs, DEMO_CHIPS).players[2].stack.value, null);
  assert.ok(physicalIssues(obs, DEMO_CHIPS).some(i => /No value is set for purple chips/.test(i.message)));
  // Typed amounts override chips; chips can be moved between stack, bet, and pot.
  obs = setSeatStack(obs, 'seat-3', 640);
  assert.deepEqual(physicalToRecognition(obs, DEMO_CHIPS).players[2].stack, { value: 640, confidence: null, source: 'corrected' });
  const potGroup = obs.chips.find(g => g.zone.kind === 'pot');
  obs = assignChips(obs, potGroup.id, { kind: 'bet', seatId: 'seat-2' });
  assert.equal(physicalToRecognition(obs, DEMO_CHIPS).players[1].bet.value, 200);
});

test('with no chip values set, chips never turn into amounts', () => {
  const rec = physicalToRecognition(scan('two-player-clear'), { denominations: [] });
  assert.ok(rec.players.every(p => p.stack.value === null && p.bet.value === null));
  assert.ok(physicalIssues(scan('two-player-clear'), { denominations: [] }).some(i => /Set your chip values/.test(i.message)));
});

// ---------------------------------------------------------------------------
// Photo quality
// ---------------------------------------------------------------------------

function pixels(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = fill(x, y);
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

test('quality checks report measured darkness, glare, low resolution, and blur only with evidence', () => {
  const big = { width: 2000, height: 1500 };
  const sharp = pixels(64, 64, (x, y) => ((x + y) % 2 ? 230 : 40));
  assert.deepEqual(photoChecks(sharp, big).checks, []);
  const dark = photoChecks(pixels(64, 64, (x, y) => ((x + y) % 2 ? 50 : 10)), big).checks;
  assert.deepEqual(dark.map(c => c.id), ['dark']);
  assert.match(dark[0].evidence, /Average brightness \d+%/);
  const glare = photoChecks(pixels(64, 64, x => (x < 16 ? 255 : (x % 2 ? 160 : 60))), big).checks;
  assert.ok(glare.some(c => c.id === 'glare' && /near white/.test(c.evidence)));
  assert.ok(photoChecks(sharp, { width: 640, height: 480 }).checks.some(c => c.id === 'resolution' && /640×480/.test(c.evidence)));
  const soft = photoChecks(pixels(64, 64, x => 40 + x * 3), big);
  assert.ok(soft.checks.some(c => c.id === 'blur' && /Sharpness score/.test(c.evidence)));
  // A flat image has no edges to judge, so no blur claim is made.
  const flat = pixelMetrics(pixels(32, 32, () => 128));
  assert.equal(flat.sharpness, null);
  assert.ok(!photoChecks(pixels(32, 32, () => 128), big).checks.some(c => c.id === 'blur'));
});

test('framing checks use the reader’s card boxes', () => {
  const ok = scan('two-player-clear');
  assert.deepEqual(framingChecks(ok), []);
  const edge = structuredClone(physicalFixtureById('two-player-clear').response);
  edge.result.cards[0].box = { x: 0, y: 0.5, width: 0.05, height: 0.1 };
  assert.ok(framingChecks(parsePhysicalResponse(edge, 'x')).some(c => c.id === 'edge'));
  const tiny = structuredClone(physicalFixtureById('two-player-clear').response);
  tiny.result.cards.forEach((c, i) => { c.box = { x: 0.45 + i * 0.01, y: 0.45, width: 0.02, height: 0.03 }; });
  tiny.result.seats.forEach((st, i) => { st.position = { x: 0.48, y: 0.42 + i * 0.1 }; });
  tiny.result.chips = [];
  assert.ok(framingChecks(parsePhysicalResponse(tiny, 'x')).some(c => c.id === 'small'));
  const empty = structuredClone(physicalFixtureById('two-player-clear').response);
  empty.result.cards = [];
  assert.deepEqual(framingChecks(parsePhysicalResponse(empty, 'x')).map(c => c.id), ['empty']);
});

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function fakeMedia({ error, devices = [{ kind: 'videoinput', deviceId: 'rear', label: 'Back' }], delay } = {}) {
  const calls = [];
  const streams = [];
  return {
    calls, streams,
    media: {
      async getUserMedia(constraints) {
        calls.push(constraints);
        if (delay) await delay;
        if (error) throw Object.assign(new Error('x'), { name: error });
        const id = constraints.video.deviceId?.exact ?? 'rear';
        const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ deviceId: id }) };
        const stream = { track, getTracks: () => [track] };
        streams.push(stream);
        return stream;
      },
      async enumerateDevices() { return [...devices, { kind: 'audioinput', deviceId: 'mic', label: 'Mic' }]; },
    },
  };
}

test('the camera starts on request, prefers the rear camera, and releases it', async () => {
  const fake = fakeMedia();
  const camera = new CameraController(fake.media, true);
  assert.equal(camera.available, true);
  assert.equal(fake.calls.length, 0, 'nothing starts until asked');
  const started = await camera.start();
  assert.equal(started.ok, true);
  assert.deepEqual(fake.calls[0].video.facingMode, { ideal: 'environment' });
  assert.equal(fake.calls[0].audio, false);
  assert.equal(camera.canSwitch, false);
  camera.stop();
  assert.equal(fake.streams[0].track.stopped, true);
  assert.equal(camera.live, false);
});

test('camera permission denied, missing, busy, insecure, and unsupported cases fall back to upload', async () => {
  for (const [name, reason] of [['NotAllowedError', 'denied'], ['NotFoundError', 'not-found'], ['NotReadableError', 'busy'], ['TypeError', 'error']]) {
    const result = await new CameraController(fakeMedia({ error: name }).media, true).start();
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.match(result.message, /upload a photo|Upload a photo/);
  }
  assert.equal((await new CameraController(undefined, true).start()).reason, 'unsupported');
  assert.equal(new CameraController(undefined, true).available, false);
  const insecure = new CameraController(fakeMedia().media, false);
  assert.equal(insecure.available, false);
  assert.equal((await insecure.start()).reason, 'insecure');
});

test('closing the camera while permission is pending releases the late stream', async () => {
  let release;
  const fake = fakeMedia({ delay: new Promise(r => { release = r; }) });
  const camera = new CameraController(fake.media, true);
  const pending = camera.start();
  camera.stop();
  release();
  const result = await pending;
  assert.deepEqual([result.ok, result.reason], [false, 'cancelled']);
  assert.equal(fake.streams[0].track.stopped, true, 'no camera is left running');
  assert.equal(camera.live, false);
});

test('switching cameras cycles devices and stops the previous stream', async () => {
  const fake = fakeMedia({ devices: [{ kind: 'videoinput', deviceId: 'rear', label: 'Back' }, { kind: 'videoinput', deviceId: 'front', label: 'Front' }] });
  const camera = new CameraController(fake.media, true);
  await camera.start();
  assert.equal(camera.canSwitch, true);
  const switched = await camera.switchCamera();
  assert.equal(switched.ok, true);
  assert.deepEqual(fake.calls[1].video.deviceId, { exact: 'front' });
  assert.equal(fake.streams[0].track.stopped, true);
  camera.stop();
  assert.equal(fake.streams[1].track.stopped, true);
});

// ---------------------------------------------------------------------------
// Conversion and validation
// ---------------------------------------------------------------------------

test('a reviewed photo converts to the shared state and passes the existing validation', () => {
  let obs = scan('two-player-clear');
  let rec = physicalToRecognition(obs, DEMO_CHIPS);
  assert.deepEqual(rec.players.map(p => [p.name.value, p.stack.value, p.bet.value]), [['You', 995, 5], ['Riley', 990, 10]]);
  assert.deepEqual([rec.heroSeat.value, rec.dealerSeat.value, rec.street.value, rec.street.source], [0, 0, 'preflop', 'inferred']);
  assert.deepEqual(rec.players[1].cards.map(c => [c.value, c.hidden]), [[null, true], [null, true]]);
  // Missing pieces are requested, never invented.
  const missing = toStudySnapshot(rec, 'simulation');
  assert.deepEqual(missing.problems, ['Enter the big blind; it sets the minimum bet.']);
  assert.deepEqual(rec.pot, { value: 0, confidence: 'medium', source: 'observed' }, 'an empty middle seen in the photo is an observed 0');
  // When the middle is not clearly visible, the pot stays unknown.
  const unclear = structuredClone(physicalFixtureById('two-player-clear').response);
  unclear.result.potArea = 'unclear';
  assert.equal(physicalToRecognition(interpretTable(parsePhysicalResponse(unclear, 'x')), DEMO_CHIPS).pot.value, null);
  obs = setBlinds(setPot(obs, 0), 5, 10);
  rec = physicalToRecognition(obs, DEMO_CHIPS);
  const ok = toStudySnapshot(rec, 'simulation');
  assert.ok(ok.snapshot, JSON.stringify(ok.problems));
  assert.deepEqual([ok.snapshot.hero, ok.snapshot.heroStack, ok.snapshot.committed, ok.snapshot.pot], [['As', 'Kd'], 995, 5, 15]);
  assert.deepEqual(reviewScreenshot(rec).filter(i => i.severity === 'error'), []);
  // A conversion of a bet the user typed as zero.
  const zero = physicalToRecognition(setSeatBet(scan('angled-photo'), 'seat-1', 0), DEMO_CHIPS);
  assert.deepEqual(zero.players[0].bet, { value: 0, confidence: null, source: 'corrected' });
});

// ---------------------------------------------------------------------------
// Providers and the server
// ---------------------------------------------------------------------------

test('physical providers: samples are marked, failures and cancels are reported, nothing throws', async () => {
  const sample = fixturePhysicalProvider(physicalFixtureById('chip-stacks').response, 'sample:chip-stacks');
  assert.equal(sample.isSample, true);
  const read = await sample.recognizePhysicalTable(image);
  assert.equal(read.kind, 'recognized');
  assert.equal(read.observation.providerId, 'sample:chip-stacks');
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await sample.recognizePhysicalTable(image, aborted.signal), { kind: 'cancelled' });
  assert.equal((await fixturePhysicalProvider({ modelId: 'm', result: { seats: 'x' } }).recognizePhysicalTable(image)).kind, 'failed');
  const asScreenshot = await physicalAsScreenshotProvider(sample, () => DEMO_CHIPS).recognize(image);
  assert.equal(asScreenshot.recognition.players[0].stack.value, 500);

  const original = globalThis.fetch;
  try {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(physicalFixtureById('four-player-board').response), { status: 200 }); };
    const ok = await claudePhysicalProvider().recognizePhysicalTable(image);
    assert.equal(ok.kind, 'recognized');
    assert.equal(sent.url, './api/recognize?layout=physical');
    assert.equal(ok.observation.providerId, 'claude-physical');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Cloud recognition is not set up. Start the server with ANTHROPIC_API_KEY set.' }), { status: 503 });
    const missingKey = await claudePhysicalProvider().recognizePhysicalTable(image);
    assert.deepEqual([missingKey.kind, missingKey.retryable], ['failed', false]);
    globalThis.fetch = async () => new Response(JSON.stringify({ modelId: 'm', result: { seats: [], cards: [{ card: 'Zz' }], chips: [] } }), { status: 200 });
    assert.match((await claudePhysicalProvider().recognizePhysicalTable(image)).reason, /malformed/);
    globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    assert.match((await claudePhysicalProvider('./api/recognize?layout=physical', 20).recognizePhysicalTable(image)).reason, /too long/);
    const controller = new AbortController();
    const pending = claudePhysicalProvider().recognizePhysicalTable(image, controller.signal);
    controller.abort();
    assert.deepEqual(await pending, { kind: 'cancelled' });
  } finally {
    globalThis.fetch = original;
  }
});

test('the server reads table photos through the same endpoint with their own schema', async () => {
  const calls = [];
  const handler = createRecognizeHandler({
    getClient: () => ({ beta: { messages: { create: async params => { calls.push(params); return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(readingFor(physicalFixtureById('two-player-clear').scene)) }] }; } } } }),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(base + '/api/recognize?layout=physical', { method: 'POST', body: new Uint8Array([1, 2]), headers: { 'Content-Type': 'image/jpeg', Origin: base } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.layout, 'physical');
    assert.equal(parsePhysicalResponse(body, 'claude-physical').seats.length, 2);
    assert.deepEqual(calls[0].output_config.format.schema, PHYSICAL_SCHEMA);
    assert.match(calls[0].system, /physical Texas Hold'em table/);
    assert.match(calls[0].system, /Never convert chips to money/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Step 4 tracking, replay, and persistence
// ---------------------------------------------------------------------------

function photoFrames() {
  return PHYSICAL_SEQUENCE.map((f, i) => {
    const rec = physicalToRecognition(interpretTable(parsePhysicalResponse(f.response, 'sample', f.scene.id)), DEMO_CHIPS);
    return createObservation('photo-' + i, i, rec, { source: 'physical_photo' });
  });
}

test('a sequence of table photos runs through the Step 4 tracking engine', () => {
  const obs = photoFrames();
  assert.ok(obs.every(o => o.source === 'physical_photo' && o.timestampMs === null));
  const result = reconstructHand(obs);
  assert.deepEqual(result.identity.players.map(p => p.id), ['name:you', 'name:riley', 'name:sam']);
  assert.equal(result.metrics.contradictions, 0, 'chips are conserved across the photos');
  assert.deepEqual(result.intervals.map(i => i.middleChange), [15, 40]);
  assert.ok(result.intervals[1].differences.some(d => d.kind === 'status-changed' && d.playerId === 'name:sam'));
  assert.ok(result.intervals.every(i => i.consistency === 'ambiguous'), 'chip movement without known actions stays unresolved');
  assert.deepEqual(buildReplaySteps(result).map(s => s.kind), ['checkpoint', 'unresolved', 'checkpoint', 'unresolved', 'checkpoint']);
  // A misread card in one photo is a contradiction across photos.
  const misread = structuredClone(PHYSICAL_SEQUENCE[2].response);
  misread.result.cards.find(c => c.card === '8d').card = '8h';
  const bad = physicalToRecognition(interpretTable(parsePhysicalResponse(misread, 'x')), DEMO_CHIPS);
  const withError = reconstructHand([obs[0], obs[1], { ...createObservation('photo-x', 2, bad, { source: 'physical_photo' }) }]);
  assert.equal(withError.intervals[1].consistency, 'contradictory');
});

test('tracking sessions keep photo frames and report the photos source type', () => {
  const obs = photoFrames();
  const session = createSession({
    id: 'photos', title: 'Photos', createdAt: '2026-11-11T10:00:00.000Z',
    screenshots: obs.map((o, i) => ({ id: o.screenshotId, label: 'photo ' + i, uploadIndex: i, source: 'physical_photo' })),
    observations: obs, resolutions: [],
  });
  assert.equal(session.sourceType, 'photos');
  assert.deepEqual(parseSession(serializeSession(session)), session);
  const tampered = JSON.parse(serializeSession(session));
  tampered.screenshots[0].source = 'webcam';
  assert.throws(() => parseSession(tampered), /frame source/);
});

