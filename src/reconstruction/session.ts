// Reconstruction sessions: screenshot ordering, resolutions, and the JSON
// format with runtime validation. Pure; browser storage lives in src/web/.
import { ReconstructionError, restoreObservation } from './observation.js';
import { reconstructHand } from './reconstruct.js';
import {
  MAX_SCREENSHOTS, RECONSTRUCTION_KIND, RECONSTRUCTION_SCHEMA_VERSION,
  type HandObservation, type IntervalResolution, type ManualAction, type ManualActionType, type ReconstructionSession, type ScreenshotEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Append screenshots in the order given, up to `max`. IDs come from `makeId`,
 * never from file names. Returns the new list and how many did not fit.
 */
export function addScreenshots(list: readonly ScreenshotEntry[], labels: readonly string[], makeId: () => string, max = MAX_SCREENSHOTS) {
  const room = Math.max(0, Math.min(max, MAX_SCREENSHOTS) - list.length);
  const nextUpload = list.reduce((m, s) => Math.max(m, s.uploadIndex + 1), 0);
  const added = labels.slice(0, room).map((label, i) => ({ id: makeId(), label, uploadIndex: nextUpload + i }));
  return { list: [...list, ...added], added, skipped: labels.length - added.length };
}

/** Move one screenshot to a new position. Out-of-range moves are clamped. */
export function moveScreenshot(list: readonly ScreenshotEntry[], id: string, to: number): ScreenshotEntry[] {
  const from = list.findIndex(s => s.id === id);
  if (from < 0) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

export const removeScreenshot = (list: readonly ScreenshotEntry[], id: string) => list.filter(s => s.id !== id);

/** Restore the order the files were added in. */
export const uploadOrder = (list: readonly ScreenshotEntry[]) => [...list].sort((a, b) => a.uploadIndex - b.uploadIndex);

/**
 * Observations for the screenshots that have one, with sequence positions
 * following the screenshot order. Unchanged observations keep their identity.
 */
export function sequenceObservations(list: readonly ScreenshotEntry[], observations: ReadonlyMap<string, HandObservation>): HandObservation[] {
  const out: HandObservation[] = [];
  list.forEach((s, index) => {
    const o = observations.get(s.id);
    if (o) out.push(o.sequenceIndex === index ? o : { ...o, sequenceIndex: index });
  });
  return out;
}

/** Resolutions whose two observations are still next to each other. */
export function liveResolutions(observations: readonly HandObservation[], resolutions: readonly IntervalResolution[]): IntervalResolution[] {
  const pairs = new Set<string>();
  const list = [...observations].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (let i = 1; i < list.length; i++) pairs.add(list[i - 1].id + '>' + list[i].id);
  return resolutions.filter(r => pairs.has(r.from + '>' + r.to));
}

/**
 * After the seats of one observation were reordered (`map[old] = new`),
 * point confirmed actions that start from it at the same players again.
 * Actions refer to seats of the interval's earlier observation.
 */
export function remapActionSeats(resolutions: readonly IntervalResolution[], observationId: string, map: readonly number[]): IntervalResolution[] {
  return resolutions.map(r => (r.from !== observationId || !r.actions.length ? r : {
    ...r, actions: r.actions.map(a => (map[a.seat] === undefined ? a : { ...a, seat: map[a.seat] })),
  }));
}

/** Replace (or add) the resolution for one interval. */
export function setResolution(resolutions: readonly IntervalResolution[], next: IntervalResolution): IntervalResolution[] {
  const others = resolutions.filter(r => !(r.from === next.from && r.to === next.to));
  return next.mark === 'none' && !next.actions.length && !next.note ? others : [...others, next];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(input: {
  id: string; title: string; createdAt: string; updatedAt?: string;
  screenshots: readonly ScreenshotEntry[]; observations: readonly HandObservation[]; resolutions: readonly IntervalResolution[];
  imagesSaved?: boolean;
}): ReconstructionSession {
  const ids = new Set(input.screenshots.map(s => s.id));
  const observations = input.observations.filter(o => ids.has(o.screenshotId));
  const resolutions = liveResolutions(observations, input.resolutions);
  const imagesSaved = input.imagesSaved === true && input.screenshots.some(s => s.image);
  return {
    kind: RECONSTRUCTION_KIND,
    schemaVersion: RECONSTRUCTION_SCHEMA_VERSION,
    id: input.id,
    title: input.title.trim() || 'Reconstruction',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    screenshots: input.screenshots.map(s => (imagesSaved || !s.image ? { ...s } : { id: s.id, label: s.label, uploadIndex: s.uploadIndex })),
    observations,
    resolutions,
    warnings: [...reconstructHand(observations, { resolutions, screenshotCount: input.screenshots.length }).warnings],
    imagesSaved,
  };
}

export const serializeSession = (session: ReconstructionSession) => JSON.stringify(session, null, 2);

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const ACTION_TYPES: readonly ManualActionType[] = ['fold', 'check', 'call', 'bet', 'raise', 'all-in'];

function parseAction(raw: unknown): ManualAction {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) throw new ReconstructionError('A confirmed action needs an ID.');
  if (!Number.isSafeInteger(raw.seat) || (raw.seat as number) < 0) throw new ReconstructionError('A confirmed action needs a seat.');
  if (!ACTION_TYPES.includes(raw.type as ManualActionType)) throw new ReconstructionError('A confirmed action has an unknown type.');
  if (raw.to !== undefined && (!Number.isSafeInteger(raw.to) || (raw.to as number) < 0)) throw new ReconstructionError('A bet or raise total must be whole chips.');
  if (!isTime(raw.confirmedAt)) throw new ReconstructionError('A confirmed action needs the time it was entered.');
  return { id: raw.id, seat: raw.seat as number, type: raw.type as ManualActionType, ...(raw.to !== undefined ? { to: raw.to as number } : {}), confirmedAt: raw.confirmedAt };
}

function parseResolution(raw: unknown): IntervalResolution {
  if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') throw new ReconstructionError('An interval resolution needs its two observations.');
  if (!['none', 'unresolved', 'different-hands'].includes(raw.mark as string)) throw new ReconstructionError('An interval resolution has an unknown mark.');
  if (!Array.isArray(raw.actions)) throw new ReconstructionError('An interval resolution needs an action list.');
  if (raw.note !== undefined && typeof raw.note !== 'string') throw new ReconstructionError('A resolution note must be text.');
  return {
    from: raw.from, to: raw.to, mark: raw.mark as IntervalResolution['mark'], actions: raw.actions.map(parseAction),
    ...(typeof raw.note === 'string' ? { note: raw.note.slice(0, 500) } : {}),
  };
}

function parseScreenshot(raw: unknown): ScreenshotEntry {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.label !== 'string') throw new ReconstructionError('A screenshot entry needs an ID and a label.');
  if (!Number.isSafeInteger(raw.uploadIndex) || (raw.uploadIndex as number) < 0) throw new ReconstructionError('A screenshot entry needs its upload position.');
  if (raw.image !== undefined && (typeof raw.image !== 'string' || !raw.image.startsWith('data:image/jpeg;base64,'))) {
    throw new ReconstructionError('A saved screenshot image must be a JPEG data URL.');
  }
  return { id: raw.id, label: raw.label.slice(0, 200), uploadIndex: raw.uploadIndex as number, ...(typeof raw.image === 'string' ? { image: raw.image } : {}) };
}

/**
 * Parse and validate a session from JSON text or a parsed value. Checks every
 * observation and resolution, that IDs are unique and consistent, and that
 * sequence positions follow the screenshot order. Warnings are recomputed.
 */
export function parseSession(input: unknown): ReconstructionSession {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ReconstructionError('This file is not valid JSON.');
    }
  }
  if (!isRecord(raw) || raw.kind !== RECONSTRUCTION_KIND) throw new ReconstructionError('This is not a Poker Study reconstruction.');
  if (raw.schemaVersion !== RECONSTRUCTION_SCHEMA_VERSION) {
    throw new ReconstructionError(Number(raw.schemaVersion) > RECONSTRUCTION_SCHEMA_VERSION
      ? 'This reconstruction uses a newer format. Update the app to open it.'
      : 'This reconstruction has no supported schema version.');
  }
  if (typeof raw.id !== 'string' || !raw.id) throw new ReconstructionError('The reconstruction needs an ID.');
  if (typeof raw.title !== 'string') throw new ReconstructionError('The reconstruction needs a title.');
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) throw new ReconstructionError('The reconstruction needs creation and update times.');
  if (!Array.isArray(raw.screenshots) || !Array.isArray(raw.observations) || !Array.isArray(raw.resolutions)) {
    throw new ReconstructionError('The reconstruction needs screenshot, observation, and resolution lists.');
  }
  if (raw.screenshots.length > MAX_SCREENSHOTS) throw new ReconstructionError('A reconstruction holds at most ' + MAX_SCREENSHOTS + ' screenshots.');
  const screenshots = raw.screenshots.map(parseScreenshot);
  const shotIds = new Set(screenshots.map(s => s.id));
  if (shotIds.size !== screenshots.length) throw new ReconstructionError('Screenshot IDs must be unique.');
  const observations = raw.observations.map(restoreObservation);
  if (new Set(observations.map(o => o.id)).size !== observations.length) throw new ReconstructionError('Observation IDs must be unique.');
  if (new Set(observations.map(o => o.screenshotId)).size !== observations.length) throw new ReconstructionError('Each screenshot has at most one observation.');
  for (const o of observations) {
    if (!shotIds.has(o.screenshotId)) throw new ReconstructionError('Observation ' + o.id + ' refers to a missing screenshot.');
    if (screenshots.findIndex(s => s.id === o.screenshotId) !== o.sequenceIndex) throw new ReconstructionError('Observation ' + o.id + ' is out of order with its screenshot.');
  }
  const resolutions = raw.resolutions.map(parseResolution);
  const obsIds = new Set(observations.map(o => o.id));
  for (const r of resolutions) {
    if (!obsIds.has(r.from) || !obsIds.has(r.to)) throw new ReconstructionError('A resolution refers to a missing observation.');
  }
  return createSession({
    id: raw.id, title: raw.title, createdAt: raw.createdAt as string, updatedAt: raw.updatedAt as string,
    screenshots, observations, resolutions, imagesSaved: raw.imagesSaved === true,
  });
}
