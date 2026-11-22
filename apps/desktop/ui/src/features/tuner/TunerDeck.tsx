import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { TunerGauge } from '../../components/kit/TunerGauge';

export const TunerDeck = () => {
  const open = useAppStore((state) => state.tunerOpen);
  const setOpen = useAppStore((state) => state.setTunerOpen);
  const tuner = useAppStore((state) => state.tuner);
  const preset = useAppStore((state) => state.preset);
  const setTuner = useAppStore((state) => state.setTuner);
  if (!open) return null;

  if (!tuner.available) {
    return (
      <section className="tuner-deck panel" aria-label="Tuner">
        <header className="tuner-deck__head">
          <div>
            <span className="eyebrow">Tuner deck</span>
            <h2>{preset.current}</h2>
          </div>
          <div className="tuner-deck__nav">
            <span className="chip chip--warn">UNAVAILABLE</span>
            <button type="button" className="btn btn--sm" onClick={() => setOpen(false)}>
              <X size={12} /> Close
            </button>
          </div>
        </header>
        <div className="tuner-deck__body tuner-deck__body--unavailable">
          <strong>Tuner unavailable</strong>
          <p className="hint">
            {tuner.message ?? 'This firmware does not expose a tuner.'} The rest of the
            board is unaffected.
          </p>
        </div>
        <footer className="tuner-deck__foot">
          <span className="hint">No tuner writes were sent.</span>
          <span className="mono">T to toggle · Esc to close</span>
        </footer>
      </section>
    );
  }

  const inTune = Math.abs(tuner.cents) <= 3;

  return (
    <section className="tuner-deck panel" aria-label="Tuner">
      <header className="tuner-deck__head">
        <div>
          <span className="eyebrow">Tuner deck</span>
          <h2>{preset.current}</h2>
        </div>
        <div className="tuner-deck__nav">
          <span className="chip">{inTune ? 'IN TUNE' : tuner.cents < 0 ? 'FLAT' : 'SHARP'}</span>
          <button type="button" className="btn btn--sm" onClick={() => setOpen(false)}>
            <X size={12} /> Close
          </button>
        </div>
      </header>
      <div className="tuner-deck__body">
        <TunerGauge cents={tuner.cents} inTune={inTune} />
        <div className="tuner-deck__readout">
          <div className="tuner-note">
            <span>{tuner.note}</span>
            <span className={`tuner-cents${inTune ? ' tuner-in-tune' : ''}`}>
              {tuner.cents > 0 ? '+' : ''}
              {tuner.cents.toFixed(1)} cents
            </span>
          </div>
          <div className="tuner-deck__numbers">
            <div>
              <span className="eyebrow">Frequency</span>
              <strong className="mono">{tuner.frequency.toFixed(1)} Hz</strong>
            </div>
            <div>
              <span className="eyebrow">Reference</span>
              <strong className="mono">{tuner.reference} Hz</strong>
            </div>
            <div>
              <span className="eyebrow">Input</span>
              <strong className="mono">{tuner.level.toFixed(0)} dB</strong>
            </div>
          </div>
          <div className="tuner-reference">
            <span className="field-label">Reference</span>
            <div className="stepper">
              <button
                type="button"
                className="stepper__btn"
                aria-label="Lower reference pitch"
                onClick={() => setTuner({ reference: Math.max(430, tuner.reference - 1) })}
              >
                <ChevronLeft size={11} />
              </button>
              <span className="stepper__value mono">{tuner.reference} Hz</span>
              <button
                type="button"
                className="stepper__btn"
                aria-label="Raise reference pitch"
                onClick={() => setTuner({ reference: Math.min(450, tuner.reference + 1) })}
              >
                <ChevronRight size={11} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <footer className="tuner-deck__foot">
        <span className="hint">Opening the tuner writes the device tuner state; closing restores it.</span>
        <span className="mono">T to toggle · Esc to close</span>
      </footer>
    </section>
  );
};
