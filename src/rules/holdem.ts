import { combinations, compareRank, ranks, standardDeck } from '../core/cards.js';
import type { Action, Card, Equity, HandRank, Ruleset, Snapshot, StudyNote } from '../core/types.js';

const categories = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function rankFive(cards: readonly Card[]): HandRank {
  const ordered = cards.map(card => ranks.indexOf(card[0]) + 2).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const rank of ordered) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts].sort(([a, ac], [b, bc]) => bc - ac || b - a);
  const flush = cards.every(card => card[1] === cards[0][1]);
  const wheel = ordered.join(',') === '14,5,4,3,2';
  const straight = groups.length === 5 && (ordered[0] - ordered[4] === 4 || wheel);
  const straightHigh = wheel ? 5 : ordered[0];
  const byGroup = groups.map(([rank]) => rank);

  let value: number[];
  if (flush && straight) value = [8, straightHigh];
  else if (groups[0][1] === 4) value = [7, ...byGroup];
  else if (groups[0][1] === 3 && groups[1][1] === 2) value = [6, ...byGroup];
  else if (flush) value = [5, ...ordered];
  else if (straight) value = [4, straightHigh];
  else if (groups[0][1] === 3) value = [3, ...byGroup];
  else if (groups[0][1] === 2 && groups[1][1] === 2) value = [2, ...byGroup];
  else if (groups[0][1] === 2) value = [1, ...byGroup];
  else value = [0, ...ordered];
  return { name: categories[value[0]], value, cards };
}

function rank(hole: readonly Card[], board: readonly Card[]): HandRank | null {
  let best: HandRank | null = null;
  for (const cards of combinations([...hole, ...board], 5)) {
    const current = rankFive(cards);
    if (!best || compareRank(current.value, best.value) > 0) best = current;
  }
  return best;
}

const rankIndex = new Map([...ranks].map((rank, i) => [rank, i + 2]));
const suitIndex = new Map([...'cdhs'].map((suit, i) => [suit, i]));

/** Highest straight in a rank bitmask (bit r for rank r, ace also as 1), or 0. */
function straightHigh(mask: number): number {
  const m = mask | ((mask >> 14) & 1) << 1;
  for (let high = 14; high >= 5; high--) {
    const run = 0b11111 << (high - 4);
    if ((m & run) === run) return high;
  }
  return 0;
}

function topRanks(mask: number, count: number, exclude = 0): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < count; r--) if (mask & (1 << r) && !(exclude & (1 << r))) out.push(r);
  return out;
}

/**
 * Fast best-hand score for 5 to 7 cards. Larger is stronger, equal means a
 * split, and the category is `Math.floor(score / 16 ** 5)`. It orders hands
 * exactly like `rank`, without building every five-card combination.
 */
function score(cards: readonly Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const suits = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const r = rankIndex.get(card[0])!;
    const s = suitIndex.get(card[1])!;
    counts[r]++;
    suits[s] |= 1 << r;
    suitCounts[s]++;
    mask |= 1 << r;
  }
  const encode = (category: number, values: number[]) => {
    let value = category;
    for (let i = 0; i < 5; i++) value = value * 16 + (values[i] ?? 0);
    return value;
  };

  const flushSuit = suitCounts.findIndex(n => n >= 5);
  if (flushSuit >= 0) {
    const high = straightHigh(suits[flushSuit]);
    if (high) return encode(8, [high]);
  }
  let quad = 0;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quad = r;
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
  }
  if (quad) return encode(7, [quad, topRanks(mask, 1, 1 << quad)[0]]);
  if (trips.length && (trips.length > 1 || pairs.length)) {
    return encode(6, [trips[0], Math.max(trips[1] ?? 0, pairs[0] ?? 0)]);
  }
  if (flushSuit >= 0) return encode(5, topRanks(suits[flushSuit], 5));
  const high = straightHigh(mask);
  if (high) return encode(4, [high]);
  if (trips.length) return encode(3, [trips[0], ...topRanks(mask, 2, 1 << trips[0])]);
  if (pairs.length >= 2) {
    const used = (1 << pairs[0]) | (1 << pairs[1]);
    return encode(2, [pairs[0], pairs[1], topRanks(mask, 1, used)[0]]);
  }
  if (pairs.length) return encode(1, [pairs[0], ...topRanks(mask, 3, 1 << pairs[0])]);
  return encode(0, topRanks(mask, 5));
}

function validate(s: Snapshot): void {
  if (s.version !== 1 || s.ruleset !== holdem.id) throw new Error('Unsupported scenario version or ruleset.');
  if (s.purpose !== 'simulation' && s.purpose !== 'completed') throw new Error('Choose a study context.');
  if (s.hero.length !== 2) throw new Error('Enter exactly two hero cards.');
  if (![0, 3, 4, 5].includes(s.board.length)) throw new Error('Enter zero, three, four, or five board cards.');
  if (![0, 2].includes(s.opponent.length)) throw new Error('Leave opponent cards blank or enter both.');
  const cards = [...s.hero, ...s.board, ...s.opponent];
  if (cards.some(card => !standardDeck.includes(card))) throw new Error('Use valid cards such as As, Td, or 7h.');
  if (new Set(cards).size !== cards.length) throw new Error('Each card can appear only once.');
  const chips = [s.pot, s.heroStack, s.opponentStack, s.committed, s.faced, s.increment];
  if (chips.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)) {
    throw new Error('Use whole chip amounts between 0 and 1 billion.');
  }
  if (s.heroStack === 0 || s.increment === 0) throw new Error('Hero stack and minimum increment must be positive.');
  if (s.pot < 2 * s.committed + s.faced) throw new Error('The pot must include both players’ current street commitments.');
  if (!s.opponentStack && !s.faced) throw new Error('There is no decision when the opponent is all-in and no wager is faced.');
}

function legalActions(s: Snapshot): Action[] {
  const actions: Action[] = s.faced
    ? [{ kind: 'fold' }, { kind: 'call', cost: Math.min(s.faced, s.heroStack) }]
    : [{ kind: 'check' }];
  if (!s.opponentStack || s.heroStack <= s.faced) return actions;
  const wagerTo = s.committed + s.faced;
  const maxTo = s.committed + s.heroStack;
  const fullMinTo = wagerTo + s.increment;
  actions.push({
    kind: wagerTo > 0 ? 'raise' : 'bet',
    minTo: Math.min(fullMinTo, maxTo),
    maxTo,
    short: maxTo < fullMinTo,
  });
  return actions;
}

function study(s: Snapshot, e: Equity): StudyNote {
  if (!s.faced) {
    return { title: 'Check is the baseline', detail: 'Bet sizing compares checking with bets under a stated opponent model.' };
  }
  const cost = Math.min(s.faced, s.heroStack);
  const eligiblePot = s.pot - (s.faced - cost);
  const finalPot = eligiblePot + cost;
  const threshold = cost / finalPot;
  if (s.board.length !== 5 && cost < s.heroStack && s.opponentStack > 0) {
    return { title: 'Pot odds only', detail: 'Future betting can change the value of a call.', threshold };
  }
  const callValue = e.share * finalPot - cost;
  const result = Math.abs(callValue) < 1e-9 && e.method === 'exact'
    ? 'Call and fold break even'
    : e.interval[0] > threshold ? 'Call beats fold under this model'
    : e.interval[1] < threshold ? 'Fold beats call under this model'
    : 'Call comparison is inconclusive';
  return {
    title: result,
    detail: 'Compares a call that ends betting with folding, using the displayed opponent model. Raise EV is unmodeled.',
    threshold,
    callValue,
  };
}

export const holdem: Ruleset = {
  id: 'holdem-nl-hu', deck: standardDeck, holeCount: 2, showdownBoardCount: 5, categories,
  validate, rank, score: (hole, board) => score([...hole, ...board]), legalActions, study,
};
