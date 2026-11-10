// Card names and faces shared by the study table and the replay table.
import type { Card } from '../core/types.js';

const rankNames: Record<string, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine',
  T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace',
};
export const suitNames: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
export const suitSymbols: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export const cardName = (card: Card) => rankNames[card[0]] + ' of ' + suitNames[card[1]];
export const rankLabel = (card: Card) => (card[0] === 'T' ? '10' : card[0]);

/** Fill `node` with a card's rank and suit, colored by suit. */
export function renderCardFace(node: HTMLElement, card: Card) {
  node.classList.add(card[1] === 'h' || card[1] === 'd' ? 'red' : 'black');
  const rank = document.createElement('span');
  rank.className = 'rank';
  rank.textContent = rankLabel(card);
  const suit = document.createElement('span');
  suit.className = 'suit';
  suit.textContent = suitSymbols[card[1]];
  node.append(rank, suit);
}
