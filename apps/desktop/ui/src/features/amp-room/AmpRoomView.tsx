import {
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Clock3,
  Copy,
  Gauge,
  Link2,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { Knob } from '../../components/kit/Knob';
import { Led } from '../../components/kit/Led';
import { responseCurve } from '../../lib/eq';
import { useAppStore } from '../../stores/useAppStore';
import type { Block, Control } from '../../types';

const MiniEq = () => {
  const eq = useAppStore((state) => state.eq);
  const setView = useAppStore((state) => state.setView);
  const points = responseCurve(eq, 120);
  const width = 260;
  const height = 74;
  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height / 2 - (point.gain / 15) * (height / 2 - 4);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const activeBands = eq.filter((band) => band.enabled).length;
  return (
    <button type="button" className="mini-eq" onClick={() => setView('eq')}>
      <div className="mini-eq__head">
        <span className="section-title">
          <AudioLines size={13} /> Global EQ
        </span>
        <span className="chip">{activeBands} bands</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mini-eq__graph" aria-hidden="true">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="mini-eq__zero" />
        <path d={path} className="mini-eq__curve" />
      </svg>
      <div className="mini-eq__bands">
        {eq.map((band) => (
          <span key={band.index} className={`mini-eq__band mini-eq__band--${band.index}`}>
            <strong>{band.index}</strong>
            {band.gain > 0 ? '+' : ''}
            {band.gain.toFixed(1)}
          </span>
        ))}
      </div>
    </button>
  );
};

const Lane = ({
  block,
  laneIndex,
  lane,
  controls,
  panControl,
  onControl,
  onModel,
  onEnable,
}: {
  block: Block;
  laneIndex: 1 | 2;
  lane?: Block['secondLane'];
  controls: Control[];
  panControl?: Control;
  onControl: (id: string, value: number) => void;
  onModel: (model: string) => void;
  onEnable?: (enabled: boolean) => void;
}) => {
  const pending = new Set(useAppStore((state) => state.pending));
  const model = laneIndex === 1 ? block.model : lane?.model;
  const options = laneIndex === 1 ? block.modelOptions ?? [] : lane?.modelOptions ?? [];
  const enabled = laneIndex === 1 ? block.on : Boolean(lane?.enabled);
  const toneControls = controls.filter(
    (control) =>
      !control.name.startsWith('pan') &&
      (control.kind === 'float' ||
        control.kind === 'pfloat' ||
        control.kind === 'number'),
  );

  return (
    <section className={`amp-lane amp-lane--${laneIndex}`} aria-label={`NAM ${laneIndex}`}>
      <div className="amp-lane__tolex">
        <span className="amp-lane__handle" aria-hidden="true">
          <span />
        </span>

        <header className="amp-lane__head">
          <div className="amp-lane__badge">
            <span className="amp-lane__num mono">{laneIndex}</span>
            <span>NAM {laneIndex}</span>
          </div>
          <div className="amp-lane__state">
            <Led on={enabled} label={`NAM ${laneIndex} state`} size="md" />
            <span className="mono">{enabled ? 'ON' : 'OFF'}</span>
            {laneIndex === 2 && onEnable && (
              <button
                type="button"
                className="switch"
                aria-checked={enabled}
                onClick={() => onEnable(!enabled)}
                title="Enable the second NAM lane"
              >
                <span className="switch__track">
                  <span className="switch__thumb" />
                </span>
                <span>{enabled ? 'Lane on' : 'Lane off'}</span>
              </button>
            )}
            {laneIndex === 1 && <span className="chip chip--warn">fixed slot</span>}
          </div>
        </header>

        <div className="amp-lane__face">
          <div className="amp-lane__brandrow">
            <span className="amp-lane__face-brand">
              STOMPSTATION
              <small>DUAL NAM</small>
            </span>
            <span className="amp-lane__face-meta">48 kHz · LANE {laneIndex}</span>
          </div>

          <label className="amp-lane__model">
            <span className="eyebrow">Model</span>
            <select className="select" value={model} onChange={(event) => onModel(event.target.value)}>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="amp-lane__knobs">
            {toneControls.map((control) => (
              <Knob
                key={control.id}
                control={control}
                size="xl"
                pending={pending.has(control.id)}
                onChange={(value) => onControl(control.id, value)}
              />
            ))}
          </div>

          <div className="amp-lane__face-foot" aria-hidden="true">
            <span className={`amp-lane__jewel ${enabled ? 'amp-lane__jewel--on' : ''}`} />
            <span className="amp-lane__face-meta">DUAL NAM AMPLIFIER</span>
            <span className="amp-lane__face-vents" />
          </div>
        </div>

        <div className="amp-lane__grille" aria-hidden="true">
          <span className="amp-lane__grille-logo">STOMPSTATION</span>
          <span className="amp-lane__speakers">
            <span className="amp-lane__speaker" />
            <span className="amp-lane__speaker" />
          </span>
          <span className="amp-lane__cab-badge">NAM · {laneIndex}</span>
        </div>

        <span className="amp-lane__foot amp-lane__foot--left" aria-hidden="true" />
        <span className="amp-lane__foot amp-lane__foot--right" aria-hidden="true" />
      </div>

      <div className="amp-lane__stereo">
        <span className="field-label">Stereo placement</span>
        <div className="pan-track">
          <span>L</span>
          <input
            type="range"
            className="pan-slider"
            min={-100}
            max={100}
            step={1}
            value={panControl ? Number(panControl.value) : 0}
            aria-label={`Pan for NAM ${laneIndex}`}
            disabled={!panControl}
            onChange={(event) =>
              panControl && onControl(panControl.id, Number(event.target.value))
            }
          />
          <span>R</span>
          <span className="pan-value mono">
            {panControl
              ? Number(panControl.value) === 0
                ? 'C'
                : Number(panControl.value) < 0
                  ? `L${Math.abs(Number(panControl.value)).toFixed(0)}`
                  : `R${Number(panControl.value).toFixed(0)}`
              : '—'}
          </span>
        </div>
      </div>
    </section>
  );
};

export const AmpRoomView = () => {
  const blocks = useAppStore((state) => state.blocks);
  const setControl = useAppStore((state) => state.setControl);
  const setBlockModel = useAppStore((state) => state.setBlockModel);
  const setLaneModel = useAppStore((state) => state.setLaneModel);
  const setLaneEnabled = useAppStore((state) => state.setLaneEnabled);
  const setView = useAppStore((state) => state.setView);
  const undo = useAppStore((state) => state.undo);
  const notify = useAppStore((state) => state.notify);
  const [compare, setCompare] = useState<'A' | 'B'>('A');
  const [linkLevels, setLinkLevels] = useState(false);

  const amp = blocks.find((block) => block.family === 'amp');
  const cab = blocks.find((block) => block.family === 'cab');

  if (!amp) {
    return (
      <div className="empty-view panel">
        <h2>No amp block in this chain</h2>
        <p>Add an amp from the board to open the amp room.</p>
        <button type="button" className="btn btn--primary" onClick={() => setView('board')}>
          Back to board
        </button>
      </div>
    );
  }

  const copySettings = () => {
    if (!amp.secondLane) return;
    const source = compare === 'A' ? amp.controls : amp.secondLane.controls;
    const targetIsA = compare === 'B';
    const target = targetIsA ? amp.controls : amp.secondLane.controls;
    source.forEach((control) => {
      const counterpart = target.find(
        (candidate) => candidate.name === control.name || candidate.name === control.name.replace('nam2.', ''),
      );
      if (counterpart && typeof control.value === 'number') {
        setControl(counterpart.id, control.value);
      }
    });
    notify(`Copied ${compare} → ${targetIsA ? 'A' : 'B'}`, 'good');
  };

  return (
    <div className="amp-room">
      <header className="view-head amp-room__head">
        <div className="view-head__title">
          <span className="eyebrow">Board / Amp (NAM) / Focus</span>
          <h1>Amp room</h1>
          <span className="view-head__meta mono">
            {amp.secondLane
              ? amp.secondLane.enabled
                ? 'DUAL LANE · 2 CAPTURES LOADED'
                : 'DUAL LANE · LANE 2 OFF'
              : 'SINGLE LANE'}
          </span>
        </div>
        <div className="view-head__actions">
          <button type="button" className="btn btn--sm" onClick={() => setView('board')}>
            <ArrowRight size={12} style={{ transform: 'rotate(180deg)' }} />
            Back to board
          </button>
          <span className="kbd">ESC</span>
          <span className="hint">↑ ↓ to step blocks</span>
        </div>
      </header>

      <div className="amp-room__grid">
        <div className="amp-room__lanes">
          <Lane
            block={amp}
            laneIndex={1}
            controls={amp.controls}
            panControl={
              amp.controls.find((control) => control.name === 'pan1' || control.name === 'pan') ??
              amp.secondLane?.controls.find((control) => control.name === 'pan1')
            }
            onControl={setControl}
            onModel={(model) => setBlockModel(amp.id, model)}
          />
          <Lane
            block={amp}
            laneIndex={2}
            lane={amp.secondLane}
            controls={amp.secondLane?.controls ?? []}
            panControl={
              amp.secondLane?.controls.find((control) => control.name === 'pan2') ??
              amp.secondLane?.controls.find((control) => control.name === 'pan' || control.name === 'pan1')
            }
            onControl={setControl}
            onModel={(model) => setLaneModel(amp.id, model)}
            onEnable={(enabled) => setLaneEnabled(amp.id, enabled)}
          />
        </div>

        <aside className="amp-room__side">
          <section className="amp-room__cab panel">
            <header className="utility-card__head">
              <span className="section-title">
                <Gauge size={13} /> Cabinet / IR
              </span>
              <span className="chip chip--good">IR 1 loaded</span>
            </header>
            <div className="cab-visual">
              <div className="cab-visual__frame">
                <div className="cab-visual__grille" />
                <span className="cab-visual__badge">TJ3</span>
                <span className="cab-visual__screw cab-visual__screw--tl" />
                <span className="cab-visual__screw cab-visual__screw--tr" />
                <span className="cab-visual__screw cab-visual__screw--bl" />
                <span className="cab-visual__screw cab-visual__screw--br" />
              </div>
            </div>
            {cab && (
              <>
                <label className="field-label" htmlFor="cabinet-ir">
                  Cabinet IR
                  <span className="mono">slot 1</span>
                </label>
                <select
                  id="cabinet-ir"
                  className="select"
                  value={cab.model}
                  onChange={(event) => setBlockModel(cab.id, event.target.value)}
                >
                  {(cab.modelOptions ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <div className="amp-room__cab-knobs">
                  {cab.controls.map((control) => (
                    <Knob
                      key={control.id}
                      control={control}
                      size="md"
                      onChange={(value) => setControl(control.id, value)}
                      format={(value) =>
                        control.name === 'blend'
                          ? `${value.toFixed(0)}%`
                          : control.name === 'lvl'
                            ? `${value.toFixed(1)} dB`
                            : value === 0
                              ? 'C'
                              : value < 0
                                ? `L${Math.abs(value).toFixed(0)}`
                                : `R${value.toFixed(0)}`
                      }
                    />
                  ))}
                </div>
                <button type="button" className="btn btn--sm" onClick={() => setView('library')}>
                  <Upload size={12} /> Upload IR
                </button>
              </>
            )}
          </section>

          <MiniEq />

          <section className="amp-room__compare panel">
            <header className="utility-card__head">
              <span className="section-title">
                <ArrowLeftRight size={13} /> A/B compare
              </span>
              <span className="chip">{compare === 'A' ? 'NAM 1' : 'NAM 2'}</span>
            </header>
            <div className="segmented amp-room__ab">
              <button type="button" aria-pressed={compare === 'A'} onClick={() => setCompare('A')}>
                A · NAM 1
              </button>
              <button type="button" aria-pressed={compare === 'B'} onClick={() => setCompare('B')}>
                B · NAM 2
              </button>
            </div>
            <div className="amp-room__compare-actions">
              <button type="button" className="btn btn--sm" onClick={copySettings}>
                <Copy size={12} /> Copy {compare} → {compare === 'A' ? 'B' : 'A'}
              </button>
              <button
                type="button"
                className="switch"
                aria-checked={linkLevels}
                onClick={() => setLinkLevels((value) => !value)}
              >
                <span className="switch__track">
                  <span className="switch__thumb" />
                </span>
                <Link2 size={11} /> Link levels
              </button>
            </div>
          </section>

          <section className="amp-room__history panel">
            <header className="utility-card__head">
              <span className="section-title">
                <Clock3 size={13} /> Edit history
              </span>
              <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} aria-label="Undo last edit" onClick={undo}>
                <RotateCcw size={12} />
              </button>
            </header>
            <ul className="history-list">
              <li>
                <span className="history-list__dot" />
                <span>Gain 6.2 → 6.4</span>
                <span className="mono">now</span>
              </li>
              <li>
                <span className="history-list__dot" />
                <span>Model changed</span>
                <span className="mono">2m</span>
              </li>
              <li>
                <span className="history-list__dot" />
                <span>Preset loaded</span>
                <span className="mono">14m</span>
              </li>
              <li>
                <span className="history-list__dot" />
                <span>IR blend 38%</span>
                <span className="mono">1h</span>
              </li>
            </ul>
            <div className="amp-room__history-foot">
              <span className="hint">
                <LockKeyhole size={10} /> Undo available · Ctrl+Z
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => notify('History refreshed', 'neutral')}>
                <RefreshCw size={11} /> Refresh
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};
