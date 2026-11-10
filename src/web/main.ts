import { standardDeck } from '../core/cards.js';
import type { analyze } from '../core/analyze.js';
import type { Action, Card, Outlook, OutlookRow, Snapshot } from '../core/types.js';
import { cloudRecognizer, type Confidence, type Recognition, type SlotGroup } from '../vision/recognizer.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: ' + id);
  return node as T;
}

// ---------------------------------------------------------------------------
// Card slots
// ---------------------------------------------------------------------------
interface Slot {
  card: Card | null;
  /** Filled from a photo and not yet confirmed by the user. */
  pending: boolean;
  confidence?: Confidence;
  duplicate?: boolean;
  unreadable?: boolean;
}

const groups: readonly SlotGroup[] = ['opponent', 'board', 'hero'];
const sizes: Record<SlotGroup, number> = { opponent: 2, board: 5, hero: 2 };
const emptySlots = () => Object.fromEntries(groups.map(group =>
  [group, Array.from({ length: sizes[group] }, (): Slot => ({ card: null, pending: false }))],
)) as Record<SlotGroup, Slot[]>;
let slots = emptySlots();

const rankNames: Record<string, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine',
  T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace',
};
const suitNames: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const suitSymbols: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const boardStreets = ['flop', 'flop', 'flop', 'turn', 'river'];

const cardName = (card: Card) => rankNames[card[0]] + ' of ' + suitNames[card[1]];
const rankLabel = (card: Card) => (card[0] === 'T' ? '10' : card[0]);

function slotLabel(group: SlotGroup, index: number) {
  if (group === 'board') return 'Board card ' + (index + 1) + ' (' + boardStreets[index] + ')';
  return (group === 'hero' ? 'Your card ' : 'Opponent card ') + (index + 1);
}

function describeSlot(group: SlotGroup, index: number, slot: Slot) {
  let text = slotLabel(group, index) + ': ' + (slot.card ? cardName(slot.card) : slot.unreadable ? 'unreadable in photo' : 'empty');
  if (slot.pending) {
    text += ', from photo';
    if (slot.confidence) text += ', ' + slot.confidence + ' confidence';
    if (slot.duplicate) text += ', duplicate card';
    text += ', needs checking';
  }
  return text;
}

function renderCardFace(node: HTMLElement, card: Card) {
  node.classList.add(card[1] === 'h' || card[1] === 'd' ? 'red' : 'black');
  const rank = document.createElement('span');
  rank.className = 'rank';
  rank.textContent = rankLabel(card);
  const suit = document.createElement('span');
  suit.className = 'suit';
  suit.textContent = suitSymbols[card[1]];
  node.append(rank, suit);
}

function renderSlots() {
  for (const group of groups) {
    const container = element('' + group + '-cards');
    container.replaceChildren(...slots[group].map((slot, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'card-slot';
      button.setAttribute('aria-label', describeSlot(group, index, slot));
      if (slot.card) {
        button.classList.add('filled');
        const face = document.createElement('span');
        face.className = 'face';
        face.setAttribute('aria-hidden', 'true');
        renderCardFace(face, slot.card);
        button.append(face);
      } else {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.setAttribute('aria-hidden', 'true');
        hint.textContent = slot.unreadable ? '?' : group === 'board' ? boardStreets[index] : '+';
        button.append(hint);
      }
      if (slot.pending) {
        button.classList.add('pending');
        const badge = document.createElement('span');
        badge.className = 'badge-check';
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = slot.duplicate ? 'dup' : slot.unreadable ? 'fix' : slot.confidence ?? 'check';
        button.append(badge);
      }
      button.addEventListener('click', () => openPicker(group, index));
      return button;
    }));
  }
  const pending = groups.flatMap(group => slots[group]).filter(slot => slot.pending).length;
  element('confirm-bar').hidden = pending === 0;
  element('confirm-text').textContent = pending === 1
    ? 'One card from the photo needs checking. Tap it to correct it, or confirm.'
    : pending + ' cards from the photo need checking. Tap any card to correct it, or confirm them all.';
}

// ---------------------------------------------------------------------------
// Card picker dialog
// ---------------------------------------------------------------------------
const picker = element<HTMLDialogElement>('picker');
const pickerGrid = element('picker-grid');
const pickerConfirm = element<HTMLButtonElement>('picker-confirm');
let picking: { group: SlotGroup; index: number; opener: HTMLElement | null } | null = null;

function openPicker(group: SlotGroup, index: number) {
  const current = slots[group][index];
  const used = new Set(groups.flatMap(g => slots[g]
    .filter((slot, i) => slot.card && !(g === group && i === index))
    .map(slot => slot.card)));
  picking = { group, index, opener: document.activeElement as HTMLElement | null };
  element('picker-title').textContent = slotLabel(group, index);
  element('picker-note').textContent = current.pending
    ? (current.card ? 'Read from the photo as ' + cardName(current.card) + '. Keep it or pick the correct card.' : 'This card could not be read from the photo. Pick the card you see.')
    : 'Cards already on the table are unavailable.';
  pickerConfirm.hidden = !(current.pending && current.card);

  const rows = [...'shdc'].map(suit => {
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', suitNames[suit]);
    for (const card of standardDeck.filter(c => c[1] === suit).reverse()) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.value = 'card:' + card;
      button.className = 'pick';
      button.setAttribute('aria-label', cardName(card) + (used.has(card) ? ', already on the table' : ''));
      button.disabled = used.has(card);
      if (card === current.card) button.setAttribute('aria-pressed', 'true');
      renderCardFace(button, card);
      row.append(button);
    }
    return row;
  });
  pickerGrid.replaceChildren(...rows);
  picker.returnValue = '';
  picker.showModal();
  (pickerGrid.querySelector<HTMLButtonElement>('[aria-pressed=true]')
    ?? pickerGrid.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
}

// Apply the choice on submit, which runs synchronously, rather than waiting for
// the dialog's close event; `close` only covers Escape and other dismissals.
picker.querySelector('form')?.addEventListener('submit', event => {
  finishPick((event.submitter as HTMLButtonElement | null)?.value ?? 'cancel');
});
picker.addEventListener('close', () => finishPick(picker.returnValue || 'cancel'));

function finishPick(value: string) {
  if (!picking) return;
  const { group, index, opener } = picking;
  picking = null;
  const slot = slots[group][index];
  if (value.startsWith('card:')) {
    slots[group][index] = { card: value.slice(5), pending: false };
  } else if (value === 'clear') {
    slots[group][index] = { card: null, pending: false };
  } else if (value === 'confirm') {
    slots[group][index] = { card: slot.card, pending: false };
  } else {
    opener?.focus();
    return;
  }
  refreshDuplicates();
  invalidate();
  renderSlots();
  element(group + '-cards').querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
}

function refreshDuplicates() {
  const counts = new Map<Card, number>();
  for (const slot of groups.flatMap(g => slots[g])) if (slot.card) counts.set(slot.card, (counts.get(slot.card) ?? 0) + 1);
  for (const slot of groups.flatMap(g => slots[g])) {
    if (slot.pending) slot.duplicate = !!slot.card && (counts.get(slot.card) ?? 0) > 1;
  }
}

element('confirm-all').addEventListener('click', () => {
  for (const slot of groups.flatMap(g => slots[g])) {
    if (slot.pending && slot.duplicate) {
      status.textContent = 'Two slots show the same card. Fix the duplicate before confirming.';
      return;
    }
  }
  for (const group of groups) {
    slots[group] = slots[group].map(slot => ({ card: slot.card, pending: false }));
  }
  invalidate();
  renderSlots();
  status.textContent = 'Cards confirmed.';
});

// ---------------------------------------------------------------------------
// Results and analysis
// ---------------------------------------------------------------------------
const form = element<HTMLFormElement>('scenario');
const submit = element<HTMLButtonElement>('analyze');
const status = element('status');
const results = element('result-body');
let worker: Worker | null = null;

function invalidate() {
  worker?.terminate();
  worker = null;
  submit.disabled = false;
  status.textContent = '';
  results.replaceChildren();
  element('result-empty').hidden = false;
}

form.addEventListener('input', invalidate);

function getNumber(id: string) {
  return element<HTMLInputElement>(id).valueAsNumber;
}

function cardsIn(group: SlotGroup): Card[] {
  return slots[group].flatMap(slot => (slot.card ? [slot.card] : []));
}

function snapshot(): Snapshot {
  const board = slots.board;
  let filled = 0;
  board.forEach((slot, index) => { if (slot.card) filled = index + 1; });
  if (board.slice(0, filled).some(slot => !slot.card)) {
    throw new Error('Fill the board from the left: three flop cards, then the turn, then the river.');
  }
  if (cardsIn('hero').length !== 2) throw new Error('Pick both of your cards.');
  if (cardsIn('opponent').length === 1) throw new Error('Pick both opponent cards or leave both empty.');
  return {
    version: 1, ruleset: 'holdem-nl-hu',
    purpose: element<HTMLSelectElement>('purpose').value as Snapshot['purpose'],
    hero: cardsIn('hero'),
    board: cardsIn('board'),
    opponent: cardsIn('opponent'),
    pot: getNumber('pot'), heroStack: getNumber('hero-stack'), opponentStack: getNumber('opponent-stack'),
    committed: getNumber('committed'), faced: getNumber('faced'), increment: getNumber('increment'),
  };
}

function setNumbers(values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) element<HTMLInputElement>(id).value = value;
}

element('load-example').addEventListener('click', () => {
  slots = emptySlots();
  const example: Record<SlotGroup, Card[]> = { hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d', '2s', '9c'], opponent: [] };
  for (const group of groups) example[group].forEach((card, i) => { slots[group][i] = { card, pending: false }; });
  setNumbers({
    purpose: 'simulation', pot: '120', 'hero-stack': '150', 'opponent-stack': '110',
    committed: '0', faced: '40', increment: '40',
  });
  invalidate();
  renderSlots();
});

element('reset-table').addEventListener('click', () => {
  slots = emptySlots();
  form.reset();
  invalidate();
  renderSlots();
});

const percent = (fraction: number) => (fraction * 100).toFixed(1) + '%';

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'check': return 'Check';
    case 'fold': return 'Fold';
    case 'call': return 'Call for ' + action.cost + ' chips';
    case 'raise':
    case 'bet': {
      const range = action.minTo === action.maxTo ? String(action.minTo) : action.minTo + '–' + action.maxTo;
      const verb = action.kind === 'raise' ? 'Raise to ' : 'Bet ';
      return verb + range + ' chips' + (action.short ? ' · short all-in only' : '');
    }
  }
}

function add(parent: HTMLElement, tag: string, value: string) {
  const node = document.createElement(tag);
  node.textContent = value;
  parent.append(node);
  return node;
}

const shortCard = (card: Card) => rankLabel(card) + suitSymbols[card[1]];

function showOutlook(outlook: Outlook) {
  add(results, 'h3', 'Hands to play for');
  const toCome = outlook.cardsToCome === 1 ? 'the river' : outlook.current ? 'the turn and river' : 'the full board';
  if (outlook.current && outlook.improveByRiver !== null) {
    add(results, 'p', 'Chance to beat your ' + outlook.current.name.toLowerCase() + ' with '
      + toCome + ': ' + percent(outlook.improveByRiver));
  }
  showSuggestion(outlook);

  const hasNext = outlook.rows.some(row => row.nextCard);
  const list = document.createElement('div');
  list.className = 'outlook' + (hasNext ? '' : ' no-next');
  const head = document.createElement('div');
  head.className = 'outlook-head';
  head.setAttribute('aria-hidden', 'true');
  for (const label of ['Hand', ...(hasNext ? ['Next card'] : []), 'By the river']) add(head, 'span', label);
  list.append(head);
  for (const row of outlook.rows) list.append(outlookRow(outlook, row, hasNext));
  results.append(list);
  results.append(opponentPanel(outlook));

  const boards = outlook.method === 'exact'
    ? 'Hand chances are exact over all ' + outlook.runouts.toLocaleString() + ' possible boards'
    : 'Hand chances are estimated from ' + outlook.runouts.toLocaleString() + ' random boards';
  const matchups = (outlook.opponent.method === 'exact' ? '; matchups are exact over ' : '; matchups are estimated from ')
    + outlook.opponent.matchups.toLocaleString() + (outlook.opponent.model === 'known' ? ' boards against the known opponent hand' : ' board and opponent-hand pairs');
  add(results, 'p', boards + matchups + '. Every unseen card counts as possible, and an unknown opponent holds a random hand. '
    + 'These are showdown odds if both players reach the river; they ignore betting, folds, and how the opponent plays.').className = 'fine-print';
}

const pct = (fraction: number) => (fraction > 0 && fraction < 0.0005 ? '<0.1%' : percent(fraction));
const wholePct = (fraction: number) => Math.round(fraction * 100) + '%';

function showSuggestion(outlook: Outlook) {
  const { playFor, caution, holding } = outlook.suggestion;
  if (!playFor.length && !caution.length && !holding) return;
  const box = document.createElement('div');
  box.className = 'suggestion';
  const lines: [string, string][] = [];
  if (holding) {
    lines.push(['Already good', 'Your ' + holding.name.toLowerCase() + ' wins ' + wholePct(holding.winWhenMade)
      + ' of showdowns when it stays your hand (' + wholePct(holding.byRiver) + ' of boards).']);
  }
  for (const hand of playFor) {
    lines.push(['Play for', hand.name + ': you make it ' + pct(hand.byRiver) + ' of the time and win '
      + wholePct(hand.winWhenMade) + ' when you do. It carries ' + wholePct(hand.equityShare / Math.max(outlook.yourEquity, 1e-9))
      + ' of your equity.']);
  }
  for (const hand of caution) {
    lines.push(['Careful', 'Finishing with ' + hand.name.toLowerCase() + ' (' + pct(hand.byRiver)
      + ' of boards) wins only ' + wholePct(hand.winWhenMade) + ' of showdowns.']);
  }
  for (const [tag, text] of lines) {
    const line = document.createElement('p');
    add(line, 'strong', tag).className = 'tag tag-' + tag.split(' ')[0].toLowerCase();
    line.append(' ' + text);
    box.append(line);
  }
  results.append(box);
}

function outlookRow(outlook: Outlook, row: OutlookRow, hasNext: boolean) {
  const isNow = outlook.current?.category === row.category;
  const details = document.createElement('details');
  details.className = 'outlook-row' + (isNow ? ' current' : '');
  const summary = document.createElement('summary');

  const name = add(summary, 'span', row.name);
  name.className = 'cell name';
  if (isNow) add(name, 'small', 'now');

  const spoken = [row.name + (isNow ? ', your current hand' : '')];
  if (hasNext) {
    const next = document.createElement('span');
    next.className = 'cell next';
    const outs = row.nextCard?.outs ?? [];
    if (outs.length) {
      const count = outs.length + (outs.length === 1 ? ' out · ' : ' outs · ') + percent(row.nextCard!.chance);
      next.append(count);
      add(next, 'span', outs.map(shortCard).join(' ')).className = 'outs';
      spoken.push('next card ' + count.replace(' · ', ', ') + ': ' + outs.map(cardName).join(', '));
    } else {
      next.append('—');
      spoken.push('no next-card outs');
    }
    summary.append(next);
  }
  add(summary, 'span', pct(row.byRiver)).className = 'cell river';
  spoken.push(pct(row.byRiver) + ' by the river');
  summary.setAttribute('aria-label', spoken.join('; '));
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'detail';
  const matchup = row.matchup;
  if (!matchup) {
    add(body, 'p', 'You do not finish with this hand on any of these boards.');
  } else {
    const article = isNow ? 'your ' : ['Straight', 'Flush', 'Full house', 'Straight flush'].includes(row.name) ? 'a ' : '';
    add(body, 'p', 'When you finish with ' + article + row.name.toLowerCase() + ':').className = 'detail-lead';
    const bar = document.createElement('div');
    bar.className = 'meter';
    bar.setAttribute('aria-hidden', 'true');
    for (const [part, value] of [['win', matchup.win], ['tie', matchup.tie], ['loss', matchup.loss]] as const) {
      const segment = document.createElement('span');
      segment.className = part;
      segment.style.width = (value * 100).toFixed(2) + '%';
      bar.append(segment);
    }
    body.append(bar);
    add(body, 'p', 'You win ' + pct(matchup.win) + ' · tie ' + pct(matchup.tie) + ' · lose ' + pct(matchup.loss));
    if (matchup.beatenBy.length) {
      add(body, 'p', 'The opponent beats it with:').className = 'detail-lead';
      const beaten = document.createElement('ul');
      beaten.className = 'beaten';
      for (const hand of matchup.beatenBy) {
        const item = add(beaten, 'li', hand.name);
        add(item, 'span', pct(hand.chance));
      }
      body.append(beaten);
    } else {
      add(body, 'p', 'No opponent hand beats it on these boards.');
    }
    add(body, 'p', 'Worth ' + percent(row.equityShare) + ' of the pot in showdown equity.').className = 'fine-print';
  }
  details.append(body);
  return details;
}

function opponentPanel(outlook: Outlook) {
  const { opponent } = outlook;
  const details = document.createElement('details');
  details.className = 'outlook-row opponent-odds';
  const summary = document.createElement('summary');
  add(summary, 'span', opponent.model === 'known' ? 'Opponent’s hands (known cards)' : 'Opponent’s possible hands').className = 'cell name';
  const odds = add(summary, 'span', 'Wins ' + pct(opponent.beatsYou));
  odds.className = 'cell river';
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'detail';
  add(body, 'p', 'Opponent showdown equity ' + percent(opponent.equity) + ' · beats you ' + pct(opponent.beatsYou)
    + ' of the time. How often they finish with each hand, and how often it beats yours:');
  const table = document.createElement('table');
  table.className = 'opponent-table';
  const head = table.createTHead().insertRow();
  for (const label of ['Their hand', 'They make it', 'And beat you']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  const rows = table.createTBody();
  for (const row of opponent.rows) {
    const line = rows.insertRow();
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = row.name;
    line.append(name);
    line.insertCell().textContent = pct(row.chance);
    line.insertCell().textContent = pct(row.beatsYou);
  }
  body.append(table);
  details.append(body);
  return details;
}

function show(result: ReturnType<typeof analyze>, scenario: Snapshot) {
  element('result-empty').hidden = true;
  const equity = result.equity;
  add(results, 'p', 'SHOWDOWN EQUITY').className = 'eyebrow';
  add(results, 'p', percent(equity.share)).className = 'equity';
  add(results, 'p', 'Win ' + percent(equity.win) + ' · Tie ' + percent(equity.tie) + ' · Loss ' + percent(equity.loss));
  const model = scenario.opponent.length ? 'Known opponent cards (hindsight if reconstructed)' : 'Uniform random opponent hand';
  add(results, 'p', model + ' · ' + equity.trials.toLocaleString() + (equity.method === 'exact' ? ' exact outcomes' : ' simulated draws'));
  if (equity.method === 'sampled') {
    add(results, 'p', '95% sampling bound: ' + equity.interval.map(percent).join(' to '));
  }
  add(results, 'h3', 'Best hand so far');
  add(results, 'p', result.rank ? result.rank.name + ' · ' + result.rank.cards.join(' ') : 'Available after the flop.');
  if (result.outlook) {
    showOutlook(result.outlook);
  } else {
    add(results, 'h3', 'Hands to play for');
    add(results, 'p', 'The board is complete, so no more cards are coming. Remove the turn and river cards to see what you could make from the flop.');
  }
  add(results, 'h3', 'Legal actions');
  const list = document.createElement('ul');
  for (const action of result.actions) add(list, 'li', describeAction(action));
  results.append(list);
  add(results, 'h3', result.study.title);
  add(results, 'p', result.study.detail);
  if (result.study.threshold !== undefined) add(results, 'p', 'Break-even equity: ' + percent(result.study.threshold));
  if (result.study.callValue !== undefined) add(results, 'p', 'Call EV versus folding: ' + result.study.callValue.toFixed(1) + ' chips');
}

form.addEventListener('submit', event => {
  event.preventDefault();
  invalidate();
  if (groups.some(group => slots[group].some(slot => slot.pending))) {
    status.textContent = 'Check the cards read from the photo before analysis. Tap each flagged card or confirm them all.';
    return;
  }
  let scenario: Snapshot;
  try {
    scenario = snapshot();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Check the table.';
    return;
  }
  let job: Worker;
  try {
    job = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
  } catch {
    status.textContent = 'This browser could not start the analysis worker.';
    return;
  }
  worker = job;
  submit.disabled = true;
  status.textContent = 'Analyzing the study snapshot…';
  function finish(message: string) {
    job.terminate();
    if (worker !== job) return false;
    worker = null;
    submit.disabled = false;
    status.textContent = message;
    return true;
  }
  job.onmessage = event => {
    const { error, result } = event.data;
    if (finish(error ?? 'Analysis ready.') && result) show(result, scenario);
  };
  job.onerror = () => finish('The analysis worker could not run. Reload and try again.');
  job.postMessage(scenario);
});

// ---------------------------------------------------------------------------
// Photo scan
// ---------------------------------------------------------------------------
const photoPanel = element<HTMLDetailsElement>('photo-panel');
const file = element<HTMLInputElement>('photo-file');
const camera = element<HTMLInputElement>('photo-camera');
const preview = element<HTMLImageElement>('photo-preview');
const photoStatus = element('photo-status');
const photoIssues = element('photo-issues');
const recognizeButton = element<HTMLButtonElement>('recognize');
const recognizer = cloudRecognizer();
let photo: Blob | null = null;
let photoUrl: string | null = null;
let pendingRequest: AbortController | null = null;

function releasePhoto() {
  pendingRequest?.abort();
  pendingRequest = null;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  photo = null;
  preview.removeAttribute('src');
  preview.hidden = true;
  recognizeButton.disabled = true;
  photoIssues.replaceChildren();
  photoIssues.hidden = true;
  photoStatus.textContent = 'Choose one photo of the cards.';
}

function clearPhoto() {
  releasePhoto();
  file.value = '';
  camera.value = '';
}

photoPanel.addEventListener('toggle', () => {
  if (!photoPanel.open) clearPhoto();
});

async function choosePhoto(input: HTMLInputElement) {
  const image = input.files?.[0];
  releasePhoto();
  (input === file ? camera : file).value = '';
  if (!image) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > 12 * 1024 * 1024) {
    photoStatus.textContent = 'Choose a JPEG, PNG, or WebP photo up to 12 MB.';
    return;
  }
  const current = URL.createObjectURL(image);
  photoUrl = current;
  preview.src = current;
  photoStatus.textContent = 'Opening the photo on this device…';
  try {
    // Decode off-screen so a hidden or backgrounded page cannot stall the check.
    (await createImageBitmap(image)).close();
    if (photoUrl !== current) return;
    preview.hidden = false;
    photo = image;
    recognizeButton.disabled = false;
    photoStatus.textContent = 'Check that all face-up cards are in frame, then read the cards.';
  } catch {
    if (photoUrl !== current) return;
    releasePhoto();
    photoStatus.textContent = 'This photo could not be opened.';
  }
}

/** Downscale to the API's recommended size and strip metadata by re-encoding. */
async function prepareUpload(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  try {
    return await new Promise((resolve, reject) => canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.9,
    ));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function applyRecognition(recognition: Extract<Recognition, { kind: 'observations' }>) {
  slots = emptySlots();
  for (const observation of recognition.slots) {
    slots[observation.group][observation.index] = {
      card: observation.candidates[0]?.card ?? null,
      pending: true,
      confidence: observation.confidence,
      duplicate: observation.duplicate,
      unreadable: observation.candidates.length === 0,
    };
  }
  invalidate();
  renderSlots();
  const read = recognition.slots.filter(o => o.candidates.length).length;
  const unreadable = recognition.slots.length - read;
  photoStatus.textContent = recognition.slots.length
    ? 'Claude read ' + read + ' card' + (read === 1 ? '' : 's') + (unreadable ? ' and could not read ' + unreadable : '')
      + '. Check every flagged card on the table against the photo.'
    : 'Claude did not find any face-up cards. Try a clearer photo or pick the cards by hand.';
  const notes = [...recognition.issues];
  if (recognition.slots.some(o => o.duplicate)) notes.unshift('The same card was read in two places. Fix the duplicate.');
  photoIssues.replaceChildren(...notes.map(note => {
    const item = document.createElement('li');
    item.textContent = note;
    return item;
  }));
  photoIssues.hidden = notes.length === 0;
}

recognizeButton.addEventListener('click', async () => {
  if (!photo) return;
  const source = photo;
  const request = new AbortController();
  pendingRequest?.abort();
  pendingRequest = request;
  recognizeButton.disabled = true;
  photoStatus.textContent = 'Sending the photo to Claude and reading the cards…';
  photoIssues.hidden = true;
  try {
    const upload = await prepareUpload(source);
    if (request.signal.aborted) return;
    const recognition = await recognizer.recognize(upload, request.signal);
    if (request.signal.aborted || photo !== source) return;
    if (recognition.kind === 'unavailable') photoStatus.textContent = recognition.reason;
    else applyRecognition(recognition);
  } catch (error) {
    if (request.signal.aborted) return;
    photoStatus.textContent = error instanceof Error ? error.message : 'Recognition failed. Pick the cards by hand.';
  } finally {
    if (pendingRequest === request) {
      pendingRequest = null;
      recognizeButton.disabled = !photo;
    }
  }
});

file.addEventListener('change', () => void choosePhoto(file));
camera.addEventListener('change', () => void choosePhoto(camera));
element('clear-photo').addEventListener('click', clearPhoto);
window.addEventListener('pagehide', clearPhoto);

renderSlots();

if (window.isSecureContext && 'serviceWorker' in navigator) {
  // When a newer build takes control, reload once so the page runs it. Skip the
  // first install, when there was no previous worker and the page is current.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {
    element('offline-status').textContent = 'Offline setup is unavailable in this browser session.';
  });
}
