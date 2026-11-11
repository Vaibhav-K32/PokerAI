// Recognition benchmarking: dataset, ground truth, predictions, results, and
// runs. Ground truth is what a careful person can see in the image, entered
// or verified independently of any recognizer. Unknown (`null`, `unreadable`)
// is always distinct from zero or empty.
import type { Card } from '../core/types.js';
import type { ChipConfiguration, PhysicalTableObservation } from '../physical/types.js';
import type { ConfidenceLabel, ScreenshotRecognition, Street } from '../vision/screenshot.js';

export const DATASET_KIND = 'poker-study/benchmark-dataset';
export const DATASET_SCHEMA_VERSION = 1;
export const RUN_KIND = 'poker-study/benchmark-run';
export const RUN_SCHEMA_VERSION = 1;
/** Bump when any metric definition changes; runs with different versions are not compared directly. */
export const METRICS_VERSION = 1;

export type SampleSource = 'digital_screenshot' | 'physical_photo';

export const DIFFICULTY_TAGS = [
  'clean', 'bright', 'dim', 'glare', 'rotated', 'angled', 'overlap', 'occlusion', 'blur', 'low_resolution', 'unusual_layout', 'unreadable_text',
] as const;
export type DifficultyTag = typeof DIFFICULTY_TAGS[number];

/** A card position in the truth: a readable card, a card back, or a visible face no one can read. */
export type TruthCard =
  | { readonly kind: 'card'; readonly card: Card }
  | { readonly kind: 'face_down' }
  | { readonly kind: 'unreadable' };

export interface TruthBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CardTag = 'rotated' | 'occluded' | 'blurred';

export interface TruthSlot {
  readonly card: TruthCard;
  /** Where the card is, as fractions of the image; only for photos with measured positions. */
  readonly box?: TruthBox;
  readonly tags?: readonly CardTag[];
}

export interface GroundTruthPlayer {
  /** `null` when no name is visible. */
  readonly name: string | null;
  /** Zero or two slots, in left-to-right order. */
  readonly cards: readonly TruthSlot[];
  /** Chips behind; `null` when not visible. */
  readonly stack: number | null;
  /** Chips in front this street; `null` when not visible, 0 when visibly none. */
  readonly bet: number | null;
  readonly folded: boolean | null;
}

export interface GroundTruth {
  /** Seats clockwise from the bottom of the image. */
  readonly players: readonly GroundTruthPlayer[];
  readonly board: readonly TruthSlot[];
  /** The pot as shown (excluding bets in front); `null` when not visible. */
  readonly pot: number | null;
  readonly dealerSeat: number | null;
  readonly heroSeat: number | null;
  readonly street: Street | null;
  readonly smallBlind: number | null;
  readonly bigBlind: number | null;
}

export type ImageRef =
  /** A table this project draws (screenshot or physical scene fixture), rendered when needed. */
  | { readonly kind: 'synthetic'; readonly fixture: string }
  /** A raster file next to the dataset manifest (relative path). */
  | { readonly kind: 'file'; readonly path: string };

export interface BenchmarkSample {
  readonly id: string;
  readonly sourceType: SampleSource;
  readonly image: ImageRef;
  readonly groundTruth: GroundTruth;
  readonly tags: readonly DifficultyTag[];
  readonly metadata: {
    readonly lighting?: string;
    readonly orientation?: string;
    readonly occlusion?: string;
    readonly imageQuality?: string;
  };
  readonly annotationStatus: 'draft' | 'verified';
  /** Chip values for physical photos, used to turn chip piles into amounts. */
  readonly chipConfig?: ChipConfiguration;
  readonly notes?: string;
  /** Only for tests of malformed input: allows duplicate cards. */
  readonly allowMalformed?: boolean;
}

/** An ordered sequence of samples from one hand (or deliberately not), for tracking metrics. */
export interface BenchmarkSequence {
  readonly id: string;
  /** Sample IDs in true chronological order. */
  readonly sampleIds: readonly string[];
  /** For each neighbouring pair: whether both frames really come from the same hand. Defaults to true. */
  readonly sameHand?: readonly boolean[];
  readonly notes?: string;
}

export interface BenchmarkDataset {
  readonly kind: typeof DATASET_KIND;
  readonly schemaVersion: typeof DATASET_SCHEMA_VERSION;
  readonly name: string;
  readonly datasetVersion: string;
  readonly samples: readonly BenchmarkSample[];
  readonly sequences: readonly BenchmarkSequence[];
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Predictions and results
// ---------------------------------------------------------------------------

export type Prediction =
  | {
    readonly kind: 'recognized';
    readonly recognition: ScreenshotRecognition;
    /** For photos: the spatial reading, used for detection metrics. */
    readonly physical?: PhysicalTableObservation;
    readonly latencyMs: number;
    readonly providerId: string;
    readonly modelId: string | null;
    readonly attempts: number;
    readonly raw?: unknown;
  }
  | { readonly kind: 'failed'; readonly reason: string; readonly latencyMs: number; readonly attempts: number; readonly timedOut: boolean }
  | { readonly kind: 'cancelled' };

/** How one card position compares with the truth. */
export type CardOutcomeKind =
  | 'exact' | 'rank_only' | 'suit_only' | 'wrong' | 'missing'
  | 'extra' | 'correct_hidden' | 'hidden_missed' | 'correct_unknown' | 'invented';

export interface CardOutcome {
  /** `board.2` or `seat.1.card.0` in truth numbering; `extra.seat.3.card.1` for predicted seats with no truth. */
  readonly location: string;
  readonly area: 'community' | 'player';
  /** A card code, `face_down`, `unreadable`, or `none`. */
  readonly truth: string;
  /** A card code, `hidden`, `unknown`, or `none`. */
  readonly predicted: string;
  readonly outcome: CardOutcomeKind;
  readonly confidence: ConfidenceLabel | null;
  readonly tags: readonly CardTag[];
}

export interface NumberOutcome {
  readonly field: string;
  readonly truth: number | null;
  readonly predicted: number | null;
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** `null` when the denominator is 0: no meaningful value. */
  readonly value: number | null;
}

export interface NumericSummary {
  /** Both known. */
  readonly compared: number;
  readonly exact: Ratio;
  /** Mean absolute error over compared values; `null` when none were compared. */
  readonly meanAbsoluteError: number | null;
  /** Truth known, prediction unknown. */
  readonly missing: Ratio;
  /** Truth not visible, but a value was predicted. */
  readonly invented: number;
  /** Truth not visible and prediction unknown. */
  readonly correctlyUnknown: number;
}

export interface DetectionResult {
  /** `unsupported` when the prediction has no positions; nothing is invented. */
  readonly localization: 'unsupported' | {
    readonly truthBoxes: number;
    readonly predictedBoxes: number;
    readonly matched: number;
    readonly meanIoU: number | null;
  };
  /** Matched detections whose board/seat grouping matches the truth. */
  readonly grouping: { readonly correct: number; readonly total: number };
}

export interface ErrorEntry {
  readonly category: 'card' | 'missing_card' | 'extra_card' | 'invented' | 'player' | 'dealer' | 'street' | 'pot' | 'stack' | 'bet' | 'invalid_state' | 'recognition_failed' | 'ambiguous';
  readonly location: string;
  readonly expected: string;
  readonly actual: string;
}

export interface SampleResult {
  readonly sampleId: string;
  readonly sourceType: SampleSource;
  readonly tags: readonly DifficultyTag[];
  readonly status: 'evaluated' | 'failed' | 'cancelled';
  readonly latencyMs: number | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly attempts: number;
  readonly timedOut: boolean;
  readonly failure?: string;
  readonly cards: readonly CardOutcome[];
  readonly table: {
    readonly playerCount: { readonly truth: number; readonly predicted: number };
    /** Truth seats found at the same position in the prediction. */
    readonly seatsInPlace: { readonly correct: number; readonly total: number };
    readonly missingPlayers: number;
    readonly extraPlayers: number;
    readonly dealer: 'correct' | 'wrong' | 'missing' | 'invented' | 'n/a';
    readonly hero: 'correct' | 'wrong' | 'missing' | 'invented' | 'n/a';
    readonly street: 'correct' | 'wrong' | 'missing' | 'n/a';
    readonly folded: { readonly correct: number; readonly total: number };
    readonly numbers: readonly NumberOutcome[];
  } | null;
  readonly physical: DetectionResult | null;
  /** Blocking problems in the prediction under the app's own checks. */
  readonly invalidState: boolean;
  readonly ambiguousFields: number;
  readonly warnings: readonly string[];
  readonly errors: readonly ErrorEntry[];
  /** Only when raw output was requested. */
  readonly raw?: unknown;
}
