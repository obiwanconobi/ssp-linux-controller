// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitAndroidSaveTarget,
  prepareAndroidSaveTarget,
  resolvePickedFile,
} from './androidFiles';

afterEach(() => {
  delete window.StompAndroid;
});

describe('Android document bridge', () => {
  it('copies content URIs into a readable cache path', () => {
    window.StompAndroid = {
      resolveFileUri: vi.fn(() => '/data/cache/picked-files/Amp.nam'),
      cachePathForName: vi.fn(() => '/data/cache/picked-files/out.zip'),
      copyFileToUri: vi.fn(() => true),
    };
    expect(resolvePickedFile('content://com.android.providers.downloads/Amp')).toBe(
      '/data/cache/picked-files/Amp.nam',
    );
    expect(resolvePickedFile('/tmp/Amp.nam')).toBe('/tmp/Amp.nam');
    expect(window.StompAndroid.resolveFileUri).toHaveBeenCalledTimes(1);
  });

  it('rejects a failed content copy', () => {
    window.StompAndroid = {
      resolveFileUri: () => '',
      cachePathForName: () => '',
      copyFileToUri: () => false,
    };
    expect(() => resolvePickedFile('content://x')).toThrow(
      'Could not copy the selected file',
    );
  });

  it('saves through a cache file and copies it into the chosen URI', () => {
    window.StompAndroid = {
      resolveFileUri: vi.fn(),
      cachePathForName: vi.fn(() => '/data/cache/picked-files/preset-1.zip'),
      copyFileToUri: vi.fn(() => true),
    };
    const target = prepareAndroidSaveTarget(
      'content://com.android.providers.downloads/preset',
      'preset-1.zip',
    );
    expect(target).toEqual({
      rustPath: '/data/cache/picked-files/preset-1.zip',
      contentUri: 'content://com.android.providers.downloads/preset',
    });
    commitAndroidSaveTarget(target);
    expect(window.StompAndroid.copyFileToUri).toHaveBeenCalledWith(
      '/data/cache/picked-files/preset-1.zip',
      'content://com.android.providers.downloads/preset',
    );
  });

  it('leaves normal desktop paths alone', () => {
    const target = prepareAndroidSaveTarget('/tmp/preset.zip', 'preset.zip');
    expect(target).toEqual({ rustPath: '/tmp/preset.zip' });
    commitAndroidSaveTarget(target);
  });
});
