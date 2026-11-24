import { isTauriRuntime, tauriClient } from '../ipc/client';
import type { BlockPreset } from '../types';

const STORAGE_PREFIX = 'stomp.blockPresets.v1';

const storageKey = (blockKey: string): string => `${STORAGE_PREFIX}.${blockKey}`;

const isBlockPreset = (value: unknown): value is BlockPreset => {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<BlockPreset>;
  return (
    typeof preset.name === 'string' &&
    typeof preset.blockKey === 'string' &&
    typeof preset.savedAt === 'string' &&
    Boolean(preset.values) &&
    typeof preset.values === 'object'
  );
};

const normalizePreset = (preset: BlockPreset): BlockPreset => ({
  ...preset,
  values: Object.fromEntries(
    Object.entries(preset.values ?? {}).filter(([, value]) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean',
    ),
  ),
});

const sortPresets = (presets: BlockPreset[]): BlockPreset[] =>
  [...presets].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );

const readLocal = (blockKey: string): BlockPreset[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(blockKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortPresets(
      parsed
        .filter(
          (item): item is BlockPreset =>
            isBlockPreset(item) && item.blockKey === blockKey,
        )
        .map(normalizePreset),
    );
  } catch {
    return [];
  }
};

const writeLocal = (blockKey: string, presets: BlockPreset[]): void => {
  if (typeof window === 'undefined') {
    throw new Error('Local preset storage is unavailable');
  }
  try {
    window.localStorage.setItem(
      storageKey(blockKey),
      JSON.stringify(sortPresets(presets)),
    );
  } catch {
    throw new Error('Could not write the block preset to local storage');
  }
};

/** Presets live in files on desktop; the browser preview uses localStorage. */
export const listBlockPresets = async (blockKey: string): Promise<BlockPreset[]> => {
  if (isTauriRuntime()) {
    return sortPresets(
      (await tauriClient.listBlockPresets(blockKey)).map(normalizePreset),
    );
  }
  return readLocal(blockKey);
};

export const saveBlockPreset = async (preset: BlockPreset): Promise<BlockPreset> => {
  if (isTauriRuntime()) {
    return tauriClient.saveBlockPreset(preset);
  }
  const presets = readLocal(preset.blockKey);
  const existing = presets.findIndex(
    (item) => item.name.toLowerCase() === preset.name.toLowerCase(),
  );
  const next =
    existing >= 0
      ? presets.map((item, index) => (index === existing ? preset : item))
      : [...presets, preset];
  writeLocal(preset.blockKey, next);
  return preset;
};

export const deleteBlockPreset = async (
  blockKey: string,
  name: string,
): Promise<boolean> => {
  if (isTauriRuntime()) {
    return tauriClient.deleteBlockPreset(blockKey, name);
  }
  const presets = readLocal(blockKey);
  const next = presets.filter(
    (item) => item.name.toLowerCase() !== name.toLowerCase(),
  );
  if (next.length === presets.length) return false;
  writeLocal(blockKey, next);
  return true;
};

/** Desktop only: reveal the block preset folder in the system file manager. */
export const openBlockPresetFolder = async (blockKey: string): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error('Opening the preset folder requires the desktop app');
  }
  await tauriClient.openBlockPresetsFolder(blockKey);
};
