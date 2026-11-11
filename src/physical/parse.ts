// Runtime validation of a physical-table reading from a provider. Rejects
// malformed or impossible output with RecognitionFormatError, and keeps every
// unknown as unknown. Positions are approximate fractions of the image size.
import { standardDeck } from '../core/cards.js';
import { RecognitionFormatError, type ConfidenceLabel, type RecognizedField, type Street } from '../vision/screenshot.js';
import type {
  CardVisibility, CardZone, ChipCountStatus, ChipGroup, ChipZone, NormBox, NormPoint, PhysicalCardDetection, PhysicalTableObservation, SeatArea,
} from './types.js';

export const MAX_PHYSICAL_SEATS = 10;
export const MAX_PHYSICAL_CARDS = 30;
export const MAX_CHIP_GROUPS = 40;
export const MAX_CHIP_COUNT = 10_000;
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (where: string): never => { throw new RecognitionFormatError('The table reading was malformed (' + where + ').'); };
const inUnit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= -0.02 && n <= 1.02;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

function confidenceOf(raw: unknown, where: string): ConfidenceLabel | null {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (raw === 'none' || raw === null || raw === undefined) return null;
  return bad(where + ' confidence');
}

function pointOf(raw: unknown, where: string): NormPoint | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !inUnit(raw.x) || !inUnit(raw.y)) return bad(where + ' position');
  return { x: clamp(raw.x as number), y: clamp(raw.y as number) };
}

function boxOf(raw: unknown, where: string): NormBox | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !inUnit(raw.x) || !inUnit(raw.y) || !inUnit(raw.width) || !inUnit(raw.height)) return bad(where + ' box');
  const box = { x: clamp(raw.x as number), y: clamp(raw.y as number), width: raw.width as number, height: raw.height as number };
  if (box.width <= 0 || box.height <= 0) return bad(where + ' box size');
  return box;
}

function fieldOf<T>(raw: unknown, where: string, check: (v: unknown) => v is T): RecognizedField<T> {
  if (raw === undefined || raw === null) return { value: null, confidence: null, source: 'observed' };
  if (!isRecord(raw)) return bad(where);
  const value = raw.value ?? null;
  if (value !== null && !check(value)) return bad(where);
  return { value: value as T | null, confidence: value === null ? null : confidenceOf(raw.confidence, where), source: 'observed' };
}

const unknownField = <T>(): RecognizedField<T> => ({ value: null, confidence: null, source: 'observed' });
const isChips = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000_000;

/**
 * Validate an untrusted payload `{ modelId, result }` from the `physical`
 * layout and build an observation with the reader's own grouping. Run
 * `interpretTable` afterwards to check that grouping against the geometry.
 */
export function parsePhysicalResponse(payload: unknown, providerId: string, id = 'scan'): PhysicalTableObservation {
  if (!isRecord(payload) || !isRecord(payload.result)) return bad('no result');
  const r = payload.result;
  if (!Array.isArray(r.seats) || !Array.isArray(r.cards) || !Array.isArray(r.chips)) return bad('seats, cards, or chips');
  if (r.seats.length > MAX_PHYSICAL_SEATS) throw new RecognitionFormatError('The photo shows more than ' + MAX_PHYSICAL_SEATS + ' seats, which this app does not support.');
  if (r.cards.length > MAX_PHYSICAL_CARDS) throw new RecognitionFormatError('The reading lists more than ' + MAX_PHYSICAL_CARDS + ' cards.');
  if (r.chips.length > MAX_CHIP_GROUPS) throw new RecognitionFormatError('The reading lists more than ' + MAX_CHIP_GROUPS + ' chip groups.');

  let hero: string | null = null;
  const seats: SeatArea[] = r.seats.map((s: unknown, i: number) => {
    const where = 'seat ' + (i + 1);
    if (!isRecord(s)) return bad(where);
    if (s.status !== 'active' && s.status !== 'folded' && s.status !== 'unknown') return bad(where + ' status');
    if (s.betArea !== undefined && s.betArea !== 'empty' && s.betArea !== 'has_chips' && s.betArea !== 'unclear') return bad(where + ' bet area');
    if (s.isUser === true) {
      if (hero) throw new RecognitionFormatError('The reading marks two seats as the user’s.');
      hero = 'seat-' + (i + 1);
    }
    return {
      id: 'seat-' + (i + 1),
      label: fieldOf(s.label, where + ' label', (v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 60),
      center: pointOf(s.position, where),
      status: s.status === 'unknown' ? unknownField() : { value: s.status, confidence: null, source: 'observed' },
      stackOverride: unknownField(),
      betOverride: unknownField(),
      betAreaEmpty: s.betArea === 'empty' ? true : s.betArea === 'has_chips' ? false : null,
    } satisfies SeatArea;
  });
  const seatRef = (raw: unknown, where: string): string | null => {
    if (raw === null || raw === undefined) return null;
    if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) >= seats.length) return bad(where + ' seat');
    return seats[raw as number].id;
  };

  const cards: PhysicalCardDetection[] = r.cards.map((c: unknown, i: number) => {
    const where = 'card ' + (i + 1);
    if (!isRecord(c) || typeof c.card !== 'string') return bad(where);
    const visibility = c.visibility as CardVisibility;
    if (!['face_up', 'face_down', 'partially_visible', 'unknown'].includes(visibility)) return bad(where + ' visibility');
    let rank: string | null = null;
    let suit: string | null = null;
    if (c.card === 'face_down') {
      if (visibility === 'face_up') return bad(where + ' face-down card marked face up');
    } else if (c.card === 'unknown') {
      // A partly read card may still carry its rank or suit.
      if (c.rank !== null && c.rank !== undefined) {
        if (typeof c.rank !== 'string' || !RANKS.includes(c.rank) || c.rank.length !== 1) return bad(where + ' rank');
        rank = c.rank;
      }
      if (c.suit !== null && c.suit !== undefined) {
        if (typeof c.suit !== 'string' || !SUITS.includes(c.suit) || c.suit.length !== 1) return bad(where + ' suit');
        suit = c.suit;
      }
      if (rank && suit) return bad(where + ': an unknown card cannot have both rank and suit');
    } else {
      if (!standardDeck.includes(c.card)) return bad(where + ' card code');
      rank = c.card[0];
      suit = c.card[1];
    }
    const rotation = c.rotation ?? null;
    if (rotation !== null && (typeof rotation !== 'number' || !Number.isFinite(rotation) || Math.abs(rotation) > 360)) return bad(where + ' rotation');
    let zone: CardZone;
    if (c.zone === 'board') zone = { kind: 'board' };
    else if (c.zone === 'seat') {
      const seatId = seatRef(c.seat, where);
      zone = seatId ? { kind: 'seat', seatId } : { kind: 'unassigned' };
    } else if (c.zone === 'unknown' || c.zone === undefined) zone = { kind: 'unassigned' };
    else return bad(where + ' zone');
    const box = boxOf(c.box, where);
    return {
      id: 'card-' + (i + 1),
      rank, suit,
      confidence: rank || suit ? confidenceOf(c.confidence, where) : null,
      source: 'observed',
      visibility: c.card === 'face_down' ? 'face_down' : visibility,
      orientationDegrees: rotation as number | null,
      box,
      center: box ? { x: clamp(box.x + box.width / 2), y: clamp(box.y + box.height / 2) } : null,
      readerZone: zone,
      zone,
      zoneSource: 'reader',
    } satisfies PhysicalCardDetection;
  });

  const chips: ChipGroup[] = r.chips.map((g: unknown, i: number) => {
    const where = 'chip group ' + (i + 1);
    if (!isRecord(g)) return bad(where);
    const count = g.count ?? null;
    if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_CHIP_COUNT)) return bad(where + ' count');
    const certainty = g.countCertainty;
    if (certainty !== 'counted' && certainty !== 'estimated' && certainty !== 'unknown') return bad(where + ' certainty');
    const status: ChipCountStatus = count === null ? 'unknown' : certainty === 'counted' ? 'confirmed' : certainty === 'estimated' ? 'estimated' : 'unknown';
    const color = g.color ?? null;
    if (color !== null && (typeof color !== 'string' || !color.trim() || color.length > 30)) return bad(where + ' colour');
    let zone: ChipZone;
    if (g.zone === 'pot') zone = { kind: 'pot' };
    else if (g.zone === 'stack' || g.zone === 'bet') {
      const seatId = seatRef(g.seat, where);
      zone = seatId ? { kind: g.zone, seatId } : { kind: 'unassigned' };
    } else if (g.zone === 'unknown' || g.zone === undefined) zone = { kind: 'unassigned' };
    else return bad(where + ' zone');
    const box = boxOf(g.box, where);
    const center = pointOf(g.position, where) ?? (box ? { x: clamp(box.x + box.width / 2), y: clamp(box.y + box.height / 2) } : null);
    return {
      id: 'chips-' + (i + 1),
      color: typeof color === 'string' ? color.trim() : null,
      count: status === 'unknown' ? null : count as number,
      countStatus: status,
      source: 'observed',
      center, box, zone, zoneSource: 'reader',
    } satisfies ChipGroup;
  });

  const dealer = isRecord(r.dealerButton) ? r.dealerButton : {};
  const dealerSeatId = seatRef(dealer.seat, 'dealer button');
  const street = fieldOf(r.street, 'street', (v): v is Street => STREETS.includes(v as Street));
  return {
    id,
    source: 'physical_photo',
    providerId,
    modelId: typeof payload.modelId === 'string' ? payload.modelId : null,
    tableCenter: pointOf(r.tableCenter, 'table centre'),
    tableCenterSource: 'reader',
    cards,
    seats,
    seatOrderSource: 'reader',
    heroSeatId: hero,
    heroSource: 'observed',
    dealerSeatId,
    dealerSource: 'observed',
    dealerButton: pointOf(dealer.position, 'dealer button'),
    chips,
    potText: fieldOf(r.pot, 'pot', isChips),
    potAreaEmpty: r.potArea === 'empty' ? true : r.potArea === 'has_chips' ? false : r.potArea === 'unclear' || r.potArea === undefined ? null : bad('pot area'),
    street,
    smallBlind: unknownField(),
    bigBlind: unknownField(),
    warnings: Array.isArray(r.issues) ? r.issues.filter((s): s is string => typeof s === 'string').slice(0, 10) : [],
    reviewStatus: 'unreviewed',
  };
}
