// Track hand: upload screenshots, or pick frames from a recorded video, of one
// simulated or finished hand; read each frame through the screenshot
// recognition providers (two at a time); review and correct each one; match
// players across frames; and walk a replay of observed frames, verified events,
// and unresolved gaps. Gaps stay unresolved unless the user enters actions,
// which the hand engine checks. Offline study only: nothing here watches a
// live game, and nothing changes the study table or saved hands.
import { createHandState, replaySteps } from '../history/engine.js';
import type { GameState } from '../history/types.js';
import { CONSISTENCY_LABELS } from '../reconstruction/consistency.js';
import { DEMO_CONFIRMED_ACTIONS, DEMO_SEQUENCE, SEQUENCE_FIXTURES, sequenceById, type SequenceFixture } from '../reconstruction/fixtures.js';
import { NEW_PLAYER, remapOverrides, setOverride } from '../reconstruction/identity.js';
import { createObservation, middleChips, seatName, withRecognition } from '../reconstruction/observation.js';
import { RecognitionQueue } from '../reconstruction/queue.js';
import { differenceKey, matchHistory, reconstructHand } from '../reconstruction/reconstruct.js';
import { buildReplaySteps, checkpointStep, moveStep, STEP_KIND_LABELS, type ReplayStep } from '../reconstruction/replay-steps.js';
import { ACTION_LABELS } from '../reconstruction/resolve.js';
import {
  addScreenshots, createSession, liveResolutions, moveScreenshot, parseSession, remapActionSeats, removeScreenshot, sequenceObservations,
  serializeSession, setResolution, uploadOrder,
} from '../reconstruction/session.js';
import {
  MAX_SCREENSHOTS,
  type Checkpoint, type FrameSource, type HandObservation, type HiddenMark, type IdentityOverride, type Interval, type IntervalResolution,
  type ManualActionType, type ReconstructionResult, type ReconstructionSession, type ScreenshotEntry, type StateDifference,
} from '../reconstruction/types.js';
import { claudeScreenshotProvider, fixtureProvider, type ScreenshotProvider } from '../vision/providers.js';
import { drawTable } from '../vision/screenshot-fixtures.js';
import { seatMoveMap, type ScreenshotRecognition } from '../vision/screenshot.js';
import { DEFAULT_INTERVAL_MS, formatVideoTime, INTERVAL_CHOICES_MS, sampleTimes, videoProblem } from '../vision/video.js';
import { loadHands } from './hand-store.js';
import { decodeImage, fileProblem, jpegDataUrlToBlob, prepareUpload, svgToPng, UPLOAD_LONG_EDGE } from './image.js';
import { renderRecognitionEditor } from './recognition-editor.js';
import { loadReconstructions, saveReconstructions } from './reconstruction-store.js';
import type { ReplayController } from './replay.js';
import { renderBoard, renderSeats, type TableSeat } from './table-view.js';
import { captureFrame, openVideo, type OpenVideo } from './video-frames.js';

const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const THUMB_EDGE = 240;

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

interface FrameMeta {
  readonly source: FrameSource;
  readonly timestampMs?: number;
}

const STATUS_LABELS: Record<Interval['status'], string> = {
  unchanged: 'No change', verified: 'Verified', unresolved: 'Unresolved', acknowledged: 'Left unresolved',
  resolved: 'Resolved', partial: 'Partly resolved', contradiction: 'Contradiction', 'different-hands': 'Different hands',
};
const BASIS_LABELS = {
  user: 'matched by you', name: 'matched by name', hero: 'your seat', position: 'matched by seat position', new: 'first seen here', unmatched: 'not matched',
} as const;

export function initReconstruction(options: { replay: ReplayController }) {
  const status = element('recon-status');
  const readButton = element<HTMLButtonElement>('recon-read');
  const cancelButton = element<HTMLButtonElement>('recon-cancel');
  const clearButton = element<HTMLButtonElement>('recon-clear');
  const uploadOrderButton = element<HTMLButtonElement>('recon-upload-order');
  const fileInput = element<HTMLInputElement>('recon-file');
  const videoInput = element<HTMLInputElement>('recon-video');
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
  let overrides: IdentityOverride[] = [];
  let hidden: HiddenMark[] = [];
  let result: ReconstructionResult = reconstructHand([]);
  let steps: ReplayStep[] = [];
  /** The replay step shown; `null` shows the selected frame. */
  let stepIndex: number | null = null;
  let selected: string | null = null;
  let editing = false;
  let session = newSession();
  let dirty = false;
  let lastTable: { observation: HandObservation | undefined; step: ReplayStep | null; label: string } | null = null;
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
  const frameName = (entry: ScreenshotEntry, i: number) => 'Frame ' + (i + 1) + (entry.timestampMs !== undefined ? ' (' + formatVideoTime(entry.timestampMs) + ')' : '');

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
      const shot = shotById(id);
      // A late reply for a removed frame, or one already recognized (and maybe corrected), is dropped.
      if (!shot || observations.has(id)) return;
      observations.set(id, createObservation(id, indexOf(id), recognition, { source: shot.entry.source ?? 'screenshot', timestampMs: shot.entry.timestampMs ?? null }));
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
  // Adding frames
  // -------------------------------------------------------------------------
  async function addFiles(files: readonly File[], providerFor: (file: File, i: number) => ScreenshotProvider, metaFor: (i: number) => FrameMeta = () => ({ source: 'screenshot' })) {
    const room = MAX_SCREENSHOTS - shots.length;
    const problems: string[] = [];
    if (files.length > room) problems.push((files.length - Math.max(room, 0)) + ' file(s) skipped: a tracked hand holds at most ' + MAX_SCREENSHOTS + ' frames.');
    const accepted: { file: File; bitmap: ImageBitmap; provider: ScreenshotProvider; meta: FrameMeta }[] = [];
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
        accepted.push({ file, bitmap: await decodeImage(file), provider: providerFor(file, i), meta: metaFor(i) });
      } catch (error) {
        problems.push(file.name + ': ' + (error instanceof Error ? error.message : 'could not be opened.'));
      }
      i++;
    }
    const { added } = addScreenshots(entries(), accepted.map(a => a.file.name), makeId);
    added.forEach((base, k) => {
      const a = accepted[k];
      const entry: ScreenshotEntry = {
        ...base,
        ...(a.meta.source === 'video' ? { source: 'video' as const } : {}),
        ...(a.meta.timestampMs !== undefined ? { timestampMs: a.meta.timestampMs } : {}),
      };
      shots.push({ entry, url: URL.createObjectURL(a.file), objectUrl: true, bitmap: a.bitmap, provider: a.provider });
    });
    if (added.length) dirty = true;
    status.textContent = (added.length ? added.length + ' frame' + (added.length === 1 ? '' : 's') + ' added. ' : '')
      + problems.join(' ') + (added.length ? ' Check the order, then press Read frames.' : '');
    refresh();
    return added.map(e => e.id);
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
    const video = files.find(f => f.type.startsWith('video/'));
    if (video) void startVideo(video);
    const images = files.filter(f => !f.type.startsWith('video/'));
    if (images.length) void addFiles(images, () => claudeScreenshotProvider());
  });
  drop.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  async function loadSequence(seq: SequenceFixture) {
    if (shots.length && dirty && !confirm('Replace the current frames with “' + seq.label + '”?')) return false;
    reset();
    try {
      const files = await Promise.all(seq.frames.map((f, i) => svgToPng(drawTable(f.table), seq.id + '-' + (i + 1) + '.png')));
      const ids = await addFiles(files, (_file, i) => fixtureProvider(seq.frames[i].response, 'sample:' + seq.frames[i].id));
      session.title = seq.label;
      return ids;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The sample could not be drawn.';
      return false;
    }
  }

  sample.addEventListener('change', async () => {
    const seq = sequenceById(sample.value);
    sample.value = '';
    if (!seq) return;
    if (await loadSequence(seq)) {
      status.textContent = 'Sample loaded: ' + seq.description + ' Press Read frames; samples use stored results and make no API calls.';
      refresh();
    }
  });

  element('recon-demo').addEventListener('click', async () => {
    const ids = await loadSequence(DEMO_SEQUENCE);
    if (!ids) return;
    // The demo's flop actions arrive as confirmed by the user; every other gap stays unresolved.
    const at = new Date().toISOString();
    const k = DEMO_CONFIRMED_ACTIONS.intervalIndex;
    resolutions = [{
      from: 'obs-' + ids[k], to: 'obs-' + ids[k + 1], mark: 'none',
      actions: DEMO_CONFIRMED_ACTIONS.actions.map((a, n) => ({ id: 'demo-act-' + (n + 1), ...a, confirmedAt: at })),
    }];
    queue.enqueue(ids);
    status.textContent = 'Demo loaded and read from stored results (no API call). ' + DEMO_SEQUENCE.description;
  });

  readButton.addEventListener('click', () => {
    const ids = shots.filter(s => !observations.has(s.entry.id) && s.bitmap).map(s => s.entry.id);
    for (const id of ids) {
      const job = queue.status(id);
      if (job?.status === 'failed') queue.retry(id);
    }
    queue.enqueue(ids);
    status.textContent = shots.some(s => s.provider?.id === 'claude' && ids.includes(s.entry.id))
      ? 'Reading with Claude, two at a time. Each frame can take up to a minute.'
      : 'Reading…';
  });
  cancelButton.addEventListener('click', () => {
    queue.cancelAll();
    status.textContent = 'Stopped. Frames already read are kept; press Read frames to continue.';
    refresh();
  });
  clearButton.addEventListener('click', () => {
    if (dirty && !confirm('Start over? Unsaved frames, corrections, player matches, and confirmed actions will be lost.')) return;
    reset();
    status.textContent = 'Cleared.';
    refresh();
  });
  uploadOrderButton.addEventListener('click', () => {
    reorder(uploadOrder(entries()));
    status.textContent = 'Restored the order the frames were added in.';
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
    overrides = [];
    hidden = [];
    selected = null;
    stepIndex = null;
    editing = false;
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
    stepIndex = null;
    dirty = true;
    refresh();
  }

  function remove(id: string) {
    const shot = shotById(id);
    if (!shot) return;
    if (observations.get(id)?.reviewStatus === 'corrected' && !confirm('Remove this frame and your corrections to it?')) return;
    queue.remove(id);
    releaseShot(shot);
    shots = shots.filter(s => s !== shot);
    observations.delete(id);
    if (selected === id) selected = shots.find(s => observations.has(s.entry.id))?.entry.id ?? null;
    stepIndex = null;
    dirty = true;
    refresh();
  }

  // -------------------------------------------------------------------------
  // Video frames
  // -------------------------------------------------------------------------
  const videoPanel = element('recon-video-panel');
  const videoFrames = element('recon-video-frames');
  const videoStatus = element('recon-video-status');
  const intervalSelect = element<HTMLSelectElement>('recon-video-interval');
  for (const ms of INTERVAL_CHOICES_MS) {
    const option = add(intervalSelect, 'option', 'Every ' + (ms < 1000 ? ms / 1000 : ms / 1000) + ' s');
    option.value = String(ms);
  }
  intervalSelect.value = String(DEFAULT_INTERVAL_MS);
  let video: { open: OpenVideo; name: string; thumbs: { timeMs: number; url: string; selected: boolean }[] } | null = null;
  let videoJob: AbortController | null = null;

  function closeVideo() {
    videoJob?.abort();
    videoJob = null;
    if (video) {
      for (const t of video.thumbs) URL.revokeObjectURL(t.url);
      video.open.close();
    }
    video = null;
    videoFrames.replaceChildren();
    videoPanel.hidden = true;
  }

  async function startVideo(file: File) {
    const problem = videoProblem(file);
    if (problem) {
      status.textContent = file.name + ': ' + problem;
      return;
    }
    closeVideo();
    videoPanel.hidden = false;
    videoStatus.textContent = 'Opening the video on this device…';
    try {
      const open = await openVideo(file);
      video = { open, name: file.name, thumbs: [] };
      element('recon-video-caption').textContent = file.name + ' · ' + formatVideoTime(open.durationMs) + ' · ' + open.width + '×' + open.height;
      videoStatus.textContent = 'Choose how often to sample, then press Sample frames. Nothing is uploaded until you read the frames you add.';
      renderVideo();
    } catch (error) {
      videoStatus.textContent = error instanceof Error ? error.message : 'This video could not be opened.';
    }
  }

  videoInput.addEventListener('change', () => {
    const file = videoInput.files?.[0];
    videoInput.value = '';
    if (file) void startVideo(file);
  });
  element('recon-video-close').addEventListener('click', closeVideo);
  element('recon-video-cancel').addEventListener('click', () => {
    videoJob?.abort();
    videoStatus.textContent = 'Sampling stopped. The frames sampled so far are kept.';
  });

  element('recon-video-sample').addEventListener('click', async () => {
    if (!video) return;
    const current = video;
    videoJob?.abort();
    const job = new AbortController();
    videoJob = job;
    for (const t of current.thumbs) URL.revokeObjectURL(t.url);
    current.thumbs = [];
    const { times, intervalMs, capped } = sampleTimes(current.open.durationMs, Number(intervalSelect.value));
    element<HTMLButtonElement>('recon-video-cancel').hidden = false;
    for (let k = 0; k < times.length; k++) {
      if (job.signal.aborted || video !== current) break;
      videoStatus.textContent = 'Sampling frame ' + (k + 1) + ' of ' + times.length + '…';
      try {
        const blob = await captureFrame(current.open, times[k], THUMB_EDGE, job.signal);
        current.thumbs.push({ timeMs: times[k], url: URL.createObjectURL(blob), selected: false });
        renderVideo();
      } catch (error) {
        if (!job.signal.aborted) videoStatus.textContent = error instanceof Error ? error.message : 'A frame could not be read.';
        break;
      }
    }
    if (videoJob === job) {
      videoJob = null;
      element<HTMLButtonElement>('recon-video-cancel').hidden = true;
      if (!job.signal.aborted) {
        videoStatus.textContent = current.thumbs.length + ' frames sampled' + (capped ? ' (every ' + intervalMs / 1000 + ' s, to stay under ' + times.length + ')' : '')
          + '. Tick the frames that show each moment you want, then add them. Only those will be read.';
      }
    }
  });

  element('recon-video-add').addEventListener('click', async () => {
    if (!video) return;
    const current = video;
    const chosen = current.thumbs.filter(t => t.selected).sort((a, b) => a.timeMs - b.timeMs);
    if (!chosen.length) return;
    videoStatus.textContent = 'Copying ' + chosen.length + ' frame(s) at full size…';
    const files: File[] = [];
    try {
      for (const t of chosen) {
        const blob = await captureFrame(current.open, t.timeMs, UPLOAD_LONG_EDGE);
        files.push(new File([blob], current.name + ' @ ' + formatVideoTime(t.timeMs) + '.jpg', { type: 'image/jpeg' }));
      }
    } catch (error) {
      videoStatus.textContent = error instanceof Error ? error.message : 'A frame could not be copied.';
      return;
    }
    const ids = await addFiles(files, () => claudeScreenshotProvider(), i => ({ source: 'video', timestampMs: chosen[i].timeMs }));
    for (const t of chosen) t.selected = false;
    renderVideo();
    videoStatus.textContent = ids.length + ' frame(s) added to the list in video order. Pick more, or close the video.';
  });

  function renderVideo() {
    videoFrames.replaceChildren();
    if (!video) return;
    for (const t of video.thumbs) {
      const label = add(videoFrames, 'label', '', 'video-thumb' + (t.selected ? ' selected' : ''));
      const box = add(label, 'input');
      box.type = 'checkbox';
      box.checked = t.selected;
      box.addEventListener('change', () => {
        t.selected = box.checked;
        label.classList.toggle('selected', box.checked);
        syncVideoAdd();
      });
      const img = add(label, 'img');
      img.src = t.url;
      img.alt = 'Video frame at ' + formatVideoTime(t.timeMs);
      add(label, 'span', formatVideoTime(t.timeMs), 'fine-print');
    }
    syncVideoAdd();
  }
  function syncVideoAdd() {
    const count = video?.thumbs.filter(t => t.selected).length ?? 0;
    const addButton = element<HTMLButtonElement>('recon-video-add');
    addButton.disabled = count === 0 || shots.length + count > MAX_SCREENSHOTS;
    addButton.textContent = count ? 'Add ' + count + ' selected frame' + (count === 1 ? '' : 's') : 'Add selected frames';
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  function refresh() {
    const ordered = sequenceObservations(entries(), observations);
    for (const o of ordered) observations.set(o.screenshotId, o);
    // Keep anything that refers to a frame still waiting to be read; drop what refers to removed frames,
    // and resolutions whose two frames are no longer next to each other.
    const ids = new Set(ordered.map(o => o.id));
    const pending = new Set(shots.filter(s => !observations.has(s.entry.id)).map(s => 'obs-' + s.entry.id));
    const live = new Set(liveResolutions(ordered, resolutions));
    const waiting = (id: string) => pending.has(id);
    resolutions = resolutions.filter(r => live.has(r) || ((waiting(r.from) || waiting(r.to)) && (ids.has(r.from) || waiting(r.from)) && (ids.has(r.to) || waiting(r.to))));
    overrides = overrides.filter(o => ids.has(o.observationId) || waiting(o.observationId));
    hidden = hidden.filter(h => ids.has(h.observationId) || waiting(h.observationId));
    result = reconstructHand(ordered, { resolutions, screenshotCount: shots.length, identity: { overrides, hidden } });
    steps = buildReplaySteps(result);
    if (selected && !observations.has(selected)) selected = ordered[0]?.screenshotId ?? null;
    if (!selected && ordered.length) selected = ordered[0].screenshotId;
    if (stepIndex !== null && stepIndex >= steps.length) stepIndex = null;
    render();
  }

  const observationById = (id: string) => [...observations.values()].find(o => o.id === id);
  const selectedObservation = () => (selected ? observations.get(selected) : undefined);
  const selectedCheckpoint = () => result.checkpoints.findIndex(c => c.screenshotId === selected);
  const playerLabel = (id: string | null) => (id ? result.identity.players.find(p => p.id === id)?.label ?? id : 'Unknown');
  const frameIdentity = (observationId: string) => result.identity.frames.find(f => f.observationId === observationId);

  function select(id: string | null) {
    selected = id;
    const o = id ? observations.get(id) : undefined;
    stepIndex = o ? checkpointStep(steps, o.id) : null;
    render();
  }

  function goStep(index: number) {
    const step = steps[index];
    if (!step) return;
    stepIndex = index;
    if (step.kind === 'checkpoint') {
      selected = observationById(step.observationId)?.screenshotId ?? selected;
    } else {
      // Events and gaps sit after a frame: keep the later frame's changes in view.
      const later = result.checkpoints[step.intervalIndex + 1];
      if (later) selected = later.screenshotId;
    }
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
    readButton.textContent = readable && readable < shots.length ? 'Read ' + readable + ' remaining' : 'Read frames';
    cancelButton.hidden = !queue.busy;
    drop.classList.toggle('busy', queue.busy);
    const box = element('recon-progress');
    box.hidden = !shots.length;
    box.replaceChildren();
    const needReview = result.checkpoints.filter(c => c.reviewStatus === 'pending' || c.reviewCount > 0 || c.contradictions.length).length;
    const processing = progress.processing.map(id => '#' + (indexOf(id) + 1)).join(', ');
    const rows: [string, string][] = [
      ['Frames', String(shots.length)],
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
      status.textContent = 'Done reading. ' + (progress.failed ? progress.failed + ' failed; use Retry on each.' : 'Review each frame, then check the changes.');
    }
  }

  function jobLabel(id: string): [string, string] {
    const o = observations.get(id);
    if (o) {
      const cp = result.checkpoints.find(c => c.screenshotId === id);
      if (cp?.contradictions.length) return ['Conflict', 'error'];
      if (o.reviewStatus === 'corrected') return ['Corrected', 'corrected'];
      if (o.reviewStatus === 'reviewed') return ['Reviewed', 'high'];
      return [cp?.reviewCount ? 'Needs review' : 'Unreviewed', 'review'];
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
        img.loading = 'lazy';
      } else {
        add(open, 'span', 'No image', 'recon-thumb placeholder');
      }
      const text = add(open, 'span', '', 'recon-item-text');
      add(text, 'strong', '#' + (i + 1) + (shot.entry.timestampMs !== undefined ? ' · ' + formatVideoTime(shot.entry.timestampMs) : ''));
      add(text, 'span', shot.entry.label, 'recon-label');
      const [label, level] = jobLabel(id);
      add(text, 'span', label, 'indicator ind-' + level);
      const o = observations.get(id);
      const issues = o ? result.identity.issues.filter(x => x.observationId === o.id && x.kind !== 'missing').length : 0;
      if (issues) add(text, 'span', issues + ' player match' + (issues === 1 ? '' : 'es') + ' to settle', 'indicator ind-low');
      open.setAttribute('aria-label', frameName(shot.entry, i) + ', ' + shot.entry.label + ', ' + label + (open.disabled ? '' : '. Show on the table.'));
      const job = queue.status(id);
      if (job?.status === 'failed') add(item, 'p', job.error ?? 'Recognition failed.', 'fine-print issue-error');
      const tools = add(item, 'div', '', 'actions small-actions');
      const up = button(tools, '↑', 'secondary', 'Move frame ' + (i + 1) + ' earlier');
      up.disabled = i === 0;
      up.addEventListener('click', () => reorder(moveScreenshot(entries(), id, i - 1)));
      const down = button(tools, '↓', 'secondary', 'Move frame ' + (i + 1) + ' later');
      down.disabled = i === shots.length - 1;
      down.addEventListener('click', () => reorder(moveScreenshot(entries(), id, i + 1)));
      if (job && (job.status === 'failed' || job.status === 'cancelled') && shot.bitmap) {
        const retry = button(tools, 'Retry', 'secondary', 'Retry frame ' + (i + 1));
        retry.addEventListener('click', () => {
          queue.retry(id);
          status.textContent = 'Reading frame ' + (i + 1) + ' again…';
        });
      }
      const del = button(tools, 'Remove', 'secondary', 'Remove frame ' + (i + 1));
      del.addEventListener('click', () => remove(id));
    });
  }

  function observedSeats(o: HandObservation): TableSeat[] {
    const rec = o.recognition;
    const frame = frameIdentity(o.id);
    return rec.players.map((p, i) => {
      const badges: string[] = [];
      if (rec.dealerSeat.value === i) badges.push('Dealer');
      if (rec.heroSeat.value === i) badges.push('You');
      if (p.status.value === 'folded') badges.push('Folded');
      else if (p.status.value === null) badges.push('Status ?');
      else if (p.stack.value === 0) badges.push('All-in');
      const match = frame?.seats[i];
      if (match && !match.playerId) badges.push('Unmatched');
      const edited: string[] = [];
      if (p.name.source === 'corrected') edited.push('name');
      if (p.stack.source === 'corrected') edited.push('stack');
      if (p.bet.source === 'corrected') edited.push('bet');
      if (p.status.source === 'corrected') edited.push('status');
      if (p.cards.some(c => c.source === 'corrected')) edited.push('cards');
      // A seat without a readable name shows the tracked player it was matched to.
      const name = p.name.value ?? (match?.playerId ? playerLabel(match.playerId) + ' (' + BASIS_LABELS[match.basis] + ')' : seatName(rec, i));
      return {
        name, badges,
        status: p.status.value === 'folded' ? 'folded' : p.status.value === null ? 'unknown' : p.stack.value === 0 ? 'all-in' : 'active',
        cards: p.cards.map(c => c.value), stack: p.stack.value, bet: p.bet.value, edited,
      };
    });
  }

  function stateSeats(state: GameState): TableSeat[] {
    return state.players.map(p => ({
      name: p.name,
      badges: [...(p.seat === state.dealer ? ['Dealer'] : []), ...(p.status === 'folded' ? ['Folded'] : p.status === 'all-in' ? ['All-in'] : [])],
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
    const step = stepIndex === null ? null : steps[stepIndex] ?? null;
    const label = step?.label ?? '';
    // Redraw only when what is shown changes: another observation object or another replay step.
    if (lastTable && lastTable.observation === observation && lastTable.step === step && lastTable.label === label) return;
    lastTable = { observation, step, label };
    const title = element('recon-table-title');
    const note = element('recon-table-note');
    const kind = element('recon-step-kind');
    editButton.hidden = !observation;
    reviewedButton.hidden = !observation || observation.reviewStatus !== 'pending';
    kind.textContent = step ? STEP_KIND_LABELS[step.kind] : '';
    kind.className = 'step-kind' + (step ? ' kind-' + step.kind : '');
    if (step?.kind === 'event') {
      // A verified event, replayed through the hand engine's states.
      const interval = result.intervals[step.intervalIndex];
      const state = step.state;
      title.textContent = 'After: ' + step.label;
      note.textContent = 'Verified event ' + (step.eventIndex + 1) + ' of ' + (interval.actionCheck?.events.length ?? 0)
        + ' between frames ' + (step.intervalIndex + 1) + ' and ' + (step.intervalIndex + 2) + '. Only actions you confirmed are replayed.';
      renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), stateSeats(state));
      element('recon-felt').dataset.seats = String(state.players.length);
      renderBoard(element('recon-board'), state.board);
      element('recon-phase').textContent = state.street[0].toUpperCase() + state.street.slice(1);
      const start = observationById(interval.from);
      const startMiddle = start ? middleChips(start.recognition) : null;
      const states = interval.actionCheck!.states;
      const put = states[0].players.reduce((s, p) => s + p.stack, 0) - state.players.reduce((s, p) => s + p.stack, 0);
      element('recon-pot').textContent = startMiddle === null ? 'Middle unknown' : 'Middle ' + (startMiddle + put).toLocaleString();
      element('recon-pot').classList.remove('edited');
      return;
    }
    if (!observation) {
      title.textContent = 'Table';
      note.textContent = shots.length ? 'Read the frames to see each recognized state here.' : '';
      renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), []);
      renderBoard(element('recon-board'), []);
      element('recon-phase').textContent = '';
      element('recon-pot').textContent = '';
      return;
    }
    const rec = observation.recognition;
    const at = indexOf(observation.screenshotId);
    const cp = result.checkpoints.find(c => c.screenshotId === observation.screenshotId)!;
    const shot = shotById(observation.screenshotId);
    title.textContent = (shot ? frameName(shot.entry, at) : 'Frame ' + (at + 1)) + (rec.street.value ? ' · ' + rec.street.value[0].toUpperCase() + rec.street.value.slice(1) : '');
    const reviewText = { pending: 'Unreviewed', reviewed: 'Reviewed', corrected: 'Corrected by you' }[observation.reviewStatus];
    const gap = step && (step.kind === 'unresolved' || step.kind === 'split') ? step.label + ' ' : '';
    note.textContent = gap + reviewText + (cp.reviewCount ? ' · ' + cp.reviewCount + ' field' + (cp.reviewCount === 1 ? '' : 's') + ' to check' : '')
      + ' · “?” is unknown; dotted underlines mark values you corrected.';
    renderSeats(element('recon-seats-top'), element('recon-seats-bottom'), observedSeats(observation));
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
    editButton.textContent = editing ? 'Close review' : 'Review and correct this frame';
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
    if (!shot?.url) add(editor, 'p', 'The image was not saved with this session; only the recognized state is available.', 'fine-print');
    renderRecognitionEditor(editor, observation.recognition, (next, info) => {
      const current = observations.get(observation.screenshotId);
      if (!current) return;
      if (info?.seatMove) {
        // Actions and player matches name seats by position in this frame; keep them on the same players.
        const map = seatMoveMap(current.recognition.players.length, info.seatMove.from, info.seatMove.to);
        resolutions = remapActionSeats(resolutions, current.id, map);
        overrides = remapOverrides(overrides, current.id, map);
      }
      // Only this frame changes; the comparisons are recomputed from the stored observations, with no new recognition.
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
  // Players, detected changes, and interval resolution
  // -------------------------------------------------------------------------
  const GROUPS: [string, (d: StateDifference) => boolean][] = [
    ['Community cards', d => d.kind.startsWith('board') || d.kind === 'street-changed' || d.kind === 'street-reversed'],
    ['Pot and chips', d => d.kind === 'pot-changed' || d.kind === 'stack-changed' || d.kind === 'bet-changed' || d.kind === 'all-in' || (d.kind.startsWith('value-') && !d.field.startsWith('players.'))],
    ['Players', d => d.kind.startsWith('hole') || d.kind === 'status-changed' || d.kind === 'unfolded' || d.kind.startsWith('seat') || d.kind.startsWith('player-') || d.kind === 'name-changed' || (d.kind.startsWith('value-') && d.field.startsWith('players.'))],
    ['Table', d => d.kind === 'dealer-moved' || d.kind === 'blinds-changed'],
  ];

  function renderChanges() {
    changes.replaceChildren();
    const at = selectedCheckpoint();
    if (at < 0) {
      add(changes, 'p', 'Select a recognized frame to see what changed.', 'fine-print');
      return;
    }
    const cp = result.checkpoints[at];
    renderPlayers(cp);
    if (cp.contradictions.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Problems in this frame');
      const ul = add(box, 'ul');
      for (const c of cp.contradictions) add(ul, 'li', c.text);
    }
    const global = result.globalContradictions.filter(c => c.observationIds.includes(cp.observationId));
    if (global.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Conflicts with other frames');
      const ul = add(box, 'ul');
      for (const c of global) add(ul, 'li', c.text);
    }
    const interval = at > 0 ? result.intervals[at - 1] : undefined;
    if (!interval) {
      add(changes, 'p', 'This is the first frame. What it shows:', 'fine-print');
      const ul = add(changes, 'ul', '', 'recon-facts');
      for (const f of cp.confirmed) add(ul, 'li', f.text);
      if (result.checkpoints.length > 1) add(changes, 'p', 'Select the next frame to see what changed after this one.', 'fine-print');
      return;
    }
    renderInterval(interval, at);
  }

  /** Who is who in the selected frame, with controls to settle matches and absences. */
  function renderPlayers(cp: Checkpoint) {
    const frame = frameIdentity(cp.observationId);
    const o = observationById(cp.observationId);
    if (!frame || !o) return;
    const box = add(changes, 'fieldset', '', 'review-section recon-players');
    add(box, 'legend', 'Players in this frame');
    const ul = add(box, 'ul', '', 'recon-player-list');
    frame.seats.forEach(s => {
      const li = add(ul, 'li', '', s.playerId ? '' : 'issue-review');
      const seatLabel = o.recognition.players[s.seat].name.value ?? 'Seat ' + (s.seat + 1);
      add(li, 'span', seatLabel + ' → ' + (s.playerId ? playerLabel(s.playerId) : 'not matched') + ' ');
      add(li, 'span', BASIS_LABELS[s.basis], 'indicator ' + (s.basis === 'user' ? 'ind-corrected' : s.basis === 'unmatched' ? 'ind-low' : s.basis === 'position' ? 'ind-medium' : 'ind-high'));
      // Let the user match this seat: any tracked player, someone new, or back to automatic.
      const select = add(li, 'select');
      select.setAttribute('aria-label', 'Match ' + seatLabel + ' in this frame to a player');
      const options: [string, string][] = [['', s.basis === 'user' ? 'Automatic match' : 'Change match…']];
      const known = result.identity.players.filter(p => result.identity.frames.findIndex(f => f.observationId === p.firstObservation) < result.identity.frames.indexOf(frame) || p.id === s.playerId);
      const ranked = [...s.candidates, ...known.map(p => p.id).filter(id => !s.candidates.includes(id))];
      for (const id of ranked) options.push([id, playerLabel(id)]);
      options.push([NEW_PLAYER, 'Someone not seen before']);
      for (const [value, text] of options) {
        const option = add(select, 'option', text);
        option.value = value;
      }
      select.value = '';
      select.addEventListener('change', () => {
        const value = select.value;
        if (!value && s.basis !== 'user') return;
        overrides = setOverride(overrides, cp.observationId, s.seat, value || null);
        dirty = true;
        refresh();
        status.textContent = value ? 'Matched ' + seatLabel + ' in this frame. The comparisons were recomputed.' : 'Back to the automatic match for ' + seatLabel + '.';
      });
    });
    for (const m of frame.missing) {
      const li = add(ul, 'li', '', m.acknowledged ? '' : 'issue-review');
      add(li, 'span', playerLabel(m.playerId) + (m.acknowledged ? ' is marked as not visible here (still in the hand). ' : ' is not visible here. That is not a fold. '));
      const toggle = button(li, m.acknowledged ? 'Undo' : 'Mark as not visible', 'secondary link-button');
      toggle.addEventListener('click', () => {
        hidden = m.acknowledged
          ? hidden.filter(h => !(h.observationId === cp.observationId && h.playerId === m.playerId))
          : [...hidden, { observationId: cp.observationId, playerId: m.playerId }];
        dirty = true;
        refresh();
      });
    }
    const conflicts = result.identity.issues.filter(x => x.observationId === cp.observationId && x.kind === 'conflict');
    for (const c of conflicts) add(box, 'p', c.text, 'issue-error');
    add(box, 'p', 'Matches use names, your seat, and seat positions relative to matched players. Nothing is merged on weak evidence.', 'fine-print');
  }

  function renderInterval(interval: Interval, at: number) {
    const head = add(changes, 'div', '', 'recon-interval-head');
    add(head, 'p', 'Since frame ' + at, 'fine-print');
    add(head, 'span', STATUS_LABELS[interval.status], 'recon-status status-' + interval.status);
    add(head, 'span', CONSISTENCY_LABELS[interval.consistency], 'recon-status consistency-' + interval.consistency);
    add(changes, 'p', interval.summary);
    if (interval.consistencyReasons.length && interval.consistency !== 'contradictory') {
      const ul = add(changes, 'ul', '', 'recon-facts fine-print');
      for (const r of interval.consistencyReasons.slice(0, 4)) add(ul, 'li', r);
    }

    if (interval.differentHandSigns.length && interval.status !== 'different-hands') {
      add(changes, 'p', 'These may be different hands: ' + interval.differentHandSigns.join(' '), 'recon-warn');
    }
    if (interval.contradictions.length) {
      const box = add(changes, 'div', '', 'recon-block contradiction');
      add(box, 'h4', 'Contradictions');
      const ul = add(box, 'ul');
      for (const c of interval.contradictions) add(ul, 'li', c.text);
      if (interval.consistencyReasons.some(r => r.includes('out of order'))) add(box, 'p', 'The frames may be out of order: try moving one.', 'fine-print');
      add(box, 'p', 'Correct the misread value in either frame, or mark them as different hands.', 'fine-print');
    }
    const userConfirmed = new Set(interval.resolution?.confirmedChanges ?? []);
    for (const [title, test] of GROUPS) {
      const items = interval.differences.filter(d => d.severity !== 'contradiction' && test(d));
      if (!items.length) continue;
      const box = add(changes, 'div', '', 'recon-block');
      add(box, 'h4', title);
      const ul = add(box, 'ul');
      for (const d of items) {
        const li = add(ul, 'li', d.label, d.severity === 'review' ? 'issue-review' : '');
        const key = differenceKey(d);
        const confirmed = userConfirmed.has(key) || d.evidence === 'confirmed';
        const tags = [confirmed ? 'confirmed' : d.evidence === 'inferred' ? 'inferred' : 'observed'];
        if (d.confidence.previous && d.confidence.next && (d.confidence.previous !== 'high' || d.confidence.next !== 'high')) tags.push('reader confidence ' + d.confidence.previous + ' → ' + d.confidence.next);
        add(li, 'span', ' ' + tags.join(' · '), 'fine-print evidence-' + tags[0]);
        if (d.warning) add(li, 'span', ' ' + d.warning, 'fine-print');
        if (d.evidence !== 'confirmed') {
          const toggle = button(li, userConfirmed.has(key) ? 'Unconfirm' : 'Confirm', 'secondary link-button', (userConfirmed.has(key) ? 'Unconfirm: ' : 'Confirm: ') + d.label);
          toggle.addEventListener('click', () => updateResolution(interval, r => ({
            ...r,
            confirmedChanges: userConfirmed.has(key) ? (r.confirmedChanges ?? []).filter(k => k !== key) : [...(r.confirmedChanges ?? []), key],
          })));
        }
      }
    }
    const confirmedExtra = interval.confirmed.filter(f => !interval.differences.some(d => d.label === f.text));
    if (confirmedExtra.length) {
      const box = add(changes, 'div', '', 'recon-block');
      add(box, 'h4', 'Follows from the frames');
      const ul = add(box, 'ul');
      for (const f of confirmedExtra) add(ul, 'li', f.text);
    }
    if (interval.possible.length) {
      const box = add(changes, 'div', '', 'recon-block unresolved');
      add(box, 'h4', 'Not determined by the frames (inferred possibilities)');
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
      const first = steps.findIndex(s => s.kind === 'event' && s.intervalIndex === interval.fromIndex);
      if (first >= 0) {
        const replay = button(box, 'Replay these actions');
        replay.addEventListener('click', () => { goStep(first); element('recon-felt').scrollIntoView({ block: 'nearest' }); });
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
      add(box, 'p', 'Each action is checked by the hand rules: stack sizes, amounts to call, and minimum bets and raises. Turn order is not checked, because the frames do not show it.', 'fine-print');
    }

    const marks = add(box, 'div', '', 'actions small-actions');
    const unresolved = button(marks, res?.mark === 'unresolved' ? 'Undo “leave unresolved”' : 'Leave unresolved');
    unresolved.disabled = interval.status === 'contradiction' || interval.status === 'different-hands';
    unresolved.addEventListener('click', () => updateResolution(interval, r => ({ ...r, mark: r.mark === 'unresolved' ? 'none' : 'unresolved' })));
    const split = button(marks, res?.mark === 'different-hands' ? 'Undo “separate hands”' : 'Split: these are separate hands');
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
      status.textContent = 'Rechecked frames ' + (interval.fromIndex + 1) + '–' + (interval.fromIndex + 2) + ': ' + (again ? CONSISTENCY_LABELS[again.consistency] + '. ' + again.summary : '');
    });
    add(box, 'p', 'You can save with intervals left unresolved.', 'fine-print');
  }

  // -------------------------------------------------------------------------
  // Replay timeline: observed frames, verified events, and unresolved gaps
  // -------------------------------------------------------------------------
  function checkpointText(c: Checkpoint) {
    const board = c.board.length ? c.board.map(x => x ?? '?').join(' ') : 'no board';
    const frame = frameIdentity(c.observationId);
    const o = observationById(c.observationId);
    // Unreadable names show the tracked player.
    const label = (s: Checkpoint['stacks'][number], i: number) => (o?.recognition.players[i]?.name.value || !frame?.seats[i]?.playerId ? s.label : playerLabel(frame.seats[i].playerId));
    const stacks = c.stacks.map((s, i) => label(s, i) + ' ' + (s.folded ? 'folded' : s.stack === null ? '?' : s.stack)).join(', ');
    return board + ' · pot ' + (c.pot ?? '?') + ' · ' + stacks;
  }

  const currentStep = () => {
    if (stepIndex !== null) return stepIndex;
    const o = selectedObservation();
    return o ? Math.max(0, checkpointStep(steps, o.id)) : 0;
  };

  function renderTimeline() {
    const count = steps.length;
    const at = currentStep();
    scrub.max = String(Math.max(0, count - 1));
    scrub.value = String(at);
    scrub.disabled = count < 2;
    const step = steps[at];
    element('recon-position').textContent = count ? (at + 1) + ' of ' + count + (step ? ' · ' + STEP_KIND_LABELS[step.kind] : '') : '';
    scrub.setAttribute('aria-valuetext', 'Step ' + (at + 1) + ' of ' + count + (step ? ': ' + STEP_KIND_LABELS[step.kind] + ', ' + step.label : ''));
    element<HTMLButtonElement>('recon-first').disabled = at === 0;
    element<HTMLButtonElement>('recon-prev').disabled = at === 0;
    element<HTMLButtonElement>('recon-next').disabled = at >= count - 1;
    element<HTMLButtonElement>('recon-last').disabled = at >= count - 1;
    timeline.replaceChildren();
    steps.forEach((s, index) => {
      const li = add(timeline, 'li', '', 'recon-tl-' + s.kind);
      const b = button(li, '', 'recon-tl-button' + (s.kind === 'checkpoint' ? '' : ' interval') + (index === at ? ' selected' : ''));
      add(b, 'span', STEP_KIND_LABELS[s.kind], 'step-kind kind-' + s.kind);
      if (s.kind === 'checkpoint') {
        const c = result.checkpoints[s.checkpointIndex];
        const shot = shotById(c.screenshotId);
        add(b, 'strong', ' ' + (shot ? frameName(shot.entry, indexOf(c.screenshotId)) : s.label) + (c.street ? ' · ' + c.street : ''));
        add(b, 'span', checkpointText(c), 'fine-print');
        const flags: string[] = [];
        const before = result.intervals[s.checkpointIndex - 1];
        if (before) flags.push(CONSISTENCY_LABELS[before.consistency] + ' with the previous frame');
        if (c.contradictions.length) flags.push(c.contradictions.length + ' problem(s)');
        if (c.reviewCount) flags.push(c.reviewCount + ' to check');
        flags.push({ pending: 'unreviewed', reviewed: 'reviewed', corrected: 'corrected' }[c.reviewStatus]);
        add(b, 'span', flags.join(' · '), 'fine-print');
      } else {
        add(b, 'span', ' ' + s.label);
      }
      if (index === at) b.setAttribute('aria-current', 'step');
      b.addEventListener('click', () => goStep(index));
    });
  }

  const nav = (move: 'first' | 'previous' | 'next' | 'last') => () => goStep(moveStep(currentStep(), steps, move));
  element('recon-first').addEventListener('click', nav('first'));
  element('recon-prev').addEventListener('click', nav('previous'));
  element('recon-next').addEventListener('click', nav('next'));
  element('recon-last').addEventListener('click', nav('last'));
  scrub.addEventListener('input', () => goStep(moveStep(0, steps, Number(scrub.value))));

  // -------------------------------------------------------------------------
  // Summary, saving, export, and history matching
  // -------------------------------------------------------------------------
  function renderSummary() {
    const m = result.metrics;
    const box = element('recon-metrics');
    box.replaceChildren();
    const unsettled = result.identity.issues.filter(x => x.kind !== 'missing').length;
    const rows: [string, number][] = [
      ['Frames', m.screenshots], ['Recognized checkpoints', m.checkpoints], ['Tracked players', result.identity.players.length],
      ['Player matches to settle', unsettled], ['Corrected fields', m.correctedFields],
      ['Verified transitions', m.verifiedTransitions], ['Unresolved intervals', m.unresolvedIntervals], ['Contradictions', m.contradictions],
      ['Hands', result.hands.length],
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
    keepImages.disabled = !shots.some(s => s.url);
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
      const { image: _old, ...entry } = shot.entry;
      screenshots.push({ ...entry, ...(image ? { image } : {}) });
    }
    return createSession({
      id: session.id,
      title: session.title || (result.checkpoints.length ? 'Hand from ' + result.checkpoints.length + ' frames' : 'Tracked hand'),
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      screenshots,
      observations: sequenceObservations(entries(), observations),
      resolutions,
      imagesSaved: withImages,
      identity: { overrides, hidden },
    });
  }

  element('recon-save').addEventListener('click', async () => {
    const note = element('recon-save-note');
    const built = await buildSession();
    const { sessions } = loadReconstructions();
    try {
      saveReconstructions([built, ...sessions.filter(s => s.id !== built.id)]);
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : 'The session could not be saved.';
      return;
    }
    session.title = built.title;
    dirty = false;
    note.textContent = 'Saved “' + built.title + '” in this browser: frame order, recognized states, corrections, player matches, confirmed actions, and checks.'
      + (built.imagesSaved ? ' The images were saved too.' : ' The images and any video were not saved; reopening restores everything else.');
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
  const fileName = (s: ReconstructionSession) => (s.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tracked-hand') + '.json';

  element('recon-export').addEventListener('click', async () => {
    const built = await buildSession();
    download(serializeSession(built), fileName(built));
    element('recon-save-note').textContent = 'Exported' + (built.imagesSaved ? ' with images.' : ' without images (metadata only).');
  });

  element('recon-match').addEventListener('click', () => {
    const out = element('recon-match-result');
    out.replaceChildren();
    const ordered = sequenceObservations(entries(), observations);
    if (!ordered.length) {
      add(out, 'p', 'Read at least one frame first.');
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
      add(out, 'p', hands.length ? 'No saved hand agrees with every frame in this order.' : 'There are no saved hands to compare with.');
      return;
    }
    for (const m of matches) {
      const row = add(out, 'div', '', 'actions');
      add(row, 'p', '“' + m.hand.name + '” fits every frame, at events ' + m.positions.join(', ') + '.');
      const open = button(row, 'Open at the selected frame');
      open.addEventListener('click', () => {
        const at = Math.max(0, selectedCheckpoint());
        options.replay.openHand(m.hand.id, m.positions[at] ?? m.positions[0]);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Saved sessions
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
    overrides = [...saved.identity.overrides];
    hidden = [...saved.identity.hidden];
    keepImages.checked = saved.imagesSaved;
    dirty = false;
    refresh();
    status.textContent = 'Opened “' + saved.title + '”.' + (saved.imagesSaved ? '' : ' The images were not saved, so the recognized states, corrections, and matches are restored without the pictures.');
    if (saved.imagesSaved) {
      // Decode saved images so a frame that is still unread can be sent.
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
        if (dirty && shots.length && !confirm('Open “' + s.title + '”? Unsaved changes to the current session will be lost.')) return;
        load(s);
      });
      add(item, 'p', new Date(s.updatedAt).toLocaleString() + ' · ' + s.screenshots.length + ' frames (' + s.sourceType + ') · ' + s.observations.length + ' read'
        + (s.imagesSaved ? ' · images saved' : ' · metadata only'), 'hand-meta');
      const tools = add(item, 'div', '', 'actions small-actions');
      const rename = button(tools, 'Rename', 'secondary', 'Rename ' + s.title);
      rename.addEventListener('click', () => { renaming = s.id; renderSaved(); });
      const exp = button(tools, 'Export', 'secondary', 'Export ' + s.title);
      exp.addEventListener('click', () => download(serializeSession(s), fileName(s)));
      const del = button(tools, 'Delete', 'secondary', 'Delete ' + s.title);
      del.addEventListener('click', () => {
        if (!confirm('Delete the saved session “' + s.title + '”? This cannot be undone.')) return;
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
      status.textContent = 'That file is too large to be a tracking session.';
      return;
    }
    try {
      const parsed = parseSession(await file.text());
      if (dirty && shots.length && !confirm('Open the imported session? Unsaved changes to the current one will be lost.')) return;
      load(parsed);
      dirty = true;
      status.textContent = 'Imported “' + parsed.title + '”. Save it to keep it in this browser.';
    } catch (error) {
      status.textContent = 'Not imported: ' + (error instanceof Error ? error.message : 'the file is not valid.');
    }
  });

  window.addEventListener('pagehide', () => {
    queue.clear();
    closeVideo();
    for (const s of shots) releaseShot(s);
  });
  renderSaved();
  render();
}
