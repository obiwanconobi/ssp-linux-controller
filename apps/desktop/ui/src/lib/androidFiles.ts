/**
 * Android document-picker bridge.
 *
 * Tauri's dialog plugin returns `content://` URIs. The Rust uploader reads
 * normal filesystem paths, so MainActivity exposes a small synchronous bridge
 * that copies picked content into app cache and copies app-cache outputs back
 * into a selected content URI.
 */
interface AndroidFileBridge {
  resolveFileUri(uri: string): string;
  cachePathForName(name: string): string;
  copyFileToUri(sourcePath: string, uri: string): boolean;
}

declare global {
  interface Window {
    StompAndroid?: AndroidFileBridge;
  }
}

export const isAndroidContentUri = (path: string): boolean =>
  /^content:\/\//i.test(path);

const bridge = (): AndroidFileBridge => {
  const candidate = typeof window !== 'undefined' ? window.StompAndroid : undefined;
  if (!candidate) {
    throw new Error(
      'Android file bridge is unavailable; rebuild/restart the app to enable the picker',
    );
  }
  return candidate;
};

/** Turn a picked content:// URI into a readable cache path. */
export const resolvePickedFile = (path: string): string => {
  if (!isAndroidContentUri(path)) return path;
  const resolved = bridge().resolveFileUri(path);
  if (!resolved) {
    throw new Error('Could not copy the selected file into app storage');
  }
  return resolved;
};

export interface SaveTarget {
  /** Path passed to the Rust download/export command. */
  rustPath: string;
  /** Content URI to copy into after the Rust command succeeds. */
  contentUri?: string;
}

/** Choose the path the Rust side should write, and remember the content URI. */
export const prepareAndroidSaveTarget = (
  selected: string,
  cacheFileName: string,
): SaveTarget => {
  if (!isAndroidContentUri(selected)) return { rustPath: selected };
  const rustPath = bridge().cachePathForName(cacheFileName);
  if (!rustPath) {
    throw new Error('Could not allocate a temporary save file');
  }
  return { rustPath, contentUri: selected };
};

/** Copy the finished cache file into the user-selected content URI. */
export const commitAndroidSaveTarget = (target: SaveTarget): void => {
  if (!target.contentUri) return;
  if (!bridge().copyFileToUri(target.rustPath, target.contentUri)) {
    throw new Error('Could not save the file to the selected location');
  }
};
