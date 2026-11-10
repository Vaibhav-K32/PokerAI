// Adapter from a replayed hand state to the analyzer's decision snapshot, so
// recorded histories and manual snapshots share one analysis path.
import type { Card, Snapshot } from '../core/types.js';
import { holdem } from '../rules/holdem.js';
import { potTotal } from './engine.js';
import { HandRuleError, type GameState } from './types.js';

/**
 * The decision facing the player to act, as an analyzer snapshot. Needs the
 * actor's hole cards and two to four players still in the hand. Opponents'
 * cards are included only when both are known; a player all-in on an earlier
 * street gets the part of the earlier pot they can win.
 */
export function toAnalysisSnapshot(state: GameState, purpose: Snapshot['purpose'] = 'completed'): Snapshot {
  if (state.step !== 'act' || state.actor === null) throw new HandRuleError('There is no decision to analyze at this point.');
  const hero = state.players[state.actor];
  if (hero.cards.some(c => c === null)) throw new HandRuleError(hero.name + '’s cards are unknown, so this decision cannot be analyzed.');
  const others = state.players.filter(p => p.id !== hero.id && p.status !== 'folded');
  if (others.length < 1 || others.length > 3) throw new HandRuleError('Analysis supports two to four players still in the hand.');

  const earlier = (p: GameState['players'][number]) => p.total - p.committed;
  const snapshot: Snapshot = {
    version: 2,
    ruleset: holdem.id,
    purpose,
    hero: [...hero.cards] as Card[],
    board: [...state.board],
    opponents: others.map(o => {
      const seat = {
        stack: o.stack,
        committed: o.committed,
        cards: o.cards.every(c => c !== null) ? [...o.cards] as Card[] : [],
      };
      if (o.stack === 0 && o.committed === 0) {
        // All-in earlier: they can win each player's earlier chips up to their own total.
        const eligiblePot = state.players.reduce((sum, p) => sum + Math.min(earlier(p), o.total), 0);
        return { ...seat, eligiblePot };
      }
      return seat;
    }),
    pot: potTotal(state),
    heroStack: hero.stack,
    committed: hero.committed,
    increment: state.currentBet === 0 ? state.bigBlind : state.lastFullRaise,
  };
  holdem.validate(snapshot);
  return snapshot;
}
