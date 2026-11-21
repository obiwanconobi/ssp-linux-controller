import type {
  Block,
  BlockFamily,
  ConnectionState,
  Control,
  ControlGroup,
  EqBand,
  EqBandType,
  LibraryList,
  MasterState,
  MeterState,
  PresetState,
} from '../types';
import type {
  ConnectionInfo,
  RustBlockEditor,
  RustEditorNode,
  RustSnapshot,
} from './client';

const FAMILY_NAMES: Record<string, BlockFamily> = {
  gate: 'gate',
  pitch: 'pitch',
  comp: 'comp',
  drive: 'drive',
  amp: 'amp',
  cab: 'cab',
  mod: 'mod',
  delay: 'delay',
  reverb: 'reverb',
  utility: 'utility',
};

const FAMILY_BY_NAME: Record<string, BlockFamily> = {
  gate: 'gate',
  pitch: 'pitch',
  pitch_time: 'pitch',
  comp: 'comp',
  dyna_comp: 'comp',
  drive: 'drive',
  dtchr: 'drive',
  pcm42: 'drive',
  amp: 'amp',
  ir: 'cab',
  mod: 'mod',
  mod_pre: 'mod',
  chorus: 'mod',
  flanger: 'mod',
  rotary: 'mod',
  delay: 'delay',
  delay2: 'delay',
  reverb: 'reverb',
  reverb2: 'reverb',
};

const SHORT_NAMES: Record<BlockFamily, string> = {
  gate: 'GATE',
  pitch: 'PITCH',
  comp: 'COMP',
  drive: 'DRIVE',
  amp: 'AMP / NAM',
  cab: 'CAB',
  mod: 'MOD',
  delay: 'DELAY',
  reverb: 'REVERB',
  utility: 'UTILITY',
};

const EQ_KINDS: Record<string, EqBandType> = {
  low_shelf: 'LPS',
  high_shelf: 'HPS',
  bell: 'BP',
  low_pass: 'LP',
  high_pass: 'HP',
  notch: 'BP',
};

const isGroup = (node: RustEditorNode) => node.kind === 'group' || node.kind === 'time';

const toControl = (node: RustEditorNode): Control => {
  const kind =
    node.kind === 'pfloat'
      ? 'pfloat'
      : node.kind === 'enum' || node.kind === 'choice'
        ? 'choice'
        : node.kind === 'bool'
          ? 'bool'
          : node.kind === 'text'
            ? 'text'
            : 'float';
  const range = Math.abs((node.max ?? 1) - (node.min ?? 0));
  const decimals = node.decimals ?? (range <= 10 ? 1 : 0);
  const displayRange = Math.abs((node.display_max ?? 1) - (node.display_min ?? 0));
  const step =
    kind === 'float' || kind === 'pfloat'
      ? node.decimals != null
        ? 10 ** -Math.min(4, node.decimals)
        : (node.pfloat ? displayRange : range) <= 10
          ? 0.1
          : (node.pfloat ? displayRange : range) <= 100
            ? 1
            : 10
      : 1;

  return {
    id: node.path,
    name: node.name,
    label:
      node.kind === 'pfloat'
        ? node.label || node.desc || node.name
        : node.desc || node.label || node.name,
    kind,
    value:
      kind === 'bool'
        ? Boolean(node.value)
        : kind === 'float' || kind === 'pfloat'
          ? Number(node.value ?? 0)
          : String(node.value ?? ''),
    defaultValue:
      typeof node.value === 'number' ? node.value : String(node.value ?? ''),
    min: node.min ?? undefined,
    max: node.max ?? undefined,
    step,
    unit: node.unit || undefined,
    options: node.options.length ? [...node.options] : undefined,
    visible: node.visible,
    decimals,
    pfloat: node.pfloat,
    displayMin: node.display_min ?? undefined,
    displayMax: node.display_max ?? undefined,
  };
};

const toGroup = (node: RustEditorNode): ControlGroup => {
  const controls = node.parameters.filter((child) => child.visible).map(toControl);
  if (node.kind === 'time' && node.rawdata) {
    const raw = node.rawdata;
    controls.unshift({
      ...toControl(raw),
      name: node.name,
      label: node.label || 'Time',
    });
  }
  return {
    id: node.path,
    label: node.label || node.name,
    itemType: node.item_type || 'vfolder',
    enabled: node.on_off?.value ?? undefined,
    onOffId: node.on_off?.path,
    modePath: node.mode_options.length > 0 ? node.path : undefined,
    modeValue: node.module_value ?? undefined,
    modeOptions: node.mode_options.length > 0 ? node.mode_options : undefined,
    controls,
    groups: node.items.filter(isGroup).map(toGroup),
  };
};

const flatControls = (editor: RustBlockEditor): RustEditorNode[] => {
  const out: RustEditorNode[] = [...editor.parameters];
  const walk = (nodes: RustEditorNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'group' || node.kind === 'time') {
        out.push(...node.parameters);
        walk(node.items);
      }
    }
  };
  walk(editor.items);
  return out;
};

const findModel = (nodes: RustEditorNode[]) => {
  const models = nodes.filter(
    (node) =>
      (node.kind === 'choice' || node.kind === 'enum') &&
      (node.name === 'model' || node.name === 'pmodel' || node.name === 'ir') &&
      node.options.length > 0,
  );
  // NAM and Parametric NAM keep both loaders in the editor, but only the
  // active one is visible. Prefer it so the shell/loader follows the type.
  return models.find((node) => node.visible) ?? models[0];
};

const mapBlock = (
  snapshot: RustSnapshot,
  editor: RustBlockEditor,
  index: number,
): Block => {
  const name = editor.path.split('\\').pop() ?? editor.path;
  const family = FAMILY_BY_NAME[name] ?? FAMILY_NAMES[editor.family] ?? 'utility';
  const slot = snapshot.chain.slots.find((candidate) => candidate.path === editor.path);
  const allControls = flatControls(editor);
  const modelControl = findModel(editor.parameters) ?? findModel(allControls);
  const directControls = editor.parameters
    .filter((node) => node.path !== modelControl?.path && node.visible)
    .map(toControl);
  const groups = editor.items.filter(isGroup).map(toGroup);
  const laneGroup = editor.items.find(
    (node) =>
      isGroup(node) &&
      (node.name === 'nam2' ||
        node.name === 'ir2' ||
        node.path.endsWith('\\nam2') ||
        node.path.endsWith('\\ir2')),
  );
  const laneModel = laneGroup ? findModel(laneGroup.parameters) ?? findModel(laneGroup.items.flatMap((item) => item.parameters)) : undefined;
  const laneControls = laneGroup
    ? [...laneGroup.parameters, ...laneGroup.items.flatMap((item) => item.parameters)]
        .filter((node) => !isGroup(node) && node.path !== laneModel?.path && node.visible)
        .map(toControl)
    : [];

  return {
    id: editor.path,
    label: editor.label,
    shortName: SHORT_NAMES[family],
    family,
    on: editor.on ?? slot?.on ?? false,
    fixed: slot?.fixed ?? false,
    link: slot?.link ?? 'series',
    model: modelControl ? String(modelControl.value) : editor.label,
    modelOptions: modelControl?.options.length ? [...modelControl.options] : undefined,
    modelControlId: modelControl?.path,
    controls: directControls,
    groups,
    footswitch: index + 1,
    slotRow: slot?.row,
    slotCol: slot?.col,
    secondLane: laneGroup
      ? {
          id: laneGroup.path,
          label: laneGroup.label || laneGroup.name,
          model: laneModel ? String(laneModel.value) : laneGroup.label,
          modelOptions: laneModel?.options.length ? [...laneModel.options] : [],
          enabled: laneGroup.on_off?.value ?? true,
          modelControlId: laneModel?.path,
          onOffId: laneGroup.on_off?.path,
          controls: laneControls,
        }
      : undefined,
  };
};

export interface MappedDevice {
  blocks: Block[];
  availableBlocks: Array<{ id: string; label: string; desc: string }>;
  master: MasterState;
  eq: EqBand[];
  eqEnabled: boolean;
  lists: LibraryList[];
  preset: PresetState;
  meters: MeterState;
  connection: ConnectionState;
}

export const mapAvailableBlocks = (
  snapshot: RustSnapshot,
): Array<{ id: string; label: string; desc: string }> =>
  snapshot.chain.available_blocks.map((block) => ({
    id: block.path,
    label: block.name,
    desc: block.desc,
  }));

export const mapMaster = (snapshot: RustSnapshot): MasterState => ({
  volume: snapshot.master.volume?.value ?? snapshot.master.volume?.min ?? 0,
  volumeMin: snapshot.master.volume?.min ?? 0,
  volumeMax: snapshot.master.volume?.max ?? 100,
  presetLevel: snapshot.master.preset_level?.value ?? 0,
  presetLevelAvailable: snapshot.master.preset_level != null,
  tempo: snapshot.master.tempo?.value ?? 120,
  tempoMin: snapshot.master.tempo?.min ?? 20,
  tempoMax: snapshot.master.tempo?.max ?? 300,
});

export const mapEq = (
  snapshot: RustSnapshot,
  fallback: EqBand[],
): { eq: EqBand[]; eqEnabled: boolean } => ({
  eq: snapshot.eq
    ? snapshot.eq.bands.map((band) => ({
        index: band.index,
        deviceIndex: band.device_index,
        enabled: band.enabled,
        type: EQ_KINDS[band.kind] ?? 'BP',
        frequency: band.frequency,
        gain: band.gain_db,
        q: band.q,
      }))
    : fallback,
  eqEnabled: snapshot.eq?.enabled ?? false,
});

export const mapLists = (snapshot: RustSnapshot): LibraryList[] =>
  snapshot.lists.map((list) => ({
    id: list.path.split('\\').pop() ?? list.path,
    label: list.label,
    kind: list.kind,
    slotSize: list.slot_size,
    activeSlot: list.active_slot ?? undefined,
    slots: list.slots.map((slot) => ({
      index: slot.index,
      name: slot.name,
      used: slot.used,
      active: slot.active,
    })),
  }));

export const mapPreset = (
  snapshot: RustSnapshot,
  previous: PresetState,
): PresetState => ({
  current: snapshot.preset.current,
  index: snapshot.preset.index ?? 0,
  names: snapshot.preset.names,
  favorites: previous.favorites,
  recent: previous.recent,
});

export const mapMeters = (snapshot: RustSnapshot): MeterState => ({
  input: snapshot.meters.input,
  output: snapshot.meters.output,
});

export function mapSnapshot(
  snapshot: RustSnapshot,
  editors: Record<string, RustBlockEditor>,
  info: ConnectionInfo,
  previous: { preset: PresetState; connection: ConnectionState; eq: EqBand[] },
): MappedDevice {
  const blocks = snapshot.chain.blocks
    .map((block, index) => {
      const editor = editors[block.path];
      return editor ? mapBlock(snapshot, editor, index) : null;
    })
    .filter((block): block is Block => Boolean(block));
  const eqView = mapEq(snapshot, previous.eq);

  return {
    blocks,
    availableBlocks: mapAvailableBlocks(snapshot),
    master: mapMaster(snapshot),
    eq: eqView.eq,
    eqEnabled: eqView.eqEnabled,
    lists: mapLists(snapshot),
    preset: mapPreset(snapshot, previous.preset),
    meters: mapMeters(snapshot),
    connection: {
      ...previous.connection,
      connected: snapshot.connected,
      connecting: false,
      mode: 'device',
      transport: info.transport,
      deviceName: snapshot.device_name || info.device_name,
      firmware: snapshot.firmware || info.firmware,
      address: info.address,
      pollMs: 500,
      lastPollMs: 0,
    },
  };
}
