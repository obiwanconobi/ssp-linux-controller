import type {
  ActivityEntry,
  Block,
  Control,
  ControlGroup,
  EqBand,
  LibraryList,
  MasterState,
  MeterState,
  PresetState,
  TunerState,
  UploadTask,
} from '../types';

const control = (
  id: string,
  name: string,
  label: string,
  value: number | string | boolean,
  options: Partial<Control> = {},
): Control => ({
  id,
  name,
  label,
  kind: typeof value === 'number' ? 'float' : typeof value === 'boolean' ? 'bool' : 'choice',
  value,
  defaultValue: value,
  min: typeof value === 'number' ? 0 : undefined,
  max: typeof value === 'number' ? 10 : undefined,
  step: typeof value === 'number' ? 0.1 : undefined,
  ...options,
});

const float = (
  id: string,
  name: string,
  label: string,
  value: number,
  min: number,
  max: number,
  unit = '',
  step = 0.1,
): Control => ({
  id,
  name,
  label,
  kind: 'float',
  value,
  defaultValue: value,
  min,
  max,
  step,
  unit,
  decimals: step < 0.1 ? 2 : 1,
});

const choice = (
  id: string,
  name: string,
  label: string,
  value: string,
  options: string[],
  kind: Control['kind'] = 'choice',
): Control => ({
  id,
  name,
  label,
  kind,
  value,
  defaultValue: value,
  options,
});

const bool = (id: string, name: string, label: string, value: boolean): Control => ({
  id,
  name,
  label,
  kind: 'bool',
  value,
  defaultValue: value,
});

const pfloat = (
  id: string,
  name: string,
  label: string,
  value: number,
  displayMin: number,
  displayMax: number,
  unit = '',
): Control => ({
  id,
  name,
  label,
  kind: 'pfloat',
  value,
  defaultValue: value,
  min: 0,
  max: 1,
  displayMin,
  displayMax,
  step: 0.01,
  decimals: 1,
  unit,
  pfloat: true,
});

const group = (
  id: string,
  label: string,
  controls: Control[],
  itemType = 'vfolder',
): ControlGroup => ({ id, label, itemType, controls });

export const PRESET_NAMES = [
  'Dumble Clean',
  'Dumble Ford',
  'Dumble Carlton',
  'Match Brave Chorus',
  'Match Brave Cab',
  'Match Brave No Cab',
  'Tone-King',
  'Tone-King - Drive',
  'Tone-King - Drive Delay',
  'Purple Plexi',
  'SineWave',
  'Space Prince',
  '5150',
  'Bass Ampeg',
  'Dumble Deep',
  'Dumble Room',
  'Twin Clean',
  'Twin Edge',
  'JTM 45',
  'JCM 800',
  'Plexi Lead',
  'AC30 Chime',
  'AC30 Top Boost',
  'Deluxe Reverb',
  'Princeton Clean',
  'Bassman',
  'Bandmaster',
  'Matchless DC30',
  'Vox Night Train',
  'Friedman BE',
  'Diezel VH4',
  'Mesa Dual Rec',
  'Orange Rockerverb',
  'Soldano SLO',
  'Bogner Ecstasy',
  'Trainwreck',
  'Dumble ODS',
  'Two-Rock',
  'Carol Ann',
  'Bad Cat',
  'Dr Z Maz',
  'Fender Champ',
  'Supro Thunderbolt',
  'Ampeg SVT',
  'Gallien Krueger',
  'Darkglass B7K',
  'Acoustic DI',
  'Studio Flat',
  'Headphones',
  'Lo-Fi Room',
  'Wet Only',
  'Null Test',
];

const typeControl = (prefix: string): Control =>
  choice(`${prefix}.type`, 'type', 'Type', 'NAM', ['NAM', 'Parametric NAM']);

export const DRIVE_MODELS = [
  'Klone 3',
  'The Green Box',
  'The Orange Box',
  'Tone-King OD',
];

export const PNAM_DRIVE_MODELS = [
  'Dumble Drive PNAM',
  'Fuzz Face PNAM',
  'Klon PNAM',
];

export const AMP_MODELS = [
  'Match Brave Hi D 3',
  '64 Vibroverb D 2',
  'Dumble Pack A',
  'Twin Clean',
];

export const PNAM_AMP_MODELS = [
  'Dumble PNAM Clean',
  'Dumble PNAM Lead',
  'Tweed PNAM',
];

const NAM_DRIVE_CONTROLS: Control[] = [
  typeControl('drive'),
  float('drive.gain', 'gain', 'Gain', 6.4, 0, 10, '', 0.1),
  float('drive.tone', 'treble', 'Tone', 5.2, 0, 10, '', 0.1),
  float('drive.level', 'lvl', 'Level', 7.0, 0, 10, '', 0.1),
  float('drive.mix', 'mix', 'Mix', 100, 0, 100, '%', 1),
];

const PNAM_DRIVE_CONTROLS: Control[] = [
  typeControl('drive'),
  pfloat('drive.pdrive', 'pdrive', 'Drive', 0.62, 0, 10),
  pfloat('drive.pcharacter', 'pcharacter', 'Character', 0.48, 0, 10),
  pfloat('drive.pbias', 'pbias', 'Bias', 0.55, 0, 10),
  pfloat('drive.poutput', 'poutput', 'Output', 0.7, 0, 10),
  pfloat('drive.ppresence', 'ppresence', 'Presence', 0.58, 0, 10),
  pfloat('drive.pmix', 'pmix', 'Mix', 1, 0, 100, '%'),
];

const driveVoice: ControlGroup = {
  id: 'drive.voice',
  label: 'Voice',
  itemType: 'vfolder_tc',
  enabled: true,
  controls: [
    float('drive.voice.body', 'body', 'Body', 4.5, 0, 10, '', 0.1),
    float('drive.voice.presence', 'presence', 'Presence', 6.1, 0, 10, '', 0.1),
    bool('drive.voice.bright', 'bright', 'Bright', true),
  ],
};

export const AMP_LANE_1: Control[] = [
  typeControl('amp'),
  float('amp.gain', 'gain', 'Gain', 6.2, 0, 10, '', 0.1),
  float('amp.bass', 'low', 'Bass', 5.0, 0, 10, '', 0.1),
  float('amp.mid', 'mid', 'Mid', 4.8, 0, 10, '', 0.1),
  float('amp.treble', 'treble', 'Treble', 6.0, 0, 10, '', 0.1),
  float('amp.level', 'lvl', 'Level', 7.0, 0, 10, '', 0.1),
  float('amp.pan', 'pan1', 'Pan 1', -30, -100, 100, '', 1),
];

const PNAM_AMP_CONTROLS: Control[] = [
  typeControl('amp'),
  pfloat('amp.pdrive', 'pdrive', 'Drive', 0.58, 0, 10),
  pfloat('amp.pcharacter', 'pcharacter', 'Character', 0.52, 0, 10),
  pfloat('amp.pbass', 'pbass', 'Bass', 0.5, 0, 10),
  pfloat('amp.pmid', 'pmid', 'Mid', 0.48, 0, 10),
  pfloat('amp.ptreble', 'ptreble', 'Treble', 0.6, 0, 10),
  pfloat('amp.ppresence', 'ppresence', 'Presence', 0.55, 0, 10),
  pfloat('amp.poutput', 'poutput', 'Output', 0.7, 0, 10),
];

export const AMP_LANE_2: Control[] = [
  typeControl('amp.nam2'),
  choice('amp.nam2.model', 'model', 'Model', '64 Vibroverb D 2', AMP_MODELS),
  float('amp.nam2.gain', 'gain', 'Gain', 4.0, 0, 10, '', 0.1),
  float('amp.nam2.bass', 'low', 'Bass', 5.2, 0, 10, '', 0.1),
  float('amp.nam2.mid', 'mid', 'Mid', 5.0, 0, 10, '', 0.1),
  float('amp.nam2.treble', 'treble', 'Treble', 5.5, 0, 10, '', 0.1),
  float('amp.nam2.level', 'vol', 'Volume', 6.5, 0, 10, '', 0.1),
  float('amp.nam2.pan', 'pan', 'Pan', 30, -100, 100, '', 1),
];

export const CAB_CONTROLS: Control[] = [
  float('cab.level', 'lvl', 'Level', -3.5, -20, 20, 'dB', 0.1),
  float('cab.blend', 'blend', 'Blend', 38, 0, 100, '%', 1),
  float('cab.pan', 'pan', 'Pan', 0, -100, 100, '', 1),
];

export const CAB_SECOND: ControlGroup = {
  id: 'cab.ir2',
  label: 'IR 2 · Stereo',
  itemType: 'vfolder_tc',
  enabled: false,
  controls: [
    choice('cab.ir2.model', 'ir', 'IR', 'TJ3 57', ['TJ3 58BND310', 'TJ3 57', 'G12M Greenback']),
    float('cab.ir2.pan', 'pan', 'Pan', -20, -100, 100, '', 1),
  ],
};

export const DELAY_SYNC: ControlGroup = {
  id: 'delay.sync',
  label: 'Tempo Sync',
  itemType: 'module',
  enabled: true,
  controls: [
    choice('delay.sync.mode', 'mode', 'Mode', '1/4', ['1/4', '1/8', '1/8D', '1/16']),
    choice('delay.sync.lock', 'lock', 'Lock', 'OFF', ['ON', 'OFF']),
  ],
};

export const INITIAL_BLOCKS: Block[] = [
  {
    id: 'gate',
    label: 'Noise Gate',
    shortName: 'GATE',
    family: 'gate',
    on: false,
    fixed: false,
    link: 'series',
    model: 'NS-2',
    footswitch: 1,
    controls: [
      float('gate.thresh', 'thresh', 'Threshold', -45, -80, 0, 'dB', 0.1),
      float('gate.decay', 'decay', 'Decay', 20, 0, 100, '%', 1),
    ],
    groups: [],
  },
  {
    id: 'pitch',
    label: 'Pitch',
    shortName: 'PITCH',
    family: 'pitch',
    on: false,
    fixed: false,
    link: 'series',
    model: 'Whammy',
    footswitch: 2,
    controls: [
      float('pitch.pitch', 'pitch', 'Pitch', 0, -24, 24, 'st', 1),
      float('pitch.mix', 'mix', 'Mix', 100, 0, 100, '%', 1),
    ],
    groups: [],
  },
  {
    id: 'comp',
    label: 'Compressor',
    shortName: 'COMP',
    family: 'comp',
    on: true,
    fixed: false,
    link: 'series',
    model: 'Dyna Comp',
    footswitch: 3,
    controls: [
      float('comp.thresh', 'thresh', 'Threshold', -18, -60, 0, 'dB', 0.1),
      float('comp.ratio', 'ratio', 'Ratio', 4, 1, 20, ':1', 0.5),
      float('comp.level', 'lvl', 'Level', 6, 0, 10, '', 0.1),
    ],
    groups: [
      group('comp.envelope', 'Envelope', [
        float('comp.attack', 'attack', 'Attack', 10, 0.1, 100, 'ms', 0.1),
        float('comp.release', 'release', 'Release', 120, 10, 1000, 'ms', 1),
      ]),
    ],
  },
  {
    id: 'drive',
    label: 'Drive · Klone 3',
    shortName: 'DRIVE',
    family: 'drive',
    on: true,
    fixed: false,
    link: 'series',
    model: 'Klone 3',
    modelOptions: DRIVE_MODELS,
    modelControlId: 'drive.model',
    footswitch: 4,
    controls: NAM_DRIVE_CONTROLS,
    groups: [driveVoice],
  },
  {
    id: 'amp',
    label: 'Amp · Match Brave Hi D 3',
    shortName: 'AMP / NAM',
    family: 'amp',
    on: true,
    fixed: true,
    link: 'series',
    model: 'Match Brave Hi D 3',
    modelOptions: AMP_MODELS,
    modelControlId: 'amp.model',
    footswitch: 5,
    controls: AMP_LANE_1,
    groups: [group('amp.nam2', 'Dual Amp', AMP_LANE_2)],
    secondLane: {
      id: 'amp.nam2',
      label: 'NAM 2',
      model: '64 Vibroverb D 2',
      modelOptions: AMP_MODELS,
      modelControlId: 'amp.nam2.model',
      enabled: true,
      controls: AMP_LANE_2,
    },
  },
  {
    id: 'cab',
    label: 'Cab · TJ3 58BND310',
    shortName: 'CAB',
    family: 'cab',
    on: true,
    fixed: false,
    link: 'series',
    model: 'TJ3 58BND310',
    modelOptions: ['TJ3 58BND310', 'TJ3 57', 'G12M Greenback'],
    modelControlId: 'cab.model',
    footswitch: 6,
    controls: CAB_CONTROLS,
    groups: [CAB_SECOND],
  },
  {
    id: 'mod',
    label: 'Mod · Chorus',
    shortName: 'MOD',
    family: 'mod',
    on: true,
    fixed: false,
    link: 'series',
    model: 'Chorus',
    footswitch: 7,
    controls: [
      float('mod.rate', 'rate', 'Rate', 2.4, 0, 10, 'Hz', 0.1),
      float('mod.depth', 'depth', 'Depth', 35, 0, 100, '%', 1),
      float('mod.mix', 'mix', 'Mix', 28, 0, 100, '%', 1),
    ],
    groups: [],
  },
  {
    id: 'delay',
    label: 'Delay · Dual',
    shortName: 'DELAY',
    family: 'delay',
    on: false,
    fixed: true,
    link: 'series',
    model: 'Dual',
    footswitch: 8,
    controls: [
      float('delay.time', 'dlytime', 'Time', 420, 20, 2000, 'ms', 1),
      float('delay.feedback', 'fdbk', 'Feedback', 35, 0, 100, '%', 1),
      float('delay.mix', 'mix', 'Mix', 24, 0, 100, '%', 1),
    ],
    groups: [DELAY_SYNC],
  },
  {
    id: 'reverb',
    label: 'Reverb · Plate',
    shortName: 'REVERB',
    family: 'reverb',
    on: false,
    fixed: true,
    link: 'series',
    model: 'Plate',
    footswitch: 9,
    controls: [
      float('reverb.mix', 'mix', 'Mix', 22, 0, 100, '%', 1),
      float('reverb.decay', 'decay', 'Decay', 40, 0, 100, '%', 1),
      float('reverb.predelay', 'predelay', 'Pre-delay', 20, 0, 200, 'ms', 1),
    ],
    groups: [
      group('reverb.tone', 'Tone', [
        float('reverb.lowcut', 'locut', 'Low cut', 120, 20, 500, 'Hz', 1),
        float('reverb.highcut', 'hicut', 'High cut', 8000, 1000, 20000, 'Hz', 10),
      ]),
    ],
  },
];

export const AVAILABLE_BLOCKS = [
  { id: 'chorus', label: 'Chorus', desc: 'Classic analog chorus' },
  { id: 'flanger', label: 'Flanger', desc: 'Through-zero flanger' },
  { id: 'rotary', label: 'Rotary', desc: 'Leslie cabinet' },
  { id: 'eq', label: 'EQ', desc: '4-band parametric' },
  { id: 'parametric_eq', label: 'Parametric EQ', desc: 'High-resolution EQ' },
];

export const INITIAL_MASTER: MasterState = {
  volume: 72,
  volumeMin: 0,
  volumeMax: 100,
  presetLevel: 1.5,
  presetLevelAvailable: true,
  tempo: 120,
  tempoMin: 20,
  tempoMax: 300,
};

export const INITIAL_EQ: EqBand[] = [
  { index: 1, enabled: true, type: 'LPS', frequency: 90, gain: 4, q: 0.7 },
  { index: 2, enabled: true, type: 'BP', frequency: 640, gain: 2.5, q: 1.2 },
  { index: 3, enabled: true, type: 'BP', frequency: 3200, gain: -2, q: 2.4 },
  { index: 4, enabled: true, type: 'HPS', frequency: 9000, gain: 3, q: 0.7 },
];

export const INITIAL_PRESET: PresetState = {
  current: 'Match Brave Chorus',
  index: 3,
  names: PRESET_NAMES,
  favorites: ['Dumble Ford', 'Match Brave Chorus', 'Tone-King - Drive Delay', 'Purple Plexi'],
  recent: ['Match Brave Chorus', 'Dumble Clean', 'Tone-King - Drive', 'Space Prince'],
};

export const INITIAL_LISTS: LibraryList[] = [
  {
    id: 'nam_amp',
    label: 'Amp models',
    kind: 'nam',
    slotSize: 1024 * 1024,
    activeSlot: 0,
    slots: [
      { index: 0, name: 'Match Brave Hi D 3', used: true, active: true },
      { index: 1, name: '64 Vibroverb D 2', used: true, active: true },
      { index: 2, name: 'Twin Clean', used: true, active: false },
      { index: 3, name: 'Dumble Ford', used: true, active: false },
      { index: 4, name: 'Plexi Lead', used: true, active: false },
      { index: 5, name: '', used: false, active: false },
      { index: 6, name: '', used: false, active: false },
      { index: 7, name: '', used: false, active: false },
    ],
  },
  {
    id: 'nam_drive',
    label: 'Drive models',
    kind: 'nam',
    slotSize: 1024 * 1024,
    activeSlot: 0,
    slots: [
      { index: 0, name: 'Klone 3', used: true, active: true },
      { index: 1, name: 'Tone-King OD', used: true, active: false },
      { index: 2, name: '', used: false, active: false },
      { index: 3, name: '', used: false, active: false },
    ],
  },
  {
    id: 'pnam_list',
    label: 'Parametric amp models',
    kind: 'pnam',
    slotSize: 2 * 1024 * 1024,
    activeSlot: 2,
    slots: [
      { index: 0, name: '', used: false, active: false },
      { index: 1, name: '', used: false, active: false },
      { index: 2, name: 'Dumble Pack A', used: true, active: true },
      { index: 3, name: '', used: false, active: false },
    ],
  },
  {
    id: 'pnam_drive',
    label: 'Parametric drive models',
    kind: 'pnam',
    slotSize: 2 * 1024 * 1024,
    activeSlot: 0,
    slots: [
      { index: 0, name: 'ZenDrive', used: true, active: true },
      { index: 1, name: 'Klon Centaur', used: true, active: false },
      { index: 2, name: '', used: false, active: false },
      { index: 3, name: '', used: false, active: false },
    ],
  },
  {
    id: 'ir_list',
    label: 'Cabinet IRs',
    kind: 'ir',
    slotSize: 8192,
    activeSlot: 0,
    slots: [
      { index: 0, name: 'TJ3 58BND310', used: true, active: true },
      { index: 1, name: 'TJ3 57', used: true, active: true },
      { index: 2, name: 'G12M Greenback', used: true, active: false },
      { index: 3, name: '', used: false, active: false },
    ],
  },
];

export const INITIAL_METERS: MeterState = {
  input: [-12.4, -11.8],
  output: [-9.2, -8.7],
};

export const INITIAL_ACTIVITY: ActivityEntry[] = [
  { id: 'a1', time: '12:04', title: 'Preset loaded', detail: 'Match Brave Chorus', tone: 'neutral' },
  { id: 'a2', time: '12:04', title: 'Drive model', detail: 'Klone 3', tone: 'neutral' },
  { id: 'a3', time: '12:03', title: 'IR upload started', detail: 'TJ3 58BND310.wav · slot 4', tone: 'warn' },
  { id: 'a4', time: '12:01', title: 'Device synced', detail: 'firmware 2.5.3 · 694 nodes', tone: 'good' },
  { id: 'a5', time: '11:58', title: 'Preset saved', detail: 'Tone-King - Drive', tone: 'good' },
];

export const INITIAL_TUNER: TunerState = {
  enabled: false,
  available: true,
  note: 'A',
  cents: 0.8,
  frequency: 110,
  reference: 440,
  level: -18,
};

export const INITIAL_UPLOADS: UploadTask[] = [
  {
    id: 'u1',
    file: 'TJ3 58BND310.wav',
    kind: 'ir',
    target: 'Cabinet IRs',
    slot: 3,
    progress: 62,
    state: 'uploading',
    ack: 5,
    totalAcks: 8,
    detail: '1.2 s left',
  },
];

export const applyDemoBlockType = (block: Block, type: string): Block => {
  const parametric = type === 'Parametric NAM';
  const withType = (controls: Control[]) =>
    controls.map((control) => ({
      ...control,
      value:
        control.name === 'type'
          ? type
          : control.value,
    }));

  if (block.family === 'drive') {
    const model = parametric ? PNAM_DRIVE_MODELS[0] : 'Klone 3';
    return {
      ...block,
      label: `Drive · ${model}`,
      model,
      modelOptions: parametric ? PNAM_DRIVE_MODELS : DRIVE_MODELS,
      controls: withType(parametric ? PNAM_DRIVE_CONTROLS : NAM_DRIVE_CONTROLS),
      groups: parametric ? [] : [driveVoice],
    };
  }
  if (block.family === 'amp') {
    const model = parametric ? PNAM_AMP_MODELS[0] : 'Match Brave Hi D 3';
    return {
      ...block,
      label: `Amp · ${model}`,
      model,
      modelOptions: parametric ? PNAM_AMP_MODELS : AMP_MODELS,
      controls: withType(parametric ? PNAM_AMP_CONTROLS : AMP_LANE_1),
    };
  }
  return block;
};

export const applyDemoLaneType = (
  lane: NonNullable<Block['secondLane']>,
  type: string,
): NonNullable<Block['secondLane']> => {
  const parametric = type === 'Parametric NAM';
  return {
    ...lane,
    model: parametric ? PNAM_AMP_MODELS[0] : '64 Vibroverb D 2',
    modelOptions: parametric ? PNAM_AMP_MODELS : AMP_MODELS,
    controls: lane.controls.map((control) =>
      control.name === 'type' ? { ...control, value: type } : control,
    ),
  };
};

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

export const formatFrequency = (frequency: number): string => {
  if (frequency >= 1000) {
    const value = frequency / 1000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  return `${Math.round(frequency)}`;
};

export const cloneBlocks = (blocks: Block[]): Block[] =>
  blocks.map((block) => ({
    ...block,
    controls: block.controls.map((item) => ({ ...item })),
    groups: block.groups.map((item) => ({
      ...item,
      controls: item.controls.map((controlItem) => ({ ...controlItem })),
      groups: item.groups?.map((nested) => ({
        ...nested,
        controls: nested.controls.map((controlItem) => ({ ...controlItem })),
      })),
    })),
    secondLane: block.secondLane
      ? {
          ...block.secondLane,
          controls: block.secondLane.controls.map((item) => ({ ...item })),
        }
      : undefined,
  }));
