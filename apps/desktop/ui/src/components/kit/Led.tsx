interface LedProps {
  on: boolean;
  label?: string;
  tone?: 'green' | 'amber';
  size?: 'sm' | 'md';
}

export const Led = ({ on, label, tone = 'green', size = 'sm' }: LedProps) => (
  <span
    className={`led ${on ? 'led--on' : 'led--off'}${tone === 'amber' && on ? ' led--amber' : ''}`}
    style={size === 'md' ? { width: 10, height: 10 } : undefined}
    role="img"
    aria-label={label ? `${label}: ${on ? 'on' : 'off'}` : on ? 'on' : 'off'}
  />
);
