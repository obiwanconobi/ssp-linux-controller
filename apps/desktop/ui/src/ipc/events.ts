import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/useAppStore';
import type { RustSnapshot, RustUploadProgress } from './client';

/**
 * Live device events from the interim Tauri poller. Writes still go through
 * commands; events are snapshots, not patches, until the full actor lands.
 */
export async function startDeviceEvents(): Promise<UnlistenFn> {
  const unlistenSnapshot = await listen<RustSnapshot>('device://snapshot', (event) => {
    useAppStore.getState().applyDeviceSnapshot(event.payload);
  });

  const unlistenUpload = await listen<RustUploadProgress>('device://upload', (event) => {
    useAppStore.getState().applyUploadProgress(event.payload);
  });

  const unlistenError = await listen<string>('device://error', (event) => {
    const state = useAppStore.getState();
    state.addActivity('Device connection lost', event.payload, 'bad');
    state.notify(`Device connection lost: ${event.payload}`, 'bad');
    useAppStore.setState((current) => ({
      connection: { ...current.connection, connected: false, connecting: false },
    }));
  });

  return () => {
    unlistenSnapshot();
    unlistenUpload();
    unlistenError();
  };
}
