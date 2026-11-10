// The difference engine: compares two observations of one table and lists
// what visibly changed. Deterministic and pure, with no UI. Which seat is
// which person comes from the identity module as a SeatPairing; this module
// only compares values. A value missing on either side is never a change in
// the game; it is reported only as information becoming visible or hidden,
// and unknown is never treated as zero.
import type { RecognizedField, Street } from '../vision/screenshot.js';
import { pairByOrder } from './identity.js';
import { middleChips, possessive, seatName, subjectIs, subjectVerb } from './observation.js';
import type { DifferenceKind, Evidence, HandObservation, SeatPairing, StateDifference } from './types.js';

export { alignSeats } from './identity.js';

const STREET_ORDER: Record<Street, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const BOARD_STREET = ['flop', 'flop', 'flop', 'turn', 'river'] as const;

/** Kinds that cannot happen within one hand, so they suggest two different hands. */
export const DIFFERENT_HAND_KINDS: readonly DifferenceKind[] = [
  'board-shrank', 'street-reversed', 'dealer-moved', 'blinds-changed', 'seat-count-changed', 'unfolded',
];

function evidenceOf(a: RecognizedField<unknown>, b: RecognizedField<unknown>): Evidence {
  if (a.source === 'inferred' || b.source === 'inferred') return 'inferred';
  if (a.source === 'corrected' || b.source === 'corrected') return 'confirmed';
  return 'observed';
}

const cardList = (cards: readonly (string | null)[]) => cards.map(c => c ?? '?').join(' ');

/**
 * Compare two observations on their own, lining seats up by order and names.
 * Use `compareFrameStates` with a tracked pairing inside a sequence.
 */
export function compareObservations(previous: HandObservation, next: HandObservation, pairing?: SeatPairing | null): StateDifference[] {
  return compareFrameStates(previous, next, pairing === undefined ? pairByOrder(previous.recognition, next.recognition) : pairing);
}

/**
 * Every visible difference between two frames, in a fixed order. Players are
 * compared through `pairing` (from the identity module); `null` means the
 * seats could not be lined up at all.
 */
export function compareFrameStates(previous: HandObservation, next: HandObservation, pairing: SeatPairing | null): StateDifference[] {
  const a = previous.recognition;
  const b = next.recognition;
  const out: StateDifference[] = [];
  let playerId: string | undefined;
  const push = (
    kind: DifferenceKind, field: string, label: string, from: RecognizedField<unknown>, to: RecognizedField<unknown>,
    severity: StateDifference['severity'] = 'info', warning?: string, values?: [unknown, unknown],
  ) => out.push({
    kind, field, label,
    previous: values ? values[0] : from.value, next: values ? values[1] : to.value,
    fromObservation: previous.id, toObservation: next.id,
    evidence: evidenceOf(from, to),
    confidence: { previous: from.confidence, next: to.confidence },
    severity,
    ...(warning ? { warning } : {}),
    ...(playerId ? { playerId } : {}),
  });
  const known = <T>(value: T | null): RecognizedField<T> => ({ value, confidence: null, source: 'observed' });

  // Table settings that are fixed for a hand.
  if (a.smallBlind.value !== null && b.smallBlind.value !== null && a.smallBlind.value !== b.smallBlind.value
    || a.bigBlind.value !== null && b.bigBlind.value !== null && a.bigBlind.value !== b.bigBlind.value) {
    push('blinds-changed', 'bigBlind', 'Blinds changed from ' + a.smallBlind.value + '/' + a.bigBlind.value + ' to ' + b.smallBlind.value + '/' + b.bigBlind.value + '.',
      a.bigBlind, b.bigBlind, 'contradiction', 'Blinds do not change during a hand.',
      [[a.smallBlind.value, a.bigBlind.value], [b.smallBlind.value, b.bigBlind.value]]);
  }

  // Board.
  const shared = Math.min(a.communityCards.length, b.communityCards.length);
  for (let i = 0; i < shared; i++) {
    const x = a.communityCards[i];
    const y = b.communityCards[i];
    if (x.value !== null && y.value !== null && x.value !== y.value) {
      push('board-card-changed', 'board.' + i, 'Board card ' + (i + 1) + ' changed from ' + x.value + ' to ' + y.value + '.', x, y, 'contradiction',
        'A dealt board card cannot change. One of the two readings is wrong, or these are different hands.');
    } else if (x.value === null && y.value !== null) {
      push('board-card-visible', 'board.' + i, 'Board card ' + (i + 1) + ' became readable: ' + y.value + '.', x, y);
    } else if (x.value !== null && y.value === null) {
      push('board-card-hidden', 'board.' + i, 'Board card ' + (i + 1) + ' (' + x.value + ') is not readable in the later screenshot.', x, y);
    }
  }
  if (b.communityCards.length < a.communityCards.length) {
    push('board-shrank', 'board', 'The board went from ' + a.communityCards.length + ' to ' + b.communityCards.length + ' cards.',
      known(a.communityCards.length), known(b.communityCards.length), 'contradiction', 'Board cards are never removed during a hand.');
  } else if (b.communityCards.length > a.communityCards.length) {
    const added = b.communityCards.slice(a.communityCards.length);
    const streets = [...new Set(added.map((_, j) => BOARD_STREET[a.communityCards.length + j] ?? 'river'))];
    const joined = streets.length < 3 ? streets.join(' and ') : streets.slice(0, -1).join(', ') + ', and ' + streets[streets.length - 1];
    const name = joined[0].toUpperCase() + joined.slice(1);
    push('board-dealt', 'board', name + ' dealt: ' + cardList(added.map(c => c.value)) + '.',
      known(a.communityCards.length), known(b.communityCards.length), 'info',
      streets.length > 1 ? 'More than one street was dealt between these screenshots; betting on the skipped street is not shown.' : undefined,
      [a.communityCards.map(c => c.value), b.communityCards.map(c => c.value)]);
  }

  // Street.
  if (a.street.value && b.street.value && a.street.value !== b.street.value) {
    const back = STREET_ORDER[b.street.value] < STREET_ORDER[a.street.value];
    push(back ? 'street-reversed' : 'street-changed', 'street', 'Street changed from ' + a.street.value + ' to ' + b.street.value + '.', a.street, b.street,
      back ? 'contradiction' : 'info', back ? 'A hand never goes back to an earlier street.' : undefined);
  }

  // Pot: compare all chips in the middle when both are fully known.
  const ma = middleChips(a);
  const mb = middleChips(b);
  if (ma !== null && mb !== null && ma !== mb) {
    push('pot-changed', 'pot', mb > ma
      ? 'Chips in the middle grew from ' + ma + ' to ' + mb + ' (+' + (mb - ma) + ').'
      : 'Chips in the middle fell from ' + ma + ' to ' + mb + '.',
    a.pot, b.pot, mb > ma ? 'info' : 'review',
    mb > ma ? undefined : 'Chips leave the middle only when a pot is awarded or an uncalled bet is returned.', [ma, mb]);
  } else if ((ma === null || mb === null) && a.pot.value !== null && b.pot.value !== null && a.pot.value !== b.pot.value) {
    push('pot-changed', 'pot', 'The pot shown changed from ' + a.pot.value + ' to ' + b.pot.value + '.', a.pot, b.pot,
      b.pot.value > a.pot.value ? 'info' : 'review', 'Some bets are unknown, so the full chip movement cannot be checked.');
  } else if (a.pot.value === null && b.pot.value !== null) {
    push('value-visible', 'pot', 'The pot became readable: ' + b.pot.value + '.', a.pot, b.pot);
  } else if (a.pot.value !== null && b.pot.value === null) {
    push('value-hidden', 'pot', 'The pot (' + a.pot.value + ') is not readable in the later screenshot.', a.pot, b.pot);
  }

  // Seats.
  const n = a.players.length;
  if (!pairing) {
    if (n !== b.players.length) {
      push('seat-count-changed', 'players', 'The number of seats changed from ' + n + ' to ' + b.players.length + '.',
        known(n), known(b.players.length), 'contradiction', 'Players do not join or leave during a hand. Check for a missed seat, or these are different hands.');
    } else {
      push('seats-moved', 'players', 'The seat names do not line up between these screenshots.',
        known(a.players.map(p => p.name.value)), known(b.players.map(p => p.name.value)), 'contradiction',
        'Names were misread, or these screenshots show different tables or hands.');
    }
    return out;
  }
  const moved = pairing.pairs.filter(x => x.prev !== x.next);
  if (moved.length) {
    const shifts = new Set(pairing.pairs.map(x => (x.prev - x.next + n) % n));
    const rotation = shifts.size === 1 && n === b.players.length ? [...shifts][0] : null;
    push('seats-moved', 'players', rotation !== null
      ? 'The seats appear rotated by ' + rotation + ' position' + (rotation === 1 ? '' : 's') + ', matched by player.'
      : 'Some players are shown in different seats; they are matched by player.',
    known(null), known(moved.length), 'review', 'The client may have moved the view. Changes below use the earlier frame’s seat numbers.');
  }
  const nameOf = (id: string | null) => {
    if (!id) return 'an unknown player';
    const pair = pairing.pairs.find(x => x.playerId === id);
    if (pair) return seatName(a, pair.prev);
    const gone = pairing.gone.find(x => x.playerId === id);
    if (gone) return seatName(a, gone.seat);
    const arrived = pairing.arrived.find(x => x.playerId === id);
    return arrived ? seatName(b, arrived.seat) : 'another player';
  };

  // Dealer: compare the players holding the button, not the seat numbers.
  const [dealerBefore, dealerAfter] = pairing.dealer;
  if (dealerBefore && dealerAfter && dealerBefore !== dealerAfter) {
    push('dealer-moved', 'dealerSeat', 'The dealer button moved from ' + nameOf(dealerBefore) + ' to ' + nameOf(dealerAfter) + '.',
      a.dealerSeat, b.dealerSeat, 'contradiction', 'The button does not move during a hand; this suggests a new hand.', [dealerBefore, dealerAfter]);
  }

  for (const pair of pairing.pairs) {
    const i = pair.prev;
    const p = a.players[i];
    const q = b.players[pair.next];
    const who = seatName(a, i);
    const base = 'players.' + i;
    playerId = pair.playerId;

    if (p.stack.value !== null && q.stack.value !== null && p.stack.value !== q.stack.value) {
      const up = q.stack.value > p.stack.value;
      push('stack-changed', base + '.stack', possessive(who) + ' stack ' + (up ? 'grew' : 'fell') + ' from ' + p.stack.value + ' to ' + q.stack.value
        + ' (' + (up ? '+' : '−') + Math.abs(q.stack.value - p.stack.value) + ').', p.stack, q.stack,
      up ? 'review' : 'info', up ? 'A stack grows only from a pot award or a returned uncalled bet.' : undefined);
    } else if (p.stack.value === null && q.stack.value !== null) {
      push('value-visible', base + '.stack', possessive(who) + ' stack became readable: ' + q.stack.value + '.', p.stack, q.stack);
    } else if (p.stack.value !== null && q.stack.value === null && q.status.value !== 'folded') {
      push('value-hidden', base + '.stack', possessive(who) + ' stack (' + p.stack.value + ') is not readable in the later screenshot.', p.stack, q.stack);
    }

    if (p.bet.value !== null && q.bet.value !== null && p.bet.value !== q.bet.value) {
      push('bet-changed', base + '.bet', possessive(who) + ' bet in front changed from ' + p.bet.value + ' to ' + q.bet.value + '.', p.bet, q.bet);
    }

    if (p.status.value === 'active' && q.status.value === 'folded') {
      push('status-changed', base + '.status', subjectIs(who) + ' shown as folded.', p.status, q.status);
    } else if (p.status.value === 'folded' && q.status.value === 'active') {
      push('unfolded', base + '.status', (who.toLowerCase() === 'you' ? 'You were' : who + ' was') + ' folded and ' + (who.toLowerCase() === 'you' ? 'are' : 'is') + ' now shown in the hand.', p.status, q.status, 'contradiction',
        'A folded player cannot return to the hand. A status was misread, or these are different hands.');
    }

    // Hole cards.
    if (p.cards.length === 2 && q.cards.length === 2) {
      const revealed: string[] = [];
      for (let j = 0; j < 2; j++) {
        const x = p.cards[j];
        const y = q.cards[j];
        if (x.value !== null && y.value !== null && x.value !== y.value) {
          push('hole-card-changed', base + '.cards.' + j, possessive(who) + ' card ' + (j + 1) + ' changed from ' + x.value + ' to ' + y.value + '.', x, y, 'contradiction',
            'Hole cards do not change during a hand. One reading is wrong, or these are different hands.');
        } else if (x.value === null && y.value !== null) {
          revealed.push(y.value);
        }
      }
      if (revealed.length) {
        push('hole-cards-visible', base + '.cards', subjectVerb(who, 'show') + ' ' + revealed.join(' ') + '.', p.cards[0], q.cards[0], 'info', undefined,
          [p.cards.map(c => c.value), q.cards.map(c => c.value)]);
      }
      const hidden = p.cards.filter((c, j) => c.value !== null && q.cards[j].value === null);
      if (hidden.length) {
        push('hole-cards-hidden', base + '.cards', possessive(who) + ' ' + cardList(hidden.map(c => c.value)) + ' is no longer visible.', hidden[0], q.cards[0]);
      }
    } else if (p.cards.length === 0 && q.cards.length === 2 && q.cards.some(c => c.value !== null)) {
      push('hole-cards-visible', base + '.cards', subjectVerb(who, 'show') + ' ' + cardList(q.cards.map(c => c.value)) + '.', known(null), q.cards[0], 'info', undefined,
        [[], q.cards.map(c => c.value)]);
    } else if (p.cards.length === 2 && q.cards.length === 0 && q.status.value !== 'folded' && p.cards.some(c => c.value !== null)) {
      push('hole-cards-hidden', base + '.cards', possessive(who) + ' cards are no longer shown.', p.cards[0], known(null));
    }

    if (p.stack.value !== null && p.stack.value > 0 && q.stack.value === 0 && q.status.value !== 'folded') {
      push('all-in', base + '.stack', (who.toLowerCase() === 'you' ? 'You are' : who + ' is') + ' all-in.', p.stack, q.stack);
    }
  }
  playerId = undefined;

  // Presence: a player out of view is not a fold.
  for (const g of pairing.gone) {
    playerId = g.playerId;
    push('player-hidden', 'players.' + g.seat, seatName(a, g.seat) + (g.acknowledged ? ' is marked as not visible in the later frame.' : ' is not visible in the later frame.'),
      known(g.seat), known(null), 'info', g.acknowledged ? undefined : 'Not counted as a fold. Their chips cannot be checked in the later frame.');
  }
  for (const x of pairing.arrived) {
    playerId = x.playerId;
    if (x.firstSeen) {
      push('player-appeared', 'later.players.' + x.seat, seatName(b, x.seat) + ' appears for the first time.', known(null), known(x.seat), 'review',
        'Players do not join during a hand. An earlier frame may have missed this seat, a name may be misread, or these are different hands.');
    } else {
      push('player-visible', 'later.players.' + x.seat, seatName(b, x.seat) + ' is visible again.', known(null), known(x.seat));
    }
  }
  playerId = undefined;
  for (const seat of pairing.unmatched) {
    push('player-unmatched', 'later.players.' + seat, seatName(b, seat) + ' in the later frame is not matched to a player yet.', known(null), known(seat), 'review',
      'Match the seat to a player, or mark it as someone new, to compare it.');
  }
  return out;
}
