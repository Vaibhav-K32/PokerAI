// The review-and-correct form for one recognized screenshot, shared by
// Import screenshot and Reconstruct hand. Every field is editable; each edit
// produces a new recognition (marked as corrected) and is re-checked.
import type { Card } from '../core/types.js';
import {
  corrected, correctedCard, indicator, indicatorLabels, inferStreet, reviewScreenshot,
  type RecognizedCard, type RecognizedField, type RecognizedPlayer, type ReviewIssue, type ScreenshotRecognition, type Street,
} from '../vision/screenshot.js';
import { pickCard } from './card-picker.js';
import { cardName, renderCardFace } from './cards-view.js';

const MAX_SEATS = 10;
const unknown = <T>(): RecognizedField<T> => corrected<T>(null);

function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

/**
 * Draw the summary of problems and the editable table, board, and seats into
 * `parent`. `change` receives the corrected recognition after each edit; the
 * caller redraws. `group` keeps radio-button names unique on the page.
 * Returns the review issues for the recognition as drawn.
 */
export function renderRecognitionEditor(
  parent: HTMLElement, rec: ScreenshotRecognition, change: (next: ScreenshotRecognition) => void, group: string,
): ReviewIssue[] {
  const r = rec;
  const issues = reviewScreenshot(r);
  const update = (edit: (x: ScreenshotRecognition) => ScreenshotRecognition) => change(edit(r));
  const updatePlayer = (index: number, edit: (p: RecognizedPlayer) => RecognizedPlayer) =>
    update(x => ({ ...x, players: x.players.map((p, i) => (i === index ? edit(p) : p)) }));

  function badge(host: HTMLElement, field: RecognizedField<unknown>, path: string) {
    const level = issues.some(i => i.field === path && i.severity === 'error') ? 'error' : indicator(field);
    const text = level === 'error' ? 'Conflict' : indicatorLabels[level];
    const note = field.source === 'inferred' ? ' · inferred' : field.source === 'corrected' ? ' · edited' : '';
    add(host, 'span', text + note, 'indicator ind-' + level);
  }

  function numberField(host: HTMLElement, label: string, field: RecognizedField<number>, path: string, set: (f: RecognizedField<number>) => void) {
    const wrap = add(host, 'label', '', 'review-field');
    add(wrap, 'span', label, 'review-label');
    const input = add(wrap, 'input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.inputMode = 'numeric';
    input.placeholder = 'Unknown';
    input.value = field.value === null ? '' : String(field.value);
    badge(wrap, field, path);
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const value = text === '' ? null : Number(text);
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        input.setCustomValidity('Use a whole number of chips, or leave it blank for unknown.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      set(corrected(value));
    });
  }

  function usedCards(except: RecognizedCard) {
    const used = new Set<Card>();
    for (const c of [...r.communityCards, ...r.players.flatMap(p => p.cards)]) if (c !== except && c.value) used.add(c.value);
    return used;
  }

  function cardButton(host: HTMLElement, card: RecognizedCard, label: string, path: string, set: (c: RecognizedCard) => void) {
    const wrap = add(host, 'div', '', 'review-card');
    const button = add(wrap, 'button', '', 'card-slot' + (card.value ? ' filled' : ''));
    button.type = 'button';
    if (card.value) {
      const face = add(button, 'span', '', 'face');
      renderCardFace(face, card.value);
    } else {
      add(button, 'span', card.hidden ? 'back' : '?', 'hint');
    }
    const state = card.value ? cardName(card.value) : card.hidden ? 'face-down' : 'unknown';
    button.setAttribute('aria-label', label + ': ' + state + '. Edit.');
    badge(wrap, card, path);
    button.addEventListener('click', async () => {
      const result = await pickCard({
        title: label,
        note: card.value ? 'Read as ' + cardName(card.value) + '. Keep it, pick the correct card, or mark it unknown.' : 'Pick the card you see, or leave it unknown.',
        current: card.value,
        used: usedCards(card),
        canConfirm: !!card.value,
        clearLabel: 'Mark as unknown',
      });
      if (result.kind === 'card') set(correctedCard(result.card));
      else if (result.kind === 'clear') set(correctedCard(null, card.hidden));
      else if (result.kind === 'confirm') set(correctedCard(card.value));
    });
  }

  function renderSeat(host: HTMLElement, p: RecognizedPlayer, i: number) {
    const seat = add(host, 'fieldset', '', 'review-seat' + (r.heroSeat.value === i ? ' is-hero' : ''));
    add(seat, 'legend', 'Seat ' + (i + 1) + (p.name.value ? ' · ' + p.name.value : ''));
    const top = add(seat, 'div', '', 'review-row');
    const nameWrap = add(top, 'label', '', 'review-field');
    add(nameWrap, 'span', 'Name', 'review-label');
    const name = add(nameWrap, 'input');
    name.value = p.name.value ?? '';
    name.placeholder = 'Unknown';
    name.maxLength = 60;
    badge(nameWrap, p.name, 'players.' + i + '.name');
    name.addEventListener('change', () => updatePlayer(i, x => ({ ...x, name: corrected(name.value.trim() || null) })));
    const statusWrap = add(top, 'label', '', 'review-field');
    add(statusWrap, 'span', 'Status', 'review-label');
    const status = add(statusWrap, 'select');
    for (const [value, text] of [['', 'Unknown'], ['active', 'In the hand'], ['folded', 'Folded']]) {
      const option = add(status, 'option', text);
      option.value = value;
    }
    status.value = p.status.value ?? '';
    badge(statusWrap, p.status, 'players.' + i + '.status');
    status.addEventListener('change', () => updatePlayer(i, x => ({ ...x, status: corrected((status.value || null) as 'active' | 'folded' | null) })));

    const chips = add(seat, 'div', '', 'review-row');
    numberField(chips, 'Stack', p.stack, 'players.' + i + '.stack', f => updatePlayer(i, x => ({ ...x, stack: f })));
    numberField(chips, 'Bet this street', p.bet, 'players.' + i + '.bet', f => updatePlayer(i, x => ({ ...x, bet: f })));

    const roles = add(seat, 'div', '', 'review-row roles');
    const radio = (label: string, name: string, checked: boolean, select: () => void) => {
      const wrap = add(roles, 'label', '', 'checkbox');
      const input = add(wrap, 'input');
      input.type = 'radio';
      input.name = name;
      input.checked = checked;
      wrap.append(' ' + label);
      input.addEventListener('change', select);
    };
    radio('This is me', group + '-hero', r.heroSeat.value === i, () => update(x => ({ ...x, heroSeat: corrected(i) })));
    radio('Dealer button', group + '-dealer', r.dealerSeat.value === i, () => update(x => ({ ...x, dealerSeat: corrected(i) })));

    const cards = add(seat, 'div', '', 'review-cards');
    if (!p.cards.length) {
      add(cards, 'p', 'No cards shown.', 'fine-print');
      const addCards = add(cards, 'button', 'Add two cards', 'secondary');
      addCards.type = 'button';
      addCards.addEventListener('click', () => updatePlayer(i, x => ({ ...x, cards: [correctedCard(null, true), correctedCard(null, true)] })));
    } else {
      p.cards.forEach((c, j) => cardButton(cards, c, (p.name.value ?? 'Seat ' + (i + 1)) + ' card ' + (j + 1), 'players.' + i + '.cards.' + j,
        next => updatePlayer(i, x => ({ ...x, cards: x.cards.map((cc, k) => (k === j ? next : cc)) }))));
      const removeCards = add(cards, 'button', 'No cards', 'secondary');
      removeCards.type = 'button';
      removeCards.addEventListener('click', () => updatePlayer(i, x => ({ ...x, cards: [] })));
    }
  }

  // Summary
  const errors = issues.filter(i => i.severity === 'error');
  const reviews = issues.filter(i => i.severity === 'review');
  const summary = add(parent, 'div', '', 'review-summary' + (errors.length ? ' has-errors' : ''));
  summary.setAttribute('role', 'status');
  add(summary, 'p', errors.length
    ? errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ' must be fixed before saving or importing.'
    : reviews.length ? 'No conflicts. ' + reviews.length + ' field' + (reviews.length === 1 ? '' : 's') + ' to check.' : 'Everything is filled in and consistent.');
  if (issues.length) {
    const list = add(summary, 'ul');
    for (const issue of issues) add(list, 'li', (issue.severity === 'error' ? 'Fix: ' : 'Check: ') + issue.message, 'issue-' + issue.severity);
  }
  if (r.warnings.length) {
    const notes = add(summary, 'p', 'Reader notes: ' + r.warnings.join(' '), 'fine-print');
    notes.setAttribute('aria-label', 'Notes from the recognizer');
  }
  add(summary, 'p', 'Read by ' + (r.providerId === 'claude' ? 'Claude' + (r.modelId ? ' (' + r.modelId + ')' : '') : 'sample data')
    + '. Confidence labels are the reader’s own and are not calibrated probabilities.', 'fine-print');

  // Table fields
  const table = add(parent, 'fieldset', '', 'review-section');
  add(table, 'legend', 'Table');
  const streetWrap = add(table, 'label', '', 'review-field');
  add(streetWrap, 'span', 'Street', 'review-label');
  const street = add(streetWrap, 'select');
  for (const value of ['', 'preflop', 'flop', 'turn', 'river']) {
    const option = add(street, 'option', value ? value[0].toUpperCase() + value.slice(1) : 'Unknown');
    option.value = value;
  }
  street.value = r.street.value ?? '';
  badge(streetWrap, r.street, 'street');
  street.addEventListener('change', () => update(x => ({ ...x, street: street.value ? corrected(street.value as Street) : inferStreet(x.communityCards) })));
  numberField(table, 'Pot', r.pot, 'pot', f => update(x => ({ ...x, pot: f })));
  const includes = add(table, 'label', '', 'checkbox');
  const box = add(includes, 'input');
  box.type = 'checkbox';
  box.checked = r.potIncludesBets;
  includes.append(' The pot shown already includes the bets in front of players');
  box.addEventListener('change', () => update(x => ({ ...x, potIncludesBets: box.checked })));
  const blinds = add(table, 'div', '', 'review-row');
  numberField(blinds, 'Small blind', r.smallBlind, 'smallBlind', f => update(x => ({ ...x, smallBlind: f })));
  numberField(blinds, 'Big blind', r.bigBlind, 'bigBlind', f => update(x => ({ ...x, bigBlind: f })));

  // Board
  const board = add(parent, 'fieldset', '', 'review-section');
  add(board, 'legend', 'Community cards');
  const boardCards = add(board, 'div', '', 'review-cards');
  r.communityCards.forEach((c, i) => cardButton(boardCards, c, 'Board card ' + (i + 1), 'board.' + i,
    next => update(x => ({ ...x, communityCards: x.communityCards.map((cc, j) => (j === i ? next : cc)) }))));
  if (!r.communityCards.length) add(boardCards, 'p', 'No community cards.', 'fine-print');
  const boardActions = add(board, 'div', '', 'actions small-actions');
  const addCard = add(boardActions, 'button', 'Add board card', 'secondary');
  addCard.type = 'button';
  addCard.disabled = r.communityCards.length >= 5;
  addCard.addEventListener('click', () => update(x => ({ ...x, communityCards: [...x.communityCards, correctedCard(null)] })));
  const removeCard = add(boardActions, 'button', 'Remove last board card', 'secondary');
  removeCard.type = 'button';
  removeCard.disabled = !r.communityCards.length;
  removeCard.addEventListener('click', () => update(x => ({ ...x, communityCards: x.communityCards.slice(0, -1) })));

  // Seats
  const seats = add(parent, 'fieldset', '', 'review-section');
  add(seats, 'legend', 'Seats (clockwise from the bottom)');
  r.players.forEach((p, i) => renderSeat(seats, p, i));
  const seatActions = add(seats, 'div', '', 'actions small-actions');
  const addSeat = add(seatActions, 'button', 'Add seat', 'secondary');
  addSeat.type = 'button';
  addSeat.disabled = r.players.length >= MAX_SEATS;
  addSeat.addEventListener('click', () => update(x => ({
    ...x,
    players: [...x.players, { name: unknown(), stack: unknown(), bet: unknown(), status: unknown(), cards: [correctedCard(null, true), correctedCard(null, true)] }],
  })));
  const removeSeat = add(seatActions, 'button', 'Remove last seat', 'secondary');
  removeSeat.type = 'button';
  removeSeat.disabled = r.players.length <= 2;
  removeSeat.addEventListener('click', () => update(x => {
    const last = x.players.length - 1;
    const keep = (f: RecognizedField<number>) => (f.value === last ? unknown<number>() : f);
    return { ...x, players: x.players.slice(0, -1), dealerSeat: keep(x.dealerSeat), heroSeat: keep(x.heroSeat) };
  }));
  return issues;
}
