import type { KeyboardEvent } from 'react';
import { AudioLines, LibraryBig, LayoutGrid, MonitorPlay, Settings2, Speaker } from 'lucide-react';
import { isMobileRuntime } from '../../ipc/client';
import { useAppStore } from '../../stores/useAppStore';
import type { ViewId } from '../../types';

const TABS: Array<{
  id: ViewId;
  label: string;
  shortLabel: string;
  icon: typeof LayoutGrid;
  key: string;
}> = [
  { id: 'board', label: 'Board', shortLabel: 'Board', icon: LayoutGrid, key: '1' },
  { id: 'amp', label: 'Amp room', shortLabel: 'Amp', icon: Speaker, key: '2' },
  { id: 'eq', label: 'Global EQ', shortLabel: 'EQ', icon: AudioLines, key: '3' },
  { id: 'library', label: 'Library', shortLabel: 'Library', icon: LibraryBig, key: '4' },
  { id: 'settings', label: 'Settings', shortLabel: 'Settings', icon: Settings2, key: '5' },
  { id: 'stage', label: 'Stage mode', shortLabel: 'Stage', icon: MonitorPlay, key: '6' },
];

const tabId = (id: ViewId) => `nav-tab-${id}`;

export const NavTabs = () => {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const preset = useAppStore((state) => state.preset);
  const connection = useAppStore((state) => state.connection);
  // Amp room is a desktop visualisation; phones edit the amp in the block
  // inspector. Keeping it out of the tab list also leaves room for labels.
  const tabs = isMobileRuntime()
    ? TABS.filter((tab) => tab.id !== 'amp')
    : TABS;

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
    const index = tabs.findIndex((tab) => tab.id === view);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    select(tabs[next].id);
  };

  return (
    <nav className="nav-tabs" aria-label="Views">
      <div className="nav-tabs__list" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
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
              <span className="nav-tab__label">{tab.label}</span>
              <span className="nav-tab__short">{tab.shortLabel}</span>
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
