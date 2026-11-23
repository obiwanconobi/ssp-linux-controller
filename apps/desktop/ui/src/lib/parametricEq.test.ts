import { describe, expect, it } from 'vitest';
import { parametricEqModel, parametricEqType, parametricEqTypeOption } from './parametricEq';
import type { Block, Control, ControlGroup } from '../types';

const bandControl = (
  index: number,
  field: string,
  value: number,
  min: number,
  max: number,
): Control => ({
  id: `parametric_eq.eq_par.${field}_${index}`,
  name: `${field}_${index}`,
  label: `${field} ${index}`,
  kind: 'float',
  value,
  min,
  max,
  step: 0.1,
});

const typeControl = (index: number, value: string): Control => ({
  id: `parametric_eq.eq_par.type_${index}`,
  name: `type_${index}`,
  label: `type ${index}`,
  kind: 'choice',
  value,
  options: ['LPS', 'LP', 'BP', 'HP', 'HPS'],
});

const block = (controls: Control[], id = 'root\\app\\parametric_eq'): Block => {
  const group: ControlGroup = {
    id: 'root\\app\\parametric_eq\\eq_par',
    label: 'Parametric EQ',
    itemType: 'module',
    enabled: true,
    onOffId: 'root\\app\\parametric_eq\\on_off',
    controls,
  };
  return {
    id,
    label: 'Parametric EQ',
    shortName: 'PEQ',
    family: 'utility',
    on: true,
    fixed: false,
    link: 'series',
    controls: [],
    groups: [group],
    footswitch: 1,
  };
};

describe('parametricEqModel', () => {
  it('maps band_0..3, freq, q, and type into the shared EqBand shape', () => {
    const controls = [
      bandControl(0, 'band', 4, -15, 15),
      bandControl(0, 'freq', 90, 50, 20000),
      bandControl(0, 'q', 0.7, 0.1, 10),
      typeControl(0, 'LPS'),
      bandControl(1, 'band', -2.5, -15, 15),
      bandControl(1, 'freq', 640, 50, 20000),
      bandControl(1, 'q', 1.2, 0.1, 10),
      typeControl(1, 'BP'),
    ];
    const model = parametricEqModel(block(controls));
    expect(model).not.toBeNull();
    expect(model!.bands).toHaveLength(2);
    expect(model!.bands[0]).toMatchObject({
      index: 1,
      deviceIndex: 0,
      type: 'LPS',
      frequency: 90,
      gain: 4,
      q: 0.7,
    });
    expect(model!.bands[1]).toMatchObject({
      index: 2,
      deviceIndex: 1,
      type: 'BP',
      frequency: 640,
      gain: -2.5,
    });
    expect(model!.minFrequency).toBe(50);
    expect(model!.maxFrequency).toBe(20000);
    expect(model!.maxGain).toBe(15);
  });

  it('returns null for other blocks and non-EQ groups', () => {
    expect(parametricEqModel(block([], 'root\\app\\eq'))).toBeNull();
    const other = block([
      {
        id: 'parametric_eq.eq_par.rate',
        name: 'rate',
        label: 'Rate',
        kind: 'float',
        value: 1,
      },
    ]);
    other.groups[0].id = 'root\\app\\drive\\voice';
    other.groups[0].label = 'Voice';
    expect(parametricEqModel(other)).toBeNull();
  });

  it('accepts one-based device indices from older firmware', () => {
    const controls = [
      bandControl(1, 'band', 2, -15, 15),
      bandControl(1, 'freq', 1000, 50, 20000),
      bandControl(1, 'q', 1, 0.1, 10),
      typeControl(1, 'HPS'),
    ];
    const model = parametricEqModel(block(controls));
    expect(model!.bands[0].index).toBe(1);
    expect(model!.bands[0].deviceIndex).toBe(1);
  });
});

describe('parametricEqType', () => {
  it('normalises device spellings and resolves enum options', () => {
    expect(parametricEqType('LPS')).toBe('LPS');
    expect(parametricEqType('low_shelf')).toBe('LPS');
    expect(parametricEqType('BELL')).toBe('BP');
    expect(parametricEqType('high pass')).toBe('HP');
    expect(parametricEqType('unknown')).toBe('BP');

    const control = typeControl(0, 'BP');
    expect(parametricEqTypeOption(control, 'HPS')).toBe('HPS');
    expect(parametricEqTypeOption(control, 'LP')).toBe('LP');
  });
});
