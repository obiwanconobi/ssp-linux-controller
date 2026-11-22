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
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../../data/demoDevice';
import { ipcErrorMessage, isTauriRuntime, tauriClient } from '../../ipc/client';
import { useAppStore } from '../../stores/useAppStore';
import type { LibraryList, UploadTask } from '../../types';

type Tab = 'library' | 'presets' | 'local' | 'uploads' | 'activity';
type CaptureKind = 'nam' | 'pnam' | 'ir';
type CategoryId = 'amps' | 'drives' | 'irs';
type SubId = 'nam' | 'pnam' | 'ir';

interface TargetDef {
  id: string;
  path: string;
  label: string;
  kind: CaptureKind;
  category: CategoryId;
  sub: SubId;
}

interface CategoryDef {
  id: CategoryId;
  label: string;
  subs: Array<{ id: SubId; label: string; target: string; kind: CaptureKind }>;
}

const KIND_LABEL: Record<string, string> = { nam: 'NAM', pnam: 'PNAM', ir: 'IR' };

const TARGETS: TargetDef[] = [
  { id: 'nam_amp', path: 'root\\nam_amp', label: 'Amps — NAM', kind: 'nam', category: 'amps', sub: 'nam' },
  { id: 'pnam_list', path: 'root\\pnam_list', label: 'Amps — Parametric NAM', kind: 'pnam', category: 'amps', sub: 'pnam' },
  { id: 'nam_drive', path: 'root\\nam_drive', label: 'Drives — NAM', kind: 'nam', category: 'drives', sub: 'nam' },
  { id: 'pnam_drive', path: 'root\\pnam_drive', label: 'Drives — Parametric NAM', kind: 'pnam', category: 'drives', sub: 'pnam' },
  { id: 'ir_list', path: 'root\\ir_list', label: 'IRs', kind: 'ir', category: 'irs', sub: 'ir' },
];

const CATEGORIES: CategoryDef[] = [
  {
    id: 'amps',
    label: 'Amps',
    subs: [
      { id: 'nam', label: 'NAM', target: 'nam_amp', kind: 'nam' },
      { id: 'pnam', label: 'Parametric NAM', target: 'pnam_list', kind: 'pnam' },
    ],
  },
  {
    id: 'drives',
    label: 'Drives',
    subs: [
      { id: 'nam', label: 'NAM', target: 'nam_drive', kind: 'nam' },
      { id: 'pnam', label: 'Parametric NAM', target: 'pnam_drive', kind: 'pnam' },
    ],
  },
  {
    id: 'irs',
    label: 'IRs',
    subs: [{ id: 'ir', label: 'Cabinet IRs', target: 'ir_list', kind: 'ir' }],
  },
];

const KIND_HINT: Record<CaptureKind, string> = {
  nam: 'Amps → NAM or Drives → NAM',
  pnam: 'Amps → Parametric NAM or Drives → Parametric NAM',
  ir: 'IRs',
};

const targetDef = (id: string): TargetDef | undefined =>
  TARGETS.find((target) => target.id === id);

interface PendingFile {
  name: string;
  size: number;
  kind: CaptureKind;
  target: string;
  slot: number;
  warnings: string[];
  error?: string;
  file?: File;
  path?: string;
  captureName?: string;
  checking?: boolean;
}

interface LocalEntry {
  path: string;
  name: string;
  relative: string;
  kind: CaptureKind;
  size: number;
  file?: File;
}

const kindFor = (name: string): CaptureKind | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pnam')) return 'pnam';
  if (lower.endsWith('.nam')) return 'nam';
  if (lower.endsWith('.wav')) return 'ir';
  return null;
};

const UploadCard = ({ upload }: { upload: UploadTask }) => {
  const cancelUpload = useAppStore((state) => state.cancelUpload);
  const active = upload.state === 'uploading' || upload.state === 'queued';
  const label =
    upload.state === 'done'
      ? 'Complete'
      : upload.state === 'cancelled'
        ? 'Cancelled'
        : upload.state === 'error'
          ? 'Failed'
          : `${Math.round(upload.progress)}%`;
  const chipClass =
    upload.state === 'done'
      ? 'chip--good'
      : upload.state === 'error'
        ? 'chip--bad'
        : 'chip--warn';

  return (
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
        <span className={`chip ${chipClass}`}>{label}</span>
      </div>
      <div className="progress-bar progress-bar--lg" aria-label={`Upload ${Math.round(upload.progress)} percent`}>
        <span style={{ width: `${upload.progress}%` }} />
      </div>
      <div className="upload-card__foot">
        <span className="mono">
          ACK {upload.ack} / {upload.totalAcks}
        </span>
        <span className="hint">{upload.detail}</span>
        {active && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => cancelUpload(upload.id)}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};

const LibraryTable = ({
  list,
  query,
  recentUpload,
}: {
  list?: LibraryList;
  query: string;
  recentUpload: { target: string; slot: number; name: string } | null;
}) => {
  if (!list) {
    return (
      <div className="library-empty">
        <HardDrive size={18} />
        <p>This firmware does not expose this capture list.</p>
      </div>
    );
  }

  const rows = list.slots.filter(
    ({ name }) => !query || name.toLowerCase().includes(query.toLowerCase()),
  );

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
          {rows.map((slot) => (
            <tr
              key={`${list.id}-${slot.index}`}
              className={[
                slot.active ? 'library-row--active' : '',
                recentUpload?.target === list.id && recentUpload.slot === slot.index
                  ? 'library-row--recent'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
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
              <td>{targetDef(list.id)?.label ?? list.label}</td>
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
  const recentUpload = useAppStore((state) => state.recentUpload);
  const activity = useAppStore((state) => state.activity);
  const preset = useAppStore((state) => state.preset);
  const addUpload = useAppStore((state) => state.addUpload);
  const notify = useAppStore((state) => state.notify);
  const deviceMode = useAppStore((state) => state.connection.mode === 'device');
  const [tab, setTab] = useState<Tab>('library');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryId>('amps');
  const [sub, setSub] = useState<SubId>('nam');
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localRoot, setLocalRoot] = useState('');
  const [localScanning, setLocalScanning] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const preflightSeq = useRef(0);
  const tauri = isTauriRuntime();

  const activeCategory = CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0];
  const activeSub =
    activeCategory.subs.find((item) => item.id === sub) ?? activeCategory.subs[0];
  const activeTarget = targetDef(activeSub.target);
  const activeList = lists.find((list) => list.id === activeSub.target);
  const activeKind = activeSub.kind;
  const activeAccept = activeKind === 'ir' ? '.wav' : `.${activeKind}`;

  const listStats = (target: string) => {
    const list = lists.find((item) => item.id === target);
    if (!list) return '—';
    return `${list.slots.filter((slot) => slot.used).length}/${list.slots.length}`;
  };

  const selectCategory = (next: CategoryId) => {
    setCategory(next);
    setPending(null);
    setQuery('');
  };

  const selectSub = (next: SubId) => {
    setSub(next);
    setPending(null);
    setQuery('');
  };

  const focusTarget = (targetId: string) => {
    const target = targetDef(targetId);
    if (!target) return;
    setCategory(target.category);
    setSub(target.sub);
  };

  const compatibleTargets = (kind: CaptureKind) =>
    TARGETS.filter(
      (target) =>
        target.kind === kind && lists.some((list) => list.id === target.id),
    );

  const slotsUsed = lists.reduce(
    (sum, list) => sum + list.slots.filter((slot) => slot.used).length,
    0,
  );
  const slotsTotal = lists.reduce((sum, list) => sum + list.slots.length, 0);
  const pendingTargets = pending ? compatibleTargets(pending.kind) : [];
  const pendingSlots = pending
    ? (lists.find((item) => item.id === pending.target)?.slots ?? [])
    : [];
  const activeTargetLabel = activeTarget?.label ?? activeSub.target;

  const preparePending = (
    name: string,
    size: number,
    kind: CaptureKind,
    target: string,
    source: { file?: File; path?: string },
    slotOverride?: number,
  ) => {
    const targetInfo = targetDef(target);
    const list = lists.find((item) => item.id === target);
    const slot = slotOverride ?? list?.slots.find((item) => !item.used)?.index ?? 0;
    const staticWarnings: string[] = [];
    let error: string | undefined;
    if (!targetInfo) {
      error = 'This upload target is not known to the app.';
    } else if (!list) {
      error = `This firmware does not expose the ${targetInfo.label} list.`;
    }
    if (kind === 'nam' && size > 1024 * 1024) error = 'NAM files must be ≤ 1 MiB.';
    if (kind === 'pnam' && size > 2 * 1024 * 1024) error = 'PNAM files must be ≤ 2 MiB.';
    if (kind === 'ir') {
      staticWarnings.push('IR will be reduced to the first 2048 samples.');
      staticWarnings.push('Sample rate is read from the WAV; 48 kHz is expected.');
    }
    const warnings = [...staticWarnings];
    if (list?.slots[slot]?.used) {
      warnings.push(`Slot ${slot + 1} already contains a capture and will be overwritten.`);
    }

    const checking = deviceMode && Boolean(source.path) && !error;
    setPending({
      name,
      size,
      kind,
      target,
      slot,
      warnings,
      error,
      checking,
      ...source,
    });
    if (!checking || !source.path) return;

    const seq = ++preflightSeq.current;
    const path = source.path;
    void tauriClient
      .preflightUpload(kind, path, targetInfo?.path ?? target, slot)
      .then((preflight) => {
        if (seq !== preflightSeq.current) return;
        setPending((current) => {
          if (
            !current ||
            !current.checking ||
            current.name !== name ||
            current.kind !== kind ||
            current.target !== target
          ) {
            return current;
          }
          return {
            ...current,
            size: preflight.file_size,
            slot: preflight.slot,
            captureName: preflight.name,
            warnings: [...preflight.warnings, ...staticWarnings],
            error: preflight.ready ? undefined : 'The uploader rejected this file.',
            checking: false,
          };
        });
      })
      .catch((cause) => {
        if (seq !== preflightSeq.current) return;
        setPending((current) => {
          if (
            !current ||
            current.name !== name ||
            current.kind !== kind ||
            current.target !== target
          ) {
            return current;
          }
          return { ...current, checking: false, error: ipcErrorMessage(cause) };
        });
      });
  };

  const setSectionError = (
    source: { name: string; size: number; file?: File; path?: string },
    kind: CaptureKind,
    error: string,
  ) => {
    setPending({
      name: source.name,
      size: source.size,
      kind,
      target: activeSub.target,
      slot: 0,
      warnings: [],
      error,
      file: source.file,
      path: source.path,
    });
  };

  const inspectFile = (file: File) => {
    const kind = kindFor(file.name);
    if (!kind) {
      setSectionError(
        { name: file.name, size: file.size, file },
        activeKind,
        'Unsupported file. Choose a .nam, .pnam, or .wav capture.',
      );
      return;
    }
    if (kind !== activeKind) {
      setSectionError(
        { name: file.name, size: file.size, file },
        kind,
        `${KIND_LABEL[kind]} captures cannot be uploaded to ${activeCategory.label}. Use ${KIND_HINT[kind]}.`,
      );
      return;
    }
    preparePending(file.name, file.size, kind, activeSub.target, { file });
  };

  const inspectPath = (path: string) => {
    const name = path.split(/[\\/]/).pop() || path;
    const kind = kindFor(name);
    if (!kind) {
      setSectionError(
        { name, size: 0, path },
        activeKind,
        'Unsupported file. Choose a .nam, .pnam, or .wav capture.',
      );
      return;
    }
    if (kind !== activeKind) {
      setSectionError(
        { name, size: 0, path },
        kind,
        `${KIND_LABEL[kind]} captures cannot be uploaded to ${activeCategory.label}. Use ${KIND_HINT[kind]}.`,
      );
      return;
    }
    preparePending(name, 0, kind, activeSub.target, { path });
  };

  const inspectPathRef = useRef(inspectPath);
  inspectPathRef.current = inspectPath;

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            setDragging(true);
          } else if (event.payload.type === 'leave') {
            setDragging(false);
          } else if (event.payload.type === 'drop') {
            setDragging(false);
            const path = event.payload.paths[0];
            if (path) inspectPathRef.current(path);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (error) {
        console.error('Could not subscribe to native file drops', error);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tauri]);

  const chooseFile = async () => {
    if (!activeList) return;
    if (!tauri) {
      inputRef.current?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: false,
        multiple: false,
        title: `Choose a ${KIND_LABEL[activeKind]} capture`,
        filters: [
          {
            name: KIND_LABEL[activeKind],
            extensions:
              activeKind === 'ir'
                ? ['wav', 'WAV']
                : [activeKind, activeKind.toUpperCase()],
          },
        ],
      });
      if (typeof selected === 'string') inspectPath(selected);
    } catch (error) {
      notify(ipcErrorMessage(error), 'bad');
    }
  };

  const inspectLocal = (entry: LocalEntry) => {
    const available = compatibleTargets(entry.kind);
    const sameCategory = available.find((target) => target.category === category);
    const preferred =
      available.find((target) => target.id === activeSub.target) ??
      sameCategory ??
      available[0];
    const target =
      preferred?.id ??
      (entry.kind === 'ir' ? 'ir_list' : entry.kind === 'pnam' ? 'pnam_list' : 'nam_amp');
    preparePending(entry.name, entry.size, entry.kind, target, {
      file: entry.file,
      path: entry.path,
    });
    focusTarget(target);
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
    if (!pending || pending.error || pending.checking) return;
    const started = addUpload({
      name: pending.name,
      size: pending.size,
      kind: pending.kind,
      target: pending.target,
      slot: pending.slot,
      path: pending.path,
    });
    if (!started) return;
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
            <div className="library-scope">
              <div className="library-scope__categories" role="group" aria-label="Library category">
                {CATEGORIES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`library-scope__category${category === item.id ? ' library-scope__category--active' : ''}`}
                    aria-pressed={category === item.id}
                    onClick={() => selectCategory(item.id)}
                  >
                    <span className="library-scope__label">{item.label}</span>
                    <span className="library-scope__meta mono">
                      {item.subs
                        .map((entry) => `${entry.label} ${listStats(entry.target)}`)
                        .join(' · ')}
                    </span>
                  </button>
                ))}
              </div>
              {activeCategory.id !== 'irs' && (
                <div
                  className="library-scope__subs"
                  role="group"
                  aria-label={`${activeCategory.label} capture type`}
                >
                  {activeCategory.subs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`library-scope__sub${activeSub.id === item.id ? ' library-scope__sub--active' : ''}`}
                      aria-pressed={activeSub.id === item.id}
                      onClick={() => selectSub(item.id)}
                    >
                      <span>{item.label}</span>
                      <span className="mono">{listStats(item.target)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="library-toolbar">
              <label className="search-field">
                <Search size={13} aria-hidden="true" />
                <span className="sr-only">Search captures</span>
                <input
                  className="input input--mono"
                  placeholder={`Search ${activeCategory.label.toLowerCase()}`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <span className="library-toolbar__spacer" />
              <span className="chip">{activeTargetLabel}</span>
              <span className="chip">
                {activeList
                  ? `${activeList.slots.filter((slot) => slot.used).length}/${activeList.slots.length} used`
                  : 'list unavailable'}
              </span>
            </div>
            <LibraryTable list={activeList} query={query} recentUpload={recentUpload} />
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
                // Tauri reports real filesystem paths through the native
                // drag-drop event; a browser File has no readable path.
                if (tauri) return;
                const file = event.dataTransfer.files[0];
                if (file) inspectFile(file);
              }}
            >
              <UploadCloud size={25} aria-hidden="true" />
              <strong>Drop a {activeAccept}</strong>
              <p>
                Uploads to {activeTargetLabel} ·{' '}
                {activeKind === 'ir'
                  ? 'WAV is reduced to the first 2048 samples'
                  : `${KIND_LABEL[activeKind]} slot limits apply`}
              </p>
              {!activeList && (
                <p className="preflight__warning preflight__warning--error">
                  <AlertTriangle size={12} /> This firmware does not expose the{' '}
                  {activeTargetLabel} list.
                </p>
              )}
              <input
                ref={inputRef}
                type="file"
                accept={activeAccept}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) inspectFile(file);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={!activeList}
                onClick={() => void chooseFile()}
              >
                Choose a file
              </button>
            </section>

            {pending ? (
              <section className="preflight panel">
                <header className="utility-card__head">
                  <span className="section-title">Preflight</span>
                  <span
                    className={`chip ${pending.error ? 'chip--bad' : pending.checking ? 'chip--warn' : 'chip--good'}`}
                  >
                    {pending.error ? 'Blocked' : pending.checking ? 'Checking' : 'Ready'}
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
                    <dd className="mono">{pending.checking ? '—' : formatBytes(pending.size)}</dd>
                  </div>
                  {pending.captureName && (
                    <div>
                      <dt>Capture</dt>
                      <dd>{pending.captureName}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {pendingTargets.length > 1 ||
                      !pendingTargets.some((target) => target.id === pending.target) ? (
                        <select
                          className="select"
                          aria-label="Upload target"
                          value={pending.target}
                          onChange={(event) => {
                            const target = event.target.value;
                            if (!pending) return;
                            preparePending(
                              pending.name,
                              pending.size,
                              pending.kind,
                              target,
                              { file: pending.file, path: pending.path },
                              undefined,
                            );
                            focusTarget(target);
                          }}
                        >
                          {!pendingTargets.some((target) => target.id === pending.target) && (
                            <option value={pending.target} disabled>
                              Choose a target
                            </option>
                          )}
                          {pendingTargets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{targetDef(pending.target)?.label ?? pending.target}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Slot</dt>
                    <dd>
                      {pendingSlots.length > 0 ? (
                        <select
                          className="select"
                          aria-label="Upload slot"
                          value={pending.slot}
                          onChange={(event) => {
                            if (!pending) return;
                            preparePending(
                              pending.name,
                              pending.size,
                              pending.kind,
                              pending.target,
                              { file: pending.file, path: pending.path },
                              Number(event.target.value),
                            );
                          }}
                        >
                          {pendingSlots.map((slot) => (
                            <option key={slot.index} value={slot.index}>
                              {String(slot.index + 1).padStart(2, '0')} —{' '}
                              {slot.used ? slot.name : 'Empty'}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="mono">{pending.slot + 1}</span>
                      )}
                    </dd>
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
                    disabled={Boolean(pending.error) || Boolean(pending.checking)}
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
