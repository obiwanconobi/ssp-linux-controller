// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBlockPreset } from '../lib/blockPresets';

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

  it('batch-deletes preset and capture slots without shifting indices', async () => {
    const before = useAppStore.getState();
    const favoriteName = before.preset.favorites[0];
    const favoriteIndex = before.preset.names.indexOf(favoriteName);
    const currentIndex = before.preset.index;
    const presetIndices = [...new Set([favoriteIndex, currentIndex])].sort((a, b) => a - b);
    const presetNames = presetIndices.map((index) => before.preset.names[index]);
    expect(favoriteIndex).toBeGreaterThanOrEqual(0);
    expect(before.preset.names[currentIndex]).toBeTruthy();

    await useAppStore.getState().deletePresets(presetIndices);

    const afterPresets = useAppStore.getState();
    for (const index of presetIndices) {
      expect(afterPresets.preset.names[index]).toBe('');
    }
    expect(afterPresets.preset.names).toHaveLength(before.preset.names.length);
    expect(afterPresets.preset.current).toBe('');
    expect(afterPresets.preset.favorites).not.toContain(presetNames[0]);
    expect(afterPresets.preset.recent).not.toContain(presetNames[0]);

    const list = afterPresets.lists.find((item) => item.id === 'nam_amp')!;
    const usedIndices = list.slots
      .filter((slot) => slot.used)
      .map((slot) => slot.index)
      .slice(0, 2);
    expect(usedIndices.length).toBeGreaterThan(0);

    await useAppStore.getState().deleteCaptures('nam_amp', usedIndices);

    const final = useAppStore.getState().lists.find((item) => item.id === 'nam_amp')!;
    for (const index of usedIndices) {
      expect(final.slots[index].name).toBe('');
      expect(final.slots[index].used).toBe(false);
      expect(final.slots[index].active).toBe(false);
    }
    expect(final.slots).toHaveLength(list.slots.length);
    expect(final.slots.map((slot) => slot.index)).toEqual(list.slots.map((slot) => slot.index));
    expect(final.activeSlot).toBeUndefined();
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

  it('applies a block preset as one undoable edit', () => {
    const before = useAppStore.getState();
    const drive = before.blocks.find((block) => block.id === 'drive')!;
    const preset = captureBlockPreset(drive, 'Clean drive');
    const originalGain = drive.controls.find((control) => control.id === 'drive.gain')!.value;

    before.setControl('drive.gain', 9.5);
    expect(
      useAppStore.getState().blocks.find((block) => block.id === 'drive')!
        .controls.find((control) => control.id === 'drive.gain')!.value,
    ).toBe(9.5);
    const undoBeforeApply = useAppStore.getState().undoStack.length;

    useAppStore.getState().applyBlockPreset('drive', preset);

    const after = useAppStore.getState();
    expect(
      after.blocks.find((block) => block.id === 'drive')!
        .controls.find((control) => control.id === 'drive.gain')!.value,
    ).toBe(originalGain);
    expect(after.undoStack).toHaveLength(undoBeforeApply + 1);
    expect(after.save.edited).toBe(true);
    expect(after.toast?.tone).toBe('good');
  });

  it('falls back to the first model and flags a preset with no model', () => {
    const before = useAppStore.getState();
    const drive = before.blocks.find((block) => block.id === 'drive')!;
    const options = drive.modelOptions!;
    before.setBlockModel('drive', options[1]);
    const preset = captureBlockPreset(
      useAppStore.getState().blocks.find((block) => block.id === 'drive')!,
      'No model',
    );
    delete preset.values['drive.model'];

    useAppStore.getState().applyBlockPreset('drive', preset);

    const after = useAppStore.getState();
    expect(after.blocks.find((block) => block.id === 'drive')!.model).toBe(options[0]);
    expect(after.toast?.tone).toBe('warn');
    expect(after.toast?.message).toContain('has no model');
  });

  it('adds a VXAMP block with the VXAMP family heading', () => {
    const before = useAppStore.getState();
    const available = before.availableBlocks.find((block) => block.id === 'vxamp');
    expect(available).toBeTruthy();

    before.addBlock('vxamp');

    const added = useAppStore
      .getState()
      .blocks.find((block) => block.id.startsWith('vxamp-'));
    expect(added).toBeTruthy();
    expect(added?.family).toBe('vxamp');
    expect(added?.shortName).toBe('VXAMP');
    expect(added?.label).toBe('VXAMP');
  });

  it('queues a VXAMP upload to the VXAMP list', () => {
    const before = useAppStore.getState();
    expect(before.lists.some((list) => list.id === 'vxamp_list')).toBe(true);

    const started = before.addUpload({
      name: 'Legacy.vxamp',
      size: 1024,
      kind: 'vxamp',
      target: 'vxamp_list',
      slot: 0,
    });

    expect(started).toBe(true);
    const upload = useAppStore.getState().uploads[0];
    expect(upload.kind).toBe('vxamp');
    expect(upload.target).toBe('VXAMP models');
    expect(upload.slot).toBe(0);
  });

  it('flags a preset saved with a different block type', () => {
    const before = useAppStore.getState();
    const drive = before.blocks.find((block) => block.id === 'drive')!;
    const preset = captureBlockPreset(drive, 'PNAM drive');
    preset.values['drive.type'] = 'Parametric NAM';
    const gainBefore = drive.controls.find((control) => control.id === 'drive.gain')!.value;

    before.applyBlockPreset('drive', preset);

    const after = useAppStore.getState();
    const nextDrive = after.blocks.find((block) => block.id === 'drive')!;
    expect(nextDrive.controls.find((control) => control.id === 'drive.type')?.value).toBe(
      'NAM',
    );
    expect(nextDrive.controls.find((control) => control.id === 'drive.gain')?.value).toBe(
      gainBefore,
    );
    expect(after.toast?.tone).toBe('warn');
    expect(after.toast?.message).toContain('different block type');
  });
});
