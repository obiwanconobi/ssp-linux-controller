import { loadDirectoryPreference, rememberDirectoryForPath } from './recentPaths';

const safeFileName = (name: string, fallback: string): string => {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || fallback;
};

/** Native save dialog for a preset bundle. Returns null when cancelled. */
export const choosePresetExportPath = async (presetName: string): Promise<string | null> => {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const remembered = loadDirectoryPreference('bundle.export');
  const fileName = `${safeFileName(presetName, 'preset')}.zip`;
  const selected = await save({
    title: `Export ${presetName}`,
    defaultPath: remembered ? `${remembered}/${fileName}` : fileName,
    filters: [{ name: 'StompStation preset bundle', extensions: ['zip'] }],
  });
  if (typeof selected !== 'string') return null;
  rememberDirectoryForPath('bundle.export', selected);
  return selected;
};

/** Native open dialog for a preset bundle. Returns null when cancelled. */
export const choosePresetImportPath = async (): Promise<string | null> => {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const remembered = loadDirectoryPreference('bundle.import');
  const selected = await open({
    title: 'Import a preset bundle',
    multiple: false,
    directory: false,
    defaultPath: remembered ?? undefined,
    filters: [{ name: 'StompStation preset bundle', extensions: ['zip'] }],
  });
  if (typeof selected !== 'string') return null;
  rememberDirectoryForPath('bundle.import', selected);
  return selected;
};
