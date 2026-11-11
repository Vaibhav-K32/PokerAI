// Corrections to a physical observation. Each returns a new observation with
// the change marked as made by the user (source `corrected`, zone source
// `user`), and re-runs the geometry so dependent groupings stay current.
// User placements are never moved by the geometry afterwards.
import type { Card } from '../core/types.js';
import { corrected, type Street } from '../vision/screenshot.js';
import { interpretTable } from './geometry.js';
import type {
  CardVisibility, CardZone, ChipCountStatus, ChipGroup, ChipZone, NormPoint, PhysicalCardDetection, PhysicalTableObservation, SeatArea,
} from './types.js';

const done = (obs: PhysicalTableObservation): PhysicalTableObservation => interpretTable({ ...obs, reviewStatus: 'corrected' });
const mapCard = (obs: PhysicalTableObservation, id: string, change: (c: PhysicalCardDetection) => PhysicalCardDetection) =>
  done({ ...obs, cards: obs.cards.map(c => (c.id === id ? change(c) : c)) });
const mapSeat = (obs: PhysicalTableObservation, id: string, change: (s: SeatArea) => SeatArea) =>
  done({ ...obs, seats: obs.seats.map(s => (s.id === id ? change(s) : s)) });
const mapChips = (obs: PhysicalTableObservation, id: string, change: (g: ChipGroup) => ChipGroup) =>
  done({ ...obs, chips: obs.chips.map(g => (g.id === id ? change(g) : g)) });
const nextId = (prefix: string, ids: readonly string[]) => {
  let n = ids.length + 1;
  while (ids.includes(prefix + n)) n++;
  return prefix + n;
};

/** Set a card's value (rank and suit), or `null` to mark it unknown. */
export function setCardValue(obs: PhysicalTableObservation, id: string, card: Card | null): PhysicalTableObservation {
  return mapCard(obs, id, c => ({
    ...c, rank: card ? card[0] : null, suit: card ? card[1] : null, confidence: null, source: 'corrected',
    visibility: card ? (c.visibility === 'face_down' || c.visibility === 'unknown' ? 'face_up' : c.visibility) : c.visibility,
  }));
}

/** Correct only the rank or only the suit of a card. */
export function setCardPart(obs: PhysicalTableObservation, id: string, part: 'rank' | 'suit', value: string | null): PhysicalTableObservation {
  return mapCard(obs, id, c => ({ ...c, [part]: value, confidence: null, source: 'corrected' }));
}

export function setCardVisibility(obs: PhysicalTableObservation, id: string, visibility: CardVisibility): PhysicalTableObservation {
  return mapCard(obs, id, c => ({
    ...c, visibility, source: 'corrected',
    ...(visibility === 'face_down' ? { rank: null, suit: null, confidence: null } : {}),
  }));
}

export function assignCard(obs: PhysicalTableObservation, id: string, zone: CardZone): PhysicalTableObservation {
  return mapCard(obs, id, c => ({ ...c, zone, zoneSource: 'user', zoneNote: undefined }));
}

/** Remove a false detection. */
export function removeCard(obs: PhysicalTableObservation, id: string): PhysicalTableObservation {
  return done({ ...obs, cards: obs.cards.filter(c => c.id !== id) });
}

/** Add a card the reader missed. It has no position, so no overlay is drawn for it. */
export function addCard(obs: PhysicalTableObservation, zone: CardZone, card: Card | null, visibility: CardVisibility = card ? 'face_up' : 'face_down'): PhysicalTableObservation {
  const id = nextId('added-card-', obs.cards.map(c => c.id));
  const detection: PhysicalCardDetection = {
    id, rank: card ? card[0] : null, suit: card ? card[1] : null, confidence: null, source: 'corrected', visibility,
    orientationDegrees: null, box: null, center: null, readerZone: { kind: 'unassigned' }, zone, zoneSource: 'user',
  };
  return done({ ...obs, cards: [...obs.cards, detection] });
}

// Seats -----------------------------------------------------------------------

export const setSeatLabel = (obs: PhysicalTableObservation, id: string, label: string | null) => mapSeat(obs, id, s => ({ ...s, label: corrected(label?.trim() || null) }));
export const setSeatStatus = (obs: PhysicalTableObservation, id: string, status: 'active' | 'folded' | null) => mapSeat(obs, id, s => ({ ...s, status: corrected(status) }));
export const setSeatStack = (obs: PhysicalTableObservation, id: string, stack: number | null) => mapSeat(obs, id, s => ({ ...s, stackOverride: corrected(stack) }));
export const setSeatBet = (obs: PhysicalTableObservation, id: string, bet: number | null) => mapSeat(obs, id, s => ({ ...s, betOverride: corrected(bet) }));
/** Go back to the chip-derived stack or bet. */
export const clearSeatAmount = (obs: PhysicalTableObservation, id: string, which: 'stack' | 'bet') =>
  mapSeat(obs, id, s => ({ ...s, [which === 'stack' ? 'stackOverride' : 'betOverride']: { value: null, confidence: null, source: 'observed' } }));

export function setHero(obs: PhysicalTableObservation, id: string | null): PhysicalTableObservation {
  return done({ ...obs, heroSeatId: id, heroSource: 'corrected' });
}

export function setDealer(obs: PhysicalTableObservation, id: string | null): PhysicalTableObservation {
  return done({ ...obs, dealerSeatId: id, dealerSource: 'corrected' });
}

/** Move a seat in the clockwise order; the user's order then stays fixed. */
export function moveSeatArea(obs: PhysicalTableObservation, id: string, to: number): PhysicalTableObservation {
  const from = obs.seats.findIndex(s => s.id === id);
  if (from < 0 || to < 0 || to >= obs.seats.length || from === to) return obs;
  const seats = [...obs.seats];
  const [seat] = seats.splice(from, 1);
  seats.splice(to, 0, seat);
  return done({ ...obs, seats, seatOrderSource: 'user' });
}

export function addSeat(obs: PhysicalTableObservation, label: string | null = null): PhysicalTableObservation {
  const unknown = { value: null, confidence: null, source: 'corrected' } as const;
  const seat: SeatArea = {
    id: nextId('added-seat-', obs.seats.map(s => s.id)), label: corrected(label), center: null,
    status: unknown, stackOverride: { value: null, confidence: null, source: 'observed' }, betOverride: { value: null, confidence: null, source: 'observed' },
    betAreaEmpty: null,
  };
  return done({ ...obs, seats: [...obs.seats, seat], seatOrderSource: obs.seatOrderSource === 'user' ? 'user' : obs.seatOrderSource });
}

/** Remove a seat; its cards and chips become unassigned rather than disappearing. */
export function removeSeat(obs: PhysicalTableObservation, id: string): PhysicalTableObservation {
  const free = <T extends { zone: CardZone | ChipZone; zoneSource: string }>(x: T): T =>
    ('seatId' in x.zone && x.zone.seatId === id ? { ...x, zone: { kind: 'unassigned' }, zoneSource: 'user' } : x);
  return done({
    ...obs,
    seats: obs.seats.filter(s => s.id !== id),
    cards: obs.cards.map(free),
    chips: obs.chips.map(free),
    heroSeatId: obs.heroSeatId === id ? null : obs.heroSeatId,
    dealerSeatId: obs.dealerSeatId === id ? null : obs.dealerSeatId,
  });
}

/** Set where the table centre is (for example by clicking the photo); zones are recomputed for anything not placed by the user. */
export function setTableCenter(obs: PhysicalTableObservation, center: NormPoint | null): PhysicalTableObservation {
  return done({ ...obs, tableCenter: center, tableCenterSource: 'user' });
}

/** Mark a seat's position on the photo, so cards and chips near it can be grouped with it. */
export const setSeatPosition = (obs: PhysicalTableObservation, id: string, center: NormPoint | null) => mapSeat(obs, id, s => ({ ...s, center }));

// Chips -----------------------------------------------------------------------

export function setChipCount(obs: PhysicalTableObservation, id: string, count: number | null, status: ChipCountStatus = count === null ? 'unknown' : 'confirmed'): PhysicalTableObservation {
  return mapChips(obs, id, g => ({ ...g, count: status === 'unknown' ? null : count, countStatus: count === null ? 'unknown' : status, source: 'corrected' }));
}

export const setChipColor = (obs: PhysicalTableObservation, id: string, color: string | null) =>
  mapChips(obs, id, g => ({ ...g, color: color?.trim() || null, source: 'corrected' }));
export const assignChips = (obs: PhysicalTableObservation, id: string, zone: ChipZone) =>
  mapChips(obs, id, g => ({ ...g, zone, zoneSource: 'user' }));
export const removeChips = (obs: PhysicalTableObservation, id: string) => done({ ...obs, chips: obs.chips.filter(g => g.id !== id) });

export function addChips(obs: PhysicalTableObservation, zone: ChipZone, color: string | null = null, count: number | null = null): PhysicalTableObservation {
  const group: ChipGroup = {
    id: nextId('added-chips-', obs.chips.map(g => g.id)), color, count, countStatus: count === null ? 'unknown' : 'confirmed', source: 'corrected',
    center: null, box: null, zone, zoneSource: 'user',
  };
  return done({ ...obs, chips: [...obs.chips, group] });
}

// Table -----------------------------------------------------------------------

export const setStreet = (obs: PhysicalTableObservation, street: Street | null) => done({ ...obs, street: corrected(street) });
export const setPot = (obs: PhysicalTableObservation, pot: number | null) => done({ ...obs, potText: corrected(pot) });
export const clearPot = (obs: PhysicalTableObservation) => done({ ...obs, potText: { value: null, confidence: null, source: 'observed' } });
export const setBlinds = (obs: PhysicalTableObservation, small: number | null, big: number | null) => done({ ...obs, smallBlind: corrected(small), bigBlind: corrected(big) });
export const markReviewed = (obs: PhysicalTableObservation): PhysicalTableObservation => ({ ...obs, reviewStatus: obs.reviewStatus === 'corrected' ? 'corrected' : 'reviewed' });
