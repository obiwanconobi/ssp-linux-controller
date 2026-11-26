import { describe, expect, it } from 'vitest';
import { librarySlotStatus } from './libraryStatus';

describe('library slot status', () => {
  it('reports an empty slot as free', () => {
    expect(librarySlotStatus({ used: false, active: false })).toBe('free');
  });

  it('reports an occupied slot with no preset references as loaded', () => {
    expect(librarySlotStatus({ used: true, active: false, usedBy: [] })).toBe('loaded');
  });

  it('reports a preset-referenced slot as in use', () => {
    expect(librarySlotStatus({ used: true, active: false, usedBy: [3] })).toBe('in-use');
  });

  it('lets the live chain win over preset references', () => {
    expect(librarySlotStatus({ used: true, active: true, usedBy: [3] })).toBe('active');
    expect(librarySlotStatus({ used: true, active: true })).toBe('active');
  });

  it('keeps an empty slot free even if a stale reference is present', () => {
    expect(librarySlotStatus({ used: false, active: false, usedBy: [3] })).toBe('free');
  });
});
