import { combinations } from './cards.js';
import { choose, draw, knownCards, scorer, seededRandom } from './table.js';
import type {
  Card, Matchup, OpponentOutlook, Outlook, OutlookRow, Ruleset, Snapshot, Suggestion,
} from './types.js';

const SAMPLE_RUNOUTS = 2500;
const EXACT_LIMIT = 3000;
/** Board-and-opponent pairs evaluated exactly; above this they are sampled. */
const EXACT_MATCHUPS = 250_000;
const SAMPLED_MATCHUPS = 100_000;
const CATEGORY_BASE = 16 ** 5;

interface Tally { hands: number; win: number; tie: number; loss: number; share: number; beatenBy: Map<string, number> }

/**
 * The hero's chances of finishing with each hand category, how each finished
 * hand fares at showdown, and which hands carry the hero's equity. Every
 * unseen card counts as equally likely. Known opponent hands are used
 * exactly; unknown opponents hold uniformly random hands. With several
 * opponents, the hero must beat the strongest of them.
 * Returns null when the board is already complete.
 */
export function handOutlook(s: Snapshot, rules: Ruleset): Outlook | null {
  const toCome = rules.showdownBoardCount - s.board.length;
  if (toCome <= 0) return null;
  const evaluate = scorer(rules);
  const categoryOf = (value: number) => Math.floor(value / CATEGORY_BASE);
  const names = rules.categories;
  const used = new Set(knownCards(s));
  const unseen = rules.deck.filter(card => !used.has(card));
  const random = seededRandom(20262);
  const current = s.board.length ? categoryOf(evaluate(s.hero, s.board)) : null;

  // Complete boards: every runout when small enough, otherwise a seeded sample.
  const exact = choose(unseen.length, toCome) <= EXACT_LIMIT;
  const runouts: Card[][] = exact
    ? [...combinations(unseen, toCome)]
    : Array.from({ length: SAMPLE_RUNOUTS }, () => draw([...unseen], toCome, random));

  // Opponent hands per board: fixed when known; every hand for a single
  // unknown opponent when affordable; otherwise sampled deals.
  const unknownSeats = s.opponents.flatMap((o, i) => (o.cards.length ? [] : [i]));
  const allKnown = unknownSeats.length === 0;
  const singleCombos = unknownSeats.length === 1 ? choose(unseen.length - toCome, rules.holeCount) : Infinity;
  const exactMatchups = allKnown || runouts.length * singleCombos <= EXACT_MATCHUPS;
  const samplesPerBoard = Math.ceil(SAMPLED_MATCHUPS / runouts.length);

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
    if (!tally) tallies.set(heroCategory, tally = { hands: 0, win: 0, tie: 0, loss: 0, share: 0, beatenBy: new Map() });

    const rest = unseen.filter(card => !runout.includes(card));
    const deals: Iterable<readonly (readonly Card[])[]> = allKnown
      ? [[]]
      : exactMatchups
        ? (function* () { for (const hole of combinations(rest, rules.holeCount)) yield [hole]; })()
        : Array.from({ length: samplesPerBoard }, () => {
          const cards = draw(rest, unknownSeats.length * rules.holeCount, random);
          return unknownSeats.map((_, k) => cards.slice(k * rules.holeCount, (k + 1) * rules.holeCount));
        });
    for (const holes of deals) {
      let next = 0;
      let best = -Infinity;
      let level = 0;
      for (const o of s.opponents) {
        const value = evaluate(o.cards.length ? o.cards : holes[next++], board);
        if (value > best) { best = value; level = 1; } else if (value === best) level++;
      }
      const opponentCategory = categoryOf(best);
      const opponent = opponentFinals.get(opponentCategory) ?? { hands: 0, beats: 0 };
      opponent.hands++;
      tally.hands++;
      matchups++;
      if (heroScore > best) {
        tally.win++;
        tally.share++;
      } else if (heroScore === best) {
        tally.tie++;
        tally.share += 1 / (level + 1);
      } else {
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
        share: tally.share / tally.hands,
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
      equityShare: matchup ? byRiver * matchup.share : 0,
    };
    if (matchup) row.matchup = matchup;
    if (nextCard) {
      const cards = outs.get(category) ?? [];
      row.nextCard = { outs: cards, chance: cards.length / unseen.length };
    }
    return row;
  });

  const yourEquity = rows.reduce((sum, row) => sum + row.equityShare, 0);
  const opponentRows = [...opponentFinals].sort(([a], [b]) => b - a).map(([category, { hands, beats }]) => ({
    category, name: names[category], chance: hands / matchups, beatsYou: beats / matchups,
  }));
  const opponent: OpponentOutlook = {
    model: allKnown ? 'known' : 'random',
    method: exact && exactMatchups ? 'exact' : 'sampled',
    players: s.opponents.length,
    matchups,
    equity: 1 - yourEquity,
    beatsYou: opponentRows.reduce((sum, row) => sum + row.beatsYou, 0),
    rows: opponentRows,
  };

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

/** Minimum share of the pot a hand must carry to be worth naming... */
const NOTABLE_SHARE = 0.02;
/** ...and at least this part of the hero's own equity. */
const NOTABLE_PART = 0.1;

/**
 * Point to the finishing hands that carry most of the hero's showdown equity,
 * and warn about hands made often that usually lose. This describes where
 * equity comes from at showdown; it is not a betting recommendation.
 */
function suggest(rows: readonly OutlookRow[], current: number | null, yourEquity: number): Suggestion {
  const winRate = (row: OutlookRow) => row.matchup?.share ?? 0;
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
