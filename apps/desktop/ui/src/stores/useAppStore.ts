import { create } from 'zustand';
import {
  applyDemoBlockType,
  applyDemoLaneType,
  AVAILABLE_BLOCKS,
  cloneBlocks,
  formatBytes,
  INITIAL_ACTIVITY,
  INITIAL_BLOCKS,
  INITIAL_EQ,
  INITIAL_LISTS,
  INITIAL_MASTER,
  INITIAL_METERS,
  INITIAL_PRESET,
  INITIAL_TUNER,
  INITIAL_UPLOADS,
} from '../data/demoDevice';
import { applyAppearance, loadAppearance, saveAppearance } from '../theme/themes';
import {
  adjacentEmptySlot,
  compareChainSlots,
  parseChainSlotId,
  slotOf,
  type ChainSlotRef,
} from '../lib/chainSlots';
import {
  commitAndroidSaveTarget,
  prepareAndroidSaveTarget,
} from '../lib/androidFiles';
import { listNameError, presetNameError } from '../lib/presetNames';
import {
  applyPresetValuesToBlock,
  blockPresetChanges,
  prepareBlockPresetValues,
  sortBlockPresetChanges,
} from '../lib/blockPresets';
import {
  allBlockControls,
  blockControl,
  getBlockKnobIds,
} from '../components/kit/knobMap';
import {
  UPLOAD_TARGET_PATHS,
  uploadTargetId,
  uploadTargetPath,
} from '../lib/uploads';
import {
  coalesce,
  flushCoalesced,
  ipcErrorCode,
  ipcErrorMessage,
  isMobileRuntime,
  isStaleWriteError,
  isTauriRuntime,
  tauriClient,
} from '../ipc/client';
import type {
  ConnectionInfo,
  RustBlockEditor,
  RustImportReport,
  RustSnapshot,
  RustUploadProgress,
} from '../ipc/client';
import {
  mapAvailableBlocks,
  mapBlock,
  mapEq,
  mapInput,
  mapLists,
  mapMaster,
  mapMeters,
  mapPreset,
  mapSnapshot,
} from '../ipc/mapSnapshot';
import type {
  ActivityEntry,
  Block,
  BlockPreset,
  ConflictValue,
  ConnectionState,
  ControlGroup,
  Density,
  DeviceConflict,
  DeviceChainEdit,
  DeviceOperation,
  EqBand,
  InputState,
  LibraryList,
  LibrarySlot,
  MasterField,
  MasterState,
  MeterState,
  Motion,
  PresetState,
  SaveState,
  ThemeId,
  TunerState,
  UploadTask,
  ViewId,
} from '../types';

interface Snapshot {
  blocks: Block[];
  master: MasterState;
  eq: EqBand[];
  eqEnabled: boolean;
  preset: PresetState;
}

interface Toast {
  id: number;
  message: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

interface AppStore {
  view: ViewId;
  mobileBoardPane: 'chain' | 'edit';
  selectedBlockId: string | null;
  blocks: Block[];
  availableBlocks: typeof AVAILABLE_BLOCKS;
  emptySlots: Array<{ row: number; col: number }>;
  master: MasterState;
  input: InputState;
  eq: EqBand[];
  eqEnabled: boolean;
  preset: PresetState;
  lists: LibraryList[];
  meters: MeterState;
  activity: ActivityEntry[];
  uploads: UploadTask[];
  recentUpload: { target: string; slot: number; name: string } | null;
  tuner: TunerState;
  connection: ConnectionState;
  save: SaveState;
  theme: ThemeId;
  density: Density;
  motion: Motion;
  compactChain: boolean;
  pending: string[];
  conflicts: DeviceConflict[];
  deviceUndoStack: DeviceOperation[];
  deviceRedoStack: DeviceOperation[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  commandOpen: boolean;
  presetDrawerOpen: boolean;
  connectionOpen: boolean;
  tunerOpen: boolean;
  activityOpen: boolean;
  shortcutsOpen: boolean;
  toast: Toast | null;
  demoAllowed: boolean;
  appVersion: string;
  lastEdit: { key: string; at: number };
  setView: (view: ViewId) => void;
  setMobileBoardPane: (pane: 'chain' | 'edit') => void;
  selectBlock: (id: string) => void;
  setPreset: (index: number) => void;
  savePreset: () => void;
  savePresetAs: (name: string) => boolean;
  renamePreset: (oldName: string, newName: string) => void;
  exportPreset: (index: number, destination: string) => Promise<boolean>;
  importPreset: (
    bundlePath: string,
    targetSlot: number,
    overwritePreset: boolean,
    overwriteDependencies: boolean,
  ) => Promise<RustImportReport | null>;
  renameCapture: (listId: string, index: number, newName: string) => void;
  deletePreset: (index: number) => void;
  deletePresets: (indices: number[]) => Promise<void>;
  deleteCapture: (listId: string, index: number) => void;
  deleteCaptures: (listId: string, indices: number[]) => Promise<void>;
  addPreset: () => void;
  toggleFavorite: (name: string) => void;
  toggleBlock: (id: string) => void;
  setBlockModel: (blockId: string, model: string) => void;
  setLaneModel: (blockId: string, model: string) => void;
  setLaneEnabled: (blockId: string, enabled: boolean) => void;
  setControl: (controlId: string, value: number | string | boolean) => void;
  applyBlockPreset: (blockId: string, preset: BlockPreset) => void;
  setLink: (id: string, parallel: boolean) => void;
  moveBlock: (activeId: string, overId: string) => void;
  addBlock: (id: string, slot?: ChainSlotRef) => void;
  removeBlock: (id: string) => void;
  clearChain: () => void;
  replaceBlock: (id: string, replacementId: string) => void;
  setMaster: (field: keyof MasterState, value: number) => void;
  setInputGain: (channel: 1 | 2, value: number) => void;
  setEqBand: (index: number, patch: Partial<EqBand>) => void;
  setEqEnabled: (enabled: boolean) => void;
  flattenEq: () => void;
  undo: () => void;
  redo: () => void;
  setTheme: (theme: ThemeId) => void;
  setDensity: (density: Density) => void;
  setMotion: (motion: Motion) => void;
  setCompactChain: (compact: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setPresetDrawerOpen: (open: boolean) => void;
  setConnectionOpen: (open: boolean) => void;
  setTunerOpen: (open: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  connectDemo: () => void;
  connectAuto: (password?: string, rememberPassword?: boolean) => Promise<void>;
  connectReal: (
    address: string,
    password?: string,
    rememberPassword?: boolean,
  ) => Promise<void>;
  unlockDevice: (password: string | null, rememberPassword?: boolean) => Promise<boolean>;
  forgetSavedPassword: () => Promise<void>;
  setDemoAllowed: (allowed: boolean) => void;
  setAppVersion: (version: string) => void;
  refreshDevice: (fullRefresh?: boolean) => Promise<void>;
  refreshSnapshot: () => void;
  applyDeviceSnapshot: (snapshot: RustSnapshot) => void;
  resumeDevice: () => Promise<void>;
  disconnect: () => void;
  addUpload: (file: {
    name: string;
    size: number;
    kind: 'nam' | 'pnam' | 'ir' | 'vxamp';
    target?: string;
    slot?: number;
    path?: string;
  }) => boolean;
  cancelUpload: (id?: string) => void;
  applyUploadProgress: (payload: RustUploadProgress) => void;
  tickUploads: () => void;
  setTuner: (patch: Partial<TunerState>) => void;
  tickTuner: () => void;
  handleWriteFailure: (id: string, message: string, error: unknown) => void;
  resolveConflict: (id: string, choice: 'device' | 'local') => void;
  recordDeviceOperation: (operation: DeviceOperation, coalesce?: boolean) => void;
  clearDeviceHistory: () => void;
  notify: (message: string, tone?: Toast['tone']) => void;
  copyDiagnostics: () => void;
  addActivity: (title: string, detail?: string, tone?: ActivityEntry['tone']) => void;
  getSelectedBlock: () => Block | undefined;
  getKnobIds: (block: Block) => string[];
  getControl: (block: Block, controlId: string) => ReturnType<typeof blockControl>;
}

const appearance = loadAppearance();
applyAppearance(appearance.theme, appearance.density, appearance.motion);

const loadCompactChain = (): boolean => {
  try {
    return localStorage.getItem('stomp.compactChain') === '1';
  } catch {
    return false;
  }
};

const snapshotOf = (state: AppStore): Snapshot => ({
  blocks: cloneBlocks(state.blocks),
  master: { ...state.master },
  eq: state.eq.map((band) => ({ ...band })),
  eqEnabled: state.eqEnabled,
  preset: {
    ...state.preset,
    names: [...state.preset.names],
    favorites: [...state.preset.favorites],
    recent: [...state.preset.recent],
  },
});

const now = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const toastId = { current: 1 };
const desktopRuntime = isTauriRuntime();

const demoBoot = () => ({
  selectedBlockId: 'drive' as string | null,
  blocks: cloneBlocks(INITIAL_BLOCKS),
  availableBlocks: AVAILABLE_BLOCKS,
  emptySlots: [] as Array<{ row: number; col: number }>,
  master: { ...INITIAL_MASTER } as MasterState,
  input: {
    gain1: {
      id: 'root\\settings\\input\\gain1',
      name: 'gain1',
      label: 'In 1 digital gain',
      kind: 'float',
      value: 0,
      min: -15,
      max: 15,
      step: 0.1,
      defaultValue: 0,
      unit: 'dB',
      decimals: 1,
    },
    gain2: {
      id: 'root\\settings\\input\\gain2',
      name: 'gain2',
      label: 'In 2 digital gain',
      kind: 'float',
      value: 0,
      min: -15,
      max: 15,
      step: 0.1,
      defaultValue: 0,
      unit: 'dB',
      decimals: 1,
    },
    connected1: true,
    connected2: false,
  } as InputState,
  eq: INITIAL_EQ.map((band) => ({ ...band })),
  eqEnabled: true,
  preset: {
    ...INITIAL_PRESET,
    names: [...INITIAL_PRESET.names],
    favorites: [...INITIAL_PRESET.favorites],
    recent: [...INITIAL_PRESET.recent],
  } as PresetState,
  lists: INITIAL_LISTS.map((list) => ({
    ...list,
    slots: list.slots.map((slot) => ({ ...slot })),
  })) as LibraryList[],
  meters: { input: [...INITIAL_METERS.input], output: [...INITIAL_METERS.output] } as MeterState,
  activity: INITIAL_ACTIVITY.map((entry) => ({ ...entry })) as ActivityEntry[],
  uploads: INITIAL_UPLOADS.map((upload) => ({ ...upload })) as UploadTask[],
  recentUpload: null as { target: string; slot: number; name: string } | null,
  tuner: { ...INITIAL_TUNER } as TunerState,
  save: {
    edited: false,
    saving: false,
    lastSaved: now(),
    revision: 7,
  } as SaveState,
  connection: {
    connected: true,
    connecting: false,
    mode: 'demo',
    autoSearch: 'idle',
    autoSearchMessage: '',
    transport: 'DEMO · browser simulator',
    deviceName: 'StompStation PRO',
    firmware: '2.5.3',
    pollMs: 500,
    lastPollMs: 4.1,
    address: 'simulated:45678',
  } as ConnectionState,
  demoAllowed: true,
});

const emptyBoot = () => ({
  selectedBlockId: null as string | null,
  blocks: [] as Block[],
  availableBlocks: [] as typeof AVAILABLE_BLOCKS,
  emptySlots: [] as Array<{ row: number; col: number }>,
  master: {
    volume: 0,
    volumeMin: 0,
    volumeMax: 100,
    presetLevel: 0,
    presetLevelAvailable: false,
    presetLevelMin: -20,
    presetLevelMax: 20,
    presetLevelStep: 0.1,
    tempo: 120,
    tempoMin: 20,
    tempoMax: 300,
  } as MasterState,
  input: {
    gain1: null,
    gain2: null,
    connected1: null,
    connected2: null,
  } as InputState,
  eq: [] as EqBand[],
  eqEnabled: false,
  preset: {
    current: '',
    index: 0,
    names: [],
    favorites: [],
    recent: [],
  } as PresetState,
  lists: [] as LibraryList[],
  meters: { input: [-60, -60], output: [-60, -60] } as MeterState,
  activity: [] as ActivityEntry[],
  uploads: [] as UploadTask[],
  recentUpload: null as { target: string; slot: number; name: string } | null,
  tuner: { ...INITIAL_TUNER } as TunerState,
  save: {
    edited: false,
    saving: false,
    lastSaved: '',
    revision: 0,
  } as SaveState,
  connection: {
    connected: false,
    connecting: false,
    mode: 'device',
    autoSearch: 'idle',
    autoSearchMessage: '',
    transport: 'Not connected',
    deviceName: 'StompStation PRO',
    firmware: '',
    pollMs: 500,
    lastPollMs: 0,
    address: '',
  } as ConnectionState,
  demoAllowed: false,
});

const initialBoot = desktopRuntime ? emptyBoot() : demoBoot();

const buildDemoBlock = (
  available: { id: string; label: string; desc: string },
  footswitch: number,
  link: Block['link'] = 'series',
): Block => {
  if (available.id === 'parametric_eq') {
    const bands: Array<[string, number, number, number]> = [
      ['LPS', 90, 4, 0.7],
      ['BP', 640, 2.5, 1.2],
      ['BP', 3200, -2, 2.4],
      ['HPS', 9000, 3, 0.7],
    ];
    const controls = bands.flatMap(([type, frequency, gain, q], index) => {
      const base = `parametric_eq.eq_par`;
      return [
        {
          id: `${base}.band_${index}`,
          name: `band_${index}`,
          label: `Band ${index + 1} gain`,
          kind: 'float' as const,
          value: gain,
          defaultValue: 0,
          min: -15,
          max: 15,
          step: 0.1,
          unit: 'dB',
        },
        {
          id: `${base}.freq_${index}`,
          name: `freq_${index}`,
          label: `Band ${index + 1} frequency`,
          kind: 'float' as const,
          value: frequency,
          defaultValue: 1000,
          min: 50,
          max: 20000,
          step: 1,
          unit: 'Hz',
        },
        {
          id: `${base}.q_${index}`,
          name: `q_${index}`,
          label: `Band ${index + 1} Q`,
          kind: 'float' as const,
          value: q,
          defaultValue: 0.707,
          min: 0.1,
          max: 10,
          step: 0.05,
        },
        {
          id: `${base}.type_${index}`,
          name: `type_${index}`,
          label: `Band ${index + 1} type`,
          kind: 'choice' as const,
          value: type,
          defaultValue: 'BP',
          options: ['LPS', 'LP', 'BP', 'HP', 'HPS'],
        },
      ];
    });
    return {
      id: `${available.id}-${Date.now()}`,
      label: available.label,
      shortName: 'PEQ',
      family: 'utility',
      on: true,
      fixed: false,
      link,
      model: available.desc,
      footswitch,
      controls: [],
      groups: [
        {
          id: 'parametric_eq.eq_par',
          label: 'Parametric EQ',
          itemType: 'module',
          enabled: true,
          onOffId: 'parametric_eq.on_off',
          controls,
        },
      ],
    };
  }

  const family = (available.id === 'vxamp'
    ? 'vxamp'
    : ['chorus', 'flanger', 'rotary'].includes(available.id)
      ? 'mod'
      : 'utility') as Block['family'];
  return {
    id: `${available.id}-${Date.now()}`,
    label: available.label,
    shortName: available.label.toUpperCase(),
    family,
    on: true,
    fixed: false,
    link,
    model: available.desc,
    footswitch,
    controls: [
      {
        id: `${available.id}.rate`,
        name: 'rate',
        label: 'Rate',
        kind: 'float',
        value: 0.5,
        defaultValue: 0.5,
        min: 0,
        max: 10,
        step: 0.1,
        unit: 'Hz',
      },
      {
        id: `${available.id}.depth`,
        name: 'depth',
        label: 'Depth',
        kind: 'float',
        value: 40,
        defaultValue: 40,
        min: 0,
        max: 100,
        step: 1,
        unit: '%',
      },
      {
        id: `${available.id}.mix`,
        name: 'mix',
        label: 'Mix',
        kind: 'float',
        value: 35,
        defaultValue: 35,
        min: 0,
        max: 100,
        step: 1,
        unit: '%',
      },
    ],
    groups: [],
  };
};

const VIEWS: ViewId[] = ['board', 'amp', 'eq', 'library', 'settings', 'stage'];
const initialView = (): ViewId => {
  const hash = window.location.hash.replace('#', '');
  const view = VIEWS.includes(hash as ViewId) ? (hash as ViewId) : 'board';
  // Amp room is desktop-only; an old mobile deep link should land on Board.
  if (view === 'amp' && isMobileRuntime()) {
    try {
      window.history.replaceState(null, '', '#board');
    } catch {
      /* embedded webview may restrict history */
    }
    return 'board';
  }
  return view;
};

async function collectDevice(
  connectAddress?: string,
  password?: string,
  fullRefresh = false,
): Promise<{
  snapshot: Awaited<ReturnType<typeof tauriClient.getSnapshot>>;
  editors: Record<string, RustBlockEditor>;
  info: ConnectionInfo | null;
}> {
  const info = connectAddress
    ? await tauriClient.connect(connectAddress, password)
    : null;
  // A preset change invalidates the chain/router tree, so callers that need
  // the post-load state must force a fresh browse instead of reading the
  // actor's cached node tree.
  const snapshot = fullRefresh
    ? await tauriClient.refresh()
    : await tauriClient.getSnapshot();
  const editors: Record<string, RustBlockEditor> = {};
  for (const block of snapshot.chain.blocks) {
    editors[block.path] = await tauriClient.selectBlock(block.path);
  }
  return { snapshot, editors, info };
}

let lastTunerPoll = 0;
let tunerPollInFlight = false;
/** True after an explicit Disconnect so resume does not silently reconnect. */
let userDisconnected = false;
let lastExternalSignature = '';
let lastDeviceSnapshot: RustSnapshot | null = null;
const pendingBlockWrites = new Map<string, { on: boolean; until: number }>();
/// Global input gains are not preset data, so they are kept out of the
/// conflict system. Track the optimistic value briefly so a poll cannot
/// rewind a knob while its coalesced write is in flight.
const pendingInputWrites = new Map<string, { value: number; until: number }>();

type PendingWriteKind = 'control' | 'model' | 'master' | 'eq';
interface PendingDeviceWrite {
  id: string;
  kind: PendingWriteKind;
  label: string;
  localValue: ConflictValue;
  previousValue: ConflictValue;
  issuedAt: number;
  until: number;
  blockId?: string;
  controlId?: string;
  lane?: boolean;
  field?: string;
  index?: number;
}
const pendingDeviceWrites = new Map<string, PendingDeviceWrite>();
const recentLocalBlockWrites = new Map<string, number>();

const sameConflictValue = (left: ConflictValue, right: ConflictValue): boolean =>
  typeof left === 'number' && typeof right === 'number'
    ? Math.abs(left - right) < 1e-9
    : left === right;

const rememberPendingWrite = (
  entry: Omit<PendingDeviceWrite, 'issuedAt' | 'until'>,
): PendingDeviceWrite => {
  const issuedAt = Date.now();
  const pending = { ...entry, issuedAt, until: issuedAt + 2500 };
  pendingDeviceWrites.set(pending.id, pending);
  if (pending.blockId) recentLocalBlockWrites.set(pending.blockId, issuedAt);
  return pending;
};

const clearPendingWrite = (entry: PendingDeviceWrite): void => {
  if (pendingDeviceWrites.get(entry.id) === entry) {
    pendingDeviceWrites.delete(entry.id);
  }
};

const withControlState = (
  block: Block,
  controlId: string,
  value: ConflictValue,
  conflict?: boolean,
): Block => {
  const update = (controls: Block['controls']) =>
    controls.map((control) =>
      control.id === controlId
        ? { ...control, value, ...(conflict === undefined ? {} : { conflict }) }
        : control,
    );
  const updateGroup = (group: ControlGroup): ControlGroup => ({
    ...group,
    controls: update(group.controls),
    groups: group.groups?.map(updateGroup),
  });
  return {
    ...block,
    controls: update(block.controls),
    groups: block.groups.map(updateGroup),
    secondLane: block.secondLane
      ? { ...block.secondLane, controls: update(block.secondLane.controls) }
      : undefined,
  };
};

const withModelState = (
  block: Block,
  model: ConflictValue,
  lane: boolean,
): Block =>
  lane && block.secondLane
    ? { ...block, secondLane: { ...block.secondLane, model: String(model) } }
    : { ...block, model: String(model) };

const blockValuesDiffer = (left: Block, right: Block): boolean => {
  if (left.model !== right.model) return true;
  if (left.secondLane?.model !== right.secondLane?.model) return true;
  const leftValues = new Map(
    allBlockControls(left).map((control) => [control.id, control.value]),
  );
  const rightValues = allBlockControls(right);
  if (leftValues.size !== rightValues.length) return true;
  return rightValues.some((control) => {
    const local = leftValues.get(control.id);
    return local === undefined || !sameConflictValue(local, control.value);
  });
};

const pendingStatePatch = (
  state: AppStore,
  pending: PendingDeviceWrite,
  value: ConflictValue,
): Partial<AppStore> => {
  if (pending.kind === 'control' && pending.blockId && pending.controlId) {
    return {
      blocks: state.blocks.map((block) =>
        block.id === pending.blockId
          ? withControlState(block, pending.controlId!, value, false)
          : block,
      ),
    };
  }
  if (pending.kind === 'model' && pending.blockId) {
    return {
      blocks: state.blocks.map((block) =>
        block.id === pending.blockId
          ? withModelState(block, value, Boolean(pending.lane))
          : block,
      ),
    };
  }
  if (pending.kind === 'master' && pending.field) {
    return {
      master: { ...state.master, [pending.field]: Number(value) } as MasterState,
    };
  }
  if (pending.kind === 'eq') {
    if (pending.id === 'eq.enabled') {
      return { eqEnabled: Boolean(value) };
    }
    return {
      eq: state.eq.map((band) =>
        band.index === pending.index
          ? {
              ...band,
              [pending.field!]:
                pending.field === 'type' ? String(value) : Number(value),
            }
          : band,
      ),
    };
  }
  return {};
};

const conflictStatePatch = (
  state: AppStore,
  conflict: DeviceConflict,
  value: ConflictValue,
): Partial<AppStore> => {
  if (conflict.kind === 'control' && conflict.blockId && conflict.controlId) {
    return {
      blocks: state.blocks.map((block) =>
        block.id === conflict.blockId
          ? withControlState(block, conflict.controlId!, value, false)
          : block,
      ),
    };
  }
  if (conflict.kind === 'model' && conflict.blockId) {
    return {
      blocks: state.blocks.map((block) =>
        block.id === conflict.blockId
          ? withModelState(block, value, Boolean(conflict.lane))
          : block,
      ),
    };
  }
  if (conflict.kind === 'master' && conflict.field) {
    return {
      master: { ...state.master, [conflict.field]: Number(value) } as MasterState,
    };
  }
  if (conflict.kind === 'eq') {
    if (conflict.id === 'eq.enabled') {
      return { eqEnabled: Boolean(value) };
    }
    return {
      eq: state.eq.map((band) =>
        band.index === conflict.index
          ? {
              ...band,
              [conflict.field!]:
                conflict.field === 'type' ? String(value) : Number(value),
            }
          : band,
      ),
    };
  }
  return {};
};

let deviceReplaying = false;

const mergeDeviceOperation = (
  top: DeviceOperation,
  operation: DeviceOperation,
): DeviceOperation | null => {
  if (top.key !== operation.key || top.kind !== operation.kind) return null;
  if (top.kind === 'control' && operation.kind === 'control') {
    return { ...top, after: operation.after };
  }
  if (top.kind === 'model' && operation.kind === 'model') {
    return { ...top, after: operation.after };
  }
  if (top.kind === 'master' && operation.kind === 'master') {
    return { ...top, after: operation.after };
  }
  if (top.kind === 'eq' && operation.kind === 'eq') {
    return {
      ...top,
      before: { ...operation.before, ...top.before },
      after: { ...top.after, ...operation.after },
    };
  }
  if (top.kind === 'eq-enabled' && operation.kind === 'eq-enabled') {
    return { ...top, after: operation.after };
  }
  return null;
};

const operationStatePatch = (
  state: AppStore,
  operation: DeviceOperation,
  direction: 'undo' | 'redo',
): Partial<AppStore> => {
  const value = direction === 'undo' ? 'before' : 'after';
  if (operation.kind === 'control') {
    return {
      blocks: state.blocks.map((block) =>
        block.id === operation.blockId
          ? withControlState(block, operation.path, operation[value], false)
          : block,
      ),
    };
  }
  if (operation.kind === 'block-preset') {
    const values = Object.fromEntries(
      operation.changes.map((change) => [
        change.path,
        direction === 'undo' ? change.before : change.after,
      ]),
    );
    return {
      blocks: state.blocks.map((block) =>
        block.id === operation.blockId
          ? applyPresetValuesToBlock(block, values)
          : block,
      ),
    };
  }
  if (operation.kind === 'model') {
    return {
      blocks: state.blocks.map((block) =>
        block.id === operation.blockId
          ? withModelState(block, operation[value], operation.lane)
          : block,
      ),
    };
  }
  if (operation.kind === 'toggle') {
    return {
      blocks: state.blocks.map((block) =>
        block.id === operation.blockId
          ? { ...block, on: operation[value] }
          : block,
      ),
    };
  }
  if (operation.kind === 'lane-enabled') {
    return {
      blocks: state.blocks.map((block) =>
        block.id === operation.blockId && block.secondLane
          ? {
              ...block,
              secondLane: { ...block.secondLane, enabled: operation[value] },
            }
          : block,
      ),
    };
  }
  if (operation.kind === 'master') {
    return {
      master: {
        ...state.master,
        [operation.field]: operation[value],
      } as MasterState,
    };
  }
  if (operation.kind === 'eq') {
    return {
      eq: state.eq.map((band) =>
        band.index === operation.index
          ? { ...band, ...operation[value] } as EqBand
          : band,
      ),
    };
  }
  if (operation.kind === 'eq-enabled') {
    return {
      eqEnabled: operation[value],
      eq: state.eq.map((band) => ({ ...band, enabled: operation[value] })),
    };
  }
  if (operation.kind === 'eq-bulk') {
    return {
      eq: state.eq.map((band) => {
        const change = operation.changes.find((item) => item.index === band.index);
        return change
          ? { ...band, gain: direction === 'undo' ? change.before : change.after }
          : band;
      }),
    };
  }
  return {};
};

async function applyDeviceOperation(
  operation: DeviceOperation,
  direction: 'undo' | 'redo',
): Promise<void> {
  let revision: number | null = null;
  if (operation.kind === 'control') {
    const snapshot = await tauriClient.setControl(
      operation.path,
      direction === 'undo' ? operation.before : operation.after,
    );
    revision = snapshot.revision;
  } else if (operation.kind === 'block-preset') {
    for (const change of operation.changes) {
      const snapshot = await tauriClient.setControl(
        change.path,
        direction === 'undo' ? change.before : change.after,
      );
      revision = snapshot.revision;
    }
  } else if (operation.kind === 'model') {
    const snapshot = await tauriClient.setControl(
      operation.path,
      direction === 'undo' ? operation.before : operation.after,
    );
    revision = snapshot.revision;
  } else if (operation.kind === 'toggle') {
    const snapshot = await tauriClient.setBlock(
      operation.blockId,
      direction === 'undo' ? operation.before : operation.after,
    );
    revision = snapshot.revision;
  } else if (operation.kind === 'lane-enabled') {
    const lane = useAppStore
      .getState()
      .blocks.find((block) => block.id === operation.blockId)?.secondLane;
    if (lane?.onOffId) {
      const snapshot = await tauriClient.setControl(
        lane.onOffId,
        (direction === 'undo' ? operation.before : operation.after) ? 'ON' : 'OFF',
      );
      revision = snapshot.revision;
    }
  } else if (operation.kind === 'master') {
    const snapshot = await tauriClient.setMaster(
      operation.field === 'presetLevel' ? 'preset_level' : operation.field,
      direction === 'undo' ? operation.before : operation.after,
    );
    revision = snapshot.revision;
  } else if (operation.kind === 'eq') {
    const patch = direction === 'undo' ? operation.before : operation.after;
    for (const [field, value] of Object.entries(patch)) {
      const snapshot =
        field === 'type'
          ? await tauriClient.setEqType(operation.deviceIndex, String(value))
          : await tauriClient.setEqBand(operation.deviceIndex, field, Number(value));
      revision = snapshot.revision;
    }
  } else if (operation.kind === 'eq-enabled') {
    const snapshot = await tauriClient.setEqEnabled(
      direction === 'undo' ? operation.before : operation.after,
    );
    revision = snapshot.revision;
  } else if (operation.kind === 'eq-bulk') {
    for (const change of operation.changes) {
      const snapshot = await tauriClient.setEqBand(
        change.deviceIndex,
        'gain',
        direction === 'undo' ? change.before : change.after,
      );
      revision = snapshot.revision;
    }
  } else if (operation.kind === 'chain') {
    await tauriClient.editChain(
      (direction === 'undo'
        ? operation.inverse
        : operation.edit) as unknown as Record<string, unknown>,
    );
    await useAppStore.getState().refreshDevice();
  } else if (operation.kind === 'chain-clear') {
    if (direction === 'undo') {
      for (const item of operation.restore) {
        await tauriClient.editChain({
          type: 'add',
          row: item.row,
          col: item.col,
          path: item.path,
        });
      }
    } else {
      await tauriClient.editChain({ type: 'clear' });
    }
    await useAppStore.getState().refreshDevice();
  }
  if (
    operation.kind === 'model' ||
    (operation.kind === 'control' && operation.path.endsWith('\\type'))
  ) {
    await useAppStore.getState().refreshDevice();
    revision = null;
  }
  const state = useAppStore.getState();
  useAppStore.setState({
    ...operationStatePatch(state, operation, direction),
    save: {
      ...state.save,
      edited: true,
      ...(revision != null ? { revision } : {}),
    },
  });
}

export const useAppStore = create<AppStore>()((set, get) => ({
  view: initialView(),
  mobileBoardPane: 'chain',
  ...initialBoot,
  theme: appearance.theme,
  density: appearance.density,
  motion: appearance.motion,
  compactChain: loadCompactChain(),
  pending: [],
  conflicts: [],
  deviceUndoStack: [],
  deviceRedoStack: [],
  undoStack: [],
  redoStack: [],
  commandOpen: false,
  presetDrawerOpen: false,
  connectionOpen: false,
  tunerOpen: false,
  activityOpen: false,
  shortcutsOpen: false,
  toast: null,
  appVersion: '',
  lastEdit: { key: '', at: 0 },

  setView: (view) => {
    // Amp room is a desktop visualisation; phones edit the amp block in the
    // normal inspector instead.
    const next = view === 'amp' && isMobileRuntime() ? 'board' : view;
    set({ view: next, commandOpen: false, mobileBoardPane: 'chain' });
    try {
      window.history.replaceState(null, '', `#${next}`);
    } catch {
      /* embedded webview may restrict history */
    }
  },

  setMobileBoardPane: (pane) => set({ mobileBoardPane: pane }),

  selectBlock: (id) => set({ selectedBlockId: id }),

  setPreset: (index) => {
    const { preset } = get();
    const name = preset.names[index];
    if (!name) return;
    const recent = [name, ...preset.recent.filter((item) => item !== name)].slice(0, 6);
    pendingBlockWrites.clear();
    pendingInputWrites.clear();
    pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
    set({
      preset: { ...preset, current: name, index, recent },
      mobileBoardPane: 'chain',
      conflicts: [],
      deviceUndoStack: [],
      deviceRedoStack: [],
      save: { ...get().save, edited: false, revision: get().save.revision + 1 },
    });
    get().addActivity('Preset loaded', `${name} · slot ${index + 1}`, 'neutral');
    get().notify(`Loaded ${name}`, 'good');
    if (get().connection.mode === 'device') {
      tauriClient
        .setPreset(name)
        // The write only updates the preset node. Force a fresh browse so the
        // new router/chain tree arrives without waiting for the 2 s poll.
        .then(() => get().refreshDevice(true))
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
  },

  savePreset: () => {
    const { preset, save, connection } = get();
    if (save.saving) return;
    set({ save: { ...save, saving: true } });
    if (connection.mode === 'device') {
      void (async () => {
        // Never let the save command overtake a coalesced knob/model write.
        await flushCoalesced((message) => get().notify(message, 'bad'));
        try {
          const snapshot = await tauriClient.savePreset();
          set((state) => ({
            save: {
              ...state.save,
              saving: false,
              edited: false,
              lastSaved: now(),
              revision: snapshot.revision,
            },
          }));
          const name = get().preset.current;
          get().addActivity('Preset saved', name, 'good');
          get().notify(`Saved ${name}`, 'good');
        } catch (error) {
          set((state) => ({ save: { ...state.save, saving: false } }));
          get().notify(ipcErrorMessage(error), 'bad');
        }
      })();
      return;
    }
    window.setTimeout(() => {
      const current = get().save;
      set({
        save: {
          ...current,
          saving: false,
          edited: false,
          lastSaved: now(),
          revision: current.revision + 1,
        },
      });
      get().addActivity('Preset saved', preset.current, 'good');
      get().notify(`Saved ${preset.current}`, 'good');
    }, 420);
  },

  savePresetAs: (name) => {
    const trimmed = name.trim();
    const problem = presetNameError(trimmed);
    if (problem) {
      get().notify(problem, 'bad');
      return false;
    }
    const { preset, save, connection } = get();
    if (
      preset.names.some(
        (existing) =>
          existing.trim().length > 0 &&
          existing.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      get().notify(`A preset named “${trimmed}” already exists`, 'bad');
      return false;
    }
    if (save.saving) return false;
    set({ save: { ...save, saving: true } });

    if (connection.mode === 'device') {
      void (async () => {
        // Never let the save command overtake a coalesced knob/model write.
        await flushCoalesced((message) => get().notify(message, 'bad'));
        try {
          const snapshot = await tauriClient.savePreset(trimmed);
          const mapped = mapPreset(snapshot, get().preset);
          const names = mapped.names.some(
            (item) => item.toLowerCase() === trimmed.toLowerCase(),
          )
            ? mapped.names
            : [...mapped.names, trimmed];
          const index = names.findIndex(
            (item) => item.toLowerCase() === trimmed.toLowerCase(),
          );
          set((state) => ({
            preset: {
              ...mapped,
              names,
              current: index >= 0 ? names[index] : trimmed,
              index: index >= 0 ? index : state.preset.index,
            },
            lists: mapLists(snapshot),
            save: {
              ...state.save,
              saving: false,
              edited: false,
              lastSaved: now(),
              revision: snapshot.revision,
            },
          }));
          get().addActivity('Preset saved as', trimmed, 'good');
          get().notify(`Saved as ${trimmed}`, 'good');
          window.setTimeout(() => void get().refreshDevice(), 300);
        } catch (error) {
          set((state) => ({ save: { ...state.save, saving: false } }));
          get().notify(ipcErrorMessage(error), 'bad');
        }
      })();
      return true;
    }

    window.setTimeout(() => {
      const state = get();
      const names = [...state.preset.names];
      const existing = names.findIndex(
        (item) => item.toLowerCase() === trimmed.toLowerCase(),
      );
      let index = existing;
      if (index >= 0) {
        names[index] = trimmed;
      } else {
        const blank = names.findIndex((item) => !item.trim());
        if (blank >= 0) {
          names[blank] = trimmed;
          index = blank;
        } else {
          names.push(trimmed);
          index = names.length - 1;
        }
      }
      set({
        preset: { ...state.preset, names, current: trimmed, index },
        save: {
          ...state.save,
          saving: false,
          edited: false,
          lastSaved: now(),
          revision: state.save.revision + 1,
        },
      });
      get().addActivity('Preset saved as', trimmed, 'good');
      get().notify(`Saved as ${trimmed}`, 'good');
    }, 420);
    return true;
  },

  renamePreset: (oldName, newName) => {
    const trimmed = newName.trim();
    const problem = presetNameError(trimmed);
    if (problem) {
      get().notify(problem, 'bad');
      return;
    }
    const { preset } = get();
    if (
      preset.names.some(
        (name) => name && name !== oldName && name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      get().notify(`A preset named “${trimmed}” already exists`, 'bad');
      return;
    }
    const names = preset.names.map((name) => (name === oldName ? trimmed : name));
    const wasCurrent = preset.current === oldName;
    set({
      preset: {
        ...preset,
        names,
        current: wasCurrent ? trimmed : preset.current,
      },
    });
    get().addActivity('Preset renamed', `${oldName} → ${trimmed}`, 'good');
    get().notify(`Renamed to ${trimmed}`, 'good');
    if (get().connection.mode === 'device') {
      tauriClient
        .renamePreset(oldName, trimmed)
        .then(() => window.setTimeout(() => void get().refreshDevice(), 250))
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
    }
  },

  exportPreset: async (index, destination) => {
    const state = get();
    if (state.connection.mode !== 'device') {
      state.notify('Connect to a pedal to export a preset bundle', 'warn');
      return false;
    }
    try {
      const saveTarget = prepareAndroidSaveTarget(
        destination,
        `preset-${index + 1}.zip`,
      );
      const result = await tauriClient.exportPreset(index, saveTarget.rustPath, true);
      commitAndroidSaveTarget(saveTarget);
      state.addActivity(
        'Preset exported',
        `${result.preset_name} · ${result.dependencies.length} dependencies · ${formatBytes(result.bytes)}`,
        'good',
      );
      state.notify(`${result.preset_name} exported`, 'good');
      return true;
    } catch (error) {
      state.notify(ipcErrorMessage(error), 'bad');
      return false;
    }
  },

  importPreset: async (
    bundlePath,
    targetSlot,
    overwritePreset,
    overwriteDependencies,
  ) => {
    const state = get();
    if (state.connection.mode !== 'device') {
      state.notify('Connect to a pedal to import a preset bundle', 'warn');
      return null;
    }
    try {
      const completion = await tauriClient.importPresetBundle(
        bundlePath,
        targetSlot,
        overwritePreset,
        overwriteDependencies,
      );
      state.applyDeviceSnapshot(completion.snapshot);
      const name = completion.snapshot.preset.names[targetSlot];
      set((current) => ({
        lists: mapLists(completion.snapshot),
        preset: {
          ...current.preset,
          names: completion.snapshot.preset.names,
          current: name ?? current.preset.current,
          index: name ? targetSlot : current.preset.index,
        },
        save: {
          ...current.save,
          revision: completion.snapshot.revision,
          edited: false,
          lastSaved: now(),
        },
      }));
      state.addActivity(
        'Preset imported',
        `${completion.report.preset_name} · slot ${targetSlot + 1} · ` +
          `${completion.report.dependencies_written.length} written, ` +
          `${completion.report.dependencies_reused.length} reused`,
        'good',
      );
      state.notify(`${completion.report.preset_name} imported`, 'good');
      if (name) get().setPreset(targetSlot);
      return completion.report;
    } catch (error) {
      const message = ipcErrorMessage(error);
      state.notify(message, 'bad');
      // Toast messages disappear after 2.6 s; keep the failure in the
      // activity drawer so the exact error can be read or copied later.
      state.addActivity('Preset import failed', message, 'bad');
      void get().refreshDevice();
      return null;
    }
  },

  renameCapture: (listId, index, newName) => {
    const trimmed = newName.trim();
    const problem = listNameError(trimmed);
    if (problem) {
      get().notify(problem, 'bad');
      return;
    }
    const { lists, connection } = get();
    const list = lists.find((item) => item.id === listId);
    const slot = list?.slots[index];
    if (!list || !slot?.used) {
      get().notify('That capture slot is empty', 'warn');
      return;
    }
    if (slot.usedBy?.length) {
      const names = slot.usedBy
        .map((presetIndex) => get().preset.names[presetIndex] || `slot ${presetIndex + 1}`)
        .join(', ');
      get().notify(
        `“${slot.name}” is used by ${names}; rename is blocked until firmware reference updates are verified`,
        'warn',
      );
      return;
    }
    if (
      list.slots.some(
        (entry) =>
          entry.index !== index &&
          entry.name &&
          entry.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      get().notify(`A capture named “${trimmed}” already exists in this list`, 'bad');
      return;
    }

    const detail = `${slot.name} → ${trimmed} · ${list.label} slot ${index + 1}`;
    if (connection.mode === 'device') {
      tauriClient
        .renameListItem(uploadTargetPath(listId), index, trimmed)
        .then((snapshot) => {
          get().applyDeviceSnapshot(snapshot);
          get().addActivity('Capture renamed', detail, 'good');
          get().notify(`${slot.name} renamed to ${trimmed}`, 'good');
          // An active loader may still hold the old name; refresh the block
          // editor so the UI shows what the firmware actually resolves.
          if (slot.active) {
            window.setTimeout(() => void get().refreshDevice(), 250);
          }
        })
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
      return;
    }

    set((state) => ({
      lists: state.lists.map((item) =>
        item.id === listId
          ? {
              ...item,
              slots: item.slots.map((entry) =>
                entry.index === index ? { ...entry, name: trimmed } : entry,
              ),
            }
          : item,
      ),
    }));
    get().addActivity('Capture renamed', detail, 'good');
    get().notify(`${slot.name} renamed to ${trimmed}`, 'good');
  },

  deletePreset: (index) => {
    const { preset, connection } = get();
    const name = preset.names[index];
    if (!name || !name.trim()) {
      get().notify('That preset slot is already empty', 'warn');
      return;
    }
    if (connection.mode === 'device') {
      const listPath = preset.listPath ?? 'root\\presets';
      tauriClient
        .deleteListItem(listPath, index)
        .then((snapshot) => {
          get().applyDeviceSnapshot(snapshot);
          set((state) => ({
            preset: {
              ...state.preset,
              favorites: state.preset.favorites.filter((item) => item !== name),
              recent: state.preset.recent.filter((item) => item !== name),
            },
          }));
          get().addActivity('Preset deleted', `${name} · slot ${index + 1}`, 'warn');
          get().notify(`${name} deleted`, 'good');
        })
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
      return;
    }
    const wasCurrent = preset.current === name;
    set({
      preset: {
        ...preset,
        names: preset.names.map((item, itemIndex) => (itemIndex === index ? '' : item)),
        current: wasCurrent ? '' : preset.current,
        index: wasCurrent ? 0 : preset.index,
        favorites: preset.favorites.filter((item) => item !== name),
        recent: preset.recent.filter((item) => item !== name),
      },
    });
    get().addActivity('Preset deleted', `${name} · slot ${index + 1}`, 'warn');
    get().notify(`${name} deleted`, 'good');
  },

  deleteCapture: (listId, index) => {
    const { lists, connection } = get();
    const list = lists.find((item) => item.id === listId);
    const slot = list?.slots[index];
    if (!list || !slot?.used) {
      get().notify('That capture slot is already empty', 'warn');
      return;
    }
    if (connection.mode === 'device') {
      tauriClient
        .deleteListItem(uploadTargetPath(listId), index)
        .then((snapshot) => {
          get().applyDeviceSnapshot(snapshot);
          get().addActivity(
            'Capture deleted',
            `${slot.name} · ${list.label} slot ${index + 1}`,
            'warn',
          );
          get().notify(`${slot.name} deleted`, 'good');
        })
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
      return;
    }
    set((state) => ({
      lists: state.lists.map((item) =>
        item.id === listId
          ? {
              ...item,
              activeSlot: item.activeSlot === index ? undefined : item.activeSlot,
              slots: item.slots.map((entry) =>
                entry.index === index
                  ? { ...entry, name: '', used: false, active: false }
                  : entry,
              ),
            }
          : item,
      ),
    }));
    get().addActivity(
      'Capture deleted',
      `${slot.name} · ${list.label} slot ${index + 1}`,
      'warn',
    );
    get().notify(`${slot.name} deleted`, 'good');
  },

  deletePresets: async (indices) => {
    const { preset, connection } = get();
    const targets = [...new Set(indices)]
      .sort((left, right) => left - right)
      .map((index) => ({ index, name: (preset.names[index] ?? '').trim() }))
      .filter((target) => target.name);
    if (targets.length === 0) {
      get().notify('No preset slots selected', 'warn');
      return;
    }
    const slots = targets.map((target) => target.index + 1).join(', ');
    if (connection.mode === 'device') {
      const listPath = preset.listPath ?? 'root\\presets';
      let lastSnapshot: RustSnapshot | null = null;
      const deleted: typeof targets = [];
      let failure: string | null = null;
      for (const target of targets) {
        try {
          lastSnapshot = await tauriClient.deleteListItem(listPath, target.index);
          deleted.push(target);
        } catch (error) {
          failure = ipcErrorMessage(error);
          break;
        }
      }
      if (lastSnapshot) get().applyDeviceSnapshot(lastSnapshot);
      if (failure) {
        await get().refreshDevice();
      }
      const deletedNames = new Set(deleted.map((target) => target.name));
      set((state) => ({
        preset: {
          ...state.preset,
          favorites: state.preset.favorites.filter((name) => !deletedNames.has(name)),
          recent: state.preset.recent.filter((name) => !deletedNames.has(name)),
        },
      }));
      if (failure) {
        get().addActivity(
          'Preset deletion failed',
          `${deleted.length} of ${targets.length} deleted · ${failure}`,
          'bad',
        );
        get().notify(
          `Deleted ${deleted.length} of ${targets.length} presets: ${failure}`,
          'bad',
        );
      } else {
        get().addActivity(
          'Presets deleted',
          `${deleted.length} presets · slots ${slots}`,
          'warn',
        );
        get().notify(`Deleted ${deleted.length} presets`, 'good');
      }
      return;
    }

    const deletedNames = new Set(targets.map((target) => target.name));
    set((state) => {
      const wasCurrent = targets.some(
        (target) => state.preset.names[target.index] === state.preset.current,
      );
      return {
        preset: {
          ...state.preset,
          names: state.preset.names.map((name, index) =>
            targets.some((target) => target.index === index) ? '' : name,
          ),
          current: wasCurrent ? '' : state.preset.current,
          index: wasCurrent ? 0 : state.preset.index,
          favorites: state.preset.favorites.filter((name) => !deletedNames.has(name)),
          recent: state.preset.recent.filter((name) => !deletedNames.has(name)),
        },
      };
    });
    get().addActivity('Presets deleted', `${targets.length} presets · slots ${slots}`, 'warn');
    get().notify(`Deleted ${targets.length} presets`, 'good');
  },

  deleteCaptures: async (listId, indices) => {
    const { lists, connection } = get();
    const list = lists.find((item) => item.id === listId);
    const targets = [...new Set(indices)]
      .sort((left, right) => left - right)
      .map((index) => list?.slots[index])
      .filter((slot): slot is LibrarySlot => Boolean(slot?.used));
    if (!list || targets.length === 0) {
      get().notify('No capture slots selected', 'warn');
      return;
    }
    const slots = targets.map((slot) => slot.index + 1).join(', ');
    if (connection.mode === 'device') {
      let lastSnapshot: RustSnapshot | null = null;
      const deleted: typeof targets = [];
      let failure: string | null = null;
      for (const target of targets) {
        try {
          lastSnapshot = await tauriClient.deleteListItem(
            uploadTargetPath(listId),
            target.index,
          );
          deleted.push(target);
        } catch (error) {
          failure = ipcErrorMessage(error);
          break;
        }
      }
      if (lastSnapshot) get().applyDeviceSnapshot(lastSnapshot);
      if (failure) {
        await get().refreshDevice();
        get().addActivity(
          'Capture deletion failed',
          `${deleted.length} of ${targets.length} deleted · ${list.label} · ${failure}`,
          'bad',
        );
        get().notify(
          `Deleted ${deleted.length} of ${targets.length} captures: ${failure}`,
          'bad',
        );
      } else {
        get().addActivity(
          'Captures deleted',
          `${deleted.length} captures · ${list.label} · slots ${slots}`,
          'warn',
        );
        get().notify(`Deleted ${deleted.length} captures`, 'good');
      }
      return;
    }

    const selected = new Set(targets.map((slot) => slot.index));
    set((state) => ({
      lists: state.lists.map((item) =>
        item.id === listId
          ? {
              ...item,
              activeSlot:
                item.activeSlot != null && selected.has(item.activeSlot)
                  ? undefined
                  : item.activeSlot,
              slots: item.slots.map((entry) =>
                selected.has(entry.index)
                  ? { ...entry, name: '', used: false, active: false, usedBy: [] }
                  : entry,
              ),
            }
          : item,
      ),
    }));
    get().addActivity(
      'Captures deleted',
      `${targets.length} captures · ${list.label} · slots ${slots}`,
      'warn',
    );
    get().notify(`Deleted ${targets.length} captures`, 'good');
  },

  addPreset: () => {
    if (get().connection.mode === 'device') {
      get().notify('New patch creation is not exposed by firmware 2.5.3', 'warn');
      return;
    }
    const { preset } = get();
    const existing = new Set(preset.names.map((name) => name.toLowerCase()));
    let index = 1;
    let name = 'New Patch';
    while (existing.has(name.toLowerCase())) {
      index += 1;
      name = `New Patch ${index}`;
    }
    const names = [...preset.names, name];
    set({
      preset: { ...preset, names, current: name, index: names.length - 1 },
      save: { ...get().save, edited: true },
    });
    get().addActivity('Preset created', name, 'good');
    get().notify(`${name} created`, 'good');
  },

  toggleFavorite: (name) => {
    const { preset } = get();
    const favorites = preset.favorites.includes(name)
      ? preset.favorites.filter((item) => item !== name)
      : [...preset.favorites, name];
    set({ preset: { ...preset, favorites } });
  },

  toggleBlock: (id) => {
    const before = snapshotOf(get());
    const block = get().blocks.find((item) => item.id === id);
    if (!block) return;
    const on = !block.on;
    set((state) => ({
      blocks: state.blocks.map((item) => (item.id === id ? { ...item, on } : item)),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
      pending: [...state.pending, id],
    }));
    get().addActivity(
      `${block.shortName} bypass`,
      `${on ? 'ON' : 'OFF'} · ${block.label}`,
      on ? 'good' : 'neutral',
    );
    window.setTimeout(() => {
      set((state) => ({ pending: state.pending.filter((item) => item !== id) }));
    }, 260);
    if (get().connection.mode === 'device') {
      get().recordDeviceOperation({
        kind: 'toggle',
        key: `toggle:${id}`,
        label: `${block.label} bypass`,
        blockId: id,
        before: block.on,
        after: on,
      });
      pendingBlockWrites.set(id, { on, until: Date.now() + 1600 });
      tauriClient
        .setBlock(block.id, on)
        .then((snapshot) =>
          set((state) => ({ save: { ...state.save, revision: snapshot.revision } })),
        )
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
    }
  },

  setBlockModel: (blockId, model) => {
    const before = snapshotOf(get());
    const previousModel =
      get().blocks.find((block) => block.id === blockId)?.model ?? model;
    set((state) => ({
      blocks: state.blocks.map((block) =>
        block.id === blockId
          ? {
              ...block,
              model,
              label: `${block.shortName.replace(' / NAM', '')} · ${model}`,
            }
          : block,
      ),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    }));
    get().addActivity('Model changed', model, 'neutral');
    const updated = get().blocks.find((block) => block.id === blockId);
    if (get().connection.mode === 'device' && updated?.modelControlId) {
      get().recordDeviceOperation({
        kind: 'model',
        key: `model.${blockId}`,
        label: 'Model',
        blockId,
        lane: false,
        path: updated.modelControlId,
        before: previousModel,
        after: model,
      });
      const pendingEntry = rememberPendingWrite({
        id: `model.${blockId}`,
        kind: 'model',
        label: 'Model',
        localValue: model,
        previousValue: previousModel,
        blockId,
        controlId: updated.modelControlId,
      });
      coalesce(
        `model.${blockId}`,
        () => tauriClient.setControl(updated.modelControlId!, model),
        (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
        () => clearPendingWrite(pendingEntry),
      );
      // A PNAM model supplies the labels/ranges for p1..pN, so rebrowse the
      // editor after the write instead of leaving stale parameter controls.
      window.setTimeout(() => void get().refreshDevice(), 350);
      if (updated.modelControlId.endsWith('\\pmodel')) {
        window.setTimeout(() => void get().refreshDevice(), 1_050);
      }
    }
  },

  setLaneModel: (blockId, model) => {
    const previousModel =
      get().blocks.find((block) => block.id === blockId)?.secondLane?.model ?? model;
    set((state) => ({
      blocks: state.blocks.map((block) =>
        block.id === blockId && block.secondLane
          ? { ...block, secondLane: { ...block.secondLane, model } }
          : block,
      ),
      save: { ...state.save, edited: true },
    }));
    get().addActivity('Model changed', `${model} · lane 2`, 'neutral');
    const lane = get().blocks.find((block) => block.id === blockId)?.secondLane;
    if (get().connection.mode === 'device' && lane?.modelControlId) {
      get().recordDeviceOperation({
        kind: 'model',
        key: `model.${blockId}.lane`,
        label: 'Dual amp model',
        blockId,
        lane: true,
        path: lane.modelControlId,
        before: previousModel,
        after: model,
      });
      const pendingEntry = rememberPendingWrite({
        id: `model.${blockId}.lane`,
        kind: 'model',
        label: 'Dual amp model',
        localValue: model,
        previousValue: previousModel,
        blockId,
        controlId: lane.modelControlId,
        lane: true,
      });
      coalesce(
        `lane.${blockId}`,
        () => tauriClient.setControl(lane.modelControlId!, model),
        (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
        () => clearPendingWrite(pendingEntry),
      );
    }
  },

  setLaneEnabled: (blockId, enabled) => {
    const block = get().blocks.find((item) => item.id === blockId);
    const previous = block?.secondLane?.enabled ?? !enabled;
    set((state) => ({
      blocks: state.blocks.map((item) =>
        item.id === blockId && item.secondLane
          ? { ...item, secondLane: { ...item.secondLane, enabled } }
          : item,
      ),
      save: { ...state.save, edited: true },
    }));
    get().notify(`NAM 2 ${enabled ? 'enabled' : 'disabled'}`, 'neutral');
    const lane = get().blocks.find((item) => item.id === blockId)?.secondLane;
    if (get().connection.mode === 'device' && lane?.onOffId) {
      get().recordDeviceOperation({
        kind: 'lane-enabled',
        key: `lane-on:${blockId}`,
        label: `${block?.label ?? 'Dual amp'} lane 2`,
        blockId,
        before: previous,
        after: enabled,
      });
      coalesce(
        `lane-on.${blockId}`,
        () => tauriClient.setControl(lane.onOffId!, enabled ? 'ON' : 'OFF'),
        (message) => get().notify(message, 'bad'),
      );
    }
  },

  setControl: (controlId, value) => {
    const state = get();
    const before = snapshotOf(state);
    const firstInGroup = state.lastEdit.key !== controlId ||
      Date.now() - state.lastEdit.at > 600;
    const target = state.blocks
      .map((block) => ({ block, control: blockControl(block, controlId) }))
      .find((entry) => entry.control);
    const isTypeChange = target?.control?.name === 'type';
    const isLaneTypeChange =
      isTypeChange &&
      Boolean(target?.block.secondLane?.controls.some((control) => control.id === controlId));
    const apply = <T extends { id: string; value: number | string | boolean }>(control: T): T =>
      control.id === controlId ? { ...control, value } : control;
    const updateGroup = (group: ControlGroup): ControlGroup => ({
      ...group,
      modeValue: group.modePath === controlId ? String(value) : group.modeValue,
      enabled:
        group.onOffId === controlId
          ? value === 'ON' || value === true
          : group.enabled,
      controls: group.controls.map(apply),
      groups: group.groups?.map(updateGroup),
    });
    set({
      blocks: state.blocks.map((block) => {
        const updated = {
          ...block,
          controls: block.controls.map(apply),
          groups: block.groups.map(updateGroup),
          secondLane: block.secondLane
            ? { ...block.secondLane, controls: block.secondLane.controls.map(apply) }
            : undefined,
        };
        if (
          !isTypeChange ||
          block.id !== target?.block.id ||
          state.connection.mode !== 'demo'
        ) {
          return updated;
        }
        if (isLaneTypeChange && updated.secondLane) {
          const nextLane = applyDemoLaneType(updated.secondLane, String(value));
          return {
            ...updated,
            secondLane: nextLane,
            groups: updated.groups.map((group) =>
              group.id === nextLane.id
                ? {
                    ...group,
                    controls: group.controls.map((control) => {
                      if (control.name === 'type') {
                        return { ...control, value };
                      }
                      if (control.name === 'model') {
                        return {
                          ...control,
                          value: nextLane.model,
                          options: nextLane.modelOptions,
                        };
                      }
                      return control;
                    }),
                  }
                : group,
            ),
          };
        }
        return applyDemoBlockType(updated, String(value));
      }),
      undoStack: firstInGroup
        ? [...state.undoStack, before].slice(-40)
        : state.undoStack,
      redoStack: firstInGroup ? [] : state.redoStack,
      save: { ...state.save, edited: true },
      pending: state.pending.includes(controlId)
        ? state.pending
        : [...state.pending, controlId],
      lastEdit: { key: controlId, at: Date.now() },
    });
    window.setTimeout(() => {
      set((current) => ({
        pending: current.pending.filter((item) => item !== controlId),
      }));
    }, 240);
    if (get().connection.mode === 'device') {
      const targetControl = target?.control;
      if (target && targetControl) {
        get().recordDeviceOperation(
          {
            kind: 'control',
            key: controlId,
            label: targetControl.label || targetControl.name || controlId,
            blockId: target.block.id,
            path: controlId,
            before: targetControl.value,
            after: value,
          },
          !firstInGroup,
        );
      }
      const pendingEntry = target && targetControl
        ? rememberPendingWrite({
            id: controlId,
            kind: 'control',
            label: targetControl.label || targetControl.name || controlId,
            localValue: value,
            previousValue: targetControl.value,
            blockId: target.block.id,
            controlId,
          })
        : null;
      coalesce(
        controlId,
        () => tauriClient.setControl(controlId, value),
        (message, error) => {
          if (pendingEntry) get().handleWriteFailure(pendingEntry.id, message, error);
          else get().notify(message, 'bad');
        },
        () => {
          if (pendingEntry) clearPendingWrite(pendingEntry);
        },
      );
      if (isTypeChange) {
        const blockId = target?.block.id;
        window.setTimeout(() => {
          void (async () => {
            await get().refreshDevice();
            if (
              !blockId ||
              !String(value).toLowerCase().includes('parametric')
            ) {
              return;
            }
            const updatedBlock = get().blocks.find((item) => item.id === blockId);
            if (isLaneTypeChange) {
              const lane = updatedBlock?.secondLane;
              if (
                updatedBlock &&
                lane?.modelControlId?.endsWith('\\pmodel') &&
                !lane.model &&
                lane.modelOptions?.length
              ) {
                get().setLaneModel(updatedBlock.id, lane.modelOptions[0]);
              }
              return;
            }
            if (
              updatedBlock?.modelControlId?.endsWith('\\pmodel') &&
              !updatedBlock.model &&
              updatedBlock.modelOptions?.length
            ) {
              // The firmware exposes no pfloat controls until a PNAM model is
              // selected, so choose the first one like the Python client.
              get().setBlockModel(updatedBlock.id, updatedBlock.modelOptions[0]);
            }
          })();
        }, 320);
        window.setTimeout(() => void get().refreshDevice(), 1_050);
      }
    }
  },

  applyBlockPreset: (blockId, preset) => {
    const state = get();
    const block = state.blocks.find((item) => item.id === blockId);
    if (!block) return;

    const typeControl = block.controls.find(
      (control) => control.name === 'type' && control.visible !== false,
    );
    const presetType = typeControl ? preset.values[typeControl.id] : undefined;
    if (
      typeControl &&
      presetType !== undefined &&
      String(typeControl.value) !== String(presetType)
    ) {
      get().notify(
        `“${preset.name}” was saved with a different block type; switch the type first`,
        'warn',
      );
      get().addActivity(
        'Block preset type mismatch',
        `${block.label} · ${preset.name}`,
        'warn',
      );
      return;
    }

    const prepared = prepareBlockPresetValues(block, preset);
    const changes = sortBlockPresetChanges(
      block,
      blockPresetChanges(block, prepared.values),
    );
    if (changes.length === 0) {
      if (prepared.warnings.length > 0) get().notify(prepared.warnings[0], 'warn');
      else get().notify(`“${preset.name}” already matches this block`, 'neutral');
      return;
    }

    const before = snapshotOf(state);
    const updated = applyPresetValuesToBlock(block, prepared.values);

    const pendingIds = changes.map((change) => change.path);
    const pendingEntries =
      state.connection.mode === 'device'
        ? changes.map((change) => {
            const mainModel = change.path === block.modelControlId;
            const laneModel =
              block.secondLane?.modelControlId === change.path;
            return rememberPendingWrite({
              id: mainModel
                ? `model.${blockId}`
                : laneModel
                  ? `model.${blockId}.lane`
                  : change.path,
              kind: mainModel || laneModel ? 'model' : 'control',
              label:
                mainModel || laneModel
                  ? 'Model'
                  : (change.path.split('\\').pop() ?? change.path),
              localValue: change.after,
              previousValue: change.before,
              blockId,
              controlId: change.path,
              lane: laneModel ? true : undefined,
            });
          })
        : [];
    set({
      blocks: state.blocks.map((item) => (item.id === blockId ? updated : item)),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
      pending: [...new Set([...state.pending, ...pendingIds])],
    });
    window.setTimeout(() => {
      set((current) => ({
        pending: current.pending.filter((item) => !pendingIds.includes(item)),
      }));
    }, 500);

    get().addActivity(
      'Block preset applied',
      `${block.label} · ${preset.name}`,
      'neutral',
    );
    if (prepared.warnings.length > 0) {
      get().notify(prepared.warnings[0], 'warn');
      get().addActivity(
        'Block preset model fallback',
        prepared.warnings.join(' · '),
        'warn',
      );
    } else {
      get().notify(`Applied “${preset.name}”`, 'good');
    }

    if (state.connection.mode === 'device') {
      const operationChanges = changes.map((change) => ({ ...change }));
      void (async () => {
        try {
          await flushCoalesced((message) => get().notify(message, 'bad'));
          let revision = get().save.revision;
          for (const change of operationChanges) {
            const snapshot = await tauriClient.setControl(change.path, change.after);
            revision = snapshot.revision;
          }
          for (const entry of pendingEntries) clearPendingWrite(entry);
          set((current) => ({
            save: { ...current.save, revision },
            pending: current.pending.filter((item) => !pendingIds.includes(item)),
          }));
          get().recordDeviceOperation({
            kind: 'block-preset',
            key: `block-preset:${blockId}:${preset.name}`,
            label: `${block.label} · ${preset.name}`,
            blockId,
            changes: operationChanges,
          });
        } catch (error) {
          for (const entry of pendingEntries) clearPendingWrite(entry);
          set((current) => ({
            pending: current.pending.filter((item) => !pendingIds.includes(item)),
          }));
          get().notify(ipcErrorMessage(error), 'bad');
          get().addActivity(
            'Block preset apply failed',
            `${block.label} · ${preset.name}`,
            'bad',
          );
          void get().refreshDevice();
        }
      })();
    }
  },

  setLink: (id, parallel) => {
    set((state) => ({
      blocks: state.blocks.map((block) =>
        block.id === id ? { ...block, link: parallel ? 'parallel' : 'series' } : block,
      ),
      save: { ...state.save, edited: true },
    }));
    get().notify(`${parallel ? 'Parallel' : 'Series'} link set`, 'neutral');
    const block = get().blocks.find((item) => item.id === id);
    if (get().connection.mode === 'device' && block?.slotRow != null && block.slotCol != null) {
      const edit = {
        type: 'link' as const,
        row: block.slotRow,
        col: block.slotCol,
        parallel,
      };
      const inverse = { ...edit, parallel: !parallel };
      tauriClient
        .editChain(edit)
        .then(() => {
          get().recordDeviceOperation({
            kind: 'chain',
            key: `link:${id}`,
            label: `${block.label} link`,
            edit,
            inverse,
          });
          window.setTimeout(() => void get().refreshDevice(), 200);
        })
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
  },

  moveBlock: (activeId, overId) => {
    if (activeId === overId) return;
    const state = get();
    const from = state.blocks.findIndex((block) => block.id === activeId);
    if (from < 0) return;
    const moved = state.blocks[from];
    if (moved.fixed) {
      get().notify('Fixed blocks cannot be moved', 'warn');
      return;
    }
    const before = snapshotOf(state);

    if (state.connection.mode !== 'device') {
      const to = state.blocks.findIndex((block) => block.id === overId);
      if (to < 0) return;
      if (state.blocks[to].fixed) {
        get().notify('Fixed blocks cannot be moved', 'warn');
        return;
      }
      const blocks = [...state.blocks];
      const [item] = blocks.splice(from, 1);
      blocks.splice(to, 0, item);
      set({
        blocks,
        undoStack: [...state.undoStack, before].slice(-40),
        redoStack: [],
        save: { ...state.save, edited: true },
      });
      get().addActivity('Chain reordered', moved.label, 'neutral');
      return;
    }

    const fromSlot = slotOf(moved);
    if (!fromSlot) {
      get().notify('This block has no router slot', 'warn');
      return;
    }

    const targetBlock = state.blocks.find((block) => block.id === overId);
    let target = targetBlock
      ? adjacentEmptySlot(moved, targetBlock, state.blocks, state.emptySlots)
      : parseChainSlotId(overId);
    let swap = false;

    if (targetBlock && !target) {
      if (targetBlock.fixed) {
        get().notify('No free slot beside that fixed block', 'warn');
        return;
      }
      const targetSlot = slotOf(targetBlock);
      if (!targetSlot) {
        get().notify('This block has no router slot', 'warn');
        return;
      }
      target = targetSlot;
      swap = true;
    }

    if (!target) return;
    const destination = target;

    const blocks = state.blocks
      .map((block) => {
        if (block.id === activeId) {
          return { ...block, slotRow: destination.row, slotCol: destination.col };
        }
        if (swap && block.id === overId) {
          return { ...block, slotRow: fromSlot.row, slotCol: fromSlot.col };
        }
        return block;
      })
      .sort((left, right) => {
        const leftSlot = slotOf(left);
        const rightSlot = slotOf(right);
        if (!leftSlot || !rightSlot) return 0;
        return compareChainSlots(leftSlot, rightSlot);
      });

    const emptySlots = swap
      ? state.emptySlots
      : [
          ...state.emptySlots.filter(
            (slot) => slot.row !== destination.row || slot.col !== destination.col,
          ),
          fromSlot,
        ].sort(compareChainSlots);

    set({
      blocks,
      emptySlots,
      selectedBlockId: activeId,
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    });
    get().addActivity('Chain reordered', moved.label, 'neutral');
    const edit = {
      type: 'move' as const,
      from: [fromSlot.row, fromSlot.col] as [number, number],
      to: [destination.row, destination.col] as [number, number],
    };
    const inverse = {
      type: 'move' as const,
      from: edit.to,
      to: edit.from,
    };
    tauriClient
      .editChain(edit)
      .then(() => {
        get().recordDeviceOperation({
          kind: 'chain',
          key: `move:${activeId}`,
          label: `${moved.label} moved`,
          edit,
          inverse,
        });
        window.setTimeout(() => void get().refreshDevice(), 200);
      })
      .catch((error) => {
        get().notify(ipcErrorMessage(error), 'bad');
        void get().refreshDevice();
      });
  },

  addBlock: (id, slot) => {
    const current = get();
    const available = current.availableBlocks.find((item) => item.id === id);
    if (!available) return;
    if (current.connection.mode === 'device') {
      const target = slot ?? current.emptySlots[current.emptySlots.length - 1];
      if (!target) {
        current.notify('No free chain slot available', 'warn');
        return;
      }
      const edit = {
        type: 'add' as const,
        row: target.row,
        col: target.col,
        path: id,
      };
      const inverse = { type: 'remove' as const, row: target.row, col: target.col };
      tauriClient
        .editChain(edit)
        .then(() => {
          get().recordDeviceOperation({
            kind: 'chain',
            key: `add:${id}:${target.row}:${target.col}`,
            label: `${available.label} added`,
            edit,
            inverse,
          });
          set((state) => ({
            save: { ...state.save, edited: true },
            emptySlots: state.emptySlots.filter(
              (item) => item.row !== target.row || item.col !== target.col,
            ),
            availableBlocks: state.availableBlocks.filter((item) => item.id !== id),
          }));
          current.addActivity('Block added', available.label, 'good');
          current.notify(`${available.label} added to the chain`, 'good');
          return get().refreshDevice();
        })
        .catch((error) => current.notify(ipcErrorMessage(error), 'bad'));
      return;
    }
    const block = buildDemoBlock(available, get().blocks.length + 1);
    set((state) => ({
      blocks: [...state.blocks, block],
      selectedBlockId: block.id,
      save: { ...state.save, edited: true },
    }));
    get().addActivity('Block added', block.label, 'good');
    get().notify(`${block.label} added to the chain`, 'good');
  },

  removeBlock: (id) => {
    const block = get().blocks.find((item) => item.id === id);
    if (!block) return;
    if (block.fixed) {
      get().notify('Fixed blocks cannot be removed', 'warn');
      return;
    }
    if (get().connection.mode === 'device') {
      if (block.slotRow == null || block.slotCol == null) {
        get().notify('This block has no router slot', 'warn');
        return;
      }
      const edit = {
        type: 'remove' as const,
        row: block.slotRow,
        col: block.slotCol,
      };
      const inverse = {
        type: 'add' as const,
        row: block.slotRow,
        col: block.slotCol,
        path: id,
      };
      tauriClient
        .editChain(edit)
        .then(() => {
          get().recordDeviceOperation({
            kind: 'chain',
            key: `remove:${id}`,
            label: `${block.label} removed`,
            edit,
            inverse,
          });
          set((state) => ({ save: { ...state.save, edited: true } }));
          get().addActivity('Block removed', block.label, 'warn');
          return get().refreshDevice();
        })
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
      return;
    }
    const before = snapshotOf(get());
    set((state) => {
      const index = state.blocks.findIndex((item) => item.id === id);
      const blocks = state.blocks.filter((item) => item.id !== id);
      const fallback = blocks[Math.min(index, blocks.length - 1)]?.id ?? null;
      return {
        blocks,
        availableBlocks: state.availableBlocks.some((item) => item.id === block.id)
          ? state.availableBlocks
          : [
              ...state.availableBlocks,
              { id: block.id, label: block.label, desc: block.model ?? '' },
            ],
        selectedBlockId: state.selectedBlockId === id ? fallback : state.selectedBlockId,
        undoStack: [...state.undoStack, before].slice(-40),
        redoStack: [],
        save: { ...state.save, edited: true },
      };
    });
    get().addActivity('Block removed', block.label, 'warn');
  },

  clearChain: () => {
    const current = get();
    const movable = current.blocks.filter((block) => !block.fixed);
    if (movable.length === 0) {
      current.notify('The signal chain has no movable blocks', 'warn');
      return;
    }
    if (current.connection.mode === 'device') {
      const restore = movable
        .filter(
          (block): block is Block & { slotRow: number; slotCol: number } =>
            block.slotRow != null && block.slotCol != null,
        )
        .map((block) => ({
          row: block.slotRow,
          col: block.slotCol,
          path: block.id,
        }));
      tauriClient
        .editChain({ type: 'clear' })
        .then(() => {
          if (restore.length > 0) {
            get().recordDeviceOperation({
              kind: 'chain-clear',
              key: 'chain.clear',
              label: 'Chain cleared',
              restore,
            });
          }
          set((state) => ({ save: { ...state.save, edited: true } }));
          get().addActivity(
            'Chain cleared',
            `${movable.length} movable blocks removed`,
            'warn',
          );
          get().notify('Signal chain cleared', 'good');
          return get().refreshDevice();
        })
        .catch((error) => current.notify(ipcErrorMessage(error), 'bad'));
      return;
    }

    const before = snapshotOf(current);
    const remaining = current.blocks.filter((block) => block.fixed);
    const restored = movable
      .map((block) => ({ id: block.id, label: block.label, desc: block.model ?? '' }))
      .filter(
        (block) => !current.availableBlocks.some((available) => available.id === block.id),
      );
    set((state) => ({
      blocks: remaining,
      availableBlocks: [...state.availableBlocks, ...restored],
      selectedBlockId: remaining.some((block) => block.id === state.selectedBlockId)
        ? state.selectedBlockId
        : (remaining[0]?.id ?? null),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    }));
    get().addActivity('Chain cleared', `${movable.length} movable blocks removed`, 'warn');
    get().notify('Signal chain cleared', 'good');
  },

  replaceBlock: (id, replacementId) => {
    const current = get();
    const block = current.blocks.find((item) => item.id === id);
    const replacement = current.availableBlocks.find((item) => item.id === replacementId);
    if (!block || !replacement || block.id === replacement.id) return;
    if (block.fixed) {
      current.notify('Fixed blocks cannot be replaced', 'warn');
      return;
    }
    if (current.connection.mode === 'device') {
      if (block.slotRow == null || block.slotCol == null) {
        current.notify('This block has no router slot', 'warn');
        return;
      }
      const edit = {
        type: 'replace' as const,
        row: block.slotRow,
        col: block.slotCol,
        path: replacementId,
      };
      const inverse = { ...edit, path: id };
      tauriClient
        .editChain(edit)
        .then(() => {
          get().recordDeviceOperation({
            kind: 'chain',
            key: `replace:${id}:${block.slotRow}:${block.slotCol}`,
            label: `${block.label} replaced`,
            edit,
            inverse,
          });
          set((state) => ({ save: { ...state.save, edited: true } }));
          get().addActivity('Block replaced', `${block.label} → ${replacement.label}`, 'good');
          get().notify(`${block.label} replaced with ${replacement.label}`, 'good');
          return get().refreshDevice();
        })
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
      return;
    }
    const before = snapshotOf(current);
    const next = buildDemoBlock(replacement, block.footswitch, block.link);
    set((state) => {
      const blocks = state.blocks.map((item) => (item.id === id ? next : item));
      return {
        blocks,
        availableBlocks: state.availableBlocks
          .filter((item) => item.id !== replacement.id)
          .concat({ id: block.id, label: block.label, desc: block.model ?? '' }),
        selectedBlockId: state.selectedBlockId === id ? next.id : state.selectedBlockId,
        undoStack: [...state.undoStack, before].slice(-40),
        redoStack: [],
        save: { ...state.save, edited: true },
      };
    });
    get().addActivity('Block replaced', `${block.label} → ${next.label}`, 'good');
    get().notify(`${block.label} replaced with ${next.label}`, 'good');
  },

  setMaster: (field, value) => {
    const state = get();
    const before = snapshotOf(state);
    const previousValue: ConflictValue =
      typeof state.master[field] === 'number' ? (state.master[field] as number) : value;
    const firstInGroup =
      state.lastEdit.key !== `master.${field}` || Date.now() - state.lastEdit.at > 600;
    set({
      master: { ...state.master, [field]: value },
      undoStack: firstInGroup
        ? [...state.undoStack, before].slice(-40)
        : state.undoStack,
      redoStack: firstInGroup ? [] : state.redoStack,
      save: { ...state.save, edited: true },
      pending: state.pending.includes(`master.${field}`)
        ? state.pending
        : [...state.pending, `master.${field}`],
      lastEdit: { key: `master.${field}`, at: Date.now() },
    });
    window.setTimeout(() => {
      set((current) => ({
        pending: current.pending.filter((item) => item !== `master.${field}`),
      }));
    }, 260);
    if (get().connection.mode === 'device') {
      const masterField: MasterField =
        field === 'presetLevel' ? 'presetLevel' : field === 'tempo' ? 'tempo' : 'volume';
      get().recordDeviceOperation(
        {
          kind: 'master',
          key: `master.${masterField}`,
          label: masterField === 'presetLevel' ? 'Preset level' : `Master ${masterField}`,
          field: masterField,
          before: Number(previousValue),
          after: value,
        },
        !firstInGroup,
      );
      const pendingEntry = rememberPendingWrite({
        id: `master.${field}`,
        kind: 'master',
        label: masterField === 'presetLevel' ? 'Preset level' : `Master ${masterField}`,
        localValue: value,
        previousValue,
        field,
      });
      coalesce(
        `master.${field}`,
        () => tauriClient.setMaster(field === 'presetLevel' ? 'preset_level' : field, value),
        (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
        () => clearPendingWrite(pendingEntry),
      );
    }
  },

  setInputGain: (channel, value) => {
    const state = get();
    const key = channel === 1 ? 'gain1' : 'gain2';
    const control = state.input[key];
    if (!control) {
      get().notify(`Input ${channel} gain is not exposed by this firmware`, 'warn');
      return;
    }
    const clamped = Math.min(
      control.max ?? 15,
      Math.max(control.min ?? -15, Number(value.toFixed(2))),
    );
    set({
      input: { ...state.input, [key]: { ...control, value: clamped } },
    });
    if (state.connection.mode === 'device') {
      const pendingKey = `gain${channel}`;
      pendingInputWrites.set(pendingKey, { value: clamped, until: Date.now() + 1_600 });
      coalesce(
        `input.gain${channel}`,
        () => tauriClient.setInputGain(channel, clamped),
        (message) => {
          pendingInputWrites.delete(pendingKey);
          get().notify(message, 'bad');
          void get().refreshDevice();
        },
        () => {
          pendingInputWrites.delete(pendingKey);
        },
      );
    }
  },

  setEqBand: (index, patch) => {
    const state = get();
    const before = snapshotOf(state);
    const previousBand = state.eq.find((band) => band.index === index);
    const eqBefore: Record<string, ConflictValue> = {};
    const eqAfter: Record<string, ConflictValue> = {};
    const key = `eq.${index}.${Object.keys(patch).join(',')}`;
    const firstInGroup = state.lastEdit.key !== key || Date.now() - state.lastEdit.at > 600;
    set({
      eq: state.eq.map((band) => (band.index === index ? { ...band, ...patch } : band)),
      undoStack: firstInGroup
        ? [...state.undoStack, before].slice(-40)
        : state.undoStack,
      redoStack: firstInGroup ? [] : state.redoStack,
      save: { ...state.save, edited: true },
      pending: state.pending.includes(`eq.${index}`)
        ? state.pending
        : [...state.pending, `eq.${index}`],
      lastEdit: { key, at: Date.now() },
    });
    window.setTimeout(() => {
      set((current) => ({
        pending: current.pending.filter((item) => item !== `eq.${index}`),
      }));
    }, 260);
    if (get().connection.mode === 'device') {
      const deviceIndex =
        get().eq.find((band) => band.index === index)?.deviceIndex ?? index;
      for (const [field, fieldValue] of Object.entries(patch)) {
        if (fieldValue == null) continue;
        const previousValue = previousBand
          ? (previousBand[field as keyof EqBand] as ConflictValue)
          : (fieldValue as ConflictValue);
        const pendingEntry = rememberPendingWrite({
          id: `eq.${index}.${field}`,
          kind: 'eq',
          label: `EQ band ${index + 1} ${field}`,
          localValue: fieldValue as ConflictValue,
          previousValue,
          index,
          field,
        });
        eqBefore[field] = previousValue;
        eqAfter[field] = fieldValue as ConflictValue;
        coalesce(
          `eq.${index}.${field}`,
          () =>
            field === 'type'
              ? tauriClient.setEqType(deviceIndex, String(fieldValue))
              : tauriClient.setEqBand(deviceIndex, field, Number(fieldValue)),
          (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
          () => clearPendingWrite(pendingEntry),
        );
      }
      get().recordDeviceOperation(
        {
          kind: 'eq',
          key: `eq.${index}`,
          label: `EQ band ${index + 1}`,
          index,
          deviceIndex,
          before: eqBefore,
          after: eqAfter,
        },
        !firstInGroup,
      );
    }
  },

  setEqEnabled: (enabled) => {
    const previous = get().eqEnabled;
    set((state) => ({
      eqEnabled: enabled,
      eq: state.eq.map((band) => ({ ...band, enabled })),
      save: { ...state.save, edited: true },
    }));
    get().notify(`Global EQ ${enabled ? 'enabled' : 'bypassed'}`, 'neutral');
    if (get().connection.mode === 'device') {
      get().recordDeviceOperation({
        kind: 'eq-enabled',
        key: 'eq.enabled',
        label: 'Global EQ',
        before: previous,
        after: enabled,
      });
      const pendingEntry = rememberPendingWrite({
        id: 'eq.enabled',
        kind: 'eq',
        label: 'Global EQ',
        localValue: enabled,
        previousValue: previous,
        field: 'enabled',
      });
      coalesce(
        'eq.enabled',
        () => tauriClient.setEqEnabled(enabled),
        (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
        () => clearPendingWrite(pendingEntry),
      );
    }
  },

  flattenEq: () => {
    const before = snapshotOf(get());
    const previousEq = get().eq;
    set((state) => ({
      eq: state.eq.map((band) => ({ ...band, gain: 0 })),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    }));
    get().notify('Global EQ flattened — undo available', 'warn');
    if (get().connection.mode === 'device') {
      get().recordDeviceOperation({
        kind: 'eq-bulk',
        key: 'eq.flatten',
        label: 'EQ flattened',
        changes: get().eq.map((band) => ({
          index: band.index,
          deviceIndex: band.deviceIndex ?? band.index,
          before:
            previousEq.find((item) => item.index === band.index)?.gain ?? band.gain,
          after: 0,
        })),
      });
      get().eq.forEach((band) => {
        const pendingEntry = rememberPendingWrite({
          id: `eq.${band.index}.gain`,
          kind: 'eq',
          label: `EQ band ${band.index + 1} gain`,
          localValue: 0,
          previousValue: previousEq.find((item) => item.index === band.index)?.gain ?? band.gain,
          index: band.index,
          field: 'gain',
        });
        coalesce(
          `eq.${band.index}.gain`,
          () => tauriClient.setEqBand(band.deviceIndex ?? band.index, 'gain', 0),
          (message, error) => get().handleWriteFailure(pendingEntry.id, message, error),
          () => clearPendingWrite(pendingEntry),
        );
      });
    }
  },

  undo: () => {
    const state = get();
    if (state.connection.mode === 'device') {
      void (async () => {
        if (deviceReplaying) return;
        if (!state.connection.connected) {
          get().notify('Reconnect before undoing device edits', 'warn');
          return;
        }
        if (state.conflicts.length > 0) {
          get().notify('Resolve the device conflicts before undoing', 'warn');
          return;
        }
        const operation = state.deviceUndoStack.at(-1);
        if (!operation) {
          get().notify('Nothing to undo', 'neutral');
          return;
        }
        deviceReplaying = true;
        try {
          await flushCoalesced((message) => get().notify(message, 'bad'));
          await applyDeviceOperation(operation, 'undo');
          set((current) => ({
            deviceUndoStack: current.deviceUndoStack.slice(0, -1),
            deviceRedoStack: [...current.deviceRedoStack, operation].slice(-100),
            save: { ...current.save, edited: true },
          }));
          get().addActivity('Undo', operation.label, 'neutral');
        } catch (error) {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        } finally {
          deviceReplaying = false;
        }
      })();
      return;
    }
    const previous = state.undoStack[state.undoStack.length - 1];
    if (!previous) {
      get().notify('Nothing to undo', 'neutral');
      return;
    }
    set({
      blocks: previous.blocks,
      master: previous.master,
      eq: previous.eq,
      eqEnabled: previous.eqEnabled,
      preset: previous.preset,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, snapshotOf(state)].slice(-40),
      save: { ...state.save, edited: true },
    });
  },

  redo: () => {
    const state = get();
    if (state.connection.mode === 'device') {
      void (async () => {
        if (deviceReplaying) return;
        if (!state.connection.connected) {
          get().notify('Reconnect before redoing device edits', 'warn');
          return;
        }
        if (state.conflicts.length > 0) {
          get().notify('Resolve the device conflicts before redoing', 'warn');
          return;
        }
        const operation = state.deviceRedoStack.at(-1);
        if (!operation) {
          get().notify('Nothing to redo', 'neutral');
          return;
        }
        deviceReplaying = true;
        try {
          await flushCoalesced((message) => get().notify(message, 'bad'));
          await applyDeviceOperation(operation, 'redo');
          set((current) => ({
            deviceRedoStack: current.deviceRedoStack.slice(0, -1),
            deviceUndoStack: [...current.deviceUndoStack, operation].slice(-100),
            save: { ...current.save, edited: true },
          }));
          get().addActivity('Redo', operation.label, 'neutral');
        } catch (error) {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        } finally {
          deviceReplaying = false;
        }
      })();
      return;
    }
    const next = state.redoStack[state.redoStack.length - 1];
    if (!next) {
      get().notify('Nothing to redo', 'neutral');
      return;
    }
    set({
      blocks: next.blocks,
      master: next.master,
      eq: next.eq,
      eqEnabled: next.eqEnabled,
      preset: next.preset,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, snapshotOf(state)].slice(-40),
      save: { ...state.save, edited: true },
    });
  },

  setTheme: (theme) => {
    const { density, motion } = get();
    applyAppearance(theme, density, motion);
    saveAppearance(theme, density, motion);
    set({ theme });
  },

  setDensity: (density) => {
    const { theme, motion } = get();
    applyAppearance(theme, density, motion);
    saveAppearance(theme, density, motion);
    set({ density });
  },

  setMotion: (motion) => {
    const { theme, density } = get();
    applyAppearance(theme, density, motion);
    saveAppearance(theme, density, motion);
    set({ motion });
  },

  setCompactChain: (compactChain) => {
    try {
      localStorage.setItem('stomp.compactChain', compactChain ? '1' : '0');
    } catch {
      /* local settings are best-effort */
    }
    set({ compactChain });
  },

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setPresetDrawerOpen: (presetDrawerOpen) => set({ presetDrawerOpen }),
  setConnectionOpen: (connectionOpen) => set({ connectionOpen }),
  setTunerOpen: (tunerOpen) => {
    if (get().tunerOpen === tunerOpen) return;
    set({ tunerOpen });
    if (tunerOpen) {
      set((state) => ({ tuner: { ...state.tuner, enabled: true } }));
      get().addActivity('Tuner opened', 'input 1 · reference 440 Hz', 'neutral');
      if (get().connection.mode === 'device') {
        tauriClient
          .tunerOpen()
          .then((view) => {
            set((state) => ({
              tuner: {
                ...state.tuner,
                available: view.available,
                message: view.message ?? undefined,
                enabled: view.available ? view.enabled : false,
                note: view.note ?? state.tuner.note,
                cents: view.cents ?? state.tuner.cents,
                frequency: view.frequency ?? state.tuner.frequency,
                reference: view.reference ?? state.tuner.reference,
                level: view.level ?? state.tuner.level,
              },
            }));
          })
          .catch((error) => {
            set((state) => ({ tuner: { ...state.tuner, enabled: false } }));
            get().notify(ipcErrorMessage(error), 'bad');
          });
      }
    } else {
      set((state) => ({ tuner: { ...state.tuner, enabled: false } }));
      if (get().connection.mode === 'device') {
        tauriClient.tunerClose().catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
      }
    }
  },
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  setDemoAllowed: (allowed) => set({ demoAllowed: allowed }),
  setAppVersion: (appVersion) => set({ appVersion }),

  connectDemo: () => {
    userDisconnected = false;
    if (get().connection.mode === 'device') {
      tauriClient.disconnect().catch(() => undefined);
    }
    pendingBlockWrites.clear();
    pendingInputWrites.clear();
    pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
    lastDeviceSnapshot = null;
    const boot = demoBoot();
    set((state) => ({
      ...boot,
      conflicts: [],
      deviceUndoStack: [],
      deviceRedoStack: [],
      connection: {
        ...boot.connection,
        connected: false,
        connecting: true,
        requiresPassword: false,
        authenticated: true,
      },
      save: { ...boot.save, revision: state.save.revision + 1 },
      undoStack: [],
      redoStack: [],
      connectionOpen: false,
    }));
    window.setTimeout(() => {
      const ready = demoBoot();
      set((state) => ({
        ...ready,
        save: { ...ready.save, revision: state.save.revision + 1 },
        undoStack: [],
        redoStack: [],
        connectionOpen: false,
      }));
      get().addActivity('Device synced', 'demo simulator · 132 nodes', 'good');
      get().notify('Connected to the simulator', 'good');
    }, 450);
  },

  connectAuto: async (password, rememberPassword) => {
    if (get().connection.connecting) return;
    userDisconnected = false;
    pendingBlockWrites.clear();
    pendingInputWrites.clear();
    pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
    set((state) => ({
      conflicts: [],
      deviceUndoStack: [],
      deviceRedoStack: [],
      connection: {
        ...state.connection,
        connected: false,
        connecting: true,
        mode: 'device',
        transport: 'AUTO · searching',
        autoSearch: 'searching',
        autoSearchMessage: 'Searching Wi-Fi first, then USB…',
        error: undefined,
      },
      connectionOpen: true,
    }));
    try {
      const info = await tauriClient.autoConnect(password);
      const { snapshot, editors } = await collectDevice();
      lastDeviceSnapshot = snapshot;
      const current = get();
      const mapped = mapSnapshot(snapshot, editors, info, {
        preset: current.preset,
        connection: current.connection,
        eq: current.eq,
      });
      const selected =
        mapped.blocks.find((block) => block.id === current.selectedBlockId)?.id ??
        mapped.blocks[0]?.id ??
        null;
      const authError =
        password && mapped.connection.requiresPassword && !mapped.connection.authenticated
          ? 'The device rejected that password.'
          : undefined;
      const locked =
        mapped.connection.requiresPassword && !mapped.connection.authenticated;
      set((state) => ({
        ...mapped,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path && !slot.fixed)
          .map((slot) => ({ row: slot.row, col: slot.col })),
        selectedBlockId: selected,
        undoStack: [],
        redoStack: [],
        uploads: [],
        recentUpload: null,
        activity: [],
        connection: {
          ...mapped.connection,
          autoSearch: 'idle',
          autoSearchMessage: '',
          error: undefined,
          authError,
        },
        connectionOpen: false,
        save: {
          ...state.save,
          edited: false,
          saving: false,
          revision: snapshot.revision,
          lastSaved: now(),
        },
      }));
      if (password && mapped.connection.requiresPassword && mapped.connection.authenticated) {
        const remember = rememberPassword !== false;
        void (remember
          ? tauriClient.saveDevicePassword(info.address, password)
          : tauriClient.forgetDevicePassword(info.address)
        ).catch((error) => get().notify(ipcErrorMessage(error), 'warn'));
      }
      if (locked) {
        get().addActivity(
          'Device locked',
          'connected read-only · password required for writes',
          'warn',
        );
        get().notify(
          'Connected read-only — enter the device password to enable writes',
          'warn',
        );
      } else {
        get().addActivity('Device found', `${info.node_count} nodes · ${info.transport}`, 'good');
        get().notify(`Connected to ${info.device_name || 'StompStation PRO'}`, 'good');
      }
    } catch (error) {
      const message = ipcErrorMessage(error);
      set((state) => ({
        connection: {
          ...state.connection,
          connected: false,
          connecting: false,
          mode: 'device',
          autoSearch: 'failed',
          autoSearchMessage: message,
          error: undefined,
        },
        connectionOpen: true,
      }));
      get().addActivity('No device found', message, 'bad');
      get().notify(message, 'bad');
    }
  },

  connectReal: async (address, password, rememberPassword) => {
    userDisconnected = false;
    pendingBlockWrites.clear();
    pendingInputWrites.clear();
    pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
    set((state) => ({
      conflicts: [],
      deviceUndoStack: [],
      deviceRedoStack: [],
      connection: {
        ...state.connection,
        connecting: true,
        connected: false,
        mode: 'device',
        autoSearch: 'idle',
        autoSearchMessage: '',
        error: undefined,
      },
      connectionOpen: true,
    }));
    try {
      const { snapshot, editors, info } = await collectDevice(address, password);
      if (!info) throw new Error('the device did not return connection information');
      lastDeviceSnapshot = snapshot;
      const current = get();
      const mapped = mapSnapshot(snapshot, editors, info, {
        preset: current.preset,
        connection: current.connection,
        eq: current.eq,
      });
      mapped.connection.address = address;
      const selected =
        mapped.blocks.find((block) => block.id === current.selectedBlockId)?.id ??
        mapped.blocks[0]?.id ??
        null;
      const authError =
        password && mapped.connection.requiresPassword && !mapped.connection.authenticated
          ? 'The device rejected that password.'
          : undefined;
      const locked =
        mapped.connection.requiresPassword && !mapped.connection.authenticated;
      set((state) => ({
        ...mapped,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path && !slot.fixed)
          .map((slot) => ({ row: slot.row, col: slot.col })),
        selectedBlockId: selected,
        undoStack: [],
        redoStack: [],
        uploads: [],
        recentUpload: null,
        activity: [],
        connection: {
          ...mapped.connection,
          autoSearch: 'idle',
          autoSearchMessage: '',
          error: undefined,
          authError,
        },
        connectionOpen: false,
        save: {
          ...state.save,
          edited: false,
          saving: false,
          revision: snapshot.revision,
          lastSaved: now(),
        },
      }));
      if (password && mapped.connection.requiresPassword && mapped.connection.authenticated) {
        const remember = rememberPassword !== false;
        void (remember
          ? tauriClient.saveDevicePassword(info.address, password)
          : tauriClient.forgetDevicePassword(info.address)
        ).catch((error) => get().notify(ipcErrorMessage(error), 'warn'));
      }
      if (locked) {
        get().addActivity(
          'Device locked',
          'connected read-only · password required for writes',
          'warn',
        );
        get().notify(
          'Connected read-only — enter the device password to enable writes',
          'warn',
        );
      } else {
        get().addActivity('Device synced', `${info.node_count} nodes · ${info.transport}`, 'good');
        get().notify(`Connected to ${info.device_name || 'StompStation PRO'}`, 'good');
      }
    } catch (error) {
      const message = ipcErrorMessage(error);
      set((state) => ({
        connection: {
          ...state.connection,
          connecting: false,
          connected: false,
          error: message,
        },
        connectionOpen: true,
      }));
      get().addActivity('Connection failed', message, 'bad');
      get().notify(message, 'bad');
    }
  },

  unlockDevice: async (password, rememberPassword) => {
    try {
      const auth = await tauriClient.setPassword(password);
      const unlocked = auth.authenticated || !auth.required;
      set((state) => ({
        connection: {
          ...state.connection,
          requiresPassword: auth.required,
          authenticated: auth.authenticated,
          error: undefined,
          authError: unlocked ? undefined : 'Incorrect device password.',
        },
        connectionOpen: unlocked ? false : state.connectionOpen,
      }));
      if (unlocked) {
        const address = get().connection.address;
        if (address) {
          const remember = Boolean(password) && rememberPassword !== false;
          void (remember
            ? tauriClient.saveDevicePassword(address, password as string)
            : tauriClient.forgetDevicePassword(address)
          ).catch((error) => get().notify(ipcErrorMessage(error), 'warn'));
        }
        get().notify(password ? 'Device unlocked' : 'Device password cleared', 'good');
        return true;
      }
      get().notify('Incorrect device password', 'bad');
      return false;
    } catch (error) {
      const message = ipcErrorMessage(error);
      if (ipcErrorCode(error) === 'auth_required') {
        set((state) => ({
          connection: {
            ...state.connection,
            requiresPassword: true,
            authenticated: false,
            authError: message,
          },
        }));
      }
      get().notify(message, 'bad');
      return false;
    }
  },

  forgetSavedPassword: async () => {
    const address = get().connection.address;
    if (!address) return;
    try {
      await tauriClient.forgetDevicePassword(address);
      get().notify('Saved device password removed', 'good');
    } catch (error) {
      get().notify(ipcErrorMessage(error), 'bad');
    }
  },

  resumeDevice: async () => {
    const current = get();
    if (
      current.connection.mode !== 'device' ||
      current.connection.connecting ||
      userDisconnected
    ) {
      return;
    }
    try {
      const snapshot = await tauriClient.refresh();
      get().applyDeviceSnapshot(snapshot);
      if (get().connection.connected) return;
    } catch {
      // The actor may have lost the transport while the activity was paused.
    }
    if (!get().connection.connected && !userDisconnected) {
      await get().connectAuto();
    }
  },

  refreshDevice: async (fullRefresh = false) => {
    const current = get();
    if (current.connection.mode !== 'device') return;
    try {
      const { snapshot, editors } = await collectDevice(undefined, undefined, fullRefresh);
      lastDeviceSnapshot = snapshot;
      const info: ConnectionInfo = {
        address: current.connection.address,
        transport: current.connection.transport,
        device_name: snapshot.device_name,
        firmware: snapshot.firmware,
        node_count: 0,
      };
      const mapped = mapSnapshot(snapshot, editors, info, {
        preset: current.preset,
        connection: current.connection,
        eq: current.eq,
      });
      mapped.connection.address = current.connection.address;
      let blocks = mapped.blocks;
      for (const conflict of current.conflicts) {
        if (conflict.kind === 'master' && conflict.field) {
          (mapped.master as unknown as Record<string, ConflictValue>)[conflict.field] =
            Number(conflict.localValue);
          continue;
        }
        if (conflict.kind === 'eq') {
          if (conflict.id === 'eq.enabled') {
            mapped.eqEnabled = Boolean(conflict.localValue);
          } else {
            const band = mapped.eq.find((item) => item.index === conflict.index);
            if (band && conflict.field) {
              if (conflict.field === 'type') {
                band.type = String(conflict.localValue) as EqBand['type'];
              } else {
                (band as unknown as Record<string, ConflictValue>)[conflict.field] =
                  Number(conflict.localValue);
              }
            }
          }
          continue;
        }
        if (!conflict.blockId) continue;
        blocks = blocks.map((block) => {
          if (block.id !== conflict.blockId) return block;
          if (conflict.controlId) {
            return withControlState(block, conflict.controlId, conflict.localValue, true);
          }
          if (conflict.kind === 'model') {
            return withModelState(block, conflict.localValue, Boolean(conflict.lane));
          }
          return block;
        });
      }
      const selected =
        mapped.blocks.find((block) => block.id === current.selectedBlockId)?.id ??
        mapped.blocks[0]?.id ??
        null;
      set((state) => ({
        ...mapped,
        blocks,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path && !slot.fixed)
          .map((slot) => ({ row: slot.row, col: slot.col })),
        selectedBlockId: selected,
        undoStack: [],
        redoStack: [],
        save: {
          ...state.save,
          revision: snapshot.revision,
          // A refresh syncs the board; it does not persist the preset.
          // Keep the local dirty flag until an actual save succeeds.
        },
      }));
    } catch (error) {
      get().notify(ipcErrorMessage(error), 'bad');
    }
  },

  refreshSnapshot: () => {
    const state = get();
    if (state.connection.mode === 'demo') {
      state.notify('The demo board is already in sync', 'neutral');
      return;
    }
    if (state.connection.connected) {
      void state.refreshDevice();
      return;
    }
    if (state.connection.address) {
      void state.connectReal(state.connection.address);
      return;
    }
    state.setConnectionOpen(true);
  },

  applyDeviceSnapshot: (snapshot) => {
    const state = get();
    if (state.connection.mode !== 'device' || state.connection.connecting) return;
    // A snapshot read before a recent write must not rewind the board.
    if (snapshot.revision < state.save.revision) return;
    lastDeviceSnapshot = snapshot;

    const incoming = snapshot.chain.blocks;
    const sameChain =
      incoming.length === state.blocks.length &&
      incoming.every((block, index) => block.path === state.blocks[index].id);
    const presetChanged = snapshot.preset.current !== state.preset.current;
    const signature = `${snapshot.preset.current}|${incoming.map((block) => block.path).join('|')}`;
    if (!sameChain || presetChanged) {
      if (signature !== lastExternalSignature) {
        lastExternalSignature = signature;
        state.addActivity(
          'Changed on device',
          presetChanged ? snapshot.preset.current : 'signal chain rebrowsed',
          'warn',
        );
        state.notify('Changed on device — board reloaded', 'warn');
      }
      if (pendingDeviceWrites.size > 0) {
        pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
        state.addActivity(
          'Pending edits discarded',
          'the preset or chain changed on the device',
          'warn',
        );
      }
      set({ conflicts: [], deviceUndoStack: [], deviceRedoStack: [] });
      void state.refreshDevice();
      return;
    }

    let chainChanged = false;
    const changedPaths: string[] = [];
    const blocks = state.blocks.map((block, index) => {
      const next = incoming[index];
      const slot = snapshot.chain.slots.find((candidate) => candidate.path === next.path);
      let on = next.on ?? false;
      const pending = pendingBlockWrites.get(block.id);
      if (pending) {
        if (on === pending.on || Date.now() >= pending.until) {
          pendingBlockWrites.delete(block.id);
        } else {
          on = pending.on;
        }
      }
      const fixed = slot?.fixed ?? false;
      const link = slot?.link ?? 'series';
      const controlRevision = next.control_revision ?? 0;
      if (block.controlRevision !== controlRevision) {
        changedPaths.push(next.path);
      }
      if (
        block.on !== on ||
        block.fixed !== fixed ||
        block.link !== link ||
        block.label !== next.label
      ) {
        chainChanged = true;
      }
      return {
        ...block,
        on,
        fixed,
        link,
        label: next.label,
        controlRevision: controlRevision,
      };
    });

    const nextMaster = mapMaster(snapshot);
    const eqView = mapEq(snapshot, state.eq);
    const nextEq = eqView.eq.map((band) => ({ ...band }));
    let nextEqEnabled = eqView.eqEnabled;
    const conflicts = new Map(state.conflicts.map((conflict) => [conflict.id, conflict]));
    let addedConflict = false;

    for (const conflict of [...conflicts.values()]) {
      if (conflict.kind === 'master' && conflict.field) {
        const deviceValue = nextMaster[conflict.field as keyof MasterState];
        if (
          typeof deviceValue === 'number' &&
          sameConflictValue(deviceValue, conflict.localValue)
        ) {
          conflicts.delete(conflict.id);
        }
      } else if (conflict.kind === 'eq') {
        let deviceValue: ConflictValue | undefined;
        if (conflict.id === 'eq.enabled') {
          deviceValue = nextEqEnabled;
        } else {
          const band = nextEq.find((item) => item.index === conflict.index);
          if (band && conflict.field) {
            deviceValue = band[conflict.field as keyof EqBand] as ConflictValue;
          }
        }
        if (
          deviceValue !== undefined &&
          sameConflictValue(deviceValue, conflict.localValue)
        ) {
          conflicts.delete(conflict.id);
        }
      }
    }

    for (const entry of pendingDeviceWrites.values()) {
      if (entry.kind === 'master' && entry.field) {
        const key = entry.field as keyof MasterState;
        const deviceValue = nextMaster[key];
        if (typeof deviceValue !== 'number') continue;
        if (Date.now() - entry.issuedAt < 250) {
          (nextMaster as unknown as Record<string, ConflictValue>)[entry.field] =
            Number(entry.localValue);
          continue;
        }
        if (sameConflictValue(deviceValue, entry.localValue)) {
          conflicts.delete(entry.id);
          continue;
        }
        conflicts.set(entry.id, {
          id: entry.id,
          kind: 'master',
          label: entry.label,
          localValue: entry.localValue,
          deviceValue,
          field: entry.field,
        });
        (nextMaster as unknown as Record<string, ConflictValue>)[entry.field] =
          Number(entry.localValue);
        addedConflict = true;
      } else if (entry.kind === 'eq') {
        if (entry.id === 'eq.enabled') {
          if (Date.now() - entry.issuedAt < 250) {
            nextEqEnabled = Boolean(entry.localValue);
            continue;
          }
          if (sameConflictValue(nextEqEnabled, entry.localValue)) {
            conflicts.delete(entry.id);
            continue;
          }
          conflicts.set(entry.id, {
            id: entry.id,
            kind: 'eq',
            label: entry.label,
            localValue: entry.localValue,
            deviceValue: nextEqEnabled,
            field: 'enabled',
          });
          nextEqEnabled = Boolean(entry.localValue);
          addedConflict = true;
          continue;
        }
        if (entry.index == null || !entry.field) continue;
        const band = nextEq.find((item) => item.index === entry.index);
        if (!band) continue;
        if (Date.now() - entry.issuedAt < 250) {
          if (entry.field === 'type') {
            band.type = String(entry.localValue) as EqBand['type'];
          } else {
            (band as unknown as Record<string, ConflictValue>)[entry.field] =
              Number(entry.localValue);
          }
          continue;
        }
        const deviceValue = band[entry.field as keyof EqBand] as ConflictValue;
        if (sameConflictValue(deviceValue, entry.localValue)) {
          conflicts.delete(entry.id);
          continue;
        }
        conflicts.set(entry.id, {
          id: entry.id,
          kind: 'eq',
          label: entry.label,
          localValue: entry.localValue,
          deviceValue,
          index: entry.index,
          field: entry.field,
        });
        if (entry.field === 'type') {
          band.type = String(entry.localValue) as EqBand['type'];
        } else {
          (band as unknown as Record<string, ConflictValue>)[entry.field] =
            Number(entry.localValue);
        }
        addedConflict = true;
      }
    }

    const masterChanged =
      state.master.volume !== nextMaster.volume ||
      state.master.tempo !== nextMaster.tempo ||
      state.master.presetLevel !== nextMaster.presetLevel;
    const eqChanged =
      state.eqEnabled !== nextEqEnabled ||
      nextEq.some((band) => {
        const local = state.eq.find((item) => item.index === band.index);
        return (
          !local ||
          local.gain !== band.gain ||
          local.frequency !== band.frequency ||
          local.q !== band.q ||
          local.type !== band.type ||
          local.enabled !== band.enabled
        );
      });

    const nextInput = mapInput(snapshot);
    for (const key of ['gain1', 'gain2'] as const) {
      const pending = pendingInputWrites.get(key);
      if (!pending) continue;
      if (Date.now() < pending.until) {
        const control = nextInput[key];
        if (control) nextInput[key] = { ...control, value: pending.value };
      } else {
        pendingInputWrites.delete(key);
      }
    }

    set((current) => ({
      blocks: chainChanged || changedPaths.length ? blocks : current.blocks,
      master: nextMaster,
      input: nextInput,
      eq: nextEq,
      eqEnabled: nextEqEnabled,
      conflicts: [...conflicts.values()],
      lists: mapLists(snapshot),
      preset: mapPreset(snapshot, current.preset),
      meters: mapMeters(snapshot),
      availableBlocks: mapAvailableBlocks(snapshot),
      emptySlots: snapshot.chain.slots
        .filter((slot) => !slot.path && !slot.fixed)
        .map((slot) => ({ row: slot.row, col: slot.col })),
      connection: {
        ...current.connection,
        connected: snapshot.connected,
        deviceName: snapshot.device_name || current.connection.deviceName,
        firmware: snapshot.firmware || current.connection.firmware,
      },
      save: { ...current.save, revision: snapshot.revision },
    }));

    if (changedPaths.length) {
      void refreshChangedBlocks(snapshot, changedPaths);
    }
    if (chainChanged) {
      state.addActivity('Changed on device', 'bypass or link updated', 'warn');
      state.notify('Changed on device — board reloaded', 'warn');
    }
    if (addedConflict) {
      state.addActivity('Changed on device', 'review the control conflict', 'warn');
      state.notify('Changed on device — review the conflict', 'warn');
    } else if (masterChanged || eqChanged) {
      state.addActivity('Changed on device', 'board values updated', 'warn');
      state.notify('Changed on device — board values updated', 'warn');
    }
  },

  disconnect: () => {
    userDisconnected = true;
    pendingBlockWrites.clear();
    pendingInputWrites.clear();
    pendingDeviceWrites.clear();
    recentLocalBlockWrites.clear();
    lastDeviceSnapshot = null;
    if (get().connection.mode === 'device') {
      tauriClient.disconnect().catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
    set((state) => ({
      conflicts: [],
      deviceUndoStack: [],
      deviceRedoStack: [],
      connection: {
        ...state.connection,
        connected: false,
        connecting: false,
        autoSearch: 'idle',
        autoSearchMessage: '',
        error: undefined,
        requiresPassword: false,
        authenticated: false,
        authError: undefined,
      },
      connectionOpen: false,
    }));
    get().addActivity('Disconnected', 'last state kept readable', 'warn');
    get().notify('Disconnected — the board is frozen', 'warn');
  },

  addUpload: (file) => {
    const state = get();
    const kind = file.kind;
    const target =
      file.target ??
      (kind === 'ir'
        ? 'ir_list'
        : kind === 'pnam'
          ? 'pnam_list'
          : kind === 'vxamp'
            ? 'vxamp_list'
            : 'nam_amp');
    const list = state.lists.find((item) => item.id === target);
    const targetLabel = list?.label ?? target;
    const slot = file.slot ?? list?.slots.find((item) => !item.used)?.index ?? 0;
    // Hardware safety: the backend re-checks this allowlist and validates the
    // file. Do not bypass preflight or add other upload targets; see
    // docs/DEVICE_SAFETY.md.
    if (!(target in UPLOAD_TARGET_PATHS)) {
      get().notify('Only NAM, Parametric NAM, VXAMP, and IR captures can be uploaded', 'bad');
      return false;
    }

    if (state.connection.mode !== 'device') {
      const upload: UploadTask = {
        id: `upload-${Date.now()}`,
        file: file.name,
        kind,
        target: targetLabel,
        slot,
        progress: 0,
        state: 'uploading',
        ack: 0,
        totalAcks: Math.max(4, Math.ceil(file.size / 1024)),
        detail: 'preflight ready',
      };
      set((current) => ({
        uploads: [upload, ...current.uploads.filter((item) => item.state !== 'done')].slice(0, 4),
      }));
      get().addActivity('Upload started', `${file.name} · ${targetLabel} slot ${slot + 1}`, 'warn');
      return true;
    }

    if (state.uploads.some((item) => item.state === 'uploading' || item.state === 'queued')) {
      get().notify('An upload is already in flight — wait for its final ACK or cancel it', 'warn');
      return false;
    }
    const path = file.path;
    if (!path) {
      get().notify(
        'Choose the file with the system picker so the uploader can read it from disk',
        'warn',
      );
      return false;
    }

    const id = `upload-${Date.now()}`;
    const upload: UploadTask = {
      id,
      file: file.name,
      kind,
      target: targetLabel,
      slot,
      progress: 0,
      state: 'queued',
      ack: 0,
      totalAcks: 0,
      detail: 'starting upload',
    };
    set((current) => ({
      uploads: [upload, ...current.uploads.filter((item) => item.state !== 'done')].slice(0, 4),
      recentUpload: null,
    }));
    get().addActivity('Upload queued', `${file.name} · ${targetLabel} slot ${slot + 1}`, 'warn');

    const targetPath = uploadTargetPath(target);
    void (async () => {
      set((current) => ({
        uploads: current.uploads.map((item) =>
          item.id === id ? { ...item, state: 'uploading' as const, detail: 'waiting for ACK' } : item,
        ),
      }));
      try {
        const completion = await tauriClient.beginUpload(id, kind, path, targetPath, slot);
        const result = completion.result;
        get().applyDeviceSnapshot(completion.snapshot);
        if (completion.cancelled || !result) {
          set((current) => ({
            uploads: current.uploads.map((item) =>
              item.id === id
                ? { ...item, state: 'cancelled' as const, detail: 'cancelled after the last ACK' }
                : item,
            ),
          }));
          get().addActivity('Upload cancelled', `${file.name} · ${targetLabel}`, 'warn');
          get().notify(`${file.name} upload cancelled`, 'warn');
          return;
        }

        const resultTarget = uploadTargetId(result.target);
        const resultLabel = get().lists.find((item) => item.id === resultTarget)?.label ?? targetLabel;
        set((current) => ({
          uploads: current.uploads.map((item) =>
            item.id === id
              ? {
                  ...item,
                  target: resultLabel,
                  slot: result.slot,
                  progress: 100,
                  ack: item.totalAcks || item.ack,
                  state: 'done' as const,
                  detail: 'slot list refreshed',
                }
              : item,
          ),
          recentUpload: { target: resultTarget, slot: result.slot, name: result.name },
        }));
        get().addActivity(
          'Upload complete',
          `${result.name} · ${resultLabel} slot ${result.slot + 1}`,
          'good',
        );
        get().notify(`${result.name} uploaded`, 'good');
      } catch (error) {
        const message = ipcErrorMessage(error);
        set((current) => ({
          uploads: current.uploads.map((item) =>
            item.id === id ? { ...item, state: 'error' as const, detail: message } : item,
          ),
        }));
        get().addActivity('Upload failed', `${file.name} · ${message}`, 'bad');
        get().notify(message, 'bad');
        // A failed chunk can leave the cached slot list out of date.
        void get().refreshDevice();
      }
    })();

    return true;
  },

  cancelUpload: (id) => {
    const state = get();
    const active = state.uploads.find(
      (item) =>
        (item.state === 'uploading' || item.state === 'queued') &&
        (!id || item.id === id),
    );
    if (!active) return;

    if (state.connection.mode !== 'device') {
      set((current) => ({
        uploads: current.uploads.map((item) =>
          item.id === active.id
            ? { ...item, state: 'cancelled' as const, detail: 'cancelled' }
            : item,
        ),
      }));
      get().addActivity('Upload cancelled', `${active.file} · slot ${active.slot + 1}`, 'warn');
      return;
    }

    set((current) => ({
      uploads: current.uploads.map((item) =>
        item.id === active.id
          ? { ...item, detail: 'cancelling after the current ACK' }
          : item,
      ),
    }));
    void tauriClient
      .cancelUpload()
      .then((accepted) => {
        if (!accepted) get().notify('The upload already finished', 'warn');
      })
      .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
  },

  applyUploadProgress: (payload) => {
    const total = payload.total_acks;
    const progress = total > 0 ? Math.min(100, (payload.ack / total) * 100) : 0;
    set((state) => ({
      uploads: state.uploads.map((item) =>
        item.id === payload.id && (item.state === 'queued' || item.state === 'uploading')
          ? {
              ...item,
              state: 'uploading' as const,
              ack: payload.ack,
              totalAcks: payload.total_acks,
              progress,
              detail: `ACK ${payload.ack} / ${payload.total_acks}`,
            }
          : item,
      ),
    }));
  },

  tickUploads: () => {
    const state = get();
    // Device uploads are driven by real ACK events; only the browser demo
    // simulates progress.
    if (state.connection.mode !== 'demo') return;
    if (!state.uploads.some((upload) => upload.state === 'uploading')) return;
    const uploads = state.uploads.map((upload) => {
      if (upload.state !== 'uploading') return upload;
      const progress = Math.min(100, upload.progress + 11 + Math.random() * 7);
      const done = progress >= 100;
      return {
        ...upload,
        progress,
        ack: Math.min(upload.totalAcks, Math.round((progress / 100) * upload.totalAcks)),
        state: done ? ('done' as const) : ('uploading' as const),
        detail: done ? 'slot list refreshed' : `${Math.max(0, Math.round((100 - progress) / 18))} s left`,
      };
    });
    set({ uploads });
    const finished = uploads.find(
      (upload) => upload.state === 'done' && state.uploads.find((old) => old.id === upload.id)?.state === 'uploading',
    );
    if (finished) {
      get().addActivity('Upload complete', `${finished.file} · slot ${finished.slot + 1}`, 'good');
      get().notify(`${finished.file} uploaded`, 'good');
    }
  },

  handleWriteFailure: (id, message, error) => {
    const authRequired = ipcErrorCode(error) === 'auth_required';
    if (authRequired) {
      set((state) => ({
        connection: {
          ...state.connection,
          requiresPassword: true,
          authenticated: false,
          authError: message,
        },
        connectionOpen: true,
      }));
    }
    const pending = pendingDeviceWrites.get(id);
    if (pending) clearPendingWrite(pending);
    set((state) => ({
      pending: state.pending.filter((item) => item !== id),
      conflicts: state.conflicts.filter((conflict) => conflict.id !== id),
    }));
    if (!pending) {
      get().notify(message, authRequired ? 'warn' : 'bad');
      return;
    }
    set((state) => pendingStatePatch(state, pending, pending.previousValue));
    if (isStaleWriteError(error)) {
      get().addActivity('Write lost during reconnect', `${pending.label} reverted`, 'warn');
      get().notify(
        `${pending.label} reverted — the write was lost during reconnect`,
        'warn',
      );
    } else {
      get().notify(message, authRequired ? 'warn' : 'bad');
    }
    if (pending.blockId && (pending.kind === 'control' || pending.kind === 'model')) {
      void refreshBlockFromDevice(pending.blockId);
    } else {
      void get().refreshDevice();
    }
  },

  resolveConflict: (id, choice) => {
    const conflict = get().conflicts.find((item) => item.id === id);
    if (!conflict) return;
    const pending = pendingDeviceWrites.get(id);
    const chosen = choice === 'device' ? conflict.deviceValue : conflict.localValue;
    if (pending) clearPendingWrite(pending);
    set((state) => ({
      conflicts: state.conflicts.filter((item) => item.id !== id),
      ...conflictStatePatch(state, conflict, chosen),
    }));

    if (choice === 'local') {
      if (conflict.kind === 'control' && conflict.controlId) {
        get().setControl(conflict.controlId, chosen);
      } else if (conflict.kind === 'model' && conflict.blockId) {
        if (conflict.lane) get().setLaneModel(conflict.blockId, String(chosen));
        else get().setBlockModel(conflict.blockId, String(chosen));
      } else if (conflict.kind === 'master' && conflict.field) {
        get().setMaster(conflict.field as keyof MasterState, Number(chosen));
      } else if (conflict.kind === 'eq') {
        if (conflict.id === 'eq.enabled') {
          get().setEqEnabled(Boolean(chosen));
        } else if (conflict.index != null && conflict.field) {
          get().setEqBand(conflict.index, {
            [conflict.field]: conflict.field === 'type' ? String(chosen) : Number(chosen),
          } as Partial<EqBand>);
        }
      }
      get().notify(`Keeping local value for ${conflict.label}`, 'neutral');
    } else {
      if (conflict.blockId) void refreshBlockFromDevice(conflict.blockId);
      get().notify(`Using device value for ${conflict.label}`, 'neutral');
    }
  },

  recordDeviceOperation: (operation, coalesce = false) => {
    if (deviceReplaying || get().connection.mode !== 'device') return;
    set((state) => {
      const stack = [...state.deviceUndoStack];
      const top = stack.at(-1);
      const merged = coalesce && top ? mergeDeviceOperation(top, operation) : null;
      if (merged) stack[stack.length - 1] = merged;
      else stack.push(operation);
      return {
        deviceUndoStack: stack.slice(-100),
        deviceRedoStack: [],
        save: { ...state.save, edited: true },
      };
    });
  },

  clearDeviceHistory: () => set({ deviceUndoStack: [], deviceRedoStack: [] }),

  setTuner: (patch) => set((state) => ({ tuner: { ...state.tuner, ...patch } })),

  tickTuner: () => {
    const state = get();
    const active = (state.tunerOpen || state.view === 'stage') && state.tuner.available;
    if (!active) return;
    if (state.connection.mode === 'device') {
      // Only one poll may be queued at a time. Without this guard a slow read
      // built up a backlog that delayed the tuner OFF write until well after
      // the deck had closed.
      if (tunerPollInFlight) return;
      const nowMs = Date.now();
      if (nowMs - lastTunerPoll < 500) return;
      lastTunerPoll = nowMs;
      tunerPollInFlight = true;
      tauriClient
        .tunerPoll()
        .then((view) => {
          set((current) => ({
            tuner: {
              ...current.tuner,
              available: view.available,
              message: view.message ?? undefined,
              enabled: view.available ? view.enabled : false,
              note: view.note ?? current.tuner.note,
              cents: view.cents ?? current.tuner.cents,
              frequency: view.frequency ?? current.tuner.frequency,
              reference: view.reference ?? current.tuner.reference,
              level: view.level ?? current.tuner.level,
            },
          }));
        })
        .catch(() => undefined)
        .finally(() => {
          tunerPollInFlight = false;
        });
      return;
    }
    set((current) => {
      const cents = Math.max(-9, Math.min(9, current.tuner.cents + (Math.random() - 0.5) * 1.6));
      return {
        tuner: {
          ...current.tuner,
          cents,
          frequency: 110 * 2 ** (cents / 1200),
          level: -18 + Math.random() * 2,
        },
      };
    });
  },

  notify: (message, tone = 'neutral') => {
    const id = toastId.current++;
    set({ toast: { id, message, tone } });
    window.setTimeout(() => {
      set((state) => (state.toast?.id === id ? { toast: null } : state));
    }, 2600);
  },

  copyDiagnostics: () => {
    void (async () => {
      try {
        let text: string;
        if (isTauriRuntime()) {
          text = await tauriClient.copyDiagnostics();
        } else {
          const state = get();
          text = [
            'StompStation PRO diagnostic report (demo)',
            `app: ${state.appVersion || 'dev'}`,
            `mode: ${state.connection.mode}`,
            `transport: ${state.connection.transport}`,
            `address: ${state.connection.address || '—'}`,
            `device: ${state.connection.deviceName}`,
            `firmware: ${state.connection.firmware || '—'}`,
            `poll: ${state.connection.pollMs} ms · ${state.connection.lastPollMs.toFixed(1)} ms last`,
            `state: ${state.connection.connected ? 'connected' : 'offline'}`,
          ].join('\n');
        }
        let copied = false;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
          }
        } catch {
          copied = false;
        }
        if (!copied) {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          copied = document.execCommand('copy');
          area.remove();
        }
        if (!copied) {
          throw new Error('the clipboard is not available');
        }
        get().notify('Diagnostic report copied', 'good');
      } catch (error) {
        get().notify(ipcErrorMessage(error), 'bad');
      }
    })();
  },

  addActivity: (title, detail, tone = 'neutral') => {
    set((state) => ({
      activity: [
        { id: `activity-${Date.now()}-${Math.random()}`, time: now(), title, detail, tone },
        ...state.activity,
      ].slice(0, 80),
    }));
  },

  getSelectedBlock: () =>
    get().blocks.find((block) => block.id === get().selectedBlockId),

  getKnobIds: (block) => getBlockKnobIds(block),
  getControl: (block, controlId) => blockControl(block, controlId),
}));

const scheduledBlockRefreshes = new Set<string>();

async function refreshBlockFromDevice(blockId: string): Promise<void> {
  const snapshot = lastDeviceSnapshot;
  if (!snapshot) return;
  if (useAppStore.getState().connection.mode !== 'device') return;
  try {
    const editor = await tauriClient.selectBlock(blockId);
    const current = useAppStore.getState();
    const index = current.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return;
    let mapped = mapBlock(snapshot, editor, index);
    for (const conflict of current.conflicts) {
      if (conflict.blockId !== blockId) continue;
      if (conflict.controlId) {
        mapped = withControlState(mapped, conflict.controlId, conflict.localValue, true);
      } else if (conflict.kind === 'model') {
        mapped = withModelState(mapped, conflict.localValue, Boolean(conflict.lane));
      }
    }
    useAppStore.setState((latest) => ({
      blocks: latest.blocks.map((block, item) => (item === index ? mapped : block)),
    }));
  } catch (error) {
    console.error('Could not refresh the block editor', error);
  }
}

async function refreshChangedBlocks(
  snapshot: RustSnapshot,
  paths: string[],
): Promise<void> {
  const current = useAppStore.getState();
  if (current.connection.mode !== 'device') return;
  const now = Date.now();
  const eligible: string[] = [];
  for (const path of paths) {
    const youngPending = [...pendingDeviceWrites.values()].some(
      (entry) => entry.blockId === path && now - entry.issuedAt < 250,
    );
    if (youngPending) {
      if (!scheduledBlockRefreshes.has(path)) {
        scheduledBlockRefreshes.add(path);
        window.setTimeout(() => {
          scheduledBlockRefreshes.delete(path);
          void refreshChangedBlocks(lastDeviceSnapshot ?? snapshot, [path]);
        }, 320);
      }
      continue;
    }
    eligible.push(path);
  }
  if (!eligible.length) return;

  const editors = await Promise.allSettled(
    eligible.map((path) => tauriClient.selectBlock(path)),
  );
  const latest = useAppStore.getState();
  if (latest.connection.mode !== 'device') return;
  const nextConflicts = new Map(
    latest.conflicts.map((conflict) => [conflict.id, conflict]),
  );
  let blocks = latest.blocks;
  let changed = false;
  let externalChanged = false;
  let addedConflicts = 0;

  editors.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const path = eligible[index];
    const blockIndex = blocks.findIndex((block) => block.id === path);
    if (blockIndex < 0) return;
    const incomingBlock = snapshot.chain.blocks.find((block) => block.path === path);
    if (
      incomingBlock &&
      (incomingBlock.control_revision ?? 0) < (blocks[blockIndex].controlRevision ?? 0)
    ) {
      return;
    }
    const deviceMapped = mapBlock(snapshot, result.value, blockIndex);
    let mapped = deviceMapped;
    const pendingForBlock = [...pendingDeviceWrites.values()].filter(
      (entry) => entry.blockId === path,
    );

    for (const entry of pendingForBlock) {
      if (Date.now() - entry.issuedAt < 250) continue;
      if (entry.kind === 'control' && entry.controlId) {
        const deviceControl = allBlockControls(deviceMapped).find(
          (control) => control.id === entry.controlId,
        );
        if (!deviceControl) continue;
        if (!sameConflictValue(deviceControl.value, entry.localValue)) {
          const existed = nextConflicts.has(entry.id);
          nextConflicts.set(entry.id, {
            id: entry.id,
            kind: 'control',
            label: entry.label,
            localValue: entry.localValue,
            deviceValue: deviceControl.value,
            blockId: path,
            controlId: entry.controlId,
          });
          mapped = withControlState(mapped, entry.controlId, entry.localValue, true);
          if (!existed) addedConflicts += 1;
        } else {
          nextConflicts.delete(entry.id);
        }
      } else if (entry.kind === 'model') {
        const deviceValue = entry.lane ? deviceMapped.secondLane?.model : deviceMapped.model;
        if (deviceValue == null) continue;
        if (!sameConflictValue(deviceValue, entry.localValue)) {
          const existed = nextConflicts.has(entry.id);
          nextConflicts.set(entry.id, {
            id: entry.id,
            kind: 'model',
            label: entry.label,
            localValue: entry.localValue,
            deviceValue,
            blockId: path,
            controlId: entry.controlId,
            lane: entry.lane,
          });
          mapped = withModelState(mapped, entry.localValue, Boolean(entry.lane));
          if (!existed) addedConflicts += 1;
        } else {
          nextConflicts.delete(entry.id);
        }
      }
    }

    for (const conflict of [...nextConflicts.values()]) {
      if (conflict.blockId !== path) continue;
      let deviceValue: ConflictValue | undefined;
      if (conflict.controlId) {
        deviceValue = allBlockControls(deviceMapped).find(
          (control) => control.id === conflict.controlId,
        )?.value;
      } else if (conflict.kind === 'model') {
        deviceValue = conflict.lane ? deviceMapped.secondLane?.model : deviceMapped.model;
      }
      if (
        deviceValue !== undefined &&
        sameConflictValue(deviceValue, conflict.localValue)
      ) {
        nextConflicts.delete(conflict.id);
        continue;
      }
      if (conflict.controlId) {
        mapped = withControlState(mapped, conflict.controlId, conflict.localValue, true);
      } else if (conflict.kind === 'model') {
        mapped = withModelState(mapped, conflict.localValue, Boolean(conflict.lane));
      }
    }

    const recentLocal =
      Date.now() - (recentLocalBlockWrites.get(path) ?? 0) <= 1500;
    if (!recentLocal && blockValuesDiffer(blocks[blockIndex], mapped)) {
      externalChanged = true;
    }
    blocks = blocks.map((block, item) => (item === blockIndex ? mapped : block));
    changed = true;
  });

  if (!changed) return;
  useAppStore.setState({ blocks, conflicts: [...nextConflicts.values()] });
  if (addedConflicts > 0) {
    latest.addActivity('Changed on device', 'review the control conflict', 'warn');
    latest.notify('Changed on device — review the control conflict', 'warn');
  } else if (externalChanged) {
    latest.addActivity('Changed on device', 'controls updated', 'warn');
    latest.notify('Changed on device — controls updated', 'warn');
  }
}

declare global {
  interface Window {
    /** Test hook used by the Playwright visual-state checks in dev mode. */
    __stompTest?: { store: typeof useAppStore };
  }
}

if (import.meta.env.DEV) {
  window.__stompTest = { store: useAppStore };
}
