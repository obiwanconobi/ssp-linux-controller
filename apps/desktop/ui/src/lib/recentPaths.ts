const STORAGE_PREFIX = 'stomp.library.lastDirectory';

const storageKey = (scope: string): string => `${STORAGE_PREFIX}.${scope}`;

/** Return the parent directory for a POSIX, Windows, or UNC file path. */
export const parentDirectory = (path: string): string | null => {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (slash < 0) return null;
  if (slash === 0) return trimmed.startsWith('/') ? '/' : null;
  const parent = trimmed.slice(0, slash);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
};

export const loadDirectoryPreference = (scope: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(storageKey(scope));
  } catch {
    return null;
  }
};

export const rememberDirectory = (scope: string, directory: string): void => {
  if (!directory || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(scope), directory);
  } catch {
    /* localStorage may be unavailable in the embedded webview */
  }
};

export const rememberDirectoryForPath = (scope: string, path: string): void => {
  const directory = parentDirectory(path);
  if (directory) rememberDirectory(scope, directory);
};
