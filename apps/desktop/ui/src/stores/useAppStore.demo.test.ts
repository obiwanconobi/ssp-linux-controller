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
