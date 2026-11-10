// Saved reconstructions in this browser's localStorage. Every entry is
// re-validated on load; unreadable entries are reported and left out.
import { parseSession } from '../reconstruction/session.js';
import type { ReconstructionSession } from '../reconstruction/types.js';

const KEY = 'poker-study:reconstructions';

export function loadReconstructions(): { sessions: ReconstructionSession[]; problems: string[] } {
  let text: string | null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return { sessions: [], problems: ['This browser is blocking storage, so saved reconstructions are unavailable.'] };
  }
  if (!text) return { sessions: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { sessions: [], problems: ['Saved reconstructions could not be read.'] };
  }
  if (!Array.isArray(raw)) return { sessions: [], problems: ['Saved reconstructions are in an unexpected format.'] };
  const sessions: ReconstructionSession[] = [];
  const problems: string[] = [];
  raw.forEach((entry, i) => {
    try {
      sessions.push(parseSession(entry));
    } catch (error) {
      problems.push('Saved reconstruction ' + (i + 1) + ' was skipped: ' + (error instanceof Error ? error.message : 'invalid'));
    }
  });
  return { sessions, problems };
}

export function saveReconstructions(sessions: readonly ReconstructionSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch (error) {
    const full = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
    throw new Error(full
      ? 'Browser storage is full. Save without images, or delete older reconstructions.'
      : 'This browser is blocking storage, so the reconstruction could not be saved.');
  }
}
