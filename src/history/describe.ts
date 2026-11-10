// Human-readable timeline lines for events. Pure; the UI adds structure.
import type { GameState, HandEvent, Street } from './types.js';

const suitSymbols: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const prettyCard = (card: string) => (card[0] === 'T' ? '10' : card[0]) + suitSymbols[card[1]];

export interface TimelineEntry {
  /** Section heading: a street, Showdown, or Result. */
  readonly section: Street | 'setup' | 'showdown' | 'result';
  readonly text: string;
}

/** Describe `event` using the state just before it. */
export function describeEvent(before: GameState, event: HandEvent): TimelineEntry {
  const name = (id: string) => before.players.find(p => p.id === id)?.name ?? id;
  const player = (id: string) => before.players.find(p => p.id === id);
  const street = before.street;
  switch (event.type) {
    case 'HAND_STARTED':
      return { section: 'setup', text: 'Hand starts · ' + before.players.length + ' players · blinds ' + before.smallBlind + '/' + before.bigBlind
        + (before.ante ? ' · ante ' + before.ante : '') + ' · ' + before.players[before.dealer].name + ' has the button' };
    case 'ANTE_POSTED':
      return { section: 'preflop', text: name(event.payload.playerId) + ' posts ante: ' + event.payload.amount };
    case 'SMALL_BLIND_POSTED':
      return { section: 'preflop', text: name(event.payload.playerId) + ' posts small blind: ' + event.payload.amount };
    case 'BIG_BLIND_POSTED':
      return { section: 'preflop', text: name(event.payload.playerId) + ' posts big blind: ' + event.payload.amount };
    case 'PLAYER_FOLDED':
      return { section: street, text: name(event.payload.playerId) + ' folds' };
    case 'PLAYER_CHECKED':
      return { section: street, text: name(event.payload.playerId) + ' checks' };
    case 'PLAYER_CALLED': {
      const p = player(event.payload.playerId);
      const allIn = p && event.payload.amount === p.stack;
      return { section: street, text: name(event.payload.playerId) + ' calls ' + event.payload.amount + (allIn ? ' and is all-in' : '') };
    }
    case 'PLAYER_BET': {
      const p = player(event.payload.playerId);
      const allIn = p && event.payload.to === p.committed + p.stack;
      return { section: street, text: name(event.payload.playerId) + ' bets ' + event.payload.to + (allIn ? ' and is all-in' : '') };
    }
    case 'PLAYER_RAISED': {
      const p = player(event.payload.playerId);
      const allIn = p && event.payload.to === p.committed + p.stack;
      return { section: street, text: name(event.payload.playerId) + ' raises to ' + event.payload.to + (allIn ? ' and is all-in' : '') };
    }
    case 'PLAYER_ALL_IN': {
      const p = player(event.payload.playerId);
      const to = (p?.committed ?? 0) + event.payload.amount;
      const verb = to <= before.currentBet ? 'calls ' + event.payload.amount : before.currentBet === 0 ? 'bets ' + to : 'raises to ' + to;
      return { section: street, text: name(event.payload.playerId) + ' ' + verb + ' and is all-in' };
    }
    case 'FLOP_DEALT':
      return { section: 'flop', text: 'Community cards: ' + event.payload.cards.map(prettyCard).join(' ') };
    case 'TURN_DEALT':
      return { section: 'turn', text: 'Turn: ' + prettyCard(event.payload.card) };
    case 'RIVER_DEALT':
      return { section: 'river', text: 'River: ' + prettyCard(event.payload.card) };
    case 'SHOWDOWN_STARTED':
      return { section: 'showdown', text: 'Showdown' };
    case 'PLAYER_CARDS_REVEALED':
      return { section: 'showdown', text: name(event.payload.playerId) + ' shows ' + event.payload.cards.map(prettyCard).join(' ') };
    case 'POT_AWARDED': {
      const potName = before.pots.length > 1 ? (event.payload.potIndex === 0 ? 'the main pot' : 'side pot ' + event.payload.potIndex) : 'the pot';
      const parts = event.payload.awards.map(a => name(a.playerId) + ' wins ' + a.amount);
      return { section: 'result', text: parts.join(' and ') + ' from ' + potName };
    }
    case 'HAND_COMPLETED':
      return { section: 'result', text: 'Hand complete' };
    case 'HAND_CANCELLED':
      return { section: 'result', text: 'Hand cancelled: ' + event.payload.reason + ' (all chips returned)' };
  }
}

export const sectionTitles: Record<TimelineEntry['section'], string> = {
  setup: 'Setup', preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown', result: 'Result',
};
