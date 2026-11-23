import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConnectionInfo, RustBlockEditor, RustSnapshot } from './client';
import { mapPreset, mapSnapshot } from './mapSnapshot';
import type { ConnectionState, PresetState } from '../types';

const loadFixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../fixtures/snapshots/${name}`, import.meta.url),
      'utf8',
    ),
  ) as { snapshot: RustSnapshot; editors: Record<string, RustBlockEditor> };

const fixture = loadFixture('simulator-2.4.4.json');
const hardware = loadFixture('hardware-2.4.4.json');

const info: ConnectionInfo = {
  address: 'tcp:127.0.0.1:45678',
  transport: 'network 127.0.0.1:45678',
  device_name: 'StompStation PRO',
  firmware: '2.4.4',
  node_count: 132,
};

const connection: ConnectionState = {
  connected: true,
  connecting: false,
  mode: 'demo',
  transport: 'DEMO',
  deviceName: 'StompStation PRO',
  firmware: '2.4.4',
  pollMs: 500,
  lastPollMs: 4,
  address: 'simulated',
};

const preset: PresetState = {
  current: 'Old',
  index: 0,
  names: ['Old'],
  favorites: ['Match Brave Chorus'],
  recent: ['Dumble Clean'],
};

describe('mapSnapshot', () => {
  const mapped = mapSnapshot(fixture.snapshot, fixture.editors, info, {
    preset,
    connection,
    eq: [],
  });

  it('maps the chain with router positions and fixed slots', () => {
    expect(mapped.blocks.map((block) => block.shortName)).toEqual([
      'GATE',
      'PITCH',
      'COMP',
      'DRIVE',
      'AMP / NAM',
      'CAB',
      'MOD',
      'DELAY',
      'REVERB',
    ]);
    const amp = mapped.blocks.find((block) => block.family === 'amp')!;
    expect(amp.fixed).toBe(true);
    expect(amp.slotRow).toBe(0);
    expect(amp.slotCol).toBe(8);
    const delay = mapped.blocks.find((block) => block.family === 'delay')!;
    expect(delay.fixed).toBe(true);
  });

  it('derives the model selector and removes it from the control list', () => {
    const drive = mapped.blocks.find((block) => block.family === 'drive')!;
    expect(drive.model).toBe('Klone 3');
    expect(drive.modelOptions).toContain('Tone-King OD');
    expect(drive.controls.some((control) => control.name === 'model')).toBe(false);
    expect(drive.controls.map((control) => control.name)).toContain('gain');
    expect(drive.controls.every((control) => control.id.startsWith('root\\app\\drive\\'))).toBe(true);
  });

  it('maps the dual NAM lane', () => {
    const amp = mapped.blocks.find((block) => block.family === 'amp')!;
    expect(amp.secondLane?.model).toBe('64 Vibroverb D 2');
    expect(amp.secondLane?.enabled).toBe(true);
    expect(amp.secondLane?.controls.map((control) => control.name)).toContain('gain');
  });

  it('maps global EQ, lists, presets, and master values', () => {
    expect(mapped.eq).toHaveLength(4);
    expect(mapped.eq[0]).toMatchObject({ index: 1, deviceIndex: 1, type: 'LPS', gain: 4, frequency: 90 });
    expect(mapped.eq[3].type).toBe('HPS');
    expect(mapped.eqEnabled).toBe(true);
    expect(mapped.master.volume).toBe(72);
    expect(mapped.master.tempo).toBe(120);
    expect(mapped.master.presetLevel).toBe(1.5);
    expect(mapped.master.presetLevelAvailable).toBe(true);
    expect(mapped.preset.favorites).toEqual(['Match Brave Chorus']);
    expect(mapped.preset.recent).toEqual(['Dumble Clean']);
    const ir = mapped.lists.find((list) => list.kind === 'ir')!;
    expect(ir.id).toBe('ir_list');
    expect(ir.slots[0].name).toBe('TJ3 58BND310');
    expect(ir.activeSlot).toBe(0);
  });

  it('maps global input settings and the 2.5.3 preset level range', () => {
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.master.preset_level = {
      id: 'root\\app\\output\\pst\\level',
      label: 'Preset level',
      value: 3.4,
      min: -20,
      max: 20,
      step: 0.1,
      unit: 'dB',
    };
    snapshot.input = {
      gain1: {
        id: 'root\\settings\\input\\gain1',
        label: 'In 1 digital gain',
        value: -3.5,
        min: -15,
        max: 15,
        step: 0.1,
        unit: 'dB',
      },
      gain2: null,
      connected1: true,
      connected2: false,
    };
    const mappedInput = mapSnapshot(snapshot, fixture.editors, info, {
      preset,
      connection,
      eq: [],
    });
    expect(mappedInput.master.presetLevel).toBe(3.4);
    expect(mappedInput.master.presetLevelMin).toBe(-20);
    expect(mappedInput.master.presetLevelMax).toBe(20);
    expect(mappedInput.master.presetLevelStep).toBe(0.1);
    expect(mappedInput.input.gain1).toMatchObject({
      label: 'In 1 digital gain',
      value: -3.5,
      min: -15,
      max: 15,
      step: 0.1,
      unit: 'dB',
    });
    expect(mappedInput.input.gain2).toBeNull();
    expect(mappedInput.input.connected1).toBe(true);
    expect(mappedInput.input.connected2).toBe(false);
  });

  it('switches connection state to the device transport', () => {
    expect(mapped.connection.mode).toBe('device');
    expect(mapped.connection.connected).toBe(true);
    expect(mapped.connection.transport).toContain('127.0.0.1');
    expect(mapped.connection.firmware).toBe('2.4.4');
  });
});

describe('hardware 2.4.4 fixture', () => {
  const mapped = mapSnapshot(hardware.snapshot, hardware.editors, info, {
    preset,
    connection,
    eq: [],
  });

  it('maps the twelve-block hardware chain and two empty slots', () => {
    expect(mapped.blocks).toHaveLength(12);
    expect(mapped.blocks[0]).toMatchObject({ family: 'gate', on: false });
    expect(mapped.blocks.find((block) => block.family === 'amp')?.fixed).toBe(true);
    expect(mapped.blocks.map((block) => block.label)).toContain('Expression');
  });

  it('follows the active NAM/PNAM type when choosing the drive model loader', () => {
    const editors = structuredClone(hardware.editors);
    const drive = editors['root\\app\\drive'];
    const param = (name: string) => drive.parameters.find((node) => node.name === name)!;
    param('type').value = 'Parametric NAM';
    param('model').visible = false;
    param('gain').visible = false;
    param('pmodel').visible = true;
    param('pmodel').value = 'Analogman King Of Tone v4 HiGain OD';
    for (const name of ['p1', 'p2', 'p3']) param(name).visible = true;

    const mappedPnam = mapSnapshot(hardware.snapshot, editors, info, {
      preset,
      connection,
      eq: [],
    });
    const pnamDrive = mappedPnam.blocks.find((block) => block.family === 'drive')!;
    expect(pnamDrive.modelControlId).toBe('root\\app\\drive\\pmodel');
    expect(pnamDrive.model).toBe('Analogman King Of Tone v4 HiGain OD');
    expect(pnamDrive.modelOptions).toContain('ChowCentaur');
    expect(pnamDrive.controls.map((control) => control.name)).toEqual(
      expect.arrayContaining(['p1', 'p2', 'p3']),
    );
    expect(pnamDrive.controls.some((control) => control.name === 'model')).toBe(false);
    expect(pnamDrive.controls.some((control) => control.name === 'gain')).toBe(false);
  });

  it('normalizes 0-based firmware EQ indices to the 1-4 UI contract', () => {
    expect(mapped.eq.map((band) => band.index)).toEqual([1, 2, 3, 4]);
    expect(mapped.eq.map((band) => band.deviceIndex)).toEqual([0, 1, 2, 3]);
    expect(mapped.eq.map((band) => band.gain)).toEqual([0, 0, 0, 0]);
  });

  it('keeps real firmware names and group-hosted controls', () => {
    const comp = mapped.blocks.find((block) => block.family === 'comp')!;
    expect(comp.controls.map((control) => control.name)).toContain('sensitivity');
    expect(comp.controls.map((control) => control.name)).toContain('makeup');
    const delay = mapped.blocks.find((block) => block.family === 'delay')!;
    expect(delay.groups.some((group) => group.id.endsWith('dlytime'))).toBe(true);
    const cab = mapped.blocks.find((block) => block.family === 'cab')!;
    expect(cab.controls.map((control) => control.name)).toEqual(
      expect.arrayContaining(['lo_cut', 'hi_cut', 'blend']),
    );
    expect(cab.model).toBeTruthy();
    const mod = mapped.blocks.find((block) => block.id.endsWith('\\mod'))!;
    expect(mod.groups.some((group) => group.id.endsWith('rate'))).toBe(true);
  });

  it('reuses the preset object when a poll has unchanged content', () => {
    const first = mapPreset(fixture.snapshot, preset);
    const polled = structuredClone(fixture.snapshot);
    const second = mapPreset(polled, first);
    expect(second).toBe(first);

    polled.preset.current = 'Changed';
    const third = mapPreset(polled, first);
    expect(third).not.toBe(first);
    expect(third.current).toBe('Changed');
  });

  it('maps the real 60-name preset list and five capture lists', () => {
    expect(mapped.preset.names).toHaveLength(60);
    expect(mapped.master.presetLevelAvailable).toBe(false);
    expect(mapped.master.tempoMin).toBe(30);
    expect(mapped.master.tempoMax).toBe(240);
    expect(mapped.eqEnabled).toBe(false);
    expect(mapped.lists).toHaveLength(5);
    expect(mapped.lists.map((list) => list.kind)).toEqual([
      'nam',
      'pnam',
      'nam',
      'pnam',
      'ir',
    ]);
  });
});
