// Synthetic screenshot fixtures: fictional tables drawn as SVG by this
// project (no third-party artwork), each with the provider response a reader
// would return. They drive the tests and the "Try a sample" option, so the
// feature can be exercised without paid API calls or a real poker client.

export interface FixtureSeat {
  readonly name: string;
  /** `null` draws an unreadable stack. */
  readonly stack: number | null;
  readonly bet: number;
  /** Card codes, 'hidden' for a card back, or empty for no cards. */
  readonly cards: readonly string[];
  readonly folded?: boolean;
  readonly dealer?: boolean;
  readonly hero?: boolean;
}

export interface FixtureTable {
  readonly seats: readonly FixtureSeat[];
  readonly board: readonly string[];
  readonly pot: number | null;
  readonly blinds?: readonly [number, number];
  readonly streetLabel?: string;
  /** Hide part of the image behind a chat box: board index and hero card index. */
  readonly covered?: { readonly board?: number; readonly heroCard?: number };
  /** Blur names and stacks as if the text were unreadable. */
  readonly blurText?: boolean;
}

export interface ScreenshotFixture {
  readonly id: string;
  readonly label: string;
  readonly table: FixtureTable;
  /** What a provider returns for this image: `{ modelId, result }`. */
  readonly response: { readonly modelId: string; readonly result: unknown };
}

const W = 960;
const H = 600;
const suits: Record<string, [string, string]> = { s: ['♠', '#111'], c: ['♣', '#111'], h: ['♥', '#c0392b'], d: ['♦', '#c0392b'] };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function card(x: number, y: number, code: string, scale = 1, covered = false) {
  const w = 44 * scale;
  const h = 62 * scale;
  if (code === 'hidden') {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#2c4a8a" stroke="#fff" stroke-width="2"/>`
      + `<rect x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" rx="3" fill="none" stroke="#9fb6e8" stroke-dasharray="4 3"/>`;
  }
  const [symbol, color] = suits[code[1]];
  const rank = code[0] === 'T' ? '10' : code[0];
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#fff" stroke="#999"/>`
    + `<text x="${x + w / 2}" y="${y + 28 * scale}" font-size="${22 * scale}" font-weight="700" text-anchor="middle" fill="${color}" font-family="Arial">${rank}</text>`
    + `<text x="${x + w / 2}" y="${y + 52 * scale}" font-size="${22 * scale}" text-anchor="middle" fill="${color}" font-family="Arial">${symbol}</text>`
    + (covered ? '' : '');
}

/** Draw a fictional digital table as an SVG document. */
export function drawTable(table: FixtureTable): string {
  const cx = W / 2;
  const cy = 270;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><filter id="blur"><feGaussianBlur stdDeviation="3.2"/></filter></defs>`,
    `<rect width="${W}" height="${H}" fill="#1b1f24"/>`,
    `<ellipse cx="${cx}" cy="${cy}" rx="380" ry="190" fill="#7a4b2a"/>`,
    `<ellipse cx="${cx}" cy="${cy}" rx="360" ry="172" fill="#1f6b4c"/>`,
    `<text x="20" y="32" font-size="18" fill="#9aa5b1" font-family="Arial">Practice table · play money</text>`,
  ];
  if (table.streetLabel) parts.push(`<text x="20" y="60" font-size="20" font-weight="700" fill="#f2c94c" font-family="Arial">${esc(table.streetLabel)}</text>`);
  if (table.blinds) parts.push(`<text x="${W - 20}" y="32" font-size="18" text-anchor="end" fill="#9aa5b1" font-family="Arial">Blinds ${table.blinds[0]}/${table.blinds[1]}</text>`);
  const potText = table.pot === null ? 'Pot: 1,2??' : 'Pot: ' + table.pot.toLocaleString('en-US');
  parts.push(`<text x="${cx}" y="${cy - 52}" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial"${table.pot === null ? ' filter="url(#blur)"' : ''}>${potText}</text>`);
  table.board.forEach((code, i) => {
    const x = cx - 2.5 * 52 + i * 52 + 4;
    parts.push(card(x, cy - 30, code));
    if (table.covered?.board === i) parts.push(`<rect x="${x - 10}" y="${cy - 40}" width="70" height="86" rx="6" fill="#3a3f47" opacity="0.97"/><text x="${x + 25}" y="${cy + 8}" font-size="12" text-anchor="middle" fill="#ccc" font-family="Arial">chat</text>`);
  });

  const n = table.seats.length;
  table.seats.forEach((seat, k) => {
    // Clockwise from the bottom center, as the recognition prompt describes.
    const angle = Math.PI / 2 + (k * 2 * Math.PI) / n;
    const x = cx + Math.cos(angle) * 430;
    const y = cy + Math.sin(angle) * 245;
    const group: string[] = [`<g${seat.folded ? ' opacity="0.42"' : ''}>`];
    group.push(`<rect x="${x - 70}" y="${y - 6}" width="140" height="52" rx="10" fill="#0f1215" stroke="${seat.hero ? '#f2c94c' : '#4b5563'}" stroke-width="2"/>`);
    const blur = table.blurText ? ' filter="url(#blur)"' : '';
    group.push(`<text x="${x}" y="${y + 16}" font-size="16" text-anchor="middle" fill="#e5e7eb" font-family="Arial"${blur}>${esc(seat.name)}</text>`);
    const stack = seat.stack === null ? '?,???' : seat.stack.toLocaleString('en-US');
    group.push(`<text x="${x}" y="${y + 38}" font-size="16" font-weight="700" text-anchor="middle" fill="#bce78e" font-family="Arial"${blur}>${stack}</text>`);
    if (seat.folded) group.push(`<text x="${x}" y="${y - 14}" font-size="15" text-anchor="middle" fill="#f87171" font-family="Arial">Fold</text>`);
    seat.cards.forEach((code, j) => {
      group.push(card(x - 46 + j * 48, y - 72, code, 0.95));
      if (seat.hero && table.covered?.heroCard === j) {
        group.push(`<rect x="${x - 50 + j * 48}" y="${y - 76}" width="52" height="40" rx="5" fill="#3a3f47" opacity="0.97"/>`);
      }
    });
    group.push('</g>');
    parts.push(...group);
    if (seat.dealer) {
      const dx = cx + Math.cos(angle) * 300 + 40;
      const dy = cy + Math.sin(angle) * 140;
      parts.push(`<circle cx="${dx}" cy="${dy}" r="14" fill="#fff"/><text x="${dx}" y="${dy + 5}" font-size="15" font-weight="700" text-anchor="middle" fill="#111" font-family="Arial">D</text>`);
    }
    if (seat.bet > 0) {
      const bx = cx + Math.cos(angle) * 250;
      const by = cy + Math.sin(angle) * 118;
      parts.push(`<circle cx="${bx - 26}" cy="${by}" r="10" fill="#e4c76b" stroke="#7a5b12"/><text x="${bx - 10}" y="${by + 6}" font-size="17" font-weight="700" fill="#fff" font-family="Arial">${seat.bet.toLocaleString('en-US')}</text>`);
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

type Conf = 'high' | 'medium' | 'low' | 'none';
const f = (value: unknown, confidence: Conf = 'high') => ({ value, confidence: value === null ? 'none' : confidence });

/** The response a careful reader would give for a fully legible table. */
function responseFor(table: FixtureTable) {
  return {
    players: table.seats.map(s => ({
      name: f(s.name),
      stack: f(s.stack),
      bet: f(s.bet),
      status: f(s.folded ? 'folded' : 'active'),
      cards: s.cards.map(c => ({ card: c, confidence: c === 'hidden' ? 'none' : 'high' })),
    })),
    board: table.board.map(c => ({ card: c, confidence: 'high' })),
    pot: f(table.pot),
    smallBlind: f(table.blinds?.[0] ?? null),
    bigBlind: f(table.blinds?.[1] ?? null),
    dealerSeat: f(table.seats.findIndex(s => s.dealer) >= 0 ? table.seats.findIndex(s => s.dealer) : null),
    heroSeat: f(table.seats.findIndex(s => s.hero) >= 0 ? table.seats.findIndex(s => s.hero) : null),
    street: f(table.streetLabel ? table.streetLabel.toLowerCase() : null),
    issues: [] as string[],
  };
}

function fixture(id: string, label: string, table: FixtureTable, edit?: (r: ReturnType<typeof responseFor>) => void): ScreenshotFixture {
  const result = responseFor(table);
  edit?.(result);
  return { id, label, table, response: { modelId: 'fixture', result } };
}

export const SCREENSHOT_FIXTURES: readonly ScreenshotFixture[] = [
  fixture('heads-up-preflop', 'Heads-up, preflop', {
    seats: [
      { name: 'You', stack: 995, bet: 5, cards: ['As', 'Kd'], hero: true, dealer: true },
      { name: 'Morgan', stack: 990, bet: 10, cards: ['hidden', 'hidden'] },
    ],
    board: [], pot: 0, blinds: [5, 10], streetLabel: 'Preflop',
  }),
  fixture('three-player-flop', 'Three players, flop', {
    seats: [
      { name: 'You', stack: 470, bet: 0, cards: ['Qh', 'Qc'], hero: true },
      { name: 'Riley', stack: 455, bet: 0, cards: ['hidden', 'hidden'], dealer: true },
      { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true },
    ],
    board: ['7s', '8d', '2c'], pot: 75, blinds: [5, 10],
  }),
  fixture('four-player-turn', 'Four players, turn', {
    seats: [
      { name: 'You', stack: 820, bet: 0, cards: ['Ah', 'Jh'], hero: true },
      { name: 'Pat', stack: 700, bet: 60, cards: ['hidden', 'hidden'] },
      { name: 'Lee', stack: 1210, bet: 0, cards: [], folded: true, dealer: true },
      { name: 'Kim', stack: 600, bet: 0, cards: ['hidden', 'hidden'] },
    ],
    board: ['Kh', '9h', '3d', '2s'], pot: 240, blinds: [10, 20], streetLabel: 'Turn',
  }),
  fixture('river-complete-board', 'River, full board', {
    seats: [
      { name: 'You', stack: 500, bet: 0, cards: ['Tc', 'Td'], hero: true, dealer: true },
      { name: 'Ash', stack: 350, bet: 100, cards: ['Ks', 'Qs'] },
    ],
    board: ['Jh', '9c', '4s', '2d', '7h'], pot: 300, blinds: [10, 20], streetLabel: 'River',
  }),
  fixture('partially-hidden', 'Partly hidden cards', {
    seats: [
      { name: 'You', stack: 640, bet: 0, cards: ['8s', '8h'], hero: true },
      { name: 'Jo', stack: 580, bet: 40, cards: ['hidden', 'hidden'], dealer: true },
      { name: 'Max', stack: 300, bet: 0, cards: ['hidden', 'hidden'] },
    ],
    board: ['Ac', '6d', '6s', '5c'], pot: 180, blinds: [10, 20],
    covered: { board: 2, heroCard: 1 },
  }, r => {
    r.board[2] = { card: 'unknown', confidence: 'none' };
    r.players[0].cards[1] = { card: 'unknown', confidence: 'none' };
    r.players[0].cards[0] = { card: '8s', confidence: 'medium' };
    r.issues.push('A chat box covers part of the board and part of your second card.');
  }),
  fixture('unreadable-text', 'Unreadable text', {
    seats: [
      { name: 'You', stack: null, bet: 0, cards: ['Jd', 'Js'], hero: true },
      { name: 'Quinn', stack: null, bet: 30, cards: ['hidden', 'hidden'], dealer: true },
      { name: 'Ry', stack: null, bet: 0, cards: ['hidden', 'hidden'] },
    ],
    board: ['Tc', '4h', '3s'], pot: null, blinds: [5, 10],
    blurText: true,
  }, r => {
    r.players.forEach(p => { p.name = f(null); });
    r.players[1].bet = f(30, 'low');
    r.players[2].bet = f(null);
    r.smallBlind = f(null);
    r.bigBlind = f(null);
    r.issues.push('Player names, stacks, and the pot are too blurry to read.');
  }),
];

export const fixtureById = (id: string) => SCREENSHOT_FIXTURES.find(f => f.id === id);
