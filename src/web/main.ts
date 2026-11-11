import { standardDeck } from '../core/cards.js';
import type { analyze } from '../core/analyze.js';
import type {
  Action, BetAdvice, BetOption, Card, OpponentStyle, Outlook, OutlookRow, Snapshot,
} from '../core/types.js';
import { explainFold } from '../core/sizing.js';
import { cardName, rankLabel, renderCardFace, suitNames, suitSymbols } from './cards-view.js';
import { pickCard } from './card-picker.js';
import { prepareUpload } from './image.js';
import { initReplay } from './replay.js';
import { initBenchmarks } from './benchmark-view.js';
import { initPhysicalScan } from './physical-view.js';
import { initReconstruction } from './reconstruct-view.js';
import { initScreenshotImport } from './screenshot-view.js';
import { cloudRecognizer, type Confidence, type Recognition } from '../vision/recognizer.js';

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

type SlotGroup = 'opp1' | 'opp2' | 'opp3' | 'board' | 'hero';
const allGroups: readonly SlotGroup[] = ['opp1', 'opp2', 'opp3', 'board', 'hero'];
const seatGroups = ['opp1', 'opp2', 'opp3'] as const;
const sizes: Record<SlotGroup, number> = { opp1: 2, opp2: 2, opp3: 2, board: 5, hero: 2 };
const emptySlots = () => Object.fromEntries(allGroups.map(group =>
  [group, Array.from({ length: sizes[group] }, (): Slot => ({ card: null, pending: false }))],
)) as Record<SlotGroup, Slot[]>;
let slots = emptySlots();

/** Opponents seated at the table, from the player count selector. */
let opponentCount = 1;
const activeSeats = () => seatGroups.slice(0, opponentCount);
/** Card groups in play: seated opponents, the board, and the hero. */
const groupsInPlay = (): SlotGroup[] => [...activeSeats(), 'board', 'hero'];

const boardStreets = ['flop', 'flop', 'flop', 'turn', 'river'];


function slotLabel(group: SlotGroup, index: number) {
  if (group === 'board') return 'Board card ' + (index + 1) + ' (' + boardStreets[index] + ')';
  if (group === 'hero') return 'Your card ' + (index + 1);
  return seatName(group) + ' card ' + (index + 1);
}

function seatName(group: SlotGroup) {
  return opponentCount === 1 ? 'Opponent' : 'Opponent ' + group.slice(3);
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

function renderSlots() {
  for (const group of groupsInPlay()) {
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
      button.addEventListener('click', () => void openPicker(group, index));
      return button;
    }));
  }
  const pending = groupsInPlay().flatMap(group => slots[group]).filter(slot => slot.pending).length;
  element('confirm-bar').hidden = pending === 0;
  element('confirm-text').textContent = pending === 1
    ? 'One card from the photo needs checking. Tap it to correct it, or confirm.'
    : pending + ' cards from the photo need checking. Tap any card to correct it, or confirm them all.';
}

// ---------------------------------------------------------------------------
// Card picker dialog
// ---------------------------------------------------------------------------
async function openPicker(group: SlotGroup, index: number) {
  const current = slots[group][index];
  const used = new Set(groupsInPlay().flatMap(g => slots[g]
    .filter((slot, i) => slot.card && !(g === group && i === index))
    .map(slot => slot.card!)));
  const result = await pickCard({
    title: slotLabel(group, index),
    note: current.pending
      ? (current.card ? 'Read from the photo as ' + cardName(current.card) + '. Keep it or pick the correct card.' : 'This card could not be read from the photo. Pick the card you see.')
      : 'Cards already on the table are unavailable.',
    current: current.card,
    used,
    canConfirm: current.pending && !!current.card,
  });
  if (result.kind === 'cancel') return;
  if (result.kind === 'card') slots[group][index] = { card: result.card, pending: false };
  else if (result.kind === 'clear') slots[group][index] = { card: null, pending: false };
  else slots[group][index] = { card: current.card, pending: false };
  refreshDuplicates();
  invalidate();
  renderSlots();
  element(group + '-cards').querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
}

function refreshDuplicates() {
  const counts = new Map<Card, number>();
  for (const slot of groupsInPlay().flatMap(g => slots[g])) if (slot.card) counts.set(slot.card, (counts.get(slot.card) ?? 0) + 1);
  for (const slot of groupsInPlay().flatMap(g => slots[g])) {
    if (slot.pending) slot.duplicate = !!slot.card && (counts.get(slot.card) ?? 0) > 1;
  }
}

element('confirm-all').addEventListener('click', () => {
  for (const slot of groupsInPlay().flatMap(g => slots[g])) {
    if (slot.pending && slot.duplicate) {
      status.textContent = 'Two slots show the same card. Fix the duplicate before confirming.';
      return;
    }
  }
  for (const group of groupsInPlay()) {
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

form.addEventListener('input', () => {
  invalidate();
  updateToCall();
});

function getNumber(id: string) {
  return element<HTMLInputElement>(id).valueAsNumber;
}

function cardsIn(group: SlotGroup): Card[] {
  return slots[group].flatMap(slot => (slot.card ? [slot.card] : []));
}

/**
 * Show the amount to call next to the hero, from the biggest opponent bet,
 * and offer the "pot they can win" field for opponents all-in earlier.
 */
function updateToCall() {
  const bets = activeSeats().map(seat => getNumber(seat + '-bet')).filter(Number.isFinite);
  const mine = getNumber('committed');
  const toCall = Math.max(0, ...bets) - (Number.isFinite(mine) ? mine : 0);
  element('to-call').textContent = toCall > 0 ? 'To call: ' + chips(toCall) : 'Nothing to call';
  for (const seat of seatGroups) {
    const earlier = activeSeats().includes(seat) && getNumber(seat + '-stack') === 0 && getNumber(seat + '-bet') === 0;
    element(seat + '-cap-field').hidden = !earlier;
    if (!earlier) element<HTMLInputElement>(seat + '-cap').value = '';
  }
}

/** Seat 1–3 opponents. Hidden seats are cleared so their cards free up. */
function setOpponentCount(count: number) {
  opponentCount = Math.min(3, Math.max(1, count));
  element<HTMLSelectElement>('players').value = String(opponentCount + 1);
  seatGroups.forEach((seat, i) => {
    const seated = i < opponentCount;
    element('seat-' + seat).hidden = !seated;
    for (const field of ['stack', 'bet']) element<HTMLInputElement>(seat + '-' + field).required = seated;
    if (!seated) {
      slots[seat] = slots[seat].map(() => ({ card: null, pending: false }));
      element<HTMLInputElement>(seat + '-stack').value = '';
      element<HTMLInputElement>(seat + '-bet').value = '0';
    }
    element(seat + '-name').textContent = seatName(seat);
  });
  element('felt').dataset.opponents = String(opponentCount);
  refreshDuplicates();
  invalidate();
  renderSlots();
  updateToCall();
}

element('players').addEventListener('change', event => {
  event.stopPropagation();
  setOpponentCount(Number(element<HTMLSelectElement>('players').value) - 1);
});

function snapshot(): Snapshot {
  const board = slots.board;
  let filled = 0;
  board.forEach((slot, index) => { if (slot.card) filled = index + 1; });
  if (board.slice(0, filled).some(slot => !slot.card)) {
    throw new Error('Fill the board from the left: three flop cards, then the turn, then the river.');
  }
  if (cardsIn('hero').length !== 2) throw new Error('Pick both of your cards.');
  for (const seat of activeSeats()) {
    if (cardsIn(seat).length === 1) throw new Error('Pick both cards for ' + seatName(seat).toLowerCase() + ' or leave both empty.');
  }
  return {
    version: 2, ruleset: 'holdem-nl',
    purpose: element<HTMLSelectElement>('purpose').value as Snapshot['purpose'],
    hero: cardsIn('hero'),
    board: cardsIn('board'),
    opponents: activeSeats().map(seat => {
      const cap = getNumber(seat + '-cap');
      return {
        stack: getNumber(seat + '-stack'), committed: getNumber(seat + '-bet'), cards: cardsIn(seat),
        ...(Number.isFinite(cap) ? { eligiblePot: cap } : {}),
      };
    }),
    pot: getNumber('pot'), heroStack: getNumber('hero-stack'),
    committed: getNumber('committed'), increment: getNumber('increment'),
  };
}

function setNumbers(values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) element<HTMLInputElement>(id).value = value;
}

element('load-example').addEventListener('click', () => {
  slots = emptySlots();
  const example: Partial<Record<SlotGroup, Card[]>> = { hero: ['As', 'Ks'], board: ['Qs', 'Js', '4d', '2s', '9c'] };
  for (const group of allGroups) example[group]?.forEach((card, i) => { slots[group][i] = { card, pending: false }; });
  setOpponentCount(1);
  setNumbers({
    purpose: 'simulation', pot: '120', 'hero-stack': '150', 'opp1-stack': '110', 'opp1-bet': '40',
    committed: '0', increment: '40',
  });
  invalidate();
  renderSlots();
  updateToCall();
});

element('reset-table').addEventListener('click', () => {
  slots = emptySlots();
  form.reset();
  setOpponentCount(Number(element<HTMLSelectElement>('players').value) - 1);
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
  const many = outlook.opponent.players > 1;
  const matchups = (outlook.opponent.method === 'exact' ? '; matchups are exact over ' : '; matchups are estimated from ')
    + outlook.opponent.matchups.toLocaleString()
    + (outlook.opponent.model === 'known' ? ' boards against the known opponent ' + (many ? 'hands' : 'hand') : many ? ' deals' : ' board and opponent-hand pairs');
  add(results, 'p', boards + matchups + '. Every unseen card counts as possible, and unknown opponents hold random hands. '
    + (many ? 'With several opponents you must beat the strongest of them. ' : '')
    + 'These are showdown odds if everyone reaches the river; they ignore betting, folds, and how opponents play.').className = 'fine-print';
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
      add(body, 'p', (outlook.opponent.players > 1 ? 'The strongest opponent beats it with:' : 'The opponent beats it with:')).className = 'detail-lead';
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
  const many = opponent.players > 1;
  add(summary, 'span', many
    ? 'Strongest opponent hand' + (opponent.model === 'known' ? ' (known cards)' : '')
    : opponent.model === 'known' ? 'Opponent’s hands (known cards)' : 'Opponent’s possible hands').className = 'cell name';
  const odds = add(summary, 'span', 'Wins ' + pct(opponent.beatsYou));
  odds.className = 'cell river';
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'detail';
  add(body, 'p', (many ? 'Opponents’ combined showdown equity ' : 'Opponent showdown equity ') + percent(opponent.equity)
    + ' · ' + (many ? 'someone beats you ' : 'beats you ') + pct(opponent.beatsYou) + ' of the time. '
    + (many ? 'How often the strongest opponent hand is each type, and how often it beats yours:'
      : 'How often they finish with each hand, and how often it beats yours:'));
  const table = document.createElement('table');
  table.className = 'opponent-table';
  const head = table.createTHead().insertRow();
  for (const label of [many ? 'Best hand' : 'Their hand', 'They make it', 'And beat you']) {
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

// ---------------------------------------------------------------------------
// Bet sizing
// ---------------------------------------------------------------------------
const styleLabels: Record<OpponentStyle, string> = { loose: 'Calls too much', balanced: 'Balanced', tight: 'Folds too much' };
let opponentStyle: OpponentStyle = 'balanced';
try {
  const saved = localStorage.getItem('poker-study:opponent-style');
  if (saved === 'loose' || saved === 'balanced' || saved === 'tight') opponentStyle = saved;
} catch {
  // Storage can be unavailable; keep the default.
}

const chips = (value: number) => (value === 1 ? '1 chip' : value.toLocaleString() + ' chips');
const signed = (value: number) => (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(1);

function describeOption(option: BetOption) {
  switch (option.kind) {
    case 'check': return 'Check';
    case 'fold': return 'Fold';
    case 'call': return 'Call ' + chips(option.put);
    default: {
      const verb = option.kind === 'bet' ? 'Bet ' + chips(option.put) : 'Raise to ' + chips(option.to);
      return verb + (option.allIn ? ' (all-in)' : option.coversOpponent ? ' (puts them all-in)' : '');
    }
  }
}

function showSizing(advice: BetAdvice) {
  add(results, 'h3', 'Bet sizing');
  const section = document.createElement('div');
  section.className = 'sizing';
  results.append(section);

  const picker = document.createElement('fieldset');
  picker.className = 'style-picker';
  add(picker, 'legend', 'Opponent style');
  const render = () => renderSizing(body, advice);
  for (const style of ['loose', 'balanced', 'tight'] as const) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'opponent-style';
    input.value = style;
    input.checked = style === opponentStyle;
    input.addEventListener('change', () => {
      opponentStyle = style;
      try { localStorage.setItem('poker-study:opponent-style', style); } catch { /* not saved */ }
      render();
    });
    label.append(input, ' ' + styleLabels[style]);
    picker.append(label);
  }
  // Keep style changes out of the form's input listener, which clears results.
  picker.addEventListener('input', event => event.stopPropagation());
  const body = document.createElement('div');
  section.append(picker, body);
  render();
}

function renderSizing(body: HTMLElement, advice: BetAdvice) {
  body.replaceChildren();
  const { options, best } = advice.byStyle[opponentStyle];
  const baseline = options.find(o => o.kind === 'check' || o.kind === 'call');
  const top = options[best];

  const headline = document.createElement('div');
  headline.className = 'sizing-headline';
  add(headline, 'p', 'Suggested').className = 'eyebrow';
  add(headline, 'p', describeOption(top)).className = 'sizing-action';
  let reason = 'Expected ' + signed(top.ev) + ' chips from here';
  if (baseline && top !== baseline) reason += ', versus ' + signed(baseline.ev) + ' for ' + describeOption(baseline).toLowerCase();
  if (top.kind === 'bet' || top.kind === 'raise') {
    reason += advice.players > 1
      ? '. Everyone folds ' + wholePct(top.foldChance) + '; when anyone calls you have ' + wholePct(top.equityWhenCalled) + ' equity.'
      : '. They fold ' + wholePct(top.foldChance) + '; when they call you have ' + wholePct(top.equityWhenCalled) + ' equity.';
  } else {
    reason += top.kind === 'check' ? '. No bet size beats checking against ' + (advice.players > 1 ? 'these opponents.' : 'this opponent.') : '.';
  }
  const fold = explainFold(advice, opponentStyle);
  if (fold) {
    // Spell out why: the price of calling against what the call wins.
    reason = 'Calling costs ' + chips(fold.cost) + ' to win a pot of ' + chips(fold.winnablePot)
      + ', so you need ' + wholePct(fold.needEquity) + ' equity. You have about ' + wholePct(fold.haveEquity)
      + ', so calling loses about ' + fold.callLoss.toFixed(1) + ' chips on average.';
  }
  add(headline, 'p', reason);
  if (fold?.bestRaise) {
    const raise = fold.bestRaise;
    add(headline, 'p', 'Raising does not rescue it: the best raise (to ' + chips(raise.to) + (raise.allIn ? ', all-in' : '') + ') '
      + (raise.ev < 0 ? 'still loses about ' + (-raise.ev).toFixed(1) + ' chips' : 'gains only ' + signed(raise.ev) + ' chips')
      + '. ' + (advice.players > 1 ? 'Everyone folds only ' : 'They fold only ') + wholePct(raise.foldChance)
      + ', and you have ' + wholePct(raise.equityWhenCalled) + ' equity when called.');
  }
  if (fold) {
    add(headline, 'p', fold.otherStyles.length
      ? fold.otherStyles.map(({ style, option }) => 'Against an opponent who ' + styleLabels[style].toLowerCase()
        + ', ' + describeOption(option).toLowerCase() + ' instead (' + signed(option.ev) + ').').join(' ')
      : 'Fold against every opponent style.');
    if (advice.streetsLeft > 0) {
      add(headline, 'p', 'Before the river this ignores later betting, which can change the answer either way.');
    }
  }
  body.append(headline);

  if (advice.sensitive && !fold) {
    const parts = (['loose', 'balanced', 'tight'] as const).map(style => {
      const choice = advice.byStyle[style];
      return styleLabels[style].toLowerCase() + ': ' + describeOption(choice.options[choice.best]).toLowerCase();
    });
    add(body, 'p', 'Depends on the opponent — ' + parts.join('; ') + '.').className = 'sizing-warning';
  }

  const table = document.createElement('table');
  table.className = 'sizing-table';
  const head = table.createTHead().insertRow();
  for (const label of ['Action', 'They fold', 'Equity if called', 'Expected']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  const rows = table.createTBody();
  options.forEach((option, i) => {
    const line = rows.insertRow();
    if (i === best) line.className = 'best';
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = describeOption(option) + (i === best ? ' ★' : '');
    line.append(name);
    const aggressive = option.kind === 'bet' || option.kind === 'raise';
    line.insertCell().textContent = aggressive ? wholePct(option.foldChance) : '—';
    line.insertCell().textContent = option.kind === 'fold' ? '—' : wholePct(option.equityWhenCalled);
    line.insertCell().textContent = signed(option.ev);
  });
  body.append(table);

  const notes = [
    'Expected chips you gain from this decision on, counting what is already in the pot. '
      + (advice.players > 1
        ? 'Each opponent ranks their possible hands by how strong they look on this board, calls with the strongest, and never re-raises; chips are paid out through main and side pots. Estimated from sampled deals.'
        : 'The opponent ranks their possible hands by how strong they look on this board, calls with the strongest, and never re-raises.'),
    styleLabels[opponentStyle] + ': ' + (opponentStyle === 'balanced'
      ? (advice.players > 1 ? 'the table folds together just often enough that a pure bluff breaks even.' : 'folds just often enough that a pure bluff breaks even.')
      : opponentStyle === 'loose' ? 'folds half as often as a balanced player.' : 'folds 1.6 times as often as a balanced player.'),
  ];
  if (advice.streetsLeft > 0) notes.push('Later streets are treated as checked down, which tends to favor bigger bets now. Treat sizes before the river as rough.');
  if (advice.opponent === 'known') notes.push('With known opponent cards (hindsight), each known hand calls or folds by where it ranks in the range.');
  if (advice.players > 1) notes.push('Players who still had to act on an earlier bet keep their current chips in and do not add more unless you bet.');
  add(body, 'p', notes.join(' ')).className = 'fine-print';
}

function show(result: ReturnType<typeof analyze>, scenario: Snapshot) {
  element('result-empty').hidden = true;
  const equity = result.equity;
  add(results, 'p', 'SHOWDOWN EQUITY').className = 'eyebrow';
  add(results, 'p', percent(equity.share)).className = 'equity';
  add(results, 'p', 'Win ' + percent(equity.win) + ' · Tie ' + percent(equity.tie) + ' · Loss ' + percent(equity.loss));
  const known = scenario.opponents.filter(o => o.cards.length).length;
  const count = scenario.opponents.length;
  const model = count === 1
    ? (known ? 'Known opponent cards (hindsight if reconstructed)' : 'Uniform random opponent hand')
    : 'Against ' + count + ' opponents · ' + (known === count ? 'all hands known (hindsight if reconstructed)'
      : known ? known + ' known, ' + (count - known) + ' random' : 'random hands');
  add(results, 'p', model + ' · ' + equity.trials.toLocaleString() + (equity.method === 'exact' ? ' exact outcomes' : ' simulated draws'));
  if (equity.method === 'sampled') {
    add(results, 'p', '95% sampling bound: ' + equity.interval.map(percent).join(' to '));
  }
  add(results, 'h3', 'Best hand so far');
  add(results, 'p', result.rank ? result.rank.name + ' · ' + result.rank.cards.join(' ') : 'Available after the flop.');
  if (result.sizing) showSizing(result.sizing);
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
  if (groupsInPlay().some(group => slots[group].some(slot => slot.pending))) {
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

function applyRecognition(recognition: Extract<Recognition, { kind: 'observations' }>) {
  slots = emptySlots();
  // Seat as many opponents as the photo shows; never fewer than one.
  if (recognition.opponentSeats > 0) setOpponentCount(recognition.opponentSeats);
  for (const observation of recognition.slots) {
    const group: SlotGroup = observation.group === 'opponent' ? seatGroups[(observation.seat ?? 1) - 1] : observation.group;
    slots[group][observation.index] = {
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

setOpponentCount(Number(element<HTMLSelectElement>('players').value) - 1);

/** Put a decision from a replayed hand on the study table, ready to analyze. */
function loadSnapshot(s: Snapshot) {
  slots = emptySlots();
  setOpponentCount(s.opponents.length);
  s.hero.forEach((card, i) => { slots.hero[i] = { card, pending: false }; });
  s.board.forEach((card, i) => { slots.board[i] = { card, pending: false }; });
  s.opponents.forEach((o, k) => {
    const seat = seatGroups[k];
    o.cards.forEach((card, i) => { slots[seat][i] = { card, pending: false }; });
    setNumbers({ [seat + '-stack']: String(o.stack), [seat + '-bet']: String(o.committed) });
  });
  setNumbers({
    purpose: s.purpose, pot: String(s.pot), 'hero-stack': String(s.heroStack),
    committed: String(s.committed), increment: String(s.increment),
  });
  updateToCall();
  s.opponents.forEach((o, k) => {
    if (o.eligiblePot !== undefined) element<HTMLInputElement>(seatGroups[k] + '-cap').value = String(o.eligiblePot);
  });
  invalidate();
  renderSlots();
  status.textContent = 'Loaded a decision onto the table. Choose the study context if needed, then select Analyze hand.';
  element('table-title').scrollIntoView({ block: 'start' });
}

let screenshotImport: { leave(): void } | null = null;
let physicalScan: { leave(): void } | null = null;
const replay = initReplay({ onAnalyze: loadSnapshot, onLeaveScreenshot: () => screenshotImport?.leave(), onLeavePhysical: () => physicalScan?.leave() });
screenshotImport = initScreenshotImport({ loadIntoTable: loadSnapshot, replay });
const tracker = initReconstruction({ replay });
physicalScan = initPhysicalScan({ loadIntoTable: loadSnapshot, showStudy: () => replay.showView('study'), track: tracker });
initBenchmarks();

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
