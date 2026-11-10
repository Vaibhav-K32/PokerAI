// Screenshot recognition: typed results, runtime validation of provider
// output, review checks, and conversion into the app's state models. Pure
// TypeScript; the browser upload and review screen live in src/web/.
import { standardDeck } from '../core/cards.js';
import type { Card, Snapshot } from '../core/types.js';
import { holdem } from '../rules/holdem.js';
import type { TableObservation } from '../history/observation.js';

/** The provider's own label. Not a calibrated probability. */
export type ConfidenceLabel = 'high' | 'medium' | 'low';
/** Where a value came from: read from the image, derived by a rule, or set by the user. */
export type FieldSource = 'observed' | 'inferred' | 'corrected';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface RecognizedField<T> {
  /** `null` means unknown; it is never replaced by a guess. */
  readonly value: T | null;
  /** `null` when no usable estimate exists (missing value, inferred, or corrected). */
  readonly confidence: ConfidenceLabel | null;
  readonly source: FieldSource;
}

export interface RecognizedCard extends RecognizedField<Card> {
  /** Face-down card back: unknown by design, not an unreadable card. */
  readonly hidden: boolean;
}

export interface RecognizedPlayer {
  readonly name: RecognizedField<string>;
  readonly stack: RecognizedField<number>;
  /** Chips in front of the seat on the current street. */
  readonly bet: RecognizedField<number>;
  readonly status: RecognizedField<'active' | 'folded'>;
  /** Zero or two cards. */
  readonly cards: readonly RecognizedCard[];
}

export interface ScreenshotRecognition {
  readonly providerId: string;
  readonly modelId: string | null;
  /** Seats in clockwise order, starting from the bottom-center seat. */
  readonly players: readonly RecognizedPlayer[];
  readonly communityCards: readonly RecognizedCard[];
  readonly pot: RecognizedField<number>;
  /** True when the pot shown already includes this street's bets. Follows `potIncludesBetsRead` when known; false otherwise. */
  readonly potIncludesBets: boolean;
  /** The reader's answer (or the user's) to whether the pot shown includes the bets; `null` value when unclear. */
  readonly potIncludesBetsRead?: RecognizedField<boolean>;
  readonly smallBlind: RecognizedField<number>;
  readonly bigBlind: RecognizedField<number>;
  /** Index into `players`. */
  readonly dealerSeat: RecognizedField<number>;
  /** Index into `players` of the user's seat. */
  readonly heroSeat: RecognizedField<number>;
  readonly street: RecognizedField<Street>;
  readonly warnings: readonly string[];
  /** True once the user changed the seat order. */
  readonly seatOrderCorrected?: boolean;
}

export const MAX_SCREEN_PLAYERS = 10;
const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const BOARD_STREET: Record<number, Street> = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };
/** Largest chip amount accepted anywhere: provider output, corrections, and saved files. */
export const MAX_CHIPS = 1_000_000_000;

export class RecognitionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionFormatError';
  }
}

// ---------------------------------------------------------------------------
// Parsing provider output
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (where: string): never => { throw new RecognitionFormatError('The recognition response was malformed (' + where + ').'); };

function confidenceOf(raw: unknown, where: string): ConfidenceLabel | null {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (raw === 'none' || raw === null || raw === undefined) return null;
  return bad(where + ' confidence');
}

function fieldOf<T>(raw: unknown, where: string, check: (v: unknown) => v is T): RecognizedField<T> {
  if (!isRecord(raw)) return bad(where);
  const value = raw.value;
  if (value !== null && !check(value)) return bad(where);
  const confidence = value === null ? null : confidenceOf(raw.confidence, where);
  return { value: value as T | null, confidence, source: 'observed' };
}

const isChips = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CHIPS;
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 60;
const isStreet = (v: unknown): v is Street => STREETS.includes(v as Street);

function cardOf(raw: unknown, where: string): RecognizedCard {
  if (!isRecord(raw) || typeof raw.card !== 'string') return bad(where);
  if (raw.card === 'hidden') return { value: null, confidence: null, source: 'observed', hidden: true };
  if (raw.card === 'unknown') return { value: null, confidence: null, source: 'observed', hidden: false };
  if (!standardDeck.includes(raw.card)) return bad(where + ' card code');
  return { value: raw.card, confidence: confidenceOf(raw.confidence, where), source: 'observed', hidden: false };
}

/**
 * Validate an untrusted provider payload `{ modelId, result }` and build a
 * typed recognition. Throws RecognitionFormatError for anything malformed or
 * structurally impossible (too many seats, board, or hole cards).
 */
export function parseScreenshotResponse(payload: unknown, providerId: string): ScreenshotRecognition {
  if (!isRecord(payload) || !isRecord(payload.result)) return bad('no result');
  const modelId = typeof payload.modelId === 'string' ? payload.modelId : null;
  const r = payload.result;
  if (!Array.isArray(r.players)) return bad('players');
  if (r.players.length > MAX_SCREEN_PLAYERS) throw new RecognitionFormatError('The screenshot shows more than ' + MAX_SCREEN_PLAYERS + ' seats, which this app does not support.');
  const players: RecognizedPlayer[] = r.players.map((p: unknown, i: number) => {
    const where = 'seat ' + (i + 1);
    if (!isRecord(p) || !Array.isArray(p.cards)) return bad(where);
    if (p.cards.length > 2) throw new RecognitionFormatError('Seat ' + (i + 1) + ' shows more than two hole cards.');
    const status = fieldOf(p.status, where + ' status', (v): v is string => v === 'active' || v === 'folded' || v === 'unknown');
    return {
      name: fieldOf(p.name, where + ' name', isName),
      stack: fieldOf(p.stack, where + ' stack', isChips),
      bet: fieldOf(p.bet, where + ' bet', isChips),
      status: status.value === 'unknown' ? { value: null, confidence: null, source: 'observed' } : status as RecognizedField<'active' | 'folded'>,
      cards: p.cards.map((c: unknown, j: number) => cardOf(c, where + ' card ' + (j + 1))),
    };
  });
  if (!Array.isArray(r.board)) return bad('board');
  if (r.board.length > 5) throw new RecognitionFormatError('The screenshot shows more than five community cards.');
  const communityCards = r.board.map((c: unknown, j: number) => cardOf(c, 'board card ' + (j + 1)));
  const seatIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < players.length;

  const observedStreet = fieldOf(r.street, 'street', isStreet);
  // Optional, so older responses and fixtures without it still parse.
  const potRead = r.potIncludesBets === undefined ? undefined : fieldOf(r.potIncludesBets, 'pot includes bets', (v): v is boolean => typeof v === 'boolean');
  const warnings = Array.isArray(r.issues) ? r.issues.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
  return {
    providerId,
    modelId,
    players,
    communityCards,
    pot: fieldOf(r.pot, 'pot', isChips),
    potIncludesBets: potRead?.value ?? false,
    ...(potRead ? { potIncludesBetsRead: potRead } : {}),
    smallBlind: fieldOf(r.smallBlind, 'small blind', isChips),
    bigBlind: fieldOf(r.bigBlind, 'big blind', isChips),
    dealerSeat: fieldOf(r.dealerSeat, 'dealer seat', seatIndex),
    heroSeat: fieldOf(r.heroSeat, 'your seat', seatIndex),
    street: observedStreet.value !== null ? observedStreet : inferStreet(communityCards),
    warnings,
  };
}

/** The street implied by the number of board positions, marked as inferred. */
export function inferStreet(board: readonly RecognizedCard[]): RecognizedField<Street> {
  const street = BOARD_STREET[board.length];
  return { value: street ?? null, confidence: null, source: 'inferred' };
}

// ---------------------------------------------------------------------------
// Confidence indicators
// ---------------------------------------------------------------------------

/**
 * How a field is shown: the reader's own label (high, medium, low), `unrated`
 * when a value has no usable label (an inferred value, or a provider that gave
 * none), `unknown` when there is no value, and `corrected` once the user set it.
 * Labels are not probabilities, and no number is ever shown.
 */
export type Indicator = 'high' | 'medium' | 'low' | 'unrated' | 'unknown' | 'corrected';

export function indicator(field: RecognizedField<unknown>): Indicator {
  if (field.source === 'corrected') return field.value === null ? 'unknown' : 'corrected';
  if (field.value === null) return 'unknown';
  if (field.source === 'inferred' || field.confidence === null) return 'unrated';
  return field.confidence;
}

export const indicatorLabels: Record<Indicator, string> = {
  high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence',
  unrated: 'Not rated', unknown: 'Unknown', corrected: 'Corrected',
};

/** True for a value that is present but not confirmed: medium, low, or unrated. */
export function needsReview(field: RecognizedField<unknown>): boolean {
  const level = indicator(field);
  return level === 'medium' || level === 'low' || level === 'unrated';
}

// ---------------------------------------------------------------------------
// Seat order
// ---------------------------------------------------------------------------

/** Where each seat ends up when the seat at `from` moves to `to`: result[old] = new. */
export function seatMoveMap(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const map = new Array<number>(count);
  order.forEach((old, index) => { map[old] = index; });
  return map;
}

/**
 * Move one seat to another position, keeping every player's cards, chips,
 * status, and name together. Your seat and the dealer stay with the same
 * players (their reader labels are kept, since the assignment did not
 * change). Out-of-range or no-op moves return the recognition unchanged.
 */
export function moveSeat(rec: ScreenshotRecognition, from: number, to: number): ScreenshotRecognition {
  const n = rec.players.length;
  const valid = (i: number) => Number.isSafeInteger(i) && i >= 0 && i < n;
  if (!valid(from) || !valid(to) || from === to) return rec;
  const map = seatMoveMap(n, from, to);
  const players = new Array<RecognizedPlayer>(n);
  rec.players.forEach((p, i) => { players[map[i]] = p; });
  const follow = (f: RecognizedField<number>): RecognizedField<number> => (f.value === null ? f : { ...f, value: map[f.value] });
  return { ...rec, players, heroSeat: follow(rec.heroSeat), dealerSeat: follow(rec.dealerSeat), seatOrderCorrected: true };
}

/**
 * Read a chip amount typed by the user. Blank means unknown. Rejects input
 * the browser could not parse (`badInput`), fractions, negatives, and amounts
 * above MAX_CHIPS, so a correction never fails a later reload.
 */
export function parseChipInput(text: string, badInput = false): { value: number | null } | { error: string } {
  const trimmed = text.trim();
  if (badInput) return { error: 'Enter a whole number of chips, or leave it blank for unknown.' };
  if (trimmed === '') return { value: null };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) return { error: 'Use a whole number of chips, or leave it blank for unknown.' };
  if (value > MAX_CHIPS) return { error: 'Use at most ' + MAX_CHIPS.toLocaleString('en-US') + ' chips.' };
  return { value };
}

/** A user edit: the value is now known (or deliberately unknown) and confirmed. */
export function corrected<T>(value: T | null): RecognizedField<T> {
  return { value, confidence: null, source: 'corrected' };
}

export function correctedCard(value: Card | null, hidden = false): RecognizedCard {
  return { value, confidence: null, source: 'corrected', hidden: value === null && hidden };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewIssue {
  /** Field path such as `board.2`, `players.1.stack`, or `pot`. */
  readonly field: string;
  /** `error` blocks every import; `review` is a prompt to check. */
  readonly severity: 'error' | 'review';
  readonly message: string;
}

const seatLabel = (rec: ScreenshotRecognition, i: number) => rec.players[i].name.value ?? 'Seat ' + (i + 1);
/** Possessive of a seat label: Your, Riley’s, Seat 2’s. */
const possessive = (label: string) => (label.toLowerCase() === 'you' ? 'Your' : label + '’s');

/** Check a recognition for impossible states, conflicts, and fields to review. */
export function reviewScreenshot(rec: ScreenshotRecognition): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const error = (field: string, message: string) => issues.push({ field, severity: 'error', message });
  const review = (field: string, message: string) => issues.push({ field, severity: 'review', message });

  if (rec.players.length < 2) error('players', 'A table needs at least two seats. Add the missing seats.');
  if (rec.players.length > MAX_SCREEN_PLAYERS) error('players', 'At most ' + MAX_SCREEN_PLAYERS + ' seats are supported.');

  // Duplicate cards anywhere.
  const seen = new Map<Card, string[]>();
  const note = (card: Card | null, field: string) => { if (card) seen.set(card, [...(seen.get(card) ?? []), field]); };
  rec.communityCards.forEach((c, i) => note(c.value, 'board.' + i));
  rec.players.forEach((p, i) => p.cards.forEach((c, j) => note(c.value, 'players.' + i + '.cards.' + j)));
  for (const [card, fields] of seen) {
    if (fields.length > 1) for (const field of fields) error(field, card + ' appears ' + fields.length + ' times. Each card can appear only once.');
  }

  // Board shape and street.
  const boardCount = rec.communityCards.length;
  if (![0, 3, 4, 5].includes(boardCount)) {
    error('board', 'A board has 0, 3, 4, or 5 cards; this one has ' + boardCount + '. Add or remove board positions.');
  }
  rec.communityCards.forEach((c, i) => {
    if (c.value === null) review('board.' + i, c.hidden ? 'Board card ' + (i + 1) + ' is face-down.' : 'Board card ' + (i + 1) + ' could not be read.');
    else if (needsReview(c)) review('board.' + i, 'Board card ' + (i + 1) + ' (' + c.value + ') is ambiguous.');
  });
  const implied = BOARD_STREET[boardCount];
  if (rec.street.value && implied && rec.street.value !== implied) {
    error('street', 'The street says ' + rec.street.value + ' but the board has ' + boardCount + ' cards.');
  } else if (rec.street.source === 'inferred' && rec.street.value) {
    review('street', 'The street was inferred from the board, not read from the screen.');
  }

  // Seats.
  rec.players.forEach((p, i) => {
    const label = seatLabel(rec, i);
    if (p.cards.length === 1) error('players.' + i + '.cards', label + ' has one hole card; a seat shows zero or two.');
    p.cards.forEach((c, j) => {
      if (c.value === null && !c.hidden) review('players.' + i + '.cards.' + j, possessive(label) + ' card ' + (j + 1) + ' could not be read.');
      else if (c.value !== null && needsReview(c)) review('players.' + i + '.cards.' + j, possessive(label) + ' card ' + (j + 1) + ' (' + c.value + ') is ambiguous.');
    });
    if (p.status.value !== 'folded') {
      if (p.stack.value === null) review('players.' + i + '.stack', possessive(label) + ' stack is unreadable or missing.');
      else if (needsReview(p.stack)) review('players.' + i + '.stack', possessive(label) + ' stack (' + p.stack.value + ') needs checking.');
    }
    if (p.bet.value === null) review('players.' + i + '.bet', possessive(label) + ' bet could not be read. Enter 0 if there is none.');
    else if (needsReview(p.bet)) review('players.' + i + '.bet', possessive(label) + ' bet (' + p.bet.value + ') needs checking.');
    if (p.status.value === null) review('players.' + i + '.status', 'Is ' + label + ' still in the hand?');
  });
  const live = rec.players.filter(p => p.status.value !== 'folded');
  if (rec.players.length >= 2 && live.length < 2) error('players', 'At least two seats must still be in the hand.');

  // Dealer and hero.
  if (rec.dealerSeat.value === null) review('dealerSeat', 'The dealer button was not found.');
  if (rec.heroSeat.value === null) {
    review('heroSeat', 'Mark which seat is yours to load this into the study table.');
  } else if (rec.players[rec.heroSeat.value]?.status.value === 'folded') {
    review('heroSeat', 'Your seat is marked as folded, so there is no decision to study.');
  }

  // Chips.
  if (rec.pot.value === null) review('pot', 'The pot was not found.');
  else if (needsReview(rec.pot)) review('pot', 'The pot (' + rec.pot.value + ') needs checking.');
  const bets = rec.players.reduce((sum, p) => sum + (p.bet.value ?? 0), 0);
  if (rec.potIncludesBets && rec.pot.value !== null && rec.pot.value < bets) {
    error('pot', 'The pot (' + rec.pot.value + ') is smaller than the bets in front of players (' + bets + ').');
  }
  if (rec.smallBlind.value !== null && rec.bigBlind.value !== null && rec.smallBlind.value > rec.bigBlind.value) {
    error('smallBlind', 'The small blind is larger than the big blind.');
  }
  if (rec.bigBlind.value === 0) error('bigBlind', 'The big blind must be positive.');
  if (rec.smallBlind.value === 0) error('smallBlind', 'The small blind must be positive.');
  const read = rec.potIncludesBetsRead;
  if (rec.pot.value !== null && bets > 0 && (!read || read.value === null || needsReview(read))) {
    review('potIncludesBets', read?.value === null || !read
      ? 'It is not clear whether the pot shown already includes the bets in front of players. Tick the box if it does.'
      : 'Check whether the pot shown already includes the bets in front of players (read as ' + (read.value ? 'included' : 'not included') + ').');
  }
  if (rec.bigBlind.value === null) review('bigBlind', 'The big blind was not found; it sets the minimum bet for analysis.');
  return issues;
}

/** True when nothing blocks saving or attaching the recognition. */
export const hasBlockingIssues = (issues: readonly ReviewIssue[]) => issues.some(i => i.severity === 'error');

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Build the study table's snapshot from a reviewed recognition. Returns the
 * reasons it cannot when something required is unknown, instead of guessing.
 */
export function toStudySnapshot(rec: ScreenshotRecognition, purpose: Snapshot['purpose']): { snapshot: Snapshot } | { problems: string[] } {
  const problems: string[] = [];
  if (hasBlockingIssues(reviewScreenshot(rec))) problems.push('Fix the problems marked as blocking first.');
  const heroIndex = rec.heroSeat.value;
  const hero = heroIndex === null ? undefined : rec.players[heroIndex];
  if (!hero) {
    problems.push('Mark which seat is yours.');
    return { problems };
  }
  if (hero.status.value === 'folded') problems.push('Your seat is folded, so there is no decision to study.');
  if (hero.cards.length !== 2 || hero.cards.some(c => c.value === null)) problems.push('Enter both of your hole cards.');
  if (hero.stack.value === null || hero.stack.value === 0) problems.push('Enter your stack; it must be above zero.');
  const opponents = rec.players.filter((p, i) => i !== heroIndex && p.status.value !== 'folded');
  if (opponents.length < 1 || opponents.length > 3) {
    problems.push('The study table analyzes two to four players still in the hand; this screenshot has ' + (opponents.length + 1) + '. Mark folded seats as folded.');
  }
  if (rec.players.some((p, i) => i !== heroIndex && p.status.value === null)) problems.push('Mark every seat as in the hand or folded.');
  opponents.forEach(p => {
    if (p.stack.value === null) problems.push('Enter the stack for ' + (p.name.value ?? 'every opponent in the hand') + '.');
  });
  if (rec.players.some(p => p.bet.value === null)) problems.push('Enter every bet in front of a seat (0 when there is none).');
  if (rec.pot.value === null) problems.push('Enter the pot.');
  if (rec.communityCards.some(c => c.value === null)) problems.push('Enter every board card.');
  if (![0, 3, 4, 5].includes(rec.communityCards.length)) problems.push('The board needs 0, 3, 4, or 5 cards.');
  if (rec.bigBlind.value === null || rec.bigBlind.value === 0) problems.push('Enter the big blind; it sets the minimum bet.');
  if (problems.length) return { problems: [...new Set(problems)] };

  const bets = rec.players.reduce((sum, p) => sum + p.bet.value!, 0);
  const pot = rec.potIncludesBets ? rec.pot.value! : rec.pot.value! + bets;
  const maxBet = Math.max(...rec.players.map(p => p.bet.value!));
  const snapshot: Snapshot = {
    version: 2,
    ruleset: holdem.id,
    purpose,
    hero: hero.cards.map(c => c.value!) as Card[],
    board: rec.communityCards.map(c => c.value!) as Card[],
    opponents: opponents.map(p => ({
      stack: p.stack.value!,
      committed: p.bet.value!,
      cards: p.cards.length === 2 && p.cards.every(c => c.value !== null) ? p.cards.map(c => c.value!) as Card[] : [],
    })),
    pot,
    heroStack: hero.stack.value!,
    committed: hero.bet.value!,
    // A screenshot shows the current bet but not the last raise size; use one big blind as the minimum increment.
    increment: Math.max(rec.bigBlind.value!, 1),
  };
  if (maxBet > 0 && opponents.every(p => p.bet.value! < maxBet) && hero.bet.value! < maxBet) {
    return { problems: ['The biggest bet belongs to a folded seat. Check the bets and statuses.'] };
  }
  try {
    holdem.validate(snapshot);
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : 'The state is not valid.'] };
  }
  return { snapshot };
}

/** The recognition as a neutral observation for matching saved hand histories. */
export function toTableObservation(rec: ScreenshotRecognition): TableObservation {
  return {
    board: rec.communityCards.map(c => c.value),
    pot: rec.pot.value,
    potIncludesBets: rec.potIncludesBets,
    players: rec.players.map(p => ({
      name: p.name.value,
      cards: p.cards.length ? p.cards.map(c => c.value) : [null, null],
      stack: p.stack.value,
      bet: p.bet.value,
      folded: p.status.value === null ? null : p.status.value === 'folded',
    })),
  };
}

// ---------------------------------------------------------------------------
// Restoring saved recognitions
// ---------------------------------------------------------------------------

const SOURCES: readonly FieldSource[] = ['observed', 'inferred', 'corrected'];

function restoreField<T>(raw: unknown, check: (v: unknown) => v is T, where: string): RecognizedField<T> {
  if (!isRecord(raw)) return bad(where);
  if (raw.value !== null && !check(raw.value)) return bad(where);
  if (raw.confidence !== null && !['high', 'medium', 'low'].includes(raw.confidence as string)) return bad(where);
  if (!SOURCES.includes(raw.source as FieldSource)) return bad(where);
  return { value: raw.value as T | null, confidence: raw.confidence as ConfidenceLabel | null, source: raw.source as FieldSource };
}

function restoreCard(raw: unknown, where: string): RecognizedCard {
  const field = restoreField(raw, (v): v is Card => typeof v === 'string' && standardDeck.includes(v), where);
  return { ...field, hidden: isRecord(raw) && raw.hidden === true && field.value === null };
}

/** Validate a recognition saved earlier (for example in browser storage). */
export function restoreRecognition(raw: unknown): ScreenshotRecognition {
  if (!isRecord(raw) || !Array.isArray(raw.players) || !Array.isArray(raw.communityCards)) return bad('saved recognition');
  if (raw.players.length > MAX_SCREEN_PLAYERS || raw.communityCards.length > 5) return bad('saved recognition size');
  const players = raw.players.map((p: unknown, i: number) => {
    const where = 'saved seat ' + (i + 1);
    if (!isRecord(p) || !Array.isArray(p.cards) || p.cards.length > 2) return bad(where);
    return {
      name: restoreField(p.name, isName, where),
      stack: restoreField(p.stack, isChips, where),
      bet: restoreField(p.bet, isChips, where),
      status: restoreField(p.status, (v): v is 'active' | 'folded' => v === 'active' || v === 'folded', where),
      cards: p.cards.map((c: unknown) => restoreCard(c, where)),
    };
  });
  const seatIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < players.length;
  return {
    providerId: typeof raw.providerId === 'string' ? raw.providerId : 'unknown',
    modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
    players,
    communityCards: raw.communityCards.map((c: unknown, i: number) => restoreCard(c, 'saved board ' + (i + 1))),
    pot: restoreField(raw.pot, isChips, 'saved pot'),
    potIncludesBets: raw.potIncludesBets === true,
    ...(raw.potIncludesBetsRead !== undefined ? { potIncludesBetsRead: restoreField(raw.potIncludesBetsRead, (v): v is boolean => typeof v === 'boolean', 'saved pot includes bets') } : {}),
    smallBlind: restoreField(raw.smallBlind, isChips, 'saved small blind'),
    bigBlind: restoreField(raw.bigBlind, isChips, 'saved big blind'),
    dealerSeat: restoreField(raw.dealerSeat, seatIndex, 'saved dealer'),
    heroSeat: restoreField(raw.heroSeat, seatIndex, 'saved seat'),
    street: restoreField(raw.street, isStreet, 'saved street'),
    ...(raw.seatOrderCorrected === true ? { seatOrderCorrected: true } : {}),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((s): s is string => typeof s === 'string').slice(0, 8) : [],
  };
}
