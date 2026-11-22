import { RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Knob } from '../../components/kit/Knob';
import {
  bandResponseDb,
  combinedResponseDb,
  EQ_GRID_FREQUENCIES,
  EQ_GRID_GAINS,
  formatGain,
  formatHz,
  frequencyFromLog,
  logFrequency,
  MAX_GAIN,
} from '../../lib/eq';
import { useAppStore } from '../../stores/useAppStore';
import type { EqBand, EqBandType } from '../../types';

const WIDTH = 1000;
const HEIGHT = 360;
const LEFT = 58;
const RIGHT = 982;
const TOP = 18;
const BOTTOM = 314;
const PLOT_W = RIGHT - LEFT;
const PLOT_H = BOTTOM - TOP;
const MID = (TOP + BOTTOM) / 2;
const Y_SCALE = PLOT_H / 2 / MAX_GAIN;
const BAND_COLORS = ['var(--band-1)', 'var(--band-2)', 'var(--band-3)', 'var(--band-4)'];
const BAND_TYPES: EqBandType[] = ['LPS', 'BP', 'HPS', 'LP', 'HP'];

const xFor = (frequency: number) => LEFT + logFrequency(frequency) * PLOT_W;
const yFor = (gain: number) => MID - gain * Y_SCALE;

const curvePath = (bands: EqBand[], index?: number): string => {
  const points = 280;
  return Array.from({ length: points }, (_, point) => {
    const frequency = frequencyFromLog(point / (points - 1));
    const gain =
      index == null
        ? combinedResponseDb(bands, frequency)
        : bandResponseDb(bands[index], frequency);
    return `${point === 0 ? 'M' : 'L'}${xFor(frequency).toFixed(2)},${yFor(gain).toFixed(2)}`;
  }).join(' ');
};

const typeLabel = (type: EqBandType) =>
  type === 'LPS' ? 'Low shelf' : type === 'HPS' ? 'High shelf' : 'Bell';

interface Snapshot {
  bands: EqBand[];
}

export const EqView = () => {
  const bands = useAppStore((state) => state.eq);
  const eqEnabled = useAppStore((state) => state.eqEnabled);
  const setEqBand = useAppStore((state) => state.setEqBand);
  const setEqEnabled = useAppStore((state) => state.setEqEnabled);
  const flattenEq = useAppStore((state) => state.flattenEq);
  const notify = useAppStore((state) => state.notify);
  const [selected, setSelected] = useState(2);
  const [dragging, setDragging] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);

  const enabled = eqEnabled;

  const pointFromEvent = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    const fraction = Math.min(1, Math.max(0, (x - LEFT) / PLOT_W));
    const frequency = frequencyFromLog(fraction);
    const gain = Math.min(MAX_GAIN, Math.max(-MAX_GAIN, (MID - y) / Y_SCALE));
    return { frequency, gain };
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragging == null) return;
    const { frequency, gain } = pointFromEvent(event);
    setEqBand(dragging + 1, {
      frequency: Math.round(frequency),
      gain: Number(gain.toFixed(1)),
    });
  };

  const selectedBand = bands.find((band) => band.index === selected) ?? bands[0];
  const selectedBandRef = useRef(selectedBand);
  useEffect(() => {
    selectedBandRef.current = selectedBand;
  }, [selectedBand]);

  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const band = selectedBandRef.current;
      if (!band) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.05 : 0.05;
      setEqBand(band.index, {
        q: Math.min(10, Math.max(0.1, Number((band.q + delta).toFixed(2)))),
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setEqBand]);

  const takeSnapshot = () => {
    setSnapshot({ bands: bands.map((band) => ({ ...band })) });
    notify('EQ snapshot captured', 'good');
  };

  const recallSnapshot = () => {
    if (!snapshot) {
      notify('No EQ snapshot yet', 'neutral');
      return;
    }
    snapshot.bands.forEach((band) => setEqBand(band.index, { ...band }));
    notify('EQ snapshot recalled', 'good');
  };

  return (
    <div className="eq-view">
      <header className="view-head eq-view__head">
        <div className="view-head__title">
          <span className="eyebrow">Output stage / global</span>
          <h1>Global EQ</h1>
          <span className="view-head__meta mono">4 bands · 48 kHz · RBJ biquads</span>
        </div>
        <div className="view-head__actions">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={enabled}
            onClick={() => setEqEnabled(!enabled)}
          >
            <span className="switch__track">
              <span className="switch__thumb" />
            </span>
            <span>{enabled ? 'Enabled' : 'Bypassed'}</span>
          </button>
          <button type="button" className="btn btn--sm" onClick={flattenEq}>
            <RotateCcw size={12} /> Flat
          </button>
          <button type="button" className="btn btn--sm" onClick={takeSnapshot}>
            <Sparkles size={12} /> Snapshot
          </button>
          <button type="button" className="btn btn--sm" onClick={recallSnapshot} disabled={!snapshot}>
            Recall
          </button>
        </div>
      </header>

      <section className="eq-view__graph-card panel">
        <header className="eq-view__graph-head">
          <span className="section-title">
            <SlidersHorizontal size={13} /> Response
          </span>
          <span className="hint">click a band · drag to shape · scroll for Q</span>
          <div className="eq-view__legend">
            {bands.map((band) => (
              <button
                key={band.index}
                type="button"
                className={`eq-legend${selected === band.index ? ' eq-legend--active' : ''}`}
                onClick={() => setSelected(band.index)}
              >
                <span className="eq-legend__dot" style={{ background: BAND_COLORS[band.index - 1] }} />
                {band.index} · {formatHz(band.frequency)}
              </button>
            ))}
          </div>
        </header>

        <div className="eq-graph" ref={graphRef}>
          <svg
            ref={svgRef}
            className="eq-graph__svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label="Global EQ response graph"
            onPointerMove={onPointerMove}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
          >
            {EQ_GRID_GAINS.map((gain) => (
              <g key={gain}>
                <line
                  x1={LEFT}
                  x2={RIGHT}
                  y1={yFor(gain)}
                  y2={yFor(gain)}
                  className={`eq-graph__grid${gain === 0 ? ' eq-graph__grid--major' : ''}`}
                />
                <text x={LEFT - 14} y={yFor(gain) + 3} textAnchor="end" className="eq-graph__label">
                  {gain > 0 ? `+${gain}` : gain}
                </text>
              </g>
            ))}
            {EQ_GRID_FREQUENCIES.map((frequency) => (
              <g key={frequency}>
                <line
                  x1={xFor(frequency)}
                  x2={xFor(frequency)}
                  y1={TOP}
                  y2={BOTTOM}
                  className="eq-graph__grid"
                />
                <text
                  x={xFor(frequency)}
                  y={BOTTOM + 18}
                  textAnchor="middle"
                  className="eq-graph__label"
                >
                  {frequency >= 1000 ? `${frequency / 1000}k` : frequency}
                </text>
              </g>
            ))}
            <text x={LEFT - 14} y={TOP + 4} textAnchor="end" className="eq-graph__label">
              dB
            </text>

            {bands.map((band, index) => (
              <path
                key={`band-${band.index}`}
                d={curvePath(bands, index)}
                className={`eq-graph__band${selected === band.index ? ' eq-graph__band--selected' : ''}`}
                style={{ stroke: BAND_COLORS[index] }}
              />
            ))}
            <path d={curvePath(bands)} className="eq-graph__combined" />

            {bands.map((band, index) => {
              const x = xFor(band.frequency);
              const y = yFor(band.gain);
              const isSelected = selected === band.index;
              return (
                <g key={`handle-${band.index}`}>
                  {isSelected && (
                    <circle cx={x} cy={y} r={16} fill={BAND_COLORS[index]} opacity={0.14} />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={isSelected ? 11 : 8}
                    fill={BAND_COLORS[index]}
                    className={`eq-graph__handle${isSelected ? ' eq-graph__handle--selected' : ''}`}
                    role="slider"
                    tabIndex={0}
                    aria-label={`Band ${band.index}, ${typeLabel(band.type)}, ${formatHz(band.frequency)}, ${formatGain(band.gain)}, Q ${band.q}`}
                    aria-valuemin={-MAX_GAIN}
                    aria-valuemax={MAX_GAIN}
                    aria-valuenow={band.gain}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      setSelected(band.index);
                      setDragging(band.index - 1);
                      svgRef.current?.setPointerCapture(event.pointerId);
                    }}
                    onKeyDown={(event) => {
                      const step = event.shiftKey ? 0.1 : 1;
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setEqBand(band.index, { gain: Math.min(MAX_GAIN, band.gain + step) });
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setEqBand(band.index, { gain: Math.max(-MAX_GAIN, band.gain - step) });
                      } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        setEqBand(band.index, { frequency: Math.max(20, band.frequency * 0.95) });
                      } else if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        setEqBand(band.index, { frequency: Math.min(20000, band.frequency * 1.05) });
                      }
                    }}
                  />
                  <text
                    x={x}
                    y={y + 3}
                    textAnchor="middle"
                    className="eq-graph__handle-label"
                    fill="var(--canvas)"
                    fontFamily="var(--font-mono)"
                    fontSize="9"
                    fontWeight="700"
                    pointerEvents="none"
                  >
                    {band.index}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </section>

      <div className="eq-view__cards">
        {bands.map((band, index) => {
          const active = selected === band.index;
          return (
            <section
              key={band.index}
              className={`eq-band-card${active ? ' eq-band-card--selected' : ''}`}
              style={{ '--band-color': BAND_COLORS[index] } as React.CSSProperties}
              onClick={() => setSelected(band.index)}
            >
              <header className="eq-band-card__head">
                <div className="eq-band-card__title-wrap">
                  <span
                    className="eq-band-card__index"
                    style={{ background: BAND_COLORS[index] }}
                  >
                    {band.index}
                  </span>
                  <div>
                    <h2 className="eq-band-card__title">{typeLabel(band.type)}</h2>
                    <span className="eq-band-card__sub mono">{formatHz(band.frequency)}</span>
                  </div>
                </div>
                <div className="eq-band-card__gain mono">{formatGain(band.gain)}</div>
              </header>
              <div className="eq-band-card__fields">
                <label className="eq-band-card__field">
                  <span className="field-label">Type</span>
                  <select
                    className="select"
                    value={band.type}
                    onChange={(event) =>
                      setEqBand(band.index, { type: event.target.value as EqBandType })
                    }
                  >
                    {BAND_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {typeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Frequency</span>
                  <input
                    className="input"
                    type="number"
                    min={20}
                    max={20000}
                    step={10}
                    value={Math.round(band.frequency)}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        frequency: Math.min(20000, Math.max(20, Number(event.target.value))),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Gain</span>
                  <input
                    className="input"
                    type="number"
                    min={-15}
                    max={15}
                    step={0.1}
                    value={band.gain}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        gain: Math.min(15, Math.max(-15, Number(event.target.value))),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Q</span>
                  <input
                    className="input"
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.05}
                    value={band.q}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        q: Math.min(10, Math.max(0.1, Number(event.target.value))),
                      })
                    }
                  />
                </label>
              </div>
              <div className="eq-band-card__knobs">
                <Knob
                  control={{
                    id: `eq.${band.index}.gain`,
                    name: 'gain',
                    label: 'Gain',
                    kind: 'float',
                    value: band.gain,
                    min: -15,
                    max: 15,
                    step: 0.1,
                    defaultValue: 0,
                    unit: 'dB',
                  }}
                  size="md"
                  color={BAND_COLORS[index]}
                  onChange={(value) => setEqBand(band.index, { gain: value })}
                />
                <Knob
                  control={{
                    id: `eq.${band.index}.q`,
                    name: 'q',
                    label: 'Q',
                    kind: 'float',
                    value: band.q,
                    min: 0.1,
                    max: 10,
                    step: 0.05,
                    defaultValue: 0.7,
                  }}
                  size="md"
                  color={BAND_COLORS[index]}
                  onChange={(value) => setEqBand(band.index, { q: value })}
                  format={(value) => value.toFixed(2)}
                />
              </div>
            </section>
          );
        })}
      </div>
      <p className="eq-view__foot hint">
        Global EQ lives on the output stage. It is not a per-preset effect; every preset hears it.
        Bypass preserves settings. Flatten is undoable.
      </p>
    </div>
  );
};
