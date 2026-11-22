// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DeviceConflictBar } from './DeviceConflictBar';
import { useAppStore } from '../../stores/useAppStore';

describe('DeviceConflictBar', () => {
  it('renders the conflict and sends the chosen resolution', async () => {
    const resolve = vi.fn();
    useAppStore.setState({
      conflicts: [
        {
          id: 'drive.gain',
          kind: 'control',
          label: 'Gain',
          localValue: 7.2,
          deviceValue: 6.4,
          blockId: 'drive',
          controlId: 'drive.gain',
        },
      ],
      resolveConflict: resolve,
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DeviceConflictBar />));

    expect(container.textContent).toContain('Changed on device');
    expect(container.textContent).toContain('Gain');
    expect(container.textContent).toContain('device 6.40');
    expect(container.textContent).toContain('local 7.20');

    const buttons = container.querySelectorAll('button');
    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(resolve).toHaveBeenCalledWith('drive.gain', 'local');

    await act(async () => root.unmount());
    container.remove();
  });
});
