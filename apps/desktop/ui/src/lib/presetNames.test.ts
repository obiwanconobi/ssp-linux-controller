import { describe, expect, it } from 'vitest';
import {
  matchingPresetName,
  presetNameBytes,
  presetNameError,
} from './presetNames';

describe('preset names', () => {
  it('validates empty, control, and byte-length limits', () => {
    expect(presetNameError('')).toBe('Patch name cannot be empty');
    expect(presetNameError('Amp\nLead')).toContain('control characters');
    expect(presetNameError('x'.repeat(63))).toBeNull();
    expect(presetNameError('x'.repeat(64))).toContain('63 bytes');
    expect(presetNameError('é'.repeat(32))).toContain('63 bytes');
    expect(presetNameBytes('amp')).toBe(3);
  });

  it('finds case-insensitive duplicates but can exclude the old name', () => {
    const names = ['Dumble Clean', 'Dumble Ford', ''];
    expect(matchingPresetName(names, 'dumble ford')).toBe('Dumble Ford');
    expect(matchingPresetName(names, 'Dumble Ford')).toBe('Dumble Ford');
    expect(matchingPresetName(names, 'Dumble Ford', 'Dumble Ford')).toBeNull();
    expect(matchingPresetName(names, 'New Patch')).toBeNull();
  });
});
