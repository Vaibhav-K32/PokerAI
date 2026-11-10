// Test helper: write heads-up fixtures in the compact legacy shape
// ({ opponent, opponentStack, faced }) and convert them to snapshot v2.
import { holdem } from '../dist/rules/holdem.js';

export function headsUp(s) {
  if (s.opponents) return s;
  const { opponent = [], opponentStack, faced = 0, version: _version, ruleset: _ruleset, ...rest } = s;
  return {
    ...rest,
    version: 2,
    ruleset: holdem.id,
    opponents: [{ stack: opponentStack, committed: rest.committed + faced, cards: opponent }],
  };
}
