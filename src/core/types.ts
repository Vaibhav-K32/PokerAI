export type Card = string;

export interface Snapshot {
  version: 1;
  ruleset: string;
  purpose: 'simulation' | 'completed';
  hero: readonly Card[];
  board: readonly Card[];
  opponent: readonly Card[]; // Empty means an unknown hand.
  pot: number;
  heroStack: number;
  opponentStack: number;
  committed: number;
  faced: number;
  increment: number;
}

export interface HandRank {
  name: string;
  value: readonly number[];
  cards: readonly Card[];
}

export type Action =
  | { kind: 'check' | 'fold' }
  | { kind: 'call'; cost: number }
  | { kind: 'bet' | 'raise'; minTo: number; maxTo: number; short: boolean };

export interface Equity {
  method: 'exact' | 'sampled';
  trials: number;
  win: number;
  tie: number;
  loss: number;
  share: number;
  interval: readonly [number, number];
}

export interface OutlookRow {
  /** Ruleset category index; higher is stronger. */
  category: number;
  name: string;
  /** Probability the hero's final hand is exactly this category. */
  byRiver: number;
  /** True when the category beats the current hand (always true preflop). */
  improves: boolean;
  /** Unseen cards that make exactly this category on the next card. Absent preflop. */
  nextCard?: { outs: readonly Card[]; chance: number };
  /** Showdown result against the opponent when the hero finishes with this category. */
  matchup?: Matchup;
  /** byRiver × (win + tie / 2): this hand's part of the hero's showdown equity. */
  equityShare: number;
}

export interface Matchup {
  /** Conditional on the hero finishing with the row's category. */
  win: number;
  tie: number;
  loss: number;
  /** Opponent hands that win, as a share of the matchups for this row. */
  beatenBy: readonly { name: string; chance: number }[];
}

export interface OpponentOutlook {
  model: 'known' | 'random';
  method: 'exact' | 'sampled';
  matchups: number;
  /** Opponent showdown equity, including half of ties. */
  equity: number;
  /** Chance the opponent finishes ahead of the hero. */
  beatsYou: number;
  /** Opponent final categories: how often they make it, and make it and win. */
  rows: readonly { category: number; name: string; chance: number; beatsYou: number }[];
}

export interface SuggestedHand {
  name: string;
  byRiver: number;
  /** Win plus half of ties when the hero finishes with this hand. */
  winWhenMade: number;
}

export interface Suggestion {
  /** Improving hands that carry the most showdown equity, strongest share first. */
  playFor: readonly (SuggestedHand & { equityShare: number })[];
  /** Hands made at least 10% of the time that win less than half the time. */
  caution: readonly SuggestedHand[];
  /** The current hand, when it is already likely to hold up. */
  holding: SuggestedHand | null;
  yourEquity: number;
}

export interface Outlook {
  /** The hero's current hand category, or null before the flop. */
  current: { category: number; name: string } | null;
  method: 'exact' | 'sampled';
  runouts: number;
  unseen: number;
  cardsToCome: number;
  /** Chance of finishing with a better category than now, or null preflop. */
  improveByRiver: number | null;
  rows: readonly OutlookRow[];
  opponent: OpponentOutlook;
  /** Hero showdown equity from these matchups (sums each row's equityShare). */
  yourEquity: number;
  suggestion: Suggestion;
}

/** How the modeled opponent responds to a bet: folds less, at the balanced rate, or more. */
export type OpponentStyle = 'loose' | 'balanced' | 'tight';

export interface BetOption {
  kind: 'check' | 'fold' | 'call' | 'bet' | 'raise';
  /** Total street commitment after the action. */
  to: number;
  /** Chips the hero adds now. */
  put: number;
  /** Modeled chance the opponent folds to this action. */
  foldChance: number;
  /** Hero showdown share against the hands that continue. */
  equityWhenCalled: number;
  /** Expected chips the hero gains from here, assuming no later betting. Fold is 0. */
  ev: number;
  /** The hero commits every remaining chip. */
  allIn?: boolean;
  /** The opponent must call all of their remaining chips. */
  coversOpponent?: boolean;
}

export interface BetAdvice {
  byStyle: Record<OpponentStyle, { options: readonly BetOption[]; best: number }>;
  /** True when using one style's best action against another costs over 2% of the pot. */
  sensitive: boolean;
  opponent: 'known' | 'random';
  /** Opponent holdings in the modeled range. */
  holdings: number;
  /** Board cards still to come; the model assumes no betting on them. */
  streetsLeft: number;
}

export interface StudyNote {
  title: string;
  detail: string;
  threshold?: number;
  callValue?: number;
}

export interface Ruleset {
  readonly id: string;
  readonly deck: readonly Card[];
  readonly holeCount: number;
  readonly showdownBoardCount: number;
  /** Hand category names, weakest first; a rank value starts with the index. */
  readonly categories: readonly string[];
  validate(snapshot: Snapshot): void;
  rank(hole: readonly Card[], board: readonly Card[]): HandRank | null;
  /**
   * Optional fast showdown score: larger wins, equal splits, and
   * `Math.floor(score / 16 ** 5)` is the category index.
   */
  score?(hole: readonly Card[], board: readonly Card[]): number;
  legalActions(snapshot: Snapshot): Action[];
  study(snapshot: Snapshot, equity: Equity): StudyNote;
}
