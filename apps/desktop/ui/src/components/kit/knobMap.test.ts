import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RustBlockEditor, RustSnapshot } from '../../ipc/client';
import { mapSnapshot } from '../../ipc/mapSnapshot';
import type { ConnectionState, PresetState } from '../../types';
import { blockControl, getBlockKnobIds } from './knobMap';

const hardware = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../../fixtures/snapshots/hardware-2.4.4.json'),
    'utf8',
  ),
) as { snapshot: RustSnapshot; editors: Record<string, RustBlockEditor> };

const connection: ConnectionState = {
  connected: true,
  connecting: false,
  mode: 'device',
  transport: 'USB',
  deviceName: 'StompStation PRO',
  firmware: '2.4.4',
  pollMs: 500,
  lastPollMs: 4,
  address: 'serial:/dev/ttyACM0',
};

const preset: PresetState = {
  current: '',
  index: 0,
  names: [],
  favorites: [],
  recent: [],
};

const mapped = mapSnapshot(
  hardware.snapshot,
  hardware.editors,
  { address: 'serial:/dev/ttyACM0@115200', transport: 'USB', device_name: 'StompStation PRO', firmware: '2.4.4', node_count: 688 },
  { preset, connection, eq: [] },
);

const namesFor = (path: string) => {
  const block = mapped.blocks.find((candidate) => candidate.id === path)!;
  return getBlockKnobIds(block).map((id) => blockControl(block, id)?.name);
};

describe('hardware knob maps', () => {
  it('uses real drive and amp priorities', () => {
    expect(namesFor('root\\app\\drive')).toEqual(['gain', 'treble', 'lvl']);
    expect(namesFor('root\\app\\amp')).toEqual(['gain', 'low', 'treble']);
  });

  it('selects the real compressor sensitivity and makeup names', () => {
    expect(namesFor('root\\app\\comp')).toEqual(['sensitivity', 'makeup', 'attack']);
  });

  it('reaches group-hosted time and rate controls', () => {
    expect(namesFor('root\\app\\delay')).toEqual(['dlytime', 'fdbk', 'mix']);
    expect(namesFor('root\\app\\mod')).toEqual(['rate', 'dpth', 'mix']);
  });

  it('uses the real cabinet low/high-cut names', () => {
    expect(namesFor('root\\app\\ir')).toEqual(['blend', 'lo_cut', 'hi_cut']);
  });

  it('does not expose second NAM lane controls on the shell', () => {
    const amp = mapped.blocks.find((block) => block.family === 'amp')!;
    expect(getBlockKnobIds(amp)).not.toContainEqual(
      expect.stringContaining('nam2'),
    );
  });
});
