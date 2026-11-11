// Physical observation → the shared ScreenshotRecognition, the state model
// that screenshot review, the study table, Track hand, and replay already use.
// Also lists physical problems (card grouping, duplicates, chips) for review.
// Values that cannot be determined stay unknown; nothing is invented to fill
// the model, and import still goes through the existing validation.
import type { Card } from '../core/types.js';
import {
  corrected, inferStreet, type ConfidenceLabel, type RecognizedCard, type RecognizedField, type RecognizedPlayer, type ScreenshotRecognition,
} from '../vision/screenshot.js';
import { sumGroups, type ChipValue } from './chips.js';
import { boardOrder, seatTitle } from './geometry.js';
import { cardOf, type ChipConfiguration, type PhysicalCardDetection, type PhysicalTableObservation } from './types.js';

export interface PhysicalIssue {
  /** `card:<id>`, `seat:<id>`, `chips:<id>`, `board`, `seats`, or `config`. */
  readonly field: string;
  readonly severity: 'error' | 'review';
  readonly message: string;
}

const rankName: Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const suitName: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
export const describeDetection = (d: PhysicalCardDetection) => {
  if (d.visibility === 'face_down') return 'a face-down card';
  if (d.rank && d.suit) return (rankName[d.rank] ?? d.rank) + ' of ' + suitName[d.suit];
  if (d.rank) return 'a ' + (rankName[d.rank] ?? d.rank) + ' (suit unknown)';
  if (d.suit) return 'a card of ' + suitName[d.suit] + ' (rank unknown)';
  return 'an unreadable card';
};

function recognizedCard(d: PhysicalCardDetection): RecognizedCard {
  const value = d.visibility === 'face_down' ? null : cardOf(d);
  return { value, confidence: value ? d.confidence : null, source: d.source, hidden: d.visibility === 'face_down' };
}

const chipConfidence = (v: ChipValue): ConfidenceLabel | null => (v.value === null ? null : v.status === 'confirmed' ? 'high' : 'low');

/** A typed override wins; otherwise the chips, with their certainty as the confidence label. */
function chipField(override: RecognizedField<number>, v: ChipValue): RecognizedField<number> {
  if (override.value !== null || override.source === 'corrected') return override;
  return { value: v.value, confidence: chipConfidence(v), source: 'observed' };
}

/** Cards of one seat in a stable left-to-right order. */
const seatCards = (obs: PhysicalTableObservation, seatId: string) =>
  obs.cards.filter(c => c.zone.kind === 'seat' && c.zone.seatId === seatId)
    .sort((a, b) => (a.center?.x ?? 0) - (b.center?.x ?? 0) || a.id.localeCompare(b.id));

export function physicalIssues(obs: PhysicalTableObservation, config: ChipConfiguration): PhysicalIssue[] {
  const issues: PhysicalIssue[] = [];
  const error = (field: string, message: string) => issues.push({ field, severity: 'error', message });
  const review = (field: string, message: string) => issues.push({ field, severity: 'review', message });

  if (obs.seats.length < 2) error('seats', 'Mark at least two seats on the table.');
  // Each physical card can be in only one place, including cards not yet assigned.
  const seen = new Map<Card, string[]>();
  for (const d of obs.cards) {
    const card = d.visibility === 'face_down' ? null : cardOf(d);
    if (card) seen.set(card, [...(seen.get(card) ?? []), d.id]);
  }
  for (const [card, ids] of seen) if (ids.length > 1) for (const id of ids) error('card:' + id, card + ' is detected ' + ids.length + ' times. A deck has one of each card.');

  const board = obs.cards.filter(c => c.zone.kind === 'board');
  if (board.length > 5) error('board', 'The board has ' + board.length + ' cards; it holds at most five. Move or remove the extras.');
  for (const c of board) if (c.visibility === 'face_down') review('card:' + c.id, 'A face-down card is grouped with the board. Board cards are dealt face up; check it.');
  for (const s of obs.seats) {
    const n = seatCards(obs, s.id).length;
    if (n > 2) error('seat:' + s.id, seatTitle(obs.seats, s.id) + ' has ' + n + ' cards; a player holds two. Reassign the extras.');
  }
  for (const c of obs.cards) {
    const field = 'card:' + c.id;
    if (c.zone.kind === 'unassigned') review(field, 'Assign ' + describeDetection(c) + ' to the board or a seat, or remove it.' + (c.zoneNote ? ' ' + c.zoneNote : ''));
    else if (c.zone.kind === 'seat' && !obs.seats.some(s => s.id === (c.zone as { seatId: string }).seatId)) error(field, 'A card belongs to a seat that was removed. Reassign it.');
    if (c.visibility === 'partially_visible' && c.source !== 'corrected') review(field, 'Part of ' + describeDetection(c) + ' is hidden; check it.');
    if (c.visibility !== 'face_down' && (c.rank === null) !== (c.suit === null)) review(field, 'Only part of this card was read: ' + describeDetection(c) + '.');
    if (c.visibility === 'unknown' && c.source !== 'corrected') review(field, 'It is not clear whether this card is face up or face down.');
  }
  for (const g of obs.chips) {
    const field = 'chips:' + g.id;
    if (g.zone.kind === 'unassigned') review(field, 'Assign this chip group to a seat or the pot, or remove it.');
    if (g.countStatus === 'unknown') review(field, 'This chip group could not be counted. Enter the count, or leave the amount unknown.');
    else if (g.countStatus === 'estimated') review(field, 'This chip count is an estimate (' + g.count + '). Confirm or correct it.');
    if (g.color && config.denominations.length && !config.denominations.some(d => d.colorLabel.trim().toLowerCase() === g.color!.trim().toLowerCase())) {
      review(field, 'No value is set for ' + g.color + ' chips. Add it to the chip values.');
    }
  }
  if (obs.chips.length && !config.denominations.length) review('config', 'Set your chip values to turn chip counts into stacks, bets, and the pot.');
  return issues;
}

/**
 * The shared table state for one photo. Seats keep their clockwise order;
 * cards, stacks, bets, pot, dealer, and street come from the reviewed
 * observation. A seat with more than two cards contributes its first two
 * here, and `physicalIssues` blocks import until the extras are reassigned.
 */
export function physicalToRecognition(obs: PhysicalTableObservation, config: ChipConfiguration): ScreenshotRecognition {
  const players: RecognizedPlayer[] = obs.seats.map(seat => {
    const cards = seatCards(obs, seat.id).slice(0, 2).map(recognizedCard);
    const stack = sumGroups(obs.chips.filter(g => g.zone.kind === 'stack' && g.zone.seatId === seat.id), config);
    const betGroups = obs.chips.filter(g => g.zone.kind === 'bet' && g.zone.seatId === seat.id);
    // No bet chips is a bet of 0 only when the reader saw the area in front of the seat clearly empty.
    const bet: RecognizedField<number> = betGroups.length
      ? chipField(seat.betOverride, sumGroups(betGroups, config))
      : seat.betOverride.value !== null || seat.betOverride.source === 'corrected'
        ? seat.betOverride
        : seat.betAreaEmpty === true ? { value: 0, confidence: 'medium', source: 'observed' } : { value: null, confidence: null, source: 'observed' };
    return {
      name: seat.label,
      stack: chipField(seat.stackOverride, stack),
      bet,
      status: seat.status,
      cards: cards.length === 1 ? [...cards, { value: null, confidence: null, source: 'observed', hidden: false }] : cards,
    };
  });
  const board = boardOrder(obs.cards).map(recognizedCard);
  const potChips = obs.chips.filter(g => g.zone.kind === 'pot');
  const potFromChips = potChips.length ? sumGroups(potChips, config) : null;
  const pot: RecognizedField<number> = obs.potText.value !== null || obs.potText.source === 'corrected'
    ? obs.potText
    : potFromChips ? { value: potFromChips.value, confidence: chipConfidence(potFromChips), source: 'observed' }
      : obs.potAreaEmpty === true ? { value: 0, confidence: 'medium', source: 'observed' } : { value: null, confidence: null, source: 'observed' };
  const index = (id: string | null) => (id ? obs.seats.findIndex(s => s.id === id) : -1);
  const dealer = index(obs.dealerSeatId);
  const hero = index(obs.heroSeatId);
  return {
    providerId: obs.providerId,
    modelId: obs.modelId,
    players,
    communityCards: board,
    pot,
    // Bets are separate chip piles in a photo and are counted on their own, so the pot never includes them.
    potIncludesBets: false,
    potIncludesBetsRead: { value: false, confidence: 'high', source: 'observed' },
    smallBlind: obs.smallBlind,
    bigBlind: obs.bigBlind,
    dealerSeat: dealer >= 0 ? { value: dealer, confidence: obs.dealerSource === 'corrected' ? null : 'medium', source: obs.dealerSource } : { value: null, confidence: null, source: 'observed' },
    heroSeat: hero >= 0 ? (obs.heroSource === 'corrected' ? corrected(hero) : { value: hero, confidence: 'medium', source: 'observed' }) : { value: null, confidence: null, source: 'observed' },
    street: obs.street.value !== null ? obs.street : inferStreet(board),
    warnings: [...obs.warnings],
    ...(obs.seatOrderSource === 'user' ? { seatOrderCorrected: true } : {}),
  };
}
