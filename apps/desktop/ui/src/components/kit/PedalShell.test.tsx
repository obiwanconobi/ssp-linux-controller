import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Block } from '../../types';
import { PedalShell } from './PedalShell';

const block = (overrides: Partial<Block>): Block => ({
  id: 'amp',
  label: 'Amp',
  shortName: 'AMP / NAM',
  family: 'amp',
  on: true,
  fixed: false,
  link: 'series',
  footswitch: 5,
  controls: [],
  groups: [],
  ...overrides,
});

const render = (value: Block, compact = false) =>
  renderToStaticMarkup(
    <PedalShell
      block={value}
      selected={false}
      pending={new Set()}
      onSelect={() => {}}
      onToggle={() => {}}
      onControlChange={() => {}}
      compact={compact}
    />,
  );

describe('PedalShell amp cabinet', () => {
  it('renders the inferred maker skin and cabinet parts', () => {
    const markup = render(block({ model: 'Marshall JCM800' }));
    expect(markup).toContain('pedal--amp-cabinet');
    expect(markup).toContain('data-amp-skin="marshall"');
    expect(markup).toContain('pedal__brand');
    expect(markup).toContain('>Marshall<');
    expect(markup).toContain('pedal__grille');
    expect(markup).toContain('pedal__handle');
  });

  it('falls back to the generic cabinet for unknown amps', () => {
    const markup = render(block({ model: 'Trainwreck Express' }));
    expect(markup).toContain('data-amp-skin="generic"');
    expect(markup).toContain('>AMP<');
  });

  it('uses the block label when the model name is empty', () => {
    const markup = render(block({ model: '', label: 'Amp · Vox AC30' }));
    expect(markup).toContain('data-amp-skin="vox"');
  });

  it('leaves non-amp blocks on the original shell', () => {
    const markup = render(
      block({
        id: 'drive',
        label: 'Drive · Klone 3',
        shortName: 'DRIVE',
        family: 'drive',
        model: 'Klone 3',
      }),
    );
    expect(markup).not.toContain('pedal--amp-cabinet');
    expect(markup).not.toContain('data-amp-skin');
    expect(markup).toContain('>DRIVE<');
  });

  it('keeps the compact amp cabinet but drops the knob row markup', () => {
    const markup = render(block({ model: 'Vox AC30' }), true);
    expect(markup).toContain('pedal--compact');
    expect(markup).toContain('data-amp-skin="vox"');
    expect(markup).toContain('pedal__grille');
    expect(markup).not.toContain('knob knob--sm');
  });
});
