import { holdem } from '../rules/holdem.js';
import type { Ruleset } from './types.js';

const rulesets: ReadonlyMap<string, Ruleset> = new Map([[holdem.id, holdem]]);

export function getRuleset(id: string): Ruleset {
  const ruleset = rulesets.get(id);
  if (!ruleset) throw new Error('Unsupported ruleset.');
  return ruleset;
}
