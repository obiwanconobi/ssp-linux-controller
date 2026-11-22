import { Activity, CircleDot, HardDrive, Usb, Wifi } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

export const UtilityRail = () => {
  const activity = useAppStore((state) => state.activity);
  const uploads = useAppStore((state) => state.uploads);
  const connection = useAppStore((state) => state.connection);
  const setActivityOpen = useAppStore((state) => state.setActivityOpen);
  const setView = useAppStore((state) => state.setView);
  const activeUpload = uploads.find((upload) => upload.state === 'uploading');

  return (
    <aside className="utility-rail" aria-label="Device and activity">
      <section className="utility-card panel">
        <header className="utility-card__head">
          <span className="eyebrow">Device</span>
          <span className={`chip ${connection.connected ? 'chip--good' : 'chip--warn'}`}>
            <CircleDot size={9} />
            {connection.connected ? 'Online' : 'Offline'}
          </span>
        </header>
        <div className="device-row">
          {connection.transport.startsWith('DEMO') ? <Usb size={15} /> : <Wifi size={15} />}
          <div>
            <strong>{connection.deviceName}</strong>
            <span className="mono">{connection.transport}</span>
          </div>
        </div>
        <dl className="device-meta">
          <div>
            <dt>Firmware</dt>
            <dd className="mono">{connection.firmware}</dd>
          </div>
          <div>
            <dt>Poll</dt>
            <dd className="mono">{connection.pollMs} ms</dd>
          </div>
          <div>
            <dt>Last reply</dt>
            <dd className="mono">
              {connection.lastPollMs > 0 ? `${connection.lastPollMs.toFixed(1)} ms` : '—'}
            </dd>
          </div>
        </dl>
        <button type="button" className="btn btn--sm utility-card__action" onClick={() => setView('settings')}>
          Connection settings
        </button>
      </section>

      <section className="utility-card panel">
        <header className="utility-card__head">
          <span className="eyebrow">Queue</span>
          <span className="mono utility-card__count">
            {uploads.filter((upload) => upload.state === 'uploading').length} active
          </span>
        </header>
        {activeUpload ? (
          <div className="upload-mini">
            <div className="upload-mini__top">
              <span className="mono upload-mini__file">{activeUpload.file}</span>
              <span className="mono">{Math.round(activeUpload.progress)}%</span>
            </div>
            <span className="hint">
              {activeUpload.kind.toUpperCase()} · {activeUpload.target} · slot {activeUpload.slot + 1}
            </span>
            <div
              className="progress-bar"
              role="progressbar"
              aria-label={`Upload ${Math.round(activeUpload.progress)} percent`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(activeUpload.progress)}
            >
              <span style={{ width: `${activeUpload.progress}%` }} />
            </div>
            <div className="upload-mini__foot">
              <span>
                ACK {activeUpload.ack} / {activeUpload.totalAcks}
              </span>
              <span>{activeUpload.detail}</span>
            </div>
          </div>
        ) : (
          <div className="utility-empty">
            <HardDrive size={16} />
            <span>No uploads in flight.</span>
            <button type="button" className="btn btn--sm" onClick={() => setView('library')}>
              Open library
            </button>
          </div>
        )}
      </section>

      <section className="utility-card utility-card--activity panel">
        <header className="utility-card__head">
          <span className="eyebrow">Activity</span>
          <button
            type="button"
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            aria-label="Open full activity log"
            onClick={() => setActivityOpen(true)}
          >
            <Activity size={13} />
          </button>
        </header>
        <ul className="activity-list activity-list--compact">
          {activity.slice(0, 6).map((entry) => (
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
        <button
          type="button"
          className="btn btn--ghost btn--sm utility-card__action"
          onClick={() => setActivityOpen(true)}
        >
          View activity log
        </button>
      </section>
    </aside>
  );
};
