// Replay of a tracked hand. Two modes in one list: event steps for actions
// the user confirmed and the hand engine accepted (event replay through the
// immutable reducer's states), and checkpoint steps for observed frames.
// Gaps with unknown actions are explicit steps; nothing is invented to fill them.
import { moveCursor, type CursorMove } from '../history/cursor.js';
import { describeEvent } from '../history/describe.js';
import type { GameState } from '../history/types.js';
import type { ReconstructionResult } from './types.js';

export type ReplayStep =
  | { readonly kind: 'checkpoint'; readonly observationId: string; readonly checkpointIndex: number; readonly label: string }
  | { readonly kind: 'event'; readonly intervalIndex: number; readonly eventIndex: number; readonly state: GameState; readonly label: string }
  | { readonly kind: 'unresolved'; readonly intervalIndex: number; readonly label: string }
  | { readonly kind: 'split'; readonly intervalIndex: number; readonly label: string };

export const STEP_KIND_LABELS: Record<ReplayStep['kind'], string> = {
  checkpoint: 'Observed frame', event: 'Verified event', unresolved: 'Unresolved interval', split: 'New hand',
};

const OPEN = new Set(['unresolved', 'acknowledged', 'partial', 'contradiction']);

/**
 * Steps in order: each frame's checkpoint, then for the gap after it, the
 * verified events (if any) and an unresolved step when actions in the gap are
 * still unknown or contradictory.
 */
export function buildReplaySteps(result: ReconstructionResult): ReplayStep[] {
  const steps: ReplayStep[] = [];
  result.checkpoints.forEach((cp, i) => {
    steps.push({ kind: 'checkpoint', observationId: cp.observationId, checkpointIndex: i, label: 'Frame ' + (cp.index + 1) + (cp.street ? ' · ' + cp.street : '') });
    const interval = result.intervals[i];
    if (!interval) return;
    if (interval.status === 'different-hands') {
      steps.push({ kind: 'split', intervalIndex: i, label: 'The next frame starts a different hand.' });
      return;
    }
    const check = interval.actionCheck;
    if (check) {
      check.events.forEach((event, k) => {
        steps.push({ kind: 'event', intervalIndex: i, eventIndex: k, state: check.states[k + 1], label: describeEvent(check.states[k], event).text });
      });
    }
    if (OPEN.has(interval.status)) {
      steps.push({
        kind: 'unresolved', intervalIndex: i,
        label: interval.status === 'contradiction' ? 'Contradiction: ' + interval.summary
          : check?.events.length ? 'Still unknown after your actions: ' + interval.summary : interval.summary,
      });
    }
  });
  return steps;
}

/** Move along the steps with the same controls as hand replay. */
export const moveStep = (position: number, steps: readonly ReplayStep[], move: CursorMove) => moveCursor(position, Math.max(0, steps.length - 1), move);

/** The step showing a frame. */
export const checkpointStep = (steps: readonly ReplayStep[], observationId: string) =>
  steps.findIndex(s => s.kind === 'checkpoint' && s.observationId === observationId);
