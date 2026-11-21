import * as Dialog from '@radix-ui/react-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, Search, Star, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';

type Filter = 'all' | 'star' | 'recent';

interface Row {
  name: string;
  index: number;
}

export const PresetRail = () => {
  const preset = useAppStore((state) => state.preset);
  const setPreset = useAppStore((state) => state.setPreset);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const renamePreset = useAppStore((state) => state.renamePreset);
  const addPreset = useAppStore((state) => state.addPreset);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [rename, setRename] = useState<{ oldName: string; value: string } | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const named = preset.names
      .map((name, index) => ({ name, index }))
      .filter((row) => row.name.trim().length > 0);
    let filtered = named;
    if (filter === 'star') {
      filtered = named.filter((row) => preset.favorites.includes(row.name));
    } else if (filter === 'recent') {
      filtered = preset.recent
        .map((name) => named.find((row) => row.name === name))
        .filter((row): row is Row => Boolean(row));
    }
    const search = query.trim().toLowerCase();
    if (search) {
      filtered = filtered.filter((row) => row.name.toLowerCase().includes(search));
    }
    return filtered;
  }, [filter, preset.favorites, preset.names, preset.recent, query]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 14,
  });

  const totalNamed = preset.names.filter((name) => name.trim()).length;

  return (
    <aside className="preset-rail panel" aria-label="Patches">
      <div className="preset-rail__head">
        <div className="preset-rail__title">
          <span>Patches</span>
          <span className="preset-rail__count mono">{totalNamed}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="New patch"
          title="New patch"
          onClick={() => addPreset()}
        >
          <Plus size={15} />
        </button>
      </div>

      <label className="search-field">
        <Search size={13} aria-hidden="true" />
        <span className="sr-only">Search patches</span>
        <input
          className="input input--mono"
          value={query}
          placeholder="Search patches"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="search-field__clear"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            <X size={11} />
          </button>
        )}
      </label>

      <div className="segmented preset-rail__filters" role="group" aria-label="Patch filter">
        {(
          [
            ['all', 'All'],
            ['star', 'Starred'],
            ['recent', 'Recent'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="preset-rail__list" ref={parentRef}>
        {rows.length === 0 ? (
          <div className="preset-rail__empty">
            <p>No patches match {query ? `“${query}”` : 'this filter'}.</p>
            <button className="btn btn--sm" type="button" onClick={() => addPreset()}>
              <Plus size={12} /> New patch
            </button>
          </div>
        ) : (
          <div
            className="preset-rail__canvas"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              const active = row.name === preset.current;
              const starred = preset.favorites.includes(row.name);
              return (
                <div
                  key={`${row.name}-${row.index}`}
                  className={`preset-row${active ? ' preset-row--active' : ''}`}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <button
                    type="button"
                    className="preset-row__main"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setPreset(row.index)}
                    onDoubleClick={() => setRename({ oldName: row.name, value: row.name })}
                    title="Double-click to rename"
                  >
                    <span className="preset-row__marker" aria-hidden="true" />
                    <span className="preset-row__name">{row.name}</span>
                    <span className="preset-row__index mono">{String(row.index + 1).padStart(2, '0')}</span>
                  </button>
                  <button
                    type="button"
                    className={`preset-row__star${starred ? ' preset-row__star--on' : ''}`}
                    aria-label={starred ? `Unstar ${row.name}` : `Star ${row.name}`}
                    aria-pressed={starred}
                    onClick={() => toggleFavorite(row.name)}
                  >
                    <Star size={11} fill={starred ? 'currentColor' : 'none'} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="preset-rail__foot">
        <span className="led led--on" aria-hidden="true" />
        <span>Synced · slot {preset.index + 1} / {preset.names.length}</span>
      </div>

      <Dialog.Root open={Boolean(rename)} onOpenChange={(open) => !open && setRename(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby={undefined}>
            <div className="dialog-head">
              <div>
                <Dialog.Title className="dialog-title">Rename patch</Dialog.Title>
                <p className="hint">The device stores names in a 63-byte slot.</p>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label="Close rename dialog">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!rename) return;
                renamePreset(rename.oldName, rename.value);
                setRename(null);
              }}
            >
              <div className="dialog-body">
                <label className="field-label" htmlFor="rename-patch">
                  Patch name
                  <span className="mono">{rename?.value.length ?? 0} / 63</span>
                </label>
                <input
                  id="rename-patch"
                  className="input input--mono"
                  autoFocus
                  maxLength={63}
                  value={rename?.value ?? ''}
                  onChange={(event) =>
                    setRename((current) =>
                      current ? { ...current, value: event.target.value } : current,
                    )
                  }
                />
              </div>
              <div className="dialog-foot">
                <Dialog.Close asChild>
                  <button type="button" className="btn">
                    Cancel
                  </button>
                </Dialog.Close>
                <button type="submit" className="btn btn--primary">
                  Rename
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
};
