import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  fetchLatestRelease,
  parseLatestRelease,
  parseVersion,
} from './updates';

describe('version comparison', () => {
  it('parses release tags with and without a v prefix', () => {
    expect(parseVersion('v0.6.1')?.core).toEqual([0, 6, 1]);
    expect(parseVersion('0.6.1')?.core).toEqual([0, 6, 1]);
    expect(parseVersion('1.10.0-rc.2')?.prerelease).toEqual(['rc', '2']);
    expect(parseVersion('1.0.0+build.7')?.core).toEqual([1, 0, 0]);
    expect(parseVersion('nightly')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });

  it('orders releases by numeric core segments', () => {
    expect(compareVersions('v0.6.1', '0.6.0')).toBe(1);
    expect(compareVersions('0.6.0', 'v0.6.0')).toBe(0);
    expect(compareVersions('v0.9.9', 'v0.10.0')).toBe(-1);
    expect(compareVersions('v1.0.0', 'v0.99.99')).toBe(1);
  });

  it('sorts prereleases before the matching stable release', () => {
    expect(compareVersions('v0.7.0', 'v0.7.0-rc.1')).toBe(1);
    expect(compareVersions('v0.7.0-beta', 'v0.7.0-alpha')).toBe(1);
    expect(compareVersions('v0.7.0-rc.2', 'v0.7.0-rc.10')).toBe(-1);
    expect(compareVersions('v0.7.0-alpha', 'v0.7.0-alpha.1')).toBe(-1);
  });

  it('returns null when a side cannot be compared', () => {
    expect(compareVersions('dev', 'v0.6.1')).toBeNull();
    expect(compareVersions('v0.6.1', '')).toBeNull();
  });
});

describe('GitHub release parsing', () => {
  it('keeps the fields rendered by the About card', () => {
    expect(
      parseLatestRelease({
        tag_name: 'v0.7.0',
        name: 'StompStation v0.7.0',
        html_url: 'https://github.com/obiwanconobi/ssp-linux-controller/releases/tag/v0.7.0',
        published_at: '2026-12-01T10:00:00Z',
      }),
    ).toEqual({
      tag: 'v0.7.0',
      version: '0.7.0',
      name: 'StompStation v0.7.0',
      url: 'https://github.com/obiwanconobi/ssp-linux-controller/releases/tag/v0.7.0',
      publishedAt: '2026-12-01T10:00:00Z',
    });
  });

  it('builds a release URL when GitHub omits one', () => {
    const release = parseLatestRelease({ tag_name: 'v0.7.0' });
    expect(release.url).toBe(
      'https://github.com/obiwanconobi/ssp-linux-controller/releases/tag/v0.7.0',
    );
  });

  it('rejects payloads without a comparable tag', () => {
    expect(() => parseLatestRelease({ tag_name: 'nightly' })).toThrow(
      /not a version/,
    );
    expect(() => parseLatestRelease({})).toThrow(/release tag/);
  });
});

describe('latest release fetch', () => {
  const release = {
    tag_name: 'v0.7.0',
    html_url: 'https://github.com/obiwanconobi/ssp-linux-controller/releases/tag/v0.7.0',
  };

  it('requests the latest non-prerelease release with GitHub headers', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const latest = await fetchLatestRelease((async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify(release), { status: 200 });
    }) as typeof fetch);
    expect(latest.version).toBe('0.7.0');
    expect(calls[0][0]).toContain('/releases/latest');
    expect((calls[0][1]?.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github+json',
    );
  });

  it('turns rate limits and missing releases into readable errors', async () => {
    await expect(
      fetchLatestRelease(
        (async () => new Response('{}', { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow(/rate-limited/);
    await expect(
      fetchLatestRelease(
        (async () => new Response('{}', { status: 404 })) as typeof fetch,
      ),
    ).rejects.toThrow(/No published releases/);
  });

  it('turns network failures into a readable error', async () => {
    await expect(
      fetchLatestRelease((async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch),
    ).rejects.toThrow(/Could not reach GitHub/);
  });

  it('turns timeouts and unreadable payloads into readable errors', async () => {
    await expect(
      fetchLatestRelease((async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as typeof fetch),
    ).rejects.toThrow(/did not respond in time/);
    await expect(
      fetchLatestRelease(
        (async () => new Response('not json', { status: 200 })) as typeof fetch,
      ),
    ).rejects.toThrow(/could not be read/);
  });
});
