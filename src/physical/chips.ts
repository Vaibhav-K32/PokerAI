// Chip values for a simulated game. Colours have no universal value, so the
// user sets a ChipConfiguration; a group's value is known only when its count
// and its colour's value are both known. Unknown is never treated as zero.
import type { ChipConfiguration, ChipCountStatus, ChipGroup } from './types.js';

/** No colours are assumed: values come from the user (or a demo's own setup). */
export const EMPTY_CHIP_CONFIGURATION: ChipConfiguration = { denominations: [] };
export const MAX_DENOMINATION = 1_000_000;

export interface ChipValue {
  readonly value: number | null;
  /** Confirmed only when every group was counted clearly or set by the user. */
  readonly status: ChipCountStatus;
  readonly reasons: readonly string[];
}

const key = (s: string) => s.trim().toLowerCase();

export function denominationOf(config: ChipConfiguration, color: string | null): number | null {
  if (!color) return null;
  return config.denominations.find(d => key(d.colorLabel) === key(color))?.value ?? null;
}

export function groupValue(group: ChipGroup, config: ChipConfiguration): ChipValue {
  if (group.count === null || group.countStatus === 'unknown') return { value: null, status: 'unknown', reasons: ['A chip count is unknown.'] };
  const each = denominationOf(config, group.color);
  if (each === null) {
    return { value: null, status: 'unknown', reasons: [group.color ? 'No value is set for ' + group.color + ' chips.' : 'A chip group has no colour.'] };
  }
  return { value: group.count * each, status: group.countStatus, reasons: group.countStatus === 'estimated' ? ['A chip count is estimated.'] : [] };
}

/** The total of several groups; unknown if there are none or any part is unknown. */
export function sumGroups(groups: readonly ChipGroup[], config: ChipConfiguration): ChipValue {
  if (!groups.length) return { value: null, status: 'unknown', reasons: ['No chips were found here.'] };
  let total = 0;
  let status: ChipCountStatus = 'confirmed';
  const reasons: string[] = [];
  for (const g of groups) {
    const v = groupValue(g, config);
    reasons.push(...v.reasons);
    if (v.value === null) return { value: null, status: 'unknown', reasons: [...new Set(reasons)] };
    total += v.value;
    if (v.status === 'estimated') status = 'estimated';
  }
  return { value: total, status, reasons: [...new Set(reasons)] };
}

/** Problems with a configuration: empty or duplicate colours, and values that are not positive whole numbers. */
export function chipConfigProblems(config: ChipConfiguration): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  config.denominations.forEach((d, i) => {
    const label = d.colorLabel.trim();
    if (!label) problems.push('Chip colour ' + (i + 1) + ' needs a name.');
    else if (seen.has(key(label))) problems.push('“' + label + '” is listed twice.');
    seen.add(key(label));
    if (!Number.isSafeInteger(d.value) || d.value <= 0 || d.value > MAX_DENOMINATION) problems.push('The value for “' + (label || 'colour ' + (i + 1)) + '” must be a whole number from 1 to ' + MAX_DENOMINATION.toLocaleString('en-US') + '.');
  });
  return problems;
}

/** Validate a saved configuration; throws on anything malformed. */
export function parseChipConfig(raw: unknown): ChipConfiguration {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { denominations?: unknown }).denominations)) throw new Error('A chip configuration needs a list of denominations.');
  const list = (raw as { denominations: unknown[] }).denominations;
  if (list.length > 20) throw new Error('At most 20 chip colours are supported.');
  const config = {
    denominations: list.map(d => {
      if (typeof d !== 'object' || d === null || typeof (d as { colorLabel?: unknown }).colorLabel !== 'string') throw new Error('Each chip colour needs a name.');
      return { colorLabel: (d as { colorLabel: string }).colorLabel.slice(0, 30), value: (d as { value: number }).value };
    }),
  };
  const problems = chipConfigProblems(config);
  if (problems.length) throw new Error(problems[0]);
  return config;
}
