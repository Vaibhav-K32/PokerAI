import type { Card } from './types.js';

export const ranks = '23456789TJQKA';
export const standardDeck = Object.freeze(
  [...ranks].flatMap(rank => [...'cdhs'].map(suit => rank + suit)),
);

export function parseCards(text: string): Card[] {
  const clean = text.trim();
  return clean ? clean.split(/[\s,]+/).map(token =>
    token.toUpperCase().replace(/^10/, 'T').replace(/[CDHS]$/, suit => suit.toLowerCase()),
  ) : [];
}

export function* combinations<T>(items: readonly T[], count: number, start = 0, prefix: T[] = []): Generator<T[]> {
  if (count === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= items.length - count; i++) {
    yield* combinations(items, count - 1, i + 1, [...prefix, items[i]]);
  }
}

export function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
