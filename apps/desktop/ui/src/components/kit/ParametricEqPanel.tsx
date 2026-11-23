import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { bandTypeLabel, formatGain, formatHz } from '../../lib/eq';
import {
  parametricEqModel,
  parametricEqType,
  parametricEqTypeOption,
} from '../../lib/parametricEq';
import { useAppStore } from '../../stores/useAppStore';
import type { Block, EqBand, EqBandType } from '../../types';
import { EqGraph, EQ_BAND_COLORS } from './EqGraph';

const TYPE_FALLBACK: EqBandType[] = ['LPS', 'LP', 'BP', 'HP', 'HPS'];

export const ParametricEqPanel = ({ block }: { block: Block }) => {
  const setControl = useAppStore((state) => state.setControl);
  const [selected, setSelected] = useState(1);
  const model = parametricEqModel(block);
  if (!model) return null;

  const selectedBand =
    model.bands.find((band) => band.index === selected) ?? model.bands[0];

  const updateBand = (index: number, patch: Partial<EqBand>) => {
    const band = model.bands.find((candidate) => candidate.index === index);
    if (!band) return;
    const deviceIndex = band.deviceIndex ?? index;
    if (patch.gain != null) {
      const control = model.gain[deviceIndex];
      if (control) setControl(control.id, patch.gain);
    }
    if (patch.frequency != null) {
      const control = model.frequency[deviceIndex];
      if (control) setControl(control.id, patch.frequency);
    }
    if (patch.q != null) {
      const control = model.q[deviceIndex];
      if (control) setControl(control.id, patch.q);
    }
    if (patch.type != null) {
      const control = model.type[deviceIndex];
      if (control) {
        setControl(
          control.id,
          parametricEqTypeOption(control, patch.type as EqBandType),
        );
      }
    }
  };

  const flatten = () => {
    for (const band of model.bands) {
      const deviceIndex = band.deviceIndex ?? band.index;
      const control = model.gain[deviceIndex];
      if (control) setControl(control.id, 0);
    }
  };

  return (
    <section className="parametric-eq" aria-label="Parametric EQ graph editor">
      <header className="eq-view__graph-head">
        <span className="section-title">
          <SlidersHorizontal size={13} /> Parametric EQ
        </span>
        <span className="hint">drag a band · scroll for Q · Page Up/Down fine Q</span>
        <button type="button" className="btn btn--sm" onClick={flatten}>
          <RotateCcw size={12} /> Flat
        </button>
      </header>

      <div className="eq-view__legend">
        {model.bands.map((band, index) => (
          <button
            key={band.index}
            type="button"
            className={`eq-legend${selectedBand?.index === band.index ? ' eq-legend--active' : ''}`}
            onClick={() => setSelected(band.index)}
          >
            <span
              className="eq-legend__dot"
              style={{ background: EQ_BAND_COLORS[index % EQ_BAND_COLORS.length] }}
            />
            {band.index} · {formatHz(band.frequency)}
          </button>
        ))}
      </div>

      <EqGraph
        bands={model.bands}
        selected={selectedBand?.index ?? 1}
        onSelect={setSelected}
        onChange={updateBand}
        ariaLabel="Parametric EQ response graph"
        minFrequency={model.minFrequency}
        maxFrequency={model.maxFrequency}
        maxGain={model.maxGain}
        minQ={model.minQ}
        maxQ={model.maxQ}
        className="eq-graph--parametric"
      />

      <div className="parametric-eq__cards">
        {model.bands.map((band, index) => {
          const deviceIndex = band.deviceIndex ?? band.index;
          const active = selectedBand?.index === band.index;
          const typeControl = model.type[deviceIndex];
          const typeOptions =
            typeControl?.options?.length ? typeControl.options : TYPE_FALLBACK;
          const color = EQ_BAND_COLORS[index % EQ_BAND_COLORS.length];
          return (
            <section
              key={band.index}
              className={`eq-band-card eq-band-card--compact${active ? ' eq-band-card--selected' : ''}`}
              style={{ '--band-color': color } as React.CSSProperties}
              onClick={() => setSelected(band.index)}
            >
              <header className="eq-band-card__head">
                <div className="eq-band-card__title-wrap">
                  <span className="eq-band-card__index" style={{ background: color }}>
                    {band.index}
                  </span>
                  <div>
                    <h2 className="eq-band-card__title">{bandTypeLabel(band.type)}</h2>
                    <span className="eq-band-card__sub mono">
                      {formatHz(band.frequency)}
                    </span>
                  </div>
                </div>
                <div className="eq-band-card__gain mono">{formatGain(band.gain)}</div>
              </header>
              <div className="eq-band-card__fields">
                <label className="eq-band-card__field">
                  <span className="field-label">Type</span>
                  <select
                    className="select"
                    value={String(typeControl?.value ?? typeOptions[0])}
                    aria-label={`Band ${band.index} type`}
                    onChange={(event) => {
                      if (typeControl) setControl(typeControl.id, event.target.value);
                    }}
                  >
                    {typeOptions.map((option) => (
                      <option key={option} value={option}>
                        {bandTypeLabel(parametricEqType(option))}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Frequency</span>
                  <input
                    className="input"
                    type="number"
                    min={model.minFrequency}
                    max={model.maxFrequency}
                    step={1}
                    value={Math.round(band.frequency)}
                    onChange={(event) =>
                      updateBand(band.index, {
                        frequency: Math.min(
                          model.maxFrequency,
                          Math.max(model.minFrequency, Number(event.target.value)),
                        ),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Gain</span>
                  <input
                    className="input"
                    type="number"
                    min={-model.maxGain}
                    max={model.maxGain}
                    step={0.1}
                    value={band.gain}
                    onChange={(event) =>
                      updateBand(band.index, {
                        gain: Math.min(
                          model.maxGain,
                          Math.max(-model.maxGain, Number(event.target.value)),
                        ),
                      })
                    }
                  />
                </label>
                <label className="eq-band-card__field">
                  <span className="field-label">Q</span>
                  <input
                    className="input"
                    type="number"
                    min={model.minQ}
                    max={model.maxQ}
                    step={0.05}
                    value={band.q}
                    onChange={(event) =>
                      updateBand(band.index, {
                        q: Math.min(
                          model.maxQ,
                          Math.max(model.minQ, Number(event.target.value)),
                        ),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
};
