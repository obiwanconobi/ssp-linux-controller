import { Zap } from 'lucide-react';

export const BrandMark = ({ size = 26 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    aria-hidden="true"
    className="brand-mark"
  >
    <rect x="3" y="3" width="58" height="58" rx="13" fill="var(--raised)" stroke="var(--hairline)" />
    <rect x="11" y="11" width="42" height="42" rx="7" fill="var(--surface)" stroke="var(--hairline)" />
    <circle cx="22" cy="23" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
    <circle cx="32" cy="23" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
    <circle cx="42" cy="23" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
    <path
      d="M33.5 29.5 39 36l-4.7 1.4 3 6.2-9.4-8 4.7-1.2Z"
      fill="var(--accent)"
      stroke="var(--accent)"
      strokeWidth="1"
      strokeLinejoin="round"
    />
    <circle cx="18" cy="46" r="2.1" fill="var(--led)" />
  </svg>
);

export const Brand = ({ compact = false }: { compact?: boolean }) => (
  <div className="brand" aria-label="StompStation">
    {compact ? <Zap size={17} /> : <BrandMark />}
    <div className="brand__text">
      <span className="brand__name">STOMPSTATION</span>
      <span className="brand__sub">TAURI</span>
    </div>
  </div>
);
