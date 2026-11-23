export const MAX_PRESET_NAME_BYTES = 63;

export const presetNameBytes = (name: string): number =>
  new TextEncoder().encode(name).length;

export const listNameError = (name: string): string | null => {
  if (!name) return 'Capture name cannot be empty';
  if (/[\u0000-\u001f]/.test(name)) {
    return 'Capture name cannot contain control characters';
  }
  if (presetNameBytes(name) > MAX_PRESET_NAME_BYTES) {
    return `Capture name must be at most ${MAX_PRESET_NAME_BYTES} bytes`;
  }
  return null;
};

export const presetNameError = (name: string): string | null => {
  if (!name) return 'Patch name cannot be empty';
  if (/[\u0000-\u001f]/.test(name)) {
    return 'Patch name cannot contain control characters';
  }
  if (presetNameBytes(name) > MAX_PRESET_NAME_BYTES) {
    return `Patch name must be at most ${MAX_PRESET_NAME_BYTES} bytes`;
  }
  return null;
};

/** Return the existing name that matches case-insensitively, if any. */
export const matchingPresetName = (
  names: string[],
  name: string,
  exclude?: string,
): string | null => {
  const lower = name.toLowerCase();
  return (
    names.find(
      (existing) =>
        existing.length > 0 &&
        existing !== exclude &&
        existing.toLowerCase() === lower,
    ) ?? null
  );
};
