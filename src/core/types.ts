export type Card = string;

/** An opponent still in the hand. */
export interface Seat {
  /** Chips behind. Zero means all-in on this street. */
  stack: number;
  /** Chips committed on the current street. */
  committed: number;
  /** Two known cards, or empty when unknown. */
  cards: readonly Card[];
  /**
   * For a player all-in on an earlier street (no stack, nothing committed
   * this street): how much of the pot from earlier streets they can win.
   * Omit it when they can win all of it.
   */
  eligiblePot?: number;
}

export interface Snapshot {
  version: 2;
  ruleset: string;
  purpose: 'simulation' | 'completed';
  hero: readonly Card[];
  board: readonly Card[];
  /** One to three opponents still in the hand. Folded players are not seated. */
  opponents: readonly Seat[];
  /** Everything in the middle, including current-street bets and dead money. */
  pot: number;
  heroStack: number;
  /** Hero chips committed on the current street. */
  committed: number;
  /** Minimum opening bet or last full raise increment. */
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
  /** Win plus split shares of ties (half heads-up, a third three ways, ...). */
  share: number;
  interval: readonly [number, number];
  /**
   * When facing a wager: expected chips collected from the main and side pots
   * after calling, with every opponent staying at their current commitment.
   */
  callWinnings?: number;
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
  /** Pot share: win plus split shares of ties. */
  share: number;
  /** Opponent hands that win, as a share of the matchups for this row. */
  beatenBy: readonly { name: string; chance: number }[];
}

export interface OpponentOutlook {
  /** 'known' only when every opponent's cards are known. */
  model: 'known' | 'random';
  method: 'exact' | 'sampled';
  /** Opponents in the hand. With several, rows describe the strongest one. */
  players: number;
  matchups: number;
  /** Combined opponent showdown equity, including split shares of ties. */
  equity: number;
  /** Chance some opponent finishes ahead of the hero. */
  beatsYou: number;
  /** Final categories of the strongest opponent hand: how often, and how often it wins. */
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
  /** Opponents in the hand. */
  players: number;
  /** Heads-up uses exact range weights; several opponents use sampled deals. */
  method: 'exact' | 'sampled';
  /** Opponent holdings in the modeled range. */
  holdings: number;
  /** Board cards still to come; the model assumes no betting on them. */
  streetsLeft: number;
  /** When facing a wager: what a call costs and the most it can win. */
  callPrice?: {
    cost: number;
    /** Pot the call can win, excluding chips above the hero's total. */
    winnablePot: number;
    /** Break-even pot share: cost ÷ winnable pot. */
    needEquity: number;
  };
}

export interface FoldReason {
  cost: number;
  winnablePot: number;
  needEquity: number;
  /** Pot share a call actually wins, side pots included. */
  haveEquity: number;
  /** Chips a call loses on average. */
  callLoss: number;
  /** The least costly raise, if any raise is legal. */
  bestRaise: BetOption | null;
  /** Opponent styles against which folding is not best, with their best action. */
  otherStyles: readonly { style: OpponentStyle; option: BetOption }[];
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
