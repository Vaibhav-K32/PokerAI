// Multi-screenshot hand reconstruction: the data model. A screenshot is an
// observation of one moment. Observations are compared in order, and the
// differences become confirmed facts, unresolved alternatives, or
// contradictions. Nothing here turns a pot change into invented actions.
import type { ConfidenceLabel, FieldSource, ScreenshotRecognition, Street } from '../vision/screenshot.js';
import type { GameState, HandEvent } from '../history/types.js';

export const RECONSTRUCTION_SCHEMA_VERSION = 1;
export const RECONSTRUCTION_KIND = 'poker-study/reconstruction';
/** Default and hard limit on screenshots per reconstruction. */
export const MAX_SCREENSHOTS = 20;

export type ReviewStatus = 'pending' | 'reviewed' | 'corrected';

/** One uploaded screenshot, in the user's chosen order. */
export interface ScreenshotEntry {
  /** Stable for the session; never derived from the filename. */
  readonly id: string;
  /** File name or sample label, for display only. */
  readonly label: string;
  /** Position in the order the files were added. Never changes. */
  readonly uploadIndex: number;
  /** A downscaled JPEG data URL, kept only when the user saves images. */
  readonly image?: string;
}

/**
 * A recognized screenshot. `recognition` holds every field with its value
 * (`null` = unknown), the reader's confidence label, and its source
 * (observed, inferred, or corrected by the user).
 */
export interface HandObservation {
  readonly id: string;
  readonly screenshotId: string;
  /** Position in the reconstruction's chronological order, from 0. */
  readonly sequenceIndex: number;
  /** Only when the user enters one; never taken from file times. */
  readonly timestamp: string | null;
  readonly recognition: ScreenshotRecognition;
  readonly reviewStatus: ReviewStatus;
  readonly source: 'screenshot';
}

// ---------------------------------------------------------------------------
// Differences between consecutive observations
// ---------------------------------------------------------------------------

export type DifferenceKind =
  | 'board-dealt' | 'board-card-changed' | 'board-shrank' | 'board-card-visible' | 'board-card-hidden'
  | 'stack-changed' | 'bet-changed' | 'status-changed' | 'unfolded'
  | 'hole-cards-visible' | 'hole-card-changed' | 'hole-cards-hidden'
  | 'name-changed' | 'seats-moved' | 'seat-count-changed'
  | 'pot-changed' | 'street-changed' | 'street-reversed' | 'dealer-moved' | 'blinds-changed'
  | 'value-visible' | 'value-hidden';

/** How the evidence for a difference was obtained, from the weaker side. */
export type Evidence = 'observed' | 'inferred' | 'corrected';

export interface StateDifference {
  readonly kind: DifferenceKind;
  /** Field path in the earlier observation's seat numbering, such as `players.1.stack` or `board.3`. */
  readonly field: string;
  /** Plain-language description. */
  readonly label: string;
  readonly previous: unknown;
  readonly next: unknown;
  readonly fromObservation: string;
  readonly toObservation: string;
  readonly evidence: Evidence;
  readonly confidence: { readonly previous: ConfidenceLabel | null; readonly next: ConfidenceLabel | null };
  /** `contradiction` cannot happen within one hand; `review` is possible but unusual. */
  readonly severity: 'info' | 'review' | 'contradiction';
  readonly warning?: string;
}

// ---------------------------------------------------------------------------
// User resolutions of intervals
// ---------------------------------------------------------------------------

export type ManualActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';

/** A known action the user entered for an interval. */
export interface ManualAction {
  readonly id: string;
  /** Seat index in the interval's earlier observation. */
  readonly seat: number;
  readonly type: ManualActionType;
  /** Bet or raise: the street total after the action. Ignored otherwise. */
  readonly to?: number;
  /** When the user entered it. */
  readonly confirmedAt: string;
}

export interface IntervalResolution {
  /** Earlier and later observation IDs. */
  readonly from: string;
  readonly to: string;
  /** `unresolved`: the user accepts that the actions are unknown. `different-hands`: the screenshots are not one hand. */
  readonly mark: 'none' | 'unresolved' | 'different-hands';
  readonly actions: readonly ManualAction[];
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Reconstruction output
// ---------------------------------------------------------------------------

export interface ConfirmedFact {
  readonly observationId: string;
  readonly text: string;
}

/** A plausible explanation that is not uniquely determined. */
export interface PossibleTransition {
  readonly text: string;
  /** Alternatives, none of which is treated as fact. */
  readonly alternatives: readonly string[];
}

export interface Contradiction {
  readonly observationIds: readonly string[];
  readonly field: string;
  readonly text: string;
}

export type IntervalStatus = 'unchanged' | 'verified' | 'unresolved' | 'acknowledged' | 'resolved' | 'partial' | 'contradiction' | 'different-hands';

export interface ActionCheck {
  /** Executable events, only when every action was valid. */
  readonly events: readonly HandEvent[];
  /** States from the earlier checkpoint through each valid action. */
  readonly states: readonly GameState[];
  /** The first invalid action and why, if any. */
  readonly error: { readonly actionId: string; readonly message: string } | null;
  /** Chip movement still unexplained after the confirmed actions, by seat label. */
  readonly unexplained: readonly string[];
  /** True when the actions account for every known stack, status, and the pot. */
  readonly explains: boolean;
}

export interface Interval {
  readonly from: string;
  readonly to: string;
  readonly fromIndex: number;
  readonly differences: readonly StateDifference[];
  readonly confirmed: readonly ConfirmedFact[];
  readonly possible: readonly PossibleTransition[];
  readonly contradictions: readonly Contradiction[];
  /** Growth in chips in the middle (pot plus bets), when both sides are known. */
  readonly middleChange: number | null;
  /** Reasons the two screenshots may come from different hands. */
  readonly differentHandSigns: readonly string[];
  readonly resolution: IntervalResolution | null;
  readonly actionCheck: ActionCheck | null;
  readonly status: IntervalStatus;
  /** One-line summary for the timeline. */
  readonly summary: string;
}

export interface Checkpoint {
  readonly observationId: string;
  readonly screenshotId: string;
  readonly index: number;
  readonly street: Street | null;
  readonly streetSource: FieldSource;
  readonly board: readonly (string | null)[];
  readonly pot: number | null;
  readonly stacks: readonly { readonly label: string; readonly stack: number | null; readonly folded: boolean | null }[];
  readonly confirmed: readonly ConfirmedFact[];
  /** Problems found inside this one screenshot. */
  readonly contradictions: readonly Contradiction[];
  readonly reviewCount: number;
  readonly reviewStatus: ReviewStatus;
}

export type TimelineEntry =
  | { readonly kind: 'checkpoint'; readonly checkpoint: Checkpoint }
  | { readonly kind: 'interval'; readonly interval: Interval };

export interface ReconstructionMetrics {
  readonly screenshots: number;
  readonly checkpoints: number;
  readonly correctedFields: number;
  readonly verifiedTransitions: number;
  readonly unresolvedIntervals: number;
  readonly contradictions: number;
  readonly pendingReview: number;
}

export interface ReconstructionResult {
  readonly checkpoints: readonly Checkpoint[];
  readonly intervals: readonly Interval[];
  readonly timeline: readonly TimelineEntry[];
  /** Contradictions that span the whole sequence, such as one card in two places. */
  readonly globalContradictions: readonly Contradiction[];
  readonly warnings: readonly string[];
  readonly metrics: ReconstructionMetrics;
}

export interface ReconstructionOptions {
  readonly resolutions?: readonly IntervalResolution[];
  /** Number of screenshots, including ones not recognized yet. */
  readonly screenshotCount?: number;
}

// ---------------------------------------------------------------------------
// Saved sessions
// ---------------------------------------------------------------------------

export interface ReconstructionSession {
  readonly kind: typeof RECONSTRUCTION_KIND;
  readonly schemaVersion: typeof RECONSTRUCTION_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** In chronological order. */
  readonly screenshots: readonly ScreenshotEntry[];
  readonly observations: readonly HandObservation[];
  readonly resolutions: readonly IntervalResolution[];
  /** Warnings at save time, for reading the file elsewhere. Recomputed on open. */
  readonly warnings: readonly string[];
  /** True when the screenshot images were saved too. */
  readonly imagesSaved: boolean;
}
