// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RustBlockEditor,
  RustSnapshot,
  RustUploadCompletion,
} from '../ipc/client';

const loadFixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), `../../../fixtures/snapshots/${name}`), 'utf8'),
  ) as { snapshot: RustSnapshot; editors: Record<string, RustBlockEditor> };

const fixture = loadFixture('simulator-2.4.4.json');
const hardware = loadFixture('hardware-2.4.4.json');

const info = {
  address: 'tcp:127.0.0.1:45678',
  transport: 'network 127.0.0.1:45678',
  device_name: 'StompStation PRO',
  firmware: '2.4.4',
  node_count: 132,
};

const tuner = {
  available: true,
  message: null as string | null,
  enabled: true,
  note: 'A',
  cents: 0,
  frequency: 440,
  reference: 440,
  level: -20,
  in_tune: true,
};

const client = {
  connect: vi.fn(async () => info),
  getSnapshot: vi.fn(async () => fixture.snapshot),
  refresh: vi.fn(async () => fixture.snapshot),
  selectBlock: vi.fn(async (path: string) => fixture.editors[path]),
  setBlock: vi.fn(async () => ({ ...fixture.snapshot, revision: fixture.snapshot.revision + 1 })),
  setControl: vi.fn(async (_path: string, _value: unknown) => fixture.snapshot),
  setMaster: vi.fn(async () => fixture.snapshot),
  setInputGain: vi.fn(async () => fixture.snapshot),
  setEqBand: vi.fn(async () => fixture.snapshot),
  setEqType: vi.fn(async () => fixture.snapshot),
  setEqEnabled: vi.fn(async () => fixture.snapshot),
  setPreset: vi.fn(async () => fixture.snapshot),
  savePreset: vi.fn(async () => fixture.snapshot),
  renamePreset: vi.fn(async () => fixture.snapshot),
  editChain: vi.fn(async () => fixture.snapshot),
  tunerOpen: vi.fn(async () => tuner),
  tunerPoll: vi.fn(async () => tuner),
  tunerClose: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  preflightUpload: vi.fn(),
  beginUpload: vi.fn(
    async (): Promise<RustUploadCompletion> => ({
      cancelled: false,
      result: null,
      snapshot: fixture.snapshot,
    }),
  ),
  cancelUpload: vi.fn(async () => true),
  downloadListItem: vi.fn(async () => ({ cancelled: false, file: null })),
  cancelDownload: vi.fn(async () => true),
  exportPreset: vi.fn(async () => ({
    path: '/tmp/preset.zip',
    preset_name: 'Preset',
    dependencies: [],
    bytes: 1024,
  })),
  preflightPresetImport: vi.fn(),
  importPresetBundle: vi.fn(async () => ({
    report: {
      preset_name: 'Preset',
      target_slot: 0,
      dependencies_written: [],
      dependencies_reused: [],
      preset_bytes: 32768,
    },
    snapshot: fixture.snapshot,
  })),
  renameListItem: vi.fn(async () => fixture.snapshot),
  deleteListItem: vi.fn(async () => fixture.snapshot),
};

vi.mock('../ipc/client', () => ({
  tauriClient: client,
  isTauriRuntime: () => true,
  ipcErrorMessage: (error: unknown) => String(error),
  isStaleWriteError: (error: unknown) =>
    String((error as { message?: unknown })?.message ?? error).includes(
      'connection changed before this write was sent',
    ),
  coalesce: (
    _key: string,
    call: () => Promise<unknown>,
    onError?: (message: string, error: unknown) => void,
    onDone?: (result: unknown, error?: unknown) => void,
  ) => {
    void call().then(
      (result) => onDone?.(result),
      (error) => {
        onError?.(String(error), error);
        onDone?.(undefined, error);
      },
    );
  },
  flushCoalesced: async () => undefined,
}));

const { useAppStore } = await import('./useAppStore');

describe('device connection integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the snapshot and routes edits back through the IPC client', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const state = useAppStore.getState();
    expect(state.connection.mode).toBe('device');
    expect(state.connection.connected).toBe(true);
    expect(state.connection.transport).toContain('127.0.0.1');
    expect(state.blocks).toHaveLength(9);
    expect(state.selectedBlockId).toBe('root\\app\\gate');
    expect(state.emptySlots.length).toBeGreaterThan(0);
    expect(state.save.revision).toBe(fixture.snapshot.revision);

    await state.toggleBlock('root\\app\\amp');
    expect(client.setBlock).toHaveBeenCalledWith('root\\app\\amp', false);

    state.setControl('root\\app\\amp\\gain', 7.2);
    expect(client.setControl).toHaveBeenCalledWith('root\\app\\amp\\gain', 7.2);

    state.setMaster('volume', 66);
    expect(client.setMaster).toHaveBeenCalledWith('volume', 66);

    useAppStore.setState((current) => ({
      save: { ...current.save, edited: false },
    }));
    state.setMaster('presetLevel', 3.4);
    expect(client.setMaster).toHaveBeenCalledWith('preset_level', 3.4);
    expect(useAppStore.getState().save.edited).toBe(true);

    useAppStore.setState({
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
        },
        gain2: null,
        connected1: true,
        connected2: false,
      },
    });
    const editedBefore = useAppStore.getState().save.edited;
    state.setInputGain(1, 3.4);
    expect(client.setInputGain).toHaveBeenCalledWith(1, 3.4);
    expect(useAppStore.getState().input.gain1?.value).toBe(3.4);
    expect(useAppStore.getState().save.edited).toBe(editedBefore);

    state.setEqBand(2, { gain: 3.4 });
    expect(client.setEqBand).toHaveBeenCalledWith(2, 'gain', 3.4);
    // Let the mocked coalesced writes settle so no local value is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A poll read before the toggle write must not rewind the local state.
    const stale = structuredClone(fixture.snapshot);
    stale.revision = useAppStore.getState().save.revision;
    useAppStore.getState().applyDeviceSnapshot(stale);
    expect(useAppStore.getState().blocks.find((block) => block.id === 'root\\app\\amp')?.on).toBe(false);

    const event = structuredClone(fixture.snapshot);
    event.chain.blocks = event.chain.blocks.map((block) =>
      block.path === 'root\\app\\amp' ? { ...block, on: false } : block,
    );
    event.master.volume = { ...event.master.volume!, value: 55 };
    event.meters = { input: [-30, -29], output: [-20, -19] };
    event.preset.current = useAppStore.getState().preset.current;
    event.revision = useAppStore.getState().save.revision;
    useAppStore.getState().applyDeviceSnapshot(event);
    const updated = useAppStore.getState();
    expect(updated.master.volume).toBe(55);
    expect(updated.meters.output[0]).toBe(-20);
    expect(updated.blocks.find((block) => block.id === 'root\\app\\amp')?.controls.length).toBeGreaterThan(0);

    const pitch = updated.blocks.find((block) => block.id === 'root\\app\\pitch');
    useAppStore.getState().replaceBlock('root\\app\\pitch', 'root\\app\\chorus');
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'replace',
      row: pitch?.slotRow,
      col: pitch?.slotCol,
      path: 'root\\app\\chorus',
    });
  });

  it('routes preset bundle export and import through the IPC client', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const state = useAppStore.getState();

    const exported = await state.exportPreset(2, '/tmp/preset.zip');
    expect(exported).toBe(true);
    expect(client.exportPreset).toHaveBeenCalledWith(2, '/tmp/preset.zip', true);

    const report = await state.importPreset('/tmp/preset.zip', 0, false, false);
    expect(client.importPresetBundle).toHaveBeenCalledWith(
      '/tmp/preset.zip',
      0,
      false,
      false,
    );
    expect(report?.preset_name).toBe('Preset');
    expect(client.setPreset).toHaveBeenCalled();
    expect(useAppStore.getState().save.edited).toBe(false);
  });

  it('keeps preset import failures in the activity log', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.importPresetBundle.mockRejectedValueOnce(
      new Error('preset upload failed after the dependencies were processed'),
    );

    const report = await useAppStore
      .getState()
      .importPreset('/tmp/preset.zip', 22, false, false);

    expect(report).toBeNull();
    const failure = useAppStore
      .getState()
      .activity.find((entry) => entry.title === 'Preset import failed');
    expect(failure?.detail).toContain('preset upload failed');
  });

  it('refreshes on resume but respects an explicit disconnect', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.refresh.mockClear();
    await useAppStore.getState().resumeDevice();
    expect(client.refresh).toHaveBeenCalled();

    useAppStore.getState().disconnect();
    client.refresh.mockClear();
    await useAppStore.getState().resumeDevice();
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('keeps edits dirty across a refresh and clears them only after save', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    useAppStore.getState().toggleBlock('root\\app\\amp');
    expect(useAppStore.getState().save.edited).toBe(true);

    await useAppStore.getState().refreshDevice();
    expect(useAppStore.getState().save.edited).toBe(true);

    useAppStore.getState().savePreset();
    await vi.waitFor(() => expect(client.savePreset).toHaveBeenCalled());
    await vi.waitFor(() => expect(useAppStore.getState().save.edited).toBe(false));
  });

  it('loads a default PNAM model and its parameter controls after a type change', async () => {
    const baseEditors = structuredClone(hardware.editors);
    const driveEmpty = structuredClone(baseEditors['root\\app\\drive']);
    const driveParam = (name: string) =>
      driveEmpty.parameters.find((node) => node.name === name)!;
    driveParam('type').value = 'Parametric NAM';
    driveParam('model').visible = false;
    driveParam('gain').visible = false;
    driveParam('pmodel').visible = true;
    driveParam('pmodel').value = '';
    for (const name of ['p1', 'p2', 'p3']) driveParam(name).visible = false;

    const driveLoaded = structuredClone(driveEmpty);
    const loadedParam = (name: string) =>
      driveLoaded.parameters.find((node) => node.name === name)!;
    const firstPnam = (loadedParam('pmodel').options ?? [])[0];
    loadedParam('pmodel').value = firstPnam;
    for (const name of ['p1', 'p2', 'p3']) loadedParam(name).visible = true;

    let pmodelWritten = false;
    client.selectBlock.mockImplementation(async (path: string) => {
      if (path === 'root\\app\\drive') {
        return pmodelWritten ? driveLoaded : driveEmpty;
      }
      return baseEditors[path];
    });
    client.getSnapshot.mockResolvedValue(hardware.snapshot);
    client.setControl.mockImplementation(async (path: string) => {
      if (path === 'root\\app\\drive\\pmodel') pmodelWritten = true;
      return hardware.snapshot;
    });

    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const drive = useAppStore.getState().blocks.find((block) => block.family === 'drive')!;
    expect(drive.modelControlId).toBe('root\\app\\drive\\pmodel');

    useAppStore.getState().setControl('root\\app\\drive\\type', 'Parametric NAM');
    await vi.waitFor(
      () =>
        expect(client.setControl).toHaveBeenCalledWith(
          'root\\app\\drive\\pmodel',
          firstPnam,
        ),
      { timeout: 3_000 },
    );
    await vi.waitFor(
      () => {
        const updated = useAppStore
          .getState()
          .blocks.find((block) => block.family === 'drive')!;
        expect(updated.controls.map((control) => control.name)).toEqual(
          expect.arrayContaining(['p1', 'p2', 'p3']),
        );
      },
      { timeout: 3_000 },
    );
  });

  it('removes a non-fixed block through its router slot without losing the dirty flag', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const comp = useAppStore.getState().blocks.find((block) => block.id === 'root\\app\\comp');
    const readsBefore = client.getSnapshot.mock.calls.length;
    useAppStore.getState().removeBlock('root\\app\\comp');
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'remove',
      row: comp?.slotRow,
      col: comp?.slotCol,
    });
    await vi.waitFor(() =>
      expect(client.getSnapshot.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    expect(useAppStore.getState().save.edited).toBe(true);
  });

  it('deletes a capture list item through the IPC client', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const list = useAppStore
      .getState()
      .lists.find((item) => item.kind === 'nam' && item.slots.some((slot) => slot.used))!;
    const slot = list.slots.find((entry) => entry.used)!;

    useAppStore.getState().deleteCapture(list.id, slot.index);

    expect(client.deleteListItem).toHaveBeenCalledWith(
      `root\\${list.id}`,
      slot.index,
    );
    await vi.waitFor(() =>
      expect(client.deleteListItem).toHaveBeenCalledTimes(1),
    );
  });

  it('clears the device chain through the router command', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const readsBefore = client.getSnapshot.mock.calls.length;

    useAppStore.getState().clearChain();

    expect(client.editChain).toHaveBeenCalledWith({ type: 'clear' });
    await vi.waitFor(() =>
      expect(client.getSnapshot.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  it('uploads a real path through the IPC client and highlights the refreshed slot', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.revision = fixture.snapshot.revision + 1;
    client.beginUpload.mockResolvedValueOnce({
      cancelled: false,
      result: {
        target: 'root\\nam_amp',
        slot: 4,
        name: 'Test Capture',
        chunks: 5,
        payload_bytes: 2048,
      },
      snapshot,
    });

    const started = useAppStore.getState().addUpload({
      name: 'test.nam',
      size: 1024,
      kind: 'nam',
      target: 'nam_amp',
      slot: 4,
      path: '/tmp/test.nam',
    });
    expect(started).toBe(true);
    expect(client.beginUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^upload-/),
      'nam',
      '/tmp/test.nam',
      'root\\nam_amp',
      4,
    );

    await vi.waitFor(() => {
      const task = useAppStore.getState().uploads.find((item) => item.file === 'test.nam');
      expect(task?.state).toBe('done');
      expect(task?.progress).toBe(100);
    });
    expect(useAppStore.getState().recentUpload).toEqual({
      target: 'nam_amp',
      slot: 4,
      name: 'Test Capture',
    });
  });

  it('reports live ACK progress and resolves a cancel after the current chunk', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    let finish!: (value: RustUploadCompletion) => void;
    client.beginUpload.mockImplementationOnce(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );

    useAppStore.getState().addUpload({
      name: 'cancel.nam',
      size: 1024,
      kind: 'nam',
      target: 'nam_amp',
      slot: 1,
      path: '/tmp/cancel.nam',
    });
    const task = useAppStore.getState().uploads.find((item) => item.file === 'cancel.nam')!;
    expect(task.state).toBe('uploading');

    useAppStore.getState().applyUploadProgress({
      id: task.id,
      kind: 'nam',
      target: 'root\\nam_amp',
      slot: 1,
      name: 'Cancel Test',
      ack: 2,
      total_acks: 5,
      progress: 40,
      bytes_sent: 2048,
      total_bytes: 5120,
    });
    let current = useAppStore.getState().uploads.find((item) => item.id === task.id)!;
    expect(current.ack).toBe(2);
    expect(current.totalAcks).toBe(5);
    expect(current.progress).toBe(40);

    useAppStore.getState().cancelUpload();
    expect(client.cancelUpload).toHaveBeenCalled();
    current = useAppStore.getState().uploads.find((item) => item.id === task.id)!;
    expect(current.detail).toContain('cancelling');

    finish({ cancelled: true, result: null, snapshot: fixture.snapshot });
    await vi.waitFor(() =>
      expect(
        useAppStore.getState().uploads.find((item) => item.id === task.id)?.state,
      ).toBe('cancelled'),
    );
  });

  it('refuses a device upload without a readable filesystem path', async () => {
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const started = useAppStore.getState().addUpload({
      name: 'browser.nam',
      size: 512,
      kind: 'nam',
      target: 'nam_amp',
      slot: 1,
    });
    expect(started).toBe(false);
    expect(client.beginUpload).not.toHaveBeenCalled();
  });

  it('adds new blocks to the requested slot and defaults to the last slot', async () => {
    client.getSnapshot.mockResolvedValue(hardware.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => hardware.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    expect(useAppStore.getState().emptySlots).toEqual([
      { row: 0, col: 18 },
      { row: 0, col: 26 },
    ]);

    useAppStore.getState().addBlock('root\\app\\flanger', { row: 0, col: 18 });
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'add',
      row: 0,
      col: 18,
      path: 'root\\app\\flanger',
    });

    client.editChain.mockClear();
    useAppStore.getState().addBlock('root\\app\\rotary');
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'add',
      row: 0,
      col: 26,
      path: 'root\\app\\rotary',
    });
  });

  it('moves a block into an empty slot when dropped on a neighbouring block', async () => {
    client.getSnapshot.mockResolvedValue(hardware.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => hardware.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    useAppStore.getState().moveBlock('root\\app\\ir', 'root\\app\\eq');
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'move',
      from: [0, 14],
      to: [0, 18],
    });

    const ids = useAppStore.getState().blocks.map((block) => block.id);
    expect(ids.indexOf('root\\app\\ir')).toBe(ids.indexOf('root\\app\\eq') + 1);
    expect(useAppStore.getState().emptySlots).toContainEqual({ row: 0, col: 14 });
  });

  it('moves a block directly into an empty slot drop target', async () => {
    client.getSnapshot.mockResolvedValue(hardware.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => hardware.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    useAppStore.getState().moveBlock('root\\app\\ir', 'slot:0:18');
    expect(client.editChain).toHaveBeenCalledWith({
      type: 'move',
      from: [0, 14],
      to: [0, 18],
    });
    const ir = useAppStore.getState().blocks.find((block) => block.id === 'root\\app\\ir');
    expect(ir?.slotCol).toBe(18);
    expect(useAppStore.getState().emptySlots).toContainEqual({ row: 0, col: 14 });
  });

  it('rejects empty, oversized, and duplicate names before saving as', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.savePreset.mockClear();
    const existing = useAppStore
      .getState()
      .preset.names.find((name) => name.trim().length > 0)!;

    expect(useAppStore.getState().savePresetAs('')).toBe(false);
    expect(useAppStore.getState().savePresetAs('   ')).toBe(false);
    expect(useAppStore.getState().savePresetAs('x'.repeat(64))).toBe(false);
    expect(useAppStore.getState().savePresetAs(existing)).toBe(false);
    expect(useAppStore.getState().savePresetAs(existing.toUpperCase())).toBe(false);
    expect(client.savePreset).not.toHaveBeenCalled();
    expect(useAppStore.getState().save.saving).toBe(false);
  });

  it('saves the current buffer under a new preset name', async () => {
    const updated = structuredClone(fixture.snapshot);
    updated.revision += 1;
    updated.preset.current = 'Studio Lead';
    updated.preset.names = [...updated.preset.names, 'Studio Lead'];
    updated.preset.index = updated.preset.names.length - 1;

    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    client.savePreset.mockResolvedValue(updated);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    client.getSnapshot.mockResolvedValue(updated);
    expect(useAppStore.getState().savePresetAs('Studio Lead')).toBe(true);
    await vi.waitFor(() =>
      expect(client.savePreset).toHaveBeenCalledWith('Studio Lead'),
    );
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.save.saving).toBe(false);
      expect(state.save.edited).toBe(false);
      expect(state.preset.current).toBe('Studio Lead');
      expect(state.preset.names).toContain('Studio Lead');
    });
  });

  it('shows an unavailable tuner without polling when firmware has no tuner', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.tunerOpen.mockResolvedValueOnce({
      available: false,
      message: 'This firmware does not expose a tuner.',
      enabled: false,
      note: '—',
      cents: 0,
      frequency: 0,
      reference: 440,
      level: -90,
      in_tune: false,
    });
    client.tunerPoll.mockClear();

    useAppStore.getState().setTunerOpen(true);
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.tuner.available).toBe(false);
      expect(state.tuner.enabled).toBe(false);
      expect(state.tuner.message).toContain('does not expose a tuner');
    });

    useAppStore.getState().tickTuner();
    expect(client.tunerPoll).not.toHaveBeenCalled();

    useAppStore.getState().setTunerOpen(false);
    expect(client.tunerClose).toHaveBeenCalled();
    expect(useAppStore.getState().tuner.enabled).toBe(false);
  });

  it('does not re-open the tuner when the deck is already open', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.tunerOpen.mockClear();

    useAppStore.getState().setTunerOpen(true);
    await vi.waitFor(() => expect(client.tunerOpen).toHaveBeenCalledTimes(1));
    useAppStore.getState().setTunerOpen(true);
    expect(client.tunerOpen).toHaveBeenCalledTimes(1);

    useAppStore.getState().setTunerOpen(false);
    expect(client.tunerClose).toHaveBeenCalled();
  });

  it('does not queue a second tuner poll while one is still in flight', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    client.tunerOpen.mockClear();
    client.tunerPoll.mockClear();

    let resolvePoll!: (value: typeof tuner) => void;
    client.tunerPoll.mockImplementationOnce(
      () =>
        new Promise<typeof tuner>((resolve) => {
          resolvePoll = resolve;
        }),
    );

    useAppStore.getState().setTunerOpen(true);
    await vi.waitFor(() => expect(client.tunerOpen).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 550));
    useAppStore.getState().tickTuner();
    expect(client.tunerPoll).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 550));
    useAppStore.getState().tickTuner();
    expect(client.tunerPoll).toHaveBeenCalledTimes(1);

    resolvePoll(tuner);
    await vi.waitFor(() => expect(useAppStore.getState().tuner.frequency).toBe(440));
    await new Promise((resolve) => setTimeout(resolve, 550));
    useAppStore.getState().tickTuner();
    expect(client.tunerPoll).toHaveBeenCalledTimes(2);

    useAppStore.getState().setTunerOpen(false);
  });

  it('marks a master change as a conflict while a local write is pending', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    client.setMaster.mockImplementationOnce(() => new Promise(() => undefined));
    useAppStore.getState().setMaster('volume', 66);
    await new Promise((resolve) => setTimeout(resolve, 280));

    const event = structuredClone(fixture.snapshot);
    event.revision = useAppStore.getState().save.revision + 1;
    event.preset.current = useAppStore.getState().preset.current;
    event.master.volume = { ...event.master.volume!, value: 55 };
    useAppStore.getState().applyDeviceSnapshot(event);

    const conflict = useAppStore
      .getState()
      .conflicts.find((item) => item.id === 'master.volume');
    expect(conflict).toMatchObject({ localValue: 66, deviceValue: 55 });
    expect(useAppStore.getState().master.volume).toBe(66);

    useAppStore.getState().resolveConflict('master.volume', 'device');
    expect(useAppStore.getState().master.volume).toBe(55);
    expect(useAppStore.getState().conflicts).toHaveLength(0);
  });

  it('marks an edited control as a conflict and can keep the device value', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    client.setControl.mockImplementationOnce(() => new Promise(() => undefined));
    useAppStore.getState().setControl('root\\app\\drive\\gain', 7.2);
    await new Promise((resolve) => setTimeout(resolve, 280));

    const event = structuredClone(fixture.snapshot);
    event.revision = useAppStore.getState().save.revision + 1;
    event.preset.current = useAppStore.getState().preset.current;
    event.chain.blocks = event.chain.blocks.map((block) =>
      block.path === 'root\\app\\drive'
        ? { ...block, control_revision: 1 }
        : block,
    );
    useAppStore.getState().applyDeviceSnapshot(event);

    await vi.waitFor(() => {
      const state = useAppStore.getState();
      const conflict = state.conflicts.find(
        (item) => item.id === 'root\\app\\drive\\gain',
      );
      expect(conflict).toMatchObject({ localValue: 7.2, deviceValue: 6.4 });
      const gain = state.blocks
        .find((block) => block.id === 'root\\app\\drive')
        ?.controls.find((control) => control.id === 'root\\app\\drive\\gain');
      expect(gain?.value).toBe(7.2);
      expect(gain?.conflict).toBe(true);
    });

    useAppStore.getState().resolveConflict('root\\app\\drive\\gain', 'device');
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      const gain = state.blocks
        .find((block) => block.id === 'root\\app\\drive')
        ?.controls.find((control) => control.id === 'root\\app\\drive\\gain');
      expect(gain?.value).toBe(6.4);
      expect(gain?.conflict).toBe(false);
      expect(state.conflicts).toHaveLength(0);
    });
  });

  it('reverts a pending control when the actor rejects the write after reconnect', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    client.setControl.mockImplementationOnce(async () => {
      const error = new Error(
        'the connection changed before this write was sent; retry',
      ) as Error & { code?: string };
      error.code = 'stale_connection';
      throw error;
    });
    useAppStore.getState().setControl('root\\app\\drive\\gain', 7.2);

    await vi.waitFor(() => {
      const gain = useAppStore
        .getState()
        .blocks.find((block) => block.id === 'root\\app\\drive')
        ?.controls.find((control) => control.id === 'root\\app\\drive\\gain');
      expect(gain?.value).toBe(6.4);
      expect(useAppStore.getState().conflicts).toHaveLength(0);
    });
  });

  it('coalesces rapid control writes and replays them on undo/redo', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    useAppStore.getState().setControl('root\\app\\drive\\gain', 7.2);
    useAppStore.getState().setControl('root\\app\\drive\\gain', 7.4);

    const operations = useAppStore.getState().deviceUndoStack;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: 'control',
      path: 'root\\app\\drive\\gain',
      before: 6.4,
      after: 7.4,
    });

    client.setControl.mockClear();
    useAppStore.getState().undo();
    await vi.waitFor(() =>
      expect(client.setControl).toHaveBeenCalledWith('root\\app\\drive\\gain', 6.4),
    );
    await vi.waitFor(() =>
      expect(useAppStore.getState().deviceUndoStack).toHaveLength(0),
    );
    expect(useAppStore.getState().deviceRedoStack).toHaveLength(1);

    client.setControl.mockClear();
    useAppStore.getState().redo();
    await vi.waitFor(() =>
      expect(client.setControl).toHaveBeenCalledWith('root\\app\\drive\\gain', 7.4),
    );
    await vi.waitFor(() =>
      expect(useAppStore.getState().deviceUndoStack).toHaveLength(1),
    );
    expect(useAppStore.getState().deviceRedoStack).toHaveLength(0);
  });

  it('undoes a master write through the device operation log', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const before = useAppStore.getState().master.volume;

    useAppStore.getState().setMaster('volume', 66);
    expect(useAppStore.getState().deviceUndoStack[0]).toMatchObject({
      kind: 'master',
      field: 'volume',
      before,
      after: 66,
    });

    client.setMaster.mockClear();
    useAppStore.getState().undo();
    await vi.waitFor(() =>
      expect(client.setMaster).toHaveBeenCalledWith('volume', before),
    );
    await vi.waitFor(() =>
      expect(useAppStore.getState().master.volume).toBe(before),
    );
  });

  it('undoes a chain move with the inverse router edit', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');

    useAppStore.getState().moveBlock('root\\app\\ir', 'slot:0:18');
    await vi.waitFor(() =>
      expect(useAppStore.getState().deviceUndoStack).toHaveLength(1),
    );
    expect(useAppStore.getState().deviceUndoStack[0]).toMatchObject({
      kind: 'chain',
      edit: { type: 'move', from: [0, 10], to: [0, 18] },
      inverse: { type: 'move', from: [0, 18], to: [0, 10] },
    });

    client.editChain.mockClear();
    useAppStore.getState().undo();
    await vi.waitFor(() =>
      expect(client.editChain).toHaveBeenCalledWith({
        type: 'move',
        from: [0, 18],
        to: [0, 10],
      }),
    );
    await vi.waitFor(() =>
      expect(useAppStore.getState().deviceUndoStack).toHaveLength(0),
    );
  });

  it('undoes a bypass toggle through the device operation log', async () => {
    client.getSnapshot.mockResolvedValue(fixture.snapshot);
    client.selectBlock.mockImplementation(async (path: string) => fixture.editors[path]);
    await useAppStore.getState().connectReal('tcp:127.0.0.1:45678');
    const before = useAppStore
      .getState()
      .blocks.find((block) => block.id === 'root\\app\\amp')!.on;

    useAppStore.getState().toggleBlock('root\\app\\amp');
    expect(useAppStore.getState().deviceUndoStack[0]).toMatchObject({
      kind: 'toggle',
      before,
      after: !before,
    });

    client.setBlock.mockClear();
    useAppStore.getState().undo();
    await vi.waitFor(() =>
      expect(client.setBlock).toHaveBeenCalledWith('root\\app\\amp', before),
    );
    await vi.waitFor(() =>
      expect(
        useAppStore.getState().blocks.find((block) => block.id === 'root\\app\\amp')?.on,
      ).toBe(before),
    );
  });
});
