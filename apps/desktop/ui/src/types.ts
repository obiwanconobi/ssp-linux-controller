export type ViewId = 'board' | 'amp' | 'eq' | 'library' | 'settings' | 'stage';
export type ThemeId = 'studio' | 'cream' | 'british';
export type Density = 'comfortable' | 'compact';
export type Motion = 'full' | 'reduced';

export type BlockFamily =
  | 'gate'
  | 'pitch'
  | 'comp'
  | 'drive'
  | 'amp'
  | 'cab'
  | 'mod'
  | 'delay'
  | 'reverb'
  | 'utility';

export type ControlKind = 'float' | 'pfloat' | 'choice' | 'enum' | 'bool' | 'text' | 'number';

export interface Control {
  id: string;
  name: string;
  label: string;
  kind: ControlKind;
  value: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number | string | boolean;
  unit?: string;
  options?: string[];
  visible?: boolean;
  decimals?: number;
  pfloat?: boolean;
  displayMin?: number;
  displayMax?: number;
  conflict?: boolean;
}

export interface ControlGroup {
  id: string;
  label: string;
  itemType: string;
  enabled?: boolean;
  onOffId?: string;
  modePath?: string;
  modeValue?: string;
  modeOptions?: Array<{ value: string; label: string }>;
  controls: Control[];
  groups?: ControlGroup[];
}

export interface Block {
  id: string;
  label: string;
  shortName: string;
  family: BlockFamily;
  on: boolean;
  fixed: boolean;
  link: 'series' | 'parallel';
  model?: string;
  modelOptions?: string[];
  modelControlId?: string;
  controls: Control[];
  groups: ControlGroup[];
  footswitch: number;
  slotRow?: number;
  slotCol?: number;
  controlRevision?: number;
  secondLane?: BlockLane;
}

export interface BlockLane {
  id: string;
  label: string;
  model: string;
  modelOptions: string[];
  enabled: boolean;
  modelControlId?: string;
  onOffId?: string;
  controls: Control[];
}

export interface MasterState {
  volume: number;
  volumeMin?: number;
  volumeMax?: number;
  presetLevel: number;
  presetLevelAvailable?: boolean;
  presetLevelMin?: number;
  presetLevelMax?: number;
  presetLevelStep?: number;
  tempo: number;
  tempoMin?: number;
  tempoMax?: number;
}

/** Global input settings. These are not preset data and never mark a preset dirty. */
export interface InputState {
  gain1: Control | null;
  gain2: Control | null;
  connected1: boolean | null;
  connected2: boolean | null;
}

export type EqBandType = 'LPS' | 'BP' | 'HPS' | 'LP' | 'HP';

export interface EqBand {
  index: number;
  deviceIndex?: number;
  enabled: boolean;
  type: EqBandType;
  frequency: number;
  gain: number;
  q: number;
}

export interface PresetState {
  current: string;
  index: number;
  names: string[];
  favorites: string[];
  recent: string[];
  listPath?: string;
}

export type BlockPresetValue = number | string | boolean;

/** A host-side preset for one block type. Values are keyed by control path. */
export interface BlockPreset {
  version: number;
  name: string;
  blockKey: string;
  blockPath: string;
  blockLabel: string;
  family: BlockFamily;
  savedAt: string;
  values: Record<string, BlockPresetValue>;
}

export interface LibrarySlot {
  index: number;
  name: string;
  used: boolean;
  active: boolean;
  /** Preset slot indices whose `used` map references this capture. */
  usedBy?: number[];
}

export interface LibraryList {
  id: string;
  label: string;
  kind: 'nam' | 'pnam' | 'ir';
  slotSize: number;
  activeSlot?: number;
  slots: LibrarySlot[];
}

export interface UploadTask {
  id: string;
  file: string;
  kind: 'nam' | 'pnam' | 'ir';
  target: string;
  slot: number;
  progress: number;
  state: 'preflight' | 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  ack: number;
  totalAcks: number;
  detail?: string;
}

export interface ActivityEntry {
  id: string;
  time: string;
  title: string;
  detail?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

export interface MeterState {
  input: [number, number];
  output: [number, number];
}

export interface TunerState {
  enabled: boolean;
  available: boolean;
  message?: string;
  note: string;
  cents: number;
  frequency: number;
  reference: number;
  level: number;
}

export type ConflictValue = number | string | boolean;

export interface DeviceConflict {
  id: string;
  kind: 'control' | 'model' | 'master' | 'eq';
  label: string;
  localValue: ConflictValue;
  deviceValue: ConflictValue;
  blockId?: string;
  controlId?: string;
  lane?: boolean;
  field?: string;
  index?: number;
}

export type MasterField = 'volume' | 'tempo' | 'presetLevel';

export type DeviceChainEdit =
  | { type: 'add'; row: number; col: number; path: string }
  | { type: 'remove'; row: number; col: number }
  | { type: 'move'; from: [number, number]; to: [number, number] }
  | { type: 'link'; row: number; col: number; parallel: boolean }
  | { type: 'replace'; row: number; col: number; path: string }
  | { type: 'clear' };

export type DeviceOperation =
  | {
      kind: 'control';
      key: string;
      label: string;
      blockId: string;
      path: string;
      before: ConflictValue;
      after: ConflictValue;
    }
  | {
      kind: 'model';
      key: string;
      label: string;
      blockId: string;
      lane: boolean;
      path: string;
      before: string;
      after: string;
    }
  | {
      kind: 'block-preset';
      key: string;
      label: string;
      blockId: string;
      changes: Array<{ path: string; before: ConflictValue; after: ConflictValue }>;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      blockId: string;
      before: boolean;
      after: boolean;
    }
  | {
      kind: 'lane-enabled';
      key: string;
      label: string;
      blockId: string;
      before: boolean;
      after: boolean;
    }
  | {
      kind: 'master';
      key: string;
      label: string;
      field: MasterField;
      before: number;
      after: number;
    }
  | {
      kind: 'eq';
      key: string;
      label: string;
      index: number;
      deviceIndex: number;
      before: Record<string, ConflictValue>;
      after: Record<string, ConflictValue>;
    }
  | {
      kind: 'eq-enabled';
      key: string;
      label: string;
      before: boolean;
      after: boolean;
    }
  | {
      kind: 'eq-bulk';
      key: string;
      label: string;
      changes: Array<{
        index: number;
        deviceIndex: number;
        before: number;
        after: number;
      }>;
    }
  | {
      kind: 'chain';
      key: string;
      label: string;
      edit: DeviceChainEdit;
      inverse: DeviceChainEdit;
    }
  | {
      kind: 'chain-clear';
      key: string;
      label: string;
      restore: Array<{ row: number; col: number; path: string }>;
    };

export interface ConnectionState {
  connected: boolean;
  connecting: boolean;
  mode: 'demo' | 'device';
  autoSearch?: 'idle' | 'searching' | 'failed';
  autoSearchMessage?: string;
  error?: string;
  transport: string;
  deviceName: string;
  firmware: string;
  pollMs: number;
  lastPollMs: number;
  address: string;
}

export interface SaveState {
  edited: boolean;
  saving: boolean;
  lastSaved: string;
  revision: number;
}
