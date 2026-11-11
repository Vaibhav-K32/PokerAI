// The user's chip values for their own game, kept in this browser and shared
// by Scan table and Track hand. Nothing is assumed: the list starts empty.
import { EMPTY_CHIP_CONFIGURATION, parseChipConfig } from '../physical/chips.js';
import type { ChipConfiguration } from '../physical/types.js';

const KEY = 'poker-study:chip-config';

export function loadChipConfig(): ChipConfiguration {
  try {
    const text = localStorage.getItem(KEY);
    return text ? parseChipConfig(JSON.parse(text)) : EMPTY_CHIP_CONFIGURATION;
  } catch {
    return EMPTY_CHIP_CONFIGURATION;
  }
}

/** Save; returns a readable error when storage refuses. Invalid configurations are not saved. */
export function saveChipConfig(config: ChipConfiguration): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
    return null;
  } catch {
    return 'This browser is blocking storage, so the chip values are kept only until you leave.';
  }
}
