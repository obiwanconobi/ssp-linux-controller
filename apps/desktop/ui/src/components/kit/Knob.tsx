import { useCallback, useEffect, useRef, useState } from 'react';
import type { Control } from '../../types';
import { isOptionControl, optionIndex, optionValue } from './optionControl';

interface KnobProps {
  control: Control;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onChange: (value: number) => void;
  pending?: boolean;
  stage?: boolean;
  hideLabel?: boolean;
  color?: string;
  label?: string;
  format?: (value: number) => string;
}

const ANGLE_MIN = -135;
const ANGLE_MAX = 135;

const polar = (angle: number, radius = 42) => {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: 50 + radius * Math.cos(radians),
    y: 50 + radius * Math.sin(radians),
  };
};

const arcPath = (start: number, end: number, radius = 42): string => {
  const from = polar(start, radius);
  const to = polar(end, radius);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  const sweep = end >= start ? 1 : 0;
  return `M ${from.x.toFixed(3)} ${from.y.toFixed(3)} A ${radius} ${radius} 0 ${large} ${sweep} ${to.x.toFixed(3)} ${to.y.toFixed(3)}`;
};

const decimalsFor = (control: Control, step: number): number => {
  if (control.decimals != null) return control.decimals;
  if (step < 0.01) return 3;
  if (step < 0.1) return 2;
  if (step < 1) return 1;
  return 0;
};

const displayValue = (control: Control): number => {
  const raw = Number(control.value);
  if (control.kind !== 'pfloat') return raw;
  const min = control.displayMin ?? 0;
  const max = control.displayMax ?? 1;
  const rawMin = control.min ?? 0;
  const rawMax = control.max ?? 1;
  const fraction = rawMax === rawMin ? 0 : (raw - rawMin) / (rawMax - rawMin);
  return min + fraction * (max - min);
};

const controlRange = (control: Control): [number, number] => {
  if (control.kind === 'pfloat') {
    return [control.displayMin ?? 0, control.displayMax ?? 1];
  }
  return [control.min ?? 0, control.max ?? 1];
};

const defaultTick = (control: Control): number => {
  const [min, max] = controlRange(control);
  if (typeof control.defaultValue === 'number') {
    if (control.kind === 'pfloat' && control.defaultValue <= 1) {
      const rawMin = control.min ?? 0;
      const rawMax = control.max ?? 1;
      const fraction =
        rawMax === rawMin ? 0 : (control.defaultValue - rawMin) / (rawMax - rawMin);
      return min + fraction * (max - min);
    }
    return Math.min(max, Math.max(min, control.defaultValue));
  }
  return min + (max - min) * 0.5;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const roundTo = (value: number, step: number) =>
  step > 0 ? Math.round(value / step) * step : value;

export const Knob = ({
  control,
  size = 'md',
  onChange,
  pending = false,
  stage = false,
  hideLabel = false,
  color,
  label,
  format,
}: KnobProps) => {
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState(false);
  const drag = useRef({ y: 0, value: 0 });
  const dragValueRef = useRef<number | null>(null);
  const lastCommit = useRef(0);
  const dialRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [min, max] = controlRange(control);
  const step = control.step ?? 0.1;
  const propValue = displayValue(control);
  const value = dragValue ?? propValue;
  const fraction = max === min ? 0 : clamp((value - min) / (max - min), 0, 1);
  const angle = ANGLE_MIN + fraction * (ANGLE_MAX - ANGLE_MIN);
  const decimals = decimalsFor(control, step);
  const display = format
    ? format(value)
    : `${value.toFixed(decimals)}${control.unit ? ` ${control.unit}` : ''}`;
  const unit = control.unit || '';

  const commit = useCallback(
    (next: number) => {
      const rounded = roundTo(clamp(next, min, max), step);
      if (control.kind === 'pfloat') {
        const rawMin = control.min ?? 0;
        const rawMax = control.max ?? 1;
        const displayMin = control.displayMin ?? 0;
        const displayMax = control.displayMax ?? 1;
        const normalized =
          displayMax === displayMin
            ? rawMin
            : rawMin + ((rounded - displayMin) / (displayMax - displayMin)) * (rawMax - rawMin);
        onChange(Math.min(rawMax, Math.max(rawMin, normalized)));
      } else {
        onChange(Number(rounded.toFixed(6)));
      }
    },
    [control.displayMax, control.displayMin, control.kind, control.max, control.min, max, min, onChange, step],
  );

  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const element = dialRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement === inputRef.current) return;
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const increment = (event.shiftKey ? step / 10 : step) * direction;
      commit(valueRef.current + increment);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [commit, step]);

  const beginEdit = () => {
    setDraft(Number(value.toFixed(Math.min(4, Math.max(0, decimals)))).toString());
    setEditError(false);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commitEdit = (): boolean => {
    const numeric = Number(draft.trim().replace(',', '.'));
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
      setEditError(true);
      return false;
    }
    commit(numeric);
    setEditing(false);
    setEditError(false);
    return true;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, value };
    dragValueRef.current = value;
    lastCommit.current = 0;
    setDragValue(value);
    setDragging(true);
    event.currentTarget.focus();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.stopPropagation();
    const fine = event.shiftKey ? 10 : 1;
    const span = max - min;
    const delta = ((drag.current.y - event.clientY) / 160 / fine) * span;
    const next = clamp(drag.current.value + delta, min, max);
    dragValueRef.current = next;
    setDragValue(next);
    const now = performance.now();
    if (now - lastCommit.current >= 24) {
      lastCommit.current = now;
      commit(next);
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.stopPropagation();
    setDragging(false);
    if (dragValueRef.current != null) {
      commit(dragValueRef.current);
      dragValueRef.current = null;
    }
    setDragValue(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const fine = event.shiftKey ? 10 : 1;
    const increment = step / fine;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = value + increment;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = value - increment;
        break;
      case 'PageUp':
        next = value + (max - min) / 10;
        break;
      case 'PageDown':
        next = value - (max - min) / 10;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    commit(next);
  };

  const tickAngles = Array.from({ length: 11 }, (_, index) => ANGLE_MIN + (index / 10) * 270);

  if (isOptionControl(control)) {
    const options = control.options ?? [];
    const index = optionIndex(control);
    const current = options[index] ?? '';
    const next = options.length ? (index + 1) % options.length : 0;
    const optionLabel = label ?? control.label;
    const conflict = control.conflict ? ' knob--conflict' : '';
    return (
      <div
        className={`knob knob--option knob--${size}${pending ? ' knob--pending' : ''}${stage ? ' knob--stage' : ''}${conflict}`}
        style={color ? ({ '--knob-color': color } as React.CSSProperties) : undefined}
      >
        <button
          type="button"
          className="knob__option"
          aria-label={`${optionLabel}: ${current}.${control.conflict ? ' Device conflict.' : ''} Click to change.`}
          title={`${optionLabel}: ${current} — click to change (${options.join(' / ')})${control.conflict ? ' · changed on device' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onChange(optionValue(control, next));
          }}
        >
          {current}
        </button>
        {!hideLabel && <span className="knob__label">{optionLabel}</span>}
      </div>
    );
  }

  const conflict = control.conflict ? ' knob--conflict' : '';
  return (
    <div
      className={`knob knob--${size}${pending ? ' knob--pending' : ''}${stage ? ' knob--stage' : ''}${conflict}`}
      style={color ? ({ '--knob-color': color } as React.CSSProperties) : undefined}
    >
      <div
        ref={dialRef}
        className="knob__dial"
        role="slider"
        tabIndex={0}
        aria-label={`${label ?? control.label}: ${display}${control.conflict ? ' — device conflict' : ''}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(4))}
        aria-valuetext={display}
        aria-disabled={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(defaultTick(control))}
        title={`${label ?? control.label} — drag, shift for fine, double-click to reset${control.conflict ? ' · changed on device' : ''}`}
      >
        <svg className="knob__svg" viewBox="0 0 100 100" aria-hidden="true">
          {tickAngles.map((tickAngle) => {
            const inner = polar(tickAngle, 46);
            const outer = polar(tickAngle, 49);
            return (
              <line
                key={tickAngle}
                className="knob__ticks"
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
              />
            );
          })}
          <path className="knob__track" d={arcPath(ANGLE_MIN, ANGLE_MAX)} />
          <path
            className="knob__arc"
            d={arcPath(ANGLE_MIN, Math.max(ANGLE_MIN + 0.01, angle))}
          />
        </svg>
        <div className="knob__cap" />
        <div className="knob__pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      {!hideLabel && <span className="knob__label">{label ?? control.label}</span>}
      {editing ? (
        <span className="knob__edit" onPointerDown={(event) => event.stopPropagation()}>
          <input
            ref={inputRef}
            className={`knob__readout-input${editError ? ' knob__readout-input--invalid' : ''}`}
            value={draft}
            inputMode="decimal"
            aria-label={`${label ?? control.label}, enter a value between ${min} and ${max}`}
            aria-invalid={editError}
            title={editError ? `Enter a value between ${min} and ${max}` : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setEditError(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitEdit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setEditError(false);
              }
            }}
            onBlur={() => {
              if (!commitEdit()) {
                setEditing(false);
                setEditError(false);
              }
            }}
          />
          {unit && <span className="knob__unit">{unit}</span>}
        </span>
      ) : (
        <button
          type="button"
          className="knob__readout"
          title={`${label ?? control.label}: ${display}. Click to type a value.`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            beginEdit();
          }}
        >
          {display}
        </button>
      )}
      {dragging && <span className="knob__bubble">{display}</span>}
    </div>
  );
};
