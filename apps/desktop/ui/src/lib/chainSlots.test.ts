import { describe, expect, it } from 'vitest';
import {
  adjacentEmptySlot,
  chainSlotId,
  compareChainSlots,
  parseChainSlotId,
  slotOf,
} from './chainSlots';
import type { Block } from '../types';

const block = (
  id: string,
  row: number,
  col: number,
  fixed = false,
): Block => ({
  id,
  label: id,
  shortName: id.toUpperCase(),
  family: 'utility',
  on: true,
  fixed,
  link: 'series',
  controls: [],
  groups: [],
  footswitch: 1,
  slotRow: row,
  slotCol: col,
});

describe('chain slot helpers', () => {
  it('round-trips slot ids and orders rows before columns', () => {
    const slot = { row: 1, col: 14 };
    expect(parseChainSlotId(chainSlotId(slot))).toEqual(slot);
    expect(parseChainSlotId('root\\app\\gate')).toBeNull();
    expect(compareChainSlots({ row: 0, col: 20 }, { row: 1, col: 0 })).toBeLessThan(0);
    expect(compareChainSlots({ row: 0, col: 20 }, { row: 0, col: 4 })).toBeGreaterThan(0);
  });

  it('inserts after a fixed target instead of swapping across it', () => {
    const cab = block('cab', 0, 0);
    const amp = block('amp', 0, 12, true);
    const empties = [
      { row: 0, col: 2 },
      { row: 0, col: 14 },
      { row: 0, col: 16 },
    ];

    expect(adjacentEmptySlot(cab, amp, [cab, amp], empties)).toEqual({ row: 0, col: 14 });
  });

  it('inserts before a target when dragging backwards', () => {
    const cab = block('cab', 0, 14);
    const gate = block('gate', 0, 4);
    const empties = [
      { row: 0, col: 0 },
      { row: 0, col: 2 },
      { row: 0, col: 18 },
    ];

    expect(adjacentEmptySlot(cab, gate, [cab, gate], empties)).toEqual({ row: 0, col: 2 });
  });

  it('stops at the next occupied block', () => {
    const drive = block('drive', 0, 0);
    const comp = block('comp', 0, 4);
    const delay = block('delay', 0, 8);
    const empties = [
      { row: 0, col: 2 },
      { row: 0, col: 6 },
      { row: 0, col: 10 },
    ];

    expect(adjacentEmptySlot(drive, comp, [drive, comp, delay], empties)).toEqual({
      row: 0,
      col: 6,
    });
    expect(adjacentEmptySlot(comp, delay, [drive, comp, delay], empties)).toEqual({
      row: 0,
      col: 10,
    });
  });

  it('returns null when there is no adjacent gap', () => {
    const drive = block('drive', 0, 0);
    const comp = block('comp', 0, 2);
    const amp = block('amp', 0, 4);
    const noSlot = { ...block('no-slot', 0, 0), slotRow: undefined, slotCol: undefined };

    expect(adjacentEmptySlot(drive, comp, [drive, comp, amp], [])).toBeNull();
    expect(slotOf(drive)).toEqual({ row: 0, col: 0 });
    expect(slotOf(noSlot)).toBeNull();
  });
});
