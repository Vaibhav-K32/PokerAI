// Import screenshot: upload, recognition, review and correction, then load,
// save, attach to a saved hand, or open in hand review. A failed or cancelled
// scan never touches the study table; only "Load into study table" does.
import type { Snapshot } from '../core/types.js';
import { createHandState, replaySteps } from '../history/engine.js';
import { withAttachment, type HandHistory } from '../history/history.js';
import { matchObservation } from '../history/observation.js';
import { claudeScreenshotProvider, fixtureProvider, type ScreenshotProvider } from '../vision/providers.js';
import { drawTable, fixtureById, SCREENSHOT_FIXTURES } from '../vision/screenshot-fixtures.js';
import {
  hasBlockingIssues, toStudySnapshot, toTableObservation, type ReviewIssue, type ScreenshotRecognition,
} from '../vision/screenshot.js';
import { loadHands, saveHands } from './hand-store.js';
import { decodeImage, fileProblem, prepareUpload, svgToPng } from './image.js';
import { renderRecognitionEditor } from './recognition-editor.js';
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

  type Upload = { file: File; bitmap: ImageBitmap; url: string; provider: ScreenshotProvider; label: string };
  let image: Upload | null = null;
  /** The upload the review was read from. Kept until the review is replaced, even after a new file is chosen. */
  let reviewed: Upload | null = null;
  /** True after an edit that has not been saved or attached. */
  let unsavedEdits = false;
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
  function release(upload: Upload) {
    upload.bitmap.close();
    URL.revokeObjectURL(upload.url);
  }

  function releaseImage() {
    if (image && image !== reviewed) release(image);
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
    if (rec && unsavedEdits
      && !confirm('Read the new screenshot? Your unsaved corrections to the current review will be replaced.')) return;
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
        useReviewed(source);
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
  /** Switch the review to another upload (or none), freeing the previous one if nothing else uses it. */
  function useReviewed(next: Upload | null) {
    if (reviewed && reviewed !== next && reviewed !== image) release(reviewed);
    reviewed = next;
  }

  function showReview(recognition: ScreenshotRecognition) {
    rec = recognition;
    notice = '';
    unsavedEdits = false;
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

  function renderReview() {
    if (!rec) return;
    const r = rec;
    statePanel.replaceChildren();
    const issues = renderRecognitionEditor(statePanel, r, next => {
      notice = '';
      unsavedEdits = true;
      rec = next;
      renderReview();
    }, 'shot');
    renderActions(r, issues);
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
    // Always the image the review was read from, never a newer upload.
    if (!reviewed || reviewed.url !== reviewSource) return undefined;
    const blob = await prepareUpload(reviewed.bitmap);
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
    unsavedEdits = false;
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
        if (rec && unsavedEdits && !confirm('Open “' + entry.name + '”? Your unsaved corrections to the current review will be replaced.')) return;
        savedId = entry.id;
        useReviewed(null);
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
  window.addEventListener('pagehide', () => { cancel(); releaseImage(); useReviewed(null); });

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
