import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/useAppStore';
import type { RustActorStatus, RustSnapshot, RustUploadProgress } from './client';

/**
 * Live device events from the single-owner Tauri device actor. Writes still go
 * through commands; events are snapshots plus connection/reconnect status.
 */
export async function startDeviceEvents(): Promise<UnlistenFn> {
  const unlistenSnapshot = await listen<RustSnapshot>('device://snapshot', (event) => {
    useAppStore.getState().applyDeviceSnapshot(event.payload);
  });

  const unlistenUpload = await listen<RustUploadProgress>('device://upload', (event) => {
    useAppStore.getState().applyUploadProgress(event.payload);
  });

  const unlistenStatus = await listen<RustActorStatus>('device://status', (event) => {
    const status = event.payload;
    const state = useAppStore.getState();
    const connection = { ...state.connection, connected: status.connected };
    if (status.connected) {
      connection.transport = status.transport;
      connection.address = status.address;
      connection.autoSearch = 'idle';
      connection.autoSearchMessage = '';
      connection.error = undefined;
    } else {
      connection.connecting = false;
      if (status.reconnect_attempt > 0) {
        connection.autoSearch = 'searching';
        connection.autoSearchMessage = status.last_error
          ? `Reconnecting (attempt ${status.reconnect_attempt}): ${status.last_error}`
          : `Reconnecting (attempt ${status.reconnect_attempt})…`;
      } else if (connection.autoSearch === 'searching') {
        connection.autoSearch = 'idle';
        connection.autoSearchMessage = '';
      }
    }
    useAppStore.setState({ connection });
  });

  const unlistenReconnected = await listen<string>('device://reconnected', (event) => {
    const state = useAppStore.getState();
    state.clearDeviceHistory();
    state.addActivity('Device reconnected', event.payload, 'good');
    state.notify('Device reconnected', 'good');
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
    unlistenStatus();
    unlistenReconnected();
    unlistenError();
  };
}
