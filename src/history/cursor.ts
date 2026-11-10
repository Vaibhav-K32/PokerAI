// Replay navigation over a recorded hand. Position 0 is before the first
// event; position N follows the N-th event. Pure, so controls are testable.

export type CursorMove = 'first' | 'previous' | 'next' | 'last' | number;

/** The new position after a move, clamped to [0, eventCount]. */
export function moveCursor(position: number, eventCount: number, move: CursorMove): number {
  const target = move === 'first' ? 0
    : move === 'previous' ? position - 1
      : move === 'next' ? position + 1
        : move === 'last' ? eventCount
          : Math.round(move);
  return Math.min(eventCount, Math.max(0, Number.isFinite(target) ? target : position));
}

/** Delay between steps during playback, in milliseconds, for a speed multiplier. */
export function playbackDelay(speed: number): number {
  const safe = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.round(1200 / safe);
}
