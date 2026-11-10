// Reconstruct hand: upload several screenshots of one hand, order them, read
// each through the screenshot recognition providers (two at a time), review
// and correct each one, and walk the checkpoint timeline. Intervals between
// screenshots stay unresolved unless the user confirms actions, which the
// hand engine checks. Nothing here changes the study table or saved hands.
import { createHandState, replaySteps } from '../history/engine.js';
import { moveCursor } from '../history/cursor.js';
import type { GameState } from '../history/types.js';
import { SEQUENCE_FIXTURES, sequenceById } from '../reconstruction/fixtures.js';
import { createObservation, middleChips, seatName, withRecognition } from '../reconstruction/observation.js';
import { RecognitionQueue } from '../reconstruction/queue.js';
import { matchHistory, reconstructHand } from '../reconstruction/reconstruct.js';
import { ACTION_LABELS } from '../reconstruction/resolve.js';
import {
  addScreenshots, createSession, liveResolutions, moveScreenshot, parseSession, removeScreenshot, sequenceObservations,
  serializeSession, setResolution, uploadOrder,
} from '../reconstruction/session.js';
import {
  MAX_SCREENSHOTS,
  type Checkpoint, type HandObservation, type Interval, type IntervalResolution, type ManualActionType,
  type ReconstructionResult, type ReconstructionSession, type ScreenshotEntry, type StateDifference,
} from '../reconstruction/types.js';
import { claudeScreenshotProvider, fixtureProvider, type ScreenshotProvider } from '../vision/providers.js';
import { drawTable } from '../vision/screenshot-fixtures.js';
import type { ScreenshotRecognition } from '../vision/screenshot.js';
import { loadHands } from './hand-store.js';
import { decodeImage, fileProblem, jpegDataUrlToBlob, prepareUpload, svgToPng } from './image.js';
import { renderRecognitionEditor } from './recognition-editor.js';
import { loadReconstructions, saveReconstructions } from './reconstruction-store.js';
import type { ReplayController } from './replay.js';
import { renderBoard, renderSeats, type TableSeat } from './table-view.js';

const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

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

function button(parent: HTMLElement, text: string, className = 'secondary', label?: string) {
  const b = add(parent, 'button', text, className);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

interface Shot {
  entry: ScreenshotEntry;
  /** Object URL or data URL for display, if the image is available. */
  url: string | null;
  objectUrl: boolean;
  /** Decoded image, needed to send it for recognition. */
  bitmap: ImageBitmap | null;
  provider: ScreenshotProvider | null;
}

const STATUS_LABELS: Record<Interval['status'], string> = {
  unchanged: 'No change', verified: 'Verified', unresolved: 'Unresolved', acknowledged: 'Left unresolved',
  resolved: 'Resolved', partial: 'Partly resolved', contradiction: 'Contradiction', 'different-hands': 'Different hands',
};

export function initReconstruction(options: { replay: ReplayController }) {
  const status = element('recon-status');
  const readButton = element<HTMLButtonElement>('recon-read');
  const cancelButton = element<HTMLButtonElement>('recon-cancel');
  const clearButton = element<HTMLButtonElement>('recon-clear');
  const uploadOrderButton = element<HTMLButtonElement>('recon-upload-order');
  const fileInput = element<HTMLInputElement>('recon-file');
  const sample = element<HTMLSelectElement>('recon-sample');
  const drop = element('recon-drop');
  const list = element('recon-list');
  const changes = element('recon-changes');
  const editorBox = element('recon-editor-box');
  const editor = element('recon-editor');
  const editButton = element<HTMLButtonElement>('recon-edit');
  const reviewedButton = element<HTMLButtonElement>('recon-mark-reviewed');
  const scrub = element<HTMLInputElement>('recon-scrub');
  const timeline = element('recon-timeline');
  const nameInput = element<HTMLInputElement>('recon-name');
  const keepImages = element<HTMLInputElement>('recon-keep-images');

  for (const s of SEQUENCE_FIXTURES) {
    const option = add(sample, 'option', s.label);
    option.value = s.id;
  }

  let shots: Shot[] = [];
  const observations = new Map<string, HandObservation>();
  let resolutions: IntervalResolution[] = [];
  let result: ReconstructionResult = reconstructHand([]);
  let selected: string | null = null;
  let editing = false;
  /** Stepping through confirmed actions of the interval ending at the selected screenshot. */
  let actionStep: number | null = null;
  let session = newSession();
  let dirty = false;
  let lastTable: { observation: HandObservation | undefined; step: number | null; interval: Interval | undefined } | null = null;
  let counter = 0;
  let renaming: string | null = null;

  function newSession() {
    const now = new Date().toISOString();
    return { id: 'recon-' + Date.now().toString(36), title: '', createdAt: now };
  }
  const makeId = () => 'shot-' + Date.now().toString(36) + '-' + ++counter;
  const entries = () => shots.map(s => s.entry);
  const shotById = (id: string) => shots.find(s => s.entry.id === id);
  const indexOf = (id: string) => shots.findIndex(s => s.entry.id === id);

  // -------------------------------------------------------------------------
  // Recognition queue
  // -------------------------------------------------------------------------
  const queue = new RecognitionQueue({
    concurrency: 2,
    run: async (id, signal) => {
      const shot = shotById(id);
      if (!shot?.bitmap || !shot.provider) return { kind: 'failed', reason: 'The image is not available in this session. Add it again.', retryable: false };
      const upload = await prepareUpload(shot.bitmap);
      if (signal.aborted) return { kind: 'cancelled' };
      return shot.provider.recognize(upload, signal);
    },
    onRecognized: (id, recognition) => {
      if (!shotById(id) || observations.has(id)) return;
      observations.set(id, createObservation(id, indexOf(id), recognition));
      selected ??= id;
      dirty = true;
      refresh();
    },
    onChange: () => {
      renderProgress();
      renderList();
    },
  });

  // -------------------------------------------------------------------------
  // Adding screenshots
  // -------------------------------------------------------------------------
  async function addFiles(files: readonly File[], providerFor: (file: File, i: number) => ScreenshotProvider) {
    const room = MAX_SCREENSHOTS - shots.length;
    const problems: string[] = [];
    if (files.length > room) problems.push((files.length - Math.max(room, 0)) + ' file(s) skipped: a reconstruction holds at most ' + MAX_SCREENSHOTS + ' screenshots.');
    const accepted: { file: File; bitmap: ImageBitmap; provider: ScreenshotProvider }[] = [];
    status.textContent = 'Opening the images on this device…';
    let i = 0;
    for (const file of files.slice(0, Math.max(room, 0))) {
      const problem = fileProblem(file);
      if (problem) {
        problems.push(file.name + ': ' + problem);
        i++;
        continue;
      }
      try {
        accepted.push({ file, bitmap: await decodeImage(file), provider: providerFor(file, i) });
      } catch (error) {
        problems.push(file.name + ': ' + (error instanceof Error ? error.message : 'could not be opened.'));
      }
      i++;
    }
    const { added } = addScreenshots(entries(), accepted.map(a => a.file.name), makeId);
    added.forEach((entry, k) => {
      const a = accepted[k];
      shots.push({ entry, url: URL.createObjectURL(a.file), objectUrl: true, bitmap: a.bitmap, provider: a.provider });
    });
    if (added.length) dirty = true;
    status.textContent = (added.length ? added.length + ' screenshot' + (added.length === 1 ? '' : 's') + ' added. ' : '')
      + problems.join(' ') + (added.length ? ' Check the order, then press Read screenshots.' : '');
    refresh();
  }

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void addFiles(files, () => claudeScreenshotProvider());
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files, () => claudeScreenshotProvider());
  });
  drop.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  sample.addEventListener('change', async () => {
    const seq = sequenceById(sample.value);
    sample.value = '';
    if (!seq) return;
    if (shots.length && !confirm('Replace the current screenshots with the sample “' + seq.label + '”?')) return;
    reset();
    try {
      const files = await Promise.all(seq.frames.map((f, i) => svgToPng(drawTable(f.table), seq.id + '-' + (i + 1) + '.png')));
      await addFiles(files, (_file, i) => fixtureProvider(seq.frames[i].response, 'sample:' + seq.frames[i].id));
      session.title = seq.label;
      status.textContent = 'Sample loaded: ' + seq.description + ' Press Read screenshots; samples use stored results and make no API calls.';
      refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The sample could not be drawn.';
    }
  });

  readButton.addEventListener('click', () => {
    const ids = shots.filter(s => !observations.has(s.entry.id) && s.bitmap).map(s => s.entry.id);
    for (const id of ids) {
      const job = queue.status(id);
      if (job?.status === 'failed') queue.retry(id);
    }
    queue.enqueue(ids);
    status.textContent = shots.some(s => s.provider?.id === 'claude' && ids.includes(s.entry.id))
      ? 'Reading with Claude, two at a time. Each screenshot can take up to a minute.'
      : 'Reading…';
  });
  cancelButton.addEventListener('click', () => {
    queue.cancelAll();
    status.textContent = 'Stopped. Screenshots already read are kept; press Read screenshots to continue.';
    refresh();
  });
  clearButton.addEventListener('click', () => {
    if (dirty && !confirm('Start over? Unsaved screenshots, corrections, and confirmed actions will be lost.')) return;
    reset();
    status.textContent = 'Cleared.';
    refresh();
  });
  uploadOrderButton.addEventListener('click', () => {
    reorder(uploadOrder(entries()));
    status.textContent = 'Restored the order the screenshots were added in.';
  });

  function releaseShot(shot: Shot) {
    shot.bitmap?.close();
    if (shot.objectUrl && shot.url) URL.revokeObjectURL(shot.url);
  }

  function reset() {
    queue.clear();
    for (const s of shots) releaseShot(s);
    shots = [];
    observations.clear();
    resolutions = [];
    selected = null;
    editing = false;
    actionStep = null;
    session = newSession();
    dirty = false;
    lastTable = null;
    keepImages.checked = false;
    element('recon-match-result').replaceChildren();
    element('recon-save-note').textContent = '';
  }

  function reorder(next: readonly ScreenshotEntry[]) {
    shots = next.map(e => shotById(e.id)!).filter(Boolean);
    shots.forEach((s, i) => { s.entry = next[i]; });
    actionStep = null;
    dirty = true;
    refresh();
  }

  function remove(id: string) {
    const shot = shotById(id);
    if (!shot) return;
    if (observations.get(id)?.reviewStatus === 'corrected' && !confirm('Remove this screenshot and your corrections to it?')) return;
    queue.remove(id);
    releaseShot(shot);
    shots = shots.filter(s => s !== shot);
    observations.delete(id);
    if (selected === id) selected = shots.find(s => observations.has(s.entry.id))?.entry.id ?? null;
    dirty = true;
    refresh();
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  function refresh() {
    const ordered = sequenceObservations(entries(), observations);
    for (const o of ordered) observations.set(o.screenshotId, o);
    resolutions = liveResolutions(ordered, resolutions);
    result = reconstructHand(ordered, { resolutions, screenshotCount: shots.length });
    if (selected && !observations.has(selected)) selected = ordered[0]?.screenshotId ?? null;
    if (!selected && ordered.length) selected = ordered[0].screenshotId;
    render();
  }

  const observationById = (id: string) => [...observations.values()].find(o => o.id === id);
  const selectedObservation = () => (selected ? observations.get(selected) : undefined);
  const selectedCheckpoint = () => result.checkpoints.findIndex(c => c.screenshotId === selected);
  /** The interval that ends at the selected screenshot. */
  const incomingInterval = () => {
    const at = selectedCheckpoint();
    return at > 0 ? result.intervals[at - 1] : undefined;
  };

  function select(id: string | null) {
    if (id !== selected) actionStep = null;
    selected = id;
    render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function render() {
    const any = shots.length > 0;
    element('recon-main').hidden = !any;
    element('recon-timeline-panel').hidden = result.checkpoints.length === 0;
    element('recon-session-panel').hidden = !any;
    clearButton.hidden = !any;
    uploadOrderButton.hidden = shots.length < 2;
    renderProgress();
    renderList();
    renderTable();
    renderEditor();
    renderChanges();
    renderTimeline();
    renderSummary();
  }

  function renderProgress() {
    const progress = queue.progress();
    const unread = shots.filter(s => !observations.has(s.entry.id)).length;
    const readable = shots.filter(s => !observations.has(s.entry.id) && s.bitmap).length;
    readButton.disabled = queue.busy || readable === 0;
    readButton.textContent = readable && readable < shots.length ? 'Read ' + readable + ' remaining' : 'Read screenshots';
    cancelButton.hidden = !queue.busy;
    drop.classList.toggle('busy', queue.busy);
    const box = element('recon-progress');
    box.hidden = !shots.length;
    box.replaceChildren();
    const needReview = result.checkpoints.filter(c => c.reviewStatus === 'pending' || c.reviewCount > 0 || c.contradictions.length).length;
    const processing = progress.processing.map(id => '#' + (indexOf(id) + 1)).join(', ');
    const rows: [string, string][] = [
      ['Screenshots', String(shots.length)],
      ['Read', String(shots.length - unread)],
      ['Reading now', processing || '—'],
      ['Need review', String(needReview)],
      ['Failed', String(shots.filter(s => queue.status(s.entry.id)?.status === 'failed').length)],
    ];
    for (const [k, v] of rows) {
      const row = add(box, 'div');
      add(row, 'dt', k);
      add(row, 'dd', v);
    }
    if (!queue.busy && progress.total && status.textContent?.startsWith('Reading')) {
      status.textContent = 'Done reading. ' + (progress.failed ? progress.failed + ' failed; use Retry on each.' : 'Review each screenshot, then check the changes.');
    }
  }

  function jobLabel(id: string): [string, string] {
    const o = observations.get(id);
    if (o) {
      const cp = result.checkpoints.find(c => c.screenshotId === id);
      if (cp?.contradictions.length) return ['Conflict', 'error'];
      if (o.reviewStatus === 'corrected') return ['Corrected', 'high'];
      if (o.reviewStatus === 'reviewed') return ['Reviewed', 'high'];
      return [cp?.reviewCount ? 'Needs review' : 'Recognized', 'review'];
    }
    const job = queue.status(id);
    if (!job) return [shotById(id)?.bitmap ? 'Not read yet' : 'Image not saved', 'unknown'];
    if (job.status === 'queued') return ['Queued', 'unknown'];
    if (job.status === 'processing') return ['Reading…', 'review'];
    if (job.status === 'failed') return ['Failed', 'error'];
    if (job.status === 'cancelled') return ['Stopped', 'unknown'];
    return ['Recognized', 'review'];
  }

  let dragging: string | null = null;
  function renderList() {
    list.replaceChildren();
    shots.forEach((shot, i) => {
      const id = shot.entry.id;
      const item = add(list, 'li', '', 'recon-item' + (id === selected ? ' selected' : ''));
      item.draggable = true;
      item.addEventListener('dragstart', () => { dragging = id; item.classList.add('drag'); });
      item.addEventListener('dragend', () => { dragging = null; item.classList.remove('drag'); });
      item.addEventListener('dragover', event => { if (dragging && dragging !== id) event.preventDefault(); });
      item.addEventListener('drop', event => {
        event.preventDefault();
        if (dragging && dragging !== id) reorder(moveScreenshot(entries(), dragging, i));
      });
      const open = add(item, 'button', '', 'recon-open');
      open.type = 'button';
      open.disabled = !observations.has(id);
      open.addEventListener('click', () => select(id));
      if (shot.url) {
        const img = add(open, 'img', '', 'recon-thumb');
        img.src = shot.url;
        img.alt = '';
      } else {
        add(open, 'span', 'No image', 'recon-thumb placeholder');
      }
      const text = add(open, 'span', '', 'recon-item-text');
      add(text, 'strong', '#' + (i + 1));
      add(text, 'span', shot.entry.label, 'recon-label');
      const [label, level] = jobLabel(id);
      add(text, 'span', label, 'indicator ind-' + level);
      open.setAttribute('aria-label', 'Screenshot ' + (i + 1) + ', ' + shot.entry.label + ', ' + label + (open.disabled ? '' : '. Show on the table.'));
      const job = queue.status(id);
      if (job?.status === 'failed') add(item, 'p', job.error ?? 'Recognition failed.', 'fine-print issue-error');
      const tools = add(item, 'div', '', 'actions small-actions');
      const up = button(tools, '↑', 'secondary', 'Move screenshot ' + (i + 1) + ' earlier');
      up.disabled = i === 0;
      up.addEventListener('click', () => reorder(moveScreenshot(entries(), id, i - 1)));
      const down = button(tools, '↓', 'secondary', 'Move screenshot ' + (i + 1) + ' later');
      down.disabled = i === shots.length - 1;
      down.addEventListener('click', () => reorder(moveScreenshot(entries(), id, i + 1)));
      if (job && (job.status === 'failed' || job.status === 'cancelled') && shot.bitmap) {
        const retry = button(tools, 'Retry', 'secondary', 'Retry screenshot ' + (i + 1));
        retry.addEventListener('click', () => {
          queue.retry(id);
          status.textContent = 'Reading screenshot ' + (i + 1) + ' again…';
        });
      }
      const del = button(tools, 'Remove', 'secondary', 'Remove screenshot ' + (i + 1));
      del.addEventListener('click', () => remove(id));
    });
  }

  function observedSeats(rec: ScreenshotRecognition): TableSeat[] {
    return rec.players.map((p, i) => {
      const badges: string[] = [];
      if (rec.dealerSeat.value === i) badges.push('Dealer');
      if (rec.heroSeat.value === i) badges.push('You');
      if (p.status.value === 'folded') badges.push('Folded');
      else if (p.status.value === null) badges.push('Status ?');
      else if (p.stack.value === 0) badges.push('All-in');
      const edited: string[] = [];
      if (p.name.source === 'corrected') edited.push('name');
      if (p.stack.source === 'corrected') edited.push('stack');
      if (p.bet.source === 'corrected') edited.push('bet');
      if (p.status.source === 'corrected') edited.push('status');
      if (p.cards.some(c => c.source === 'corrected')) edited.push('cards');
      return {
        name: seatName(rec, i), badges,
        status: p.status.value === 'folded' ? 'folded' : p.status.value === null ? 'unknown' : p.stack.value === 0 ? 'all-in' : 'active',
        cards: p.cards.map(c => c.value), stack: p.stack.value, bet: p.bet.value, edited,
      };
    });
  }

  function stateSeats(state: GameState): TableSeat[] {
    return state.players.map(p => ({
      name: p.name,
      badges: [...(p.status === 'folded' ? ['Folded'] : p.status === 'all-in' ? ['All-in'] : [])],
      status: p.status, cards: p.cards, stack: p.stack, bet: p.committed,
    }));
  }

  function describeAction(interval: Interval, index: number) {
    const a = interval.resolution!.actions[index];
    const from = observationById(interval.from);
    const who = from ? seatName(from.recognition, a.seat) : 'Seat ' + (a.seat + 1);
    return who + ': ' + ACTION_LABELS[a.type] + (a.type === 'bet' || a.type === 'raise' ? ' ' + a.to : '');
  }

  function renderTable() {
    const observation = selectedObservation();
    const interval = incomingInterval();
    const key = { observation, step: actionStep, interval };
    // Redraw only when the shown state changes: a new observation object, or another action step.
    if (lastTable && lastTable.observation === key.observation && lastTable.step === key.step && (key.step === null || lastTable.interval === key.interval)) return;
    lastTable = key;
    const steps = element('recon-steps');
    steps.replaceChildren();
    steps.hidden = true;
    const title = element('recon-table-title');
    const note = element('recon-table-note');
    editButton.hidden = !observation;
    reviewedButton.hidden = !observation || observation.reviewStatus !== 'pending';
    if (!observation) {
      title.textContent = 'Table';
      note.textContent = shots.length ? 'Read the screenshots to see each recognized state here.' : '';
      renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), []);
      renderBoard(element('recon-board'), []);
      element('recon-phase').textContent = '';
      element('recon-pot').textContent = '';
      return;
    }
    const rec = observation.recognition;
    const at = indexOf(observation.screenshotId);
    const cp = result.checkpoints.find(c => c.screenshotId === observation.screenshotId)!;
    const states = interval?.actionCheck?.states ?? [];
    if (actionStep !== null && interval && states.length > 1) {
      // Stepping through confirmed actions from the previous screenshot.
      const step = Math.min(actionStep, states.length - 1);
      const state = states[step];
      title.textContent = 'Confirmed actions before screenshot ' + (at + 1);
      note.textContent = step === 0 ? 'Start: the state in the previous screenshot.' : 'After ' + describeAction(interval, Math.min(step - 1, interval.resolution!.actions.length - 1)) + '. Only actions you confirmed are shown.';
      renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), stateSeats(state));
      renderBoard(element('recon-board'), state.board);
      element('recon-phase').textContent = state.street[0].toUpperCase() + state.street.slice(1) + ' · step ' + step + ' of ' + (states.length - 1);
      const start = observationById(interval.from);
      const startMiddle = start ? middleChips(start.recognition) : null;
      const put = states[0].players.reduce((s, p) => s + p.stack, 0) - state.players.reduce((s, p) => s + p.stack, 0);
      element('recon-pot').textContent = startMiddle === null ? 'Middle unknown' : 'Middle ' + (startMiddle + put).toLocaleString();
      steps.hidden = false;
      const prev = button(steps, '◀ Step', 'secondary', 'Previous confirmed action');
      prev.disabled = step === 0;
      prev.addEventListener('click', () => { actionStep = step - 1; renderTable(); });
      const next = button(steps, 'Step ▶', 'secondary', 'Next confirmed action');
      next.disabled = step === states.length - 1;
      next.addEventListener('click', () => { actionStep = step + 1; renderTable(); });
      const back = button(steps, 'Back to the screenshot', 'secondary');
      back.addEventListener('click', () => { actionStep = null; renderTable(); });
      return;
    }
    title.textContent = 'Screenshot ' + (at + 1) + (rec.street.value ? ' · ' + rec.street.value[0].toUpperCase() + rec.street.value.slice(1) : '');
    const reviewText = { pending: 'Not reviewed yet', reviewed: 'Reviewed', corrected: 'Corrected by you' }[observation.reviewStatus];
    note.textContent = reviewText + (cp.reviewCount ? ' · ' + cp.reviewCount + ' field' + (cp.reviewCount === 1 ? '' : 's') + ' to check' : '')
      + ' · “?” is unknown; dotted underlines mark values you corrected.';
    renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), observedSeats(rec));
    element('recon-felt').dataset.seats = String(rec.players.length);
    renderBoard(element('recon-board'), rec.communityCards.map(c => c.value));
    element('recon-phase').textContent = rec.street.value
      ? rec.street.value[0].toUpperCase() + rec.street.value.slice(1) + (rec.street.source === 'inferred' ? ' (from the board)' : '')
      : 'Street unknown';
    const pot = element('recon-pot');
    pot.textContent = 'Pot ' + (rec.pot.value === null ? '?' : rec.pot.value.toLocaleString()) + (rec.potIncludesBets ? ' incl. bets' : '');
    pot.classList.toggle('edited', rec.pot.source === 'corrected');
  }

  function renderEditor() {
    const observation = selectedObservation();
    editButton.setAttribute('aria-expanded', String(editing && !!observation));
    editButton.textContent = editing ? 'Close review' : 'Review and correct this screenshot';
    editorBox.hidden = !editing || !observation;
    if (!observation || !editing) return;
    const shot = shotById(observation.screenshotId);
    const img = element<HTMLImageElement>('recon-editor-image');
    if (shot?.url) {
      img.src = shot.url;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    editor.replaceChildren();
    if (!shot?.url) add(editor, 'p', 'The image was not saved with this reconstruction; only the recognized state is available.', 'fine-print');
    renderRecognitionEditor(editor, observation.recognition, next => {
      const current = observations.get(observation.screenshotId);
      if (!current) return;
      observations.set(observation.screenshotId, withRecognition(current, next));
      dirty = true;
      refresh();
    }, 'recon-' + observation.screenshotId);
  }

  editButton.addEventListener('click', () => {
    editing = !editing;
    renderEditor();
    if (editing) editorBox.scrollIntoView({ block: 'nearest' });
  });
  reviewedButton.addEventListener('click', () => {
    const o = selectedObservation();
    if (!o) return;
    observations.set(o.screenshotId, { ...o, reviewStatus: 'reviewed' });
    dirty = true;
    refresh();
  });

  // -------------------------------------------------------------------------
  // Detected changes and interval resolution
  // -------------------------------------------------------------------------
  const GROUPS: [string, (d: StateDifference) => boolean][] = [
    ['Community cards', d => d.kind.startsWith('board') || d.kind === 'street-changed' || d.kind === 'street-reversed'],
    ['Pot and chips', d => d.kind === 'pot-changed' || d.kind === 'stack-changed' || d.kind === 'bet-changed' || (d.kind.startsWith('value-') && !d.field.startsWith('players.'))],
    ['Players', d => d.kind.startsWith('hole') || d.kind === 'status-changed' || d.kind === 'unfolded' || d.kind.startsWith('seat') || d.kind === 'name-changed' || (d.kind.startsWith('value-') && d.field.startsWith('players.'))],
    ['Table', d => d.kind === 'dealer-moved' || d.kind === 'blinds-changed'],
  ];

  function renderChanges() {
    changes.replaceChildren();
    const at = selectedCheckpoint();
    if (at < 0) {
      add(changes, 'p', 'Select a recognized screenshot to see what changed.', 'fine-print');
      return;
    }
    const cp = result.checkpoints[at];
    if (cp.contradictions.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Problems in this screenshot');
      const ul = add(box, 'ul');
      for (const c of cp.contradictions) add(ul, 'li', c.text);
    }
    const global = result.globalContradictions.filter(c => c.observationIds.includes(cp.observationId));
    if (global.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Conflicts with other screenshots');
      const ul = add(box, 'ul');
      for (const c of global) add(ul, 'li', c.text);
    }
    const interval = at > 0 ? result.intervals[at - 1] : undefined;
    if (!interval) {
      add(changes, 'p', 'This is the first screenshot. What it shows:', 'fine-print');
      const ul = add(changes, 'ul', '', 'recon-facts');
      for (const f of cp.confirmed) add(ul, 'li', f.text);
      if (result.checkpoints.length > 1) add(changes, 'p', 'Select the next screenshot to see what changed after this one.', 'fine-print');
      return;
    }
    renderInterval(interval, at);
  }

  function renderInterval(interval: Interval, at: number) {
    const head = add(changes, 'div', '', 'recon-interval-head');
    add(head, 'p', 'Since screenshot ' + at, 'fine-print');
    add(head, 'span', STATUS_LABELS[interval.status], 'recon-status status-' + interval.status);
    add(changes, 'p', interval.summary);

    if (interval.differentHandSigns.length && interval.status !== 'different-hands') {
      add(changes, 'p', 'These may be different hands: ' + interval.differentHandSigns.join(' '), 'recon-warn');
    }
    if (interval.contradictions.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Contradictions');
      const ul = add(box, 'ul');
      for (const c of interval.contradictions) add(ul, 'li', c.text);
      add(box, 'p', 'Correct the misread value in either screenshot, or mark them as different hands.', 'fine-print');
    }
    for (const [title, test] of GROUPS) {
      const items = interval.differences.filter(d => d.severity !== 'contradiction' && test(d));
      if (!items.length) continue;
      const box = add(changes, 'div', '', 'recon-block');
      add(box, 'h4', title);
      const ul = add(box, 'ul');
      for (const d of items) {
        const li = add(ul, 'li', d.label, d.severity === 'review' ? 'issue-review' : '');
        const tags = [d.evidence === 'observed' ? 'observed' : d.evidence === 'corrected' ? 'includes your correction' : 'inferred'];
        if (d.confidence.previous && d.confidence.next && (d.confidence.previous !== 'high' || d.confidence.next !== 'high')) tags.push('reader confidence ' + d.confidence.previous + ' → ' + d.confidence.next);
        add(li, 'span', ' ' + tags.join(' · '), 'fine-print');
        if (d.warning) add(li, 'span', ' ' + d.warning, 'fine-print');
      }
    }
    const confirmedExtra = interval.confirmed.filter(f => !interval.differences.some(d => d.label === f.text));
    if (confirmedExtra.length) {
      const box = add(changes, 'div', '', 'recon-block');
      add(box, 'h4', 'Follows from the screenshots');
      const ul = add(box, 'ul');
      for (const f of confirmedExtra) add(ul, 'li', f.text);
    }
    if (interval.possible.length) {
      const box = add(changes, 'div', '', 'recon-block unresolved');
      add(box, 'h4', 'Not determined by the screenshots');
      for (const p of interval.possible) {
        add(box, 'p', p.text);
        const ul = add(box, 'ul');
        for (const alt of p.alternatives) add(ul, 'li', alt);
      }
    }
    renderResolution(interval);
  }

  function updateResolution(interval: Interval, change: (r: IntervalResolution) => IntervalResolution) {
    const current = interval.resolution ?? { from: interval.from, to: interval.to, mark: 'none' as const, actions: [] };
    resolutions = setResolution(resolutions, change(current));
    actionStep = null;
    dirty = true;
    refresh();
  }

  function renderResolution(interval: Interval) {
    const box = add(changes, 'fieldset', '', 'review-section recon-resolve');
    add(box, 'legend', 'Resolve this interval');
    const from = observationById(interval.from);
    const res = interval.resolution;
    const check = interval.actionCheck;

    if (res?.actions.length) {
      add(box, 'p', 'Your confirmed actions, in order:', 'review-label');
      const ol = add(box, 'ol', '', 'recon-actions');
      res.actions.forEach((a, k) => {
        const li = add(ol, 'li', describeAction(interval, k));
        if (check?.error?.actionId === a.id) {
          li.classList.add('issue-error');
          add(li, 'span', ' — ' + check.error.message, 'fine-print');
        }
        const del = button(li, 'Remove', 'secondary link-button', 'Remove action ' + (k + 1));
        del.addEventListener('click', () => updateResolution(interval, r => ({ ...r, actions: r.actions.filter(x => x.id !== a.id) })));
      });
      if (check && !check.error && check.unexplained.length) {
        add(box, 'p', 'Still unexplained:', 'review-label');
        const ul = add(box, 'ul');
        for (const u of check.unexplained) add(ul, 'li', u);
      }
      if (check && check.states.length > 1) {
        const step = button(box, 'Step through these actions on the table');
        step.addEventListener('click', () => { actionStep = 0; renderTable(); element('recon-felt').scrollIntoView({ block: 'nearest' }); });
      }
    }

    // Add a known action.
    if (from && interval.status !== 'different-hands') {
      const form = add(box, 'form', '', 'recon-action-form');
      const seatWrap = add(form, 'label', '', 'review-field');
      add(seatWrap, 'span', 'Player', 'review-label');
      const seat = add(seatWrap, 'select');
      from.recognition.players.forEach((p, i) => {
        if (p.status.value === 'folded') return;
        const option = add(seat, 'option', seatName(from.recognition, i));
        option.value = String(i);
      });
      const typeWrap = add(form, 'label', '', 'review-field');
      add(typeWrap, 'span', 'Action', 'review-label');
      const type = add(typeWrap, 'select');
      for (const [value, text] of Object.entries(ACTION_LABELS)) {
        const option = add(type, 'option', text.replace(' to', ''));
        option.value = value;
      }
      const amountWrap = add(form, 'label', '', 'review-field');
      add(amountWrap, 'span', 'Total this street', 'review-label');
      const amount = add(amountWrap, 'input');
      amount.type = 'number';
      amount.min = '1';
      amount.step = '1';
      amount.inputMode = 'numeric';
      const syncAmount = () => {
        const needs = type.value === 'bet' || type.value === 'raise';
        amountWrap.hidden = !needs;
        amount.required = needs;
      };
      type.addEventListener('change', syncAmount);
      syncAmount();
      const submit = add(form, 'button', 'Add action');
      submit.type = 'submit';
      form.addEventListener('submit', event => {
        event.preventDefault();
        const kind = type.value as ManualActionType;
        const to = Number(amount.value);
        if ((kind === 'bet' || kind === 'raise') && (!Number.isSafeInteger(to) || to <= 0)) {
          amount.setCustomValidity('Enter the whole-chip total after the bet or raise.');
          amount.reportValidity();
          return;
        }
        updateResolution(interval, r => ({
          ...r,
          actions: [...r.actions, {
            id: 'act-' + Date.now().toString(36) + '-' + ++counter, seat: Number(seat.value), type: kind,
            ...(kind === 'bet' || kind === 'raise' ? { to } : {}), confirmedAt: new Date().toISOString(),
          }],
        }));
      });
      add(box, 'p', 'Each action is checked by the hand rules: stack sizes, amounts to call, and minimum bets and raises. Turn order is not checked, because the screenshots do not show it.', 'fine-print');
    }

    const marks = add(box, 'div', '', 'actions small-actions');
    const unresolved = button(marks, res?.mark === 'unresolved' ? 'Undo “leave unresolved”' : 'Leave unresolved');
    unresolved.disabled = interval.status === 'contradiction' || interval.status === 'different-hands';
    unresolved.addEventListener('click', () => updateResolution(interval, r => ({ ...r, mark: r.mark === 'unresolved' ? 'none' : 'unresolved' })));
    const split = button(marks, res?.mark === 'different-hands' ? 'Undo “different hands”' : 'These are different hands');
    split.addEventListener('click', () => updateResolution(interval, r => ({ ...r, mark: r.mark === 'different-hands' ? 'none' : 'different-hands' })));
    const fix = button(marks, 'Correct values');
    fix.addEventListener('click', () => {
      editing = true;
      renderEditor();
      editorBox.scrollIntoView({ block: 'nearest' });
    });
    const recheck = button(marks, 'Revalidate');
    recheck.addEventListener('click', () => {
      refresh();
      const again = result.intervals.find(i => i.from === interval.from && i.to === interval.to);
      status.textContent = 'Rechecked screenshots ' + (interval.fromIndex + 1) + '–' + (interval.fromIndex + 2) + ': ' + (again?.summary ?? '');
    });
    add(box, 'p', 'You can save with intervals left unresolved.', 'fine-print');
  }

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------
  function checkpointText(c: Checkpoint) {
    const street = c.street ? c.street[0].toUpperCase() + c.street.slice(1) : 'Street unknown';
    const board = c.board.length ? c.board.map(x => x ?? '?').join(' ') : 'no board';
    const stacks = c.stacks.map(s => s.label + ' ' + (s.folded ? 'folded' : s.stack === null ? '?' : s.stack)).join(', ');
    return { title: 'Screenshot ' + (indexOf(c.screenshotId) + 1) + ' · ' + street, detail: board + ' · pot ' + (c.pot ?? '?') + ' · ' + stacks };
  }

  function go(position: number) {
    const cp = result.checkpoints[position];
    if (cp) select(cp.screenshotId);
  }

  function renderTimeline() {
    const count = result.checkpoints.length;
    const at = Math.max(0, selectedCheckpoint());
    scrub.max = String(Math.max(0, count - 1));
    scrub.value = String(at);
    scrub.disabled = count < 2;
    element('recon-position').textContent = count ? (at + 1) + ' of ' + count : '';
    scrub.setAttribute('aria-valuetext', 'Checkpoint ' + (at + 1) + ' of ' + count);
    element<HTMLButtonElement>('recon-first').disabled = at === 0;
    element<HTMLButtonElement>('recon-prev').disabled = at === 0;
    element<HTMLButtonElement>('recon-next').disabled = at >= count - 1;
    element<HTMLButtonElement>('recon-last').disabled = at >= count - 1;
    timeline.replaceChildren();
    for (const entry of result.timeline) {
      if (entry.kind === 'checkpoint') {
        const c = entry.checkpoint;
        const li = add(timeline, 'li', '', 'recon-tl-checkpoint');
        const b = button(li, '', 'recon-tl-button' + (c.screenshotId === selected ? ' selected' : ''));
        const { title, detail } = checkpointText(c);
        add(b, 'strong', title);
        add(b, 'span', detail, 'fine-print');
        const flags: string[] = [];
        if (c.contradictions.length) flags.push(c.contradictions.length + ' problem(s)');
        if (c.reviewCount) flags.push(c.reviewCount + ' to check');
        if (c.reviewStatus !== 'pending') flags.push(c.reviewStatus);
        if (flags.length) add(b, 'span', flags.join(' · '), 'fine-print');
        if (c.screenshotId === selected) b.setAttribute('aria-current', 'step');
        b.addEventListener('click', () => select(c.screenshotId));
      } else {
        const i = entry.interval;
        const li = add(timeline, 'li', '', 'recon-tl-interval status-' + i.status);
        const b = button(li, '', 'recon-tl-button interval');
        add(b, 'span', STATUS_LABELS[i.status], 'recon-status status-' + i.status);
        add(b, 'span', ' ' + i.summary);
        const details: string[] = [];
        const changed = i.differences.filter(d => d.severity !== 'contradiction').length;
        if (changed) details.push(changed + ' change(s)');
        if (i.resolution?.actions.length) details.push(i.resolution.actions.length + ' confirmed action(s)');
        if (i.contradictions.length) details.push(i.contradictions.length + ' contradiction(s)');
        if (details.length) add(b, 'span', details.join(' · '), 'fine-print');
        b.setAttribute('aria-label', 'Between screenshots ' + (i.fromIndex + 1) + ' and ' + (i.fromIndex + 2) + ': ' + STATUS_LABELS[i.status] + '. ' + i.summary);
        b.addEventListener('click', () => {
          const later = result.checkpoints[i.fromIndex + 1];
          if (later) select(later.screenshotId);
        });
      }
    }
  }

  const nav = (move: 'first' | 'previous' | 'next' | 'last') => () => go(moveCursor(Math.max(0, selectedCheckpoint()), result.checkpoints.length - 1, move));
  element('recon-first').addEventListener('click', nav('first'));
  element('recon-prev').addEventListener('click', nav('previous'));
  element('recon-next').addEventListener('click', nav('next'));
  element('recon-last').addEventListener('click', nav('last'));
  scrub.addEventListener('input', () => go(moveCursor(0, result.checkpoints.length - 1, Number(scrub.value))));

  // -------------------------------------------------------------------------
  // Summary, saving, export, and history matching
  // -------------------------------------------------------------------------
  function renderSummary() {
    const m = result.metrics;
    const box = element('recon-metrics');
    box.replaceChildren();
    const rows: [string, number][] = [
      ['Screenshots', m.screenshots], ['Recognized checkpoints', m.checkpoints], ['Corrected fields', m.correctedFields],
      ['Verified transitions', m.verifiedTransitions], ['Unresolved intervals', m.unresolvedIntervals], ['Contradictions', m.contradictions],
    ];
    for (const [k, v] of rows) {
      const row = add(box, 'div');
      add(row, 'dt', k);
      add(row, 'dd', String(v));
    }
    const warn = element('recon-warnings');
    warn.replaceChildren();
    for (const w of result.warnings) add(warn, 'li', w);
    warn.hidden = !result.warnings.length;
    if (document.activeElement !== nameInput) nameInput.value = session.title;
    const imagesAvailable = shots.some(s => s.url);
    keepImages.disabled = !imagesAvailable;
  }
  nameInput.addEventListener('change', () => {
    session.title = nameInput.value.trim();
    dirty = true;
  });

  async function dataUrlFor(shot: Shot): Promise<string | undefined> {
    if (shot.url?.startsWith('data:')) return shot.url;
    if (!shot.bitmap) return undefined;
    const blob = await prepareUpload(shot.bitmap);
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  }

  async function buildSession(): Promise<ReconstructionSession> {
    const withImages = keepImages.checked;
    const screenshots: ScreenshotEntry[] = [];
    for (const shot of shots) {
      const image = withImages ? await dataUrlFor(shot) : undefined;
      screenshots.push({ id: shot.entry.id, label: shot.entry.label, uploadIndex: shot.entry.uploadIndex, ...(image ? { image } : {}) });
    }
    return createSession({
      id: session.id,
      title: session.title || (result.checkpoints[0]?.street ? 'Hand from ' + result.checkpoints.length + ' screenshots' : 'Reconstruction'),
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      screenshots,
      observations: sequenceObservations(entries(), observations),
      resolutions,
      imagesSaved: withImages,
    });
  }

  element('recon-save').addEventListener('click', async () => {
    const note = element('recon-save-note');
    const built = await buildSession();
    const { sessions } = loadReconstructions();
    try {
      saveReconstructions([built, ...sessions.filter(s => s.id !== built.id)]);
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : 'The reconstruction could not be saved.';
      return;
    }
    session.title = built.title;
    dirty = false;
    note.textContent = 'Saved “' + built.title + '” in this browser'
      + (built.imagesSaved ? ' with its images.' : '. Images were not saved: reopening restores the timeline and corrections, not the screenshots.');
    renderSaved();
    renderSummary();
  });

  function download(text: string, name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fileName = (s: ReconstructionSession) => (s.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'reconstruction') + '.json';

  element('recon-export').addEventListener('click', async () => {
    const built = await buildSession();
    download(serializeSession(built), fileName(built));
    element('recon-save-note').textContent = 'Exported' + (built.imagesSaved ? ' with images.' : ' without images.');
  });

  element('recon-match').addEventListener('click', () => {
    const out = element('recon-match-result');
    out.replaceChildren();
    const ordered = sequenceObservations(entries(), observations);
    if (!ordered.length) {
      add(out, 'p', 'Read at least one screenshot first.');
      return;
    }
    const { hands, problems } = loadHands();
    const matches = hands.flatMap(hand => {
      const states = replaySteps(createHandState(hand.setup), hand.events);
      const found = matchHistory(states, ordered);
      return found ? [{ hand, ...found }] : [];
    });
    if (problems.length) add(out, 'p', problems.join(' '), 'fine-print');
    if (!matches.length) {
      add(out, 'p', hands.length ? 'No saved hand agrees with every screenshot in this order.' : 'There are no saved hands to compare with.');
      return;
    }
    for (const m of matches) {
      const row = add(out, 'div', '', 'actions');
      add(row, 'p', '“' + m.hand.name + '” fits every screenshot, at events ' + m.positions.join(', ') + '.');
      const open = button(row, 'Open at the selected screenshot');
      open.addEventListener('click', () => {
        const at = Math.max(0, selectedCheckpoint());
        options.replay.openHand(m.hand.id, m.positions[at] ?? m.positions[0]);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Saved reconstructions
  // -------------------------------------------------------------------------
  function load(saved: ReconstructionSession) {
    reset();
    session = { id: saved.id, title: saved.title, createdAt: saved.createdAt };
    shots = saved.screenshots.map(entry => ({ entry, url: entry.image ?? null, objectUrl: false, bitmap: null, provider: null }));
    for (const o of saved.observations) {
      observations.set(o.screenshotId, o);
      queue.markDone(o.screenshotId);
    }
    resolutions = [...saved.resolutions];
    keepImages.checked = saved.imagesSaved;
    dirty = false;
    refresh();
    status.textContent = 'Opened “' + saved.title + '”.' + (saved.imagesSaved ? '' : ' The images were not saved, so only the recognized states and your corrections are restored.');
    if (saved.imagesSaved) {
      // Decode saved images so they can be re-sent if a screenshot is still unread.
      for (const shot of shots) {
        if (!shot.url || observations.has(shot.entry.id)) continue;
        void Promise.resolve(shot.url).then(jpegDataUrlToBlob).then(decodeImage).then(bitmap => {
          shot.bitmap = bitmap;
          shot.provider = claudeScreenshotProvider();
          renderProgress();
          renderList();
        }).catch(() => {});
      }
    }
  }

  function renderSaved() {
    const { sessions, problems } = loadReconstructions();
    const ul = element('recon-saved');
    ul.replaceChildren();
    if (problems.length) add(ul, 'li', problems.join(' '), 'empty-list');
    if (!sessions.length) {
      add(ul, 'li', 'Nothing saved yet.', 'empty-list');
      return;
    }
    for (const s of sessions) {
      const item = add(ul, 'li', '', 'hand-item' + (s.id === session.id ? ' open' : ''));
      if (renaming === s.id) {
        const form = add(item, 'form', '', 'rename');
        const label = add(form, 'label', 'New name');
        const input = add(label, 'input');
        input.value = s.title;
        input.maxLength = 80;
        input.required = true;
        const save = add(form, 'button', 'Save');
        save.type = 'submit';
        const cancel = button(form, 'Cancel');
        cancel.addEventListener('click', () => { renaming = null; renderSaved(); });
        form.addEventListener('submit', event => {
          event.preventDefault();
          const title = input.value.trim();
          if (!title) return;
          renaming = null;
          try {
            saveReconstructions(sessions.map(x => (x.id === s.id ? { ...x, title, updatedAt: new Date().toISOString() } : x)));
            if (session.id === s.id) session.title = title;
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'Could not rename.';
          }
          renderSaved();
          renderSummary();
        });
        queueMicrotask(() => input.focus());
        continue;
      }
      const open = button(item, s.title, 'hand-open');
      open.addEventListener('click', () => {
        if (dirty && shots.length && !confirm('Open “' + s.title + '”? Unsaved changes to the current reconstruction will be lost.')) return;
        load(s);
      });
      add(item, 'p', new Date(s.updatedAt).toLocaleString() + ' · ' + s.screenshots.length + ' screenshots · ' + s.observations.length + ' read'
        + (s.imagesSaved ? ' · images saved' : ' · no images'), 'hand-meta');
      const tools = add(item, 'div', '', 'actions small-actions');
      const rename = button(tools, 'Rename', 'secondary', 'Rename ' + s.title);
      rename.addEventListener('click', () => { renaming = s.id; renderSaved(); });
      const exp = button(tools, 'Export', 'secondary', 'Export ' + s.title);
      exp.addEventListener('click', () => download(serializeSession(s), fileName(s)));
      const del = button(tools, 'Delete', 'secondary', 'Delete ' + s.title);
      del.addEventListener('click', () => {
        if (!confirm('Delete the saved reconstruction “' + s.title + '”? This cannot be undone.')) return;
        try {
          saveReconstructions(sessions.filter(x => x.id !== s.id));
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not delete.';
        }
        renderSaved();
      });
    }
  }

  element<HTMLInputElement>('recon-import').addEventListener('change', async event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      status.textContent = 'That file is too large to be a reconstruction.';
      return;
    }
    try {
      const parsed = parseSession(await file.text());
      if (dirty && shots.length && !confirm('Open the imported reconstruction? Unsaved changes to the current one will be lost.')) return;
      load(parsed);
      dirty = true;
      status.textContent = 'Imported “' + parsed.title + '”. Save it to keep it in this browser.';
    } catch (error) {
      status.textContent = 'Not imported: ' + (error instanceof Error ? error.message : 'the file is not valid.');
    }
  });

  window.addEventListener('pagehide', () => {
    queue.clear();
    for (const s of shots) releaseShot(s);
  });
  renderSaved();
  render();
}
