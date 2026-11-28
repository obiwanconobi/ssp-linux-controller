import { GripVertical, LockKeyhole } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { ampSkinFor } from '../../lib/ampSkins';
import { blockControl as blockControlLookup, getBlockKnobIds } from './knobMap';
import type { Block, Control } from '../../types';
import { Knob } from './Knob';
import { Led } from './Led';

interface PedalShellProps {
  block: Block;
  selected: boolean;
  pending: Set<string>;
  onSelect: () => void;
  onToggle: () => void;
  onControlChange: (controlId: string, value: number) => void;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  stage?: boolean;
  compact?: boolean;
}

const shortValue = (control: Control, value: number): string => {
  if (control.unit === 'Hz' && Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(Math.abs(value) >= 10000 ? 0 : 1)}k`;
  }
  if (control.unit === 'ms' || control.unit === '%') return value.toFixed(0);
  if (control.unit === 'dB') return value.toFixed(1);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(0);
  return value.toFixed(1);
};

const SHELL_LABELS: Record<string, string> = {
  threshold: 'THRESH',
  thresh: 'THR',
  sensitivity: 'SENS',
  hysteresis: 'HYST',
  makeup: 'MAKE',
  feedback: 'FDBK',
  release: 'REL',
  attack: 'ATK',
  presence: 'PRES',
  predelay: 'PRE',
  pre_dly: 'PRE',
  dlytime: 'TIME',
  lvl: 'LEVEL',
  lvl1: 'LEVEL',
  lo_cut: 'LO CUT',
  hi_cut: 'HI CUT',
  pdrive: 'DRIVE',
  pcharacter: 'CHAR',
  pbias: 'BIAS',
  poutput: 'OUT',
  ppresence: 'PRES',
  pmix: 'MIX',
  pbass: 'BASS',
  pmid: 'MID',
  ptreble: 'TREBLE',
};


const pedalVariant = (block: Block): string => {
  if (block.family === 'amp') return 'pedal--amp';
  if (block.family === 'cab') return 'pedal--cab';
  if (block.family === 'gate' || block.family === 'pitch') return 'pedal--mini';
  return '';
};

const familyColor = (family: Block['family']): string => {
  switch (family) {
    case 'drive':
      return 'var(--drive)';
    case 'mod':
      return 'var(--mod)';
    case 'delay':
      return 'var(--delay)';
    case 'reverb':
      return 'var(--reverb)';
    case 'cab':
      return 'var(--cab)';
    case 'amp':
      return '#3b2b25';
    default:
      return 'var(--utility)';
  }
};

const familyInk = (family: Block['family']): string => {
  switch (family) {
    case 'drive':
      return 'var(--drive-ink)';
    case 'mod':
      return 'var(--mod-ink)';
    case 'delay':
      return 'var(--delay-ink)';
    case 'reverb':
      return 'var(--reverb-ink)';
    case 'cab':
      return 'var(--cab-ink)';
    case 'amp':
      return '#f3e4d7';
    default:
      return 'var(--utility-ink)';
  }
};

export const PedalShell = ({
  block,
  selected,
  pending,
  onSelect,
  onToggle,
  onControlChange,
  dragHandleProps,
  stage = false,
  compact = false,
}: PedalShellProps) => {
  const knobIds = getBlockKnobIds(block);
  const variant = pedalVariant(block);
  const maxKnobs = compact
    ? variant === 'pedal--amp'
      ? 0
      : 2
    : variant === 'pedal--mini'
      ? 2
      : 3;
  const controls = knobIds
    .map((id) => blockControlLookup(block, id))
    .filter((control): control is Control => Boolean(control))
    .slice(0, maxKnobs);
  const modelName = block.model?.trim() ? block.model : block.label;
  const ampSkin = block.family === 'amp' ? ampSkinFor(modelName) : null;
  const knobRow = (
    <div className="pedal__knobs">
      {controls.map((control) => (
        <Knob
          key={control.id}
          control={control}
          size="sm"
          pending={pending.has(control.id)}
          onChange={(value) => onControlChange(control.id, value)}
          label={SHELL_LABELS[control.name] ?? control.label.toUpperCase()}
          format={(value) => shortValue(control, value)}
        />
      ))}
    </div>
  );
  const { onKeyDown: dragKeyDown, ...dragProps } = dragHandleProps ?? {};

  return (
    <div
      {...(block.fixed ? {} : dragProps)}
      className={`pedal ${variant}${ampSkin ? ' pedal--amp-cabinet' : ''}${compact ? ' pedal--compact' : ''}${selected ? ' pedal--selected' : ''}${block.on ? '' : ' pedal--off'}${block.fixed ? ' pedal--fixed' : ''}${stage ? ' pedal--stage' : ''}`}
      data-amp-skin={ampSkin?.id}
      style={
        {
          '--pedal-accent': familyColor(block.family),
          '--pedal-chassis': familyColor(block.family),
          '--pedal-ink': familyInk(block.family),
        } as React.CSSProperties
      }
      role="group"
      aria-label={`${block.label}, ${block.on ? 'on' : 'off'}, ${block.fixed ? 'fixed slot' : 'movable'}`}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onFocus={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onToggle();
      }}
      onKeyDown={(event) => {
        if (!block.fixed) dragKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="screw" style={{ top: 4, left: 4 }} />
      <span className="screw" style={{ top: 4, right: 4 }} />
      <span className="screw" style={{ bottom: 4, left: 4 }} />
      <span className="screw" style={{ bottom: 4, right: 4 }} />

      {!block.fixed && (
        <span className="pedal__grab" aria-hidden="true" title="Drag anywhere on the pedal to reorder">
          <GripVertical size={11} />
        </span>
      )}

      <span className="pedal__number" aria-hidden="true">
        {block.footswitch}
      </span>

      {ampSkin ? (
        <>
          <span className="pedal__handle" aria-hidden="true" />
          <div className="pedal__face">
            <div className="pedal__plate">
              <span className="pedal__brand">{ampSkin.brand}</span>
              <span className="pedal__plate-meta">AMP / NAM</span>
              <span className="pedal__jewel" aria-hidden="true" />
            </div>
            <div className="pedal__model" title={modelName}>
              {modelName}
            </div>
            {knobRow}
          </div>
          <div className="pedal__grille" aria-hidden="true" />
        </>
      ) : (
        <>
          <div className="pedal__plate">{block.shortName}</div>
          <div className="pedal__model" title={modelName}>
            {modelName}
          </div>
          {knobRow}
        </>
      )}

      <div className="pedal__foot">
        <span className="pedal__state">
          <Led on={block.on} label={`${block.shortName} state`} />
          <span>{block.on ? 'ON' : 'OFF'}</span>
        </span>
        <button
          type="button"
          className={`footswitch${block.on ? ' footswitch--engaged' : ''}`}
          aria-label={`${block.on ? 'Bypass' : 'Enable'} ${block.label}`}
          aria-pressed={block.on}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        />
      </div>

      {block.fixed && (
        <span className="pedal__lock" title="Fixed slot — cannot be moved or removed" aria-hidden="true">
          <LockKeyhole size={10} />
        </span>
      )}
    </div>
  );
};
