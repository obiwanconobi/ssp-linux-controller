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

const client = {
  connect: vi.fn(async () => info),
  getSnapshot: vi.fn(async () => fixture.snapshot),
  selectBlock: vi.fn(async (path: string) => fixture.editors[path]),
  setBlock: vi.fn(async () => ({ ...fixture.snapshot, revision: fixture.snapshot.revision + 1 })),
  setControl: vi.fn(async (_path: string, _value: unknown) => fixture.snapshot),
  setMaster: vi.fn(async () => fixture.snapshot),
  setEqBand: vi.fn(async () => fixture.snapshot),
  setEqType: vi.fn(async () => fixture.snapshot),
  setEqEnabled: vi.fn(async () => fixture.snapshot),
  setPreset: vi.fn(async () => fixture.snapshot),
  savePreset: vi.fn(async () => fixture.snapshot),
  renamePreset: vi.fn(async () => fixture.snapshot),
  editChain: vi.fn(async () => fixture.snapshot),
  tunerOpen: vi.fn(async () => ({})),
  tunerPoll: vi.fn(async () => ({})),
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
  deleteListItem: vi.fn(async () => fixture.snapshot),
};

vi.mock('../ipc/client', () => ({
  tauriClient: client,
  isTauriRuntime: () => true,
  ipcErrorMessage: (error: unknown) => String(error),
  coalesce: (_key: string, call: () => Promise<unknown>) => {
    void call();
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

    state.setEqBand(2, { gain: 3.4 });
    expect(client.setEqBand).toHaveBeenCalledWith(2, 'gain', 3.4);

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
});
