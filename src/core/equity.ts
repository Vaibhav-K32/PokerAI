import { combinations } from './cards.js';
import { choose, deadMoney, faced, heroPayout, knownCards, potCaps, scorer, seededRandom } from './table.js';
import type { Card, Equity, Ruleset, Snapshot } from './types.js';

const EXACT_LIMIT = 3000;
const SAMPLES = 2500;

/**
 * Showdown equity against every opponent still in the hand. Unknown opponents
 * hold uniformly random hands. Outcomes are enumerated when there are at most
 * 3,000 of them and sampled otherwise. When the hero faces a wager, also
 * returns the expected chips collected from the main and side pots after
 * calling, with opponents staying at their current commitments.
 */
export function calculateEquity(s: Snapshot, rules: Ruleset): Equity {
  rules.validate(s);
  const evaluate = scorer(rules);
  const used = new Set(knownCards(s));
  const remaining = rules.deck.filter(card => !used.has(card));
  const unknownSeats = s.opponents.flatMap((o, i) => (o.cards.length ? [] : [i]));
  const unknownBoard = rules.showdownBoardCount - s.board.length;
  let outcomes = choose(remaining.length - unknownSeats.length * rules.holeCount, unknownBoard);
  unknownSeats.forEach((_, k) => { outcomes *= choose(remaining.length - k * rules.holeCount, rules.holeCount); });
  const exact = outcomes <= EXACT_LIMIT;

  const toCall = faced(s);
  const contributions = [s.committed + Math.min(toCall, s.heroStack), ...s.opponents.map(o => o.committed)];
  const base = deadMoney(s);
  const caps = potCaps(s);

  let wins = 0;
  let ties = 0;
  let tieShare = 0;
  let winnings = 0;
  let trials = 0;
  function record(holes: readonly (readonly Card[])[], runout: readonly Card[]) {
    const board = [...s.board, ...runout];
    let next = 0;
    const scores = [evaluate(s.hero, board), ...s.opponents.map(o => evaluate(o.cards.length ? o.cards : holes[next++], board))];
    const hero = scores[0];
    let best = -Infinity;
    let level = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > best) { best = scores[i]; level = 1; } else if (scores[i] === best) level++;
    }
    if (hero > best) wins++;
    else if (hero === best) {
      ties++;
      tieShare += 1 / (level + 1);
    }
    if (toCall) winnings += heroPayout(scores, contributions, base, caps);
    trials++;
  }

  if (exact) {
    const deal = (pool: readonly Card[], holes: (readonly Card[])[]) => {
      if (holes.length === unknownSeats.length) {
        for (const runout of combinations(pool, unknownBoard)) record(holes, runout);
        return;
      }
      for (const hole of combinations(pool, rules.holeCount)) {
        deal(pool.filter(card => !hole.includes(card)), [...holes, hole]);
      }
    };
    deal(remaining, []);
  } else {
    const random = seededRandom(20261);
    const holeCards = unknownSeats.length * rules.holeCount;
    const draws = holeCards + unknownBoard;
    for (let trial = 0; trial < SAMPLES; trial++) {
      const pool = [...remaining];
      for (let i = 0; i < draws; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const holes = unknownSeats.map((_, k) => pool.slice(k * rules.holeCount, (k + 1) * rules.holeCount));
      record(holes, pool.slice(holeCards, draws));
    }
  }

  const share = (wins + tieShare) / trials;
  // Hoeffding bound for outcomes in [0, 1], including split shares for ties.
  const radius = exact ? 0 : Math.sqrt(Math.log(40) / (2 * trials));
  const equity: Equity = {
    method: exact ? 'exact' : 'sampled', trials, share,
    win: wins / trials, tie: ties / trials, loss: (trials - wins - ties) / trials,
    interval: [Math.max(0, share - radius), Math.min(1, share + radius)],
  };
  if (toCall) equity.callWinnings = winnings / trials;
  return equity;
}
