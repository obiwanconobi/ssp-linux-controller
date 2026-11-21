import type { Control } from '../../types';

/**
 * Parametric NAM models can expose discrete switch controls.  The firmware
 * still presents them as `pfloat` nodes, but stores the selected position as
 * `index / (count - 1)` in the node's normalized 0..1 value.
 */
export const isOptionControl = (control: Control): boolean =>
  control.kind === 'pfloat' && (control.options?.length ?? 0) > 1;

const normalizedValue = (control: Control): number => {
  const raw = Number(control.value ?? 0);
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  if (!Number.isFinite(raw) || max <= min) return min;
  return Math.min(max, Math.max(min, raw));
};

export const optionIndex = (control: Control): number => {
  const options = control.options ?? [];
  if (options.length <= 1) return 0;
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  const fraction =
    max === min ? 0 : (normalizedValue(control) - min) / (max - min);
  return Math.min(
    options.length - 1,
    Math.max(0, Math.round(fraction * (options.length - 1))),
  );
};

export const optionValue = (control: Control, index: number): number => {
  const options = control.options ?? [];
  const min = control.min ?? 0;
  const max = control.max ?? 1;
  if (options.length <= 1) return min;
  const clamped = Math.min(options.length - 1, Math.max(0, index));
  const raw = min + (clamped / (options.length - 1)) * (max - min);
  return Number(raw.toFixed(6));
};
