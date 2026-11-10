// Choosing frames from a recorded video of a simulated or finished hand.
// Pure helpers (no browser APIs); src/web/video-frames.ts does the decoding.
// Only frames the user selects are ever sent for recognition.

export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'] as const;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEO_MS = 30 * 60 * 1000;
/** Most thumbnails sampled from one video; the interval widens to stay under it. */
export const MAX_SAMPLED_FRAMES = 120;
export const INTERVAL_CHOICES_MS = [500, 1000, 2000, 5000, 10000] as const;
export const DEFAULT_INTERVAL_MS = 2000;

/** A readable reason the file cannot be used, or null. Browsers decide codecs; this checks the container type and size. */
export function videoProblem(file: { readonly type: string; readonly size: number }): string | null {
  if (!(VIDEO_TYPES as readonly string[]).includes(file.type)) return 'Use an MP4, WebM, Ogg, or QuickTime video.';
  if (file.size === 0) return 'The video is empty.';
  if (file.size > MAX_VIDEO_BYTES) return 'The video is larger than 500 MB. Trim it to the hand first.';
  return null;
}

/** A reason the decoded video cannot be sampled, or null. */
export function durationProblem(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'This video has no readable length. Try another file or format.';
  if (durationMs > MAX_VIDEO_MS) return 'The video is longer than 30 minutes. Trim it to the hand first.';
  return null;
}

/**
 * Times to sample, in whole milliseconds from the start: every `intervalMs`,
 * widened when needed so there are at most `max`. `capped` says whether the
 * interval was widened, and `intervalMs` is the one used.
 */
export function sampleTimes(durationMs: number, intervalMs: number, max = MAX_SAMPLED_FRAMES): { times: number[]; intervalMs: number; capped: boolean } {
  if (durationProblem(durationMs) || !Number.isFinite(intervalMs) || intervalMs <= 0 || max < 1) return { times: [], intervalMs, capped: false };
  const needed = Math.ceil(durationMs / intervalMs);
  const step = needed > max ? Math.ceil(durationMs / max) : Math.round(intervalMs);
  const times: number[] = [];
  for (let t = 0; t < durationMs && times.length < max; t += step) times.push(Math.round(t));
  return { times, intervalMs: step, capped: needed > max };
}

/** `1:05.2` style label for a video position. */
export function formatVideoTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100)) / 10;
  const minutes = Math.floor(total / 60);
  const seconds = (total - minutes * 60).toFixed(1).padStart(4, '0');
  return minutes + ':' + seconds;
}
