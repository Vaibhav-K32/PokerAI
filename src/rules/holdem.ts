import { combinations, compareRank, ranks, standardDeck } from '../core/cards.js';
import { allInEarlier, deadMoney, faced, knownCards, wager } from '../core/table.js';
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
  if (s.version !== 2 || s.ruleset !== holdem.id) throw new Error('Unsupported scenario version or ruleset.');
  if (s.purpose !== 'simulation' && s.purpose !== 'completed') throw new Error('Choose a study context.');
  if (s.hero.length !== 2) throw new Error('Enter exactly two hero cards.');
  if (![0, 3, 4, 5].includes(s.board.length)) throw new Error('Enter zero, three, four, or five board cards.');
  if (!Array.isArray(s.opponents) || s.opponents.length < 1 || s.opponents.length > 3) {
    throw new Error('Seat one to three opponents.');
  }
  if (s.opponents.some(o => ![0, 2].includes(o.cards.length))) throw new Error('Leave opponent cards blank or enter both.');
  const cards = knownCards(s);
  if (cards.some(card => !standardDeck.includes(card))) throw new Error('Use valid cards such as As, Td, or 7h.');
  if (new Set(cards).size !== cards.length) throw new Error('Each card can appear only once.');
  const chips = [s.pot, s.heroStack, s.committed, s.increment, ...s.opponents.flatMap(o => [o.stack, o.committed])];
  if (chips.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)) {
    throw new Error('Use whole chip amounts between 0 and 1 billion.');
  }
  if (s.heroStack === 0 || s.increment === 0) throw new Error('Hero stack and minimum increment must be positive.');
  if (s.committed > wager(s)) throw new Error('Your bet this street cannot be larger than the biggest opponent bet.');
  if (deadMoney(s) < 0) throw new Error('The pot must include every player’s current street commitments.');
  for (const o of s.opponents) {
    if (o.eligiblePot === undefined) continue;
    if (!allInEarlier(o)) throw new Error('Only a player all-in on an earlier street has a separate pot they can win.');
    if (!Number.isSafeInteger(o.eligiblePot) || o.eligiblePot <= 0 || o.eligiblePot > deadMoney(s)) {
      throw new Error('The pot an earlier all-in player can win must be a whole number of chips, at most the pot from earlier streets.');
    }
  }
  if (s.opponents.some(allInEarlier) && deadMoney(s) <= 0) {
    throw new Error('A player all-in on an earlier street needs chips in the pot from earlier streets.');
  }
  if (!faced(s) && s.opponents.every(o => o.stack === 0)) {
    throw new Error('There is no decision when every opponent is all-in and no wager is faced.');
  }
}

function legalActions(s: Snapshot): Action[] {
  const toCall = faced(s);
  const actions: Action[] = toCall
    ? [{ kind: 'fold' }, { kind: 'call', cost: Math.min(toCall, s.heroStack) }]
    : [{ kind: 'check' }];
  // A wager needs at least one opponent with chips left to respond.
  if (s.opponents.every(o => o.stack === 0) || s.heroStack <= toCall) return actions;
  const wagerTo = wager(s);
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
  const toCall = faced(s);
  if (!toCall) {
    return { title: 'Check is the baseline', detail: 'Bet sizing compares checking with bets under a stated opponent model.' };
  }
  const cost = Math.min(toCall, s.heroStack);
  // Chips above the hero's total cannot be won by the hero.
  const heroTotal = s.committed + cost;
  const unmatched = s.opponents.reduce((sum, o) => sum + Math.max(0, o.committed - heroTotal), 0);
  const finalPot = s.pot - unmatched + cost;
  const threshold = cost / finalPot;
  const toAct = s.opponents.some(o => o.stack > 0 && o.committed < wager(s));
  const laterStreets = s.board.length !== 5 && cost < s.heroStack && s.opponents.some(o => o.stack > 0);
  if (toAct || laterStreets) {
    return {
      title: 'Pot odds only',
      detail: toAct
        ? 'Players still to act can raise or fold, which changes the value of a call.'
        : 'Future betting can change the value of a call.',
      threshold,
    };
  }
  const winnings = e.callWinnings ?? e.share * finalPot;
  const callValue = winnings - cost;
  // Compare the pot share the call actually wins, including side pots.
  const share = winnings / finalPot;
  // Shift the equity sampling bound onto that share; heads-up it is unchanged.
  const low = share - (e.share - e.interval[0]);
  const high = share + (e.interval[1] - e.share);
  const result = Math.abs(callValue) < 1e-9 && e.method === 'exact'
    ? 'Call and fold break even'
    : low > threshold ? 'Call beats fold under this model'
    : high < threshold ? 'Fold beats call under this model'
    : 'Call comparison is inconclusive';
  return {
    title: result,
    detail: 'Compares a call that ends betting with folding, using the displayed opponent model. Raise EV is unmodeled.',
    threshold,
    callValue,
  };
}

export const holdem: Ruleset = {
  id: 'holdem-nl', deck: standardDeck, holeCount: 2, showdownBoardCount: 5, categories,
  validate, rank, score: (hole, board) => score([...hole, ...board]), legalActions, study,
};
