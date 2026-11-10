// Temporal consistency: can two neighbouring frames belong to one hand, and
// how completely is the change between them known? Pure classification of
// what the comparison, identity, and reconstruction modules found. Missing
// information is never treated as a contradiction.
import type { Consistency, IdentityIssue, IntervalStatus, PossibleTransition, StateDifference } from './types.js';

export const CONSISTENCY_LABELS: Record<Consistency, string> = {
  consistent: 'Consistent',
  'consistent-missing': 'Consistent, with missing information',
  ambiguous: 'Ambiguous',
  contradictory: 'Contradictory',
  split: 'Separate hands',
};

const ORDER_KINDS = new Set<StateDifference['kind']>(['board-shrank', 'street-reversed']);
const MISSING_KINDS = new Set<StateDifference['kind']>(['value-hidden', 'board-card-hidden', 'hole-cards-hidden', 'player-hidden']);

export interface IntervalEvidence {
  readonly status: IntervalStatus;
  readonly differences: readonly StateDifference[];
  readonly contradictions: readonly { readonly text: string }[];
  readonly possible: readonly PossibleTransition[];
  /** `null` when the chips in the middle are unknown on either side. */
  readonly middleChange: number | null;
  /** Identity issues in the later frame. */
  readonly identityIssues: readonly IdentityIssue[];
}

/**
 * Contradictory: something that cannot happen within one hand, until fixed or
 * split. Ambiguous: chips moved or a seat is unplaced, and several histories
 * fit. Consistent with missing information: nothing contradicts, but some
 * values or players were not visible. Consistent: every visible change is
 * known and explained.
 */
export function classifyInterval(e: IntervalEvidence): { consistency: Consistency; reasons: string[] } {
  if (e.status === 'different-hands') return { consistency: 'split', reasons: ['You marked these frames as different hands.'] };
  if (e.contradictions.length) {
    const reasons = e.contradictions.map(c => c.text);
    if (e.differences.some(d => ORDER_KINDS.has(d.kind))) reasons.push('The frames may be out of order: try swapping them.');
    return { consistency: 'contradictory', reasons };
  }
  const reasons: string[] = [];
  if (e.status === 'unresolved' || e.status === 'partial' || e.status === 'acknowledged') {
    reasons.push(...e.possible.map(p => p.text));
    if (e.status === 'acknowledged') reasons.push('You left the actions unresolved.');
  }
  for (const issue of e.identityIssues) if (issue.kind !== 'missing') reasons.push(issue.text);
  for (const d of e.differences) if (d.kind === 'player-unmatched' || d.kind === 'player-appeared') reasons.push(d.label);
  if (reasons.length) return { consistency: 'ambiguous', reasons: [...new Set(reasons)] };

  const missing: string[] = [];
  for (const d of e.differences) if (MISSING_KINDS.has(d.kind)) missing.push(d.label);
  for (const issue of e.identityIssues) if (issue.kind === 'missing') missing.push(issue.text);
  if (e.middleChange === null) missing.push('The chips in the middle are not fully known in both frames.');
  if (missing.length) return { consistency: 'consistent-missing', reasons: [...new Set(missing)] };
  return { consistency: 'consistent', reasons: [] };
}

const RANK: Record<Consistency, number> = { consistent: 0, split: 0, 'consistent-missing': 1, ambiguous: 2, contradictory: 3 };

/** The least certain classification across a sequence. */
export function worstConsistency(values: readonly Consistency[]): Consistency {
  return values.reduce<Consistency>((worst, c) => (RANK[c] > RANK[worst] ? c : worst), 'consistent');
}
