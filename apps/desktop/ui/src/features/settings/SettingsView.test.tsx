// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const latestRelease = {
  tag: 'v9.9.9',
  version: '9.9.9',
  name: 'StompStation v9.9.9',
  url: 'https://github.com/obiwanconobi/ssp-linux-controller/releases/tag/v9.9.9',
  publishedAt: '2026-12-01T10:00:00Z',
};

vi.mock('../../lib/updates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/updates')>();
  return {
    ...actual,
    fetchLatestRelease: vi.fn(async () => latestRelease),
  };
});

const { SettingsView } = await import('./SettingsView');
const { useAppStore } = await import('../../stores/useAppStore');

const click = async (element: Element | undefined) => {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('SettingsView updates card', () => {
  beforeEach(() => {
    useAppStore.setState({ appVersion: '0.6.1' });
  });

  it('announces a newer published release when About opens', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<SettingsView />));

    const about = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('About'),
    );
    await click(about);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Update available');
    expect(container.textContent).toContain('v9.9.9 is available');
    expect(container.textContent).toContain('Installedv0.6.1');
    expect(container.textContent).toContain('Latest releasev9.9.9');

    await act(async () => root.unmount());
    container.remove();
  });
});
