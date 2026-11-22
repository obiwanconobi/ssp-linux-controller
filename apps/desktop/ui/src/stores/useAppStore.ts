import { create } from 'zustand';
import {
  applyDemoBlockType,
  applyDemoLaneType,
  AVAILABLE_BLOCKS,
  cloneBlocks,
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
import { blockControl, getBlockKnobIds } from '../components/kit/knobMap';
import {
  UPLOAD_TARGET_PATHS,
  uploadTargetId,
  uploadTargetPath,
} from '../lib/uploads';
import {
  coalesce,
  flushCoalesced,
  ipcErrorMessage,
  isTauriRuntime,
  tauriClient,
} from '../ipc/client';
import type {
  ConnectionInfo,
  RustBlockEditor,
  RustSnapshot,
  RustUploadProgress,
} from '../ipc/client';
import {
  mapAvailableBlocks,
  mapEq,
  mapLists,
  mapMaster,
  mapMeters,
  mapPreset,
  mapSnapshot,
} from '../ipc/mapSnapshot';
import type {
  ActivityEntry,
  Block,
  ConnectionState,
  ControlGroup,
  Density,
  EqBand,
  LibraryList,
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
  selectedBlockId: string | null;
  blocks: Block[];
  availableBlocks: typeof AVAILABLE_BLOCKS;
  emptySlots: Array<{ row: number; col: number }>;
  master: MasterState;
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
  pending: string[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  commandOpen: boolean;
  connectionOpen: boolean;
  tunerOpen: boolean;
  activityOpen: boolean;
  shortcutsOpen: boolean;
  toast: Toast | null;
  demoAllowed: boolean;
  appVersion: string;
  lastEdit: { key: string; at: number };
  setView: (view: ViewId) => void;
  selectBlock: (id: string) => void;
  setPreset: (index: number) => void;
  savePreset: () => void;
  renamePreset: (oldName: string, newName: string) => void;
  deletePreset: (index: number) => void;
  deleteCapture: (listId: string, index: number) => void;
  addPreset: () => void;
  toggleFavorite: (name: string) => void;
  toggleBlock: (id: string) => void;
  setBlockModel: (blockId: string, model: string) => void;
  setLaneModel: (blockId: string, model: string) => void;
  setLaneEnabled: (blockId: string, enabled: boolean) => void;
  setControl: (controlId: string, value: number | string | boolean) => void;
  setLink: (id: string, parallel: boolean) => void;
  moveBlock: (activeId: string, overId: string) => void;
  addBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  clearChain: () => void;
  replaceBlock: (id: string, replacementId: string) => void;
  setMaster: (field: keyof MasterState, value: number) => void;
  setEqBand: (index: number, patch: Partial<EqBand>) => void;
  setEqEnabled: (enabled: boolean) => void;
  flattenEq: () => void;
  undo: () => void;
  redo: () => void;
  setTheme: (theme: ThemeId) => void;
  setDensity: (density: Density) => void;
  setMotion: (motion: Motion) => void;
  setCommandOpen: (open: boolean) => void;
  setConnectionOpen: (open: boolean) => void;
  setTunerOpen: (open: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  connectDemo: () => void;
  connectAuto: () => Promise<void>;
  connectReal: (address: string) => Promise<void>;
  setDemoAllowed: (allowed: boolean) => void;
  setAppVersion: (version: string) => void;
  refreshDevice: () => Promise<void>;
  applyDeviceSnapshot: (snapshot: RustSnapshot) => void;
  disconnect: () => void;
  addUpload: (file: {
    name: string;
    size: number;
    kind: 'nam' | 'pnam' | 'ir';
    target?: string;
    slot?: number;
    path?: string;
  }) => boolean;
  cancelUpload: (id?: string) => void;
  applyUploadProgress: (payload: RustUploadProgress) => void;
  tickUploads: () => void;
  setTuner: (patch: Partial<TunerState>) => void;
  tickTuner: () => void;
  notify: (message: string, tone?: Toast['tone']) => void;
  addActivity: (title: string, detail?: string, tone?: ActivityEntry['tone']) => void;
  getSelectedBlock: () => Block | undefined;
  getKnobIds: (block: Block) => string[];
  getControl: (block: Block, controlId: string) => ReturnType<typeof blockControl>;
}

const appearance = loadAppearance();
applyAppearance(appearance.theme, appearance.density, appearance.motion);

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
    tempo: 120,
    tempoMin: 20,
    tempoMax: 300,
  } as MasterState,
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
  const family = (['chorus', 'flanger', 'rotary'].includes(available.id)
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
  return VIEWS.includes(hash as ViewId) ? (hash as ViewId) : 'board';
};

async function collectDevice(
  connectAddress?: string,
): Promise<{
  snapshot: Awaited<ReturnType<typeof tauriClient.getSnapshot>>;
  editors: Record<string, RustBlockEditor>;
  info: ConnectionInfo | null;
}> {
  const info = connectAddress ? await tauriClient.connect(connectAddress) : null;
  const snapshot = await tauriClient.getSnapshot();
  const editors: Record<string, RustBlockEditor> = {};
  for (const block of snapshot.chain.blocks) {
    editors[block.path] = await tauriClient.selectBlock(block.path);
  }
  return { snapshot, editors, info };
}

let lastTunerPoll = 0;
let lastExternalSignature = '';
const pendingBlockWrites = new Map<string, { on: boolean; until: number }>();

export const useAppStore = create<AppStore>()((set, get) => ({
  view: initialView(),
  ...initialBoot,
  theme: appearance.theme,
  density: appearance.density,
  motion: appearance.motion,
  pending: [],
  undoStack: [],
  redoStack: [],
  commandOpen: false,
  connectionOpen: false,
  tunerOpen: false,
  activityOpen: false,
  shortcutsOpen: false,
  toast: null,
  appVersion: '',
  lastEdit: { key: '', at: 0 },

  setView: (view) => {
    set({ view, commandOpen: false });
    try {
      window.history.replaceState(null, '', `#${view}`);
    } catch {
      /* embedded webview may restrict history */
    }
  },

  selectBlock: (id) => set({ selectedBlockId: id }),

  setPreset: (index) => {
    const { preset } = get();
    const name = preset.names[index];
    if (!name) return;
    const recent = [name, ...preset.recent.filter((item) => item !== name)].slice(0, 6);
    set({
      preset: { ...preset, current: name, index, recent },
      save: { ...get().save, edited: false, revision: get().save.revision + 1 },
    });
    get().addActivity('Preset loaded', `${name} · slot ${index + 1}`, 'neutral');
    get().notify(`Loaded ${name}`, 'good');
    if (get().connection.mode === 'device') {
      tauriClient
        .setPreset(name)
        .then(() => window.setTimeout(() => void get().refreshDevice(), 320))
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

  renamePreset: (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      get().notify('Patch name cannot be empty', 'bad');
      return;
    }
    if (trimmed.length > 63) {
      get().notify('Patch name must be at most 63 bytes', 'bad');
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
      coalesce(
        `model.${blockId}`,
        () => tauriClient.setControl(updated.modelControlId!, model),
        (message) => get().notify(message, 'bad'),
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
      coalesce(
        `lane.${blockId}`,
        () => tauriClient.setControl(lane.modelControlId!, model),
        (message) => get().notify(message, 'bad'),
      );
    }
  },

  setLaneEnabled: (blockId, enabled) => {
    set((state) => ({
      blocks: state.blocks.map((block) =>
        block.id === blockId && block.secondLane
          ? { ...block, secondLane: { ...block.secondLane, enabled } }
          : block,
      ),
      save: { ...state.save, edited: true },
    }));
    get().notify(`NAM 2 ${enabled ? 'enabled' : 'disabled'}`, 'neutral');
    const lane = get().blocks.find((block) => block.id === blockId)?.secondLane;
    if (get().connection.mode === 'device' && lane?.onOffId) {
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
      coalesce(
        controlId,
        () => tauriClient.setControl(controlId, value),
        (message) => get().notify(message, 'bad'),
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
      tauriClient
        .editChain({ type: 'link', row: block.slotRow, col: block.slotCol, parallel })
        .then(() => window.setTimeout(() => void get().refreshDevice(), 200))
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
  },

  moveBlock: (activeId, overId) => {
    if (activeId === overId) return;
    const state = get();
    const from = state.blocks.findIndex((block) => block.id === activeId);
    const to = state.blocks.findIndex((block) => block.id === overId);
    if (from < 0 || to < 0) return;
    if (state.blocks[from].fixed || state.blocks[to].fixed) {
      get().notify('Fixed blocks cannot be moved', 'warn');
      return;
    }
    const before = snapshotOf(state);
    const blocks = [...state.blocks];
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    set({
      blocks,
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    });
    get().addActivity('Chain reordered', moved.label, 'neutral');
    if (get().connection.mode === 'device' && state.blocks[from].slotRow != null && state.blocks[to].slotRow != null) {
      tauriClient
        .editChain({
          type: 'move',
          from: [state.blocks[from].slotRow, state.blocks[from].slotCol],
          to: [state.blocks[to].slotRow, state.blocks[to].slotCol],
        })
        .then(() => window.setTimeout(() => void get().refreshDevice(), 200))
        .catch((error) => {
          get().notify(ipcErrorMessage(error), 'bad');
          void get().refreshDevice();
        });
    }
  },

  addBlock: (id) => {
    const current = get();
    const available = current.availableBlocks.find((item) => item.id === id);
    if (!available) return;
    if (current.connection.mode === 'device') {
      const slot = current.emptySlots[0];
      if (!slot) {
        current.notify('No free chain slot available', 'warn');
        return;
      }
      tauriClient
        .editChain({ type: 'add', row: slot.row, col: slot.col, path: id })
        .then(() => {
          set((state) => ({ save: { ...state.save, edited: true } }));
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
      tauriClient
        .editChain({ type: 'remove', row: block.slotRow, col: block.slotCol })
        .then(() => {
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
      tauriClient
        .editChain({ type: 'clear' })
        .then(() => {
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
      tauriClient
        .editChain({
          type: 'replace',
          row: block.slotRow,
          col: block.slotCol,
          path: replacementId,
        })
        .then(() => {
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
      coalesce(
        `master.${field}`,
        () => tauriClient.setMaster(field === 'presetLevel' ? 'preset_level' : field, value),
        (message) => get().notify(message, 'bad'),
      );
    }
  },

  setEqBand: (index, patch) => {
    const state = get();
    const before = snapshotOf(state);
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
        coalesce(
          `eq.${index}.${field}`,
          () =>
            field === 'type'
              ? tauriClient.setEqType(deviceIndex, String(fieldValue))
              : tauriClient.setEqBand(deviceIndex, field, Number(fieldValue)),
          (message) => get().notify(message, 'bad'),
        );
      }
    }
  },

  setEqEnabled: (enabled) => {
    set((state) => ({
      eqEnabled: enabled,
      eq: state.eq.map((band) => ({ ...band, enabled })),
      save: { ...state.save, edited: true },
    }));
    get().notify(`Global EQ ${enabled ? 'enabled' : 'bypassed'}`, 'neutral');
    if (get().connection.mode === 'device') {
      tauriClient
        .setEqEnabled(enabled)
        .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
  },

  flattenEq: () => {
    const before = snapshotOf(get());
    set((state) => ({
      eq: state.eq.map((band) => ({ ...band, gain: 0 })),
      undoStack: [...state.undoStack, before].slice(-40),
      redoStack: [],
      save: { ...state.save, edited: true },
    }));
    get().notify('Global EQ flattened — undo available', 'warn');
    if (get().connection.mode === 'device') {
      get().eq.forEach((band) =>
        coalesce(
          `eq.${band.index}.gain`,
          () => tauriClient.setEqBand(band.deviceIndex ?? band.index, 'gain', 0),
          (message) => get().notify(message, 'bad'),
        ),
      );
    }
  },

  undo: () => {
    const state = get();
    if (state.connection.mode === 'device') {
      get().notify('Device undo is not wired yet — change the value back on the board', 'warn');
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
      get().notify('Device redo is not wired yet', 'warn');
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

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setConnectionOpen: (connectionOpen) => set({ connectionOpen }),
  setTunerOpen: (tunerOpen) => {
    set({ tunerOpen });
    if (tunerOpen) {
      set((state) => ({ tuner: { ...state.tuner, enabled: true } }));
      get().addActivity('Tuner opened', 'input 1 · reference 440 Hz', 'neutral');
      if (get().connection.mode === 'device') {
        tauriClient
          .tunerOpen()
          .then((view) => {
            const tuner = view as { note?: string; cents?: number; frequency?: number; reference?: number; level?: number };
            set((state) => ({
              tuner: {
                ...state.tuner,
                note: tuner.note ?? state.tuner.note,
                cents: tuner.cents ?? state.tuner.cents,
                frequency: tuner.frequency ?? state.tuner.frequency,
                reference: tuner.reference ?? state.tuner.reference,
                level: tuner.level ?? state.tuner.level,
              },
            }));
          })
          .catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
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
    if (get().connection.mode === 'device') {
      tauriClient.disconnect().catch(() => undefined);
    }
    pendingBlockWrites.clear();
    const boot = demoBoot();
    set((state) => ({
      ...boot,
      connection: { ...boot.connection, connected: false, connecting: true },
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

  connectAuto: async () => {
    pendingBlockWrites.clear();
    set((state) => ({
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
      const info = await tauriClient.autoConnect();
      const { snapshot, editors } = await collectDevice();
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
      set((state) => ({
        ...mapped,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path)
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
      get().addActivity('Device found', `${info.node_count} nodes · ${info.transport}`, 'good');
      get().notify(`Connected to ${info.device_name || 'StompStation PRO'}`, 'good');
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

  connectReal: async (address) => {
    pendingBlockWrites.clear();
    set((state) => ({
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
      const { snapshot, editors, info } = await collectDevice(address);
      if (!info) throw new Error('the device did not return connection information');
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
      set((state) => ({
        ...mapped,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path)
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
      get().addActivity('Device synced', `${info.node_count} nodes · ${info.transport}`, 'good');
      get().notify(`Connected to ${info.device_name || 'StompStation PRO'}`, 'good');
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

  refreshDevice: async () => {
    const current = get();
    if (current.connection.mode !== 'device') return;
    try {
      const { snapshot, editors } = await collectDevice();
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
      const selected =
        mapped.blocks.find((block) => block.id === current.selectedBlockId)?.id ??
        mapped.blocks[0]?.id ??
        null;
      set((state) => ({
        ...mapped,
        emptySlots: snapshot.chain.slots
          .filter((slot) => !slot.path)
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

  applyDeviceSnapshot: (snapshot) => {
    const state = get();
    if (state.connection.mode !== 'device' || state.connection.connecting) return;
    // A snapshot read before a recent write must not rewind the board.
    if (snapshot.revision < state.save.revision) return;

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
      void state.refreshDevice();
      return;
    }

    let chainChanged = false;
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
      if (
        block.on !== on ||
        block.fixed !== fixed ||
        block.link !== link ||
        block.label !== next.label
      ) {
        chainChanged = true;
      }
      return { ...block, on, fixed, link, label: next.label };
    });

    const eqView = mapEq(snapshot, state.eq);
    set((current) => ({
      blocks: chainChanged ? blocks : current.blocks,
      master: mapMaster(snapshot),
      eq: eqView.eq,
      eqEnabled: eqView.eqEnabled,
      lists: mapLists(snapshot),
      preset: mapPreset(snapshot, current.preset),
      meters: mapMeters(snapshot),
      availableBlocks: mapAvailableBlocks(snapshot),
      emptySlots: snapshot.chain.slots
        .filter((slot) => !slot.path)
        .map((slot) => ({ row: slot.row, col: slot.col })),
      connection: {
        ...current.connection,
        connected: snapshot.connected,
        deviceName: snapshot.device_name || current.connection.deviceName,
        firmware: snapshot.firmware || current.connection.firmware,
      },
      save: { ...current.save, revision: snapshot.revision },
    }));
  },

  disconnect: () => {
    pendingBlockWrites.clear();
    if (get().connection.mode === 'device') {
      tauriClient.disconnect().catch((error) => get().notify(ipcErrorMessage(error), 'bad'));
    }
    set((state) => ({
      connection: {
        ...state.connection,
        connected: false,
        connecting: false,
        autoSearch: 'idle',
        autoSearchMessage: '',
        error: undefined,
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
      file.target ?? (kind === 'ir' ? 'ir_list' : kind === 'pnam' ? 'pnam_list' : 'nam_amp');
    const list = state.lists.find((item) => item.id === target);
    const targetLabel = list?.label ?? target;
    const slot = file.slot ?? list?.slots.find((item) => !item.used)?.index ?? 0;
    // Hardware safety: the backend re-checks this allowlist and validates the
    // file. Do not bypass preflight or add other upload targets; see
    // docs/DEVICE_SAFETY.md.
    if (!(target in UPLOAD_TARGET_PATHS)) {
      get().notify('Only NAM, Parametric NAM, and IR captures can be uploaded', 'bad');
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

  setTuner: (patch) => set((state) => ({ tuner: { ...state.tuner, ...patch } })),

  tickTuner: () => {
    const state = get();
    const active = state.tunerOpen || state.view === 'stage';
    if (!active) return;
    if (state.connection.mode === 'device') {
      const nowMs = Date.now();
      if (nowMs - lastTunerPoll < 500) return;
      lastTunerPoll = nowMs;
      tauriClient
        .tunerPoll()
        .then((view) => {
          const tuner = view as {
            note?: string;
            cents?: number;
            frequency?: number;
            reference?: number;
            level?: number;
          };
          set((current) => ({
            tuner: {
              ...current.tuner,
              note: tuner.note ?? current.tuner.note,
              cents: tuner.cents ?? current.tuner.cents,
              frequency: tuner.frequency ?? current.tuner.frequency,
              reference: tuner.reference ?? current.tuner.reference,
              level: tuner.level ?? current.tuner.level,
            },
          }));
        })
        .catch(() => undefined);
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

