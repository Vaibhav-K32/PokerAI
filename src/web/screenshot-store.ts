// Screenshots the user chose to save, in this browser's localStorage. The
// image itself is stored only when the user ticks "Also save the image".
import { restoreRecognition, type ScreenshotRecognition } from '../vision/screenshot.js';

const KEY = 'poker-study:screenshots';

export interface SavedScreenshot {
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly recognition: ScreenshotRecognition;
  /** A downscaled JPEG data URL, only when the user chose to keep the image. */
  readonly image?: string;
  /** The saved hand and replay position this screenshot is attached to. */
  readonly attachedTo?: { readonly handId: string; readonly position: number };
}

export function loadScreenshots(): { saved: SavedScreenshot[]; problems: string[] } {
  let text: string | null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return { saved: [], problems: ['This browser is blocking storage, so saved screenshots are unavailable.'] };
  }
  if (!text) return { saved: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { saved: [], problems: ['Saved screenshots could not be read.'] };
  }
  if (!Array.isArray(raw)) return { saved: [], problems: ['Saved screenshots are in an unexpected format.'] };
  const saved: SavedScreenshot[] = [];
  const problems: string[] = [];
  raw.forEach((entry, i) => {
    try {
      if (typeof entry?.id !== 'string' || typeof entry.name !== 'string' || typeof entry.savedAt !== 'string') throw new Error('missing details');
      if (entry.image !== undefined && (typeof entry.image !== 'string' || !entry.image.startsWith('data:image/jpeg;base64,'))) throw new Error('bad image');
      saved.push({
        id: entry.id, name: entry.name, savedAt: entry.savedAt,
        recognition: restoreRecognition(entry.recognition),
        ...(entry.image ? { image: entry.image } : {}),
        ...(entry.attachedTo && typeof entry.attachedTo.handId === 'string' && Number.isSafeInteger(entry.attachedTo.position)
          ? { attachedTo: { handId: entry.attachedTo.handId, position: entry.attachedTo.position } } : {}),
      });
    } catch (error) {
      problems.push('Saved screenshot ' + (i + 1) + ' was skipped: ' + (error instanceof Error ? error.message : 'invalid'));
    }
  });
  return { saved, problems };
}

export function saveScreenshots(list: readonly SavedScreenshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (error) {
    const full = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
    throw new Error(full
      ? 'Browser storage is full. Save without the image, or delete older screenshots.'
      : 'This browser is blocking storage, so the screenshot could not be saved.');
  }
}
