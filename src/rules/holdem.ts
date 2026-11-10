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
    return { title: 'Check is the baseline', detail: 'A bet comparison needs assumptions about how the opponent responds.' };
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
  id: 'holdem-nl-hu', deck: standardDeck, holeCount: 2, showdownBoardCount: 5,
  validate, rank, legalActions, study,
};
