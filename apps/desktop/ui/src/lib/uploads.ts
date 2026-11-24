/** Capture lists are addressed by device path, while the UI uses short ids. */
export const UPLOAD_TARGET_PATHS: Record<string, string> = {
  nam_amp: 'root\\nam_amp',
  nam_drive: 'root\\nam_drive',
  pnam_list: 'root\\pnam_list',
  pnam_drive: 'root\\pnam_drive',
  ir_list: 'root\\ir_list',
  vxamp_list: 'root\\vxamp_list',
};

export const uploadTargetPath = (target: string): string =>
  UPLOAD_TARGET_PATHS[target] ?? target;

export const uploadTargetId = (path: string): string =>
  path.split(/[\\/]/).pop() || path;
