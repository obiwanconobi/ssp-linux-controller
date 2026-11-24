const RELEASES_PAGE = 'https://github.com/obiwanconobi/ssp-linux-controller/releases';

const LATEST_RELEASE_API =
  'https://api.github.com/repos/obiwanconobi/ssp-linux-controller/releases/latest';

const RELEASE_TIMEOUT_MS = 12_000;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `v0.6.1`, `0.7.0-rc.1`, or `1.0.0+build`; return null for non-semver tags. */
export const parseVersion = (input: string): ParsedVersion | null => {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return null;
  const core: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (!core.every((part) => Number.isSafeInteger(part))) return null;
  return {
    core,
    prerelease: match[4] ? match[4].split('.') : [],
  };
};

const comparePrerelease = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a > b ? 1 : -1;
  }
  return left.length === right.length ? 0 : left.length > right.length ? 1 : -1;
};

/**
 * Compare two version strings in semver order. Returns 1 when `left` is
 * newer, -1 when it is older, and 0 when they match. Returns null when either
 * side is not a version the app can compare.
 */
export const compareVersions = (left: string, right: string): number | null => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] === b.core[index]) continue;
    return a.core[index] > b.core[index] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
};

export interface LatestRelease {
  tag: string;
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
}

/** Validate a GitHub release payload and keep only the fields the UI needs. */
export const parseLatestRelease = (payload: unknown): LatestRelease => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('GitHub returned an unexpected release payload.');
  }
  const release = payload as Record<string, unknown>;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag) throw new Error('GitHub did not return a release tag.');
  if (!parseVersion(tag)) {
    throw new Error(`GitHub's latest release tag “${tag}” is not a version.`);
  }
  const version = tag.replace(/^v/i, '');
  const htmlUrl =
    typeof release.html_url === 'string' &&
    release.html_url.startsWith(`${RELEASES_PAGE}/`)
      ? release.html_url
      : `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
  const name =
    typeof release.name === 'string' && release.name.trim()
      ? release.name.trim()
      : tag;
  const publishedAt =
    typeof release.published_at === 'string' ? release.published_at : null;
  return { tag, version, name, url: htmlUrl, publishedAt };
};

/**
 * Fetch the newest published (non-prerelease) GitHub release. Callers render
 * failures inline, so errors are short sentences suitable for the UI.
 */
export const fetchLatestRelease = async (
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        throw new Error('GitHub did not respond in time.');
      }
      throw new Error('Could not reach GitHub. Check the network connection.');
    }
    if (response.status === 404) {
      throw new Error('No published releases were found.');
    }
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub rate-limited the check. Try again later.');
    }
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        throw new Error('GitHub did not respond in time.');
      }
      throw new Error('GitHub returned a release feed that could not be read.');
    }
    return parseLatestRelease(payload);
  } finally {
    clearTimeout(timeout);
  }
};
