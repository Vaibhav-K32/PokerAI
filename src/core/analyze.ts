import { calculateEquity } from './equity.js';
import { handOutlook } from './outlook.js';
import { getRuleset } from './registry.js';
import { betAdvice } from './sizing.js';
import type { Snapshot } from './types.js';

export function analyze(snapshot: Snapshot) {
  const ruleset = getRuleset(snapshot.ruleset);
  const equity = calculateEquity(snapshot, ruleset);
  return {
    equity,
    rank: ruleset.rank(snapshot.hero, snapshot.board),
    outlook: handOutlook(snapshot, ruleset),
    sizing: betAdvice(snapshot, ruleset),
    actions: ruleset.legalActions(snapshot),
    study: ruleset.study(snapshot, equity),
  };
}
