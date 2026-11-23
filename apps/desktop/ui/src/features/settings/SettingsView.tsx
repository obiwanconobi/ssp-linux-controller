import * as Dialog from '@radix-ui/react-dialog';
import {
  Cable,
  Check,
  Copy,
  Cpu,
  Info,
  Keyboard,
  Palette,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Speaker,
  Usb,
  Wifi,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Knob } from '../../components/kit/Knob';
import { ipcErrorMessage, isMobileRuntime, isTauriRuntime, tauriClient } from '../../ipc/client';
import type { DiscoveredDevice, PortInfo } from '../../ipc/client';
import { THEMES } from '../../theme/themes';
import { useAppStore } from '../../stores/useAppStore';
import type { Density, Motion } from '../../types';

type Section = 'connection' | 'audio' | 'appearance' | 'editor' | 'diagnostics' | 'about';

const SECTIONS: Array<{ id: Section; label: string; detail: string; icon: typeof Cable }> = [
  { id: 'connection', label: 'Connection', detail: 'transport & discovery', icon: Cable },
  { id: 'audio', label: 'Audio & pedal', detail: 'input, CTRL, USB', icon: Speaker },
  { id: 'appearance', label: 'Appearance', detail: 'theme, density, motion', icon: Palette },
  { id: 'editor', label: 'Editor', detail: 'knobs, links, save state', icon: SlidersHorizontal },
  { id: 'diagnostics', label: 'Diagnostics', detail: 'USB, logs, support', icon: Cpu },
  { id: 'about', label: 'About', detail: 'version, licenses', icon: Info },
];

const DEMO_PORTS: PortInfo[] = [
  {
    device: '/dev/ttyACM0',
    description: 'StompStation · CDC-ACM',
    usb: true,
    vendor_id: '1d6b',
    product_id: '0104',
  },
];

const DEMO_NETWORK: DiscoveredDevice[] = [
  {
    service: 'StompStation PRO._http._tcp.local',
    name: 'StompStation PRO',
    host: '192.168.1.97',
    port: 8080,
    mac: '88:A2:9E:9E:5D:7F',
    valid: true,
  },
];

const Toggle = ({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    className="switch settings-toggle"
    aria-checked={value}
    onClick={() => onChange(!value)}
  >
    <span className="switch__track">
      <span className="switch__thumb" />
    </span>
    <span>{label}</span>
  </button>
);

const MiniControl = ({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}) => {
  const [local, setLocal] = useState(value);
  return (
    <div className="settings-knob">
      <Knob
        control={{
          id,
          name: id,
          label,
          kind: 'float',
          value: local,
          min,
          max,
          step,
          defaultValue: value,
          unit,
        }}
        size="md"
        onChange={setLocal}
      />
    </div>
  );
};

export const SettingsView = () => {
  const [section, setSection] = useState<Section>('connection');
  // Android (and iOS) builds have no USB serial transport; the connection
  // sheet already hides it, so keep Settings on the Wi-Fi path too.
  const mobile = isMobileRuntime();
  const theme = useAppStore((state) => state.theme);
  const density = useAppStore((state) => state.density);
  const motion = useAppStore((state) => state.motion);
  const compactChain = useAppStore((state) => state.compactChain);
  const setTheme = useAppStore((state) => state.setTheme);
  const setDensity = useAppStore((state) => state.setDensity);
  const setMotion = useAppStore((state) => state.setMotion);
  const setCompactChain = useAppStore((state) => state.setCompactChain);
  const connection = useAppStore((state) => state.connection);
  const input = useAppStore((state) => state.input);
  const setInputGain = useAppStore((state) => state.setInputGain);
  const setConnectionOpen = useAppStore((state) => state.setConnectionOpen);
  const notify = useAppStore((state) => state.notify);
  const copyDiagnostics = useAppStore((state) => state.copyDiagnostics);
  const appVersion = useAppStore((state) => state.appVersion);
  const activity = useAppStore((state) => state.activity);
  const [transport, setTransport] = useState<'usb' | 'network'>(mobile ? 'network' : 'usb');
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectLaunch, setReconnectLaunch] = useState(true);
  const [alias, setAlias] = useState('Studio board');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const connectReal = useAppStore((state) => state.connectReal);
  const disconnect = useAppStore((state) => state.disconnect);
  const tauri = isTauriRuntime();
  const [ports, setPorts] = useState<PortInfo[]>(tauri ? [] : DEMO_PORTS);
  const [selectedPort, setSelectedPort] = useState(tauri ? '' : DEMO_PORTS[0].device);
  const [networkDevices, setNetworkDevices] = useState<DiscoveredDevice[]>(
    tauri ? [] : DEMO_NETWORK,
  );
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [manualAddress, setManualAddress] = useState('');

  const scanDevices = async (announce = true) => {
    if (!tauri) {
      if (announce) notify('The browser preview uses the built-in demo device list.', 'neutral');
      return;
    }
    setScanning(true);
    try {
      const [portResult, wifiResult] = await Promise.allSettled([
        tauriClient.listPorts(),
        tauriClient.discoverWifi(),
      ]);
      if (portResult.status === 'fulfilled') {
        const found = portResult.value;
        setPorts(found);
        setSelectedPort((current) =>
          found.some((port) => port.device === current) ? current : found[0]?.device ?? '',
        );
      }
      if (wifiResult.status === 'fulfilled') setNetworkDevices(wifiResult.value);
      if (announce) {
        const usb = portResult.status === 'fulfilled' ? portResult.value.length : 0;
        const wifi = wifiResult.status === 'fulfilled' ? wifiResult.value.length : 0;
        const total = usb + wifi;
        notify(
          total
            ? `Discovery: ${wifi} Wi-Fi · ${usb} USB port${usb === 1 ? '' : 's'}`
            : 'No pedal found over mDNS or USB',
          total ? 'good' : 'warn',
        );
      }
    } catch (error) {
      if (announce) notify(ipcErrorMessage(error), 'bad');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (section !== 'connection' || !tauri) return;
    void scanDevices(false);
    // Re-scan when the connection panel opens; scanDevices is intentionally
    // not a dependency because it closes over notify only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tauri]);

  const connectTarget = async (target: string) => {
    if (!tauri) {
      notify('The browser preview uses the simulator. Open the Tauri shell to use USB or TCP.', 'neutral');
      return;
    }
    setConnecting(true);
    try {
      await connectReal(target);
    } finally {
      setConnecting(false);
    }
  };

  const manualTarget = manualAddress
    .trim()
    .replace(/^tcp:\/\//i, '')
    .replace(/^tcp:/i, '');

  const diagnosticText = [
    `app      ${appVersion ? `v${appVersion}` : 'dev'}`,
    `mode     ${connection.mode}`,
    `transport ${connection.transport}`,
    `address  ${connection.address || '—'}`,
    `device   ${connection.deviceName}`,
    `firmware ${connection.firmware || '—'}`,
    `poll     ${connection.pollMs} ms · ${connection.lastPollMs.toFixed(1)} ms last`,
    `state    ${connection.connected ? 'connected' : 'offline'}`,
    connection.error ? `error    ${connection.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="settings-view">
      <header className="view-head settings-view__head">
        <div className="view-head__title">
          <span className="eyebrow">Preferences / device / diagnostics</span>
          <h1>Settings</h1>
          <span className="view-head__meta mono">
            {connection.deviceName} · firmware {connection.firmware}
          </span>
        </div>
        <div className="view-head__actions">
          <span className={`chip ${connection.connected ? 'chip--good' : 'chip--warn'}`}>
            {connection.connected ? 'Connected' : 'Offline'}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => setConnectionOpen(true)}>
            <Cable size={12} /> Connection sheet
          </button>
        </div>
      </header>

      <div className="settings-view__grid">
        <nav className="settings-nav panel" aria-label="Settings sections">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`settings-nav__item${section === item.id ? ' settings-nav__item--active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <Icon size={15} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            );
          })}
          <div className="settings-nav__foot">
            <span className="led led--on" aria-hidden="true" />
            <span className="mono">{connection.transport}</span>
          </div>
        </nav>

        <div className="settings-panel">
          {section === 'connection' && (
            <>
              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Connection</h2>
                    <p className="hint">Choose how the app reaches the pedal.</p>
                  </div>
                  <span className="chip chip--good">{mobile ? 'Wi-Fi' : 'USB preferred'}</span>
                </header>
                {!mobile && (
                  <div className="segmented settings-transport" role="group" aria-label="Transport">
                    <button type="button" aria-pressed={transport === 'usb'} onClick={() => setTransport('usb')}>
                      <Usb size={12} /> USB
                    </button>
                    <button
                      type="button"
                      aria-pressed={transport === 'network'}
                      onClick={() => setTransport('network')}
                    >
                      <Wifi size={12} /> Network
                    </button>
                  </div>
                )}
                {transport === 'usb' && !mobile ? (
                  <div className="settings-rows">
                    <div className="settings-row settings-row--stack">
                      <div>
                        <strong>Serial port</strong>
                        <span className="hint">CDC-ACM · 115200 baud</span>
                      </div>
                      <div className="settings-inline">
                        <select
                          className="select"
                          aria-label="Serial port"
                          value={selectedPort}
                          onChange={(event) => setSelectedPort(event.target.value)}
                        >
                          {ports.length === 0 ? (
                            <option value="">No serial ports found</option>
                          ) : (
                            ports.map((port) => (
                              <option key={port.device} value={port.device}>
                                {port.device} — {port.description}
                              </option>
                            ))
                          )}
                        </select>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void scanDevices()}
                          disabled={scanning || connecting}
                          aria-label="Rescan serial ports"
                        >
                          <RefreshCw size={12} className={scanning ? 'spin' : undefined} />
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={!selectedPort || connecting || connection.connected}
                          onClick={() => void connectTarget(`serial:${selectedPort}`)}
                        >
                          {connecting ? 'Connecting…' : 'Connect'}
                        </button>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div>
                        <strong>Auto-reconnect</strong>
                        <span className="hint">Retry with backoff after unplug</span>
                      </div>
                      <Toggle label="Enabled" value={autoReconnect} onChange={setAutoReconnect} />
                    </div>
                    <div className="settings-row">
                      <div>
                        <strong>Reconnect on launch</strong>
                        <span className="hint">Remember the last device</span>
                      </div>
                      <Toggle label="Enabled" value={reconnectLaunch} onChange={setReconnectLaunch} />
                    </div>
                  </div>
                ) : (
                  <div className="settings-rows">
                    <div className="settings-row">
                      <div>
                        <strong>Network discovery</strong>
                        <span className="hint">mDNS · _http._tcp · voidx</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => void scanDevices()}
                        disabled={scanning || connecting}
                      >
                        <RefreshCw size={12} className={scanning ? 'spin' : undefined} />
                        {scanning ? 'Scanning…' : 'Scan'}
                      </button>
                    </div>
                    {networkDevices.length === 0 ? (
                      <p className="settings-note">
                        {scanning
                          ? 'Scanning Wi-Fi for _http._tcp devices…'
                          : 'No Wi-Fi pedal answered mDNS. Enter an address below, or connect over USB.'}
                      </p>
                    ) : (
                      networkDevices.map((device) => (
                        <button
                          key={device.service}
                          type="button"
                          className="discovered-device"
                          disabled={connecting || connection.connected}
                          onClick={() =>
                            void connectTarget(`tcp:${device.host}:${device.port}`)
                          }
                        >
                          <span
                            className={`led ${device.valid ? 'led--on' : 'led--off'}`}
                            aria-hidden="true"
                          />
                          <span>
                            <strong>{device.name}</strong>
                            <small>
                              {device.valid ? 'VoidX · mDNS' : 'Not a VoidX device'}
                              {device.mac ? ` · ${device.mac}` : ''}
                            </small>
                          </span>
                          <span className="mono">{device.host}:{device.port}</span>
                        </button>
                      ))
                    )}
                    <form
                      className="settings-inline"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (manualTarget) void connectTarget(`tcp:${manualTarget}`);
                      }}
                    >
                      <label className="field-label" htmlFor="manual-tcp">
                        Manual TCP
                      </label>
                      <input
                        id="manual-tcp"
                        className="input input--mono"
                        placeholder="192.168.1.97:8080"
                        value={manualAddress}
                        onChange={(event) => setManualAddress(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="btn btn--sm btn--primary"
                        disabled={!manualTarget || connecting || connection.connected}
                      >
                        {connecting ? 'Connecting…' : 'Connect'}
                      </button>
                    </form>
                  </div>
                )}
              </section>

              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Device</h2>
                    <p className="hint">Identity and alias.</p>
                  </div>
                  <span className="chip">{connection.firmware}</span>
                </header>
                <dl className="settings-meta">
                  <div>
                    <dt>Model</dt>
                    <dd>StompStation PRO</dd>
                  </div>
                  <div>
                    <dt>Device</dt>
                    <dd>{connection.deviceName || 'StompStation PRO'}</dd>
                  </div>
                  <div>
                    <dt>Firmware</dt>
                    <dd className="mono">{connection.firmware || '—'}</dd>
                  </div>
                  <div>
                    <dt>Transport</dt>
                    <dd className="mono">{connection.transport || '—'}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd className="mono">{connection.address || '—'}</dd>
                  </div>
                </dl>
                <div className="settings-row" style={{ marginTop: 10 }}>
                  <div>
                    <strong>{connection.connected ? 'Connected' : 'Offline'}</strong>
                    <span className="hint">
                      {connection.connected
                        ? connection.address || connection.transport
                        : 'No active session'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={!connection.connected}
                    onClick={() => disconnect()}
                  >
                    Disconnect
                  </button>
                </div>
                <div className="settings-inline">
                  <label className="field-label" htmlFor="device-alias">Alias</label>
                  <input
                    id="device-alias"
                    className="input"
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                  />
                  <button type="button" className="btn btn--sm" onClick={() => notify(`Alias set to “${alias}”`, 'good')}>
                    Save alias
                  </button>
                </div>
                <div className="danger-zone">
                  <div>
                    <strong>Factory reset</strong>
                    <span className="hint">Erases presets, captures, and device settings.</span>
                  </div>
                  <button type="button" className="btn btn--danger btn--sm" onClick={() => setResetOpen(true)}>
                    <ShieldAlert size={12} /> Reset…
                  </button>
                </div>
              </section>

              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>USB diagnostics</h2>
                    <p className="hint">Ported from the current client — explain failure, don't hide it.</p>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => copyDiagnostics()}>
                    <Copy size={12} /> Copy report
                  </button>
                </header>
                <pre className="code-block">{diagnosticText}</pre>
                <p className="settings-note">
                  If the pedal appears in sysfs but no <span className="mono">/dev/ttyACM*</span> exists, the
                  <span className="mono"> cdc_acm</span> module is missing or not bound. Reboot into the
                  installed kernel or load the module, then re-scan.
                </p>
              </section>
            </>
          )}

          {section === 'audio' && (
            <section className="settings-card panel">
              <header className="settings-card__head">
                <div>
                  <h2>Audio & pedal</h2>
                  <p className="hint">Input gains write the pedal; connection state is display-only.</p>
                </div>
                <span className="chip">Global</span>
              </header>
              <div className="settings-knobs">
                {input.gain1 ? (
                  <div className="settings-knob">
                    <Knob
                      control={input.gain1}
                      size="md"
                      onChange={(value) => setInputGain(1, value)}
                      format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`}
                    />
                  </div>
                ) : (
                  <div className="settings-knob settings-knob--missing">
                    <span className="field-label">In 1 digital gain</span>
                    <span className="hint">Not exposed by this firmware</span>
                  </div>
                )}
                {input.gain2 ? (
                  <div className="settings-knob">
                    <Knob
                      control={input.gain2}
                      size="md"
                      onChange={(value) => setInputGain(2, value)}
                      format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`}
                    />
                  </div>
                ) : (
                  <div className="settings-knob settings-knob--missing">
                    <span className="field-label">In 2 digital gain</span>
                    <span className="hint">Not exposed by this firmware</span>
                  </div>
                )}
                <MiniControl id="ctrl.min" label="EXP min" value={0} min={0} max={100} step={1} />
                <MiniControl id="ctrl.max" label="EXP max" value={100} min={0} max={100} step={1} />
                <MiniControl id="phones" label="Headphones" value={70} min={0} max={100} step={1} />
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div>
                    <strong>In 1 connection</strong>
                    <span className="hint">Read-only · firmware reports the jack state</span>
                  </div>
                  <span
                    className={`chip ${input.connected1 ? 'chip--good' : ''}`}
                    aria-label={`Input 1 connection: ${
                      input.connected1 == null
                        ? 'unknown'
                        : input.connected1
                          ? 'connected'
                          : 'not connected'
                    }`}
                  >
                    {input.connected1 == null
                      ? 'Unknown'
                      : input.connected1
                        ? 'Connected'
                        : 'No signal'}
                  </span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>In 2 connection</strong>
                    <span className="hint">Read-only · never written by the app</span>
                  </div>
                  <span
                    className={`chip ${input.connected2 ? 'chip--good' : ''}`}
                    aria-label={`Input 2 connection: ${
                      input.connected2 == null
                        ? 'unknown'
                        : input.connected2
                          ? 'connected'
                          : 'not connected'
                    }`}
                  >
                    {input.connected2 == null
                      ? 'Unknown'
                      : input.connected2
                        ? 'Connected'
                        : 'No signal'}
                  </span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>Ground lift</strong>
                    <span className="hint">Breaks the USB shield ground</span>
                  </div>
                  <Toggle label="On" value={false} onChange={() => notify('Ground lift toggled (demo)', 'neutral')} />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>USB audio mode</strong>
                    <span className="hint">Class-compliant 48 kHz interface</span>
                  </div>
                  <select className="select" defaultValue="48 kHz / 24-bit">
                    <option>48 kHz / 24-bit</option>
                    <option>44.1 kHz / 24-bit</option>
                  </select>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>MIDI over USB</strong>
                    <span className="hint">Program changes and CC control</span>
                  </div>
                  <Toggle label="Enabled" value onChange={() => notify('MIDI toggled (demo)', 'neutral')} />
                </div>
              </div>
            </section>
          )}

          {section === 'appearance' && (
            <>
              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Theme</h2>
                    <p className="hint">Validated token files. No arbitrary CSS, no remote assets.</p>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => setTheme('studio')}>
                    <RotateCcw size={12} /> Reset to Studio Black
                  </button>
                </header>
                <div className="theme-grid">
                  {THEMES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`theme-card${theme === item.id ? ' theme-card--active' : ''}`}
                      onClick={() => setTheme(item.id)}
                      aria-pressed={theme === item.id}
                    >
                      <span className="theme-card__preview" style={{ background: item.swatches[0] }}>
                        <span className="theme-card__panel" style={{ background: item.swatches[1] }}>
                          <span style={{ background: item.swatches[2] }} />
                          <span style={{ background: item.swatches[3] }} />
                          <span style={{ background: item.swatches[4] }} />
                        </span>
                        <span className="theme-card__pedal" style={{ background: item.chassis }} />
                      </span>
                      <span className="theme-card__body">
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      {theme === item.id && <Check size={14} className="theme-card__check" />}
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Layout & motion</h2>
                    <p className="hint">Local preferences. Never writes device state.</p>
                  </div>
                </header>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div>
                      <strong>Density</strong>
                      <span className="hint">Comfortable keeps stage-sized targets</span>
                    </div>
                    <div className="segmented">
                      {(['comfortable', 'compact'] as Density[]).map((value) => (
                        <button key={value} type="button" aria-pressed={density === value} onClick={() => setDensity(value)}>
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>Motion</strong>
                      <span className="hint">Reduced removes non-essential animation</span>
                    </div>
                    <div className="segmented">
                      {(['full', 'reduced'] as Motion[]).map((value) => (
                        <button key={value} type="button" aria-pressed={motion === value} onClick={() => setMotion(value)}>
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>Compact chain</strong>
                      <span className="hint">
                        Two knobs per pedal and a model-only amp plate for long chains
                      </span>
                    </div>
                    <div className="segmented">
                      <button type="button" aria-pressed={compactChain} onClick={() => setCompactChain(true)}>
                        On
                      </button>
                      <button type="button" aria-pressed={!compactChain} onClick={() => setCompactChain(false)}>
                        Off
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === 'editor' && (
            <section className="settings-card panel">
              <header className="settings-card__head">
                <div>
                  <h2>Editor</h2>
                  <p className="hint">Shell knob maps are a UI decision, stored per block type.</p>
                </div>
                <span className="chip">Auto map</span>
              </header>
              <div className="settings-table">
                <div className="settings-table__head">
                  <span>Block family</span>
                  <span>Knob 1</span>
                  <span>Knob 2</span>
                  <span>Knob 3</span>
                </div>
                {[
                  ['Drive', 'Gain', 'Tone', 'Volume'],
                  ['Amp (NAM)', 'Gain', 'Bass', 'Treble'],
                  ['Compressor', 'Threshold', 'Ratio', 'Level'],
                  ['Noise gate', 'Threshold', 'Decay', '—'],
                  ['Delay', 'Time', 'Feedback', 'Mix'],
                  ['Reverb', 'Mix', 'Decay', 'Pre-delay'],
                  ['Modulation', 'Rate', 'Depth', 'Mix'],
                  ['Cabinet', 'Level', 'Blend', 'Low cut'],
                ].map((row) => (
                  <div className="settings-table__row" key={row[0]}>
                    {row.map((cell) => (
                      <span key={cell}>{cell}</span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="settings-row" style={{ marginTop: 16 }}>
                <div>
                  <strong>Reset all knob overrides</strong>
                  <span className="hint">Return every shell to the authored priority map.</span>
                </div>
                <button type="button" className="btn btn--sm" onClick={() => notify('Knob map reset to auto', 'good')}>
                  <RotateCcw size={12} /> Reset
                </button>
              </div>
              <p className="settings-note">
                A block with two eligible continuous parameters gets two knobs. Model and IR selectors
                never become knobs. Overrides are settings, not preset data.
              </p>
            </section>
          )}

          {section === 'diagnostics' && (
            <>
              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Diagnostics</h2>
                    <p className="hint">USB, kernel module, poll timing, and the recent log.</p>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => copyDiagnostics()}>
                    <Copy size={12} /> Copy report
                  </button>
                </header>
                <pre className="code-block">{diagnosticText}</pre>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div>
                      <strong>Poll cadence</strong>
                      <span className="hint">read root every 500 ms; browse every 2 s on TCP</span>
                    </div>
                    <span className="mono">{connection.pollMs} ms</span>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>Last reply</strong>
                      <span className="hint">Median over the last 20 requests</span>
                    </div>
                    <span className="mono">{connection.lastPollMs.toFixed(1)} ms</span>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>Activity history</strong>
                      <span className="hint">In-memory session log · newest 80 entries · no payloads</span>
                    </div>
                    <span className="mono">{activity.length} entries</span>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>Crash reports</strong>
                      <span className="hint">
                        Off · no telemetry is sent; use Copy report to share manually
                      </span>
                    </div>
                    <span className="chip">Off</span>
                  </div>
                </div>
              </section>
              <section className="settings-card panel">
                <header className="settings-card__head">
                  <div>
                    <h2>Activity log</h2>
                    <p className="hint">The same entries as the utility rail, with full history.</p>
                  </div>
                  <Keyboard size={15} />
                </header>
                <ul className="activity-list activity-list--full">
                  {activity.slice(0, 8).map((entry) => (
                    <li key={entry.id} className="activity-item">
                      <span className={`activity-dot activity-dot--${entry.tone ?? 'neutral'}`} aria-hidden="true" />
                      <div className="activity-item__body">
                        <strong>{entry.title}</strong>
                        {entry.detail && <span>{entry.detail}</span>}
                      </div>
                      <span className="activity-item__time mono">{entry.time}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {section === 'about' && (
            <section className="settings-card panel about-card">
              <header className="settings-card__head">
                <div>
                  <h2>StompStation</h2>
                  <p className="hint">Pedalboard-first desktop controller for the Sonulab StompStation PRO.</p>
                </div>
                <span className="chip chip--good">{appVersion ? `v${appVersion}` : 'dev'}</span>
              </header>
              <dl className="settings-meta">
                <div>
                  <dt>Frame</dt>
                  <dd>Tauri 2 · Rust + React 19</dd>
                </div>
                <div>
                  <dt>Protocol</dt>
                  <dd>VoidX node protocol · firmware 2.5.3</dd>
                </div>
                <div>
                  <dt>Theme</dt>
                  <dd>{THEMES.find((item) => item.id === theme)?.name}</dd>
                </div>
                <div>
                  <dt>Fonts</dt>
                  <dd>Inter · JetBrains Mono (OFL)</dd>
                </div>
              </dl>
              <p className="settings-note">
                The Python GTK client remains in the repository as the protocol oracle and fallback.
                This build is the Tauri parity path. No Python runtime ships in the release app.
              </p>
              <div className="about-card__links">
                <button type="button" className="btn btn--sm" onClick={() => notify('Licenses: MIT, Apache-2.0, OFL', 'neutral')}>
                  Licenses
                </button>
                <button type="button" className="btn btn--sm" onClick={() => copyDiagnostics()}>
                  <Copy size={12} /> Copy report
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      <Dialog.Root open={resetOpen} onOpenChange={(open) => { setResetOpen(open); if (!open) setResetText(''); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby={undefined}>
            <div className="dialog-head">
              <div>
                <Dialog.Title className="dialog-title">Factory reset</Dialog.Title>
                <p className="hint">This cannot be undone from the app.</p>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label="Close factory reset dialog">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="dialog-body">
              <ul className="consequence-list">
                <li>All 52 presets are erased.</li>
                <li>NAM, PNAM, and IR slots are cleared.</li>
                <li>Global EQ, tuner reference, and input calibration reset.</li>
                <li>USB and network settings return to defaults.</li>
              </ul>
              <label className="field-label" htmlFor="reset-confirm">
                Type RESET to confirm
              </label>
              <input
                id="reset-confirm"
                className="input input--mono"
                autoFocus
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                placeholder="RESET"
              />
            </div>
            <div className="dialog-foot">
              <Dialog.Close asChild>
                <button type="button" className="btn">Cancel</button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn--danger"
                disabled={resetText !== 'RESET'}
                onClick={() => {
                  setResetOpen(false);
                  setResetText('');
                  notify('Factory reset is disabled in the demo build', 'warn');
                }}
              >
                <ShieldAlert size={13} /> Factory reset
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
