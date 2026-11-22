import type { Block } from '../types';

export interface ChainSlotRef {
  row: number;
  col: number;
}

export const compareChainSlots = (left: ChainSlotRef, right: ChainSlotRef): number =>
  left.row - right.row || left.col - right.col;

export const chainSlotId = (slot: ChainSlotRef): string => `slot:${slot.row}:${slot.col}`;

const SLOT_ID = /^slot:(\d+):(\d+)$/;

export const parseChainSlotId = (id: string): ChainSlotRef | null => {
  const match = SLOT_ID.exec(id);
  if (!match) return null;
  return { row: Number(match[1]), col: Number(match[2]) };
};

export const slotOf = (block: Block): ChainSlotRef | null =>
  block.slotRow == null || block.slotCol == null
    ? null
    : { row: block.slotRow, col: block.slotCol };

/**
 * Resolve a drop on an occupied block to the empty slot immediately after (or
 * before) that block in the direction of the drag. This inserts the dragged
 * block beside the target instead of swapping the two, so the target does not
 * jump back to the drag source's old position.
 */
export const adjacentEmptySlot = (
  moving: Block,
  target: Block,
  blocks: Block[],
  emptySlots: ChainSlotRef[],
): ChainSlotRef | null => {
  const from = slotOf(moving);
  const to = slotOf(target);
  if (!from || !to) return null;

  const occupied = blocks
    .filter((block) => block.id !== moving.id)
    .map(slotOf)
    .filter((slot): slot is ChainSlotRef => slot != null)
    .sort(compareChainSlots);
  const empties = [...emptySlots].sort(compareChainSlots);

  if (compareChainSlots(from, to) < 0) {
    const next = occupied.find((slot) => compareChainSlots(slot, to) > 0);
    return (
      empties.find(
        (slot) =>
          compareChainSlots(slot, to) > 0 &&
          (!next || compareChainSlots(slot, next) < 0),
      ) ?? null
    );
  }

  const previous = occupied
    .filter((slot) => compareChainSlots(slot, to) < 0)
    .at(-1);
  return (
    empties
      .filter(
        (slot) =>
          compareChainSlots(slot, to) < 0 &&
          (!previous || compareChainSlots(slot, previous) > 0),
      )
      .at(-1) ?? null
  );
};
