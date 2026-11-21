import type { Density, Motion, ThemeId } from '../types';

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  mode: 'dark' | 'light';
  swatches: string[];
  chassis: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'studio',
    name: 'Studio Black',
    description: 'A dark room with warm gear in it. The reference finish.',
    mode: 'dark',
    swatches: ['#12110f', '#1b1916', '#e07a3f', '#6fd79b', '#e9dfc8'],
    chassis: '#6d322b',
  },
  {
    id: 'cream',
    name: 'Cream Tolex',
    description: 'Aged cream panels, oxblood drive, worn workshop light.',
    mode: 'light',
    swatches: ['#e9e2d2', '#f8f2e5', '#b9542a', '#2f7d5c', '#f3ead6'],
    chassis: '#7a352b',
  },
  {
    id: 'british',
    name: 'British Green',
    description: 'Black-green tolex, gold piping, stage-left attitude.',
    mode: 'dark',
    swatches: ['#101410', '#1a2018', '#d6a347', '#79c98f', '#e7dfc9'],
    chassis: '#29402e',
  },
];

export const themeById = (id: ThemeId): ThemeDefinition =>
  THEMES.find((theme) => theme.id === id) ?? THEMES[0];

export const applyAppearance = (
  theme: ThemeId,
  density: Density,
  motion: Motion,
): void => {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.dataset.motion = motion;
  root.style.colorScheme = themeById(theme).mode;
};

export const loadAppearance = (): {
  theme: ThemeId;
  density: Density;
  motion: Motion;
} => {
  const read = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const theme = read('stomp.theme', 'studio');
  const density = read('stomp.density', 'comfortable');
  const motion = read('stomp.motion', 'full');
  return {
    theme: (['studio', 'cream', 'british'].includes(theme) ? theme : 'studio') as ThemeId,
    density: (density === 'compact' ? 'compact' : 'comfortable') as Density,
    motion: (motion === 'reduced' ? 'reduced' : 'full') as Motion,
  };
};

export const saveAppearance = (
  theme: ThemeId,
  density: Density,
  motion: Motion,
): void => {
  try {
    localStorage.setItem('stomp.theme', theme);
    localStorage.setItem('stomp.density', density);
    localStorage.setItem('stomp.motion', motion);
  } catch {
    /* local settings are best-effort */
  }
};
