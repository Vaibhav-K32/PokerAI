// Recognition providers. Each turns one image into a validated result or a
// readable failure, so the rest of the pipeline never depends on which
// provider ran. Screenshots of digital tables and photos of physical tables
// use the same request handling (Claude through the app server) and the same
// deterministic fixtures for tests and demos. A local model can implement the
// same interfaces later.
import { chipConfigProblems } from '../physical/chips.js';
import { physicalToRecognition } from '../physical/convert.js';
import { interpretTable } from '../physical/geometry.js';
import { parsePhysicalResponse } from '../physical/parse.js';
import type { ChipConfiguration, PhysicalTableObservation } from '../physical/types.js';
import { parseScreenshotResponse, RecognitionFormatError, type ScreenshotRecognition } from './screenshot.js';

type Failure = { readonly kind: 'failed'; readonly reason: string; readonly retryable: boolean };
type Cancelled = { readonly kind: 'cancelled' };

export type ScreenshotOutcome =
  | { readonly kind: 'recognized'; readonly recognition: ScreenshotRecognition }
  | Failure
  | Cancelled;

export interface ScreenshotProvider {
  readonly id: string;
  readonly label: string;
  /** Recognize one image. Resolves to a failure instead of throwing. */
  recognize(image: Blob, signal?: AbortSignal): Promise<ScreenshotOutcome>;
}

export type PhysicalOutcome =
  | { readonly kind: 'recognized'; readonly observation: PhysicalTableObservation }
  | Failure
  | Cancelled;

export interface PhysicalRecognitionProvider {
  readonly id: string;
  readonly label: string;
  /** True for stored sample results rather than a model reading the photo. */
  readonly isSample: boolean;
  /** Read one photo of a physical table. Resolves to a failure instead of throwing. */
  recognizePhysicalTable(image: Blob, signal?: AbortSignal): Promise<PhysicalOutcome>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parsed<T>(read: () => T): { kind: 'ok'; value: T } | Failure {
  try {
    return { kind: 'ok', value: read() };
  } catch (error) {
    if (error instanceof RecognitionFormatError) return { kind: 'failed', reason: error.message + ' Try again.', retryable: true };
    throw error;
  }
}

/**
 * POST one image to the app server's recognition endpoint and return the JSON
 * body, or a readable failure. The API key stays on the server.
 */
async function postImage(endpoint: string, image: Blob, timeoutMs: number, signal?: AbortSignal): Promise<{ kind: 'ok'; body: unknown } | Failure | Cancelled> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', body: image, signal: timeout.signal, credentials: 'same-origin',
      headers: { 'Content-Type': image.type },
    });
  } catch {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (timeout.signal.aborted) return { kind: 'failed', reason: 'Recognition took too long. Try again.', retryable: true };
    return { kind: 'failed', reason: 'The recognition server could not be reached. Check the connection and try again.', retryable: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) return { kind: 'cancelled' };
  if (response.status === 404 || response.status === 405) {
    return { kind: 'failed', reason: 'Recognition needs the app server (npm start). Enter the table by hand or try a sample.', retryable: false };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Handled below.
  }
  if (!response.ok) {
    const reason = isRecord(body) && typeof body.error === 'string' ? body.error : 'Recognition failed (' + response.status + ').';
    // Missing keys, oversized or unsupported images will not fix themselves.
    return { kind: 'failed', reason, retryable: ![400, 413, 415, 503].includes(response.status) };
  }
  return { kind: 'ok', body };
}

/**
 * Claude vision through the app server (`/api/recognize?layout=screenshot`).
 * Times out after `timeoutMs`.
 */
export function claudeScreenshotProvider(endpoint = './api/recognize?layout=screenshot', timeoutMs = 100_000): ScreenshotProvider {
  return {
    id: 'claude',
    label: 'Claude vision',
    async recognize(image, signal) {
      const posted = await postImage(endpoint, image, timeoutMs, signal);
      if (posted.kind !== 'ok') return posted;
      const result = parsed(() => parseScreenshotResponse(posted.body, 'claude'));
      return result.kind === 'ok' ? { kind: 'recognized', recognition: result.value } : result;
    },
  };
}

/** A deterministic provider returning a fixed payload, for tests and samples. */
export function fixtureProvider(payload: unknown, id = 'fixture'): ScreenshotProvider {
  return {
    id,
    label: 'Sample data',
    async recognize(_image, signal) {
      if (signal?.aborted) return { kind: 'cancelled' };
      const result = parsed(() => parseScreenshotResponse(structuredClone(payload), id));
      return result.kind === 'ok' ? { kind: 'recognized', recognition: result.value } : result;
    },
  };
}

/** Placeholder for a future on-device model. */
export const localScreenshotProvider: ScreenshotProvider = {
  id: 'local',
  label: 'On-device model',
  async recognize() {
    return { kind: 'failed', reason: 'On-device screenshot recognition is not available yet.', retryable: false };
  },
};

// ---------------------------------------------------------------------------
// Physical table photos
// ---------------------------------------------------------------------------

let scanCounter = 0;
const scanId = () => 'scan-' + Date.now().toString(36) + '-' + ++scanCounter;

/** Claude vision for physical-table photos (`/api/recognize?layout=physical`). The reading is checked against the geometry before it is returned. */
export function claudePhysicalProvider(endpoint = './api/recognize?layout=physical', timeoutMs = 100_000): PhysicalRecognitionProvider {
  return {
    id: 'claude-physical',
    label: 'Claude vision',
    isSample: false,
    async recognizePhysicalTable(image, signal) {
      const posted = await postImage(endpoint, image, timeoutMs, signal);
      if (posted.kind !== 'ok') return posted;
      const result = parsed(() => interpretTable(parsePhysicalResponse(posted.body, 'claude-physical', scanId())));
      return result.kind === 'ok' ? { kind: 'recognized', observation: result.value } : result;
    },
  };
}

/** Stored sample readings for tests and the physical-table demo. Never calls an API. */
export function fixturePhysicalProvider(payload: unknown, id = 'sample-physical'): PhysicalRecognitionProvider {
  return {
    id,
    label: 'Sample data (not AI recognition)',
    isSample: true,
    async recognizePhysicalTable(_image, signal) {
      if (signal?.aborted) return { kind: 'cancelled' };
      const result = parsed(() => interpretTable(parsePhysicalResponse(structuredClone(payload), id, id)));
      return result.kind === 'ok' ? { kind: 'recognized', observation: result.value } : result;
    },
  };
}

/**
 * Use a physical provider wherever a screenshot provider is expected (for
 * example in Track hand): the photo is read, its geometry interpreted, and the
 * result converted into the shared table state with the given chip values.
 */
export function physicalAsScreenshotProvider(provider: PhysicalRecognitionProvider, chips: () => ChipConfiguration): ScreenshotProvider {
  return {
    id: provider.id,
    label: provider.label,
    async recognize(image, signal) {
      const outcome = await provider.recognizePhysicalTable(image, signal);
      if (outcome.kind !== 'recognized') return outcome;
      const config = chips();
      return { kind: 'recognized', recognition: physicalToRecognition(outcome.observation, chipConfigProblems(config).length ? { denominations: [] } : config) };
    },
  };
}
