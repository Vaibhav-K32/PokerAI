import { combinations } from './cards.js';
import type { Card, Outlook, OutlookRow, Ruleset, Snapshot } from './types.js';

const SAMPLE_RUNOUTS = 2500;
const EXACT_LIMIT = 3000;

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

/**
 * The hero's chances of finishing with each hand category, counting every
 * unseen card as equally likely. Known opponent cards are removed from the
 * deck; unknown opponent cards are not, because the hero cannot see them.
 * Returns null when the board is already complete.
 */
export function handOutlook(s: Snapshot, rules: Ruleset): Outlook | null {
  const toCome = rules.showdownBoardCount - s.board.length;
  if (toCome <= 0) return null;
  const used = new Set([...s.hero, ...s.board, ...s.opponent]);
  const unseen = rules.deck.filter(card => !used.has(card));

  const names = new Map<number, string>();
  const categoryOf = (board: readonly Card[]) => {
    const rank = rules.rank(s.hero, board);
    if (!rank) throw new Error('Ruleset did not produce a hand rank.');
    names.set(rank.value[0], rank.name);
    return rank.value[0];
  };
  const current = s.board.length ? categoryOf(s.board) : null;

  // Final category counts across complete runouts.
  const finals = new Map<number, number>();
  const exact = choose(unseen.length, toCome) <= EXACT_LIMIT;
  let runouts = 0;
  const record = (runout: readonly Card[]) => {
    const category = categoryOf([...s.board, ...runout]);
    finals.set(category, (finals.get(category) ?? 0) + 1);
    runouts++;
  };
  if (exact) {
    for (const runout of combinations(unseen, toCome)) record(runout);
  } else {
    const random = seededRandom(20262);
    for (let trial = 0; trial < SAMPLE_RUNOUTS; trial++) {
      const pool = [...unseen];
      for (let i = 0; i < toCome; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      record(pool.slice(0, toCome));
    }
  }

  // Outs on the next single card, once a flop is out.
  const outs = new Map<number, Card[]>();
  const nextCard = s.board.length > 0;
  if (nextCard) {
    for (const card of unseen) {
      const category = categoryOf([...s.board, card]);
      if (current !== null && category > current) outs.set(category, [...(outs.get(category) ?? []), card]);
    }
  }

  const categories = new Set([...finals.keys(), ...outs.keys()]);
  if (current !== null) categories.add(current);
  const rows: OutlookRow[] = [...categories].sort((a, b) => b - a).map(category => {
    const row: OutlookRow = {
      category,
      name: names.get(category) ?? String(category),
      byRiver: (finals.get(category) ?? 0) / runouts,
      improves: current === null || category > current,
    };
    if (nextCard) {
      const cards = outs.get(category) ?? [];
      row.nextCard = { outs: cards, chance: cards.length / unseen.length };
    }
    return row;
  });

  const improveByRiver = rows.filter(row => current !== null && row.category > current)
    .reduce((sum, row) => sum + row.byRiver, 0);
  return {
    current: current === null ? null : { category: current, name: names.get(current)! },
    method: exact ? 'exact' : 'sampled',
    runouts,
    unseen: unseen.length,
    cardsToCome: toCome,
    improveByRiver: current === null ? null : improveByRiver,
    rows,
  };
}
