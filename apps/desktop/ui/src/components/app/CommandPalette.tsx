import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  AudioLines,
  Check,
  Copy,
  LibraryBig,
  MonitorPlay,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Speaker,
  Sun,
  Undo2,
  Unplug,
  Wifi,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { THEMES } from '../../theme/themes';
import { isMobileRuntime } from '../../ipc/client';
import { useAppStore } from '../../stores/useAppStore';
import type { ViewId } from '../../types';

interface Action {
  id: string;
  title: string;
  detail?: string;
  group: string;
  icon: typeof Search;
  shortcut?: string;
  run: () => void;
}

export const CommandPalette = () => {
  const open = useAppStore((state) => state.commandOpen);
  const setOpen = useAppStore((state) => state.setCommandOpen);
  const setView = useAppStore((state) => state.setView);
  const setTunerOpen = useAppStore((state) => state.setTunerOpen);
  const tunerOpen = useAppStore((state) => state.tunerOpen);
  const setConnectionOpen = useAppStore((state) => state.setConnectionOpen);
  const setActivityOpen = useAppStore((state) => state.setActivityOpen);
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen);
  const savePreset = useAppStore((state) => state.savePreset);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const addPreset = useAppStore((state) => state.addPreset);
  const setTheme = useAppStore((state) => state.setTheme);
  const theme = useAppStore((state) => state.theme);
  const notify = useAppStore((state) => state.notify);
  const copyDiagnostics = useAppStore((state) => state.copyDiagnostics);
  const disconnect = useAppStore((state) => state.disconnect);
  const addActivity = useAppStore((state) => state.addActivity);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const mobile = isMobileRuntime();

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  const navigate = (view: ViewId) => setView(view);

  const actions = useMemo<Action[]>(() => {
    const nextTheme = THEMES[(THEMES.findIndex((item) => item.id === theme) + 1) % THEMES.length];
    return [
      { id: 'board', title: 'Go to Board', group: 'View', icon: LibraryBig, shortcut: '1', run: () => navigate('board') },
      ...(mobile
        ? []
        : [{ id: 'amp', title: 'Go to Amp room', group: 'View', icon: Speaker, shortcut: '2', run: () => navigate('amp') }]),
      { id: 'eq', title: 'Go to Global EQ', group: 'View', icon: AudioLines, shortcut: '3', run: () => navigate('eq') },
      { id: 'library', title: 'Go to Library', group: 'View', icon: LibraryBig, shortcut: '4', run: () => navigate('library') },
      { id: 'settings', title: 'Go to Settings', group: 'View', icon: Settings2, shortcut: '5', run: () => navigate('settings') },
      { id: 'stage', title: 'Enter Stage mode', group: 'View', icon: MonitorPlay, shortcut: '6', run: () => navigate('stage') },
      { id: 'save', title: 'Save current preset', detail: 'Persist the edit buffer to the device', group: 'Preset', icon: Save, shortcut: '⌘S', run: () => savePreset() },
      { id: 'new', title: 'New patch', detail: 'Create a patch slot', group: 'Preset', icon: Plus, run: () => addPreset() },
      { id: 'undo', title: 'Undo last edit', group: 'Edit', icon: Undo2, shortcut: '⌘Z', run: () => undo() },
      { id: 'redo', title: 'Redo', group: 'Edit', icon: RefreshCw, shortcut: '⇧⌘Z', run: () => redo() },
      { id: 'tuner', title: 'Toggle tuner deck', group: 'Performance', icon: AudioLines, shortcut: 'T', run: () => setTunerOpen(!tunerOpen) },
      { id: 'connect', title: 'Connect or disconnect', detail: 'Choose USB, network, or the simulator', group: 'Device', icon: Wifi, run: () => setConnectionOpen(true) },
      { id: 'offline', title: 'Disconnect from device', detail: 'Keep the board readable, disable writes', group: 'Device', icon: Unplug, run: () => disconnect() },
      { id: 'activity', title: 'Open activity log', group: 'Device', icon: Activity, run: () => setActivityOpen(true) },
      { id: 'theme', title: `Switch theme to ${nextTheme.name}`, detail: 'Theme changes stay local', group: 'Appearance', icon: theme === 'cream' ? Moon : Sun, run: () => setTheme(nextTheme.id) },
      { id: 'copy', title: 'Copy diagnostic report', group: 'Support', icon: Copy, run: () => copyDiagnostics() },
      { id: 'shortcuts', title: 'Open keyboard shortcuts', group: 'Support', icon: Check, shortcut: '?', run: () => setShortcutsOpen(true) },
      { id: 'refresh', title: 'Refresh snapshot from device', group: 'Device', icon: RefreshCw, run: () => { addActivity('Snapshot refreshed', 'demo simulator', 'neutral'); notify('Snapshot refreshed', 'neutral'); } },
    ];
  }, [
    addActivity,
    addPreset,
    copyDiagnostics,
    disconnect,
    notify,
    redo,
    savePreset,
    setActivityOpen,
    setConnectionOpen,
    setShortcutsOpen,
    setTheme,
    setTunerOpen,
    setView,
    mobile,
    theme,
    tunerOpen,
    undo,
  ]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return actions;
    return actions.filter((action) =>
      `${action.title} ${action.detail ?? ''} ${action.group}`.toLowerCase().includes(search),
    );
  }, [actions, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const run = (action?: Action) => {
    if (!action) return;
    setOpen(false);
    window.setTimeout(() => action.run(), 30);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content command-palette" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="command-palette__search">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder="Search actions, views, and settings…"
              aria-label="Search commands"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSelected((index) => Math.min(filtered.length - 1, index + 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected((index) => Math.max(0, index - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  run(filtered[selected]);
                }
              }}
            />
            <span className="kbd">ESC</span>
          </div>
          <div className="command-palette__list" role="listbox" aria-label="Commands">
            {filtered.length === 0 ? (
              <div className="command-palette__empty">
                <p>No command matches “{query}”.</p>
                <button type="button" className="btn btn--sm" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </div>
            ) : (
              filtered.map((action, index) => {
                const Icon = action.icon;
                const showGroup = index === 0 || filtered[index - 1].group !== action.group;
                return (
                  <div key={action.id}>
                    {showGroup && <div className="command-palette__group">{action.group}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      className={`command-palette__item${index === selected ? ' command-palette__item--active' : ''}`}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => run(action)}
                    >
                      <Icon size={14} />
                      <span className="command-palette__text">
                        <strong>{action.title}</strong>
                        {action.detail && <small>{action.detail}</small>}
                      </span>
                      {action.shortcut && <span className="kbd">{action.shortcut}</span>}
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="command-palette__foot">
            <span><span className="kbd">↑↓</span> navigate</span>
            <span><span className="kbd">↵</span> run</span>
            <span><span className="kbd">esc</span> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
