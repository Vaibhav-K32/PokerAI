// Stored hand histories: building, JSON round trips, runtime validation, and
// schema migration. Pure TypeScript; storage lives in the web layer.
import { applyHandEvent, buildPots, createHandState, potWinners, replayHand, splitPot } from './engine.js';
import {
  HAND_SCHEMA_VERSION, HandRuleError,
  type GameState, type HandEvent, type HandEventPayloads, type HandEventType, type HandSetup,
} from './types.js';

export const HISTORY_KIND = 'poker-study/hand-history';

export interface HandResult {
  readonly status: 'complete' | 'cancelled' | 'in-progress';
  readonly board: readonly string[];
  /** Each pot with who could win it and who did. */
  readonly pots: GameState['pots'];
  /** Net chips won by each player: final stack minus starting stack. */
  readonly net: readonly { readonly playerId: string; readonly amount: number }[];
  /** Players who received chips from a pot. */
  readonly winners: readonly string[];
}

export interface HandHistory {
  readonly kind: typeof HISTORY_KIND;
  readonly schemaVersion: typeof HAND_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly playerCount: number;
  /** Dealer seat, blinds, ante, players with starting stacks and known cards. */
  readonly setup: HandSetup;
  readonly events: readonly HandEvent[];
  readonly result: HandResult;
  readonly finalState: GameState;
}

export function summarize(state: GameState): HandResult {
  return {
    status: state.step === 'complete' ? 'complete' : state.step === 'cancelled' ? 'cancelled' : 'in-progress',
    board: [...state.board],
    pots: state.pots,
    net: state.players.map(p => ({ playerId: p.id, amount: p.stack - p.startingStack })),
    winners: [...new Set(state.pots.flatMap(p => (p.awards ?? []).filter(a => a.amount > 0).map(a => a.playerId)))],
  };
}

/** Replay the events and package a history. Throws when any event is illegal. */
export function createHistory(
  setup: HandSetup,
  events: readonly HandEvent[],
  meta: { name?: string; createdAt?: string } = {},
): HandHistory {
  const finalState = replayHand(createHandState(setup), events);
  return {
    kind: HISTORY_KIND,
    schemaVersion: HAND_SCHEMA_VERSION,
    id: setup.handId,
    name: meta.name ?? 'Hand ' + setup.handId,
    createdAt: meta.createdAt ?? events[0]?.timestamp ?? new Date(0).toISOString(),
    playerCount: setup.players.length,
    setup,
    events: [...events],
    result: summarize(finalState),
    finalState,
  };
}

export function serializeHistory(history: HandHistory): string {
  return JSON.stringify(history, null, 2);
}

// ---------------------------------------------------------------------------
// Parsing and migration
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Upgrades from older schema versions, keyed by the version they upgrade
 * from. Version 1 is the first published format, so there is nothing to do
 * yet; add `1: raw => ({ ...raw, schemaVersion: 2, ... })` when version 2
 * ships, and migrate events alongside the history.
 */
const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {};

export function migrateHistory(raw: Raw): Raw {
  let current = raw;
  let version = current.schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new HandRuleError('This file has no valid schema version.');
  while ((version as number) < HAND_SCHEMA_VERSION) {
    const step = MIGRATIONS[version as number];
    if (!step) throw new HandRuleError('Cannot upgrade a hand history from schema version ' + version + '.');
    current = step(current);
    version = current.schemaVersion;
  }
  if ((version as number) > HAND_SCHEMA_VERSION) {
    throw new HandRuleError('This hand history uses a newer schema (version ' + version + '). Update the app to open it.');
  }
  return current;
}

/**
 * Parse and validate a history from JSON text or a parsed value. Replays every
 * event, and rejects the file when its stored final state or result does not
 * match the replay. Returns a history whose final state comes from the replay.
 */
export function parseHistory(input: unknown): HandHistory {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new HandRuleError('This file is not valid JSON.');
    }
  }
  if (!isRecord(raw) || raw.kind !== HISTORY_KIND) throw new HandRuleError('This is not a Poker Study hand history.');
  const data = migrateHistory(raw);
  const { setup, events } = data;
  if (typeof data.name !== 'string' || !data.name.trim()) throw new HandRuleError('The hand history needs a name.');
  if (typeof data.createdAt !== 'string' || Number.isNaN(Date.parse(data.createdAt))) throw new HandRuleError('The hand history needs a creation time.');
  if (!isRecord(setup) || !Array.isArray(setup.players)) throw new HandRuleError('The hand history needs a setup with players.');
  if (data.id !== setup.handId) throw new HandRuleError('The hand ID does not match its setup.');
  if (data.playerCount !== setup.players.length) throw new HandRuleError('The player count does not match the setup.');
  if (!Array.isArray(events)) throw new HandRuleError('The hand history needs an event list.');

  const history = createHistory(setup as unknown as HandSetup, events as HandEvent[], { name: data.name, createdAt: data.createdAt });
  if (data.finalState !== undefined && JSON.stringify(data.finalState) !== JSON.stringify(history.finalState)) {
    throw new HandRuleError('The recorded final state does not match a replay of the events.');
  }
  if (data.result !== undefined && JSON.stringify(data.result) !== JSON.stringify(history.result)) {
    throw new HandRuleError('The recorded result does not match a replay of the events.');
  }
  return history;
}

// ---------------------------------------------------------------------------
// Building events
// ---------------------------------------------------------------------------

export type EventSpec = { [T in HandEventType]: [T, HandEventPayloads[T]] }[HandEventType];

/**
 * Make events with sequential IDs (`<handId>-e1`, … or `<idPrefix>1`, …) and
 * timestamps `step` seconds apart, for fixtures, demos, and manual recording.
 */
export function eventFactory(handId: string, start = '2026-01-01T12:00:00.000Z', stepSeconds = 5, idPrefix = handId + '-e') {
  let n = 0;
  const base = Date.parse(start);
  return <T extends HandEventType>(type: T, payload: HandEventPayloads[T]): HandEvent => {
    n++;
    return {
      schemaVersion: HAND_SCHEMA_VERSION, id: idPrefix + n, type, handId,
      timestamp: new Date(base + (n - 1) * stepSeconds * 1000).toISOString(), payload,
    } as HandEvent;
  };
}

/** Build events from compact specs, checking each against the rules as it goes. */
export function buildEvents(setup: HandSetup, specs: readonly EventSpec[], make = eventFactory(setup.handId)): HandEvent[] {
  let state = createHandState(setup);
  const events: HandEvent[] = [];
  for (const [type, payload] of specs) {
    const event = make(type, payload as never);
    state = applyHandEvent(state, event);
    events.push(event);
  }
  return events;
}

/**
 * The events that finish a hand whose betting is over: showdown, reveals of
 * known live hands, one award per pot, and completion. Needs every contested
 * hand known; returns the specs to append.
 */
export function settlementSpecs(state: GameState): EventSpec[] {
  const specs: EventSpec[] = [];
  let pots = state.pots;
  if (state.step === 'showdown') {
    specs.push(['SHOWDOWN_STARTED', {}]);
    pots = buildPots(state);
    for (const p of state.players) {
      if (p.status !== 'folded' && p.cards.every(c => c !== null)) specs.push(['PLAYER_CARDS_REVEALED', { playerId: p.id, cards: [...p.cards] as string[] }]);
    }
  } else if (state.step !== 'award' && state.step !== 'reveal') {
    throw new HandRuleError('Betting is not over yet.');
  }
  pots.forEach((pot, potIndex) => {
    if (pot.awards) return;
    const winners = potWinners({ ...state, pots }, pot);
    if (!winners) throw new HandRuleError('Pot ' + potIndex + ' needs known hands to settle automatically.');
    specs.push(['POT_AWARDED', { potIndex, awards: splitPot(state, pot.amount, winners) }]);
  });
  specs.push(['HAND_COMPLETED', {}]);
  return specs;
}
