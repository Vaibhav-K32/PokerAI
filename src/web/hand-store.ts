// Saved hand histories in this browser's localStorage. Every stored hand is
// re-validated by replaying it on load; unreadable entries are reported and
// kept out of the list rather than silently dropped from storage.
import { parseHistory, type HandHistory } from '../history/history.js';

const KEY = 'poker-study:hand-histories';

export interface LoadResult {
  hands: HandHistory[];
  problems: string[];
}

export function loadHands(): LoadResult {
  let text: string | null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return { hands: [], problems: ['This browser is blocking storage, so saved hands are unavailable.'] };
  }
  if (!text) return { hands: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { hands: [], problems: ['Saved hands could not be read. Export or clear them from this browser’s site data.'] };
  }
  if (!Array.isArray(raw)) return { hands: [], problems: ['Saved hands are in an unexpected format.'] };
  const hands: HandHistory[] = [];
  const problems: string[] = [];
  raw.forEach((entry, i) => {
    try {
      hands.push(parseHistory(entry));
    } catch (error) {
      problems.push('Saved hand ' + (i + 1) + ' was skipped: ' + (error instanceof Error ? error.message : 'invalid'));
    }
  });
  return { hands, problems };
}

/** Save the full list. Throws a readable error when storage refuses it. */
export function saveHands(hands: readonly HandHistory[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hands));
  } catch (error) {
    const full = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
    throw new Error(full
      ? 'Browser storage is full. Delete or export some hands and try again.'
      : 'This browser is blocking storage, so the hand could not be saved.');
  }
}
