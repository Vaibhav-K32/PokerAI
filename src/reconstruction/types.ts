// Multi-screenshot hand reconstruction: the data model. A screenshot is an
// observation of one moment. Observations are compared in order, and the
// differences become confirmed facts, unresolved alternatives, or
// contradictions. Nothing here turns a pot change into invented actions.
import type { ConfidenceLabel, FieldSource, ScreenshotRecognition, Street } from '../vision/screenshot.js';
import type { GameState, HandEvent } from '../history/types.js';

export const RECONSTRUCTION_SCHEMA_VERSION = 2;
export const RECONSTRUCTION_KIND = 'poker-study/reconstruction';
/** Default and hard limit on screenshots per reconstruction. */
export const MAX_SCREENSHOTS = 20;

export type ReviewStatus = 'pending' | 'reviewed' | 'corrected';

/** One uploaded screenshot, in the user's chosen order. */
/** Where a frame came from: an uploaded screenshot, or a frame taken from an uploaded video. */
export type FrameSource = 'screenshot' | 'video';

export interface ScreenshotEntry {
  /** Stable for the session; never derived from the filename. */
  readonly id: string;
  /** File name or sample label, for display only. */
  readonly label: string;
  /** Position in the order the files were added. Never changes. */
  readonly uploadIndex: number;
  /** A downscaled JPEG data URL, kept only when the user saves images. */
  readonly image?: string;
  /** Defaults to `screenshot`. */
  readonly source?: FrameSource;
  /** Position in the source video, in milliseconds. Only for video frames. */
  readonly timestampMs?: number;
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
  /** Position in the source video, in milliseconds; `null` for screenshots. Never invented. */
  readonly timestampMs: number | null;
  readonly recognition: ScreenshotRecognition;
  readonly reviewStatus: ReviewStatus;
  readonly source: FrameSource;
}

/** The name the Step 4 brief uses for a recognized frame. */
export type FrameObservation = HandObservation;

// ---------------------------------------------------------------------------
// Player identity across frames
// ---------------------------------------------------------------------------

/** Why a seat was matched to a player. */
export type MatchBasis = 'user' | 'name' | 'hero' | 'position' | 'new' | 'unmatched';

/** One person tracked through the sequence. IDs are stable for a given set of frames and corrections. */
export interface TrackedPlayer {
  readonly id: string;
  /** Latest visible name, or a seat description. */
  readonly label: string;
  readonly firstObservation: string;
}

export interface SeatIdentity {
  readonly seat: number;
  /** `null` when the evidence does not settle who this is. */
  readonly playerId: string | null;
  readonly basis: MatchBasis;
  /** For unmatched seats: players it could be, most plausible first. */
  readonly candidates: readonly string[];
}

export interface FrameIdentity {
  readonly observationId: string;
  readonly seats: readonly SeatIdentity[];
  readonly dealer: string | null;
  readonly hero: string | null;
  /** Players seen in an earlier frame who are not visible here. Not a fold. */
  readonly missing: readonly { readonly playerId: string; readonly acknowledged: boolean }[];
}

export interface IdentityIssue {
  readonly kind: 'ambiguous' | 'conflict' | 'missing';
  readonly observationId: string;
  readonly seat: number | null;
  readonly playerId?: string;
  readonly text: string;
}

export interface IdentityResult {
  readonly players: readonly TrackedPlayer[];
  readonly frames: readonly FrameIdentity[];
  readonly issues: readonly IdentityIssue[];
}

/** The user says seat `seat` of a frame is this player, or `new` for someone not seen before. */
export interface IdentityOverride {
  readonly observationId: string;
  readonly seat: number;
  readonly playerId: string;
}

/** The user confirms a player is in the hand but not visible in this frame. */
export interface HiddenMark {
  readonly observationId: string;
  readonly playerId: string;
}

export interface IdentityInput {
  readonly overrides?: readonly IdentityOverride[];
  readonly hidden?: readonly HiddenMark[];
}

/** How two neighbouring frames line up, player by player. */
export interface SeatPairing {
  readonly pairs: readonly { readonly prev: number; readonly next: number; readonly playerId: string }[];
  /** In the earlier frame, not visible in the later one. */
  readonly gone: readonly { readonly seat: number; readonly playerId: string; readonly acknowledged: boolean }[];
  /** In the later frame but not the earlier one; `firstSeen` when never seen before. */
  readonly arrived: readonly { readonly seat: number; readonly playerId: string; readonly firstSeen: boolean }[];
  /** Later-frame seats nobody could be matched to. */
  readonly unmatched: readonly number[];
  readonly dealer: readonly [string | null, string | null];
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
  | 'value-visible' | 'value-hidden'
  | 'all-in' | 'player-hidden' | 'player-visible' | 'player-appeared' | 'player-unmatched';

/** How the evidence for a difference was obtained, from the weaker side. */
/**
 * Evidence levels. Observed: read from a frame. Inferred: a rule-consistent
 * reading that is not uniquely established. Confirmed: set or verified by the user.
 */
export type Evidence = 'observed' | 'inferred' | 'confirmed';

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
  /** The tracked player this is about, when it is about one. */
  readonly playerId?: string;
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
  /** Observed changes the user verified, by `differenceKey`. */
  readonly confirmedChanges?: readonly string[];
}

// ---------------------------------------------------------------------------
// Reconstruction output
// ---------------------------------------------------------------------------

export interface ConfirmedFact {
  /** `observed` from the frames, or `confirmed` by the user. */
  readonly evidence?: 'observed' | 'confirmed';
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

export type Consistency = 'consistent' | 'consistent-missing' | 'ambiguous' | 'contradictory' | 'split';

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
  /** Can these two frames belong to one hand, and how completely is the change known? */
  readonly consistency: Consistency;
  readonly consistencyReasons: readonly string[];
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
  readonly identity: IdentityResult;
  /** Observation IDs per hand, split where the user marked different hands. */
  readonly hands: readonly (readonly string[])[];
}

export interface ReconstructionOptions {
  readonly resolutions?: readonly IntervalResolution[];
  /** Number of screenshots, including ones not recognized yet. */
  readonly screenshotCount?: number;
  readonly identity?: IdentityInput;
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
  /** `screenshots`, `video`, or `mixed`, from the frames' sources. */
  readonly sourceType: 'screenshots' | 'video' | 'mixed';
  /** Player matches and visibility the user set. */
  readonly identity: { readonly overrides: readonly IdentityOverride[]; readonly hidden: readonly HiddenMark[] };
  /** Per-interval results at save time, for reading the file elsewhere. Recomputed on open. */
  readonly validation: readonly { readonly from: string; readonly to: string; readonly status: IntervalStatus; readonly consistency: Consistency }[];
}
