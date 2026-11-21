import { describe, expect, it } from 'vitest';
import {
  bandResponseDb,
  combinedResponseDb,
  EQ_GRID_FREQUENCIES,
  frequencyFromLog,
  logFrequency,
  responseCurve,
} from './eq';
import type { EqBand } from '../types';

const band = (patch: Partial<EqBand> = {}): EqBand => ({
  index: 1,
  enabled: true,
  type: 'BP',
  frequency: 640,
  gain: 2.5,
  q: 1.2,
  ...patch,
});

describe('EQ response', () => {
  it('matches the gain at a bell centre frequency', () => {
    expect(bandResponseDb(band(), 640)).toBeCloseTo(2.5, 6);
  });

  it('sums enabled bands only', () => {
    const bands = [
      band({ index: 1, type: 'LPS', frequency: 90, gain: 4, q: 0.7 }),
      band({ index: 2, gain: 2.5 }),
      band({ index: 3, enabled: false, frequency: 3200, gain: -20 }),
    ];
    const expected =
      bandResponseDb(bands[0], 1000) + bandResponseDb(bands[1], 1000);
    expect(combinedResponseDb(bands, 1000)).toBeCloseTo(expected, 9);
  });

  it('round-trips the logarithmic frequency axis', () => {
    for (const frequency of EQ_GRID_FREQUENCIES) {
      expect(frequencyFromLog(logFrequency(frequency))).toBeCloseTo(frequency, 6);
    }
  });

  it('builds a 20 Hz to 20 kHz response curve', () => {
    const curve = responseCurve([band()], 5);
    expect(curve).toHaveLength(5);
    expect(curve[0].frequency).toBeCloseTo(20, 6);
    expect(curve[4].frequency).toBeCloseTo(20000, 2);
  });
});
