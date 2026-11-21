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
  tempo: number;
  tempoMin?: number;
  tempoMax?: number;
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
}

export interface LibrarySlot {
  index: number;
  name: string;
  used: boolean;
  active: boolean;
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
  state: 'preflight' | 'queued' | 'uploading' | 'done' | 'error';
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
  note: string;
  cents: number;
  frequency: number;
  reference: number;
  level: number;
}

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
