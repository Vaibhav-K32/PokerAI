// Hand replay and hand history views. Read-only: an opened hand is frozen,
// replayed once into a list of states, and only ever read after that.
import type { Card, Snapshot } from '../core/types.js';
import { moveCursor, playbackDelay, type CursorMove } from '../history/cursor.js';
import { demoHand } from '../history/demo.js';
import { describeEvent, sectionTitles, type TimelineEntry } from '../history/describe.js';
import { bigBlindSeat, createHandState, potTotal, replaySteps, smallBlindSeat } from '../history/engine.js';
import { parseHistory, serializeHistory, type HandHistory } from '../history/history.js';
import { toAnalysisSnapshot } from '../history/snapshot.js';
import type { GameState, PlayerState } from '../history/types.js';
import { loadHands, saveHands } from './hand-store.js';
import { renderBoard, renderSeats, type TableSeat } from './table-view.js';

const MAX_IMPORT_BYTES = 1024 * 1024;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: ' + id);
  return node as T;
}

function add(parent: HTMLElement, tag: string, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export interface ReplayController {
  showView(view: 'study' | 'replay' | 'screenshot' | 'reconstruct'): void;
  /** Reload saved hands from storage and redraw the list. */
  reloadHands(): void;
  /** Open a saved hand at a replay position and show the replay view. */
  openHand(handId: string, position: number): boolean;
}

export function initReplay(options: { onAnalyze: (snapshot: Snapshot) => void; onLeaveScreenshot?: () => void }): ReplayController {
  const views = ['study', 'replay', 'screenshot', 'reconstruct'] as const;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.view-tab')];
  const status = element('history-status');
  const list = element('hand-list');
  const body = element('replay-body');
  const playButton = element<HTMLButtonElement>('replay-play');
  const speed = element<HTMLSelectElement>('replay-speed');
  const scrub = element<HTMLInputElement>('replay-scrub');
  const timeline = element('replay-timeline');
  const analyzeButton = element<HTMLButtonElement>('replay-analyze');

  let hands: HandHistory[] = [];
  let current: { history: HandHistory; states: GameState[]; entries: TimelineEntry[] } | null = null;
  let position = 0;
  let timer: number | null = null;
  let renaming: string | null = null;

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------
  function showView(view: string) {
    if (view !== 'replay') pause();
    if (view !== 'screenshot') options.onLeaveScreenshot?.();
    for (const name of views) element(name + '-view').hidden = name !== view;
    for (const tab of tabs) {
      if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
  }
  for (const tab of tabs) tab.addEventListener('click', () => showView(tab.dataset.view ?? 'study'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('pagehide', pause);

  // -------------------------------------------------------------------------
  // Saved hands
  // -------------------------------------------------------------------------
  function persist(next: HandHistory[]): boolean {
    try {
      saveHands(next);
      hands = next;
      return true;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The hands could not be saved.';
      return false;
    }
  }

  function upsert(history: HandHistory): boolean {
    const others = hands.filter(h => h.id !== history.id);
    return persist([history, ...others]);
  }

  function renderList() {
    list.replaceChildren();
    if (!hands.length) {
      add(list, 'li', 'No saved hands yet. Load the demo hand or import a JSON file.', 'empty-list');
      return;
    }
    for (const hand of hands) {
      const item = add(list, 'li', '', 'hand-item' + (current?.history.id === hand.id ? ' open' : ''));
      if (renaming === hand.id) {
        const form = document.createElement('form');
        form.className = 'rename';
        const label = add(form, 'label', 'New name');
        const input = document.createElement('input');
        input.value = hand.name;
        input.maxLength = 80;
        input.required = true;
        label.append(input);
        const save = add(form, 'button', 'Save') as HTMLButtonElement;
        save.type = 'submit';
        const cancel = add(form, 'button', 'Cancel', 'secondary') as HTMLButtonElement;
        cancel.type = 'button';
        cancel.addEventListener('click', () => { renaming = null; renderList(); });
        form.addEventListener('submit', event => {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          renaming = null;
          if (upsert({ ...hand, name })) {
            status.textContent = 'Renamed to “' + name + '”.';
            if (current?.history.id === hand.id) open(hands[0], position);
          }
          renderList();
        });
        item.append(form);
        queueMicrotask(() => input.focus());
        continue;
      }
      const openButton = add(item, 'button', hand.name, 'hand-open') as HTMLButtonElement;
      openButton.type = 'button';
      openButton.addEventListener('click', () => open(hand));
      const winners = hand.result.winners.map(id => hand.setup.players.find(p => p.id === id)?.name ?? id);
      add(item, 'p', new Date(hand.createdAt).toLocaleString() + ' · ' + hand.playerCount + ' players · '
        + hand.result.status + (winners.length ? ' · won by ' + winners.join(', ') : ''), 'hand-meta');
      const actions = add(item, 'div', '', 'actions small-actions');
      const button = (text: string, label: string, handler: () => void) => {
        const b = add(actions, 'button', text, 'secondary') as HTMLButtonElement;
        b.type = 'button';
        b.setAttribute('aria-label', label + ' ' + hand.name);
        b.addEventListener('click', handler);
      };
      button('Rename', 'Rename', () => { renaming = hand.id; renderList(); });
      button('Export', 'Export', () => exportHand(hand));
      button('Delete', 'Delete', () => {
        if (!confirm('Delete “' + hand.name + '” from this browser? Export it first if you want to keep a copy.')) return;
        if (persist(hands.filter(h => h.id !== hand.id))) {
          status.textContent = 'Deleted “' + hand.name + '”.';
          if (current?.history.id === hand.id) close();
          renderList();
        }
      });
    }
  }

  function exportHand(hand: HandHistory) {
    const blob = new Blob([serializeHistory(hand)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = hand.id.replace(/[^\w.-]+/g, '-') + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Exported “' + hand.name + '”.';
  }

  element('load-demo').addEventListener('click', () => {
    const demo = demoHand();
    if (upsert(demo)) {
      status.textContent = 'Loaded the demo hand.';
      open(demo);
      renderList();
    }
  });

  const importInput = element<HTMLInputElement>('import-hand');
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      status.textContent = 'That file is larger than 1 MB, which is too big for one hand.';
      return;
    }
    try {
      const history = parseHistory(await file.text());
      if (hands.some(h => h.id === history.id)
        && !confirm('A saved hand already uses the ID “' + history.id + '”. Replace it with the imported one?')) return;
      if (upsert(history)) {
        status.textContent = 'Imported “' + history.name + '”.';
        open(history);
        renderList();
      }
    } catch (error) {
      status.textContent = 'Import failed: ' + (error instanceof Error ? error.message : 'unreadable file.');
    }
  });

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------
  function open(history: HandHistory, at = 0) {
    pause();
    const frozen = deepFreeze(structuredClone(history));
    const states = replaySteps(createHandState(frozen.setup), frozen.events);
    current = {
      history: frozen,
      states,
      entries: frozen.events.map((event, i) => describeEvent(states[i], event)),
    };
    body.hidden = false;
    element('replay-title').textContent = frozen.name;
    const setup = frozen.setup;
    element('replay-meta').textContent = frozen.playerCount + ' players · blinds ' + setup.smallBlind + '/' + setup.bigBlind
      + (setup.ante ? ' · ante ' + setup.ante : '') + ' · ' + frozen.events.length + ' events · ' + frozen.result.status;
    scrub.max = String(frozen.events.length);
    renderAttachments();
    renderTimeline();
    go(at);
    renderList();
  }

  function close() {
    pause();
    current = null;
    body.hidden = true;
    analyzeButton.hidden = true;
    element('replay-title').textContent = 'Hand replay';
    element('replay-meta').textContent = 'Load the demo hand or open a saved hand.';
  }

  function renderAttachments() {
    const box = element('replay-attachments');
    box.replaceChildren();
    const attachments = current?.history.attachments ?? [];
    box.hidden = !attachments.length;
    if (!attachments.length || !current) return;
    add(box, 'h3', 'Attached screenshots');
    const items = add(box, 'ul', '', 'attachment-list');
    for (const a of attachments) {
      const item = add(items, 'li');
      const button = add(item, 'button', a.label + ' · event ' + a.position, 'secondary') as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => { pause(); go(a.position); });
      add(item, 'span', ' Observed state; it adds no events to the hand.', 'fine-print');
    }
  }

  function renderTimeline() {
    timeline.replaceChildren();
    if (!current) return;
    const startItem = add(timeline, 'li', '', 'timeline-entry');
    const startButton = add(startItem, 'button', 'Before the first event') as HTMLButtonElement;
    startButton.type = 'button';
    startButton.dataset.position = '0';
    let section = '';
    current.entries.forEach((entry, i) => {
      if (entry.section !== section) {
        section = entry.section;
        add(timeline, 'li', sectionTitles[entry.section], 'timeline-section').setAttribute('aria-hidden', 'true');
      }
      const item = add(timeline, 'li', '', 'timeline-entry');
      const button = add(item, 'button', entry.text) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.position = String(i + 1);
      button.setAttribute('aria-label', sectionTitles[entry.section] + ': ' + entry.text);
    });
  }

  timeline.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-position]');
    if (!button) return;
    pause();
    go(Number(button.dataset.position));
  });

  function go(move: CursorMove) {
    if (!current) return;
    position = moveCursor(position, current.history.events.length, move);
    render();
  }

  function seatBadges(state: GameState, p: PlayerState): string[] {
    const badges: string[] = [];
    if (p.seat === state.dealer) badges.push('Dealer');
    if (p.seat === smallBlindSeat(state)) badges.push('SB');
    if (p.seat === bigBlindSeat(state)) badges.push('BB');
    if (p.status === 'folded') badges.push('Folded');
    if (p.status === 'all-in') badges.push('All-in');
    if (state.actor === p.seat) badges.push('To act');
    return badges;
  }

  function seatModel(state: GameState, p: PlayerState): TableSeat {
    return {
      name: p.name, badges: seatBadges(state, p), status: p.status, acting: state.actor === p.seat,
      cards: p.cards, stack: p.stack, bet: p.committed,
    };
  }

  const phaseLabels: Record<GameState['phase'], string> = {
    preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown', complete: 'Hand complete', cancelled: 'Cancelled',
  };

  function render() {
    if (!current) return;
    const state = current.states[position];
    const total = current.history.events.length;
    renderSeats(element('replay-seats-top'), element('replay-seats-bottom'), state.players.map(p => seatModel(state, p)));
    element('replay-felt').dataset.seats = String(state.players.length);
    renderBoard(element('replay-board'), state.board);
    const step = state.step === 'start' ? 'Not started' : state.step === 'post' ? 'Posting blinds' : phaseLabels[state.phase];
    element('replay-phase').textContent = step;
    const pot = potTotal(state);
    const awarded = state.players.reduce((sum, p) => sum + p.won, 0);
    element('replay-pot').textContent = 'Pot ' + pot.toLocaleString() + (awarded ? ' · awarded ' + awarded.toLocaleString() : '');
    element('replay-last').textContent = position === 0 ? 'Before the first event.' : current.entries[position - 1].text;
    element('replay-position').textContent = position + ' of ' + total;
    scrub.value = String(position);
    scrub.setAttribute('aria-valuetext', 'Event ' + position + ' of ' + total
      + (position ? ': ' + current.entries[position - 1].text : ', before the first event'));

    element<HTMLButtonElement>('replay-first').disabled = position === 0;
    element<HTMLButtonElement>('replay-prev').disabled = position === 0;
    element<HTMLButtonElement>('replay-next').disabled = position === total;
    element<HTMLButtonElement>('replay-last-btn').disabled = position === total;

    for (const button of timeline.querySelectorAll<HTMLButtonElement>('button[data-position]')) {
      const selected = Number(button.dataset.position) === position;
      button.classList.toggle('selected', selected);
      if (selected) {
        button.setAttribute('aria-current', 'step');
        button.scrollIntoView({ block: 'nearest' });
      } else {
        button.removeAttribute('aria-current');
      }
    }

    let snapshot: Snapshot | null = null;
    try {
      snapshot = toAnalysisSnapshot(state);
    } catch {
      snapshot = null;
    }
    analyzeButton.hidden = !snapshot;
    analyzeButton.onclick = snapshot ? () => { pause(); options.onAnalyze(snapshot!); showView('study'); } : null;
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------
  function pause() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    playButton.textContent = 'Play';
    playButton.setAttribute('aria-pressed', 'false');
  }

  function tick() {
    if (!current) return pause();
    if (position >= current.history.events.length) return pause();
    go('next');
    if (position >= current.history.events.length) return pause();
    timer = window.setTimeout(tick, playbackDelay(Number(speed.value)));
  }

  playButton.addEventListener('click', () => {
    if (!current) return;
    if (timer !== null) return pause();
    if (position >= current.history.events.length) go('first');
    playButton.textContent = 'Pause';
    playButton.setAttribute('aria-pressed', 'true');
    timer = window.setTimeout(tick, playbackDelay(Number(speed.value)));
  });
  speed.addEventListener('change', () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = window.setTimeout(tick, playbackDelay(Number(speed.value)));
  });
  element('replay-first').addEventListener('click', () => { pause(); go('first'); });
  element('replay-prev').addEventListener('click', () => { pause(); go('previous'); });
  element('replay-next').addEventListener('click', () => { pause(); go('next'); });
  element('replay-last-btn').addEventListener('click', () => { pause(); go('last'); });
  scrub.addEventListener('input', () => { pause(); go(Number(scrub.value)); });

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------
  function reloadHands() {
    const loaded = loadHands();
    hands = loaded.hands;
    if (loaded.problems.length) status.textContent = loaded.problems.join(' ');
    if (current && !hands.some(h => h.id === current!.history.id)) close();
    renderList();
  }
  reloadHands();

  return {
    showView,
    reloadHands,
    openHand(handId, at) {
      reloadHands();
      const hand = hands.find(h => h.id === handId);
      if (!hand) return false;
      showView('replay');
      open(hand, at);
      return true;
    },
  };
}
