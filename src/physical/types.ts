// Physical table photographs: the data model. A photo of real cards and chips
// is read into spatial detections (cards, seats, the dealer button, chip
// groups), which the geometry and chip modules interpret and the conversion
// module turns into the same ScreenshotRecognition that screenshots use. There
// is no separate rules engine or state model for physical tables.
import type { Card } from '../core/types.js';
import type { ConfidenceLabel, FieldSource, RecognizedField, Street } from '../vision/screenshot.js';

/** A point as a fraction of the image width and height (0–1), so overlays stay aligned when the image is resized. */
export interface NormPoint {
  readonly x: number;
  readonly y: number;
}

/** An approximate box as fractions of the image size. Never treated as exact. */
export interface NormBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CardVisibility = 'face_up' | 'face_down' | 'partially_visible' | 'unknown';

/** Where a detection belongs on the table. */
export type CardZone =
  | { readonly kind: 'board' }
  | { readonly kind: 'seat'; readonly seatId: string }
  | { readonly kind: 'unassigned' };

/** Who decided a zone: the reader, the geometry module, or the user. */
export type ZoneSource = 'reader' | 'geometry' | 'user';

export interface PhysicalCardDetection {
  readonly id: string;
  /** Rank character (2–9, T, J, Q, K, A) when read, even if the suit is not. */
  readonly rank: string | null;
  /** Suit letter (c, d, h, s) when read. */
  readonly suit: string | null;
  /** The reader's label for the rank and suit together; not a probability. */
  readonly confidence: ConfidenceLabel | null;
  readonly source: FieldSource;
  readonly visibility: CardVisibility;
  /** Approximate rotation from upright, in degrees, when reported. */
  readonly orientationDegrees: number | null;
  readonly box: NormBox | null;
  readonly center: NormPoint | null;
  /** The reader's own grouping, kept for comparison with the geometry. */
  readonly readerZone: CardZone;
  readonly zone: CardZone;
  readonly zoneSource: ZoneSource;
  /** Why the zone is uncertain, when it is. */
  readonly zoneNote?: string;
}

export interface SeatArea {
  /** Stable within a scan: `seat-1`, … in the order the reader listed them, or `added-…` for seats the user adds. */
  readonly id: string;
  readonly label: RecognizedField<string>;
  readonly center: NormPoint | null;
  readonly status: RecognizedField<'active' | 'folded'>;
  /** A stack typed by the user; overrides the chip estimate. */
  readonly stackOverride: RecognizedField<number>;
  /** A bet typed by the user; overrides chips in front of the seat. */
  readonly betOverride: RecognizedField<number>;
  /** True when the reader saw clearly that no chips are in front of this seat; `null` when unclear. */
  readonly betAreaEmpty: boolean | null;
}

export type ChipCountStatus = 'confirmed' | 'estimated' | 'unknown';

export type ChipZone =
  | { readonly kind: 'stack'; readonly seatId: string }
  | { readonly kind: 'bet'; readonly seatId: string }
  | { readonly kind: 'pot' }
  | { readonly kind: 'unassigned' };

export interface ChipGroup {
  readonly id: string;
  /** Colour as the reader or user described it, matched to the chip configuration case-insensitively. */
  readonly color: string | null;
  readonly count: number | null;
  /** Confirmed: counted clearly or set by the user. Estimated: approximate. Unknown: could not be counted. */
  readonly countStatus: ChipCountStatus;
  readonly source: FieldSource;
  readonly center: NormPoint | null;
  readonly box: NormBox | null;
  readonly zone: ChipZone;
  readonly zoneSource: ZoneSource;
}

/** Chip values for one simulated game; colours carry no universal value. */
export interface ChipConfiguration {
  readonly denominations: readonly { readonly colorLabel: string; readonly value: number }[];
}

export type PhysicalReviewStatus = 'unreviewed' | 'reviewed' | 'corrected';

export interface PhysicalTableObservation {
  readonly id: string;
  readonly source: 'physical_photo';
  readonly providerId: string;
  readonly modelId: string | null;
  readonly tableCenter: NormPoint | null;
  readonly tableCenterSource: ZoneSource;
  readonly cards: readonly PhysicalCardDetection[];
  /** In clockwise order around the table. */
  readonly seats: readonly SeatArea[];
  /** Who set the seat order; geometry reorders only when it is not the user. */
  readonly seatOrderSource: ZoneSource;
  readonly heroSeatId: string | null;
  readonly heroSource: FieldSource;
  readonly dealerSeatId: string | null;
  readonly dealerSource: FieldSource;
  readonly dealerButton: NormPoint | null;
  readonly chips: readonly ChipGroup[];
  /** A pot amount only when written or displayed (for example on a card); otherwise counted from chips. */
  readonly potText: RecognizedField<number>;
  /** True when the reader saw clearly that the middle of the table has no chips; `null` when unclear. */
  readonly potAreaEmpty: boolean | null;
  readonly street: RecognizedField<Street>;
  readonly smallBlind: RecognizedField<number>;
  readonly bigBlind: RecognizedField<number>;
  /** The reader's notes about glare, overlap, framing, and lighting. */
  readonly warnings: readonly string[];
  readonly reviewStatus: PhysicalReviewStatus;
}

/** A card value when both rank and suit are known. */
export const cardOf = (d: Pick<PhysicalCardDetection, 'rank' | 'suit'>): Card | null => (d.rank && d.suit ? d.rank + d.suit : null);
