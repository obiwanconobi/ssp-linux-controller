import { invoke } from '@tauri-apps/api/core';

export interface RustControlValue {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
}

export interface RustChainSlot {
  row: number;
  col: number;
  path: string | null;
  fixed: boolean;
  link: 'series' | 'parallel' | null;
  label: string;
  family: string;
  on: boolean | null;
}

export interface RustChainBlock {
  path: string;
  label: string;
  family: string;
  on: boolean | null;
  on_path: string;
  in_chain: boolean;
}

export interface RustAvailableBlock {
  path: string;
  name: string;
  desc: string;
}

export interface RustPreset {
  current: string;
  index: number | null;
  names: string[];
  list_path: string | null;
  preset_path: string | null;
}

export interface RustMaster {
  volume: RustControlValue | null;
  tempo: RustControlValue | null;
  preset_level: RustControlValue | null;
}

export interface RustEqBand {
  index: number;
  device_index: number;
  enabled: boolean;
  kind: 'low_shelf' | 'high_shelf' | 'bell' | 'low_pass' | 'high_pass' | 'notch';
  frequency: number;
  gain_db: number;
  q: number;
}

export interface RustEq {
  path: string;
  on_path: string;
  enabled: boolean;
  bands: RustEqBand[];
}

export interface RustLibrarySlot {
  index: number;
  name: string;
  used: boolean;
  active: boolean;
}

export interface RustLibraryList {
  path: string;
  label: string;
  kind: 'nam' | 'pnam' | 'ir';
  slot_size: number;
  active_slot: number | null;
  slots: RustLibrarySlot[];
}

export interface RustSnapshot {
  revision: number;
  connected: boolean;
  device_name: string;
  firmware: string;
  device_id: string;
  usb_status: string;
  preset: RustPreset;
  chain: {
    router_present: boolean;
    slots: RustChainSlot[];
    blocks: RustChainBlock[];
    available_blocks: RustAvailableBlock[];
  };
  master: RustMaster;
  meters: { input: [number, number]; output: [number, number] };
  eq: RustEq | null;
  lists: RustLibraryList[];
}

export interface RustTunerView {
  available: boolean;
  message: string | null;
  enabled: boolean;
  note: string;
  cents: number;
  frequency: number;
  reference: number;
  level: number;
  in_tune: boolean;
}

export interface RustEditorNode {
  kind: string;
  path: string;
  name: string;
  label: string;
  value: unknown;
  visible: boolean;
  desc: string;
  min: number | null;
  max: number | null;
  display_min: number | null;
  display_max: number | null;
  display_default: number | null;
  decimals: number | null;
  unit: string;
  options: string[];
  pfloat: boolean;
  vtype: string;
  item_type: string;
  on_off: { path: string; value: boolean | null } | null;
  module_value: string | null;
  rawdata: RustEditorNode | null;
  subdivision: RustEditorNode | null;
  lock: RustEditorNode | null;
  mode_options: Array<{ value: string; label: string }>;
  parameters: RustEditorNode[];
  items: RustEditorNode[];
}

export interface RustBlockEditor {
  path: string;
  label: string;
  family: string;
  on: boolean | null;
  on_path: string;
  parameters: RustEditorNode[];
  items: RustEditorNode[];
}

export interface ConnectionInfo {
  address: string;
  transport: string;
  device_name: string;
  firmware: string;
  node_count: number;
}

export interface PortInfo {
  device: string;
  description: string;
  usb: boolean;
  vendor_id: string | null;
  product_id: string | null;
}

export interface RustLocalCapture {
  path: string;
  name: string;
  relative: string;
  kind: 'nam' | 'pnam' | 'ir';
  size: number;
}

export interface RustLocalScan {
  root: string;
  files: RustLocalCapture[];
  truncated: boolean;
}

export interface RustUploadPreflight {
  kind: 'nam' | 'pnam' | 'ir';
  name: string;
  file_size: number;
  slot_size: number;
  slot: number;
  overwrite: string | null;
  ready: boolean;
  warnings: string[];
}

export interface RustUploadResult {
  target: string;
  slot: number;
  name: string;
  chunks: number;
  payload_bytes: number;
}

export interface RustUploadProgress {
  id: string;
  kind: 'nam' | 'pnam' | 'ir';
  target: string;
  slot: number;
  name: string;
  ack: number;
  total_acks: number;
  progress: number;
  bytes_sent: number;
  total_bytes: number;
}

export interface RustUploadCompletion {
  cancelled: boolean;
  result: RustUploadResult | null;
  snapshot: RustSnapshot;
}

export interface DiscoveredDevice {
  service: string;
  name: string;
  host: string;
  port: number;
  mac: string | null;
  valid: boolean;
}

export interface Bootstrap {
  product: string;
  version: string;
  platform: string;
  connected: boolean;
  demo_allowed: boolean;
  transports: string[];
  serial_ports: PortInfo[];
}

export const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isMobileRuntime = (): boolean =>
  typeof navigator !== 'undefined' && /android|iphone|ipad/i.test(navigator.userAgent);

const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const latestCall = new Map<string, () => Promise<unknown>>();
const activeWrites = new Set<Promise<unknown>>();

const trackWrite = (promise: Promise<unknown>): void => {
  activeWrites.add(promise);
  void promise.finally(() => activeWrites.delete(promise));
};

/**
 * Coalesce high-frequency writes at 50 ms. The UI keeps its local value at
 * pointer rate; the device always receives the final value.
 */
export function coalesce(
  key: string,
  call: () => Promise<unknown>,
  onError?: (message: string) => void,
): void {
  latestCall.set(key, call);
  const existing = activeTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    activeTimers.delete(key);
    const pending = latestCall.get(key);
    latestCall.delete(key);
    if (!pending) return;
    const write = pending().catch((error: unknown) => {
      const message = ipcErrorMessage(error);
      if (onError) onError(message);
      else console.error(message);
    });
    trackWrite(write);
  }, 50);
  activeTimers.set(key, timer);
}

/** Run every coalesced write now, so a save cannot overtake a pending edit. */
export async function flushCoalesced(
  onError?: (message: string) => void,
): Promise<void> {
  const pending = [...latestCall.entries()];
  latestCall.clear();
  for (const [key] of pending) {
    const timer = activeTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      activeTimers.delete(key);
    }
  }
  for (const [, call] of pending) {
    const write = call().catch((error: unknown) => {
      onError?.(ipcErrorMessage(error));
    });
    trackWrite(write);
  }
  // Also wait for writes whose 50 ms timer already fired.
  await Promise.allSettled([...activeWrites]);
}

export function ipcErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export const tauriClient = {
  bootstrap: () => invoke<Bootstrap>('get_bootstrap'),
  listPorts: () => invoke<PortInfo[]>('list_serial_ports'),
  discoverWifi: () => invoke<DiscoveredDevice[]>('discover_wifi'),
  connect: (address: string) => invoke<ConnectionInfo>('connect', { address }),
  autoConnect: () => invoke<ConnectionInfo>('auto_connect'),
  disconnect: () => invoke<void>('disconnect'),
  getSnapshot: () => invoke<RustSnapshot>('get_snapshot'),
  refresh: () => invoke<RustSnapshot>('refresh'),
  selectBlock: (blockPath: string) => invoke<RustBlockEditor>('select_block', { blockPath }),
  setBlock: (blockPath: string, on: boolean) => invoke<RustSnapshot>('set_block', { blockPath, on }),
  setControl: (path: string, value: unknown) => invoke<RustSnapshot>('set_control', { path, value }),
  setPreset: (name: string) => invoke<RustSnapshot>('set_preset', { name }),
  savePreset: (name?: string) => invoke<RustSnapshot>('save_preset', { name: name ?? null }),
  renamePreset: (oldName: string, newName: string) =>
    invoke<RustSnapshot>('rename_preset', { oldName, newName }),
  editChain: (edit: Record<string, unknown>) => invoke<RustSnapshot>('edit_chain', { edit }),
  setMaster: (control: string, value: number) =>
    invoke<RustSnapshot>('set_master', { control, value }),
  setEqBand: (index: number, field: string, value: number) =>
    invoke<RustSnapshot>('set_eq_band', { index, field, value }),
  setEqType: (index: number, value: string) =>
    invoke<RustSnapshot>('set_eq_type', { index, value }),
  setEqEnabled: (enabled: boolean) => invoke<RustSnapshot>('set_eq_enabled', { enabled }),
  setAlias: (alias: string) => invoke<RustSnapshot>('set_alias', { alias }),
  tunerOpen: () => invoke<RustTunerView>('tuner_open'),
  tunerPoll: () => invoke<RustTunerView>('tuner_poll'),
  tunerClose: () => invoke('tuner_close'),
  copyDiagnostics: () => invoke<string>('copy_diagnostics'),
  scanCaptures: (directory: string) =>
    invoke<RustLocalScan>('scan_captures', { directory }),
  preflightUpload: (
    kind: 'nam' | 'pnam' | 'ir',
    filePath: string,
    target: string,
    slot?: number,
  ) =>
    invoke<RustUploadPreflight>('preflight_upload', {
      kind,
      filePath,
      target,
      slot: slot ?? null,
    }),
  beginUpload: (
    id: string,
    kind: 'nam' | 'pnam' | 'ir',
    filePath: string,
    target: string,
    slot?: number,
  ) =>
    invoke<RustUploadCompletion>('begin_upload', {
      id,
      kind,
      filePath,
      target,
      slot: slot ?? null,
    }),
  cancelUpload: () => invoke<boolean>('cancel_upload'),
  deleteListItem: (listPath: string, index: number) =>
    invoke<RustSnapshot>('delete_list_item', { listPath, index }),
};
