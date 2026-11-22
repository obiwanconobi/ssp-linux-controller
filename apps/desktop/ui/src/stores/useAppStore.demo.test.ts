// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc/client', () => ({
  tauriClient: {
    disconnect: vi.fn(async () => undefined),
  },
  isTauriRuntime: () => false,
  ipcErrorMessage: (error: unknown) => String(error),
  coalesce: (_key: string, call: () => Promise<unknown>) => {
    void call();
  },
  flushCoalesced: async () => undefined,
}));

const { useAppStore } = await import('./useAppStore');

describe('demo chain editing', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it('selects a surviving neighbour when the selected block is removed', () => {
    const before = useAppStore.getState();
    const driveIndex = before.blocks.findIndex((block) => block.id === 'drive');
    expect(before.selectedBlockId).toBe('drive');

    before.removeBlock('drive');

    const after = useAppStore.getState();
    expect(after.blocks.some((block) => block.id === 'drive')).toBe(false);
    expect(after.blocks).toHaveLength(before.blocks.length - 1);
    expect(after.selectedBlockId).toBe(before.blocks[driveIndex + 1].id);
    expect(after.availableBlocks.some((block) => block.id === 'drive')).toBe(true);
  });

  it('clears every movable block and preserves fixed slots', () => {
    const before = useAppStore.getState();
    const fixed = before.blocks.filter((block) => block.fixed);
    const movable = before.blocks.filter((block) => !block.fixed);
    expect(movable.length).toBeGreaterThan(0);

    before.clearChain();

    const after = useAppStore.getState();
    expect(after.blocks.map((block) => block.id)).toEqual(fixed.map((block) => block.id));
    expect(after.blocks.every((block) => block.fixed)).toBe(true);
    for (const block of movable) {
      expect(after.availableBlocks.some((available) => available.id === block.id)).toBe(true);
    }
    expect(after.save.edited).toBe(true);
    expect(after.undoStack.length).toBe(before.undoStack.length + 1);
  });

  it('deletes preset and capture slots without shifting indices', () => {
    const before = useAppStore.getState();
    const presetIndex = before.preset.names.findIndex((name) => name.trim());
    const presetName = before.preset.names[presetIndex];
    expect(presetName).toBeTruthy();

    before.deletePreset(presetIndex);

    const after = useAppStore.getState();
    expect(after.preset.names[presetIndex]).toBe('');
    expect(after.preset.names).toHaveLength(before.preset.names.length);
    expect(after.preset.favorites).not.toContain(presetName);
    expect(after.preset.recent).not.toContain(presetName);

    const list = after.lists.find((item) => item.id === 'nam_amp')!;
    const slot = list.slots.find((entry) => entry.used)!;
    const slotName = slot.name;
    useAppStore.getState().deleteCapture('nam_amp', slot.index);

    const final = useAppStore.getState().lists.find((item) => item.id === 'nam_amp')!;
    expect(final.slots[slot.index].name).toBe('');
    expect(final.slots[slot.index].used).toBe(false);
    expect(final.slots).toHaveLength(list.slots.length);
    expect(slotName).toBeTruthy();
  });

  it('swaps a block with an available one in place', () => {
    const before = useAppStore.getState();
    const gateIndex = before.blocks.findIndex((block) => block.id === 'gate');
    const chorus = before.availableBlocks.find((block) => block.id === 'chorus');
    expect(chorus).toBeTruthy();

    before.selectBlock('gate');
    before.replaceBlock('gate', 'chorus');

    const after = useAppStore.getState();
    expect(after.blocks).toHaveLength(before.blocks.length);
    expect(after.blocks[gateIndex].label).toBe('Chorus');
    expect(after.blocks.some((block) => block.id === 'gate')).toBe(false);
    expect(after.selectedBlockId).toBe(after.blocks[gateIndex].id);
    expect(after.availableBlocks.some((block) => block.id === 'gate')).toBe(true);
    expect(after.availableBlocks.some((block) => block.id === 'chorus')).toBe(false);
  });
});
