import type { Block, Control, ControlGroup, EqBand, EqBandType } from '../types';

const FIELD = /^(band|freq|q|type)_(\d+)$/;

const TYPE_MAP: Record<string, EqBandType> = {
  LPS: 'LPS',
  LOW_SHELF: 'LPS',
  LOWSHELF: 'LPS',
  'LOW SHELF': 'LPS',
  LS: 'LPS',
  HPS: 'HPS',
  HIGH_SHELF: 'HPS',
  HIGHSHELF: 'HPS',
  'HIGH SHELF': 'HPS',
  HS: 'HPS',
  LP: 'LP',
  LOW_PASS: 'LP',
  LOWPASS: 'LP',
  'LOW PASS': 'LP',
  HP: 'HP',
  HIGH_PASS: 'HP',
  HIGHPASS: 'HP',
  'HIGH PASS': 'HP',
  BP: 'BP',
  BELL: 'BP',
  PEAK: 'BP',
  NOTCH: 'BP',
};

export const parametricEqType = (value: string): EqBandType =>
  TYPE_MAP[value.trim().toUpperCase()] ?? 'BP';

export interface ParametricEqModel {
  group: ControlGroup;
  bands: EqBand[];
  gain: Record<number, Control>;
  frequency: Record<number, Control>;
  q: Record<number, Control>;
  type: Record<number, Control>;
  minFrequency: number;
  maxFrequency: number;
  maxGain: number;
  minQ: number;
  maxQ: number;
}

const controlNumber = (control: Control): number =>
  typeof control.value === 'number' ? control.value : Number(control.value) || 0;

const firstNumber = (controls: Control[], key: 'min' | 'max', fallback: number) =>
  controls.find((control) => control[key] != null)?.[key] ?? fallback;

/** Map the in-chain Parametric EQ block into the shared graph view model. */
export const parametricEqModel = (block: Block): ParametricEqModel | null => {
  const name = block.id.split('\\').pop() ?? block.id;
  // Demo blocks append a unique suffix to the device block name.
  if (name !== 'parametric_eq' && !name.startsWith('parametric_eq-')) return null;
  const group = block.groups.find(
    (candidate) =>
      candidate.id.endsWith('\\eq_par') ||
      candidate.id.endsWith('.eq_par') ||
      candidate.controls.some((control) => FIELD.test(control.name)),
  );
  if (!group) return null;

  const gain: Record<number, Control> = {};
  const frequency: Record<number, Control> = {};
  const q: Record<number, Control> = {};
  const type: Record<number, Control> = {};
  for (const control of group.controls) {
    const match = FIELD.exec(control.name);
    if (!match) continue;
    const index = Number(match[2]);
    if (match[1] === 'band') gain[index] = control;
    else if (match[1] === 'freq') frequency[index] = control;
    else if (match[1] === 'q') q[index] = control;
    else if (match[1] === 'type') type[index] = control;
  }
  const indices = [...new Set(Object.keys(gain).map(Number))].sort((a, b) => a - b);
  if (indices.length === 0) return null;

  const oneBased = indices[0] >= 1;
  const bands: EqBand[] = indices.map((deviceIndex) => ({
    index: oneBased ? deviceIndex : deviceIndex + 1,
    deviceIndex,
    enabled: block.on,
    type: type[deviceIndex] ? parametricEqType(String(type[deviceIndex].value)) : 'BP',
    frequency: frequency[deviceIndex] ? controlNumber(frequency[deviceIndex]) : 1000,
    gain: gain[deviceIndex] ? controlNumber(gain[deviceIndex]) : 0,
    q: q[deviceIndex] ? controlNumber(q[deviceIndex]) : 0.707,
  }));
  return {
    group,
    bands,
    gain,
    frequency,
    q,
    type,
    minFrequency: firstNumber(Object.values(frequency), 'min', 50),
    maxFrequency: firstNumber(Object.values(frequency), 'max', 20000),
    maxGain: Math.max(
      Math.abs(firstNumber(Object.values(gain), 'min', -15)),
      Math.abs(firstNumber(Object.values(gain), 'max', 15)),
    ),
    minQ: firstNumber(Object.values(q), 'min', 0.1),
    maxQ: firstNumber(Object.values(q), 'max', 10),
  };
};

/** Resolve an EqBand type to one of the firmware's current enum options. */
export const parametricEqTypeOption = (
  control: Control | undefined,
  type: EqBandType,
): string => {
  if (!control) return type;
  const options = control.options ?? [];
  const match = options.find((option) => parametricEqType(option) === type);
  return match ?? type;
};
