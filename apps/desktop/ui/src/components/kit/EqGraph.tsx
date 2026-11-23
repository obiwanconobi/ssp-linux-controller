import { useEffect, useRef } from 'react';
import {
  bandResponseDb,
  bandTypeLabel,
  combinedResponseDb,
  EQ_GRID_FREQUENCIES,
  EQ_GRID_GAINS,
  formatGain,
  formatHz,
  frequencyFromLog,
  logFrequency,
  MAX_FREQ,
  MAX_GAIN,
  MIN_FREQ,
} from '../../lib/eq';
import type { EqBand } from '../../types';

export const EQ_BAND_COLORS = [
  'var(--band-1)',
  'var(--band-2)',
  'var(--band-3)',
  'var(--band-4)',
];

const WIDTH = 1000;
const HEIGHT = 360;
const LEFT = 58;
const RIGHT = 982;
const TOP = 18;
const BOTTOM = 314;
const PLOT_W = RIGHT - LEFT;
const PLOT_H = BOTTOM - TOP;
const MID = (TOP + BOTTOM) / 2;

export interface EqGraphProps {
  bands: EqBand[];
  selected: number;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: Partial<EqBand>) => void;
  ariaLabel: string;
  minFrequency?: number;
  maxFrequency?: number;
  maxGain?: number;
  minQ?: number;
  maxQ?: number;
  className?: string;
}

export const EqGraph = ({
  bands,
  selected,
  onSelect,
  onChange,
  ariaLabel,
  minFrequency = MIN_FREQ,
  maxFrequency = MAX_FREQ,
  maxGain = MAX_GAIN,
  minQ = 0.1,
  maxQ = 10,
  className = '',
}: EqGraphProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<number | null>(null);
  const selectedRef = useRef(selected);
  const bandsRef = useRef(bands);
  const yScale = PLOT_H / 2 / maxGain;

  selectedRef.current = selected;
  bandsRef.current = bands;

  const xFor = (frequency: number) =>
    LEFT + logFrequency(frequency, minFrequency, maxFrequency) * PLOT_W;
  const yFor = (gain: number) => MID - gain * yScale;

  const curvePath = (source: EqBand[], index?: number): string => {
    const points = 280;
    return Array.from({ length: points }, (_, point) => {
      const frequency = frequencyFromLog(
        point / (points - 1),
        minFrequency,
        maxFrequency,
      );
      const gain =
        index == null
          ? combinedResponseDb(source, frequency)
          : bandResponseDb(source[index], frequency);
      return `${point === 0 ? 'M' : 'L'}${xFor(frequency).toFixed(2)},${yFor(gain).toFixed(2)}`;
    }).join(' ');
  };

  const pointFromEvent = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    const fraction = Math.min(1, Math.max(0, (x - LEFT) / PLOT_W));
    const frequency = frequencyFromLog(fraction, minFrequency, maxFrequency);
    const gain = Math.min(maxGain, Math.max(-maxGain, (MID - y) / yScale));
    return { frequency, gain };
  };

  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const band = bandsRef.current.find((item) => item.index === selectedRef.current);
      if (!band) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.05 : 0.05;
      onChange(band.index, {
        q: Math.min(maxQ, Math.max(minQ, Number((band.q + delta).toFixed(2)))),
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [maxQ, minQ, onChange]);

  return (
    <div className={`eq-graph ${className}`.trim()} ref={graphRef}>
      <svg
        ref={svgRef}
        className="eq-graph__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={ariaLabel}
        onPointerMove={(event) => {
          const dragging = draggingRef.current;
          if (dragging == null) return;
          const { frequency, gain } = pointFromEvent(event);
          onChange(dragging, {
            frequency: Math.round(frequency),
            gain: Number(gain.toFixed(1)),
          });
        }}
        onPointerUp={() => {
          draggingRef.current = null;
        }}
        onPointerCancel={() => {
          draggingRef.current = null;
        }}
      >
        {EQ_GRID_GAINS.filter((gain) => Math.abs(gain) <= maxGain).map((gain) => (
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
        {EQ_GRID_FREQUENCIES.filter(
          (frequency) => frequency >= minFrequency && frequency <= maxFrequency,
        ).map((frequency) => (
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
            style={{ stroke: EQ_BAND_COLORS[index % EQ_BAND_COLORS.length] }}
          />
        ))}
        <path d={curvePath(bands)} className="eq-graph__combined" />

        {bands.map((band, index) => {
          const x = xFor(band.frequency);
          const y = yFor(band.gain);
          const isSelected = selected === band.index;
          const color = EQ_BAND_COLORS[index % EQ_BAND_COLORS.length];
          return (
            <g key={`handle-${band.index}`}>
              {isSelected && <circle cx={x} cy={y} r={16} fill={color} opacity={0.14} />}
              <circle
                cx={x}
                cy={y}
                r={isSelected ? 11 : 8}
                fill={color}
                className={`eq-graph__handle${isSelected ? ' eq-graph__handle--selected' : ''}`}
                role="slider"
                tabIndex={0}
                aria-label={`Band ${band.index}, ${bandTypeLabel(band.type)}, ${formatHz(
                  band.frequency,
                )}, ${formatGain(band.gain)}, Q ${band.q}`}
                aria-valuemin={-maxGain}
                aria-valuemax={maxGain}
                aria-valuenow={band.gain}
                aria-valuetext={`${formatHz(band.frequency)}, ${formatGain(band.gain)}, Q ${band.q}`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onSelect(band.index);
                  draggingRef.current = band.index;
                  svgRef.current?.setPointerCapture(event.pointerId);
                }}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 0.1 : 1;
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    onChange(band.index, { gain: Math.min(maxGain, band.gain + step) });
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    onChange(band.index, { gain: Math.max(-maxGain, band.gain - step) });
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    onChange(band.index, {
                      frequency: Math.max(minFrequency, Math.round(band.frequency * 0.95)),
                    });
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    onChange(band.index, {
                      frequency: Math.min(maxFrequency, Math.round(band.frequency * 1.05)),
                    });
                  } else if (event.key === 'PageUp') {
                    event.preventDefault();
                    onChange(band.index, { q: Math.min(maxQ, Number((band.q + 0.1).toFixed(2))) });
                  } else if (event.key === 'PageDown') {
                    event.preventDefault();
                    onChange(band.index, { q: Math.max(minQ, Number((band.q - 0.1).toFixed(2))) });
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
  );
};
