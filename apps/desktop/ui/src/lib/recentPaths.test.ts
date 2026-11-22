// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadDirectoryPreference,
  parentDirectory,
  rememberDirectory,
  rememberDirectoryForPath,
} from './recentPaths';

describe('recent path preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('extracts parent folders from POSIX, Windows, and UNC paths', () => {
    expect(parentDirectory('/home/me/captures/amp.nam')).toBe('/home/me/captures');
    expect(parentDirectory('C:\\Users\\me\\Captures\\cab.wav')).toBe(
      'C:\\Users\\me\\Captures',
    );
    expect(parentDirectory('\\\\nas\\share\\captures\\amp.pnam')).toBe(
      '\\\\nas\\share\\captures',
    );
    expect(parentDirectory('/amp.nam')).toBe('/');
    expect(parentDirectory('C:\\amp.nam')).toBe('C:\\');
    expect(parentDirectory('amp.nam')).toBeNull();
    expect(parentDirectory('')).toBeNull();
  });

  it('remembers a directory per capture scope', () => {
    rememberDirectoryForPath('upload.nam', '/home/me/captures/amp.nam');
    expect(loadDirectoryPreference('upload.nam')).toBe('/home/me/captures');
    expect(loadDirectoryPreference('upload.ir')).toBeNull();

    rememberDirectory('upload.ir', 'D:\\IRs');
    expect(loadDirectoryPreference('upload.ir')).toBe('D:\\IRs');
  });
});
