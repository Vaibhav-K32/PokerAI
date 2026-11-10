// Import screenshot: upload, recognition, review and correction, then load,
// save, attach to a saved hand, or open in hand review. A failed or cancelled
// scan never touches the study table; only "Load into study table" does.
import type { Card, Snapshot } from '../core/types.js';
import { createHandState, replaySteps } from '../history/engine.js';
import { withAttachment, type HandHistory } from '../history/history.js';
import { matchObservation } from '../history/observation.js';
import { claudeScreenshotProvider, fixtureProvider, type ScreenshotProvider } from '../vision/providers.js';
import { drawTable, fixtureById, SCREENSHOT_FIXTURES } from '../vision/screenshot-fixtures.js';
import {
  corrected, correctedCard, hasBlockingIssues, indicator, indicatorLabels, inferStreet, reviewScreenshot,
  toStudySnapshot, toTableObservation,
  type RecognizedCard, type RecognizedField, type RecognizedPlayer, type ReviewIssue, type ScreenshotRecognition, type Street,
} from '../vision/screenshot.js';
import { pickCard } from './card-picker.js';
import { cardName, renderCardFace } from './cards-view.js';
import { loadHands, saveHands } from './hand-store.js';
import { decodeImage, fileProblem, prepareUpload, svgToPng } from './image.js';
import type { ReplayController } from './replay.js';
import { loadScreenshots, saveScreenshots, type SavedScreenshot } from './screenshot-store.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: ' + id);
  return node as T;
}

function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

const MAX_SEATS = 10;
const unknown = <T>(): RecognizedField<T> => corrected<T>(null);

export function initScreenshotImport(options: { loadIntoTable: (snapshot: Snapshot) => void; replay: ReplayController }) {
  const status = element('shot-status');
  const warnings = element('shot-warnings');
  const readButton = element<HTMLButtonElement>('shot-read');
  const cancelButton = element<HTMLButtonElement>('shot-cancel');
  const clearButton = element<HTMLButtonElement>('shot-clear');
  const fileInput = element<HTMLInputElement>('shot-file');
  const sample = element<HTMLSelectElement>('shot-sample');
  const drop = element('shot-drop');
  const previewBox = element('shot-preview-box');
  const preview = element<HTMLImageElement>('shot-preview');
  const reviewPanel = element('shot-review');
  const reviewImage = element<HTMLImageElement>('shot-review-image');
  const zoom = element<HTMLInputElement>('shot-zoom');
  const statePanel = element('shot-state');

  for (const f of SCREENSHOT_FIXTURES) {
    const option = add(sample, 'option', f.label);
    option.value = f.id;
  }

  let image: { file: File; bitmap: ImageBitmap; url: string; provider: ScreenshotProvider; label: string } | null = null;
  let request: AbortController | null = null;
  let rec: ScreenshotRecognition | null = null;
  /** Image shown in review: the current upload, or a saved data URL. */
  let reviewSource: string | null = null;
  let savedId: string | null = null;
  let saved: SavedScreenshot[] = [];
  /** Outcome of the last load, save, or attach; survives redraws until the next edit. */
  let notice = '';

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------
  function releaseImage() {
    if (image) {
      image.bitmap.close();
      URL.revokeObjectURL(image.url);
    }
    image = null;
    preview.removeAttribute('src');
    previewBox.hidden = true;
    readButton.disabled = true;
    clearButton.hidden = true;
  }

  async function useFile(file: File, provider: ScreenshotProvider, label: string) {
    cancel();
    const problem = fileProblem(file);
    if (problem) {
      status.textContent = problem;
      return;
    }
    status.textContent = 'Opening the image on this device…';
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeImage(file);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'This image could not be opened.';
      return;
    }
    releaseImage();
    const url = URL.createObjectURL(file);
    image = { file, bitmap, url, provider, label };
    preview.src = url;
    previewBox.hidden = false;
    element('shot-preview-caption').textContent = label + ' · ' + bitmap.width + '×' + bitmap.height
      + (provider.id === 'claude' ? '' : ' · sample data, no API call');
    element('shot-consent').hidden = provider.id !== 'claude';
    readButton.disabled = false;
    readButton.textContent = 'Read table';
    clearButton.hidden = false;
    status.textContent = 'Ready. Press Read table to recognize it.';
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    sample.value = '';
    if (file) void useFile(file, claudeScreenshotProvider(), file.name);
  });
  sample.addEventListener('change', async () => {
    const fixture = fixtureById(sample.value);
    if (!fixture) return;
    try {
      const file = await svgToPng(drawTable(fixture.table), fixture.id + '.png');
      await useFile(file, fixtureProvider(fixture.response, 'sample:' + fixture.id), 'Sample: ' + fixture.label);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The sample could not be drawn.';
    }
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    sample.value = '';
    if (file) void useFile(file, claudeScreenshotProvider(), file.name);
  });
  drop.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  function cancel() {
    request?.abort();
    request = null;
    cancelButton.hidden = true;
    drop.classList.remove('busy');
  }

  cancelButton.addEventListener('click', () => {
    cancel();
    status.textContent = 'Recognition cancelled. Your study table is unchanged.';
    readButton.disabled = !image;
  });

  clearButton.addEventListener('click', () => {
    cancel();
    releaseImage();
    sample.value = '';
    status.textContent = '';
    warnings.hidden = true;
  });

  readButton.addEventListener('click', async () => {
    if (!image) return;
    const source = image;
    cancel();
    const controller = new AbortController();
    request = controller;
    readButton.disabled = true;
    cancelButton.hidden = false;
    drop.classList.add('busy');
    warnings.hidden = true;
    status.textContent = 'Preparing the image…';
    try {
      const upload = await prepareUpload(source.bitmap);
      if (controller.signal.aborted) return;
      status.textContent = source.provider.id === 'claude' ? 'Reading the table with Claude… this can take up to a minute.' : 'Reading the sample…';
      const outcome = await source.provider.recognize(upload, controller.signal);
      if (controller.signal.aborted || image !== source) return;
      if (outcome.kind === 'cancelled') {
        status.textContent = 'Recognition cancelled. Your study table is unchanged.';
      } else if (outcome.kind === 'failed') {
        status.textContent = outcome.reason + ' Your study table is unchanged.';
        readButton.textContent = outcome.retryable ? 'Try again' : 'Read table';
      } else {
        savedId = null;
        reviewSource = source.url;
        showReview(outcome.recognition);
        status.textContent = 'Recognized. Check the review below; nothing is loaded until you choose to.';
      }
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = (error instanceof Error ? error.message : 'Recognition failed.') + ' Your study table is unchanged.';
    } finally {
      if (request === controller) {
        request = null;
        cancelButton.hidden = true;
        drop.classList.remove('busy');
        readButton.disabled = !image;
      }
    }
  });

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------
  function showReview(recognition: ScreenshotRecognition) {
    rec = recognition;
    notice = '';
    reviewPanel.hidden = false;
    if (reviewSource) reviewImage.src = reviewSource;
    else reviewImage.removeAttribute('src');
    reviewImage.hidden = !reviewSource;
    zoom.value = '1';
    applyZoom();
    renderReview();
    element('review-title').scrollIntoView({ block: 'start' });
  }

  function applyZoom() {
    const level = Number(zoom.value);
    reviewImage.style.width = level * 100 + '%';
    element('shot-zoom-value').textContent = Math.round(level * 100) + '%';
  }
  zoom.addEventListener('input', applyZoom);

  function update(change: (r: ScreenshotRecognition) => ScreenshotRecognition) {
    if (!rec) return;
    notice = '';
    rec = change(rec);
    renderReview();
  }

  const updatePlayer = (index: number, change: (p: RecognizedPlayer) => RecognizedPlayer) =>
    update(r => ({ ...r, players: r.players.map((p, i) => (i === index ? change(p) : p)) }));

  function badge(parent: HTMLElement, field: RecognizedField<unknown>, issues: readonly ReviewIssue[], path: string) {
    const level = issues.some(i => i.field === path && i.severity === 'error') ? 'error' : indicator(field);
    const text = level === 'error' ? 'Conflict' : indicatorLabels[level];
    const note = field.source === 'inferred' ? ' · inferred' : field.source === 'corrected' ? ' · edited' : '';
    add(parent, 'span', text + note, 'indicator ind-' + level);
  }

  function numberField(parent: HTMLElement, label: string, field: RecognizedField<number>, issues: readonly ReviewIssue[], path: string, set: (f: RecognizedField<number>) => void) {
    const wrap = add(parent, 'label', '', 'review-field');
    add(wrap, 'span', label, 'review-label');
    const input = add(wrap, 'input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.inputMode = 'numeric';
    input.placeholder = 'Unknown';
    input.value = field.value === null ? '' : String(field.value);
    badge(wrap, field, issues, path);
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
    if (!rec) return used;
    for (const c of [...rec.communityCards, ...rec.players.flatMap(p => p.cards)]) if (c !== except && c.value) used.add(c.value);
    return used;
  }

  function cardButton(parent: HTMLElement, card: RecognizedCard, label: string, issues: readonly ReviewIssue[], path: string, set: (c: RecognizedCard) => void) {
    const wrap = add(parent, 'div', '', 'review-card');
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
    badge(wrap, card, issues, path);
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

  function renderReview() {
    if (!rec) return;
    const r = rec;
    const issues = reviewScreenshot(r);
    statePanel.replaceChildren();

    // Summary
    const errors = issues.filter(i => i.severity === 'error');
    const reviews = issues.filter(i => i.severity === 'review');
    const summary = add(statePanel, 'div', '', 'review-summary' + (errors.length ? ' has-errors' : ''));
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
    const table = add(statePanel, 'fieldset', '', 'review-section');
    add(table, 'legend', 'Table');
    const streetWrap = add(table, 'label', '', 'review-field');
    add(streetWrap, 'span', 'Street', 'review-label');
    const street = add(streetWrap, 'select');
    for (const value of ['', 'preflop', 'flop', 'turn', 'river']) {
      const option = add(street, 'option', value ? value[0].toUpperCase() + value.slice(1) : 'Unknown');
      option.value = value;
    }
    street.value = r.street.value ?? '';
    badge(streetWrap, r.street, issues, 'street');
    street.addEventListener('change', () => update(x => ({ ...x, street: street.value ? corrected(street.value as Street) : inferStreet(x.communityCards) })));
    numberField(table, 'Pot', r.pot, issues, 'pot', f => update(x => ({ ...x, pot: f })));
    const includes = add(table, 'label', '', 'checkbox');
    const box = add(includes, 'input');
    box.type = 'checkbox';
    box.checked = r.potIncludesBets;
    includes.append(' The pot shown already includes the bets in front of players');
    box.addEventListener('change', () => update(x => ({ ...x, potIncludesBets: box.checked })));
    const blinds = add(table, 'div', '', 'review-row');
    numberField(blinds, 'Small blind', r.smallBlind, issues, 'smallBlind', f => update(x => ({ ...x, smallBlind: f })));
    numberField(blinds, 'Big blind', r.bigBlind, issues, 'bigBlind', f => update(x => ({ ...x, bigBlind: f })));

    // Board
    const board = add(statePanel, 'fieldset', '', 'review-section');
    add(board, 'legend', 'Community cards');
    const boardCards = add(board, 'div', '', 'review-cards');
    r.communityCards.forEach((c, i) => cardButton(boardCards, c, 'Board card ' + (i + 1), issues, 'board.' + i,
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
    const seats = add(statePanel, 'fieldset', '', 'review-section');
    add(seats, 'legend', 'Seats (clockwise from the bottom)');
    r.players.forEach((p, i) => renderSeat(seats, r, p, i, issues));
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

    renderActions(r, issues);
  }

  function renderSeat(parent: HTMLElement, r: ScreenshotRecognition, p: RecognizedPlayer, i: number, issues: readonly ReviewIssue[]) {
    const seat = add(parent, 'fieldset', '', 'review-seat' + (r.heroSeat.value === i ? ' is-hero' : ''));
    add(seat, 'legend', 'Seat ' + (i + 1) + (p.name.value ? ' · ' + p.name.value : ''));
    const top = add(seat, 'div', '', 'review-row');
    const nameWrap = add(top, 'label', '', 'review-field');
    add(nameWrap, 'span', 'Name', 'review-label');
    const name = add(nameWrap, 'input');
    name.value = p.name.value ?? '';
    name.placeholder = 'Unknown';
    name.maxLength = 60;
    badge(nameWrap, p.name, issues, 'players.' + i + '.name');
    name.addEventListener('change', () => updatePlayer(i, x => ({ ...x, name: corrected(name.value.trim() || null) })));
    const statusWrap = add(top, 'label', '', 'review-field');
    add(statusWrap, 'span', 'Status', 'review-label');
    const status = add(statusWrap, 'select');
    for (const [value, text] of [['', 'Unknown'], ['active', 'In the hand'], ['folded', 'Folded']]) {
      const option = add(status, 'option', text);
      option.value = value;
    }
    status.value = p.status.value ?? '';
    badge(statusWrap, p.status, issues, 'players.' + i + '.status');
    status.addEventListener('change', () => updatePlayer(i, x => ({ ...x, status: corrected((status.value || null) as 'active' | 'folded' | null) })));

    const chips = add(seat, 'div', '', 'review-row');
    numberField(chips, 'Stack', p.stack, issues, 'players.' + i + '.stack', f => updatePlayer(i, x => ({ ...x, stack: f })));
    numberField(chips, 'Bet this street', p.bet, issues, 'players.' + i + '.bet', f => updatePlayer(i, x => ({ ...x, bet: f })));

    const roles = add(seat, 'div', '', 'review-row roles');
    const radio = (label: string, group: string, checked: boolean, select: () => void) => {
      const wrap = add(roles, 'label', '', 'checkbox');
      const input = add(wrap, 'input');
      input.type = 'radio';
      input.name = group;
      input.checked = checked;
      wrap.append(' ' + label);
      input.addEventListener('change', select);
    };
    radio('This is me', 'shot-hero', r.heroSeat.value === i, () => update(x => ({ ...x, heroSeat: corrected(i) })));
    radio('Dealer button', 'shot-dealer', r.dealerSeat.value === i, () => update(x => ({ ...x, dealerSeat: corrected(i) })));

    const cards = add(seat, 'div', '', 'review-cards');
    if (!p.cards.length) {
      add(cards, 'p', 'No cards shown.', 'fine-print');
      const addCards = add(cards, 'button', 'Add two cards', 'secondary');
      addCards.type = 'button';
      addCards.addEventListener('click', () => updatePlayer(i, x => ({ ...x, cards: [correctedCard(null, true), correctedCard(null, true)] })));
    } else {
      p.cards.forEach((c, j) => cardButton(cards, c, (p.name.value ?? 'Seat ' + (i + 1)) + ' card ' + (j + 1), issues, 'players.' + i + '.cards.' + j,
        next => updatePlayer(i, x => ({ ...x, cards: x.cards.map((cc, k) => (k === j ? next : cc)) }))));
      const removeCards = add(cards, 'button', 'No cards', 'secondary');
      removeCards.type = 'button';
      removeCards.addEventListener('click', () => updatePlayer(i, x => ({ ...x, cards: [] })));
    }
  }

  // -------------------------------------------------------------------------
  // Using the reviewed state
  // -------------------------------------------------------------------------
  function compatibleHands(r: ScreenshotRecognition) {
    const observation = toTableObservation(r);
    return loadHands().hands.flatMap(hand => {
      const states = replaySteps(createHandState(hand.setup), hand.events);
      return matchObservation(states, observation).map(m => ({ hand, ...m, street: states[m.position].phase }));
    });
  }

  function renderActions(r: ScreenshotRecognition, issues: readonly ReviewIssue[]) {
    const blocked = hasBlockingIssues(issues);
    const section = add(statePanel, 'fieldset', '', 'review-section review-actions');
    add(section, 'legend', 'Use this state');
    const message = add(section, 'div', '', 'action-message');
    message.setAttribute('role', 'status');
    message.textContent = notice;

    // Load into the study table.
    const loadRow = add(section, 'div', '', 'actions');
    const purposeWrap = add(loadRow, 'label', '', 'review-field');
    add(purposeWrap, 'span', 'Study context', 'review-label');
    const purpose = add(purposeWrap, 'select');
    for (const [value, text] of [['completed', 'Completed hand'], ['simulation', 'Simulated hand']]) {
      const option = add(purpose, 'option', text);
      option.value = value;
    }
    const load = add(loadRow, 'button', 'Load into study table');
    load.type = 'button';
    load.disabled = blocked;
    load.addEventListener('click', () => {
      const result = toStudySnapshot(r, purpose.value as Snapshot['purpose']);
      message.replaceChildren();
      if ('problems' in result) {
        add(message, 'p', 'Not loaded. The study table needs:');
        const list = add(message, 'ul');
        for (const problem of result.problems) add(list, 'li', problem);
        return;
      }
      options.loadIntoTable(result.snapshot);
      options.replay.showView('study');
    });

    // Save for later.
    const saveRow = add(section, 'div', '', 'actions');
    const keepWrap = add(saveRow, 'label', '', 'checkbox');
    const keepImage = add(keepWrap, 'input');
    keepImage.type = 'checkbox';
    keepImage.disabled = !reviewSource;
    keepWrap.append(' Also save the screenshot image');
    const save = add(saveRow, 'button', savedId ? 'Update saved copy' : 'Save for later', 'secondary');
    save.type = 'button';
    save.disabled = blocked;
    save.addEventListener('click', async () => {
      const entry = await saveCurrent(keepImage.checked);
      if (entry) {
        notice = 'Saved “' + entry.name + '” in this browser' + (entry.image ? ' with its image.' : ', without the image.');
        renderReview();
      }
    });

    // Attach to a saved hand.
    const matches = blocked ? [] : compatibleHands(r);
    const attachRow = add(section, 'div', '', 'actions');
    const handWrap = add(attachRow, 'label', '', 'review-field');
    add(handWrap, 'span', 'Saved hand that fits', 'review-label');
    const handSelect = add(handWrap, 'select');
    if (!matches.length) add(handSelect, 'option', blocked ? 'Fix the problems first' : 'No saved hand matches this state');
    matches.forEach((m, k) => {
      const option = add(handSelect, 'option', m.hand.name + ' · event ' + m.position + ' (' + m.street + ')');
      option.value = String(k);
    });
    handSelect.disabled = !matches.length;
    const attach = add(attachRow, 'button', 'Attach to hand', 'secondary');
    attach.type = 'button';
    attach.disabled = !matches.length;
    attach.addEventListener('click', async () => {
      const match = matches[Number(handSelect.value)];
      if (!match) return;
      if (savedId && match.hand.attachments?.some(a => a.id === savedId)) {
        notice = 'This screenshot is already attached to “' + match.hand.name + '”.';
        renderReview();
        return;
      }
      if (!confirm('Attach this screenshot to “' + match.hand.name + '” at event ' + match.position + '? This updates the saved hand. It adds no events.')) return;
      const entry = await saveCurrent(keepImage.checked, { handId: match.hand.id, position: match.position });
      if (!entry) return;
      try {
        const updated: HandHistory = withAttachment(match.hand, {
          id: entry.id, label: entry.name, attachedAt: new Date().toISOString(),
          position: match.position, rotation: match.rotation, observation: toTableObservation(r),
        });
        const hands = loadHands().hands;
        saveHands(hands.map(h => (h.id === updated.id ? updated : h)));
        options.replay.reloadHands();
        notice = 'Attached to “' + match.hand.name + '” at event ' + match.position + '. Open it in hand review below.';
        renderReview();
      } catch (error) {
        notice = 'Not attached: ' + (error instanceof Error ? error.message : 'the hand could not be updated.');
        renderReview();
      }
    });

    // Open in hand review.
    const current = saved.find(s => s.id === savedId);
    if (current?.attachedTo) {
      const open = add(section, 'button', 'Open in hand review', 'secondary');
      open.type = 'button';
      open.addEventListener('click', () => {
        if (!options.replay.openHand(current.attachedTo!.handId, current.attachedTo!.position)) {
          message.textContent = 'That saved hand is no longer in this browser.';
        }
      });
    } else {
      add(section, 'p', 'Attach this screenshot to a saved hand to open it in hand review. A screenshot is one observed moment; it never creates hand events.', 'fine-print');
    }
    if (blocked) add(section, 'p', 'Fix the problems marked “Fix” to save, attach, or load this state.', 'fine-print');
  }

  async function imageData(): Promise<string | undefined> {
    if (!reviewSource) return undefined;
    if (reviewSource.startsWith('data:')) return reviewSource;
    if (!image) return undefined;
    const blob = await prepareUpload(image.bitmap);
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  }

  async function saveCurrent(keepImage: boolean, attachedTo?: SavedScreenshot['attachedTo']): Promise<SavedScreenshot | null> {
    if (!rec) return null;
    const existing = saved.find(s => s.id === savedId);
    const names = rec.players.map(p => p.name.value).filter(Boolean).slice(0, 3).join(', ');
    const entry: SavedScreenshot = {
      id: existing?.id ?? 'shot-' + Date.now().toString(36),
      name: existing?.name ?? ((rec.street.value ? rec.street.value[0].toUpperCase() + rec.street.value.slice(1) : 'Table') + (names ? ' · ' + names : '')),
      savedAt: new Date().toISOString(),
      recognition: rec,
      ...(keepImage ? { image: await imageData() } : existing?.image ? { image: existing.image } : {}),
      ...(attachedTo ? { attachedTo } : existing?.attachedTo ? { attachedTo: existing.attachedTo } : {}),
    };
    if (entry.image === undefined) delete (entry as { image?: string }).image;
    try {
      saveScreenshots([entry, ...saved.filter(s => s.id !== entry.id)]);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The screenshot could not be saved.';
      return null;
    }
    savedId = entry.id;
    reloadSaved();
    renderReview();
    return entry;
  }

  // -------------------------------------------------------------------------
  // Saved screenshots
  // -------------------------------------------------------------------------
  function reloadSaved() {
    const loaded = loadScreenshots();
    saved = loaded.saved;
    if (loaded.problems.length) status.textContent = loaded.problems.join(' ');
    const list = element('shot-saved');
    list.replaceChildren();
    if (!saved.length) {
      add(list, 'li', 'Nothing saved yet.', 'empty-list');
      return;
    }
    for (const entry of saved) {
      const item = add(list, 'li', '', 'hand-item' + (entry.id === savedId ? ' open' : ''));
      const open = add(item, 'button', entry.name, 'hand-open');
      open.type = 'button';
      open.addEventListener('click', () => {
        cancel();
        savedId = entry.id;
        reviewSource = entry.image ?? null;
        showReview(entry.recognition);
        status.textContent = 'Opened “' + entry.name + '”' + (entry.image ? '.' : '. The image was not saved, only the reviewed state.');
      });
      add(item, 'p', new Date(entry.savedAt).toLocaleString() + ' · ' + entry.recognition.players.length + ' seats'
        + (entry.image ? ' · image saved' : '') + (entry.attachedTo ? ' · attached to a hand' : ''), 'hand-meta');
      const actions = add(item, 'div', '', 'actions small-actions');
      const remove = add(actions, 'button', 'Delete', 'secondary');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete ' + entry.name);
      remove.addEventListener('click', () => {
        if (!confirm('Delete the saved screenshot “' + entry.name + '”? Saved hands keep any attachment.')) return;
        try {
          saveScreenshots(saved.filter(s => s.id !== entry.id));
          if (savedId === entry.id) savedId = null;
          reloadSaved();
          if (rec) renderReview();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not delete.';
        }
      });
    }
  }

  reloadSaved();
  window.addEventListener('pagehide', () => { cancel(); releaseImage(); });

  return {
    /** Stop any recognition in flight when the user leaves the view. */
    leave() {
      if (request) {
        cancel();
        readButton.disabled = !image;
        status.textContent = 'Recognition stopped because you left the screen. Your study table is unchanged.';
      }
    },
  };
}
