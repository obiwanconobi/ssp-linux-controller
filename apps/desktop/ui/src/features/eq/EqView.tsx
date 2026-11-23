import { RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { EqGraph, EQ_BAND_COLORS } from '../../components/kit/EqGraph';
import { Knob } from '../../components/kit/Knob';
import { bandTypeLabel, formatGain, formatHz } from '../../lib/eq';
import { useAppStore } from '../../stores/useAppStore';
import type { EqBand, EqBandType } from '../../types';

const BAND_COLORS = EQ_BAND_COLORS;
const BAND_TYPES: EqBandType[] = ['LPS', 'BP', 'HPS', 'LP', 'HP'];

const typeLabel = bandTypeLabel;

interface Snapshot {
  bands: EqBand[];
}

export const EqView = () => {
  const bands = useAppStore((state) => state.eq);
  const eqEnabled = useAppStore((state) => state.eqEnabled);
  const setEqBand = useAppStore((state) => state.setEqBand);
  const setEqEnabled = useAppStore((state) => state.setEqEnabled);
  const flattenEq = useAppStore((state) => state.flattenEq);
  const notify = useAppStore((state) => state.notify);
  const [selected, setSelected] = useState(2);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const enabled = eqEnabled;

  const takeSnapshot = () => {
    setSnapshot({ bands: bands.map((band) => ({ ...band })) });
    notify('EQ snapshot captured', 'good');
  };

  const recallSnapshot = () => {
    if (!snapshot) {
      notify('No EQ snapshot yet', 'neutral');
      return;
    }
    snapshot.bands.forEach((band) => setEqBand(band.index, { ...band }));
    notify('EQ snapshot recalled', 'good');
  };

  return (
    <div className="eq-view">
      <header className="view-head eq-view__head">
        <div className="view-head__title">
          <span className="eyebrow">Output stage / global</span>
          <h1>Global EQ</h1>
          <span className="view-head__meta mono">4 bands · 48 kHz · RBJ biquads</span>
        </div>
        <div className="view-head__actions">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={enabled}
            onClick={() => setEqEnabled(!enabled)}
          >
            <span className="switch__track">
              <span className="switch__thumb" />
            </span>
            <span>{enabled ? 'Enabled' : 'Bypassed'}</span>
          </button>
          <button type="button" className="btn btn--sm" onClick={flattenEq}>
            <RotateCcw size={12} /> Flat
          </button>
          <button type="button" className="btn btn--sm" onClick={takeSnapshot}>
            <Sparkles size={12} /> Snapshot
          </button>
          <button type="button" className="btn btn--sm" onClick={recallSnapshot} disabled={!snapshot}>
            Recall
          </button>
        </div>
      </header>

      <section className="eq-view__graph-card panel">
        <header className="eq-view__graph-head">
          <span className="section-title">
            <SlidersHorizontal size={13} /> Response
          </span>
          <span className="hint">click a band · drag to shape · scroll for Q</span>
          <div className="eq-view__legend">
            {bands.map((band) => (
              <button
                key={band.index}
                type="button"
                className={`eq-legend${selected === band.index ? ' eq-legend--active' : ''}`}
                onClick={() => setSelected(band.index)}
              >
                <span className="eq-legend__dot" style={{ background: BAND_COLORS[band.index - 1] }} />
                {band.index} · {formatHz(band.frequency)}
              </button>
            ))}
          </div>
        </header>

        <EqGraph
          bands={bands}
          selected={selected}
          onSelect={setSelected}
          onChange={(index, patch) => setEqBand(index, patch)}
          ariaLabel="Global EQ response graph"
        />
      </section>

      <div className="eq-view__cards">
        {bands.map((band, index) => {
          const active = selected === band.index;
          return (
            <section
              key={band.index}
              className={`eq-band-card${active ? ' eq-band-card--selected' : ''}`}
              style={{ '--band-color': BAND_COLORS[index] } as React.CSSProperties}
              onClick={() => setSelected(band.index)}
            >
              <header className="eq-band-card__head">
                <div className="eq-band-card__title-wrap">
                  <span
                    className="eq-band-card__index"
                    style={{ background: BAND_COLORS[index] }}
                  >
                    {band.index}
                  </span>
                  <div>
                    <h2 className="eq-band-card__title">{typeLabel(band.type)}</h2>
                    <span className="eq-band-card__sub mono">{formatHz(band.frequency)}</span>
                  </div>
                </div>
                <div className="eq-band-card__gain mono">{formatGain(band.gain)}</div>
              </header>
              <div className="eq-band-card__fields">
                <label className="eq-band-card__field">
                  <span className="field-label">Type</span>
                  <select
                    className="select"
                    value={band.type}
                    onChange={(event) =>
                      setEqBand(band.index, { type: event.target.value as EqBandType })
                    }
                  >
                    {BAND_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {typeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Frequency</span>
                  <input
                    className="input"
                    type="number"
                    min={20}
                    max={20000}
                    step={10}
                    value={Math.round(band.frequency)}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        frequency: Math.min(20000, Math.max(20, Number(event.target.value))),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Gain</span>
                  <input
                    className="input"
                    type="number"
                    min={-15}
                    max={15}
                    step={0.1}
                    value={band.gain}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        gain: Math.min(15, Math.max(-15, Number(event.target.value))),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Q</span>
                  <input
                    className="input"
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.05}
                    value={band.q}
                    onChange={(event) =>
                      setEqBand(band.index, {
                        q: Math.min(10, Math.max(0.1, Number(event.target.value))),
                      })
                    }
                  />
                </label>
              </div>
              <div className="eq-band-card__knobs">
                <Knob
                  control={{
                    id: `eq.${band.index}.gain`,
                    name: 'gain',
                    label: 'Gain',
                    kind: 'float',
                    value: band.gain,
                    min: -15,
                    max: 15,
                    step: 0.1,
                    defaultValue: 0,
                    unit: 'dB',
                  }}
                  size="md"
                  color={BAND_COLORS[index]}
                  onChange={(value) => setEqBand(band.index, { gain: value })}
                />
                <Knob
                  control={{
                    id: `eq.${band.index}.q`,
                    name: 'q',
                    label: 'Q',
                    kind: 'float',
                    value: band.q,
                    min: 0.1,
                    max: 10,
                    step: 0.05,
                    defaultValue: 0.7,
                  }}
                  size="md"
                  color={BAND_COLORS[index]}
                  onChange={(value) => setEqBand(band.index, { q: value })}
                  format={(value) => value.toFixed(2)}
                />
              </div>
            </section>
          );
        })}
      </div>
      <p className="eq-view__foot hint">
        Global EQ lives on the output stage. It is not a per-preset effect; every preset hears it.
        Bypass preserves settings. Flatten is undoable.
      </p>
    </div>
  );
};
