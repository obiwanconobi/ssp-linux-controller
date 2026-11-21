interface TunerGaugeProps {
  cents: number;
  inTune?: boolean;
  compact?: boolean;
}

const polar = (angle: number, radius: number, centerX = 170, centerY = 138) => {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(radians),
    y: centerY + radius * Math.sin(radians),
  };
};

const arcPath = (start: number, end: number, radius = 118): string => {
  const from = polar(start, radius);
  const to = polar(end, radius);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
};

const ANGLE = 62;

export const TunerGauge = ({ cents, inTune = false, compact = false }: TunerGaugeProps) => {
  const fraction = Math.max(-1, Math.min(1, cents / 50));
  const angle = fraction * ANGLE;
  const needle = polar(angle, 104);
  const center = polar(angle, 16);
  const ticks = [-50, -25, 0, 25, 50];

  return (
    <div
      className={`tuner-gauge tuner-gauge--${compact ? 'compact' : 'full'}${inTune ? ' tuner-gauge--tuned' : ''}`}
      role="img"
      aria-label={`Tuner: ${inTune ? 'in tune' : `${cents.toFixed(1)} cents ${cents < 0 ? 'flat' : 'sharp'}`}`}
    >
      <svg className="tuner-gauge__svg" viewBox="0 0 340 168">
        <path className="tuner-gauge__arc" d={arcPath(-ANGLE, ANGLE)} />
        <path
          className="tuner-gauge__zone"
          d={arcPath(-(3 / 50) * ANGLE, (3 / 50) * ANGLE)}
        />
        {ticks.map((tick) => {
          const tickAngle = (tick / 50) * ANGLE;
          const inner = polar(tickAngle, 128);
          const outer = polar(tickAngle, 141);
          return (
            <g key={tick}>
              <line
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                className="tuner-gauge__tick"
              />
              <text
                x={outer.x}
                y={outer.y + (tick === 0 ? 14 : 12)}
                textAnchor="middle"
                className="eq-graph__label"
              >
                {tick === 0 ? '0' : tick > 0 ? `+${tick}` : tick}
              </text>
            </g>
          );
        })}
        <line
          x1={polar(0, 24).x}
          y1={polar(0, 24).y}
          x2={polar(0, 134).x}
          y2={polar(0, 134).y}
          className="tuner-gauge__center"
          opacity={0.35}
        />
        <line
          x1={center.x}
          y1={center.y}
          x2={needle.x}
          y2={needle.y}
          className="tuner-gauge__needle"
          style={{ stroke: inTune ? 'var(--led)' : 'var(--text)' }}
        />
        <circle cx={center.x} cy={center.y} r={5} fill="var(--accent)" />
      </svg>
    </div>
  );
};
