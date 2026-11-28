import { Activity, CircleDot, Copy, Radio, RotateCw } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

export const StatusBar = () => {
  const connection = useAppStore((state) => state.connection);
  const save = useAppStore((state) => state.save);
  const setActivityOpen = useAppStore((state) => state.setActivityOpen);
  const setConnectionOpen = useAppStore((state) => state.setConnectionOpen);
  const copyDiagnostics = useAppStore((state) => state.copyDiagnostics);
  const refreshSnapshot = useAppStore((state) => state.refreshSnapshot);
  const activity = useAppStore((state) => state.activity);

  return (
    <footer className="status-bar" aria-label="Status">
      <div className="status-bar__left">
        <span className={`status-dot${connection.connected ? ' status-dot--on' : ''}`} aria-hidden="true" />
        <span>{connection.connected ? 'Synced' : 'Offline'}</span>
        <span className="status-bar__sep" />
        <button type="button" className="status-link" onClick={() => setConnectionOpen(true)}>
          <Radio size={11} />
          {connection.transport}
        </button>
        <span className="status-bar__sep" />
        <span className="mono">firmware {connection.firmware}</span>
        <span className="status-bar__sep" />
        <span className="mono">poll {connection.pollMs} ms</span>
        <span className="status-bar__sep" />
        <span className="mono">rev {save.revision}</span>
      </div>
      <div className="status-bar__right">
        <span aria-live="polite" className="status-bar__save">
          {save.saving ? 'Saving…' : save.edited ? 'Edited' : `Saved ${save.lastSaved}`}
        </span>
        <button
          type="button"
          className="status-link"
          onClick={() => setActivityOpen(true)}
          aria-label={`Activity log, ${activity.length} entries`}
        >
          <Activity size={11} />
          Activity
        </button>
        <button
          type="button"
          className="status-link"
          onClick={() => copyDiagnostics()}
        >
          <Copy size={11} />
          Copy report
        </button>
        <button
          type="button"
          className="status-link"
          onClick={() => refreshSnapshot()}
        >
          <RotateCw size={11} />
          Refresh
        </button>
        <CircleDot size={10} aria-hidden="true" />
      </div>
    </footer>
  );
};
