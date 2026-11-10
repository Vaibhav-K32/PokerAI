import { combinations } from './cards.js';
import type {
  Action, BetAdvice, BetOption, Card, OpponentStyle, Ruleset, Snapshot,
} from './types.js';

/**
 * Bet sizing under an explicit opponent response model.
 *
 * The opponent holds any unseen hand. They cannot see the hero's cards, so
 * they judge each holding by its showdown equity against a random hand on
 * this board. Facing a bet, they call with their strongest holdings and fold
 * the rest. A balanced opponent defends just enough that a pure bluff breaks
 * even (minimum defense frequency); the other styles fold less or more.
 * After the hero's action the hand is assumed to go to showdown with no
 * further betting, and the opponent never re-raises.
 */

const STYLE_FOLD_SCALE: Record<OpponentStyle, number> = { loose: 0.5, balanced: 1, tight: 1.6 };
const MAX_FOLD = 0.95;
/** Share of the pot a style mismatch must cost before the advice is flagged. */
const SENSITIVE_SHARE = 0.02;
/** Bet sizes as a fraction of the pot after calling, before clamping to legal limits. */
const POT_FRACTIONS = [1 / 3, 1 / 2, 2 / 3, 1, 1.5];
const EXACT_RUNOUTS = 50;
const SAMPLED_RUNOUTS = 80;
const STRENGTH_SAMPLES = 60;
const CATEGORY_BASE = 16 ** 5;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

function draw<T>(pool: T[], count: number, random: () => number): T[] {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function scorer(rules: Ruleset): (hole: readonly Card[], board: readonly Card[]) => number {
  if (rules.score) return rules.score.bind(rules);
  return (hole, board) => {
    const rank = rules.rank(hole, board);
    if (!rank) throw new Error('Ruleset did not produce a hand rank.');
    let value = 0;
    for (let i = 0; i < 6; i++) value = value * 16 + (rank.value[i] ?? 0);
    return value;
  };
}

interface Holding {
  cards: readonly Card[];
  /** Hero showdown share against this holding (win + tie / 2). */
  heroEquity: number;
  /** This holding's equity against a random hand, as the opponent sees it. */
  strength: number;
}

/** Score every opponent holding for hero equity and perceived strength. */
function holdings(s: Snapshot, rules: Ruleset): Holding[] {
  const evaluate = scorer(rules);
  const random = seededRandom(20263);
  const toCome = rules.showdownBoardCount - s.board.length;
  const known = new Set([...s.hero, ...s.board]);
  const unseen = rules.deck.filter(card => !known.has(card));
  const share = (a: number, b: number) => (a > b ? 1 : a === b ? 0.5 : 0);

  const result: Holding[] = [];
  for (const cards of combinations(unseen, rules.holeCount)) {
    const rest = unseen.filter(card => !cards.includes(card));

    // Hero equity against this holding: exact when few runouts remain.
    let heroTotal = 0;
    let heroCount = 0;
    const runoutCount = toCome === 0 ? 1 : toCome === 1 ? rest.length : SAMPLED_RUNOUTS;
    const exact = toCome <= 1 && runoutCount <= EXACT_RUNOUTS;
    const runouts: Iterable<readonly Card[]> = toCome === 0
      ? [[]]
      : exact ? combinations(rest, toCome)
        : Array.from({ length: SAMPLED_RUNOUTS }, () => draw([...rest], toCome, random));
    for (const runout of runouts) {
      const board = [...s.board, ...runout];
      heroTotal += share(evaluate(s.hero, board), evaluate(cards, board));
      heroCount++;
    }

    // Perceived strength: this holding against a random hand and runout.
    let strengthTotal = 0;
    for (let i = 0; i < STRENGTH_SAMPLES; i++) {
      const picked = draw([...rest], rules.holeCount + toCome, random);
      const villain = picked.slice(0, rules.holeCount);
      const board = [...s.board, ...picked.slice(rules.holeCount)];
      strengthTotal += share(evaluate(cards, board), evaluate(villain, board));
    }
    // Break ties in perceived strength by made-hand score so the order is stable.
    const tiebreak = evaluate(cards, s.board.length ? s.board : []) / (CATEGORY_BASE * 16 * 1e6);
    result.push({ cards, heroEquity: heroTotal / heroCount, strength: strengthTotal / STRENGTH_SAMPLES + tiebreak });
  }
  return result.sort((a, b) => b.strength - a.strength);
}

/**
 * Opponent fold frequency facing `toCall` chips with `potAfterBet` in the
 * middle. A balanced opponent folds toCall / potAfterBet, the minimum-defense
 * rate at which a pure bluff of that size exactly breaks even.
 */
export function foldFrequency(toCall: number, potAfterBet: number, style: OpponentStyle): number {
  if (potAfterBet <= 0) return 0;
  return Math.min(MAX_FOLD, Math.max(0, (toCall / potAfterBet) * STYLE_FOLD_SCALE[style]));
}

/**
 * Split the strength-ordered range into callers and folders. The defending
 * share is filled from the strongest holding down, with a fractional holding
 * at the boundary so results move smoothly with bet size.
 */
function callers(range: readonly Holding[], defend: number) {
  let remaining = defend * range.length;
  let weight = 0;
  let equity = 0;
  for (const holding of range) {
    if (remaining <= 0) break;
    const w = Math.min(1, remaining);
    weight += w;
    equity += w * holding.heroEquity;
    remaining -= w;
  }
  return { share: weight / range.length, heroEquity: weight ? equity / weight : 0 };
}

function candidateTotals(s: Snapshot, minTo: number, maxTo: number): number[] {
  const wager = s.committed + s.faced;
  const totals = new Set<number>([minTo, maxTo]);
  for (const fraction of POT_FRACTIONS) {
    const to = Math.round(wager + fraction * (s.pot + s.faced));
    if (to >= minTo && to <= maxTo) totals.add(to);
  }
  return [...totals].sort((a, b) => a - b);
}

export function betAdvice(s: Snapshot, rules: Ruleset): BetAdvice | null {
  const aggressive = rules.legalActions(s).find(
    (a): a is Extract<Action, { kind: 'bet' | 'raise' }> => a.kind === 'bet' || a.kind === 'raise',
  );
  const range = holdings(s, rules);
  const knownOpponent = s.opponent.length === rules.holeCount;
  const knownRank = knownOpponent
    ? range.findIndex(h => h.cards.every(card => s.opponent.includes(card)))
    : -1;
  const knownHolding = knownRank >= 0 ? range[knownRank] : null;
  const everyone = callers(range, 1);
  const heroEquity = knownHolding ? knownHolding.heroEquity : everyone.heroEquity;

  const baseline: BetOption[] = [];
  if (s.faced === 0) {
    baseline.push({ kind: 'check', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: heroEquity, ev: heroEquity * s.pot });
  } else {
    const cost = Math.min(s.faced, s.heroStack);
    const finalPot = s.pot - (s.faced - cost) + cost;
    baseline.push({ kind: 'fold', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: 0, ev: 0 });
    baseline.push({ kind: 'call', to: s.committed + cost, put: cost, foldChance: 0, equityWhenCalled: heroEquity, ev: heroEquity * finalPot - cost });
  }

  // Chips beyond what the opponent can call come straight back, so cap sizes there.
  const coverTo = s.committed + s.faced + s.opponentStack;
  const totals = aggressive
    ? candidateTotals(s, Math.min(aggressive.minTo, coverTo), Math.min(aggressive.maxTo, coverTo)) : [];

  const optionsFor = (style: OpponentStyle): BetOption[] => [
    ...baseline,
    ...totals.map(to => {
      const put = to - s.committed;
      const opponentCommitted = s.committed + s.faced;
      const asked = to - opponentCommitted;
      const toCall = Math.min(asked, s.opponentStack);
      const refunded = asked - toCall;
      const heroIn = put - refunded;
      const potIfFold = s.pot + put;
      const fold = foldFrequency(toCall, s.pot + heroIn, style);
      let foldChance: number;
      let equityWhenCalled: number;
      if (knownHolding) {
        // The known hand calls when it ranks inside the defending share.
        const calls = knownRank < (1 - fold) * range.length;
        foldChance = calls ? 0 : 1;
        equityWhenCalled = knownHolding.heroEquity;
      } else {
        const defenders = callers(range, 1 - fold);
        foldChance = 1 - defenders.share;
        equityWhenCalled = defenders.heroEquity;
      }
      const showdownPot = s.pot + heroIn + toCall;
      // Fold: the hero takes back everything in the pot, including this bet.
      const ev = foldChance * (potIfFold - put) + (1 - foldChance) * (equityWhenCalled * showdownPot - heroIn);
      return {
        kind: s.committed + s.faced > 0 ? 'raise' : 'bet',
        to, put, foldChance, equityWhenCalled, ev,
        allIn: put === s.heroStack,
        coversOpponent: toCall === s.opponentStack,
      } satisfies BetOption;
    }),
  ];

  const styles: OpponentStyle[] = ['loose', 'balanced', 'tight'];
  const choose = (style: OpponentStyle) => {
    const options = optionsFor(style);
    let best = 0;
    options.forEach((option, i) => { if (option.ev > options[best].ev + 1e-9) best = i; });
    return { options, best };
  };
  const byStyle: BetAdvice['byStyle'] = { loose: choose('loose'), balanced: choose('balanced'), tight: choose('tight') };
  // Sensitive when playing one style's best action against another style
  // gives up more than 2% of the pot compared with that style's own best.
  const sensitive = styles.some(actual => styles.some(assumed => {
    const own = byStyle[actual];
    const pick = byStyle[assumed].options[byStyle[assumed].best];
    const same = own.options.find(o => o.kind === pick.kind && o.to === pick.to);
    return !same || own.options[own.best].ev - same.ev > SENSITIVE_SHARE * s.pot;
  }));
  return {
    byStyle,
    sensitive,
    opponent: knownHolding ? 'known' : 'random',
    holdings: range.length,
    streetsLeft: rules.showdownBoardCount - s.board.length,
  };
}
