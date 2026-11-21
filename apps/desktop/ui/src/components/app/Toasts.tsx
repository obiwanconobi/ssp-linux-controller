import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

export const Toasts = () => {
  const toast = useAppStore((state) => state.toast);
  if (!toast) return null;
  const Icon =
    toast.tone === 'good'
      ? CheckCircle2
      : toast.tone === 'warn' || toast.tone === 'bad'
        ? AlertTriangle
        : Info;
  return (
    <div className="toast-region" role="status" aria-live="polite">
      <div className={`toast toast--${toast.tone}`}>
        <Icon size={14} />
        <span>{toast.message}</span>
        <button
          type="button"
          className="toast__close"
          aria-label="Dismiss notification"
          onClick={() => useAppStore.setState({ toast: null })}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};
