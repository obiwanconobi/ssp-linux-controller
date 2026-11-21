import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileAudio,
  FileMusic,
  FolderOpen,
  HardDrive,
  RefreshCw,
  Search,
  UploadCloud,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { formatBytes } from '../../data/demoDevice';
import { ipcErrorMessage, isTauriRuntime, tauriClient } from '../../ipc/client';
import { useAppStore } from '../../stores/useAppStore';
import type { LibraryList, UploadTask } from '../../types';

type Tab = 'library' | 'presets' | 'local' | 'uploads' | 'activity';
type KindFilter = 'all' | 'nam' | 'pnam' | 'ir';

const KIND_LABEL: Record<string, string> = { nam: 'NAM', pnam: 'PNAM', ir: 'IR' };

const TARGETS: Record<'nam' | 'pnam' | 'ir', string[]> = {
  nam: ['nam_amp', 'nam_drive'],
  pnam: ['pnam_list'],
  ir: ['ir_list'],
};

interface PendingFile {
  name: string;
  size: number;
  kind: 'nam' | 'pnam' | 'ir';
  target: string;
  slot: number;
  warnings: string[];
  error?: string;
  file?: File;
  path?: string;
}

interface LocalEntry {
  path: string;
  name: string;
  relative: string;
  kind: 'nam' | 'pnam' | 'ir';
  size: number;
  file?: File;
}

const kindFor = (name: string): 'nam' | 'pnam' | 'ir' | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pnam')) return 'pnam';
  if (lower.endsWith('.nam')) return 'nam';
  if (lower.endsWith('.wav')) return 'ir';
  return null;
};

const UploadCard = ({ upload }: { upload: UploadTask }) => (
  <div className="upload-card">
    <div className="upload-card__head">
      <span className={`upload-card__icon upload-card__icon--${upload.kind}`}>
        {upload.kind === 'ir' ? <FileMusic size={15} /> : <FileAudio size={15} />}
      </span>
      <div className="upload-card__meta">
        <strong>{upload.file}</strong>
        <span className="mono">
          {KIND_LABEL[upload.kind]} · {upload.target} · slot {upload.slot + 1}
        </span>
      </div>
      <span className={`chip ${upload.state === 'done' ? 'chip--good' : 'chip--warn'}`}>
        {upload.state === 'done' ? 'Complete' : `${Math.round(upload.progress)}%`}
      </span>
    </div>
    <div className="progress-bar progress-bar--lg" aria-label={`Upload ${Math.round(upload.progress)} percent`}>
      <span style={{ width: `${upload.progress}%` }} />
    </div>
    <div className="upload-card__foot">
      <span className="mono">
        ACK {upload.ack} / {upload.totalAcks}
      </span>
      <span className="hint">{upload.detail}</span>
    </div>
  </div>
);

const LibraryTable = ({
  lists,
  query,
  kindFilter,
}: {
  lists: LibraryList[];
  query: string;
  kindFilter: KindFilter;
}) => {
  const rows = lists
    .filter((list) => kindFilter === 'all' || list.kind === kindFilter)
    .flatMap((list) =>
      list.slots.map((slot) => ({
        list,
        slot,
      })),
    )
    .filter(({ slot }) => !query || slot.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="library-table-wrap">
      <table className="library-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Target</th>
            <th scope="col">Slot</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ list, slot }) => (
            <tr key={`${list.id}-${slot.index}`} className={slot.active ? 'library-row--active' : ''}>
              <td>
                <span className="library-name">
                  <span className={`library-type-dot library-type-dot--${list.kind}`} aria-hidden="true" />
                  {slot.name || <span className="muted">Empty slot</span>}
                </span>
                <span className="library-sub mono">
                  {slot.name ? `${formatBytes(list.slotSize)} slot · gzip` : 'No capture loaded'}
                </span>
              </td>
              <td>
                <span className={`type-badge type-badge--${list.kind}`}>{KIND_LABEL[list.kind]}</span>
              </td>
              <td>{list.label}</td>
              <td className="mono">{String(slot.index + 1).padStart(2, '0')}</td>
              <td>
                {slot.active ? (
                  <span className="chip chip--good">Active</span>
                ) : slot.used ? (
                  <span className="chip">Used</span>
                ) : (
                  <span className="chip">Free</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="library-empty">
          <HardDrive size={18} />
          <p>No captures match this search.</p>
        </div>
      )}
    </div>
  );
};

export const LibraryView = () => {
  const lists = useAppStore((state) => state.lists);
  const uploads = useAppStore((state) => state.uploads);
  const activity = useAppStore((state) => state.activity);
  const preset = useAppStore((state) => state.preset);
  const addUpload = useAppStore((state) => state.addUpload);
  const notify = useAppStore((state) => state.notify);
  const deviceMode = useAppStore((state) => state.connection.mode === 'device');
  const [tab, setTab] = useState<Tab>('library');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localRoot, setLocalRoot] = useState('');
  const [localScanning, setLocalScanning] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const tauri = isTauriRuntime();

  const slotsUsed = lists.reduce(
    (sum, list) => sum + list.slots.filter((slot) => slot.used).length,
    0,
  );
  const slotsTotal = lists.reduce((sum, list) => sum + list.slots.length, 0);

  const preparePending = (
    name: string,
    size: number,
    kind: 'nam' | 'pnam' | 'ir',
    source: { file?: File; path?: string },
  ) => {
    const target = TARGETS[kind][0];
    const list = lists.find((item) => item.id === target);
    const slot = list?.slots.find((item) => !item.used)?.index ?? 0;
    const warnings: string[] = [];
    let error: string | undefined;
    if (kind === 'nam' && size > 1024 * 1024) error = 'NAM files must be ≤ 1 MiB.';
    if (kind === 'pnam' && size > 2 * 1024 * 1024) error = 'PNAM files must be ≤ 2 MiB.';
    if (kind === 'ir' && size > 64 * 1024) warnings.push('IR will be reduced to the first 2048 samples.');
    if (list?.slots[slot]?.used) warnings.push(`Slot ${slot + 1} already contains a capture and will be overwritten.`);
    if (kind === 'ir') warnings.push('Sample rate is read from the WAV; 48 kHz is expected.');
    setPending({ name, size, kind, target, slot, warnings, error, ...source });
  };

  const inspectFile = (file: File) => {
    const kind = kindFor(file.name);
    if (!kind) {
      setPending({
        name: file.name,
        size: file.size,
        kind: 'nam',
        target: 'nam_amp',
        slot: 0,
        warnings: [],
        error: 'Unsupported file. Choose a .nam, .pnam, or .wav capture.',
        file,
      });
      return;
    }
    preparePending(file.name, file.size, kind, { file });
  };

  const inspectLocal = (entry: LocalEntry) => {
    preparePending(entry.name, entry.size, entry.kind, {
      file: entry.file,
      path: entry.path,
    });
    setTab('library');
  };

  const loadLocalScan = async (root: string) => {
    setLocalScanning(true);
    setLocalError(null);
    try {
      const scan = await tauriClient.scanCaptures(root);
      setLocalRoot(scan.root);
      setLocalEntries(
        scan.files.map((file) => ({
          path: file.path,
          name: file.name,
          relative: file.relative,
          kind: file.kind,
          size: file.size,
        })),
      );
      if (scan.truncated) {
        notify('Showing the first 5000 captures in this folder', 'warn');
      }
      if (scan.files.length === 0) {
        setLocalError('No .nam, .pnam, or .wav captures were found in that directory.');
      }
    } catch (error) {
      setLocalError(ipcErrorMessage(error));
    } finally {
      setLocalScanning(false);
    }
  };

  const chooseLocalFolder = async () => {
    if (!tauri) {
      dirInputRef.current?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a capture folder',
      });
      if (typeof selected === 'string') {
        await loadLocalScan(selected);
      }
    } catch (error) {
      setLocalError(ipcErrorMessage(error));
    }
  };

  const onDirectoryFiles = (files: FileList | null) => {
    if (!files) return;
    const entries: LocalEntry[] = [];
    for (const file of Array.from(files)) {
      const kind = kindFor(file.name);
      if (!kind) continue;
      const relative =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      entries.push({
        path: relative,
        name: file.name,
        relative,
        kind,
        size: file.size,
        file,
      });
    }
    entries.sort((left, right) =>
      left.kind === right.kind
        ? left.relative.toLowerCase().localeCompare(right.relative.toLowerCase())
        : left.kind.localeCompare(right.kind),
    );
    setLocalRoot(entries[0]?.relative.split('/')[0] ?? 'Local folder');
    setLocalEntries(entries);
    setLocalError(
      entries.length === 0
        ? 'No .nam, .pnam, or .wav captures were found in that directory.'
        : null,
    );
  };

  const upload = () => {
    if (!pending || pending.error) return;
    addUpload({
      name: pending.name,
      size: pending.size,
      kind: pending.kind,
      target: pending.target,
      slot: pending.slot,
    });
    setPending(null);
    setTab('uploads');
    notify(`${pending.name} queued`, 'good');
  };

  return (
    <div className="library-view">
      <input
        ref={(element) => {
          dirInputRef.current = element;
          if (element) {
            element.setAttribute('webkitdirectory', '');
            element.setAttribute('directory', '');
          }
        }}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          onDirectoryFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <header className="view-head library-view__head">
        <div className="view-head__title">
          <span className="eyebrow">Captures / slots / uploads</span>
          <h1>Library</h1>
          <span className="view-head__meta mono">
            {slotsTotal} slots · {slotsUsed} used · {lists.length} lists
          </span>
        </div>
        <div className="view-head__actions">
          <div className="segmented" role="tablist" aria-label="Library sections">
            {(
              [
                ['library', 'Models & IRs'],
                ['presets', 'Presets'],
                ['local', 'Local files'],
                ['uploads', `Uploads${uploads.filter((uploadItem) => uploadItem.state === 'uploading').length ? ` · ${uploads.filter((uploadItem) => uploadItem.state === 'uploading').length}` : ''}`],
                ['activity', 'Activity'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {tab === 'library' && (
        <div className="library-view__grid">
          <section className="library-main panel">
            <div className="library-toolbar">
              <label className="search-field">
                <Search size={13} aria-hidden="true" />
                <span className="sr-only">Search captures</span>
                <input
                  className="input input--mono"
                  placeholder="Search captures"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <select
                className="select"
                aria-label="Filter capture type"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as KindFilter)}
              >
                <option value="all">All types</option>
                <option value="nam">NAM</option>
                <option value="pnam">PNAM</option>
                <option value="ir">IR</option>
              </select>
              <span className="library-toolbar__spacer" />
              <span className="chip">{lists.length} lists</span>
            </div>
            <LibraryTable lists={lists} query={query} kindFilter={kindFilter} />
          </section>

          <aside className="library-side">
            <section
              className={`drop-zone panel${dragging ? ' drop-zone--dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) inspectFile(file);
              }}
            >
              <UploadCloud size={25} aria-hidden="true" />
              <strong>Drop a .nam, .pnam, or .wav</strong>
              <p>or choose a file · NAM ≤ 1 MiB · PNAM ≤ 2 MiB · IR = first 2048 samples</p>
              <input
                ref={inputRef}
                type="file"
                accept=".nam,.pnam,.wav"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) inspectFile(file);
                  event.target.value = '';
                }}
              />
              <button type="button" className="btn btn--sm" onClick={() => inputRef.current?.click()}>
                Choose a file
              </button>
            </section>

            {pending ? (
              <section className="preflight panel">
                <header className="utility-card__head">
                  <span className="section-title">Preflight</span>
                  <span className={`chip ${pending.error ? 'chip--bad' : 'chip--good'}`}>
                    {pending.error ? 'Blocked' : 'Ready'}
                  </span>
                </header>
                <dl className="preflight__list">
                  <div>
                    <dt>File</dt>
                    <dd className="mono">{pending.name}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>{pending.kind === 'ir' ? 'WAV · 2048 samples' : `${KIND_LABEL[pending.kind]} · gzip`}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd className="mono">{formatBytes(pending.size)}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      <select
                        className="select"
                        value={pending.target}
                        onChange={(event) => {
                          const target = event.target.value;
                          const list = lists.find((item) => item.id === target);
                          const slot = list?.slots.find((item) => !item.used)?.index ?? 0;
                          setPending((current) => current && { ...current, target, slot });
                        }}
                      >
                        {TARGETS[pending.kind].map((target) => (
                          <option key={target} value={target}>
                            {lists.find((item) => item.id === target)?.label ?? target}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </div>
                  <div>
                    <dt>Slot</dt>
                    <dd className="mono">{pending.slot + 1}</dd>
                  </div>
                </dl>
                {pending.error && (
                  <p className="preflight__warning preflight__warning--error">
                    <AlertTriangle size={12} /> {pending.error}
                  </p>
                )}
                {pending.warnings.map((warning) => (
                  <p key={warning} className="preflight__warning">
                    <AlertTriangle size={12} /> {warning}
                  </p>
                ))}
                <div className="preflight__actions">
                  <button type="button" className="btn btn--sm" onClick={() => setPending(null)}>
                    <X size={12} /> Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={upload}
                    disabled={Boolean(pending.error)}
                  >
                    <UploadCloud size={12} /> Upload to slot {pending.slot + 1}
                  </button>
                </div>
                <p className="hint">
                  Polling pauses while an upload is in flight. Navigation stays live; cancellation
                  stops after the current ACK.
                </p>
              </section>
            ) : (
              <section className="preflight preflight--empty panel">
                <CheckCircle2 size={16} />
                <p>Select a capture to validate its format, length, target, and overwrite state before any bytes are sent.</p>
              </section>
            )}

            {deviceMode && (
              <p className="preflight__warning">
                <AlertTriangle size={12} /> Device uploads are preview-only in this build. The Rust
                ACK uploader is exercised by <span className="mono">scripts/smoke.sh</span>; the
                file-picker bridge is the next Phase 3 step.
              </p>
            )}

            <section className="library-side__queue panel">
              <header className="utility-card__head">
                <span className="section-title">Queue</span>
                <span className="mono">{uploads.filter((uploadItem) => uploadItem.state === 'uploading').length} active</span>
              </header>
              {uploads.filter((uploadItem) => uploadItem.state !== 'done').length === 0 ? (
                <div className="utility-empty">
                  <HardDrive size={15} />
                  <span>No uploads in flight.</span>
                </div>
              ) : (
                uploads
                  .filter((uploadItem) => uploadItem.state !== 'done')
                  .slice(0, 2)
                  .map((uploadItem) => <UploadCard key={uploadItem.id} upload={uploadItem} />)
              )}
              <p className="hint">Lists refresh after the final ACK; the new capture is highlighted.</p>
            </section>
          </aside>
        </div>
      )}

      {tab === 'local' && (
        <section className="library-main panel library-tab-panel local-library">
          <header className="library-tab-panel__head">
            <div>
              <h2>Local captures</h2>
              <p className="hint">
                Recursively find .nam, .pnam, and .wav files in a folder. The scan is read-only;
                nothing is uploaded until you preflight a file.
              </p>
            </div>
            <div className="local-library__actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void chooseLocalFolder()}>
                <FolderOpen size={12} /> Choose folder
              </button>
              {tauri && localRoot && (
                <button type="button" className="btn btn--sm" onClick={() => void loadLocalScan(localRoot)}>
                  <RefreshCw size={12} /> Rescan
                </button>
              )}
              {!tauri && localEntries.length > 0 && (
                <button type="button" className="btn btn--sm" onClick={() => dirInputRef.current?.click()}>
                  <RefreshCw size={12} /> Choose another
                </button>
              )}
            </div>
          </header>
          <div className="local-library__folder">
            <FolderOpen size={14} />
            <span className="mono">{localRoot || 'No folder selected'}</span>
            {localScanning && <span className="chip">Scanning…</span>}
            {localEntries.length > 0 && <span className="chip">{localEntries.length} files</span>}
          </div>
          {localError && (
            <p className="preflight__warning preflight__warning--error">
              <AlertTriangle size={12} /> {localError}
            </p>
          )}
          {localEntries.length > 0 && (
            <>
              <div className="library-toolbar">
                <label className="search-field">
                  <Search size={13} aria-hidden="true" />
                  <span className="sr-only">Search local captures</span>
                  <input
                    className="input input--mono"
                    placeholder="Search local files"
                    value={localQuery}
                    onChange={(event) => setLocalQuery(event.target.value)}
                  />
                </label>
                <span className="library-toolbar__spacer" />
                <span className="chip">{localEntries.filter((entry) => entry.kind === 'nam').length} NAM</span>
                <span className="chip">{localEntries.filter((entry) => entry.kind === 'pnam').length} PNAM</span>
                <span className="chip">{localEntries.filter((entry) => entry.kind === 'ir').length} IR</span>
              </div>
              <div className="library-table-wrap">
                <table className="library-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Type</th>
                      <th scope="col">Relative path</th>
                      <th scope="col">Size</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {localEntries
                      .filter((entry) =>
                        localQuery
                          ? `${entry.name} ${entry.relative}`
                              .toLowerCase()
                              .includes(localQuery.toLowerCase())
                          : true,
                      )
                      .map((entry) => (
                        <tr key={`${entry.path}-${entry.size}`}>
                          <td>
                            <span className="library-name">
                              <span className={`library-type-dot library-type-dot--${entry.kind}`} aria-hidden="true" />
                              {entry.name}
                            </span>
                          </td>
                          <td>
                            <span className={`type-badge type-badge--${entry.kind}`}>
                              {KIND_LABEL[entry.kind]}
                            </span>
                          </td>
                          <td className="mono local-library__path">{entry.relative}</td>
                          <td className="mono">{formatBytes(entry.size)}</td>
                          <td>
                            <button type="button" className="btn btn--sm" onClick={() => inspectLocal(entry)}>
                              Preflight
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {localEntries.length === 0 && !localError && (
            <div className="library-empty local-library__empty">
              <FolderOpen size={22} />
              <p>Choose a folder to index its NAM, PNAM, and IR captures.</p>
              <span className="hint">
                {tauri
                  ? 'The Rust scanner walks subdirectories and ignores hidden folders, node_modules, target, and vendor.'
                  : 'The browser directory picker lists files from the selected folder and its subdirectories.'}
              </span>
            </div>
          )}
        </section>
      )}

      {tab === 'presets' && (
        <section className="library-main panel library-tab-panel">
          <header className="library-tab-panel__head">
            <div>
              <h2>Preset slots</h2>
              <p className="hint">Names are stored in 128-byte chunks; rename preserves contents.</p>
            </div>
            <span className="chip chip--good">{preset.names.filter(Boolean).length} patches</span>
          </header>
          <ul className="preset-slot-list">
            {preset.names.map((name, index) => (
              <li key={`${name}-${index}`} className={name === preset.current ? 'preset-slot--active' : ''}>
                <span className="mono">{String(index + 1).padStart(2, '0')}</span>
                <span>{name || 'Empty slot'}</span>
                {name === preset.current && <span className="chip chip--good">Current</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'uploads' && (
        <section className="library-main panel library-tab-panel">
          <header className="library-tab-panel__head">
            <div>
              <h2>Upload queue</h2>
              <p className="hint">One active upload at a time. ACK progress and cancellation boundaries are explicit.</p>
            </div>
            <span className="chip">{uploads.length} tasks</span>
          </header>
          <div className="upload-list">
            {uploads.map((uploadItem) => (
              <UploadCard key={uploadItem.id} upload={uploadItem} />
            ))}
            {uploads.length === 0 && (
              <div className="utility-empty">
                <UploadCloud size={18} />
                <span>Nothing queued. Drop a capture in the Models & IRs tab.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {tab === 'activity' && (
        <section className="library-main panel library-tab-panel">
          <header className="library-tab-panel__head">
            <div>
              <h2>Activity</h2>
              <p className="hint">Uploads, list refreshes, and device events. Never hidden in a modal.</p>
            </div>
            <Activity size={16} />
          </header>
          <ul className="activity-list activity-list--full">
            {activity.map((entry) => (
              <li key={entry.id} className="activity-item">
                <span className={`activity-dot activity-dot--${entry.tone ?? 'neutral'}`} aria-hidden="true" />
                <div className="activity-item__body">
                  <strong>{entry.title}</strong>
                  {entry.detail && <span>{entry.detail}</span>}
                </div>
                <span className="activity-item__time mono">{entry.time}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
