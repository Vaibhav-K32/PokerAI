import type { Card, Ruleset, Seat, Snapshot } from './types.js';

/** The largest current-street commitment among opponents. */
export function wager(s: Snapshot): number {
  return Math.max(0, ...s.opponents.map(o => o.committed));
}

/** Chips the hero must add to match the largest bet. */
export function faced(s: Snapshot): number {
  return Math.max(0, wager(s) - s.committed);
}

/** Every card visible to the analysis: hero, board, and known opponent cards. */
export function knownCards(s: Snapshot): Card[] {
  return [...s.hero, ...s.board, ...s.opponents.flatMap(o => o.cards)];
}

/** Chips in the pot from earlier streets or folded players. */
export function deadMoney(s: Snapshot): number {
  return s.pot - s.committed - s.opponents.reduce((sum, o) => sum + o.committed, 0);
}

/** True for an opponent who went all-in on an earlier street. */
export function allInEarlier(o: Seat): boolean {
  return o.stack === 0 && o.committed === 0;
}

/**
 * How much of the earlier-street pot each player can win, hero first.
 * `undefined` means all of it. A player all-in on an earlier street is capped
 * at their `eligiblePot`, or the whole earlier pot when it is not given.
 */
export function potCaps(s: Snapshot): (number | undefined)[] {
  const base = deadMoney(s);
  return [undefined, ...s.opponents.map(o => (allInEarlier(o) ? Math.min(o.eligiblePot ?? base, base) : undefined))];
}

/**
 * Chips the hero collects at showdown. `scores[0]` and `contributions[0]` are
 * the hero's; the rest are opponents still in the hand (`null` score means
 * folded this street, whose chips stay in the pot). `base` is the pot from
 * earlier streets: each player can win up to their entry in `caps` of it
 * (`undefined` for all of it), which splits it into a main pot and earlier
 * side pots. This street's chips form further pots by commitment. Each pot
 * goes to the best eligible hand, split evenly on ties; a pot only one player
 * reached is that player's uncalled chips.
 */
export function heroPayout(
  scores: readonly (number | null)[],
  contributions: readonly number[],
  base: number,
  caps: readonly (number | undefined)[] = [],
): number {
  let folded = 0;
  const live: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] === null) folded += contributions[i];
    else live.push(i);
  }
  let won = 0;
  const award = (amount: number, eligible: readonly number[]) => {
    if (amount <= 0 || !eligible.includes(0)) return;
    const best = Math.max(...eligible.map(i => scores[i]!));
    const winners = eligible.filter(i => scores[i] === best);
    if (winners.includes(0)) won += amount / winners.length;
  };

  // Earlier streets: layers up to each capped player's limit, then the rest.
  const capOf = (i: number) => caps[i] ?? Infinity;
  const capLevels = [...new Set(live.map(capOf).filter(c => c < base))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of [...capLevels, base]) {
    award(level - previous, live.filter(i => capOf(i) >= level));
    previous = level;
  }

  // This street: layers by commitment. Chips from players who folded this
  // street join the lowest layer, which everyone who put chips in can win.
  const levels = [...new Set(live.map(i => contributions[i]).filter(c => c > 0))].sort((a, b) => a - b);
  if (!levels.length) award(folded, live.filter(i => capOf(i) === Infinity));
  previous = 0;
  levels.forEach((level, index) => {
    const eligible = live.filter(i => contributions[i] >= level);
    award((level - previous) * eligible.length + (index === 0 ? folded : 0), eligible);
    previous = level;
  });
  return won;
}

export function choose(n: number, k: number): number {
  let count = 1;
  for (let i = 1; i <= k; i++) count = count * (n - i + 1) / i;
  return Math.round(count);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Partial Fisher-Yates: the first `count` entries become a random draw. */
export function draw<T>(pool: T[], count: number, random: () => number): T[] {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** A comparable showdown score, using the ruleset's fast path when it has one. */
export function scorer(rules: Ruleset): (hole: readonly Card[], board: readonly Card[]) => number {
  if (rules.score) return rules.score.bind(rules);
  return (hole, board) => {
    const rank = rules.rank(hole, board);
    if (!rank) throw new Error('Ruleset did not produce a hand rank.');
    let value = 0;
    for (let i = 0; i < 6; i++) value = value * 16 + (rank.value[i] ?? 0);
    return value;
  };
}
