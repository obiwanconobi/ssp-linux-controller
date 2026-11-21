import { describe, expect, it } from 'vitest';
import type { Control } from '../../types';
import { isOptionControl, optionIndex, optionValue } from './optionControl';

const pfloatSwitch = (value: number, options: string[]): Control => ({
  id: 'root\\app\\amp\\p1',
  name: 'p1',
  label: 'Gain-Boost',
  kind: 'pfloat',
  value,
  min: 0,
  max: 1,
  options,
});

describe('parametric NAM switch controls', () => {
  it('detects pfloat nodes with discrete options', () => {
    expect(isOptionControl(pfloatSwitch(0, ['ON', 'OFF']))).toBe(true);
    expect(
      isOptionControl({ ...pfloatSwitch(0, []), options: undefined }),
    ).toBe(false);
    expect(
      isOptionControl({ ...pfloatSwitch(0, []), kind: 'float' }),
    ).toBe(false);
  });

  it('matches the firmware half-away-from-zero index mapping', () => {
    const control = pfloatSwitch(0.5, ['ON', 'OFF']);
    expect(optionIndex(control)).toBe(1);
    expect(optionValue(control, 0)).toBe(0);
    expect(optionValue(control, 1)).toBe(1);
  });

  it('maps multi-position switches across the normalized range', () => {
    const control = pfloatSwitch(0.5, ['CLEAN', 'EDGE', 'CRUNCH']);
    expect(optionIndex(control)).toBe(1);
    expect(optionValue(control, 0)).toBe(0);
    expect(optionValue(control, 1)).toBe(0.5);
    expect(optionValue(control, 2)).toBe(1);
  });
});
