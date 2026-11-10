import { combinations, compareRank } from './cards.js';
import type { Card, Equity, Ruleset, Snapshot } from './types.js';

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

export function calculateEquity(s: Snapshot, rules: Ruleset): Equity {
  rules.validate(s);
  const used = new Set([...s.hero, ...s.board, ...s.opponent]);
  const remaining = rules.deck.filter(card => !used.has(card));
  const unknownHole = s.opponent.length ? 0 : rules.holeCount;
  const unknownBoard = rules.showdownBoardCount - s.board.length;
  const exact = choose(remaining.length, unknownHole)
    * choose(remaining.length - unknownHole, unknownBoard) <= 3000;
  let wins = 0;
  let ties = 0;
  let trials = 0;
  // Prefer the ruleset's fast score; it orders hands exactly like `rank`.
  const compare = rules.score
    ? (board: readonly Card[], hole: readonly Card[]) =>
      rules.score!(s.hero, board) - rules.score!([...s.opponent, ...hole], board)
    : (board: readonly Card[], hole: readonly Card[]) => {
      const hero = rules.rank(s.hero, board);
      const opponent = rules.rank([...s.opponent, ...hole], board);
      if (!hero || !opponent) throw new Error('Ruleset did not produce a showdown rank.');
      return compareRank(hero.value, opponent.value);
    };

  function record(hole: readonly Card[], runout: readonly Card[]) {
    const order = compare([...s.board, ...runout], hole);
    if (order > 0) wins++;
    if (order === 0) ties++;
    trials++;
  }

  if (exact) {
    for (const hole of combinations(remaining, unknownHole)) {
      const boardPool = remaining.filter(card => !hole.includes(card));
      for (const runout of combinations(boardPool, unknownBoard)) record(hole, runout);
    }
  } else {
    const random = seededRandom(20261);
    const draws = unknownHole + unknownBoard;
    for (let trial = 0; trial < 2500; trial++) {
      const pool = [...remaining];
      for (let i = 0; i < draws; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      record(pool.slice(0, unknownHole), pool.slice(unknownHole, draws));
    }
  }

  const share = (wins + ties / 2) / trials;
  // Hoeffding bound for outcomes in [0, 1], including half a pot for ties.
  const radius = exact ? 0 : Math.sqrt(Math.log(40) / (2 * trials));
  return {
    method: exact ? 'exact' : 'sampled', trials, share,
    win: wins / trials, tie: ties / trials, loss: (trials - wins - ties) / trials,
    interval: [Math.max(0, share - radius), Math.min(1, share + radius)],
  };
}
