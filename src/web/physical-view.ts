// Scan table: photograph or upload a physical table, read it (Claude, or a
// stored sample), check the photo's quality, review and correct cards, seats,
// and chips, then load the result into the study table or add it to Track
// hand. The camera runs only after an explicit tap and is released after
// capture or when leaving; nothing records continuously.
import type { Card, Snapshot } from '../core/types.js';
import { chipConfigProblems, groupValue, sumGroups } from '../physical/chips.js';
import { describeDetection, physicalIssues, physicalToRecognition, type PhysicalIssue } from '../physical/convert.js';
import {
  addCard, addChips, addSeat, assignCard, assignChips, clearPot, clearSeatAmount, markReviewed, moveSeatArea, removeCard, removeChips, removeSeat,
  setBlinds, setCardValue, setCardVisibility, setChipColor, setChipCount, setDealer, setHero, setPot, setSeatBet, setSeatLabel, setSeatPosition,
  setSeatStack, setSeatStatus, setStreet, setTableCenter,
} from '../physical/edits.js';
import { drawPhysicalScene, PHYSICAL_FIXTURES, physicalFixtureById } from '../physical/fixtures.js';
import { seatTitle, tableCenter } from '../physical/geometry.js';
import { framingChecks, photoChecks, type QualityCheck } from '../physical/quality.js';
import {
  cardOf, type CardVisibility, type CardZone, type ChipConfiguration, type ChipCountStatus, type ChipGroup, type ChipZone,
  type PhysicalCardDetection, type PhysicalTableObservation,
} from '../physical/types.js';
import { claudePhysicalProvider, fixturePhysicalProvider, type PhysicalRecognitionProvider } from '../vision/providers.js';
import { hasBlockingIssues, MAX_CHIPS, parseChipInput, reviewScreenshot, toStudySnapshot, type ScreenshotRecognition, type Street } from '../vision/screenshot.js';
import { CameraController } from './camera.js';
import { pickCard } from './card-picker.js';
import { cardName, renderCardFace } from './cards-view.js';
import { loadChipConfig, saveChipConfig } from './chip-store.js';
import { decodeImage, fileProblem, prepareUpload, svgToPng } from './image.js';
import { renderBoard, renderSeats, type TableSeat } from './table-view.js';

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

function select(parent: HTMLElement, label: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void) {
  const wrap = add(parent, 'label', '', 'review-field');
  add(wrap, 'span', label, 'review-label');
  const s = add(wrap, 'select');
  for (const [v, t] of options) {
    const o = add(s, 'option', t);
    o.value = v;
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** A whole-chip input; blank means unknown or "use the chips". Invalid input is refused, not stored. */
function chipInput(parent: HTMLElement, label: string, value: number | null, placeholder: string, onChange: (v: number | null) => void) {
  const wrap = add(parent, 'label', '', 'review-field');
  add(wrap, 'span', label, 'review-label');
  const input = add(wrap, 'input');
  input.type = 'number';
  input.min = '0';
  input.max = String(MAX_CHIPS);
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = placeholder;
  input.value = value === null ? '' : String(value);
  input.addEventListener('change', () => {
    const parsed = parseChipInput(input.value, input.validity.badInput);
    if ('error' in parsed) {
      input.setCustomValidity(parsed.error);
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    onChange(parsed.value);
  });
  return wrap;
}

export interface TrackTarget {
  /** Add a reviewed photo to Track hand as a recognized frame. Returns a message for the user. */
  addRecognizedFrame(file: File, recognition: ScreenshotRecognition, label: string): Promise<string>;
}

interface Photo {
  file: File;
  bitmap: ImageBitmap;
  url: string;
  label: string;
  provider: PhysicalRecognitionProvider;
  quality: QualityCheck[];
  fromCamera: boolean;
  /** Chip values that came with a demo scene. */
  demoChips?: ChipConfiguration;
}

const ZONE_BOARD = 'board';
const ZONE_NONE = 'unassigned';
const zoneValue = (z: CardZone) => (z.kind === 'seat' ? 'seat:' + z.seatId : z.kind);
const zoneFrom = (v: string): CardZone => (v.startsWith('seat:') ? { kind: 'seat', seatId: v.slice(5) } : v === ZONE_BOARD ? { kind: 'board' } : { kind: 'unassigned' });
const chipZoneValue = (z: ChipZone) => (z.kind === 'stack' || z.kind === 'bet' ? z.kind + ':' + z.seatId : z.kind);
const chipZoneFrom = (v: string): ChipZone => {
  const [kind, id] = v.split(':');
  return (kind === 'stack' || kind === 'bet') && id ? { kind, seatId: id } : kind === 'pot' ? { kind: 'pot' } : { kind: 'unassigned' };
};
const STATUS_TEXT: Record<ChipCountStatus, string> = { confirmed: 'confirmed', estimated: 'estimated', unknown: 'unknown' };

export function initPhysicalScan(options: { loadIntoTable: (snapshot: Snapshot) => void; showStudy: () => void; track: TrackTarget }) {
  const status = element('phys-status');
  const readButton = element<HTMLButtonElement>('phys-read');
  const cancelButton = element<HTMLButtonElement>('phys-cancel');
  const clearButton = element<HTMLButtonElement>('phys-clear');
  const drop = element('phys-drop');
  const fileInput = element<HTMLInputElement>('phys-file');
  const previewBox = element('phys-preview-box');
  const qualityList = element('phys-quality');
  const reviewPanel = element('phys-review');
  const stage = element('phys-stage');
  const photoImg = element<HTMLImageElement>('phys-photo');
  const overlay = element('phys-overlay-layer');
  const statePanel = element('phys-state');
  const cameraBox = element('phys-camera');
  const video = element<HTMLVideoElement>('phys-video');
  const cameraStatus = element('phys-camera-status');
  const demoSelect = element<HTMLSelectElement>('phys-demo-select');
  for (const f of PHYSICAL_FIXTURES) {
    const o = add(demoSelect, 'option', f.scene.label);
    o.value = f.scene.id;
  }

  const camera = new CameraController(navigator.mediaDevices as unknown as undefined, window.isSecureContext);
  let photo: Photo | null = null;
  let obs: PhysicalTableObservation | null = null;
  /** The photo the current review was read from; kept even if a new photo is chosen. */
  let readFrom: Photo | null = null;
  let config: ChipConfiguration = loadChipConfig();
  let request: AbortController | null = null;
  let selectedCard: string | null = null;
  let zoom = 1;
  let rotation = 0;
  let showBoxes = true;
  let placing: { kind: 'center' } | { kind: 'seat'; id: string } | null = null;
  let notice = '';

  const activeConfig = () => (readFrom?.demoChips && !config.denominations.length ? readFrom.demoChips : config);

  // -------------------------------------------------------------------------
  // Photos
  // -------------------------------------------------------------------------
  function release(p: Photo | null) {
    if (!p) return;
    p.bitmap.close();
    URL.revokeObjectURL(p.url);
  }

  function setPhoto(next: Photo | null) {
    if (photo && photo !== readFrom) release(photo);
    photo = next;
    previewBox.hidden = !photo;
    readButton.disabled = !photo || !!request;
    clearButton.hidden = !photo;
    if (photo) {
      element<HTMLImageElement>('phys-preview').src = photo.url;
      element('phys-preview-caption').textContent = photo.label + ' · ' + photo.bitmap.width + '×' + photo.bitmap.height
        + (photo.provider.isSample ? ' · sample data, no API call' : '');
      element('phys-consent').hidden = photo.provider.isSample;
      readButton.textContent = obs && readFrom === photo ? 'Read again' : 'Read table';
    } else {
      element<HTMLImageElement>('phys-preview').removeAttribute('src');
    }
    renderQuality();
  }

  async function qualityOf(bitmap: ImageBitmap): Promise<QualityCheck[]> {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return photoChecks({ width: data.width, height: data.height, data: data.data }, { width: bitmap.width, height: bitmap.height }).checks;
  }

  async function useFile(file: File, provider: PhysicalRecognitionProvider, label: string, extra: Partial<Photo> = {}) {
    cancelRead();
    const problem = fileProblem(file);
    if (problem) {
      status.textContent = problem;
      return null;
    }
    status.textContent = 'Opening the photo on this device…';
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeImage(file);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'This photo could not be opened.';
      return null;
    }
    const next: Photo = { file, bitmap, url: URL.createObjectURL(file), label, provider, quality: await qualityOf(bitmap), fromCamera: false, ...extra };
    setPhoto(next);
    status.textContent = next.quality.length
      ? 'Check the photo notes below. You can retake it or read it anyway.'
      : 'Ready. Press Read table to recognize it.';
    return next;
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void useFile(file, claudePhysicalProvider(), file.name);
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
    if (file) void useFile(file, claudePhysicalProvider(), file.name);
  });
  drop.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  clearButton.addEventListener('click', () => {
    cancelRead();
    setPhoto(null);
    status.textContent = 'Photo removed.' + (obs ? ' The review below stays until you read another photo.' : '');
  });

  element('phys-demo').addEventListener('click', async () => {
    const fixture = physicalFixtureById(demoSelect.value) ?? PHYSICAL_FIXTURES[0];
    if (obs && obs.reviewStatus === 'corrected' && !confirm('Load the demo? Your corrections to the current review will be replaced.')) return;
    try {
      const file = await svgToPng(drawPhysicalScene(fixture.scene), fixture.scene.id + '.png');
      const loaded = await useFile(file, fixturePhysicalProvider(fixture.response, 'sample:' + fixture.scene.id), 'Demo: ' + fixture.scene.label, { demoChips: fixture.scene.chipConfig });
      if (loaded) await read(true);
      status.textContent = 'Demo: ' + fixture.scene.description + ' These are stored sample results, not AI recognition.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'The demo could not be drawn.';
    }
  });

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------
  function closeCamera() {
    camera.stop();
    video.srcObject = null;
    cameraBox.hidden = true;
  }

  element('phys-camera-start').addEventListener('click', async () => {
    cameraBox.hidden = false;
    cameraStatus.textContent = 'Asking for camera permission…';
    element<HTMLButtonElement>('phys-capture').disabled = true;
    const result = await camera.start();
    if (!result.ok) {
      if (result.reason !== 'cancelled') cameraStatus.textContent = result.message;
      video.srcObject = null;
      return;
    }
    video.srcObject = result.stream as unknown as MediaStream;
    await video.play().catch(() => {});
    element<HTMLButtonElement>('phys-capture').disabled = false;
    element('phys-switch').hidden = !camera.canSwitch;
    cameraStatus.textContent = 'Frame the whole table, then press Capture. Nothing is recorded or sent until you read the photo.';
  });
  element('phys-switch').addEventListener('click', async () => {
    const result = await camera.switchCamera();
    if (result?.ok) {
      video.srcObject = result.stream as unknown as MediaStream;
      await video.play().catch(() => {});
    } else if (result && result.reason !== 'cancelled') {
      cameraStatus.textContent = result.message;
    }
  });
  element('phys-camera-stop').addEventListener('click', () => {
    closeCamera();
    status.textContent = 'Camera closed.';
  });
  element('phys-capture').addEventListener('click', async () => {
    if (!camera.live || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    // Release the camera as soon as the still is taken.
    closeCamera();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      status.textContent = 'The photo could not be captured. Try again or upload one.';
      return;
    }
    const file = new File([blob], 'table-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.jpg', { type: 'image/jpeg' });
    await useFile(file, claudePhysicalProvider(), 'Camera photo', { fromCamera: true });
    element('phys-retake').hidden = false;
  });
  element('phys-retake').addEventListener('click', () => element('phys-camera-start').click());

  // -------------------------------------------------------------------------
  // Recognition
  // -------------------------------------------------------------------------
  function cancelRead() {
    request?.abort();
    request = null;
    cancelButton.hidden = true;
    drop.classList.remove('busy');
    readButton.disabled = !photo;
  }
  cancelButton.addEventListener('click', () => {
    cancelRead();
    status.textContent = 'Recognition cancelled. Nothing was changed.';
  });

  async function read(skipConfirm = false) {
    const source = photo;
    if (!source) return;
    if (!skipConfirm && obs && obs.reviewStatus === 'corrected' && !confirm('Read this photo? Your corrections to the current review will be replaced.')) return;
    cancelRead();
    const controller = new AbortController();
    request = controller;
    readButton.disabled = true;
    cancelButton.hidden = false;
    drop.classList.add('busy');
    status.textContent = 'Preparing the photo…';
    try {
      // Card corners need detail: the upload keeps the long edge at the recognition size.
      const upload = await prepareUpload(source.bitmap);
      if (controller.signal.aborted) return;
      status.textContent = source.provider.isSample ? 'Reading the stored sample…' : 'Reading the table with Claude… this can take up to a minute.';
      const outcome = await source.provider.recognizePhysicalTable(upload, controller.signal);
      // A newer photo, a cancel, or a removal replaced this request: drop the result.
      if (controller.signal.aborted || photo !== source) return;
      if (outcome.kind === 'cancelled') status.textContent = 'Recognition cancelled. Nothing was changed.';
      else if (outcome.kind === 'failed') {
        status.textContent = outcome.reason + ' Nothing was changed.';
        readButton.textContent = outcome.retryable ? 'Try again' : 'Read table';
      } else {
        if (readFrom && readFrom !== photo) release(readFrom);
        readFrom = source;
        obs = outcome.observation;
        selectedCard = null;
        notice = '';
        rotation = 0;
        zoom = 1;
        showReview();
        status.textContent = (source.provider.isSample ? 'Sample results loaded (not AI recognition). ' : 'Recognized. ') + 'Check the review below; nothing is used until you choose to.';
        readButton.textContent = 'Read again';
      }
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = (error instanceof Error ? error.message : 'Recognition failed.') + ' Nothing was changed.';
    } finally {
      if (request === controller) {
        request = null;
        cancelButton.hidden = true;
        drop.classList.remove('busy');
        readButton.disabled = !photo;
      }
    }
  }
  readButton.addEventListener('click', () => void read());

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------
  function update(next: PhysicalTableObservation) {
    obs = next;
    notice = '';
    render();
  }

  function showReview() {
    reviewPanel.hidden = false;
    render();
    element('phys-review-title').scrollIntoView({ block: 'start' });
  }

  function renderQuality() {
    qualityList.replaceChildren();
    const checks = [...(photo?.quality ?? []), ...(obs && readFrom === photo ? framingChecks(obs) : [])];
    qualityList.hidden = !checks.length;
    for (const c of checks) {
      const li = add(qualityList, 'li', c.message + ' ');
      add(li, 'span', c.evidence, 'fine-print');
    }
  }

  function render() {
    if (!obs) return;
    renderQuality();
    renderPhoto();
    renderState();
  }

  function renderPhoto() {
    if (!obs || !readFrom) return;
    photoImg.src = readFrom.url;
    stage.style.setProperty('--zoom', String(zoom));
    stage.dataset.rotation = String(rotation);
    element('phys-zoom-value').textContent = Math.round(zoom * 100) + '%';
    element<HTMLInputElement>('phys-zoom').value = String(zoom);
    element<HTMLInputElement>('phys-boxes').checked = showBoxes;
    stage.classList.toggle('placing', !!placing);
    element('phys-placing').textContent = placing
      ? placing.kind === 'center' ? 'Click the middle of the table on the photo.' : 'Click where ' + seatTitle(obs.seats, placing.id) + ' sits on the photo.'
      : '';
    overlay.replaceChildren();
    if (!showBoxes) return;
    const issues = physicalIssues(obs, activeConfig());
    const flagged = new Set(issues.map(i => i.field));
    for (const c of obs.cards) {
      if (!c.box) continue;
      const box = add(overlay, 'button', '', 'phys-box' + (flagged.has('card:' + c.id) || (c.confidence !== 'high' && c.source !== 'corrected' && c.visibility !== 'face_down') ? ' uncertain' : '') + (c.id === selectedCard ? ' selected' : ''));
      box.type = 'button';
      box.style.left = c.box.x * 100 + '%';
      box.style.top = c.box.y * 100 + '%';
      box.style.width = c.box.width * 100 + '%';
      box.style.height = c.box.height * 100 + '%';
      box.setAttribute('aria-label', 'Approximate outline of ' + describeDetection(c) + '. Select it in the review.');
      box.title = describeDetection(c) + ' (approximate outline)';
      box.addEventListener('click', event => {
        event.stopPropagation();
        selectedCard = c.id;
        render();
        document.getElementById('phys-card-' + c.id)?.scrollIntoView({ block: 'nearest' });
      });
    }
    const center = tableCenter(obs);
    if (center) {
      const dot = add(overlay, 'span', '', 'phys-center');
      dot.style.left = center.x * 100 + '%';
      dot.style.top = center.y * 100 + '%';
      dot.title = 'Table centre';
    }
    obs.seats.forEach((s, i) => {
      if (!s.center) return;
      const tag = add(overlay, 'span', String(i + 1), 'phys-seat-tag' + (s.id === obs!.heroSeatId ? ' hero' : ''));
      tag.style.left = s.center.x * 100 + '%';
      tag.style.top = s.center.y * 100 + '%';
      tag.title = seatTitle(obs!.seats, s.id);
    });
  }

  element<HTMLInputElement>('phys-zoom').addEventListener('input', event => {
    zoom = Number((event.target as HTMLInputElement).value);
    renderPhoto();
  });
  element('phys-rotate-left').addEventListener('click', () => { rotation = (rotation + 270) % 360; renderPhoto(); });
  element('phys-rotate-right').addEventListener('click', () => { rotation = (rotation + 90) % 360; renderPhoto(); });
  element<HTMLInputElement>('phys-boxes').addEventListener('change', event => {
    showBoxes = (event.target as HTMLInputElement).checked;
    renderPhoto();
  });
  element('phys-set-center').addEventListener('click', () => {
    placing = placing?.kind === 'center' ? null : { kind: 'center' };
    renderPhoto();
  });
  photoImg.addEventListener('click', event => {
    if (!obs || !placing) return;
    // offsetX/offsetY are in the image's own (unrotated) coordinates.
    const point = { x: Math.min(1, Math.max(0, event.offsetX / photoImg.clientWidth)), y: Math.min(1, Math.max(0, event.offsetY / photoImg.clientHeight)) };
    const next = placing.kind === 'center' ? setTableCenter(obs, point) : setSeatPosition(obs, placing.id, point);
    placing = null;
    update(next);
  });

  // ---- The editable state -------------------------------------------------

  function cardLabel(d: PhysicalCardDetection): [string, string] {
    if (d.source === 'corrected') return ['Corrected', 'corrected'];
    if (d.visibility === 'face_down') return ['Face down', 'unknown'];
    if (!cardOf(d)) return ['Unknown', 'unknown'];
    return d.confidence === 'high' ? ['High confidence', 'high'] : d.confidence === 'medium' ? ['Medium confidence', 'medium'] : d.confidence === 'low' ? ['Low confidence', 'low'] : ['Not rated', 'unrated'];
  }

  function zoneOptions(o: PhysicalTableObservation): [string, string][] {
    return [[ZONE_BOARD, 'Board'], ...o.seats.map((s, i) => ['seat:' + s.id, 'Seat ' + (i + 1) + ' · ' + (s.label.value ?? 'unnamed')] as [string, string]), [ZONE_NONE, 'Not assigned']];
  }

  function usedCards(o: PhysicalTableObservation, except: string) {
    return new Set<Card>(o.cards.filter(c => c.id !== except && c.visibility !== 'face_down').map(cardOf).filter((c): c is Card => !!c));
  }

  function cardItem(parent: HTMLElement, o: PhysicalTableObservation, d: PhysicalCardDetection, issues: readonly PhysicalIssue[]) {
    const item = add(parent, 'div', '', 'phys-card' + (d.id === selectedCard ? ' selected' : '') + (issues.some(i => i.field === 'card:' + d.id && i.severity === 'error') ? ' has-error' : ''));
    item.id = 'phys-card-' + d.id;
    const face = add(item, 'button', '', 'card-slot' + (cardOf(d) && d.visibility !== 'face_down' ? ' filled' : ''));
    face.type = 'button';
    const value = d.visibility === 'face_down' ? null : cardOf(d);
    if (value) renderCardFace(add(face, 'span', '', 'face'), value);
    else add(face, 'span', d.visibility === 'face_down' ? 'back' : (d.rank ?? '') + (d.suit ? { c: '♣', d: '♦', h: '♥', s: '♠' }[d.suit] : '') || '?', 'hint');
    face.setAttribute('aria-label', describeDetection(d) + '. Edit.');
    face.addEventListener('click', async () => {
      selectedCard = d.id;
      renderPhoto();
      const result = await pickCard({
        title: 'Card: ' + describeDetection(d),
        note: value ? 'Read as ' + cardName(value) + '. Keep it, pick the correct card, or mark it unknown.' : 'Pick the card you see, or leave it unknown.',
        current: value, used: usedCards(o, d.id), canConfirm: !!value, clearLabel: 'Mark as unknown',
      });
      if (result.kind === 'card') update(setCardValue(o, d.id, result.card));
      else if (result.kind === 'clear') update(setCardValue(o, d.id, null));
      else if (result.kind === 'confirm' && value) update(setCardValue(o, d.id, value));
    });
    const meta = add(item, 'div', '', 'phys-card-meta');
    const [label, level] = cardLabel(d);
    add(meta, 'span', label, 'indicator ind-' + level);
    if (!d.box) add(meta, 'span', 'no position', 'fine-print');
    const visibility = add(meta, 'select');
    visibility.setAttribute('aria-label', 'Visibility of ' + describeDetection(d));
    for (const [v, t] of [['face_up', 'Face up'], ['face_down', 'Face down'], ['partially_visible', 'Partly hidden'], ['unknown', 'Not sure']]) {
      const opt = add(visibility, 'option', t);
      opt.value = v;
    }
    visibility.value = d.visibility;
    visibility.addEventListener('change', () => update(setCardVisibility(o, d.id, visibility.value as CardVisibility)));
    const zone = add(meta, 'select');
    zone.setAttribute('aria-label', 'Where ' + describeDetection(d) + ' belongs');
    for (const [v, t] of zoneOptions(o)) {
      const opt = add(zone, 'option', t);
      opt.value = v;
    }
    zone.value = zoneValue(d.zone);
    zone.addEventListener('change', () => update(assignCard(o, d.id, zoneFrom(zone.value))));
    const remove = button(meta, 'Remove', 'secondary link-button', 'Remove the detection of ' + describeDetection(d));
    remove.addEventListener('click', () => update(removeCard(o, d.id)));
    if (d.zoneNote) add(item, 'p', d.zoneNote, 'fine-print issue-review');
  }

  function chipRow(parent: HTMLElement, o: PhysicalTableObservation, g: ChipGroup, cfg: ChipConfiguration) {
    const row = add(parent, 'div', '', 'phys-chip-row');
    const colorWrap = add(row, 'label', '', 'review-field');
    add(colorWrap, 'span', 'Colour', 'review-label');
    const color = add(colorWrap, 'input');
    color.value = g.color ?? '';
    color.placeholder = 'unknown';
    color.maxLength = 30;
    color.setAttribute('list', 'phys-chip-colors');
    color.addEventListener('change', () => update(setChipColor(o, g.id, color.value)));
    chipInput(row, 'Count', g.count, 'unknown', v => update(setChipCount(o, g.id, v, v === null ? 'unknown' : g.countStatus === 'unknown' ? 'confirmed' : g.countStatus)));
    select(row, 'Count is', [['confirmed', 'Confirmed'], ['estimated', 'Estimated'], ['unknown', 'Unknown']], g.countStatus,
      v => update(setChipCount(o, g.id, v === 'unknown' ? null : g.count, v as ChipCountStatus)));
    const zoneOpts: [string, string][] = [['pot', 'Pot'], ...o.seats.flatMap((s, i) => [
      ['stack:' + s.id, 'Seat ' + (i + 1) + ' stack'] as [string, string], ['bet:' + s.id, 'Seat ' + (i + 1) + ' bet'] as [string, string],
    ]), ['unassigned', 'Not assigned']];
    select(row, 'Belongs to', zoneOpts, chipZoneValue(g.zone), v => update(assignChips(o, g.id, chipZoneFrom(v))));
    const value = groupValue(g, cfg);
    add(row, 'span', value.value === null ? 'Value unknown' : '= ' + value.value.toLocaleString() + ' (' + STATUS_TEXT[value.status] + ')', 'phys-chip-value fine-print');
    const remove = button(row, 'Remove', 'secondary link-button', 'Remove this chip group');
    remove.addEventListener('click', () => update(removeChips(o, g.id)));
  }

  function amountLine(parent: HTMLElement, label: string, override: { value: number | null; source: string }, fromChips: ReturnType<typeof sumGroups> | null,
    set: (v: number | null) => void, clear: () => void) {
    const row = add(parent, 'div', '', 'phys-amount');
    const chipsText = fromChips === null ? 'no chips placed here' : fromChips.value === null ? 'unknown from chips' : fromChips.value.toLocaleString() + ' from chips (' + STATUS_TEXT[fromChips.status] + ')';
    const typed = override.source === 'corrected';
    chipInput(row, label + (typed ? ' (typed)' : ''), typed ? override.value : null, fromChips?.value === null || !fromChips ? 'unknown' : String(fromChips.value), set);
    add(row, 'span', typed ? 'Overrides chips: ' + chipsText + '.' : 'Using ' + chipsText + '. Type a value to override.', 'fine-print');
    if (typed) {
      const back = button(row, 'Use chips', 'secondary link-button');
      back.addEventListener('click', clear);
    }
  }

  function renderState() {
    const o = obs!;
    const cfg = activeConfig();
    const rec = physicalToRecognition(o, cfg);
    const physical = physicalIssues(o, cfg);
    const shared = reviewScreenshot(rec).filter(i => !(i.field === 'players' && physical.some(p => p.field === 'seats')));
    const errors = [...physical.filter(i => i.severity === 'error'), ...shared.filter(i => i.severity === 'error')];
    const reviews = [...physical.filter(i => i.severity === 'review'), ...shared.filter(i => i.severity === 'review')];
    statePanel.replaceChildren();

    const banner = add(statePanel, 'p', '', 'phys-source ' + (readFrom?.provider.isSample ? 'sample' : 'ai'));
    banner.textContent = readFrom?.provider.isSample
      ? 'Sample data: stored fixture results for a drawn table, not AI recognition.'
      : 'Read by Claude' + (o.modelId ? ' (' + o.modelId + ')' : '') + '. Labels are the reader’s own, not measured accuracy. Outlines are approximate.';
    const summary = add(statePanel, 'div', '', 'review-summary' + (errors.length ? ' has-errors' : ''));
    summary.setAttribute('role', 'status');
    add(summary, 'p', errors.length ? errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ' must be fixed before using this state.'
      : reviews.length ? 'No conflicts. ' + reviews.length + ' item' + (reviews.length === 1 ? '' : 's') + ' to check.' : 'Everything is filled in and consistent.');
    if (errors.length || reviews.length) {
      const ul = add(summary, 'ul');
      for (const i of errors) add(ul, 'li', 'Fix: ' + i.message, 'issue-error');
      for (const i of reviews) add(ul, 'li', 'Check: ' + i.message, 'issue-review');
    }
    if (o.warnings.length) add(summary, 'p', 'Reader notes: ' + o.warnings.join(' '), 'fine-print');

    // Chip values.
    const chipsBox = add(statePanel, 'fieldset', '', 'review-section');
    add(chipsBox, 'legend', 'Chip values for this game');
    add(chipsBox, 'p', readFrom?.demoChips && !config.denominations.length
      ? 'Using the demo’s values. Add your own to replace them.'
      : 'Colours have no standard value. Set what each colour is worth in your game; it is saved in this browser.', 'fine-print');
    const list = add(chipsBox, 'datalist');
    list.id = 'phys-chip-colors';
    for (const d of cfg.denominations) add(list, 'option').value = d.colorLabel;
    const editable = config.denominations.length || !readFrom?.demoChips ? config : cfg;
    editable.denominations.forEach((d, i) => {
      const row = add(chipsBox, 'div', '', 'phys-chip-row');
      const nameWrap = add(row, 'label', '', 'review-field');
      add(nameWrap, 'span', 'Colour', 'review-label');
      const name = add(nameWrap, 'input');
      name.value = d.colorLabel;
      name.maxLength = 30;
      name.addEventListener('change', () => setConfig({ denominations: editable.denominations.map((x, k) => (k === i ? { ...x, colorLabel: name.value.trim() } : x)) }));
      chipInput(row, 'Value each', d.value, '', v => setConfig({ denominations: editable.denominations.map((x, k) => (k === i ? { ...x, value: v ?? 0 } : x)) }));
      const remove = button(row, 'Remove', 'secondary link-button', 'Remove ' + d.colorLabel);
      remove.addEventListener('click', () => setConfig({ denominations: editable.denominations.filter((_, k) => k !== i) }));
    });
    const colorsSeen = [...new Set(o.chips.map(g => g.color).filter((c): c is string => !!c))].filter(c => !editable.denominations.some(d => d.colorLabel.toLowerCase() === c.toLowerCase()));
    const addColor = button(chipsBox, colorsSeen.length ? 'Add value for ' + colorsSeen[0] : 'Add a chip colour');
    addColor.addEventListener('click', () => setConfig({ denominations: [...editable.denominations, { colorLabel: colorsSeen[0] ?? 'colour ' + (editable.denominations.length + 1), value: 1 }] }));
    for (const p of chipConfigProblems(config)) add(chipsBox, 'p', p, 'issue-error');

    // Table.
    const table = add(statePanel, 'fieldset', '', 'review-section');
    add(table, 'legend', 'Table');
    const row1 = add(table, 'div', '', 'review-row');
    select(row1, 'Street', [['', 'From the board'], ['preflop', 'Preflop'], ['flop', 'Flop'], ['turn', 'Turn'], ['river', 'River']], o.street.value ?? '',
      v => update(setStreet(o, (v || null) as Street | null)));
    const potChips = o.chips.filter(g => g.zone.kind === 'pot');
    amountLine(table, 'Pot', o.potText, potChips.length ? sumGroups(potChips, cfg) : null, v => update(setPot(o, v)), () => update(clearPot(o)));
    const blinds = add(table, 'div', '', 'review-row');
    chipInput(blinds, 'Small blind', o.smallBlind.value, 'unknown', v => update(setBlinds(o, v, o.bigBlind.value)));
    chipInput(blinds, 'Big blind', o.bigBlind.value, 'unknown', v => update(setBlinds(o, o.smallBlind.value, v)));
    const tools = add(table, 'div', '', 'actions small-actions');
    const noBets = button(tools, 'No bets in front of anyone');
    noBets.title = 'Sets every unknown bet to 0. Use it only when the photo shows no chips pushed forward.';
    noBets.addEventListener('click', () => {
      let next = o;
      for (const s of o.seats) {
        if (s.betOverride.source === 'corrected' || o.chips.some(g => g.zone.kind === 'bet' && g.zone.seatId === s.id)) continue;
        next = setSeatBet(next, s.id, 0);
      }
      update(next);
    });
    const center = button(tools, placing?.kind === 'center' ? 'Cancel placing' : 'Mark the table centre');
    center.addEventListener('click', () => {
      placing = placing?.kind === 'center' ? null : { kind: 'center' };
      renderPhoto();
      renderState();
    });
    add(table, 'p', 'Marking the centre or a seat on the photo regroups cards and chips you have not placed yourself.', 'fine-print');

    // Board.
    const boardBox = add(statePanel, 'fieldset', '', 'review-section');
    add(boardBox, 'legend', 'Community cards');
    const boardCards = o.cards.filter(c => c.zone.kind === 'board');
    for (const d of boardCards) cardItem(boardBox, o, d, physical);
    if (!boardCards.length) add(boardBox, 'p', 'No community cards.', 'fine-print');
    const addBoard = button(boardBox, 'Add a board card');
    addBoard.disabled = boardCards.length >= 5;
    addBoard.addEventListener('click', () => update(addCard(o, { kind: 'board' }, null, 'unknown')));

    // Seats.
    const seatsBox = add(statePanel, 'fieldset', '', 'review-section');
    add(seatsBox, 'legend', 'Seats, clockwise');
    o.seats.forEach((s, i) => {
      const seat = add(seatsBox, 'fieldset', '', 'review-seat' + (o.heroSeatId === s.id ? ' is-hero' : ''));
      add(seat, 'legend', 'Seat ' + (i + 1) + (s.label.value ? ' · ' + s.label.value : ''));
      const order = add(seat, 'div', '', 'actions small-actions seat-order');
      const up = button(order, '↑ Move up', 'secondary', 'Move seat ' + (i + 1) + ' up');
      up.disabled = i === 0;
      up.addEventListener('click', () => update(moveSeatArea(o, s.id, i - 1)));
      const down = button(order, '↓ Move down', 'secondary', 'Move seat ' + (i + 1) + ' down');
      down.disabled = i === o.seats.length - 1;
      down.addEventListener('click', () => update(moveSeatArea(o, s.id, i + 1)));
      const place = button(order, placing?.kind === 'seat' && placing.id === s.id ? 'Cancel placing' : s.center ? 'Move on photo' : 'Place on photo', 'secondary');
      place.addEventListener('click', () => {
        placing = placing?.kind === 'seat' && placing.id === s.id ? null : { kind: 'seat', id: s.id };
        renderPhoto();
        renderState();
      });
      const removeSeatButton = button(order, 'Remove seat', 'secondary', 'Remove seat ' + (i + 1));
      removeSeatButton.addEventListener('click', () => update(removeSeat(o, s.id)));

      const top = add(seat, 'div', '', 'review-row');
      const nameWrap = add(top, 'label', '', 'review-field');
      add(nameWrap, 'span', 'Name', 'review-label');
      const name = add(nameWrap, 'input');
      name.value = s.label.value ?? '';
      name.placeholder = 'Unknown';
      name.maxLength = 60;
      name.addEventListener('change', () => update(setSeatLabel(o, s.id, name.value)));
      select(top, 'Status', [['', 'Unknown'], ['active', 'In the hand'], ['folded', 'Folded']], s.status.value ?? '', v => update(setSeatStatus(o, s.id, (v || null) as 'active' | 'folded' | null)));
      const roles = add(seat, 'div', '', 'review-row roles');
      const radio = (label: string, group: string, checked: boolean, pick: () => void) => {
        const wrap = add(roles, 'label', '', 'checkbox');
        const input = add(wrap, 'input');
        input.type = 'radio';
        input.name = group;
        input.checked = checked;
        wrap.append(' ' + label);
        input.addEventListener('change', pick);
      };
      radio('This is me', 'phys-hero', o.heroSeatId === s.id, () => update(setHero(o, s.id)));
      radio('Dealer button', 'phys-dealer', o.dealerSeatId === s.id, () => update(setDealer(o, s.id)));

      const cards = o.cards.filter(c => c.zone.kind === 'seat' && c.zone.seatId === s.id);
      const cardBox = add(seat, 'div', '', 'phys-cards');
      for (const d of cards) cardItem(cardBox, o, d, physical);
      if (!cards.length) add(cardBox, 'p', 'No cards placed here.', 'fine-print');
      if (cards.length < 2) {
        const addHere = button(cardBox, 'Add a card here');
        addHere.addEventListener('click', () => update(addCard(o, { kind: 'seat', seatId: s.id }, null, 'unknown')));
      }

      const stackGroups = o.chips.filter(g => g.zone.kind === 'stack' && g.zone.seatId === s.id);
      const betGroups = o.chips.filter(g => g.zone.kind === 'bet' && g.zone.seatId === s.id);
      amountLine(seat, 'Stack', s.stackOverride, stackGroups.length ? sumGroups(stackGroups, cfg) : null, v => update(setSeatStack(o, s.id, v)), () => update(clearSeatAmount(o, s.id, 'stack')));
      amountLine(seat, 'Bet', s.betOverride, betGroups.length ? sumGroups(betGroups, cfg) : null, v => update(setSeatBet(o, s.id, v)), () => update(clearSeatAmount(o, s.id, 'bet')));
      for (const g of [...stackGroups, ...betGroups]) chipRow(seat, o, g, cfg);
      const addChipsButton = button(seat, 'Add chips for this seat');
      addChipsButton.addEventListener('click', () => update(addChips(o, { kind: 'stack', seatId: s.id })));
    });
    const addSeatButton = button(seatsBox, 'Add a seat');
    addSeatButton.disabled = o.seats.length >= 10;
    addSeatButton.addEventListener('click', () => update(addSeat(o)));

    // Pot chips and anything unassigned.
    const other = add(statePanel, 'fieldset', '', 'review-section');
    add(other, 'legend', 'Pot chips and unassigned items');
    for (const g of potChips) chipRow(other, o, g, cfg);
    const loose = o.cards.filter(c => c.zone.kind === 'unassigned' || (c.zone.kind === 'seat' && !o.seats.some(s => s.id === (c.zone as { seatId: string }).seatId)));
    for (const d of loose) cardItem(other, o, d, physical);
    for (const g of o.chips.filter(g => g.zone.kind === 'unassigned')) chipRow(other, o, g, cfg);
    const addPot = button(other, 'Add pot chips');
    addPot.addEventListener('click', () => update(addChips(o, { kind: 'pot' })));
    if (!potChips.length && !loose.length) add(other, 'p', 'Nothing here.', 'fine-print');

    // The converted table, as the rest of the app will see it.
    const preview = add(statePanel, 'fieldset', '', 'review-section');
    add(preview, 'legend', 'Table state for the app');
    const felt = add(preview, 'div', '', 'felt replay-felt');
    const topSeats = add(felt, 'div', '', 'replay-seats');
    const middle = add(felt, 'div', '', 'center');
    const street = add(middle, 'p', rec.street.value ? rec.street.value[0].toUpperCase() + rec.street.value.slice(1) + (rec.street.source === 'inferred' ? ' (from the board)' : '') : 'Street unknown', 'replay-phase');
    street.setAttribute('aria-label', 'Street');
    const boardEl = add(middle, 'div', '', 'cards board');
    add(middle, 'p', 'Pot ' + (rec.pot.value === null ? '?' : rec.pot.value.toLocaleString()), 'replay-pot');
    const bottomSeats = add(felt, 'div', '', 'replay-seats');
    const seatModels: TableSeat[] = rec.players.map((p, i) => ({
      name: p.name.value ?? 'Seat ' + (i + 1),
      badges: [...(rec.dealerSeat.value === i ? ['Dealer'] : []), ...(rec.heroSeat.value === i ? ['You'] : []), ...(p.status.value === 'folded' ? ['Folded'] : [])],
      status: p.status.value === 'folded' ? 'folded' : p.status.value === null ? 'unknown' : 'active',
      cards: p.cards.map(c => c.value), stack: p.stack.value, bet: p.bet.value,
    }));
    renderSeats(topSeats, bottomSeats, seatModels);
    renderBoard(boardEl, rec.communityCards.map(c => c.value));

    // Using the state.
    const use = add(statePanel, 'fieldset', '', 'review-section review-actions');
    add(use, 'legend', 'Use this state');
    const message = add(use, 'div', '', 'action-message');
    message.setAttribute('role', 'status');
    message.textContent = notice;
    const blocked = errors.length > 0 || hasBlockingIssues(shared);
    const loadRow = add(use, 'div', '', 'actions');
    const purpose = select(loadRow, 'Study context', [['simulation', 'Simulated hand'], ['completed', 'Completed hand']], 'simulation', () => {});
    const load = button(loadRow, 'Load into study table', '');
    load.disabled = blocked;
    load.addEventListener('click', () => {
      const result = toStudySnapshot(rec, purpose.value as Snapshot['purpose']);
      if ('problems' in result) {
        notice = 'Not loaded. The study table needs: ' + result.problems.join(' ');
        renderState();
        return;
      }
      options.loadIntoTable(result.snapshot);
      options.showStudy();
    });
    const track = button(loadRow, 'Add to Track hand');
    track.disabled = blocked;
    track.addEventListener('click', async () => {
      if (!readFrom) return;
      notice = await options.track.addRecognizedFrame(readFrom.file, rec, readFrom.label);
      renderState();
    });
    const reviewed = button(loadRow, o.reviewStatus === 'unreviewed' ? 'Mark as reviewed' : o.reviewStatus === 'corrected' ? 'Corrected' : 'Reviewed');
    reviewed.disabled = o.reviewStatus !== 'unreviewed';
    reviewed.addEventListener('click', () => update(markReviewed(o)));
    if (blocked) add(use, 'p', 'Fix the problems marked “Fix” to use this state. Partial states can still be added to Track hand once nothing blocks them.', 'fine-print');
    add(use, 'p', 'The study table needs your two cards, every stack, every bet, the pot, and the big blind. Unknown values are never filled in for you.', 'fine-print');
  }

  function setConfig(next: ChipConfiguration) {
    config = next;
    if (!chipConfigProblems(next).length) {
      const problem = saveChipConfig(next);
      if (problem) status.textContent = problem;
    }
    render();
  }

  // -------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------
  const leave = () => {
    closeCamera();
    if (request) {
      cancelRead();
      status.textContent = 'Recognition stopped because you left the screen. Nothing was changed.';
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); });
  window.addEventListener('pagehide', () => {
    leave();
    release(photo);
    if (readFrom !== photo) release(readFrom);
  });
  element('phys-camera-start').hidden = !camera.available;
  if (!camera.available) element('phys-camera-note').textContent = window.isSecureContext ? 'This browser cannot use a camera here; upload a photo instead.' : 'Camera capture needs a secure page (HTTPS or localhost); upload a photo instead.';
  return { leave };
}
