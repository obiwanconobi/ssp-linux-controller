import type { KeyboardEvent } from 'react';
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

const tabId = (id: ViewId) => `nav-tab-${id}`;

export const NavTabs = () => {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const preset = useAppStore((state) => state.preset);
  const connection = useAppStore((state) => state.connection);

  const select = (id: ViewId) => {
    setView(id);
    requestAnimationFrame(() => {
      if (id === 'stage') {
        document.getElementById('view-panel')?.focus();
      } else {
        document.getElementById(tabId(id))?.focus();
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === view);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    select(TABS[next].id);
  };

  return (
    <nav className="nav-tabs" aria-label="Views">
      <div className="nav-tabs__list" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = view === tab.id;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="view-panel"
              tabIndex={active ? 0 : -1}
              className={`nav-tab${active ? ' nav-tab--active' : ''}`}
              onClick={() => select(tab.id)}
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
