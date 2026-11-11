// Table geometry: where the table centre is, which seat each card and chip
// group belongs to, which cards form the board, and the clockwise seat order.
// Pure and deterministic. Positions are approximate, so a card that is about
// equally close to two places stays unassigned rather than being guessed, and
// the user's own placements are never overridden.
import type { CardZone, ChipGroup, ChipZone, NormPoint, PhysicalCardDetection, PhysicalTableObservation, SeatArea } from './types.js';

/** A seat must be this much closer than the next one to own a card. */
export const SEAT_MARGIN = 1.25;
/** A card closer to the centre than this fraction of the nearest seat's distance is on the board. */
export const BOARD_RATIO = 0.6;

const dist = (a: NormPoint, b: NormPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (points: readonly NormPoint[]): NormPoint | null =>
  points.length ? { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length } : null;
const sameZone = (a: CardZone, b: CardZone) => a.kind === b.kind && (a.kind !== 'seat' || (b.kind === 'seat' && a.seatId === b.seatId));

/** The table centre: the user's or reader's, else the middle of the seats, else of the cards. */
export function tableCenter(obs: PhysicalTableObservation): NormPoint | null {
  if (obs.tableCenter) return obs.tableCenter;
  return mean(obs.seats.flatMap(s => (s.center ? [s.center] : []))) ?? mean(obs.cards.flatMap(c => (c.center ? [c.center] : [])));
}

export type ZoneGuess = { zone: CardZone; ambiguous: false } | { zone: null; ambiguous: true; between: readonly string[] };

/** Where a point lies by position alone, or ambiguous when two places are about equally close. */
export function zoneAt(point: NormPoint, seats: readonly SeatArea[], center: NormPoint | null): ZoneGuess | null {
  const placed = seats.filter(s => s.center).map(s => ({ id: s.id, d: dist(point, s.center!) })).sort((a, b) => a.d - b.d);
  if (!placed.length) return null;
  const nearest = placed[0];
  if (center && dist(point, center) < nearest.d * BOARD_RATIO) return { zone: { kind: 'board' }, ambiguous: false };
  const second = placed[1];
  if (second && second.d < nearest.d * SEAT_MARGIN) return { zone: null, ambiguous: true, between: [nearest.id, second.id] };
  if (center && dist(point, center) < nearest.d) return { zone: null, ambiguous: true, between: ['board', nearest.id] };
  return { zone: { kind: 'seat', seatId: nearest.id }, ambiguous: false };
}

const zoneName = (zone: CardZone, seats: readonly SeatArea[]) =>
  zone.kind === 'board' ? 'the board' : zone.kind === 'seat' ? seatTitle(seats, zone.seatId) : 'no seat';
export const seatTitle = (seats: readonly SeatArea[], id: string) => {
  const i = seats.findIndex(s => s.id === id);
  return i < 0 ? 'a removed seat' : seats[i].label.value ?? 'Seat ' + (i + 1);
};

function placeCard(card: PhysicalCardDetection, seats: readonly SeatArea[], center: NormPoint | null): PhysicalCardDetection {
  if (card.zoneSource === 'user' || !card.center) return card;
  const guess = zoneAt(card.center, seats, center);
  if (!guess) return { ...card, zone: card.readerZone, zoneSource: 'reader', zoneNote: undefined };
  const reader = card.readerZone;
  if (guess.ambiguous) {
    if (reader.kind !== 'unassigned') return { ...card, zone: reader, zoneSource: 'reader', zoneNote: undefined };
    const names = guess.between.map(id => (id === 'board' ? 'the board' : seatTitle(seats, id)));
    return { ...card, zone: { kind: 'unassigned' }, zoneSource: 'geometry', zoneNote: 'About equally close to ' + names.join(' and ') + '. Assign it.' };
  }
  if (reader.kind === 'unassigned') return { ...card, zone: guess.zone, zoneSource: 'geometry', zoneNote: undefined };
  if (sameZone(reader, guess.zone)) return { ...card, zone: reader, zoneSource: 'reader', zoneNote: undefined };
  return {
    ...card, zone: { kind: 'unassigned' }, zoneSource: 'geometry',
    zoneNote: 'The reader placed this card with ' + zoneName(reader, seats) + ', but it lies closer to ' + zoneName(guess.zone, seats) + '. Assign it.',
  };
}

/** Stack, bet, or pot by where the chips sit on the line from a seat to the centre. */
function placeChips(group: ChipGroup, seats: readonly SeatArea[], center: NormPoint | null): ChipGroup {
  if (group.zoneSource === 'user' || group.zone.kind !== 'unassigned' || !group.center) return group;
  const guess = zoneAt(group.center, seats, center);
  if (!guess || guess.ambiguous) return group;
  if (guess.zone.kind === 'board') return { ...group, zone: { kind: 'pot' }, zoneSource: 'geometry' };
  if (guess.zone.kind !== 'seat' || !center) return group;
  const seat = seats.find(s => s.id === (guess.zone as { seatId: string }).seatId)!;
  const toCenter = dist(seat.center!, center);
  const t = toCenter ? 1 - dist(group.center, center) / toCenter : 0;
  const zone: ChipZone = t < 0.35 ? { kind: 'stack', seatId: seat.id } : { kind: 'bet', seatId: seat.id };
  return { ...group, zone, zoneSource: 'geometry' };
}

/**
 * Seats in clockwise order around the centre, as seen in the photo, starting
 * from `startId` (the user's seat) or else the seat nearest the camera (the
 * bottom of the image). Seats without a position keep their relative order at the end.
 */
export function clockwiseOrder(seats: readonly SeatArea[], center: NormPoint | null, startId: string | null): SeatArea[] {
  const placed = seats.filter(s => s.center);
  if (!center || placed.length < 2) return [...seats];
  // In image coordinates y grows downward, so increasing atan2 runs clockwise on screen.
  const angle = (s: SeatArea) => Math.atan2(s.center!.y - center.y, s.center!.x - center.x);
  const start = placed.find(s => s.id === startId) ?? [...placed].sort((a, b) => b.center!.y - a.center!.y)[0];
  const a0 = angle(start);
  const turn = (s: SeatArea) => (angle(s) - a0 + 4 * Math.PI) % (2 * Math.PI);
  return [...[...placed].sort((a, b) => turn(a) - turn(b)), ...seats.filter(s => !s.center)];
}

/** Board cards ordered along the board's own axis (not assuming it is horizontal), left to right as seen by the camera. */
export function boardOrder(cards: readonly PhysicalCardDetection[]): PhysicalCardDetection[] {
  const board = cards.filter(c => c.zone.kind === 'board');
  const placed = board.filter(c => c.center);
  if (placed.length < 2) return board;
  const m = mean(placed.map(c => c.center!))!;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const c of placed) {
    const dx = c.center!.x - m.x;
    const dy = c.center!.y - m.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Principal axis of the card centres.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(theta);
  let uy = Math.sin(theta);
  if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
  const along = (c: PhysicalCardDetection) => (c.center ? (c.center.x - m.x) * ux + (c.center.y - m.y) * uy : Infinity);
  return [...board].sort((a, b) => along(a) - along(b) || a.id.localeCompare(b.id));
}

/**
 * Interpret the photo's layout: settle card and chip zones from positions
 * (keeping the reader's grouping when it agrees, and the user's always),
 * place the dealer button, and order seats clockwise unless the user set the order.
 */
export function interpretTable(obs: PhysicalTableObservation): PhysicalTableObservation {
  const center = tableCenter(obs);
  const seats = obs.seatOrderSource === 'user' ? [...obs.seats] : clockwiseOrder(obs.seats, center, obs.heroSeatId);
  const cards = obs.cards.map(c => placeCard(c, seats, center));
  const chips = obs.chips.map(g => placeChips(g, seats, center));
  let dealerSeatId = obs.dealerSeatId;
  if (obs.dealerSource !== 'corrected' && !dealerSeatId && obs.dealerButton) {
    const guess = zoneAt(obs.dealerButton, seats, null);
    if (guess && !guess.ambiguous && guess.zone.kind === 'seat') dealerSeatId = guess.zone.seatId;
  }
  return { ...obs, seats, cards, chips, dealerSeatId, tableCenter: obs.tableCenter, seatOrderSource: obs.seatOrderSource === 'user' ? 'user' : seats.some((s, i) => s.id !== obs.seats[i].id) ? 'geometry' : obs.seatOrderSource };
}
