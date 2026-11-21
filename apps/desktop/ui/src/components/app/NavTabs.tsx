import { AudioLines, LibraryBig, LayoutGrid, MonitorPlay, Settings2, Speaker } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import type { ViewId } from '../../types';

const TABS: Array<{ id: ViewId; label: string; icon: typeof LayoutGrid; key: string }> = [
  { id: 'board', label: 'Board', icon: LayoutGrid, key: '1' },
  { id: 'amp', label: 'Amp room', icon: Speaker, key: '2' },
  { id: 'eq', label: 'Global EQ', icon: AudioLines, key: '3' },
  { id: 'library', label: 'Library', icon: LibraryBig, key: '4' },
  { id: 'settings', label: 'Settings', icon: Settings2, key: '5' },
  { id: 'stage', label: 'Stage mode', icon: MonitorPlay, key: '6' },
];

export const NavTabs = () => {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const preset = useAppStore((state) => state.preset);
  const connection = useAppStore((state) => state.connection);

  return (
    <nav className="nav-tabs" aria-label="Views">
      <div className="nav-tabs__list" role="tablist">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`nav-tab${active ? ' nav-tab--active' : ''}`}
              onClick={() => setView(tab.id)}
              title={`${tab.label} (${tab.key})`}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
              <span className="nav-tab__key kbd">{tab.key}</span>
            </button>
          );
        })}
      </div>
      <div className="nav-tabs__context">
        <span className="nav-tabs__preset">{preset.current}</span>
        <span className="nav-tabs__meta mono">
          {preset.names.filter(Boolean).length} patches
          {connection.connected ? ' · synced' : ' · offline'}
        </span>
      </div>
    </nav>
  );
};
