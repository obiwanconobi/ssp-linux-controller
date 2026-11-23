import { Minus, Plus, Save, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import type { Control } from '../../types';
import { Knob } from './Knob';
import { LevelMeter } from './LevelMeter';

const asControl = (
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  unit = '',
): Control => ({
  id,
  name: id,
  label,
  kind: 'float',
  value,
  min,
  max,
  step,
  defaultValue,
  unit,
  decimals: step < 1 ? 1 : 0,
});

export const MasterStrip = () => {
  const master = useAppStore((state) => state.master);
  const setMaster = useAppStore((state) => state.setMaster);
  const edited = useAppStore((state) => state.save.edited);
  const saving = useAppStore((state) => state.save.saving);
  const savePreset = useAppStore((state) => state.savePreset);
  const meters = useAppStore((state) => state.meters);
  const uploads = useAppStore((state) => state.uploads);
  const connected = useAppStore((state) => state.connection.connected);
  const pending = new Set(useAppStore((state) => state.pending));

  const activeUploads = uploads.filter((upload) => upload.state === 'uploading').length;
  const presetLevelAvailable = master.presetLevelAvailable !== false;
  const presetLevelMin = master.presetLevelMin ?? -20;
  const presetLevelMax = master.presetLevelMax ?? 20;
  const presetLevelStep = master.presetLevelStep ?? 0.1;
  const setPresetLevel = (value: number) =>
    setMaster(
      'presetLevel',
      Math.min(presetLevelMax, Math.max(presetLevelMin, Number(value.toFixed(2)))),
    );

  return (
    <section className="master-strip panel" aria-label="Master controls">
      <div className="master-strip__title">
        <span className="eyebrow">Master</span>
        <span className="master-strip__sub mono">output</span>
      </div>
      <Knob
        control={asControl(
          'master.volume',
          'Volume',
          master.volume,
          master.volumeMin ?? 0,
          master.volumeMax ?? 100,
          1,
          72,
        )}
        size="lg"
        pending={pending.has('master.volume')}
        onChange={(value) => setMaster('volume', value)}
        format={(value) => value.toFixed(1)}
      />
      <div className="master-strip__divider" />
      <div className="master-strip__group">
        <span className="eyebrow">Preset level</span>
        <div className="stepper">
          <button
            type="button"
            className="stepper__btn"
            aria-label="Decrease preset level"
            disabled={!presetLevelAvailable}
            onClick={() => setPresetLevel(master.presetLevel - 0.5)}
          >
            <Minus size={11} />
          </button>
          <span
            className="stepper__value mono"
            role={presetLevelAvailable ? 'slider' : undefined}
            tabIndex={presetLevelAvailable ? 0 : undefined}
            aria-label="Preset level"
            aria-valuemin={presetLevelMin}
            aria-valuemax={presetLevelMax}
            aria-valuenow={master.presetLevel}
            aria-valuetext={`${master.presetLevel > 0 ? '+' : ''}${master.presetLevel.toFixed(1)} dB`}
            title={
              presetLevelAvailable
                ? 'Arrow keys step 0.1 dB · Page Up/Down step 1 dB'
                : 'Not exposed by this firmware'
            }
            onKeyDown={(event) => {
              if (!presetLevelAvailable) return;
              const step = event.shiftKey ? 1 : presetLevelStep;
              if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                event.preventDefault();
                setPresetLevel(master.presetLevel + step);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                event.preventDefault();
                setPresetLevel(master.presetLevel - step);
              } else if (event.key === 'PageUp') {
                event.preventDefault();
                setPresetLevel(master.presetLevel + 1);
              } else if (event.key === 'PageDown') {
                event.preventDefault();
                setPresetLevel(master.presetLevel - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setPresetLevel(presetLevelMin);
              } else if (event.key === 'End') {
                event.preventDefault();
                setPresetLevel(presetLevelMax);
              }
            }}
          >
            {presetLevelAvailable
              ? `${master.presetLevel > 0 ? '+' : ''}${master.presetLevel.toFixed(1)}`
              : '—'}
          </span>
          <button
            type="button"
            className="stepper__btn"
            aria-label="Increase preset level"
            disabled={!presetLevelAvailable}
            onClick={() => setPresetLevel(master.presetLevel + 0.5)}
          >
            <Plus size={11} />
          </button>
        </div>
      </div>
      <div className="master-strip__group master-strip__tempo">
        <span className="eyebrow">Tempo</span>
        <div className="tempo-readout">
          <span className="mono">{master.tempo.toFixed(0)}</span>
          <span className="tempo-readout__unit">BPM</span>
        </div>
        <div className="tempo-controls">
          <button
            type="button"
            className="stepper__btn"
            aria-label="Decrease tempo"
            onClick={() => setMaster('tempo', Math.max(master.tempoMin ?? 20, master.tempo - 1))}
          >
            <Minus size={11} />
          </button>
          <button
            type="button"
            className="stepper__btn"
            aria-label="Increase tempo"
            onClick={() => setMaster('tempo', Math.min(master.tempoMax ?? 300, master.tempo + 1))}
          >
            <Plus size={11} />
          </button>
        </div>
      </div>
      <div className="master-strip__meters">
        <LevelMeter input={meters.input} output={meters.output} active={connected} />
      </div>
      <div className="master-strip__actions">
        <button type="button" className="btn btn--sm" onClick={() => savePreset()} disabled={!edited}>
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
        {activeUploads > 0 && (
          <span className="chip chip--warn">
            <SlidersHorizontal size={10} /> {activeUploads} upload
          </span>
        )}
      </div>
    </section>
  );
};
