// Synthetic screenshot sequences for reconstruction tests and in-app samples.
// Each frame is a fictional table drawn by this project with the response a
// careful reader would give, so no paid API call or real client is needed.
import { fixture, type ScreenshotFixture } from '../vision/screenshot-fixtures.js';

export interface SequenceFixture {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly frames: readonly ScreenshotFixture[];
}

const hidden = ['hidden', 'hidden'];

export const SEQUENCE_FIXTURES: readonly SequenceFixture[] = [
  {
    id: 'complete-hand',
    label: 'Complete hand, preflop to showdown',
    description: 'Three players, 5/10 blinds, 1,000 chips each. Every chip is visible in every frame.',
    frames: [
      fixture('complete-1', 'Preflop, blinds posted', {
        seats: [
          { name: 'You', stack: 995, bet: 5, cards: ['Qh', 'Qc'], hero: true },
          { name: 'Riley', stack: 990, bet: 10, cards: hidden },
          { name: 'Sam', stack: 1000, bet: 0, cards: hidden, dealer: true },
        ],
        board: [], pot: 0, blinds: [5, 10], streetLabel: 'Preflop',
      }),
      fixture('complete-2', 'Flop', {
        seats: [
          { name: 'You', stack: 990, bet: 0, cards: ['Qh', 'Qc'], hero: true },
          { name: 'Riley', stack: 990, bet: 0, cards: hidden },
          { name: 'Sam', stack: 990, bet: 0, cards: hidden, dealer: true },
        ],
        board: ['7s', '8d', '2c'], pot: 30, blinds: [5, 10], streetLabel: 'Flop',
      }),
      fixture('complete-3', 'Turn', {
        seats: [
          { name: 'You', stack: 970, bet: 0, cards: ['Qh', 'Qc'], hero: true },
          { name: 'Riley', stack: 970, bet: 0, cards: hidden },
          { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true, dealer: true },
        ],
        board: ['7s', '8d', '2c', 'Kh'], pot: 70, blinds: [5, 10], streetLabel: 'Turn',
      }),
      fixture('complete-4', 'River', {
        seats: [
          { name: 'You', stack: 970, bet: 0, cards: ['Qh', 'Qc'], hero: true },
          { name: 'Riley', stack: 970, bet: 0, cards: hidden },
          { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true, dealer: true },
        ],
        board: ['7s', '8d', '2c', 'Kh', '3d'], pot: 70, blinds: [5, 10], streetLabel: 'River',
      }),
      fixture('complete-5', 'Showdown', {
        seats: [
          { name: 'You', stack: 1090, bet: 0, cards: ['Qh', 'Qc'], hero: true },
          { name: 'Riley', stack: 920, bet: 0, cards: ['As', '9s'] },
          { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true, dealer: true },
        ],
        board: ['7s', '8d', '2c', 'Kh', '3d'], pot: 0, blinds: [5, 10], streetLabel: 'River',
      }),
    ],
  },
  {
    id: 'missing-street',
    label: 'Missing flop screenshot',
    description: 'Heads-up: a preflop frame, then the turn. The flop and its betting were never captured.',
    frames: [
      fixture('missing-1', 'Preflop', {
        seats: [
          { name: 'You', stack: 995, bet: 5, cards: ['Ah', 'Jh'], hero: true, dealer: true },
          { name: 'Morgan', stack: 990, bet: 10, cards: hidden },
        ],
        board: [], pot: 0, blinds: [5, 10], streetLabel: 'Preflop',
      }),
      fixture('missing-2', 'Turn', {
        seats: [
          { name: 'You', stack: 960, bet: 0, cards: ['Ah', 'Jh'], hero: true, dealer: true },
          { name: 'Morgan', stack: 960, bet: 0, cards: hidden },
        ],
        board: ['As', '7d', '2h', '9c'], pot: 80, blinds: [5, 10], streetLabel: 'Turn',
      }),
    ],
  },
  {
    id: 'ambiguous-betting',
    label: 'Ambiguous betting',
    description: 'The pot grows from 60 to 120 while two stacks are unreadable, so who put in what is unknown.',
    frames: [
      fixture('ambiguous-1', 'Flop, pot 60', {
        seats: [
          { name: 'You', stack: 980, bet: 0, cards: ['Td', '9d'], hero: true },
          { name: 'Pat', stack: 980, bet: 0, cards: hidden, dealer: true },
          { name: 'Kim', stack: 980, bet: 0, cards: hidden },
        ],
        board: ['Jh', '8c', '4d'], pot: 60, blinds: [10, 20], streetLabel: 'Flop',
      }),
      fixture('ambiguous-2', 'Turn, pot 120', {
        seats: [
          { name: 'You', stack: 980, bet: 0, cards: ['Td', '9d'], hero: true },
          { name: 'Pat', stack: null, bet: 0, cards: hidden, dealer: true },
          { name: 'Kim', stack: null, bet: 0, cards: hidden },
        ],
        board: ['Jh', '8c', '4d', '5s'], pot: 120, blinds: [10, 20], streetLabel: 'Turn',
      }, r => {
        r.issues.push('Two stacks are covered by animations and cannot be read.');
      }),
    ],
  },
  {
    id: 'recognition-error',
    label: 'Misread card',
    description: 'The reader takes the 7♣ on the flop for a 7♠ on the turn, which contradicts the earlier frame.',
    frames: [
      fixture('error-1', 'Flop', {
        seats: [
          { name: 'You', stack: 900, bet: 0, cards: ['Ac', 'Qc'], hero: true, dealer: true },
          { name: 'Drew', stack: 1060, bet: 0, cards: hidden },
        ],
        board: ['Ah', 'Kd', '7c'], pot: 40, blinds: [5, 10], streetLabel: 'Flop',
      }),
      fixture('error-2', 'Turn (7♣ misread)', {
        seats: [
          { name: 'You', stack: 900, bet: 0, cards: ['Ac', 'Qc'], hero: true, dealer: true },
          { name: 'Drew', stack: 1060, bet: 0, cards: hidden },
        ],
        board: ['Ah', 'Kd', '7c', '2h'], pot: 40, blinds: [5, 10], streetLabel: 'Turn',
      }, r => {
        r.board[2] = { card: '7s', confidence: 'medium' };
      }),
    ],
  },
  {
    id: 'multiway-all-in',
    label: 'Three-way all-in with a side pot',
    description: 'Ash is all-in for 200 and wins the main pot; you win the 600 side pot from Blake.',
    frames: [
      fixture('allin-1', 'Preflop, blinds posted', {
        seats: [
          { name: 'You', stack: 490, bet: 10, cards: ['Kc', 'Kh'], hero: true },
          { name: 'Ash', stack: 180, bet: 20, cards: hidden },
          { name: 'Blake', stack: 1000, bet: 0, cards: hidden, dealer: true },
        ],
        board: [], pot: 0, blinds: [10, 20], streetLabel: 'Preflop',
      }),
      fixture('allin-2', 'All-in, cards shown', {
        seats: [
          { name: 'You', stack: 0, bet: 500, cards: ['Kc', 'Kh'], hero: true },
          { name: 'Ash', stack: 0, bet: 200, cards: ['Qs', 'Qd'] },
          { name: 'Blake', stack: 500, bet: 500, cards: ['9c', '9d'], dealer: true },
        ],
        board: [], pot: 0, blinds: [10, 20], streetLabel: 'Preflop',
      }),
      fixture('allin-3', 'Showdown, pots awarded', {
        seats: [
          { name: 'You', stack: 600, bet: 0, cards: ['Kc', 'Kh'], hero: true },
          { name: 'Ash', stack: 600, bet: 0, cards: ['Qs', 'Qd'] },
          { name: 'Blake', stack: 500, bet: 0, cards: ['9c', '9d'], dealer: true },
        ],
        board: ['2s', '5h', 'Qc', '8d', '3c'], pot: 0, blinds: [10, 20], streetLabel: 'River',
      }),
    ],
  },
];

export const sequenceById = (id: string) => SEQUENCE_FIXTURES.find(s => s.id === id);

// ---------------------------------------------------------------------------
// Demo sequence for Track hand
// ---------------------------------------------------------------------------

/**
 * Five frames of one fictional three-player hand, preflop to showdown, built
 * to show the whole workflow without an API key:
 * - frame 3 cannot read Riley's name, so Riley is matched by seat position;
 * - frame 4 comes from a client that hides folded players (Sam), and misreads
 *   the turn card Kh as Kd, a contradiction to correct;
 * - the flop actions between frames 2 and 3 are supplied as confirmed by the
 *   user (`DEMO_CONFIRMED_ACTIONS`); the other gaps stay unresolved.
 */
export const DEMO_SEQUENCE: SequenceFixture = {
  id: 'demo-track',
  label: 'Demo: tracked three-player hand',
  description: 'Five frames from preflop to showdown with an unreadable name, a hidden folded player, a misread card to correct, one interval with confirmed actions, and unresolved gaps.',
  frames: [
    fixture('demo-1', 'Preflop, blinds posted', {
      seats: [
        { name: 'You', stack: 995, bet: 5, cards: ['Qh', 'Qc'], hero: true },
        { name: 'Riley', stack: 990, bet: 10, cards: hidden },
        { name: 'Sam', stack: 1000, bet: 0, cards: hidden, dealer: true },
      ],
      board: [], pot: 0, blinds: [5, 10], streetLabel: 'Preflop',
    }),
    fixture('demo-2', 'Flop', {
      seats: [
        { name: 'You', stack: 990, bet: 0, cards: ['Qh', 'Qc'], hero: true },
        { name: 'Riley', stack: 990, bet: 0, cards: hidden },
        { name: 'Sam', stack: 990, bet: 0, cards: hidden, dealer: true },
      ],
      board: ['7s', '8d', '2c'], pot: 30, blinds: [5, 10], streetLabel: 'Flop',
    }),
    fixture('demo-3', 'Turn, a name is unreadable', {
      seats: [
        { name: 'You', stack: 970, bet: 0, cards: ['Qh', 'Qc'], hero: true },
        { name: 'Riley', stack: 970, bet: 0, cards: hidden },
        { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true, dealer: true },
      ],
      board: ['7s', '8d', '2c', 'Kh'], pot: 70, blinds: [5, 10], streetLabel: 'Turn',
      blurNames: [1],
    }, r => {
      r.players[1].name = { value: null, confidence: 'none' };
      r.issues.push('One player label is covered by an animation.');
    }),
    fixture('demo-4', 'River, folded player hidden, Kh misread', {
      seats: [
        { name: 'You', stack: 970, bet: 0, cards: ['Qh', 'Qc'], hero: true },
        { name: 'Riley', stack: 970, bet: 0, cards: hidden },
      ],
      board: ['7s', '8d', '2c', 'Kh', '3d'], pot: 70, blinds: [5, 10], streetLabel: 'River',
    }, r => {
      r.board[3] = { card: 'Kd', confidence: 'low' };
      r.issues.push('Folded players are hidden by this client.');
    }),
    fixture('demo-5', 'Showdown', {
      seats: [
        { name: 'You', stack: 1090, bet: 0, cards: ['Qh', 'Qc'], hero: true },
        { name: 'Riley', stack: 920, bet: 0, cards: ['As', '9s'] },
        { name: 'Sam', stack: 990, bet: 0, cards: [], folded: true, dealer: true },
      ],
      board: ['7s', '8d', '2c', 'Kh', '3d'], pot: 0, blinds: [5, 10], streetLabel: 'River',
    }),
  ],
};

/** Flop actions between demo frames 2 and 3 (index 1), by seat in frame 2: You, Riley, Sam. */
export const DEMO_CONFIRMED_ACTIONS = {
  intervalIndex: 1,
  actions: [
    { seat: 0, type: 'check' as const },
    { seat: 1, type: 'bet' as const, to: 20 },
    { seat: 2, type: 'fold' as const },
    { seat: 0, type: 'call' as const },
  ],
};
