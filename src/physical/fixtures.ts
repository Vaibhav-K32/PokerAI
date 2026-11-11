// Synthetic photos of staged physical tables, drawn as SVG by this project
// (no third-party artwork or real photographs), each with the reading a
// careful reader would return. Because each scene's layout is known exactly,
// the stored readings include correct approximate boxes. They drive the tests
// and the "Load physical table demo" option; they are sample data, not AI
// recognition.
import type { ChipConfiguration } from './types.js';

export const PHOTO_W = 1200;
export const PHOTO_H = 800;
const CX = 600;
const CY = 400;
const CARD_W = 70;
const CARD_H = 100;

type ChipColor = 'red' | 'green' | 'black' | 'white' | 'blue';
type Zone = 'board' | 'unknown' | number;

export interface SceneSeat {
  readonly label: string | null;
  readonly x: number;
  readonly y: number;
  readonly isUser?: boolean;
  readonly status?: 'active' | 'folded' | 'unknown';
}

export interface SceneCard {
  /** Card code, or 'back' for a face-down card. */
  readonly code: string;
  readonly x: number;
  readonly y: number;
  readonly rot?: number;
  readonly zone: Zone;
  /** Draw something over the lower half of the card. */
  readonly covered?: boolean;
  readonly blurred?: boolean;
  /** What the reader reports instead of the true card. */
  readonly reported?: { readonly card: string; readonly rank?: string | null; readonly suit?: string | null; readonly confidence: 'high' | 'medium' | 'low' | 'none'; readonly visibility?: string };
}

export interface SceneChips {
  readonly color: ChipColor;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly zone: 'stack' | 'bet' | 'pot';
  readonly seat?: number;
  readonly certainty?: 'counted' | 'estimated' | 'unknown';
  /** Draw this stack leaning into another, so it cannot be counted exactly. */
  readonly messy?: boolean;
}

export interface PhysicalScene {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Rotation and perspective of the whole photo. */
  readonly view?: { readonly rotate?: number; readonly skewX?: number; readonly scaleY?: number };
  readonly seats: readonly SceneSeat[];
  readonly cards: readonly SceneCard[];
  readonly chips: readonly SceneChips[];
  readonly dealer: { readonly x: number; readonly y: number; readonly seat: number } | null;
  readonly chipConfig: ChipConfiguration;
  readonly issues?: readonly string[];
  readonly dim?: boolean;
}

export interface PhysicalFixture {
  readonly scene: PhysicalScene;
  /** The stored reading: `{ modelId, layout, result }`. */
  readonly response: { readonly modelId: string; readonly layout: 'physical'; readonly result: unknown };
}

// ---------------------------------------------------------------------------
// Geometry of the drawing
// ---------------------------------------------------------------------------

type M = readonly [number, number, number, number, number, number];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const rad = (d: number) => (d * Math.PI) / 180;
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const rotate = (d: number): M => [Math.cos(rad(d)), Math.sin(rad(d)), -Math.sin(rad(d)), Math.cos(rad(d)), 0, 0];
const skewX = (d: number): M => [1, 0, Math.tan(rad(d)), 1, 0, 0];
const scale = (sx: number, sy: number): M => [sx, 0, 0, sy, 0, 0];
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function viewMatrix(scene: PhysicalScene): M {
  const v = scene.view ?? {};
  return [translate(CX, CY), rotate(v.rotate ?? 0), skewX(v.skewX ?? 0), scale(1, v.scaleY ?? 1), translate(-CX, -CY)].reduce(mul);
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const norm = (p: { x: number; y: number }) => ({ x: r3(p.x / PHOTO_W), y: r3(p.y / PHOTO_H) });

function cardBox(view: M, c: SceneCard) {
  const m = [view, translate(c.x, c.y), rotate(c.rot ?? 0)].reduce(mul);
  const corners = [[-CARD_W / 2, -CARD_H / 2], [CARD_W / 2, -CARD_H / 2], [CARD_W / 2, CARD_H / 2], [-CARD_W / 2, CARD_H / 2]].map(([x, y]) => apply(m, x, y));
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const x0 = Math.max(0, Math.min(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const x1 = Math.min(PHOTO_W, Math.max(...xs));
  const y1 = Math.min(PHOTO_H, Math.max(...ys));
  return { x: r3(x0 / PHOTO_W), y: r3(y0 / PHOTO_H), width: r3((x1 - x0) / PHOTO_W), height: r3((y1 - y0) / PHOTO_H) };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const SUITS: Record<string, [string, string]> = { s: ['♠', '#111'], c: ['♣', '#111'], h: ['♥', '#c0392b'], d: ['♦', '#c0392b'] };
const CHIP_FILL: Record<ChipColor, [string, string]> = {
  red: ['#c0392b', '#f5d0cb'], green: ['#1e8449', '#c9efd6'], black: ['#1d1d1f', '#d0d0d0'], white: ['#f2f2ee', '#888'], blue: ['#1f4fa3', '#cfdcf5'],
};

function drawCard(c: SceneCard): string {
  const t = `translate(${c.x} ${c.y}) rotate(${c.rot ?? 0})`;
  const x = -CARD_W / 2;
  const y = -CARD_H / 2;
  let face: string;
  if (c.code === 'back') {
    face = `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="7" fill="#7b1e2b" stroke="#fff" stroke-width="3"/>`
      + `<rect x="${x + 7}" y="${y + 7}" width="${CARD_W - 14}" height="${CARD_H - 14}" rx="4" fill="none" stroke="#e7b9a4" stroke-width="2" stroke-dasharray="5 3"/>`;
  } else {
    const [sym, col] = SUITS[c.code[1]];
    const rank = c.code[0] === 'T' ? '10' : c.code[0];
    face = `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="7" fill="#fbfaf5" stroke="#9a9a92" stroke-width="1.5"/>`
      + `<text x="${x + 6}" y="${y + 20}" font-size="18" font-weight="700" fill="${col}" font-family="Georgia">${rank}</text>`
      + `<text x="${x + 7}" y="${y + 37}" font-size="16" fill="${col}" font-family="Arial">${sym}</text>`
      + `<text x="0" y="12" font-size="36" text-anchor="middle" fill="${col}" font-family="Arial">${sym}</text>`
      + `<g transform="rotate(180)"><text x="${x + 6}" y="${y + 20}" font-size="18" font-weight="700" fill="${col}" font-family="Georgia">${rank}</text></g>`;
  }
  const blur = c.blurred ? ' filter="url(#soft)"' : '';
  const cover = c.covered ? `<path d="M ${x - 14} ${y + 38} q 50 -22 98 6 l 6 70 l -110 4 z" fill="#c69c7b" stroke="#8a6447" stroke-width="2"/>` : '';
  return `<g transform="${t}"><g${blur}>${face}</g>${cover}<rect x="${x + 3}" y="${y + CARD_H - 4}" width="${CARD_W - 6}" height="5" fill="rgba(0,0,0,0.18)"/></g>`;
}

function drawChips(g: SceneChips): string {
  const [fill, edge] = CHIP_FILL[g.color];
  const layers = Math.min(g.count, 24);
  const parts: string[] = [];
  for (let k = 0; k < layers; k++) {
    const dx = g.messy ? Math.sin(k * 1.7) * 6 : 0;
    parts.push(`<ellipse cx="${g.x + dx}" cy="${g.y - k * 4}" rx="17" ry="7" fill="${fill}" stroke="${edge}" stroke-width="1.5"/>`);
  }
  return parts.join('');
}

/** Draw a staged table as an SVG “photo”. */
export function drawPhysicalScene(scene: PhysicalScene): string {
  const view = viewMatrix(scene);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W * 1.5}" height="${PHOTO_H * 1.5}" viewBox="0 0 ${PHOTO_W} ${PHOTO_H}">`,
    `<defs><filter id="soft"><feGaussianBlur stdDeviation="2.4"/></filter>`
      + `<radialGradient id="felt" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#2f8a5e"/><stop offset="1" stop-color="#16573a"/></radialGradient></defs>`,
    `<rect width="${PHOTO_W}" height="${PHOTO_H}" fill="#3b2a20"/>`,
    `<g transform="matrix(${view.join(' ')})">`,
    `<ellipse cx="${CX}" cy="${CY}" rx="560" ry="360" fill="#5a3a24"/>`,
    `<ellipse cx="${CX}" cy="${CY}" rx="530" ry="332" fill="url(#felt)"/>`,
  ];
  scene.seats.forEach(s => {
    if (s.label) parts.push(`<rect x="${s.x - 50}" y="${s.y + 52}" width="100" height="26" rx="5" fill="#f4ecd8" stroke="#8a7a5a"/><text x="${s.x}" y="${s.y + 70}" font-size="15" text-anchor="middle" fill="#3a2a1a" font-family="Arial">${s.label}</text>`);
  });
  for (const g of scene.chips) parts.push(drawChips(g));
  if (scene.dealer) parts.push(`<circle cx="${scene.dealer.x}" cy="${scene.dealer.y}" r="20" fill="#fff" stroke="#333" stroke-width="2"/><text x="${scene.dealer.x}" y="${scene.dealer.y + 6}" font-size="17" font-weight="700" text-anchor="middle" fill="#222" font-family="Arial">D</text>`);
  for (const c of scene.cards) parts.push(drawCard(c));
  parts.push('</g>');
  if (scene.dim) parts.push(`<rect width="${PHOTO_W}" height="${PHOTO_H}" fill="#000" opacity="0.72"/>`);
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** The reading a careful reader would give for a scene. */
export function readingFor(scene: PhysicalScene) {
  const view = viewMatrix(scene);
  const rotateBy = scene.view?.rotate ?? 0;
  const seatIndex = (zone: Zone) => (typeof zone === 'number' ? zone : null);
  return {
    tableCenter: norm(apply(view, CX, CY)),
    seats: scene.seats.map((s, i) => ({
      label: { value: s.label, confidence: s.label ? 'high' : 'none' },
      position: norm(apply(view, s.x, s.y)),
      isUser: s.isUser === true,
      status: s.status ?? 'active',
      betArea: scene.chips.some(g => g.zone === 'bet' && g.seat === i) ? 'has_chips' : 'empty',
    })),
    cards: scene.cards.map(c => {
      const r = c.reported;
      const card = r ? r.card : c.code === 'back' ? 'face_down' : c.code;
      return {
        card,
        rank: r?.rank ?? null,
        suit: r?.suit ?? null,
        confidence: r ? r.confidence : card === 'face_down' ? 'none' : 'high',
        visibility: r?.visibility ?? (c.code === 'back' ? 'face_down' : c.covered ? 'partially_visible' : 'face_up'),
        box: cardBox(view, c),
        rotation: Math.round((c.rot ?? 0) + rotateBy),
        zone: c.zone === 'board' ? 'board' : c.zone === 'unknown' ? 'unknown' : 'seat',
        seat: seatIndex(c.zone),
      };
    }),
    dealerButton: scene.dealer ? { position: norm(apply(view, scene.dealer.x, scene.dealer.y)), seat: scene.dealer.seat } : { position: null, seat: null },
    chips: scene.chips.map(g => {
      const certainty = g.certainty ?? 'counted';
      return {
        color: g.color,
        count: certainty === 'unknown' ? null : g.count,
        countCertainty: certainty,
        position: norm(apply(view, g.x, g.y - Math.min(g.count, 24) * 2)),
        box: null,
        zone: g.zone,
        seat: g.zone === 'pot' ? null : g.seat ?? null,
      };
    }),
    pot: { value: null, confidence: 'none' },
    potArea: scene.chips.some(g => g.zone === 'pot') ? 'has_chips' : 'empty',
    street: { value: null, confidence: 'none' },
    issues: [...(scene.issues ?? [])],
  };
}

/** The exact box of a card in a scene, as fractions of the photo (ground truth for benchmarks). */
export const sceneCardBox = (scene: PhysicalScene, c: SceneCard) => cardBox(viewMatrix(scene), c);

const fixture = (scene: PhysicalScene): PhysicalFixture => ({ scene, response: { modelId: 'fixture', layout: 'physical', result: readingFor(scene) } });

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Chip values used by every demo scene. Your own game may use different ones. */
export const DEMO_CHIPS: ChipConfiguration = { denominations: [{ colorLabel: 'red', value: 5 }, { colorLabel: 'green', value: 25 }, { colorLabel: 'black', value: 100 }] };

const bottom = { x: 600, y: 650 };
const top = { x: 600, y: 150 };
const left = { x: 170, y: 400 };
const right = { x: 1030, y: 400 };

/** Stack chips for an amount in black, green, and red. */
function stack(amount: number, x: number, y: number, seat: number, zone: 'stack' | 'bet' = 'stack'): SceneChips[] {
  const black = Math.floor(amount / 100);
  const green = Math.floor((amount % 100) / 25);
  const red = (amount % 25) / 5;
  const out: SceneChips[] = [];
  if (black) out.push({ color: 'black', count: black, x: x - 40, y, zone, seat });
  if (green) out.push({ color: 'green', count: green, x, y, zone, seat });
  if (red) out.push({ color: 'red', count: red, x: x + 40, y, zone, seat });
  return out;
}

export const PHYSICAL_FIXTURES: readonly PhysicalFixture[] = [
  fixture({
    id: 'two-player-clear', label: 'Two players, clear cards',
    description: 'Heads-up before the flop, photographed from your seat. Cards and chips are easy to read.',
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Riley', ...top }],
    cards: [
      { code: 'As', x: 565, y: 560, rot: -4, zone: 0 }, { code: 'Kd', x: 640, y: 560, rot: 5, zone: 0 },
      { code: 'back', x: 565, y: 240, rot: 3, zone: 1 }, { code: 'back', x: 640, y: 240, rot: -2, zone: 1 },
    ],
    chips: [...stack(995, 420, 680, 0), ...stack(5, 600, 480, 0, 'bet'), ...stack(990, 780, 130, 1), ...stack(10, 600, 320, 1, 'bet')],
    dealer: { x: 470, y: 560, seat: 0 }, chipConfig: DEMO_CHIPS,
  }),
  fixture({
    id: 'four-player-board', label: 'Four players with community cards',
    description: 'Four seats on the turn: four board cards in the middle, your cards face up, opponents face down, one player folded.',
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Pat', ...left }, { label: 'Lee', ...top, status: 'folded' }, { label: 'Kim', ...right }],
    cards: [
      { code: 'Ah', x: 565, y: 560, rot: -3, zone: 0 }, { code: 'Jc', x: 640, y: 560, rot: 4, zone: 0 },
      { code: 'back', x: 255, y: 380, rot: 80, zone: 1 }, { code: 'back', x: 255, y: 440, rot: 95, zone: 1 },
      { code: 'back', x: 945, y: 380, rot: -85, zone: 3 }, { code: 'back', x: 945, y: 440, rot: -95, zone: 3 },
      { code: 'Kh', x: 480, y: 400, zone: 'board' }, { code: '9h', x: 560, y: 400, zone: 'board' },
      { code: '3d', x: 640, y: 400, zone: 'board' }, { code: '2s', x: 720, y: 400, zone: 'board' },
    ],
    chips: [...stack(820, 420, 690, 0), ...stack(700, 150, 560, 1), ...stack(600, 1050, 560, 3), ...stack(60, 870, 470, 3, 'bet'), { color: 'black', count: 2, x: 600, y: 300, zone: 'pot' }, { color: 'green', count: 1, x: 650, y: 300, zone: 'pot' }, { color: 'red', count: 3, x: 690, y: 300, zone: 'pot' }],
    dealer: { x: 600, y: 230, seat: 2 }, chipConfig: DEMO_CHIPS,
  }),
  fixture({
    id: 'angled-photo', label: 'Rotated, angled photo',
    description: 'Three players on the flop, photographed at an angle: the table is rotated and seen in perspective, so the board is not horizontal.',
    view: { rotate: 24, skewX: 14, scaleY: 0.78 },
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Ash', ...left }, { label: 'Blake', ...right }],
    cards: [
      { code: 'Qs', x: 565, y: 560, rot: -4, zone: 0 }, { code: 'Qd', x: 640, y: 560, rot: 3, zone: 0 },
      { code: 'back', x: 255, y: 380, rot: 85, zone: 1 }, { code: 'back', x: 255, y: 440, rot: 92, zone: 1 },
      { code: 'back', x: 945, y: 380, rot: -88, zone: 2 }, { code: 'back', x: 945, y: 440, rot: -93, zone: 2 },
      { code: '7c', x: 520, y: 400, zone: 'board' }, { code: '8c', x: 600, y: 400, zone: 'board' }, { code: '2h', x: 680, y: 400, zone: 'board' },
    ],
    chips: [...stack(470, 420, 690, 0), ...stack(455, 150, 560, 1), ...stack(990, 1050, 560, 2), { color: 'green', count: 3, x: 600, y: 300, zone: 'pot' }],
    dealer: { x: 1000, y: 300, seat: 2 }, chipConfig: DEMO_CHIPS,
    issues: ['The photo is taken at an angle, so positions are approximate.'],
  }),
  fixture({
    id: 'partly-hidden', label: 'Partly hidden cards',
    description: 'A hand covers part of a board card and one of your cards. The reader reports only what it can see.',
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Jo', ...left }, { label: 'Max', ...right }],
    cards: [
      { code: '8s', x: 565, y: 560, rot: -3, zone: 0 },
      { code: '8h', x: 640, y: 560, rot: 4, zone: 0, covered: true, reported: { card: 'unknown', rank: '8', suit: null, confidence: 'medium', visibility: 'partially_visible' } },
      { code: 'back', x: 255, y: 410, rot: 88, zone: 1 }, { code: 'back', x: 945, y: 410, rot: -88, zone: 2 },
      { code: 'Ac', x: 480, y: 400, zone: 'board' }, { code: '6d', x: 560, y: 400, zone: 'board' },
      { code: '6s', x: 640, y: 400, zone: 'board', covered: true, reported: { card: 'unknown', confidence: 'none', visibility: 'partially_visible' } },
      { code: '5c', x: 720, y: 400, zone: 'board' },
    ],
    chips: [...stack(640, 420, 690, 0), ...stack(580, 150, 560, 1), ...stack(300, 1050, 560, 2)],
    dealer: { x: 255, y: 300, seat: 1 }, chipConfig: DEMO_CHIPS,
    issues: ['A hand covers part of one board card and part of the user’s second card.'],
  }),
  fixture({
    id: 'chip-stacks', label: 'Chip stacks and bets',
    description: 'Three players with chips behind, bets in front, and a pot. One pile overlaps another, so its count is only estimated; another cannot be counted.',
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Dee', ...left }, { label: 'Rae', ...right }],
    cards: [
      { code: 'Td', x: 565, y: 560, rot: -3, zone: 0 }, { code: 'Tc', x: 640, y: 560, rot: 4, zone: 0 },
      { code: 'back', x: 255, y: 410, rot: 88, zone: 1 }, { code: 'back', x: 945, y: 410, rot: -88, zone: 2 },
      { code: 'Jh', x: 520, y: 400, zone: 'board' }, { code: '9c', x: 600, y: 400, zone: 'board' }, { code: '4s', x: 680, y: 400, zone: 'board' },
    ],
    chips: [
      ...stack(500, 420, 690, 0), ...stack(100, 600, 490, 0, 'bet'),
      { color: 'black', count: 3, x: 110, y: 560, zone: 'stack', seat: 1 }, { color: 'green', count: 6, x: 150, y: 560, zone: 'stack', seat: 1, messy: true, certainty: 'estimated' },
      ...stack(100, 330, 470, 1, 'bet'),
      { color: 'black', count: 7, x: 1030, y: 560, zone: 'stack', seat: 2, messy: true, certainty: 'unknown' },
      { color: 'black', count: 1, x: 600, y: 300, zone: 'pot' }, { color: 'green', count: 2, x: 650, y: 300, zone: 'pot' },
    ],
    dealer: { x: 950, y: 300, seat: 2 }, chipConfig: DEMO_CHIPS,
    issues: ['Two of Dee’s piles lean together, so that count is approximate.', 'Rae’s chips overlap too much to count.'],
  }),
  fixture({
    id: 'uncertain-card', label: 'Uncertain card reading',
    description: 'A board card is out of focus. The reader takes the 9♠ for a 6♠ with low confidence; correct it in the review.',
    seats: [{ label: 'You', ...bottom, isUser: true }, { label: 'Drew', ...top }],
    cards: [
      { code: 'Ac', x: 565, y: 560, rot: -3, zone: 0 }, { code: 'Qc', x: 640, y: 560, rot: 4, zone: 0 },
      { code: 'back', x: 565, y: 240, zone: 1 }, { code: 'back', x: 640, y: 240, zone: 1 },
      { code: 'Ah', x: 520, y: 400, zone: 'board' }, { code: 'Kd', x: 600, y: 400, zone: 'board' },
      { code: '9s', x: 680, y: 400, rot: 8, zone: 'board', blurred: true, reported: { card: '6s', confidence: 'low' } },
    ],
    chips: [...stack(900, 420, 690, 0), ...stack(1060, 780, 130, 1), { color: 'green', count: 1, x: 600, y: 300, zone: 'pot' }, { color: 'red', count: 3, x: 640, y: 300, zone: 'pot' }],
    dealer: { x: 470, y: 560, seat: 0 }, chipConfig: DEMO_CHIPS,
    issues: ['One board card is out of focus; 6 and 9 look alike when blurred.'],
  }),
];

export const physicalFixtureById = (id: string) => PHYSICAL_FIXTURES.find(f => f.scene.id === id);

// ---------------------------------------------------------------------------
// A three-photo sequence of one physical hand, for Track hand
// ---------------------------------------------------------------------------

const seq3 = (id: string, label: string, cards: SceneCard[], chips: SceneChips[], status: ('active' | 'folded')[]): PhysicalFixture => fixture({
  id, label, description: label,
  seats: [{ label: 'You', ...bottom, isUser: true, status: status[0] }, { label: 'Riley', ...left, status: status[1] }, { label: 'Sam', ...right, status: status[2] }],
  cards, chips, dealer: { x: 1000, y: 300, seat: 2 }, chipConfig: DEMO_CHIPS,
});
const hole: SceneCard[] = [
  { code: 'Qh', x: 565, y: 560, rot: -3, zone: 0 }, { code: 'Qc', x: 640, y: 560, rot: 4, zone: 0 },
  { code: 'back', x: 255, y: 380, rot: 85, zone: 1 }, { code: 'back', x: 255, y: 440, rot: 92, zone: 1 },
];
const samCards: SceneCard[] = [{ code: 'back', x: 945, y: 380, rot: -88, zone: 2 }, { code: 'back', x: 945, y: 440, rot: -93, zone: 2 }];
const board = (codes: string[]): SceneCard[] => codes.map((code, i) => ({ code, x: 480 + i * 80, y: 400, zone: 'board' as const }));

/** Preflop, flop, and turn of one three-player hand: blinds 5/10, chips in red 5, green 25, black 100. */
export const PHYSICAL_SEQUENCE: readonly PhysicalFixture[] = [
  seq3('physical-seq-1', 'Physical hand: preflop', [...hole, ...samCards],
    [...stack(995, 420, 690, 0), ...stack(5, 600, 490, 0, 'bet'), ...stack(990, 150, 560, 1), ...stack(10, 330, 470, 1, 'bet'), ...stack(1000, 1050, 560, 2)], ['active', 'active', 'active']),
  seq3('physical-seq-2', 'Physical hand: flop', [...hole, ...samCards, ...board(['7s', '8d', '2c'])],
    [...stack(990, 420, 690, 0), ...stack(990, 150, 560, 1), ...stack(990, 1050, 560, 2), { color: 'green', count: 1, x: 600, y: 300, zone: 'pot' }, { color: 'red', count: 1, x: 640, y: 300, zone: 'pot' }], ['active', 'active', 'active']),
  seq3('physical-seq-3', 'Physical hand: turn', [...hole, ...board(['7s', '8d', '2c', 'Kh'])],
    [...stack(970, 420, 690, 0), ...stack(970, 150, 560, 1), ...stack(990, 1050, 560, 2), { color: 'green', count: 2, x: 600, y: 300, zone: 'pot' }, { color: 'red', count: 4, x: 640, y: 300, zone: 'pot' }], ['active', 'active', 'folded']),
];
