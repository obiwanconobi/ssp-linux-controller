import { ChevronLeft, ChevronRight, LogOut, Minus, Plus } from 'lucide-react';
import { BrandMark } from '../../components/Brand';
import { TunerGauge } from '../../components/kit/TunerGauge';
import { useAppStore } from '../../stores/useAppStore';

export const StageView = () => {
  const blocks = useAppStore((state) => state.blocks);
  const preset = useAppStore((state) => state.preset);
  const setPreset = useAppStore((state) => state.setPreset);
  const toggleBlock = useAppStore((state) => state.toggleBlock);
  const master = useAppStore((state) => state.master);
  const setMaster = useAppStore((state) => state.setMaster);
  const setView = useAppStore((state) => state.setView);
  const connection = useAppStore((state) => state.connection);
  const tuner = useAppStore((state) => state.tuner);
  const setTunerOpen = useAppStore((state) => state.setTunerOpen);

  const prev = () => {
    for (let offset = 1; offset <= preset.names.length; offset += 1) {
      const index = (preset.index - offset + preset.names.length) % preset.names.length;
      if (preset.names[index]?.trim()) {
        setPreset(index);
        return;
      }
    }
  };
  const next = () => {
    for (let offset = 1; offset <= preset.names.length; offset += 1) {
      const index = (preset.index + offset) % preset.names.length;
      if (preset.names[index]?.trim()) {
        setPreset(index);
        return;
      }
    }
  };

  const inTune = Math.abs(tuner.cents) <= 3;

  return (
    <div className="stage-view">
      <header className="stage-view__top">
        <div className="stage-brand">
          <BrandMark size={30} />
          <div>
            <span className="stage-brand__name">STOMPSTATION</span>
            <span className="stage-brand__sub">STAGE</span>
          </div>
        </div>
        <div className="stage-transport">
          <span className={`led ${connection.connected ? 'led--on' : 'led--off'}`} aria-hidden="true" />
          <span>{connection.connected ? 'USB · Connected' : 'Offline'}</span>
        </div>
        <button type="button" className="btn stage-exit" onClick={() => setView('board')}>
          <LogOut size={13} /> Exit stage
          <span className="kbd">Esc</span>
        </button>
      </header>

      <section className="stage-preset">
        <button type="button" className="stage-step" onClick={prev} aria-label="Previous preset">
          <ChevronLeft size={34} />
        </button>
        <div className="stage-preset__center">
          <span className="eyebrow">Current preset</span>
          <h1>{preset.current}</h1>
          <span className="stage-preset__meta mono">
            PRESET {String(preset.index + 1).padStart(2, '0')} / {preset.names.length} · SYNCED ·
            FIRMWARE {connection.firmware}
          </span>
        </div>
        <button type="button" className="stage-step" onClick={next} aria-label="Next preset">
          <ChevronRight size={34} />
        </button>
      </section>

      <section className="stage-tiles" aria-label="Bypass tiles">
        {blocks.map((block) => (
          <button
            key={block.id}
            type="button"
            className={`stage-tile${block.on ? ' stage-tile--on' : ''}`}
            aria-pressed={block.on}
            onClick={() => toggleBlock(block.id)}
          >
            <span className="stage-tile__top">
              <span className={`led ${block.on ? 'led--on' : 'led--off'}`} aria-hidden="true" />
              <span className="stage-tile__number mono">{block.footswitch}</span>
            </span>
            <span className="stage-tile__name">{block.shortName}</span>
            <span className="stage-tile__state mono">
              {block.on ? 'ON' : 'OFF'} · {block.model?.split(' ').slice(0, 2).join(' ') ?? 'IR'}
            </span>
          </button>
        ))}
        <button type="button" className="stage-tile stage-tile--action" onClick={() => setTunerOpen(true)}>
          <span className="stage-tile__top">
            <span className="led led--amber" aria-hidden="true" />
            <span className="stage-tile__number mono">TUNE</span>
          </span>
          <span className="stage-tile__name">TUNER</span>
          <span className="stage-tile__state mono">REF {tuner.reference} · INPUT 1</span>
        </button>
      </section>

      <section className="stage-bottom">
        <div className="stage-master panel">
          <div className="stage-master__head">
            <span className="eyebrow">Master volume</span>
            <span className="stage-master__value mono">{master.volume.toFixed(1)}</span>
          </div>
          <input
            type="range"
            className="stage-slider"
            min={0}
            max={100}
            step={0.5}
            value={master.volume}
            aria-label="Master volume"
            onChange={(event) => setMaster('volume', Number(event.target.value))}
          />
          <div className="stage-master__scale mono">
            <span>0</span>
            <span>50</span>
            <span>100</span>
          </div>
        </div>
        <div className="stage-tempo panel">
          <span className="eyebrow">Tempo</span>
          <div className="stage-tempo__readout">
            <strong className="mono">{master.tempo.toFixed(0)}</strong>
            <span>BPM</span>
          </div>
          <div className="stage-tempo__buttons">
            <button type="button" className="btn" aria-label="Lower tempo" onClick={() => setMaster('tempo', Math.max(20, master.tempo - 1))}>
              <Minus size={13} />
            </button>
            <button type="button" className="btn" aria-label="Raise tempo" onClick={() => setMaster('tempo', Math.min(300, master.tempo + 1))}>
              <Plus size={13} />
            </button>
          </div>
        </div>
        <button type="button" className="stage-tuner panel" onClick={() => setTunerOpen(true)}>
          <div className="stage-tuner__head">
            <span className="eyebrow">Tuner</span>
            <span className={`chip ${inTune ? 'chip--good' : ''}`}>{inTune ? 'IN TUNE' : 'INPUT 1'}</span>
          </div>
          <TunerGauge cents={tuner.cents} inTune={inTune} compact />
          <div className="stage-tuner__readout">
            <strong>{tuner.note}</strong>
            <span className="mono">
              {tuner.cents > 0 ? '+' : ''}
              {tuner.cents.toFixed(1)} cents · {tuner.frequency.toFixed(1)} Hz
            </span>
          </div>
          <span className="hint">REF {tuner.reference} · INPUT 1 · click for the full deck</span>
        </button>
      </section>

      <footer className="stage-view__foot">
        <span>Large targets · keyboard preset stepping · tuner engaged</span>
        <span className="mono">1–9 footswitches · [ ] presets · Space bypass · Esc exit</span>
      </footer>
    </div>
  );
};
