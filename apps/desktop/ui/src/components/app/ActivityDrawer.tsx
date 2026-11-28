import * as Dialog from '@radix-ui/react-dialog';
import { Activity, Copy, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

export const ActivityDrawer = () => {
  const open = useAppStore((state) => state.activityOpen);
  const setOpen = useAppStore((state) => state.setActivityOpen);
  const activity = useAppStore((state) => state.activity);
  const copyDiagnostics = useAppStore((state) => state.copyDiagnostics);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="activity-drawer" aria-describedby={undefined}>
          <header className="activity-drawer__head">
            <div>
              <Dialog.Title className="dialog-title">Activity log</Dialog.Title>
              <p className="hint">{activity.length} entries · newest first</p>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close activity log">
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>
          <div className="activity-drawer__toolbar">
            <span className="chip">
              <Activity size={10} /> Live
            </span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => copyDiagnostics()}
            >
              <Copy size={12} /> Copy report
            </button>
          </div>
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
          <footer className="activity-drawer__foot">
            <span className="hint">Session log · newest 80 entries · no payloads</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
