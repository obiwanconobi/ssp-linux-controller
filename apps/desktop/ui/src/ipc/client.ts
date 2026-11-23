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
  control_revision?: number;
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

export interface RustInput {
  gain1: RustControlValue | null;
  gain2: RustControlValue | null;
  connected1: boolean | null;
  connected2: boolean | null;
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
  used_by?: number[];
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
  input: RustInput;
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

export interface RustActorStatus {
  connected: boolean;
  transport: string;
  address: string;
  reconnect_attempt: number;
  retry_in_ms: number | null;
  pending_writes: number;
  last_error: string | null;
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

export interface RustDownloadProgress {
  id: string;
  list_path: string;
  index: number;
  name: string;
  kind: string;
  chunk: number;
  total_chunks: number;
  progress: number;
  bytes: number;
  total_bytes: number;
}

export interface RustDownloadFile {
  path: string;
  list_path: string;
  index: number;
  name: string;
  kind: string;
  extension: string;
  bytes: number;
}

export interface RustDownloadCompletion {
  cancelled: boolean;
  file: RustDownloadFile | null;
}

export interface RustExportCompletion {
  path: string;
  preset_name: string;
  dependencies: string[];
  bytes: number;
}

export interface RustImportDependencyPlan {
  name: string;
  extension: string;
  node_path: string;
  archive_path: string;
  bytes: number;
  existing_index: number | null;
  target_index: number | null;
  action: 'compare' | 'upload' | 'reuse' | 'overwrite' | 'blocked' | string;
}

export interface RustImportPreflight {
  preset_name: string;
  preset_bytes: number;
  preset_entries: number;
  chain_blocks: string[];
  chain_changes: string[];
  target_slot: number | null;
  target_occupied_by: string | null;
  empty_slots: number[];
  dependencies: RustImportDependencyPlan[];
  blocked: boolean;
  errors: string[];
  warnings: string[];
}

export interface RustImportReport {
  preset_name: string;
  target_slot: number;
  dependencies_written: string[];
  dependencies_reused: string[];
  preset_bytes: number;
}

export interface RustImportCompletion {
  report: RustImportReport;
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
interface CoalescedCall {
  call: () => Promise<unknown>;
  onError?: (message: string, error: unknown) => void;
  onDone?: (result: unknown, error?: unknown) => void;
}
const latestCall = new Map<string, CoalescedCall>();
const activeWrites = new Set<Promise<unknown>>();

const trackWrite = (promise: Promise<unknown>): void => {
  activeWrites.add(promise);
  void promise.finally(() => activeWrites.delete(promise));
};

const runCoalesced = (entry: CoalescedCall, fallbackError?: (message: string) => void) => {
  const write = entry.call().then(
    (result) => {
      entry.onDone?.(result);
      return result;
    },
    (error: unknown) => {
      const message = ipcErrorMessage(error);
      if (entry.onError) entry.onError(message, error);
      else if (fallbackError) fallbackError(message);
      else console.error(message);
      entry.onDone?.(undefined, error);
    },
  );
  trackWrite(write);
};

/**
 * Coalesce high-frequency writes at 50 ms. The UI keeps its local value at
 * pointer rate; the device always receives the final value. `onDone` receives
 * the raw error so callers can distinguish a stale write after reconnect.
 */
export function coalesce(
  key: string,
  call: () => Promise<unknown>,
  onError?: (message: string, error: unknown) => void,
  onDone?: (result: unknown, error?: unknown) => void,
): void {
  latestCall.set(key, { call, onError, onDone });
  const existing = activeTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    activeTimers.delete(key);
    const pending = latestCall.get(key);
    latestCall.delete(key);
    if (pending) runCoalesced(pending);
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
  for (const [, entry] of pending) {
    runCoalesced(entry, onError);
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

export function ipcErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return null;
}

/** A write rejected because the actor reconnected before it was applied. */
export const isStaleWriteError = (error: unknown): boolean =>
  ipcErrorCode(error) === 'stale_connection' ||
  ipcErrorMessage(error).includes('connection changed before this write was sent');

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
  setInputGain: (channel: 1 | 2, value: number) =>
    invoke<RustSnapshot>('set_input_gain', { channel, value }),
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
  downloadListItem: (
    id: string,
    listPath: string,
    index: number,
    destination: string,
    overwrite = true,
  ) =>
    invoke<RustDownloadCompletion>('download_list_item', {
      id,
      listPath,
      index,
      destination,
      overwrite,
    }),
  cancelDownload: () => invoke<boolean>('cancel_download'),
  exportPreset: (index: number, destination: string, overwrite = true) =>
    invoke<RustExportCompletion>('export_preset', { index, destination, overwrite }),
  preflightPresetImport: (bundlePath: string, targetSlot?: number) =>
    invoke<RustImportPreflight>('preflight_preset_import', {
      bundlePath,
      targetSlot: targetSlot ?? null,
    }),
  importPresetBundle: (
    bundlePath: string,
    targetSlot: number,
    overwritePreset: boolean,
    overwriteDependencies: boolean,
  ) =>
    invoke<RustImportCompletion>('import_preset_bundle', {
      bundlePath,
      targetSlot,
      overwritePreset,
      overwriteDependencies,
    }),
  renameListItem: (listPath: string, index: number, newName: string) =>
    invoke<RustSnapshot>('rename_list_item', { listPath, index, newName }),
  deleteListItem: (listPath: string, index: number) =>
    invoke<RustSnapshot>('delete_list_item', { listPath, index }),
};
