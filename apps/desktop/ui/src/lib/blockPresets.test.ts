import { describe, expect, it } from 'vitest';
import { INITIAL_BLOCKS, cloneBlocks } from '../data/demoDevice';
import {
  applyPresetValuesToBlock,
  blockPresetChanges,
  blockPresetKey,
  blockPresetNameError,
  captureBlockPreset,
  prepareBlockPresetValues,
  sortBlockPresetChanges,
} from './blockPresets';

const initialBlocks = () => cloneBlocks(INITIAL_BLOCKS);
const drive = () => initialBlocks().find((block) => block.id === 'drive')!;
const amp = () => initialBlocks().find((block) => block.id === 'amp')!;

describe('block presets', () => {
  it('captures parameters, nested groups, second lanes, and model names', () => {
    const block = amp();
    block.groups[0].enabled = true;
    block.groups[0].onOffId = 'amp.nam2.on_off';
    const preset = captureBlockPreset(block, '  Amp lead  ');

    expect(preset.name).toBe('Amp lead');
    expect(preset.blockKey).toBe('amp');
    expect(preset.values['amp.gain']).toBe(6.2);
    expect(preset.values['amp.nam2.gain']).toBe(4);
    expect(preset.values['amp.nam2.on_off']).toBe('ON');
    expect(preset.values['amp.model']).toBe('Match Brave Hi D 3');
    expect(preset.values['amp.nam2.model']).toBe('64 Vibroverb D 2');
    expect(preset.values['amp.on']).toBeUndefined();
  });

  it('applies values, group state, and models without changing bypass', () => {
    const block = amp();
    block.groups[0].enabled = true;
    block.groups[0].onOffId = 'amp.nam2.on_off';
    const preset = captureBlockPreset(block, 'Lead');
    const values = {
      ...preset.values,
      'amp.gain': 8.5,
      'amp.nam2.on_off': 'OFF',
      'amp.model': 'Twin Clean',
      'amp.nam2.model': 'Dumble Pack A',
    };

    const next = applyPresetValuesToBlock(block, values);

    expect(next.on).toBe(block.on);
    expect(next.controls.find((control) => control.id === 'amp.gain')?.value).toBe(8.5);
    expect(next.groups[0].enabled).toBe(false);
    expect(next.model).toBe('Twin Clean');
    expect(next.secondLane?.model).toBe('Dumble Pack A');
    expect(next.label).toContain('Twin Clean');
  });

  it('falls back to the first available model and flags missing or stale names', () => {
    const block = drive();
    const preset = captureBlockPreset(block, 'Klone');

    const stale = prepareBlockPresetValues(block, {
      ...preset,
      values: { ...preset.values, 'drive.model': 'Not a real model' },
    });
    expect(stale.values['drive.model']).toBe(block.modelOptions?.[0]);
    expect(stale.warnings[0]).toContain('Not a real model');

    const missingValues = { ...preset.values };
    delete missingValues['drive.model'];
    const missing = prepareBlockPresetValues(block, {
      ...preset,
      values: missingValues,
    });
    expect(missing.values['drive.model']).toBe(block.modelOptions?.[0]);
    expect(missing.warnings[0]).toContain('has no model');
  });

  it('only reports values that differ and orders type/model changes first', () => {
    const block = amp();
    const preset = captureBlockPreset(block, 'Lead');
    const values = {
      ...preset.values,
      'amp.gain': 9,
      'amp.model': 'Twin Clean',
    };
    const changes = sortBlockPresetChanges(
      block,
      blockPresetChanges(block, values),
    );

    expect(changes.map((change) => change.path)).toEqual(['amp.model', 'amp.gain']);
    expect(changes[0].path).toBe('amp.model');
  });

  it('derives friendly, safe block keys and validates preset names', () => {
    expect(blockPresetKey({ ...drive(), id: 'root\\app\\drive' })).toBe('drive');
    expect(blockPresetKey({ ...drive(), id: 'root\\app\\Delay Two' })).toBe('delay_two');
    expect(blockPresetNameError('')).toBeTruthy();
    expect(blockPresetNameError('Lead\n')).toBeTruthy();
    expect(blockPresetNameError('Lead')).toBeNull();
  });
});
