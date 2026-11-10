import { combinations } from './cards.js';
import { deadMoney, draw, faced, heroPayout, knownCards, potCaps, scorer, seededRandom, wager } from './table.js';
import type {
  Action, BetAdvice, BetOption, Card, FoldReason, OpponentStyle, Ruleset, Snapshot,
} from './types.js';

/**
 * Bet sizing under an explicit opponent response model.
 *
 * Each opponent may hold any unseen hand. They cannot see the hero's cards,
 * so they judge each holding by its showdown equity against a random hand on
 * this board. Facing a bet, an opponent calls with their strongest holdings
 * and folds the rest. A balanced table defends just enough that a pure bluff
 * breaks even: heads-up the opponent folds at the minimum-defense rate; with
 * several opponents deciding, each folds at the k-th root of that rate so that
 * everyone folds together exactly that often. The other styles fold less or
 * more. After the hero's action the hand goes to showdown with no further
 * betting, nobody re-raises, and players who still had to act on an earlier
 * bet keep their current commitment.
 *
 * Heads-up uses exact range weights. With several opponents, deals are
 * sampled and the pot is paid out through main and side pots.
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
const MULTIWAY_TRIALS = 8000;
const CATEGORY_BASE = 16 ** 5;
const STYLES: readonly OpponentStyle[] = ['loose', 'balanced', 'tight'];

interface Holding {
  cards: readonly Card[];
  /** Hero showdown share against this holding (heads-up only). */
  heroEquity: number;
  /** This holding's equity against a random hand, as an opponent sees it. */
  strength: number;
}

const handKey = (cards: readonly Card[]) => [...cards].sort().join('');

/**
 * The opponent range, strongest first: every holding that avoids the hero's
 * cards and the board. Heads-up also scores the hero's equity against each.
 */
function holdings(s: Snapshot, rules: Ruleset, withHeroEquity: boolean): Holding[] {
  const evaluate = scorer(rules);
  const random = seededRandom(20263);
  const toCome = rules.showdownBoardCount - s.board.length;
  const known = new Set([...s.hero, ...s.board]);
  const unseen = rules.deck.filter(card => !known.has(card));
  const share = (a: number, b: number) => (a > b ? 1 : a === b ? 0.5 : 0);

  const result: Holding[] = [];
  for (const cards of combinations(unseen, rules.holeCount)) {
    const rest = unseen.filter(card => !cards.includes(card));

    let heroEquity = 0;
    if (withHeroEquity) {
      // Hero equity against this holding: exact when few runouts remain.
      let total = 0;
      let count = 0;
      const runoutCount = toCome === 0 ? 1 : toCome === 1 ? rest.length : SAMPLED_RUNOUTS;
      const exact = toCome <= 1 && runoutCount <= EXACT_RUNOUTS;
      const runouts: Iterable<readonly Card[]> = toCome === 0
        ? [[]]
        : exact ? combinations(rest, toCome)
          : Array.from({ length: SAMPLED_RUNOUTS }, () => draw([...rest], toCome, random));
      for (const runout of runouts) {
        const board = [...s.board, ...runout];
        total += share(evaluate(s.hero, board), evaluate(cards, board));
        count++;
      }
      heroEquity = total / count;
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
    const tiebreak = evaluate(cards, s.board) / (CATEGORY_BASE * 16 * 1e6);
    result.push({ cards, heroEquity, strength: strengthTotal / STRENGTH_SAMPLES + tiebreak });
  }
  return result.sort((a, b) => b.strength - a.strength);
}

/**
 * Opponent fold frequency facing `toCall` chips with `potAfterBet` in the
 * middle. A balanced opponent folds toCall / potAfterBet, the minimum-defense
 * rate at which a pure bluff of that size exactly breaks even. With
 * `deciding` opponents, each folds at the root that makes all of them fold
 * together at that rate.
 */
export function foldFrequency(toCall: number, potAfterBet: number, style: OpponentStyle, deciding = 1): number {
  if (potAfterBet <= 0) return 0;
  const balanced = Math.min(1, toCall / potAfterBet) ** (1 / Math.max(1, deciding));
  return Math.min(MAX_FOLD, Math.max(0, balanced * STYLE_FOLD_SCALE[style]));
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
  const toCall = faced(s);
  const totals = new Set<number>([minTo, maxTo]);
  for (const fraction of POT_FRACTIONS) {
    const to = Math.round(wager(s) + fraction * (s.pot + toCall));
    if (to >= minTo && to <= maxTo) totals.add(to);
  }
  return [...totals].sort((a, b) => a - b);
}

type Options = (style: OpponentStyle) => BetOption[];

/** Heads-up: exact weights over the opponent's strength-ordered range. */
function headsUp(s: Snapshot, range: readonly Holding[], totals: readonly number[]): Options {
  const opponent = s.opponents[0];
  const toCall = faced(s);
  const knownRank = opponent.cards.length
    ? range.findIndex(h => h.cards.every(card => opponent.cards.includes(card)))
    : -1;
  const knownHolding = knownRank >= 0 ? range[knownRank] : null;
  const heroEquity = knownHolding ? knownHolding.heroEquity : callers(range, 1).heroEquity;

  const baseline: BetOption[] = [];
  if (toCall === 0) {
    baseline.push({ kind: 'check', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: heroEquity, ev: heroEquity * s.pot });
  } else {
    const cost = Math.min(toCall, s.heroStack);
    const finalPot = s.pot - (toCall - cost) + cost;
    baseline.push({ kind: 'fold', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: 0, ev: 0 });
    baseline.push({ kind: 'call', to: s.committed + cost, put: cost, foldChance: 0, equityWhenCalled: heroEquity, ev: heroEquity * finalPot - cost });
  }

  return style => [
    ...baseline,
    ...totals.map(to => {
      const put = to - s.committed;
      const asked = to - opponent.committed;
      const opponentCall = Math.min(asked, opponent.stack);
      const refunded = asked - opponentCall;
      const heroIn = put - refunded;
      const fold = foldFrequency(opponentCall, s.pot + heroIn, style);
      let foldChance: number;
      let equityWhenCalled: number;
      if (knownHolding) {
        // The known hand calls when it ranks inside the defending share.
        foldChance = knownRank < (1 - fold) * range.length ? 0 : 1;
        equityWhenCalled = knownHolding.heroEquity;
      } else {
        const defenders = callers(range, 1 - fold);
        foldChance = 1 - defenders.share;
        equityWhenCalled = defenders.heroEquity;
      }
      const showdownPot = s.pot + heroIn + opponentCall;
      // On a fold the hero collects the pot and their own bet back.
      const ev = foldChance * s.pot + (1 - foldChance) * (equityWhenCalled * showdownPot - heroIn);
      return {
        kind: wager(s) > 0 ? 'raise' : 'bet',
        to, put, foldChance, equityWhenCalled, ev,
        allIn: put === s.heroStack,
        coversOpponent: opponentCall === opponent.stack,
      } satisfies BetOption;
    }),
  ];
}

/** Several opponents: sampled deals, each opponent responding on their own. */
function multiway(s: Snapshot, rules: Ruleset, range: readonly Holding[], totals: readonly number[]): Options {
  const evaluate = scorer(rules);
  const random = seededRandom(20264);
  const toCome = rules.showdownBoardCount - s.board.length;
  const used = new Set(knownCards(s));
  const unseen = rules.deck.filter(card => !used.has(card));
  const unknownSeats = s.opponents.flatMap((o, i) => (o.cards.length ? [] : [i]));
  const rankOf = new Map(range.map((h, i) => [handKey(h.cards), i / range.length]));
  const base = deadMoney(s);
  const caps = potCaps(s);
  const toCall = faced(s);
  const n = s.opponents.length;

  // Common deals for every option keep comparisons between sizes steady.
  const heroScores: number[] = [];
  const opponentScores: number[][] = [];
  const percentiles: number[][] = [];
  for (let t = 0; t < MULTIWAY_TRIALS; t++) {
    const cards = draw([...unseen], unknownSeats.length * rules.holeCount + toCome, random);
    const board = [...s.board, ...cards.slice(unknownSeats.length * rules.holeCount)];
    let next = 0;
    const hands = s.opponents.map(o => (o.cards.length ? o.cards : cards.slice(next * rules.holeCount, ++next * rules.holeCount)));
    heroScores.push(evaluate(s.hero, board));
    opponentScores.push(hands.map(hand => evaluate(hand, board)));
    percentiles.push(hands.map(hand => rankOf.get(handKey(hand)) ?? 1));
  }

  /** Average over deals; `live[i]` says whether opponent i stays in. */
  const evaluateAction = (heroIn: number, contributions: (t: number) => { live: boolean[]; chips: number[] }) => {
    let payout = 0;
    let folds = 0;
    let shareTotal = 0;
    let showdowns = 0;
    for (let t = 0; t < MULTIWAY_TRIALS; t++) {
      const { live, chips } = contributions(t);
      const scores = [heroScores[t], ...opponentScores[t].map((v, i) => (live[i] ? v : null))];
      payout += heroPayout(scores, [heroIn, ...chips], base, caps);
      if (!live.some(Boolean)) {
        folds++;
        continue;
      }
      showdowns++;
      const others = opponentScores[t].filter((_, i) => live[i]);
      const best = Math.max(...others);
      if (heroScores[t] > best) shareTotal += 1;
      else if (heroScores[t] === best) shareTotal += 1 / (others.filter(v => v === best).length + 1);
    }
    return {
      ev: payout / MULTIWAY_TRIALS,
      foldChance: folds / MULTIWAY_TRIALS,
      equityWhenCalled: showdowns ? shareTotal / showdowns : 0,
    };
  };

  const stay = () => ({ live: s.opponents.map(() => true), chips: s.opponents.map(o => o.committed) });
  const baseline: BetOption[] = [];
  if (toCall === 0) {
    const check = evaluateAction(s.committed, stay);
    baseline.push({ kind: 'check', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: check.equityWhenCalled, ev: check.ev });
  } else {
    const cost = Math.min(toCall, s.heroStack);
    const call = evaluateAction(s.committed + cost, stay);
    baseline.push({ kind: 'fold', to: s.committed, put: 0, foldChance: 0, equityWhenCalled: 0, ev: 0 });
    baseline.push({ kind: 'call', to: s.committed + cost, put: cost, foldChance: 0, equityWhenCalled: call.equityWhenCalled, ev: call.ev - cost });
  }

  return style => [
    ...baseline,
    ...totals.map(to => {
      const put = to - s.committed;
      const deciding = s.opponents.filter(o => o.stack > 0).length;
      const thresholds = s.opponents.map(o => {
        if (o.stack === 0) return 1; // Already all-in: always in.
        const asked = Math.min(to - o.committed, o.stack);
        return 1 - foldFrequency(asked, s.pot + put, style, deciding);
      });
      const result = evaluateAction(s.committed + put, t => {
        const live = s.opponents.map((_, i) => percentiles[t][i] < thresholds[i]);
        const chips = s.opponents.map((o, i) => (live[i] && o.stack > 0 ? Math.min(to, o.committed + o.stack) : o.committed));
        return { live, chips };
      });
      return {
        kind: wager(s) > 0 ? 'raise' : 'bet',
        to, put,
        foldChance: result.foldChance,
        equityWhenCalled: result.equityWhenCalled,
        ev: result.ev - put,
        allIn: put === s.heroStack,
        coversOpponent: s.opponents.every(o => o.stack === 0 || to >= o.committed + o.stack),
      } satisfies BetOption;
    }),
  ];
}

export function betAdvice(s: Snapshot, rules: Ruleset): BetAdvice {
  const aggressive = rules.legalActions(s).find(
    (a): a is Extract<Action, { kind: 'bet' | 'raise' }> => a.kind === 'bet' || a.kind === 'raise',
  );
  // Chips beyond what the deepest opponent can call come straight back, so cap sizes there.
  const coverTo = Math.max(...s.opponents.map(o => o.committed + o.stack));
  const totals = aggressive
    ? candidateTotals(s, Math.min(aggressive.minTo, coverTo), Math.min(aggressive.maxTo, coverTo)) : [];
  const single = s.opponents.length === 1;
  const range = holdings(s, rules, single);
  const optionsFor = single ? headsUp(s, range, totals) : multiway(s, rules, range, totals);

  const pick = (style: OpponentStyle) => {
    const options = optionsFor(style);
    let best = 0;
    options.forEach((option, i) => { if (option.ev > options[best].ev + 1e-9) best = i; });
    return { options, best };
  };
  const byStyle: BetAdvice['byStyle'] = { loose: pick('loose'), balanced: pick('balanced'), tight: pick('tight') };
  // Sensitive when playing one style's best action against another style
  // gives up more than 2% of the pot compared with that style's own best.
  const sensitive = STYLES.some(actual => STYLES.some(assumed => {
    const own = byStyle[actual];
    const choice = byStyle[assumed].options[byStyle[assumed].best];
    const same = own.options.find(o => o.kind === choice.kind && o.to === choice.to);
    return !same || own.options[own.best].ev - same.ev > SENSITIVE_SHARE * s.pot;
  }));
  const advice: BetAdvice = {
    byStyle,
    sensitive,
    opponent: s.opponents.every(o => o.cards.length) ? 'known' : 'random',
    players: s.opponents.length,
    method: single ? 'exact' : 'sampled',
    holdings: range.length,
    streetsLeft: rules.showdownBoardCount - s.board.length,
  };
  const toCall = faced(s);
  if (toCall > 0) {
    // The price of calling: chips above the hero's total cannot be won.
    const cost = Math.min(toCall, s.heroStack);
    const unmatched = s.opponents.reduce((sum, o) => sum + Math.max(0, o.committed - s.committed - cost), 0);
    const winnablePot = s.pot - unmatched + cost;
    advice.callPrice = { cost, winnablePot, needEquity: cost / winnablePot };
  }
  return advice;
}

/**
 * Why folding is the suggestion for a style, or null when it is not. Compares
 * the equity a call needs with the pot share it actually wins (side pots
 * included), reports the least costly raise, and lists the opponent styles
 * against which the hero should not fold.
 */
export function explainFold(advice: BetAdvice, style: OpponentStyle): FoldReason | null {
  const { options, best } = advice.byStyle[style];
  if (options[best].kind !== 'fold' || !advice.callPrice) return null;
  const call = options.find(o => o.kind === 'call');
  if (!call) return null;
  const { cost, winnablePot, needEquity } = advice.callPrice;
  const raises = options.filter(o => o.kind === 'raise');
  const bestRaise = raises.length ? raises.reduce((a, b) => (b.ev > a.ev ? b : a)) : null;
  return {
    cost,
    winnablePot,
    needEquity,
    haveEquity: (call.ev + cost) / winnablePot,
    callLoss: -call.ev,
    bestRaise,
    otherStyles: STYLES.filter(other => other !== style)
      .map(other => ({ style: other, option: advice.byStyle[other].options[advice.byStyle[other].best] }))
      .filter(({ option }) => option.kind !== 'fold'),
  };
}
