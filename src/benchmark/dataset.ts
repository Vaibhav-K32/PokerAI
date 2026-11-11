// Benchmark datasets: runtime validation of manifests and annotations, so a
// metric is never computed against impossible or malformed ground truth.
import { standardDeck } from '../core/cards.js';
import type { Street } from '../vision/screenshot.js';
import {
  DATASET_KIND, DATASET_SCHEMA_VERSION, DIFFICULTY_TAGS,
  type BenchmarkDataset, type BenchmarkSample, type BenchmarkSequence, type CardTag, type DifficultyTag, type GroundTruth, type GroundTruthPlayer,
  type ImageRef, type TruthBox, type TruthSlot,
} from './types.js';

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetError';
  }
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isChips = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000_000;
const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const BOARD_FOR: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const CARD_TAGS: readonly CardTag[] = ['rotated', 'occluded', 'blurred'];

function slotOf(raw: unknown, where: string): TruthSlot {
  if (!isRecord(raw) || !isRecord(raw.card)) throw new DatasetError(where + ' needs a card.');
  const c = raw.card;
  let card: TruthSlot['card'];
  if (c.kind === 'card') {
    if (typeof c.card !== 'string' || !standardDeck.includes(c.card)) throw new DatasetError(where + ' has an invalid card code.');
    card = { kind: 'card', card: c.card };
  } else if (c.kind === 'face_down' || c.kind === 'unreadable') {
    card = { kind: c.kind };
  } else throw new DatasetError(where + ' has an unknown card kind.');
  let box: TruthBox | undefined;
  if (raw.box !== undefined) {
    const b = raw.box;
    const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (!isRecord(b) || !unit(b.x) || !unit(b.y) || !unit(b.width) || !unit(b.height) || (b.width as number) <= 0 || (b.height as number) <= 0
      || (b.x as number) + (b.width as number) > 1.001 || (b.y as number) + (b.height as number) > 1.001) {
      throw new DatasetError(where + ' has a box outside the image.');
    }
    box = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
  }
  let tags: CardTag[] | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some(t => !CARD_TAGS.includes(t as CardTag))) throw new DatasetError(where + ' has unknown card tags.');
    tags = [...new Set(raw.tags as CardTag[])];
  }
  return { card, ...(box ? { box } : {}), ...(tags?.length ? { tags } : {}) };
}

const numberOrNull = (v: unknown, where: string): number | null => {
  if (v === null) return null;
  if (!isChips(v)) throw new DatasetError(where + ' must be a whole number of chips or null (not visible).');
  return v;
};

/** Problems with a ground truth, or an empty list. Used by the annotation tool before saving. */
export function groundTruthProblems(raw: unknown, allowMalformed = false): string[] {
  try {
    parseGroundTruth(raw, allowMalformed);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : 'The annotation is not valid.'];
  }
}

export function parseGroundTruth(raw: unknown, allowMalformed = false): GroundTruth {
  if (!isRecord(raw) || !Array.isArray(raw.players) || !Array.isArray(raw.board)) throw new DatasetError('Ground truth needs players and a board.');
  if (raw.players.length < 2 || raw.players.length > 10) throw new DatasetError('Ground truth needs 2 to 10 seats.');
  const players: GroundTruthPlayer[] = raw.players.map((p: unknown, i: number) => {
    const where = 'Seat ' + (i + 1);
    if (!isRecord(p) || !Array.isArray(p.cards)) throw new DatasetError(where + ' needs a card list.');
    if (p.cards.length !== 0 && p.cards.length !== 2) throw new DatasetError(where + ' shows ' + p.cards.length + ' cards; use zero or two.');
    if (p.name !== null && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60)) throw new DatasetError(where + ' has an invalid name.');
    if (p.folded !== null && typeof p.folded !== 'boolean') throw new DatasetError(where + ' folded must be true, false, or null.');
    return {
      name: p.name as string | null,
      cards: p.cards.map((c: unknown, j: number) => slotOf(c, where + ' card ' + (j + 1))),
      stack: numberOrNull(p.stack, where + ' stack'),
      bet: numberOrNull(p.bet, where + ' bet'),
      folded: p.folded as boolean | null,
    };
  });
  if (![0, 3, 4, 5].includes(raw.board.length)) throw new DatasetError('A board has 0, 3, 4, or 5 cards; this one has ' + raw.board.length + '.');
  const board = raw.board.map((c: unknown, i: number) => slotOf(c, 'Board card ' + (i + 1)));
  const seat = (v: unknown, what: string) => {
    if (v === null) return null;
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= players.length) throw new DatasetError(what + ' must be one of the seats or null.');
    return v as number;
  };
  const street = raw.street === null ? null : STREETS.includes(raw.street as Street) ? raw.street as Street : (() => { throw new DatasetError('Unknown street.'); })();
  if (street && BOARD_FOR[street] !== board.length) throw new DatasetError('The street is ' + street + ' but the board has ' + board.length + ' cards.');
  const smallBlind = numberOrNull(raw.smallBlind ?? null, 'Small blind');
  const bigBlind = numberOrNull(raw.bigBlind ?? null, 'Big blind');
  if (smallBlind !== null && bigBlind !== null && smallBlind > bigBlind) throw new DatasetError('The small blind is larger than the big blind.');
  if (bigBlind === 0 || smallBlind === 0) throw new DatasetError('Blinds must be positive or null.');
  const truth: GroundTruth = {
    players, board, pot: numberOrNull(raw.pot ?? null, 'Pot'),
    dealerSeat: seat(raw.dealerSeat ?? null, 'The dealer'), heroSeat: seat(raw.heroSeat ?? null, 'Your seat'),
    street, smallBlind, bigBlind,
  };
  if (!allowMalformed) {
    const seen = new Set<string>();
    for (const slot of [...board, ...players.flatMap(p => p.cards)]) {
      if (slot.card.kind !== 'card') continue;
      if (seen.has(slot.card.card)) throw new DatasetError(slot.card.card + ' appears twice. A deck has one of each card.');
      seen.add(slot.card.card);
    }
  }
  return truth;
}

function imageOf(raw: unknown, where: string): ImageRef {
  if (!isRecord(raw)) throw new DatasetError(where + ' needs an image reference.');
  if (raw.kind === 'synthetic' && typeof raw.fixture === 'string' && raw.fixture) return { kind: 'synthetic', fixture: raw.fixture };
  if (raw.kind === 'file' && typeof raw.path === 'string' && raw.path) {
    const path = raw.path.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]+:/i.test(path) || path.split('/').includes('..')) throw new DatasetError(where + ' image path must be relative to the dataset.');
    if (!/\.(png|jpe?g|webp)$/i.test(path)) throw new DatasetError(where + ' image must be PNG, JPEG, or WebP.');
    return { kind: 'file', path };
  }
  throw new DatasetError(where + ' has an invalid image reference.');
}

export function parseSample(raw: unknown): BenchmarkSample {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !/^[\w.-]{1,80}$/.test(raw.id)) throw new DatasetError('Each sample needs an ID of letters, digits, dots, dashes, or underscores.');
  const where = 'Sample ' + raw.id;
  if (raw.sourceType !== 'digital_screenshot' && raw.sourceType !== 'physical_photo') throw new DatasetError(where + ' has an unknown source type.');
  if (raw.annotationStatus !== 'draft' && raw.annotationStatus !== 'verified') throw new DatasetError(where + ' must be draft or verified.');
  if (!Array.isArray(raw.tags) || raw.tags.some(t => !(DIFFICULTY_TAGS as readonly string[]).includes(t as string))) throw new DatasetError(where + ' has unknown difficulty tags.');
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const metadata: Record<string, string> = {};
  for (const key of ['lighting', 'orientation', 'occlusion', 'imageQuality']) if (typeof meta[key] === 'string') metadata[key] = (meta[key] as string).slice(0, 100);
  let groundTruth: GroundTruth;
  try {
    groundTruth = parseGroundTruth(raw.groundTruth, raw.allowMalformed === true);
  } catch (error) {
    throw new DatasetError(where + ': ' + (error instanceof Error ? error.message : 'invalid ground truth'));
  }
  let chipConfig: BenchmarkSample['chipConfig'];
  if (raw.chipConfig !== undefined) {
    const c = raw.chipConfig;
    if (!isRecord(c) || !Array.isArray(c.denominations) || c.denominations.some(d => !isRecord(d) || typeof d.colorLabel !== 'string' || !Number.isSafeInteger(d.value) || (d.value as number) <= 0)) {
      throw new DatasetError(where + ' has an invalid chip configuration.');
    }
    chipConfig = { denominations: (c.denominations as Raw[]).map(d => ({ colorLabel: d.colorLabel as string, value: d.value as number })) };
  }
  return {
    id: raw.id, sourceType: raw.sourceType, image: imageOf(raw.image, where), groundTruth,
    tags: [...new Set(raw.tags as DifficultyTag[])], metadata, annotationStatus: raw.annotationStatus,
    ...(chipConfig ? { chipConfig } : {}),
    ...(typeof raw.notes === 'string' ? { notes: raw.notes.slice(0, 1000) } : {}),
    ...(raw.allowMalformed === true ? { allowMalformed: true } : {}),
  };
}

/** Parse and validate a dataset manifest (JSON text or value). Samples keep the manifest's order. */
export function parseDataset(input: unknown): BenchmarkDataset {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new DatasetError('This file is not valid JSON.');
    }
  }
  if (!isRecord(raw) || raw.kind !== DATASET_KIND) throw new DatasetError('This is not a Poker Study benchmark dataset.');
  if (raw.schemaVersion !== DATASET_SCHEMA_VERSION) throw new DatasetError('Unsupported dataset schema version.');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new DatasetError('The dataset needs a name.');
  if (typeof raw.datasetVersion !== 'string' || !raw.datasetVersion.trim()) throw new DatasetError('The dataset needs a version.');
  if (!Array.isArray(raw.samples)) throw new DatasetError('The dataset needs a sample list.');
  const samples = raw.samples.map(parseSample);
  const ids = new Set<string>();
  for (const s of samples) {
    if (ids.has(s.id)) throw new DatasetError('Sample ID ' + s.id + ' is used twice.');
    ids.add(s.id);
  }
  const sequences: BenchmarkSequence[] = (Array.isArray(raw.sequences) ? raw.sequences : []).map((q: unknown) => {
    if (!isRecord(q) || typeof q.id !== 'string' || !q.id || !Array.isArray(q.sampleIds) || q.sampleIds.length < 2) throw new DatasetError('Each sequence needs an ID and at least two samples.');
    for (const id of q.sampleIds) if (typeof id !== 'string' || !ids.has(id)) throw new DatasetError('Sequence ' + q.id + ' refers to a missing sample.');
    if (new Set(q.sampleIds).size !== q.sampleIds.length) throw new DatasetError('Sequence ' + q.id + ' repeats a sample.');
    if (q.sameHand !== undefined && (!Array.isArray(q.sameHand) || q.sameHand.length !== q.sampleIds.length - 1 || q.sameHand.some(v => typeof v !== 'boolean'))) {
      throw new DatasetError('Sequence ' + q.id + ' needs one same-hand flag per neighbouring pair.');
    }
    return {
      id: q.id, sampleIds: q.sampleIds as string[],
      ...(Array.isArray(q.sameHand) ? { sameHand: q.sameHand as boolean[] } : {}),
      ...(typeof q.notes === 'string' ? { notes: q.notes } : {}),
    };
  });
  return {
    kind: DATASET_KIND, schemaVersion: DATASET_SCHEMA_VERSION, name: raw.name.trim(), datasetVersion: raw.datasetVersion.trim(),
    samples, sequences, ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
  };
}

export const serializeDataset = (dataset: BenchmarkDataset) => JSON.stringify(dataset, null, 2);
