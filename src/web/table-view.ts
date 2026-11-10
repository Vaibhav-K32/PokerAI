// The read-only poker table shared by hand replay and hand reconstruction:
// seats with badges, hole cards, stacks and bets, and the board. Unknown
// values are drawn as unknown; edited values are marked.
import type { Card } from '../core/types.js';
import { cardName, renderCardFace } from './cards-view.js';

export interface TableSeat {
  readonly name: string;
  readonly badges: readonly string[];
  readonly status: 'active' | 'folded' | 'all-in' | 'unknown';
  readonly acting?: boolean;
  /** `null` is an unknown card. An empty list means no cards are shown. */
  readonly cards: readonly (Card | null)[];
  readonly stack: number | null;
  readonly bet: number | null;
  /** Fields the user corrected: any of `stack`, `bet`, `cards`, `status`, `name`. */
  readonly edited?: readonly string[];
}

function add(parent: HTMLElement, tag: string, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

const chips = (n: number | null) => (n === null ? '?' : n.toLocaleString());

export function renderSeat(seat: TableSeat): HTMLElement {
  const node = document.createElement('div');
  node.className = 'replay-seat ' + seat.status + (seat.acting ? ' acting' : '');
  const edited = new Set(seat.edited ?? []);
  const name = add(node, 'p', seat.name, 'seat-name' + (edited.has('name') ? ' edited' : ''));
  for (const badge of seat.badges) add(name, 'span', badge, 'seat-badge badge-' + badge.toLowerCase().replace(/[^a-z]/g, ''));
  const cards = add(node, 'div', '', 'cards mini-cards' + (edited.has('cards') ? ' edited' : ''));
  seat.cards.forEach(card => {
    const slot = add(cards, 'span', '', 'mini-card' + (card ? ' face' : ' back'));
    if (card) {
      renderCardFace(slot, card);
      slot.setAttribute('aria-label', cardName(card));
    } else {
      slot.textContent = '?';
      slot.setAttribute('aria-label', 'Unknown card');
    }
  });
  add(node, 'p', 'Stack ' + chips(seat.stack), 'seat-stack' + (edited.has('stack') ? ' edited' : '') + (seat.stack === null ? ' unknown-value' : ''));
  add(node, 'p', seat.bet === null ? 'Bet ?' : seat.bet ? 'Bet ' + seat.bet.toLocaleString() : ' ', 'seat-bet' + (edited.has('bet') ? ' edited' : ''));
  const status = seat.status === 'folded' ? 'folded' : seat.status === 'all-in' ? 'all-in' : seat.status === 'unknown' ? 'status unknown' : 'in the hand';
  node.setAttribute('aria-label', seat.name + ', ' + seat.badges.join(', ') + (seat.badges.length ? ', ' : '') + status
    + ', stack ' + (seat.stack ?? 'unknown') + (seat.bet ? ', bet ' + seat.bet : seat.bet === null ? ', bet unknown' : '')
    + (seat.cards.length ? ', cards ' + seat.cards.map(c => (c ? cardName(c) : 'unknown')).join(' and ') : ', no cards shown')
    + (edited.size ? ', edited: ' + [...edited].join(', ') : ''));
  node.setAttribute('role', 'group');
  return node;
}

/** Five board slots; `null` entries inside the dealt part are unknown cards. */
export function renderBoard(container: HTMLElement, board: readonly (Card | null)[]) {
  container.replaceChildren(...Array.from({ length: 5 }, (_, i) => {
    const slot = document.createElement('span');
    const card = board[i];
    slot.className = 'card-slot' + (card ? ' filled' : '');
    if (card) {
      const face = add(slot, 'span', '', 'face');
      renderCardFace(face, card);
      slot.setAttribute('aria-label', cardName(card));
    } else if (i < board.length) {
      add(slot, 'span', '?', 'hint');
      slot.setAttribute('aria-label', 'Unknown board card');
    } else {
      slot.setAttribute('aria-hidden', 'true');
    }
    return slot;
  }));
}

/** Seats clockwise: the first half across the top, the rest back along the bottom. */
export function renderSeats(top: HTMLElement, bottom: HTMLElement, seats: readonly TableSeat[]) {
  const half = Math.ceil(seats.length / 2);
  top.replaceChildren(...seats.slice(0, half).map(renderSeat));
  bottom.replaceChildren(...seats.slice(half).reverse().map(renderSeat));
}
