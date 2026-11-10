// Frame extraction from a local video with the browser's own decoder: a
// <video> element seeks to each chosen time and a canvas copies the picture.
// Nothing is uploaded here; frames the user picks join the screenshot list.
import { durationProblem } from '../vision/video.js';

export interface OpenVideo {
  readonly video: HTMLVideoElement;
  readonly url: string;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  close(): void;
}

function waitFor(target: HTMLMediaElement, event: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener('error', fail);
      signal?.removeEventListener('abort', stop);
      fn();
    };
    const ok = done(resolve);
    const fail = done(() => reject(new Error('This video could not be decoded in this browser. Try MP4 (H.264) or WebM.')));
    const stop = done(() => reject(new DOMException('Cancelled', 'AbortError')));
    const timer = setTimeout(done(() => reject(new Error('The video took too long to respond.'))), ms);
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Load a video's metadata. Throws a readable error for unsupported or unreadable files. */
export async function openVideo(file: File): Promise<OpenVideo> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  const close = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    const loaded = waitFor(video, 'loadeddata', 20_000);
    video.src = url;
    await loaded;
  } catch (error) {
    close();
    throw error;
  }
  let durationMs = video.duration * 1000;
  if (!Number.isFinite(durationMs)) {
    // Some recorders write no duration; seeking far ahead makes the browser compute it.
    try {
      const seeked = waitFor(video, 'durationchange', 10_000);
      video.currentTime = 1e7;
      await seeked;
      durationMs = video.duration * 1000;
    } catch {
      // Reported below.
    }
  }
  const problem = durationProblem(durationMs);
  if (problem || !video.videoWidth || !video.videoHeight) {
    close();
    throw new Error(problem ?? 'This video has no picture.');
  }
  return { video, url, durationMs: Math.round(durationMs), width: video.videoWidth, height: video.videoHeight, close };
}

/** Seek and copy one frame as a JPEG, scaled so the long edge is at most `longEdge`. */
export async function captureFrame(open: OpenVideo, timeMs: number, longEdge: number, signal?: AbortSignal): Promise<Blob> {
  const { video } = open;
  const target = Math.min(timeMs, Math.max(0, open.durationMs - 1)) / 1000;
  if (Math.abs(video.currentTime - target) > 0.001) {
    const seeked = waitFor(video, 'seeked', 15_000, signal);
    video.currentTime = target;
    await seeked;
  }
  const scale = Math.min(1, longEdge / Math.max(open.width, open.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(open.width * scale));
  canvas.height = Math.max(1, Math.round(open.height * scale));
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The frame could not be copied.'))), 'image/jpeg', 0.88));
}
