import { lazy, Suspense, useEffect, useRef } from 'react';
import { CommandPalette } from './components/app/CommandPalette';
import { ConnectionSheet } from './components/app/ConnectionSheet';
import { DeviceConflictBar } from './components/app/DeviceConflictBar';
import { ActivityDrawer } from './components/app/ActivityDrawer';
import { NavTabs } from './components/app/NavTabs';
import { ShortcutsDialog } from './components/app/ShortcutsDialog';
import { TitleBar } from './components/app/TitleBar';
import { Toasts } from './components/app/Toasts';
import { MasterStrip } from './components/kit/MasterStrip';
import { PresetDrawer } from './components/app/PresetDrawer';
import { StatusBar } from './components/kit/StatusBar';
import { BoardView } from './features/board/BoardView';
import { TunerDeck } from './features/tuner/TunerDeck';
import { isTauriRuntime, tauriClient } from './ipc/client';
import { startDeviceEvents } from './ipc/events';
import { useAppStore } from './stores/useAppStore';
import type { ViewId } from './types';

const AmpRoomView = lazy(() =>
  import('./features/amp-room/AmpRoomView').then((module) => ({ default: module.AmpRoomView })),
);
const EqView = lazy(() =>
  import('./features/eq/EqView').then((module) => ({ default: module.EqView })),
);
const LibraryView = lazy(() =>
  import('./features/library/LibraryView').then((module) => ({ default: module.LibraryView })),
);
const SettingsView = lazy(() =>
  import('./features/settings/SettingsView').then((module) => ({ default: module.SettingsView })),
);
const StageView = lazy(() =>
  import('./features/stage/StageView').then((module) => ({ default: module.StageView })),
);

const VIEW_KEYS: Record<string, ViewId> = {
  '1': 'board',
  '2': 'amp',
  '3': 'eq',
  '4': 'library',
  '5': 'settings',
  '6': 'stage',
};

const isTyping = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
};

const stepPreset = (direction: 1 | -1) => {
  const state = useAppStore.getState();
  const { preset } = state;
  const total = preset.names.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (preset.index + direction * offset + total) % total;
    if (preset.names[index]?.trim()) {
      state.setPreset(index);
      return;
    }
  }
};

const stepBlock = (direction: 1 | -1) => {
  const state = useAppStore.getState();
  const index = state.blocks.findIndex((block) => block.id === state.selectedBlockId);
  if (index < 0) {
    state.selectBlock(state.blocks[0]?.id ?? '');
    return;
  }
  const next = Math.min(state.blocks.length - 1, Math.max(0, index + direction));
  state.selectBlock(state.blocks[next].id);
};

export const App = () => {
  const view = useAppStore((state) => state.view);
  const connection = useAppStore((state) => state.connection);
  const tunerOpen = useAppStore((state) => state.tunerOpen);
  const preset = useAppStore((state) => state.preset);
  const blocks = useAppStore((state) => state.blocks);

  useEffect(() => {
    document.title = `${preset.current || 'StompStation'} — StompStation`;
  }, [preset.current]);

  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    if (!isTauriRuntime()) {
      useAppStore.getState().setDemoAllowed(true);
      return;
    }
    void (async () => {
      try {
        const bootstrap = await tauriClient.bootstrap();
        useAppStore.getState().setAppVersion(bootstrap.version);
        useAppStore.getState().setDemoAllowed(bootstrap.demo_allowed);
        if (bootstrap.demo_allowed) {
          useAppStore.getState().connectDemo();
          return;
        }
        useAppStore.getState().setConnectionOpen(true);
        await useAppStore.getState().connectAuto();
      } catch {
        useAppStore.getState().setConnectionOpen(true);
        await useAppStore.getState().connectAuto();
      }
    })();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void startDeviceEvents()
      .then((stop) => {
        unlisten = stop;
      })
      .catch((error) => {
        console.error('Could not subscribe to device events', error);
      });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const uploadTimer = window.setInterval(() => useAppStore.getState().tickUploads(), 850);
    const tunerTimer = window.setInterval(() => useAppStore.getState().tickTuner(), 190);
    return () => {
      window.clearInterval(uploadTimer);
      window.clearInterval(tunerTimer);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      const state = useAppStore.getState();
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        state.setCommandOpen(!state.commandOpen);
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        state.savePreset();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (event.key === 'Escape') {
        if (state.tunerOpen) {
          state.setTunerOpen(false);
          return;
        }
        if (state.commandOpen || state.connectionOpen || state.activityOpen || state.shortcutsOpen) {
          return;
        }
        if (state.view === 'stage' || state.view !== 'board') {
          state.setView('board');
          requestAnimationFrame(() => document.getElementById('view-panel')?.focus());
        }
        return;
      }
      if (meta || event.altKey) return;

      if (VIEW_KEYS[event.key]) {
        event.preventDefault();
        state.setView(VIEW_KEYS[event.key]);
        return;
      }
      if (event.key === '[') {
        event.preventDefault();
        stepPreset(-1);
        return;
      }
      if (event.key === ']') {
        event.preventDefault();
        stepPreset(1);
        return;
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        state.setTunerOpen(!state.tunerOpen);
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        state.setShortcutsOpen(true);
        return;
      }
      if (event.key === ' ' && state.view !== 'stage') {
        event.preventDefault();
        if (state.selectedBlockId) state.toggleBlock(state.selectedBlockId);
        return;
      }
      if (event.key === 'ArrowLeft' && state.view !== 'stage') {
        event.preventDefault();
        stepBlock(-1);
        return;
      }
      if (event.key === 'ArrowRight' && state.view !== 'stage') {
        event.preventDefault();
        stepBlock(1);
        return;
      }
      if (event.key === 'Enter' && state.view === 'board') {
        const block = state.blocks.find((item) => item.id === state.selectedBlockId);
        if (block?.family === 'amp') {
          event.preventDefault();
          state.setView('amp');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={`app-shell${view === 'stage' ? ' app-shell--stage' : ''}`}>
      <a className="skip-link" href="#view-panel">
        Skip to main content
      </a>
      {view !== 'stage' && <TitleBar />}
      {view !== 'stage' && <NavTabs />}
      {!connection.connected && view !== 'stage' && (
        <div className="offline-banner" role="status">
          <span className="led led--amber" aria-hidden="true" />
          {blocks.length === 0
            ? 'No device connected — use Reconnect to load the board.'
            : 'Offline — showing the last known board. Controls are read-only until you reconnect.'}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              const state = useAppStore.getState();
              if (state.connection.mode === 'device' && state.connection.address) {
                void state.connectReal(state.connection.address);
              } else {
                state.connectDemo();
              }
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      {view !== 'stage' && <DeviceConflictBar />}

      <main
        id="view-panel"
        role="tabpanel"
        aria-label="Current view"
        tabIndex={-1}
        className={`app-main app-main--${view}`}
      >
        <Suspense
          fallback={
            <div className="view-loading panel">
              <span className="led led--on" aria-hidden="true" />
              Loading view…
            </div>
          }
        >
          {view === 'board' && <BoardView />}
          {view === 'amp' && <AmpRoomView />}
          {view === 'eq' && <EqView />}
          {view === 'library' && <LibraryView />}
          {view === 'settings' && <SettingsView />}
          {view === 'stage' && <StageView />}
        </Suspense>
      </main>

      {view !== 'stage' && <MasterStrip />}
      {view !== 'stage' && <StatusBar />}

      <TunerDeck />
      <PresetDrawer />
      <CommandPalette />
      <ConnectionSheet />
      <ActivityDrawer />
      <ShortcutsDialog />
      <Toasts />

      <div className="sr-only" aria-live="polite">
        {tunerOpen ? 'Tuner opened' : ''}
      </div>
    </div>
  );
};
