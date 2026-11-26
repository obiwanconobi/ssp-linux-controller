import type { LibrarySlot } from '../types';

export type LibrarySlotStatus = 'active' | 'in-use' | 'loaded' | 'free';

/**
 * Four-state library status, in precedence order:
 * the live chain (ACTIVE) wins over saved preset references (IN USE),
 * which win over a capture merely being present (LOADED).
 */
export const librarySlotStatus = (
  slot: Pick<LibrarySlot, 'used' | 'active' | 'usedBy'>,
): LibrarySlotStatus => {
  if (!slot.used) return 'free';
  if (slot.active) return 'active';
  return slot.usedBy?.length ? 'in-use' : 'loaded';
};
