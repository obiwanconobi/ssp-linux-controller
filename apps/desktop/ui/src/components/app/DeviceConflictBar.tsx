import { AlertTriangle, Check, RotateCcw } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import type { ConflictValue } from '../../types';

const formatValue = (value: ConflictValue): string => {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value || '—';
};

export const DeviceConflictBar = () => {
  const conflicts = useAppStore((state) => state.conflicts);
  const resolveConflict = useAppStore((state) => state.resolveConflict);
  if (conflicts.length === 0) return null;
  const visible = conflicts.slice(0, 3);
  const remaining = conflicts.length - visible.length;

  return (
    <section className="device-conflict-bar panel" role="alert" aria-label="Device changes">
      <div className="device-conflict-bar__title">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>
          Changed on device — choose the value to keep
          {remaining > 0 ? ` (${conflicts.length} conflicts)` : ''}
        </span>
      </div>
      <div className="device-conflict-bar__rows">
        {visible.map((conflict) => (
          <div key={conflict.id} className="device-conflict-bar__row">
            <span className="device-conflict-bar__label">{conflict.label}</span>
            <span className="device-conflict-bar__values mono">
              device {formatValue(conflict.deviceValue)} · local{' '}
              {formatValue(conflict.localValue)}
            </span>
            <div className="device-conflict-bar__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => resolveConflict(conflict.id, 'device')}
              >
                <RotateCcw size={11} /> Use device
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => resolveConflict(conflict.id, 'local')}
              >
                <Check size={11} /> Keep local
              </button>
            </div>
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <span className="device-conflict-bar__more mono">+{remaining} more</span>
      )}
    </section>
  );
};
