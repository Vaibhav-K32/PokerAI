// Photo quality feedback from measurements, not impressions. Pixel checks run
// on a downscaled copy (brightness, glare, sharpness); framing checks use the
// reader's approximate card boxes. A check reports only what its measurement
// shows, with the number, and the user can always continue.
import type { PhysicalTableObservation } from './types.js';

export interface PixelData {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
}

export type QualityId = 'dark' | 'glare' | 'resolution' | 'blur' | 'edge' | 'small' | 'empty';

export interface QualityCheck {
  readonly id: QualityId;
  readonly message: string;
  /** The measurement behind the message. */
  readonly evidence: string;
}

export interface PixelMetrics {
  /** Mean luminance, 0–1. */
  readonly brightness: number;
  /** Share of near-white pixels, 0–1. */
  readonly glare: number;
  /** Variance of the Laplacian of luminance (0–255 scale); higher is sharper. `null` when the image is too flat to judge. */
  readonly sharpness: number | null;
  /** Standard deviation of luminance, 0–1. */
  readonly contrast: number;
}

export const QUALITY_LIMITS = {
  /** Shortest side below which card corners are likely too small to read. */
  minSide: 900,
  dark: 0.2,
  glare: 0.06,
  glareLevel: 0.97,
  /** Laplacian variance below which the photo is soft. */
  blur: 30,
  /** Below this contrast the sharpness measure is not meaningful. */
  minContrast: 0.06,
  /** Cards within this fraction of the edge may be cut off. */
  edge: 0.012,
  /** When cards, chips, and seats spread over less than this fraction of the photo in both directions, the table is far away. */
  smallSpread: 0.35,
} as const;

export function pixelMetrics(px: PixelData): PixelMetrics {
  const { width, height, data } = px;
  const n = width * height;
  if (!n || data.length < n * 4) return { brightness: 0, glare: 0, sharpness: null, contrast: 0 };
  const lum = new Float32Array(n);
  let sum = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    const l = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
    lum[i] = l;
    sum += l;
    if (l >= QUALITY_LIMITS.glareLevel) bright++;
  }
  const brightness = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (lum[i] - brightness) ** 2;
  const contrast = Math.sqrt(varSum / n);
  let sharpness: number | null = null;
  if (width >= 3 && height >= 3 && contrast >= QUALITY_LIMITS.minContrast) {
    let lsum = 0;
    let lsq = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const v = 255 * (4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - width] - lum[i + width]);
        lsum += v;
        lsq += v * v;
        count++;
      }
    }
    const m = lsum / count;
    sharpness = lsq / count - m * m;
  }
  return { brightness, glare: bright / n, sharpness, contrast };
}

const pct = (v: number) => Math.round(v * 100) + '%';

/** Checks from the pixels and the original size. `px` is a downscaled copy (about 640 px on the long edge). */
export function photoChecks(px: PixelData, original: { width: number; height: number }): { checks: QualityCheck[]; metrics: PixelMetrics } {
  const metrics = pixelMetrics(px);
  const checks: QualityCheck[] = [];
  if (metrics.brightness < QUALITY_LIMITS.dark) {
    checks.push({ id: 'dark', message: 'The photo is dark, so card corners may be hard to read. Add light or retake it.', evidence: 'Average brightness ' + pct(metrics.brightness) + ' (below ' + pct(QUALITY_LIMITS.dark) + ').' });
  }
  if (metrics.glare > QUALITY_LIMITS.glare) {
    checks.push({ id: 'glare', message: 'Bright glare covers part of the photo and may hide cards. Tilt the camera or move the light.', evidence: 'About ' + pct(metrics.glare) + ' of the photo is near white.' });
  }
  const side = Math.min(original.width, original.height);
  if (side < QUALITY_LIMITS.minSide) {
    checks.push({ id: 'resolution', message: 'The photo is small, so card corners may have too few pixels to read.', evidence: original.width + '×' + original.height + ' (shortest side under ' + QUALITY_LIMITS.minSide + ' px).' });
  }
  if (metrics.sharpness !== null && metrics.sharpness < QUALITY_LIMITS.blur) {
    checks.push({ id: 'blur', message: 'The photo looks soft or blurred. Hold the camera still and let it focus.', evidence: 'Sharpness score ' + Math.round(metrics.sharpness) + ' (below ' + QUALITY_LIMITS.blur + ').' });
  }
  return { checks, metrics };
}

/** Framing checks from the reader's approximate card boxes. Only boxes it reported are used. */
export function framingChecks(obs: PhysicalTableObservation): QualityCheck[] {
  const checks: QualityCheck[] = [];
  if (!obs.cards.length) {
    return [{ id: 'empty', message: 'No cards were found in the photo. Check that the table is in view.', evidence: 'The reading lists no cards.' }];
  }
  const e = QUALITY_LIMITS.edge;
  const atEdge = obs.cards.filter(c => c.box && (c.box.x <= e || c.box.y <= e || c.box.x + c.box.width >= 1 - e || c.box.y + c.box.height >= 1 - e));
  if (atEdge.length) {
    checks.push({ id: 'edge', message: atEdge.length + ' card' + (atEdge.length === 1 ? ' touches' : 's touch') + ' the edge of the photo and may be cut off. Step back or reframe.', evidence: 'Card boxes reach the image border.' });
  }
  // How far the table's contents spread across the photo: card boxes, chips, and seats.
  const points = [
    ...obs.cards.flatMap(c => (c.box ? [{ x: c.box.x, y: c.box.y }, { x: c.box.x + c.box.width, y: c.box.y + c.box.height }] : [])),
    ...obs.chips.flatMap(g => (g.center ? [g.center] : [])),
    ...obs.seats.flatMap(s => (s.center ? [s.center] : [])),
  ];
  if (points.length >= 6) {
    const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
    const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
    if (width < QUALITY_LIMITS.smallSpread && height < QUALITY_LIMITS.smallSpread) {
      checks.push({ id: 'small', message: 'The table fills only a small part of the photo. Move closer for sharper card corners.', evidence: 'Cards, chips, and seats span about ' + pct(width) + ' by ' + pct(height) + ' of the photo.' });
    }
  }
  return checks;
}
