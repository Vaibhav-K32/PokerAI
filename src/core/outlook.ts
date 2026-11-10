import { combinations } from './cards.js';
import type {
  Card, Matchup, OpponentOutlook, Outlook, OutlookRow, Ruleset, Snapshot, Suggestion,
} from './types.js';

const SAMPLE_RUNOUTS = 2500;
const EXACT_LIMIT = 3000;
/** Board-and-opponent pairs evaluated exactly; above this they are sampled. */
const EXACT_MATCHUPS = 250_000;
const SAMPLED_MATCHUPS = 100_000;
const CATEGORY_BASE = 16 ** 5;

function choose(n: number, k: number): number {
  let count = 1;
  for (let i = 1; i <= k; i++) count = count * (n - i + 1) / i;
  return Math.round(count);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Partial Fisher-Yates: the first `count` entries become a random draw. */
function draw<T>(pool: T[], count: number, random: () => number): T[] {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** A comparable showdown score, using the ruleset's fast path when it has one. */
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

interface Tally { hands: number; win: number; tie: number; loss: number; beatenBy: Map<string, number> }

/**
 * The hero's chances of finishing with each hand category, how each finished
 * hand fares against the opponent, and which hands carry the hero's equity.
 * Every unseen card counts as equally likely. A known opponent hand is used
 * exactly; otherwise the opponent holds a uniformly random hand.
 * Returns null when the board is already complete.
 */
export function handOutlook(s: Snapshot, rules: Ruleset): Outlook | null {
  const toCome = rules.showdownBoardCount - s.board.length;
  if (toCome <= 0) return null;
  const evaluate = scorer(rules);
  const categoryOf = (value: number) => Math.floor(value / CATEGORY_BASE);
  const names = rules.categories;
  const used = new Set([...s.hero, ...s.board, ...s.opponent]);
  const unseen = rules.deck.filter(card => !used.has(card));
  const random = seededRandom(20262);
  const current = s.board.length ? categoryOf(evaluate(s.hero, s.board)) : null;

  // Complete boards: every runout when small enough, otherwise a seeded sample.
  const exact = choose(unseen.length, toCome) <= EXACT_LIMIT;
  const runouts: Card[][] = exact
    ? [...combinations(unseen, toCome)]
    : Array.from({ length: SAMPLE_RUNOUTS }, () => draw([...unseen], toCome, random));

  // Opponent hands per board.
  const knownOpponent = s.opponent.length === rules.holeCount;
  const holesPerBoard = knownOpponent ? 1 : choose(unseen.length - toCome, rules.holeCount);
  const exactMatchups = knownOpponent || runouts.length * holesPerBoard <= EXACT_MATCHUPS;
  const samplesPerBoard = exactMatchups ? holesPerBoard : Math.ceil(SAMPLED_MATCHUPS / runouts.length);

  const finals = new Map<number, number>();
  const tallies = new Map<number, Tally>();
  const opponentFinals = new Map<number, { hands: number; beats: number }>();
  let matchups = 0;

  for (const runout of runouts) {
    const board = [...s.board, ...runout];
    const heroScore = evaluate(s.hero, board);
    const heroCategory = categoryOf(heroScore);
    finals.set(heroCategory, (finals.get(heroCategory) ?? 0) + 1);
    let tally = tallies.get(heroCategory);
    if (!tally) tallies.set(heroCategory, tally = { hands: 0, win: 0, tie: 0, loss: 0, beatenBy: new Map() });

    const rest = knownOpponent ? [] : unseen.filter(card => !runout.includes(card));
    const holes: Iterable<readonly Card[]> = knownOpponent
      ? [s.opponent]
      : exactMatchups
        ? combinations(rest, rules.holeCount)
        : Array.from({ length: samplesPerBoard }, () => draw(rest, rules.holeCount, random));
    for (const hole of holes) {
      const opponentScore = evaluate(hole, board);
      const opponentCategory = categoryOf(opponentScore);
      const opponent = opponentFinals.get(opponentCategory) ?? { hands: 0, beats: 0 };
      opponent.hands++;
      tally.hands++;
      matchups++;
      if (heroScore > opponentScore) tally.win++;
      else if (heroScore === opponentScore) tally.tie++;
      else {
        tally.loss++;
        opponent.beats++;
        const label = opponentCategory === heroCategory
          ? 'Better ' + names[opponentCategory].toLowerCase()
          : names[opponentCategory];
        tally.beatenBy.set(label, (tally.beatenBy.get(label) ?? 0) + 1);
      }
      opponentFinals.set(opponentCategory, opponent);
    }
  }

  // Outs on the next single card, once a flop is out.
  const outs = new Map<number, Card[]>();
  const nextCard = s.board.length > 0;
  if (nextCard && current !== null) {
    for (const card of unseen) {
      const category = categoryOf(evaluate(s.hero, [...s.board, card]));
      if (category > current) outs.set(category, [...(outs.get(category) ?? []), card]);
    }
  }

  const categories = new Set([...finals.keys(), ...outs.keys()]);
  if (current !== null) categories.add(current);
  const rows: OutlookRow[] = [...categories].sort((a, b) => b - a).map(category => {
    const byRiver = (finals.get(category) ?? 0) / runouts.length;
    const tally = tallies.get(category);
    let matchup: Matchup | undefined;
    if (tally?.hands) {
      matchup = {
        win: tally.win / tally.hands,
        tie: tally.tie / tally.hands,
        loss: tally.loss / tally.hands,
        beatenBy: [...tally.beatenBy]
          .map(([name, count]) => ({ name, chance: count / tally.hands }))
          .sort((a, b) => b.chance - a.chance),
      };
    }
    const row: OutlookRow = {
      category,
      name: names[category],
      byRiver,
      improves: current === null || category > current,
      equityShare: matchup ? byRiver * (matchup.win + matchup.tie / 2) : 0,
    };
    if (matchup) row.matchup = matchup;
    if (nextCard) {
      const cards = outs.get(category) ?? [];
      row.nextCard = { outs: cards, chance: cards.length / unseen.length };
    }
    return row;
  });

  const opponent: OpponentOutlook = {
    model: knownOpponent ? 'known' : 'random',
    method: exact && exactMatchups ? 'exact' : 'sampled',
    matchups,
    equity: 0,
    beatsYou: 0,
    rows: [...opponentFinals].sort(([a], [b]) => b - a).map(([category, { hands, beats }]) => ({
      category, name: names[category], chance: hands / matchups, beatsYou: beats / matchups,
    })),
  };
  const yourEquity = rows.reduce((sum, row) => sum + row.equityShare, 0);
  opponent.equity = 1 - yourEquity;
  opponent.beatsYou = opponent.rows.reduce((sum, row) => sum + row.beatsYou, 0);

  const improveByRiver = rows.filter(row => current !== null && row.category > current)
    .reduce((sum, row) => sum + row.byRiver, 0);
  return {
    current: current === null ? null : { category: current, name: names[current] },
    method: exact ? 'exact' : 'sampled',
    runouts: runouts.length,
    unseen: unseen.length,
    cardsToCome: toCome,
    improveByRiver: current === null ? null : improveByRiver,
    rows,
    opponent,
    yourEquity,
    suggestion: suggest(rows, current, yourEquity),
  };
}

/** Minimum share of the pot a hand must carry to be worth naming. */
const NOTABLE_SHARE = 0.02;
/** ...and at least this part of the hero's own equity. */
const NOTABLE_PART = 0.1;

/**
 * Point to the finishing hands that carry most of the hero's showdown equity,
 * and warn about hands made often that usually lose. This describes where
 * equity comes from at showdown; it is not a betting recommendation.
 */
function suggest(rows: readonly OutlookRow[], current: number | null, yourEquity: number): Suggestion {
  const winRate = (row: OutlookRow) => (row.matchup ? row.matchup.win + row.matchup.tie / 2 : 0);
  const playFor = rows
    .filter(row => row.improves && row.equityShare >= NOTABLE_SHARE && row.equityShare >= NOTABLE_PART * yourEquity)
    .sort((a, b) => b.equityShare - a.equityShare)
    .slice(0, 2)
    .map(row => ({ name: row.name, byRiver: row.byRiver, winWhenMade: winRate(row), equityShare: row.equityShare }));
  const caution = rows
    .filter(row => row.byRiver >= 0.1 && row.matchup && winRate(row) < 0.5)
    .sort((a, b) => b.byRiver - a.byRiver)
    .slice(0, 2)
    .map(row => ({ name: row.name, byRiver: row.byRiver, winWhenMade: winRate(row) }));
  const now = current === null ? undefined : rows.find(row => row.category === current);
  const holding = now && now.matchup && winRate(now) >= 0.75 && now.byRiver >= 0.2
    ? { name: now.name, byRiver: now.byRiver, winWhenMade: winRate(now) }
    : null;
  return { playFor, caution, holding, yourEquity };
}
