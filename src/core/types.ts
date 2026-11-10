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
  validate(snapshot: Snapshot): void;
  rank(hole: readonly Card[], board: readonly Card[]): HandRank | null;
  legalActions(snapshot: Snapshot): Action[];
  study(snapshot: Snapshot, equity: Equity): StudyNote;
}
