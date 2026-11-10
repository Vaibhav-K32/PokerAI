// Screenshot recognition providers. Each turns one image into a validated
// ScreenshotRecognition or a readable failure, so the rest of the pipeline
// never depends on which provider ran. Today: Claude through the app server,
// and deterministic fixtures for tests and offline demos. A local model can
// implement the same interface later.
import { parseScreenshotResponse, RecognitionFormatError, type ScreenshotRecognition } from './screenshot.js';

export type ScreenshotOutcome =
  | { readonly kind: 'recognized'; readonly recognition: ScreenshotRecognition }
  | { readonly kind: 'failed'; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: 'cancelled' };

export interface ScreenshotProvider {
  readonly id: string;
  readonly label: string;
  /** Recognize one image. Resolves to a failure instead of throwing. */
  recognize(image: Blob, signal?: AbortSignal): Promise<ScreenshotOutcome>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(payload: unknown, providerId: string): ScreenshotOutcome {
  try {
    return { kind: 'recognized', recognition: parseScreenshotResponse(payload, providerId) };
  } catch (error) {
    if (error instanceof RecognitionFormatError) return { kind: 'failed', reason: error.message + ' Try again.', retryable: true };
    throw error;
  }
}

/**
 * Claude vision through the app server (`/api/recognize?layout=screenshot`).
 * The API key stays on the server. Times out after `timeoutMs`.
 */
export function claudeScreenshotProvider(endpoint = './api/recognize?layout=screenshot', timeoutMs = 100_000): ScreenshotProvider {
  return {
    id: 'claude',
    label: 'Claude vision',
    async recognize(image, signal) {
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
        return { kind: 'failed', reason: 'Screenshot recognition needs the app server (npm start). Enter the table by hand or try a sample.', retryable: false };
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
      return parse(body, 'claude');
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
      return parse(structuredClone(payload), id);
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
