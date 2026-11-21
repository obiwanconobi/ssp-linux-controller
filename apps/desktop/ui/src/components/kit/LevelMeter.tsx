import { useEffect, useRef } from 'react';

interface LevelMeterProps {
  input: [number, number];
  output: [number, number];
  active?: boolean;
  compact?: boolean;
}

const toPercent = (db: number) => {
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
};

const formatDb = (db: number) => `${db > -1 ? '+' : ''}${db.toFixed(0)}`;

export const LevelMeter = ({ input, output, active = true, compact = false }: LevelMeterProps) => {
  const bars = useRef<Array<HTMLDivElement | null>>([]);
  const peaks = useRef<Array<HTMLDivElement | null>>([]);
  const values = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    let frame = 0;
    let peakValues = [0, 0, 0, 0];
    let last = 0;
    const levels = [...input, ...output];
    const tick = (time: number) => {
      if (time - last > 55) {
        last = time;
        levels.forEach((base, index) => {
          const wobble = active ? (Math.random() - 0.5) * 2.2 : 0;
          const level = Math.max(-60, Math.min(0, base + wobble));
          const percent = toPercent(level);
          peakValues[index] = Math.max(percent, peakValues[index] - 0.55);
          if (bars.current[index]) bars.current[index]!.style.setProperty('--level', `${percent}%`);
          if (peaks.current[index]) peaks.current[index]!.style.setProperty('--peak', `${peakValues[index]}%`);
          if (values.current[index]) values.current[index]!.textContent = formatDb(level);
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, input, output]);

  return (
    <div className={`level-meter${compact ? ' level-meter--compact' : ''}`} aria-label="Stereo level meters">
      {[
        { label: 'IN', pair: input, offset: 0 },
        { label: 'OUT', pair: output, offset: 2 },
      ].map((row) => (
        <div className="level-meter__row" key={row.label}>
          <span className="level-meter__label">{row.label}</span>
          <div className="level-meter__tracks">
            {row.pair.map((level, index) => (
              <div className="level-meter__track" key={index}>
                <div
                  className="level-meter__fill"
                  ref={(element) => {
                    bars.current[row.offset + index] = element;
                  }}
                  style={{ '--level': `${toPercent(level)}%` } as React.CSSProperties}
                />
                <div
                  className="level-meter__peak"
                  ref={(element) => {
                    peaks.current[row.offset + index] = element;
                  }}
                  style={{ '--peak': `${toPercent(level)}%` } as React.CSSProperties}
                />
              </div>
            ))}
          </div>
          {!compact && (
            <span
              className="level-meter__db"
              ref={(element) => {
                values.current[row.offset] = element;
              }}
            >
              {formatDb(row.pair[0])}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};
