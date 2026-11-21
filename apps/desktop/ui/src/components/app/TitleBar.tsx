import { ChevronLeft, ChevronRight, Redo2, Save, Undo2, Activity } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { Brand } from '../Brand';

const shortTransport = (transport: string): string =>
  transport
    .replace(/^USB serial /, 'USB · ')
    .replace(/^network /, 'NET · ')
    .replace(/ @ \d+$/, '');

export const TitleBar = () => {
  const preset = useAppStore((state) => state.preset);
  const blocks = useAppStore((state) => state.blocks);
  const setPreset = useAppStore((state) => state.setPreset);
  const save = useAppStore((state) => state.save);
  const savePreset = useAppStore((state) => state.savePreset);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const connection = useAppStore((state) => state.connection);
  const autoSearching = connection.autoSearch === 'searching';
  const autoFailed = connection.autoSearch === 'failed';
  const setTunerOpen = useAppStore((state) => state.setTunerOpen);
  const setConnectionOpen = useAppStore((state) => state.setConnectionOpen);
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen);
  const setActivityOpen = useAppStore((state) => state.setActivityOpen);
  const undoDepth = useAppStore((state) => state.undoStack.length);
  const redoDepth = useAppStore((state) => state.redoStack.length);

  const previousIndex = (index: number) => {
    for (let offset = 1; offset <= preset.names.length; offset += 1) {
      const candidate = (index - offset + preset.names.length) % preset.names.length;
      if (preset.names[candidate]?.trim()) return candidate;
    }
    return index;
  };
  const nextIndex = (index: number) => {
    for (let offset = 1; offset <= preset.names.length; offset += 1) {
      const candidate = (index + offset) % preset.names.length;
      if (preset.names[candidate]?.trim()) return candidate;
    }
    return index;
  };

  return (
    <header className="title-bar">
      <div className="title-bar__brand">
        <Brand />
      </div>

      <div className="preset-nav" aria-label="Preset navigation">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous preset"
          title="Previous preset ( [ )"
          onClick={() => setPreset(previousIndex(preset.index))}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="preset-nav__center">
          <span className="preset-nav__name">{preset.current || 'No preset'}</span>
          <span className="preset-nav__meta mono">
            slot {String(preset.index + 1).padStart(2, '0')} / {preset.names.length}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next preset"
          title="Next preset ( ] )"
          onClick={() => setPreset(nextIndex(preset.index))}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="title-bar__state">
        {save.saving ? (
          <span className="chip chip--warn">
            <Save size={10} /> Saving
          </span>
        ) : save.edited ? (
          <span className="chip chip--warn">Edited</span>
        ) : (
          <span className="chip chip--good">Saved</span>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={`Undo (${undoDepth} available)`}
          title="Undo (Ctrl+Z)"
          onClick={undo}
          disabled={undoDepth === 0}
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Redo (${redoDepth} available)`}
          title="Redo (Ctrl+Shift+Z)"
          onClick={redo}
          disabled={redoDepth === 0}
        >
          <Redo2 size={15} />
        </button>
        <button
          type="button"
          className="btn btn--sm title-bar__save"
          onClick={() => savePreset()}
          disabled={!save.edited || save.saving}
        >
          <Save size={12} />
          Save
          <span className="kbd">⌘S</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setTunerOpen(true)}
          title="Tuner (T)"
        >
          TUNER
        </button>
        <button
          type="button"
          className={`connection-pill${connection.connected ? ' connection-pill--on' : ''}`}
          onClick={() => setConnectionOpen(true)}
          title="Connection settings"
        >
          <span className={`led ${autoSearching ? 'led--amber' : 'led--on'}`} aria-hidden="true" />
          <span>
            {autoSearching
              ? 'Searching…'
              : connection.connected
                ? shortTransport(connection.transport)
                : autoFailed
                  ? 'No device'
                  : 'Offline'}
          </span>
          <span className="connection-pill__detail">
            {autoSearching
              ? 'Wi-Fi → USB'
              : connection.connected
                ? 'Connected'
                : autoFailed
                  ? 'Connect'
                  : 'Reconnect'}
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Activity log"
          title="Activity log"
          onClick={() => setActivityOpen(true)}
        >
          <Activity size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Keyboard shortcuts and details"
          title="Keyboard shortcuts (?)"
          onClick={() => setShortcutsOpen(true)}
        >
          <span className="title-bar__help">?</span>
        </button>
        <span className="title-bar__count mono" title={`${blocks.length} blocks in chain`}>
          {blocks.length} blocks
        </span>
      </div>
    </header>
  );
};
