// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_BLOCKS, cloneBlocks } from '../data/demoDevice';
import { captureBlockPreset } from './blockPresets';

vi.mock('../ipc/client', () => ({
  isTauriRuntime: () => false,
  tauriClient: {},
}));

const {
  deleteBlockPreset,
  listBlockPresets,
  saveBlockPreset,
} = await import('./blockPresetStorage');

const drivePreset = (name: string) =>
  captureBlockPreset(
    cloneBlocks(INITIAL_BLOCKS).find((block) => block.id === 'drive')!,
    name,
  );

describe('block preset browser storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('saves, lists, overwrites case-insensitively, and deletes presets', async () => {
    await saveBlockPreset(drivePreset('Klone Lead'));
    const second = drivePreset('Bright Lead');
    second.values['drive.gain'] = 9;
    await saveBlockPreset(second);

    expect((await listBlockPresets('drive')).map((preset) => preset.name)).toEqual([
      'Bright Lead',
      'Klone Lead',
    ]);

    const overwritten = drivePreset('KLONE LEAD');
    overwritten.values['drive.gain'] = 1.5;
    await saveBlockPreset(overwritten);

    const presets = await listBlockPresets('drive');
    expect(presets).toHaveLength(2);
    expect(
      presets.find((preset) => preset.name === 'KLONE LEAD')?.values['drive.gain'],
    ).toBe(1.5);

    expect(await deleteBlockPreset('drive', 'klone lead')).toBe(true);
    expect((await listBlockPresets('drive')).map((preset) => preset.name)).toEqual([
      'Bright Lead',
    ]);
    expect(await deleteBlockPreset('drive', 'missing')).toBe(false);
  });
});
