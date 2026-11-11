// The built-in synthetic benchmark: every screenshot and physical-table
// fixture this project draws, plus the hand sequences. Ground truth comes
// from the drawing definitions (what is actually on the image), never from the
// stored readings, so the readings' deliberate mistakes count as errors. The
// stored readings serve as the deterministic "mock" predictions.
import { DEMO_SEQUENCE, SEQUENCE_FIXTURES } from '../reconstruction/fixtures.js';
import { drawPhysicalScene, PHYSICAL_FIXTURES, PHYSICAL_SEQUENCE, sceneCardBox, type PhysicalScene } from '../physical/fixtures.js';
import { drawTable, SCREENSHOT_FIXTURES, type FixtureTable, type ScreenshotFixture } from '../vision/screenshot-fixtures.js';
import type { Street } from '../vision/screenshot.js';
import {
  DATASET_KIND, DATASET_SCHEMA_VERSION,
  type BenchmarkDataset, type BenchmarkSample, type DifficultyTag, type GroundTruth, type GroundTruthPlayer, type TruthSlot,
} from './types.js';

export const BUILTIN_DATASET_VERSION = 'synthetic-1';
const STREET_FOR: Record<number, Street> = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };

/** Ground truth for a drawn screenshot: what a careful person sees, with covered and blurred items unknown. */
export function screenshotTruth(table: FixtureTable): GroundTruth {
  const players: GroundTruthPlayer[] = table.seats.map((s, k) => ({
    name: table.blurText || table.blurNames?.includes(k) ? null : s.name,
    cards: s.cards.map((code, j): TruthSlot => ({
      card: code === 'hidden' ? { kind: 'face_down' } : s.hero && table.covered?.heroCard === j ? { kind: 'unreadable' } : { kind: 'card', card: code },
      ...(s.hero && table.covered?.heroCard === j ? { tags: ['occluded' as const] } : {}),
    })),
    stack: table.blurText ? null : s.stack,
    bet: s.bet,
    folded: s.folded === true,
  }));
  const board = table.board.map((code, i): TruthSlot => (table.covered?.board === i ? { card: { kind: 'unreadable' }, tags: ['occluded'] } : { card: { kind: 'card', card: code } }));
  const index = (pred: (s: FixtureTable['seats'][number]) => boolean | undefined) => {
    const i = table.seats.findIndex(s => pred(s));
    return i >= 0 ? i : null;
  };
  return {
    players, board, pot: table.pot,
    dealerSeat: index(s => s.dealer), heroSeat: index(s => s.hero),
    street: STREET_FOR[table.board.length] ?? null,
    smallBlind: table.blinds?.[0] ?? null, bigBlind: table.blinds?.[1] ?? null,
  };
}

/** Ground truth for a drawn physical scene, with exact card boxes and chip totals at the scene's chip values. */
export function physicalTruth(scene: PhysicalScene): GroundTruth {
  const value = (color: string) => scene.chipConfig.denominations.find(d => d.colorLabel === color)?.value ?? 0;
  const total = (zone: 'stack' | 'bet' | 'pot', seat?: number) => {
    const piles = scene.chips.filter(g => g.zone === zone && (seat === undefined || g.seat === seat));
    return piles.length ? piles.reduce((sum, g) => sum + g.count * value(g.color), 0) : null;
  };
  const rotated = Math.abs(scene.view?.rotate ?? 0) > 10 || Math.abs(scene.view?.skewX ?? 0) > 10;
  const slot = (c: PhysicalScene['cards'][number]): TruthSlot => {
    const tags = [
      ...(rotated || Math.abs(((c.rot ?? 0) + 360) % 180) > 15 && Math.abs(((c.rot ?? 0) + 360) % 180) < 165 ? ['rotated' as const] : []),
      ...(c.covered ? ['occluded' as const] : []),
      ...(c.blurred ? ['blurred' as const] : []),
    ];
    return { card: c.code === 'back' ? { kind: 'face_down' } : { kind: 'card', card: c.code }, box: sceneCardBox(scene, c), ...(tags.length ? { tags } : {}) };
  };
  const players: GroundTruthPlayer[] = scene.seats.map((s, i) => {
    const cards = scene.cards.filter(c => c.zone === i).sort((a, b) => a.x - b.x || a.y - b.y).map(slot);
    return {
      name: s.label,
      // A single visible back means the second card lies under it, also face down.
      cards: cards.length === 1 ? [...cards, { card: { kind: 'face_down' as const } }] : cards,
      stack: total('stack', i),
      // The space in front of every seat is visible in these scenes: no piles there is a bet of 0.
      bet: total('bet', i) ?? 0,
      folded: s.status === 'folded',
    };
  });
  const board = scene.cards.filter(c => c.zone === 'board').sort((a, b) => a.x - b.x).map(slot);
  const dealer = scene.dealer?.seat ?? null;
  const hero = scene.seats.findIndex(s => s.isUser);
  return {
    players, board, pot: total('pot') ?? 0,
    dealerSeat: dealer, heroSeat: hero >= 0 ? hero : null,
    street: STREET_FOR[board.length] ?? null, smallBlind: null, bigBlind: null,
  };
}

const SCREENSHOT_TAGS: Record<string, DifficultyTag[]> = {
  'heads-up-preflop': ['clean'], 'three-player-flop': ['clean'], 'four-player-turn': ['clean'], 'river-complete-board': ['clean'],
  'partially-hidden': ['occlusion'], 'unreadable-text': ['unreadable_text', 'blur'],
};
const PHYSICAL_TAGS: Record<string, DifficultyTag[]> = {
  'two-player-clear': ['clean'], 'four-player-board': ['clean'], 'angled-photo': ['angled', 'rotated'],
  'partly-hidden': ['occlusion'], 'chip-stacks': ['overlap'], 'uncertain-card': ['blur'],
};

/** Image keys for the built-in samples: `screenshot:<id>`, `sequence:<id>:<n>`, or `physical:<id>`. */
interface BuiltinImage {
  readonly svg: () => string;
  readonly response: unknown;
  readonly sourceType: BenchmarkSample['sourceType'];
}

const images = new Map<string, BuiltinImage>();
const screenshotImage = (f: ScreenshotFixture): BuiltinImage => ({ svg: () => drawTable(f.table), response: f.response, sourceType: 'digital_screenshot' });
for (const f of SCREENSHOT_FIXTURES) images.set('screenshot:' + f.id, screenshotImage(f));
for (const seq of [...SEQUENCE_FIXTURES, DEMO_SEQUENCE]) seq.frames.forEach((f, i) => images.set('sequence:' + seq.id + ':' + (i + 1), screenshotImage(f)));
for (const f of [...PHYSICAL_FIXTURES, ...PHYSICAL_SEQUENCE]) images.set('physical:' + f.scene.id, { svg: () => drawPhysicalScene(f.scene), response: f.response, sourceType: 'physical_photo' });

/** The drawing for a built-in image, as SVG. */
export const builtinSvg = (fixture: string) => images.get(fixture)?.svg() ?? null;
/** The stored reading for a built-in image, used by the mock predictor. */
export const builtinResponse = (fixture: string) => images.get(fixture)?.response ?? null;

function sample(id: string, fixture: string, sourceType: BenchmarkSample['sourceType'], groundTruth: GroundTruth, tags: DifficultyTag[], extra: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return { id, sourceType, image: { kind: 'synthetic', fixture }, groundTruth, tags, metadata: { imageQuality: 'synthetic drawing' }, annotationStatus: 'verified', ...extra };
}

/** The built-in dataset, built deterministically from the fixtures. */
export function builtinDataset(): BenchmarkDataset {
  const samples: BenchmarkSample[] = [];
  for (const f of SCREENSHOT_FIXTURES) samples.push(sample('shot-' + f.id, 'screenshot:' + f.id, 'digital_screenshot', screenshotTruth(f.table), SCREENSHOT_TAGS[f.id] ?? []));
  for (const f of PHYSICAL_FIXTURES) {
    samples.push(sample('photo-' + f.scene.id, 'physical:' + f.scene.id, 'physical_photo', physicalTruth(f.scene), PHYSICAL_TAGS[f.scene.id] ?? [], {
      chipConfig: f.scene.chipConfig,
      metadata: { imageQuality: 'synthetic drawing', ...(f.scene.view ? { orientation: 'rotated and angled' } : {}) },
    }));
  }
  const sequences: BenchmarkDataset['sequences'][number][] = [];
  for (const seq of [...SEQUENCE_FIXTURES, DEMO_SEQUENCE]) {
    const ids = seq.frames.map((f, i) => {
      const id = 'seq-' + seq.id + '-' + (i + 1);
      const tags: DifficultyTag[] = f.table.blurText || f.table.blurNames?.length ? ['unreadable_text'] : f.table.covered ? ['occlusion'] : ['clean'];
      samples.push(sample(id, 'sequence:' + seq.id + ':' + (i + 1), 'digital_screenshot', screenshotTruth(f.table), tags, { notes: seq.label + ', frame ' + (i + 1) }));
      return id;
    });
    sequences.push({ id: seq.id, sampleIds: ids, notes: seq.description });
  }
  const physicalIds = PHYSICAL_SEQUENCE.map(f => {
    const id = 'photo-' + f.scene.id;
    samples.push(sample(id, 'physical:' + f.scene.id, 'physical_photo', physicalTruth(f.scene), ['clean'], { chipConfig: f.scene.chipConfig, notes: f.scene.label }));
    return id;
  });
  sequences.push({ id: 'physical-sequence', sampleIds: physicalIds, notes: 'Three photos of one physical hand.' });
  return {
    kind: DATASET_KIND, schemaVersion: DATASET_SCHEMA_VERSION, name: 'Poker Study synthetic benchmark', datasetVersion: BUILTIN_DATASET_VERSION,
    samples, sequences,
    notes: 'Drawn tables made for this project. Truth comes from the drawing definitions; the stored readings are the mock predictions and include deliberate mistakes. Scores on synthetic drawings say nothing about accuracy on real images.',
  };
}

export const builtinSourceType = (fixture: string) => images.get(fixture)?.sourceType ?? null;
