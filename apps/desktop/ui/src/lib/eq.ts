import type { EqBand, EqBandType } from '../types';

export const SAMPLE_RATE = 48_000;
export const MIN_FREQ = 20;
export const MAX_FREQ = 20_000;
export const MIN_GAIN = -15;
export const MAX_GAIN = 15;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

const DEFAULTS: Record<EqBandType, { frequency: number; gain: number; q: number }> = {
  LPS: { frequency: 90, gain: 3, q: 0.7 },
  BP: { frequency: 1000, gain: 2, q: 1 },
  HPS: { frequency: 9000, gain: 3, q: 0.7 },
  LP: { frequency: 12000, gain: 0, q: 0.7 },
  HP: { frequency: 80, gain: 0, q: 0.7 },
};

export const bandDefaults = (type: EqBandType) => DEFAULTS[type];

export const bandTypeLabel = (type: EqBandType): string => {
  switch (type) {
    case 'LPS':
      return 'Low shelf';
    case 'HPS':
      return 'High shelf';
    case 'LP':
      return 'Low pass';
    case 'HP':
      return 'High pass';
    default:
      return 'Bell';
  }
};

export const bandResponseDb = (band: EqBand, frequency: number): number => {
  if (!band.enabled) return 0;
  const f0 = Math.max(1, Math.min(band.frequency, SAMPLE_RATE / 2 - 10));
  const q = Math.max(0.05, Math.min(band.q, 40));
  const gain = Math.max(-60, Math.min(band.gain, 60));
  const amplitude = 10 ** (gain / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const sqrtA = Math.sqrt(amplitude);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;

  if (band.type === 'LPS') {
    b0 = amplitude * (amplitude + 1 - (amplitude - 1) * cos + 2 * sqrtA * alpha);
    b1 = 2 * amplitude * (amplitude - 1 - (amplitude + 1) * cos);
    b2 = amplitude * (amplitude + 1 - (amplitude - 1) * cos - 2 * sqrtA * alpha);
    a0 = amplitude + 1 + (amplitude - 1) * cos + 2 * sqrtA * alpha;
    a1 = -2 * (amplitude - 1 + (amplitude + 1) * cos);
    a2 = amplitude + 1 + (amplitude - 1) * cos - 2 * sqrtA * alpha;
  } else if (band.type === 'HPS') {
    b0 = amplitude * (amplitude + 1 + (amplitude - 1) * cos + 2 * sqrtA * alpha);
    b1 = -2 * amplitude * (amplitude - 1 + (amplitude + 1) * cos);
    b2 = amplitude * (amplitude + 1 + (amplitude - 1) * cos - 2 * sqrtA * alpha);
    a0 = amplitude + 1 - (amplitude - 1) * cos + 2 * sqrtA * alpha;
    a1 = 2 * (amplitude - 1 - (amplitude + 1) * cos);
    a2 = amplitude + 1 - (amplitude - 1) * cos - 2 * sqrtA * alpha;
  } else if (band.type === 'LP' || band.type === 'HP') {
    const gainFactor = 10 ** (gain / 20);
    if (band.type === 'LP') {
      b0 = (1 - cos) * 0.5 * gainFactor;
      b1 = (1 - cos) * gainFactor;
      b2 = (1 - cos) * 0.5 * gainFactor;
    } else {
      b0 = (1 + cos) * 0.5 * gainFactor;
      b1 = -(1 + cos) * gainFactor;
      b2 = (1 + cos) * 0.5 * gainFactor;
    }
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = 1 + alpha * amplitude;
    b1 = -2 * cos;
    b2 = 1 - alpha * amplitude;
    a0 = 1 + alpha / amplitude;
    a1 = -2 * cos;
    a2 = 1 - alpha / amplitude;
  }

  const biquad: Biquad = { b0, b1, b2, a0, a1, a2 };
  return magnitudeDb(biquad, frequency);
};

const magnitudeDb = (coeff: Biquad, frequency: number): number => {
  const a0 = coeff.a0 === 0 ? 1 : coeff.a0;
  const b0 = coeff.b0 / a0;
  const b1 = coeff.b1 / a0;
  const b2 = coeff.b2 / a0;
  const a1 = coeff.a1 / a0;
  const a2 = coeff.a2 / a0;
  const w = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numReal = b0 + b1 * cos1 + b2 * cos2;
  const numImag = -(b1 * sin1 + b2 * sin2);
  const denReal = 1 + a1 * cos1 + a2 * cos2;
  const denImag = -(a1 * sin1 + a2 * sin2);
  const num = Math.hypot(numReal, numImag);
  const den = Math.hypot(denReal, denImag);
  return den === 0 ? 0 : 20 * Math.log10(num / den);
};

export const combinedResponseDb = (bands: EqBand[], frequency: number): number =>
  bands
    .filter((band) => band.enabled)
    .reduce((sum, band) => sum + bandResponseDb(band, frequency), 0);

export const logFrequency = (
  frequency: number,
  minFrequency = MIN_FREQ,
  maxFrequency = MAX_FREQ,
): number =>
  (Math.log10(frequency) - Math.log10(minFrequency)) /
  (Math.log10(maxFrequency) - Math.log10(minFrequency));

export const frequencyFromLog = (
  position: number,
  minFrequency = MIN_FREQ,
  maxFrequency = MAX_FREQ,
): number =>
  10 **
  (Math.log10(minFrequency) +
    position * (Math.log10(maxFrequency) - Math.log10(minFrequency)));

export const responseCurve = (
  bands: EqBand[],
  points = 240,
): Array<{ frequency: number; gain: number }> =>
  Array.from({ length: points }, (_, index) => {
    const frequency = frequencyFromLog(index / (points - 1));
    return { frequency, gain: combinedResponseDb(bands, frequency) };
  });

export const EQ_GRID_FREQUENCIES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
export const EQ_GRID_GAINS = [12, 6, 0, -6, -12];

export const formatHz = (frequency: number): string => {
  if (frequency >= 1000) {
    const value = frequency / 1000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} kHz`;
  }
  return `${Math.round(frequency)} Hz`;
};

export const formatGain = (gain: number): string =>
  `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
