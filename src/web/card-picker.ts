// The shared card picker dialog, used by the study table and the screenshot
// review screen. Cards already in use elsewhere are disabled.
import { standardDeck } from '../core/cards.js';
import type { Card } from '../core/types.js';
import { cardName, renderCardFace, suitNames } from './cards-view.js';

export type PickResult =
  | { readonly kind: 'card'; readonly card: Card }
  | { readonly kind: 'clear' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PickRequest {
  readonly title: string;
  readonly note: string;
  readonly current: Card | null;
  /** Cards shown elsewhere; they cannot be picked. */
  readonly used: ReadonlySet<Card>;
  /** Offer "Keep this card" for a card that needs confirming. */
  readonly canConfirm: boolean;
  /** Text for the button that empties the slot. */
  readonly clearLabel?: string;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: ' + id);
  return node as T;
}

let pending: { resolve: (result: PickResult) => void; opener: HTMLElement | null } | null = null;
let wired = false;

function settle(result: PickResult) {
  if (!pending) return;
  const { resolve, opener } = pending;
  pending = null;
  if (result.kind === 'cancel') opener?.focus();
  resolve(result);
}

function wire(dialog: HTMLDialogElement) {
  if (wired) return;
  wired = true;
  // Resolve on submit, which runs synchronously, rather than waiting for the
  // close event; `close` only covers Escape and other dismissals.
  dialog.querySelector('form')?.addEventListener('submit', event => {
    const value = (event.submitter as HTMLButtonElement | null)?.value ?? 'cancel';
    if (value.startsWith('card:')) settle({ kind: 'card', card: value.slice(5) });
    else if (value === 'clear') settle({ kind: 'clear' });
    else if (value === 'confirm') settle({ kind: 'confirm' });
    else settle({ kind: 'cancel' });
  });
  dialog.addEventListener('close', () => settle({ kind: 'cancel' }));
}

/** Open the picker and resolve with the user's choice. */
export function pickCard(request: PickRequest): Promise<PickResult> {
  const dialog = element<HTMLDialogElement>('picker');
  const grid = element('picker-grid');
  wire(dialog);
  settle({ kind: 'cancel' });
  element('picker-title').textContent = request.title;
  element('picker-note').textContent = request.note;
  element<HTMLButtonElement>('picker-confirm').hidden = !request.canConfirm;
  const clear = dialog.querySelector<HTMLButtonElement>('button[value=clear]');
  if (clear) clear.textContent = request.clearLabel ?? 'Empty this slot';

  grid.replaceChildren(...[...'shdc'].map(suit => {
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', suitNames[suit]);
    for (const card of standardDeck.filter(c => c[1] === suit).reverse()) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.value = 'card:' + card;
      button.className = 'pick';
      const used = request.used.has(card) && card !== request.current;
      button.setAttribute('aria-label', cardName(card) + (used ? ', already in use' : ''));
      button.disabled = used;
      if (card === request.current) button.setAttribute('aria-pressed', 'true');
      renderCardFace(button, card);
      row.append(button);
    }
    return row;
  }));
  const promise = new Promise<PickResult>(resolve => {
    pending = { resolve, opener: document.activeElement as HTMLElement | null };
  });
  dialog.returnValue = '';
  dialog.showModal();
  (grid.querySelector<HTMLButtonElement>('[aria-pressed=true]') ?? grid.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  return promise;
}
