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
  required: ['opponent', 'board', 'hero', 'issues'],
  properties: {
    opponent: { type: 'array', items: slot },
    board: { type: 'array', items: slot },
    hero: { type: 'array', items: slot },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You transcribe physical playing cards from a single photo for a poker study app. The user reviews and confirms every card you report, so accuracy matters more than completeness.

The user lays the cards out face-up in three rows:
- opponent: the two hole cards in the row farthest from the camera (top of the image)
- board: the community cards in the middle row, read left to right (up to five)
- hero: the user's two hole cards in the row nearest the camera (bottom of the image)

Card codes are a rank from 2 3 4 5 6 7 8 9 T J Q K A followed by a suit letter: c clubs, d diamonds, h hearts, s spades. A ten is T.

Report only cards that are face-up and visible. Leave out face-down cards, card backs, and empty positions; do not guess hidden cards. When a face-up card is visible but you cannot read both rank and suit with certainty (glare, blur, occlusion, angle), report it as "unknown". Use "high" confidence only when both the rank and the suit indices are clearly legible. Ignore chips, hands, and other objects; never estimate bets or positions. If the layout does not match the three rows, assign cards as best you can and describe the problem in issues. Put short, plain-language notes about glare, blur, cropping, layout, or duplicate-looking cards in issues, or leave it empty.`;

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
export function buildRequest(image, mediaType, model = MODEL) {
  return {
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
        { type: 'text', text: 'Transcribe the face-up cards in this photo by row.' },
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
      message = await client.beta.messages.create(buildRequest(image, mediaType, model));
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
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
      send(response, 200, { modelId: message.model, result: JSON.parse(text) });
    } catch {
      send(response, 502, { error: 'Claude returned an unreadable answer. Try again.' });
    }
  };
}
