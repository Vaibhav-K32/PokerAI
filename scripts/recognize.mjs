// Server-side card recognition through the Claude API. The browser posts one
// downscaled still per explicit user request. The image is held in memory for
// the request only and is never logged or written to disk.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const ranks = '23456789TJQKA';
export const CARD_CODES = [...ranks].flatMap(rank => [...'cdhs'].map(suit => rank + suit));

const slot = {
  type: 'object',
  additionalProperties: false,
  required: ['card', 'confidence'],
  properties: {
    card: { type: 'string', enum: [...CARD_CODES, 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opponents', 'board', 'hero', 'issues'],
  properties: {
    // One entry per opponent, left to right; an empty list for face-down cards.
    opponents: { type: 'array', items: { type: 'array', items: slot } },
    board: { type: 'array', items: slot },
    hero: { type: 'array', items: slot },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You transcribe physical playing cards from a single photo for a poker study app. The user reviews and confirms every card you report, so accuracy matters more than completeness.

The user lays the cards out in three rows:
- opponents: the row farthest from the camera (top of the image) holds one to three opponents' hole cards, two cards per opponent, as separate pairs from left to right. Return one entry per opponent pair in that left-to-right order. If an opponent's pair is face-down, return an empty list for that opponent so the seats stay in order.
- board: the community cards in the middle row, read left to right (up to five)
- hero: the user's two hole cards in the row nearest the camera (bottom of the image)

Card codes are a rank from 2 3 4 5 6 7 8 9 T J Q K A followed by a suit letter: c clubs, d diamonds, h hearts, s spades. A ten is T.

Report only cards that are face-up and visible. Leave out face-down cards, card backs, and empty positions; do not guess hidden cards. When a face-up card is visible but you cannot read both rank and suit with certainty (glare, blur, occlusion, angle), report it as "unknown". Use "high" confidence only when both the rank and the suit indices are clearly legible. Ignore chips, hands, and other objects; never estimate bets or positions. Never report more than three opponents or more than two cards for one opponent. If the layout does not match the three rows, assign cards as best you can and describe the problem in issues. Put short, plain-language notes about glare, blur, cropping, layout, or duplicate-looking cards in issues, or leave it empty.`;

// ---------------------------------------------------------------------------
// Screenshot layout: a digital table from a simulated or completed hand.
// ---------------------------------------------------------------------------
const confidence = { type: 'string', enum: ['high', 'medium', 'low', 'none'] };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const field = value => ({
  type: 'object', additionalProperties: false, required: ['value', 'confidence'],
  properties: { value, confidence },
});
const screenCard = {
  type: 'object', additionalProperties: false, required: ['card', 'confidence'],
  properties: { card: { type: 'string', enum: [...CARD_CODES, 'unknown', 'hidden'] }, confidence },
};
const screenSeat = {
  type: 'object', additionalProperties: false,
  required: ['name', 'stack', 'bet', 'status', 'cards'],
  properties: {
    name: field(nullable({ type: 'string' })),
    stack: field(nullable({ type: 'integer' })),
    bet: field(nullable({ type: 'integer' })),
    status: field({ type: 'string', enum: ['active', 'folded', 'unknown'] }),
    cards: { type: 'array', items: screenCard },
  },
};
export const SCREENSHOT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['players', 'board', 'pot', 'smallBlind', 'bigBlind', 'dealerSeat', 'heroSeat', 'street', 'issues'],
  properties: {
    players: { type: 'array', items: screenSeat },
    board: { type: 'array', items: screenCard },
    pot: field(nullable({ type: 'integer' })),
    smallBlind: field(nullable({ type: 'integer' })),
    bigBlind: field(nullable({ type: 'integer' })),
    // Indexes into players.
    dealerSeat: field(nullable({ type: 'integer' })),
    heroSeat: field(nullable({ type: 'integer' })),
    street: field(nullable({ type: 'string', enum: ['preflop', 'flop', 'turn', 'river'] })),
    issues: { type: 'array', items: { type: 'string' } },
  },
};

const SCREENSHOT_SYSTEM = `You read one screenshot of a digital Texas Hold'em table for an offline poker study app. The hand is simulated or already finished. The user reviews and corrects everything you report, so report only what you can see; accuracy matters more than completeness.

Players: list every visible seat in clockwise order, starting with the seat at the bottom center of the table (usually the user's own seat) and continuing to its left. For each seat report:
- name: the player label if legible, else null
- stack: the chip count shown for that seat as a whole number (strip commas and currency symbols; if the stack is shown only in big blinds or is unreadable, use null)
- bet: chips in front of the seat for the current betting round as a whole number, 0 only when the seat clearly has no bet in front, null when you cannot tell
- status: "folded" when the seat is clearly out of the hand (greyed out, a Fold label, no cards while others have cards), "active" when clearly still in, otherwise "unknown"
- cards: the seat's hole cards. Use the card code when face-up and readable, "unknown" when face-up but not readable, "hidden" for a face-down card back, and an empty list when the seat shows no cards at all.

Board: the community cards left to right (0 to 5). Pot: the total pot number displayed in the middle, else null. Blinds: only if displayed as text, else null. dealerSeat and heroSeat: indexes into your players list for the seat with the dealer button and for the user's own seat (face-up hole cards at the bottom), else null. Street: only if the screen states it in text; otherwise null.

Card codes are a rank from 2 3 4 5 6 7 8 9 T J Q K A followed by a suit letter: c clubs, d diamonds, h hearts, s spades. A ten is T.

For every field give a confidence: "high" only when it is clearly legible, "medium" or "low" when you are unsure, and "none" when the value is null. Never compute, estimate, or infer a value from game rules or other fields; report null instead. Never advise on play. Put short notes about cropping, overlapping elements, unreadable text, or unusual layouts in issues.`;

/** Prompt and schema for each supported layout. */
export const LAYOUTS = {
  cards: { system: SYSTEM, schema: RESULT_SCHEMA, prompt: 'Transcribe the face-up cards in this photo by row.' },
  screenshot: { system: SCREENSHOT_SYSTEM, schema: SCREENSHOT_SCHEMA, prompt: 'Read the table state shown in this screenshot.' },
};

/** Upper bound for one recognition request. */
export const REQUEST_TIMEOUT_MS = 90_000;

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Build the Messages API request for one image. Exported for tests. */
export function buildRequest(image, mediaType, model = MODEL, layout = 'cards') {
  const { system, schema, prompt } = LAYOUTS[layout];
  return {
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  };
}

/**
 * Create the POST /api/recognize handler. `getClient` is injectable for tests;
 * by default it builds a client from ANTHROPIC_API_KEY or another SDK credential.
 */
export function createRecognizeHandler({ getClient = () => new Anthropic(), model = MODEL } = {}) {
  let client = null;
  return async function recognize(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!sameOrigin(request)) {
      send(response, 403, { error: 'Recognition requests must come from this app.' });
      return;
    }
    const layout = new URL(request.url ?? '/', 'http://localhost').searchParams.get('layout') ?? 'cards';
    if (!Object.hasOwn(LAYOUTS, layout)) {
      send(response, 400, { error: 'Unknown recognition layout.' });
      return;
    }
    const mediaType = (request.headers['content-type'] ?? '').split(';')[0].trim();
    if (!IMAGE_TYPES.has(mediaType)) {
      send(response, 415, { error: 'Send a JPEG, PNG, or WebP image.' });
      return;
    }
    const image = await readBody(request, MAX_IMAGE_BYTES);
    if (!image) {
      send(response, 413, { error: 'The photo is larger than 5 MB after resizing.' });
      return;
    }
    if (!image.length) {
      send(response, 400, { error: 'The photo is empty.' });
      return;
    }

    try {
      client ??= getClient();
    } catch {
      send(response, 503, { error: 'Cloud recognition is not set up. Start the server with ANTHROPIC_API_KEY set, or enter the cards by hand.' });
      return;
    }

    let message;
    try {
      message = await client.beta.messages.create(buildRequest(image, mediaType, model, layout), { timeout: REQUEST_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        send(response, 504, { error: 'Recognition took too long. Try again, or try a smaller screenshot.' });
      } else if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        send(response, 503, { error: 'The Claude API key was rejected. Check ANTHROPIC_API_KEY on the server.' });
      } else if (error instanceof Anthropic.RateLimitError) {
        send(response, 429, { error: 'The Claude API is rate limited. Try again in a moment.' });
      } else if (error instanceof Anthropic.BadRequestError) {
        send(response, 422, { error: 'Claude could not accept this photo. Try a smaller or clearer image.' });
      } else if (error instanceof Anthropic.APIError) {
        send(response, 502, { error: 'The Claude API returned an error. Try again or enter the cards by hand.' });
      } else {
        send(response, 502, { error: 'Cloud recognition failed. Check that the server has ANTHROPIC_API_KEY set and can reach the internet, or enter the cards by hand.' });
      }
      return;
    }

    if (message.stop_reason === 'refusal') {
      send(response, 422, { error: 'Claude declined to read this photo. Enter the cards by hand.' });
      return;
    }
    const text = message.content.find(block => block.type === 'text')?.text;
    if (message.stop_reason !== 'end_turn' || !text) {
      send(response, 502, { error: 'Claude returned an incomplete answer. Try again.' });
      return;
    }
    try {
      // The photo layout keeps its original response shape.
      send(response, 200, { modelId: message.model, ...(layout === 'cards' ? {} : { layout }), result: JSON.parse(text) });
    } catch {
      send(response, 502, { error: 'Claude returned an unreadable answer. Try again.' });
    }
  };
}
