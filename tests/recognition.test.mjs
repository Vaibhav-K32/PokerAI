// Cloud card recognition: payload validation, the browser client, and the
// server endpoint. The Claude client is faked; no test calls the real API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cloudRecognizer, toRecognition } from '../dist/vision/recognizer.js';
import { buildRequest, createRecognizeHandler, MAX_IMAGE_BYTES, MODEL, RESULT_SCHEMA } from '../scripts/recognize.mjs';

const card = (code, confidence = 'high') => ({ card: code, confidence });
const payload = (result, modelId = 'claude-opus-5-5') => ({
  modelId,
  result: { opponent: [], board: [], hero: [], issues: [], ...result },
});

test('maps rows to table slots with confidence labels and unreadable cards', () => {
  const recognition = toRecognition(payload({
    opponent: [card('Qh', 'medium'), card('unknown', 'low')],
    board: [card('Ts'), card('9s'), card('2d')],
    hero: [card('As'), card('Ks')],
    issues: ['Glare on the opponent cards.'],
  }));
  assert.equal(recognition.kind, 'observations');
  assert.equal(recognition.modelId, 'claude-opus-5-5');
  assert.deepEqual(recognition.issues, ['Glare on the opponent cards.']);
  assert.deepEqual(recognition.slots.map(s => s.slot), [
    'opponent-1', 'opponent-2', 'board-1', 'board-2', 'board-3', 'hero-1', 'hero-2',
  ]);
  const unreadable = recognition.slots[1];
  assert.deepEqual(unreadable.candidates, []);
  assert.equal(unreadable.confidence, 'low');
  assert.deepEqual(recognition.slots[0].candidates, [{ card: 'Qh', score: 0.5 }]);
  assert.equal(recognition.slots[5].group, 'hero');
  assert.equal(recognition.slots[5].index, 0);
  assert.ok(recognition.slots.every(s => !s.duplicate));
});

test('flags the same card read in two slots', () => {
  const recognition = toRecognition(payload({ board: [card('As'), card('7c'), card('2d')], hero: [card('As'), card('Kd')] }));
  const flagged = recognition.slots.filter(s => s.duplicate).map(s => s.slot);
  assert.deepEqual(flagged, ['board-1', 'hero-1']);
});

test('rejects malformed, oversized, and invalid recognition payloads', () => {
  assert.throws(() => toRecognition(null), /malformed/);
  assert.throws(() => toRecognition({ modelId: 'x' }), /malformed/);
  assert.throws(() => toRecognition(payload({ hero: 'As Ks' })), /malformed/);
  assert.throws(() => toRecognition(payload({ hero: [card('As'), card('Ks'), card('Qs')] })), /more than 2 hero/);
  assert.throws(() => toRecognition(payload({ board: Array.from({ length: 6 }, (_, i) => card('23456789'[i] + 'c')) })), /more than 5 board/);
  assert.throws(() => toRecognition(payload({ hero: [card('Zz')] })), /invalid card/);
  assert.throws(() => toRecognition(payload({ hero: [{ card: 'As', confidence: 'certain' }] })), /malformed/);
  const capped = toRecognition(payload({ issues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 42] }));
  assert.equal(capped.issues.length, 6);
});

test('the request schema matches the slot limits the client enforces', () => {
  assert.deepEqual(RESULT_SCHEMA.required, ['opponent', 'board', 'hero', 'issues']);
  const codes = RESULT_SCHEMA.properties.hero.items.properties.card.enum;
  assert.equal(codes.length, 53);
  assert.ok(codes.includes('Td') && codes.includes('unknown'));
  const request = buildRequest(Buffer.from([1, 2, 3]), 'image/jpeg');
  assert.equal(request.model, MODEL);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.output_config.format, { type: 'json_schema', schema: RESULT_SCHEMA });
  const [image, text] = request.messages[0].content;
  assert.deepEqual(image.source, { type: 'base64', media_type: 'image/jpeg', data: 'AQID' });
  assert.equal(text.type, 'text');
  assert.ok(!('thinking' in request) && !('temperature' in request));
});

// ---------------------------------------------------------------------------
// Server endpoint
// ---------------------------------------------------------------------------
async function withServer(handlerOptions, run) {
  const handler = createRecognizeHandler(handlerOptions);
  const server = createServer((request, response) => void handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (base, body, headers = {}) => fetch(base + '/api/recognize', {
  method: 'POST', body,
  headers: { 'Content-Type': 'image/jpeg', Origin: base, ...headers },
});

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    getClient: () => ({ beta: { messages: { create: async params => { calls.push(params); return reply(params); } } } }),
  };
}

const okResult = { opponent: [], board: [card('Qs'), card('Js'), card('4d')], hero: [card('As'), card('Ks')], issues: [] };

test('endpoint forwards one same-origin image and returns the parsed cards', async () => {
  const fake = fakeClient(() => ({
    model: 'claude-opus-5-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(okResult) }],
  }));
  await withServer({ getClient: fake.getClient }, async base => {
    const response = await post(base, new Uint8Array([255, 216, 255]));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { modelId: 'claude-opus-5-5', result: okResult });
    assert.equal(toRecognition(body).slots.length, 5);
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].messages[0].content[0].source.data, Buffer.from([255, 216, 255]).toString('base64'));
});

test('endpoint rejects other origins, methods, types, sizes, and empty bodies without calling Claude', async () => {
  const fake = fakeClient(() => { throw new Error('should not be called'); });
  await withServer({ getClient: fake.getClient }, async base => {
    assert.equal((await post(base, 'x', { Origin: 'https://evil.example' })).status, 403);
    const noOrigin = await fetch(base + '/api/recognize', { method: 'POST', body: 'x', headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(noOrigin.status, 403);
    assert.equal((await fetch(base + '/api/recognize')).status, 405);
    assert.equal((await post(base, 'x', { 'Content-Type': 'image/gif' })).status, 415);
    assert.equal((await post(base, new Uint8Array(MAX_IMAGE_BYTES + 1))).status, 413);
    assert.equal((await post(base, new Uint8Array(0))).status, 400);
  });
  assert.equal(fake.calls.length, 0);
});

test('endpoint reports missing setup, refusals, truncation, and API failures as errors', async () => {
  await withServer({ getClient: () => { throw new Error('no key'); } }, async base => {
    const response = await post(base, 'x');
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /ANTHROPIC_API_KEY/);
  });
  const cases = [
    [() => ({ stop_reason: 'refusal', content: [] }), 422, /declined/],
    [() => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"hero":' }] }), 502, /incomplete/],
    [() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), 502, /unreadable/],
    [() => { throw new Error('network down'); }, 502, /Cloud recognition failed/],
  ];
  for (const [reply, status, message] of cases) {
    await withServer({ getClient: fakeClient(reply).getClient }, async base => {
      const response = await post(base, 'x');
      assert.equal(response.status, status);
      assert.match((await response.json()).error, message);
    });
  }
});

// ---------------------------------------------------------------------------
// Browser client
// ---------------------------------------------------------------------------
test('browser client turns server answers into recognitions or unavailable reasons', async () => {
  const original = globalThis.fetch;
  const image = new Blob([new Uint8Array([1, 2])], { type: 'image/jpeg' });
  try {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify({ modelId: 'claude-opus-5-5', result: okResult }), { status: 200 });
    };
    const ok = await cloudRecognizer('/api/recognize').recognize(image);
    assert.equal(ok.kind, 'observations');
    assert.equal(sent.init.method, 'POST');
    assert.equal(sent.init.headers['Content-Type'], 'image/jpeg');

    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.match((await cloudRecognizer().recognize(image)).reason, /not available on this server/);

    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Cloud recognition is not set up.' }), { status: 503 });
    assert.deepEqual(await cloudRecognizer().recognize(image), { kind: 'unavailable', reason: 'Cloud recognition is not set up.' });

    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.match((await cloudRecognizer().recognize(image)).reason, /could not be reached/);

    globalThis.fetch = async () => new Response(JSON.stringify({ modelId: 'x', result: { hero: 'bad' } }), { status: 200 });
    await assert.rejects(cloudRecognizer().recognize(image), /malformed/);
  } finally {
    globalThis.fetch = original;
  }
});
