import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Cable, Check, RefreshCw, Router, Usb, Wifi, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ipcErrorMessage, isMobileRuntime, isTauriRuntime, tauriClient } from '../../ipc/client';
import type { DiscoveredDevice } from '../../ipc/client';
import { useAppStore } from '../../stores/useAppStore';

const USB_PORTS = [
  { device: '/dev/ttyACM0', description: 'StompStation · CDC-ACM' },
  { device: '/dev/ttyACM1', description: 'USB serial · no pedal detected' },
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

export const ConnectionSheet = () => {
  const open = useAppStore((state) => state.connectionOpen);
  const setOpen = useAppStore((state) => state.setConnectionOpen);
  const connection = useAppStore((state) => state.connection);
  const demoAllowed = useAppStore((state) => state.demoAllowed);
  const connectDemo = useAppStore((state) => state.connectDemo);
  const connectReal = useAppStore((state) => state.connectReal);
  const disconnect = useAppStore((state) => state.disconnect);
  const notify = useAppStore((state) => state.notify);
  const mobile = isMobileRuntime();
  const [transport, setTransport] = useState<'usb' | 'network'>(mobile ? 'network' : 'usb');
  const [ports, setPorts] = useState(USB_PORTS);
  const [port, setPort] = useState(USB_PORTS[0].device);
  const [address, setAddress] = useState(mobile ? '' : '127.0.0.1:45678');
  const [reconnect, setReconnect] = useState(true);
  const [remember, setRemember] = useState(true);
  const [networkDevices, setNetworkDevices] = useState<DiscoveredDevice[]>(
    isTauriRuntime() ? [] : DEMO_NETWORK,
  );
  const [scanningNetwork, setScanningNetwork] = useState(false);
  const tauri = isTauriRuntime();

  useEffect(() => {
    if (!open || !tauri) return;
    let cancelled = false;
    setScanningNetwork(true);
    void Promise.allSettled([tauriClient.listPorts(), tauriClient.discoverWifi()]).then(
      ([portResult, wifiResult]) => {
        if (cancelled) return;
        if (portResult.status === 'fulfilled' && portResult.value.length > 0) {
          const mapped = portResult.value.map((item) => ({
            device: item.device,
            description: item.description || (item.usb ? 'USB serial' : 'serial port'),
          }));
          setPorts(mapped);
          setPort((previous) =>
            mapped.some((item) => item.device === previous) ? previous : mapped[0].device,
          );
        }
        if (wifiResult.status === 'fulfilled') setNetworkDevices(wifiResult.value);
        setScanningNetwork(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, tauri]);

  const scanNetwork = async () => {
    setScanningNetwork(true);
    try {
      const found = await tauriClient.discoverWifi();
      setNetworkDevices(found);
      notify(
        found.length
          ? `mDNS scan: ${found.length} device${found.length === 1 ? '' : 's'} found`
          : 'No Wi-Fi pedal answered mDNS',
        found.length ? 'good' : 'warn',
      );
    } catch (error) {
      notify(ipcErrorMessage(error), 'bad');
    } finally {
      setScanningNetwork(false);
    }
  };

  const connect = async () => {
    if (!tauri) {
      if (transport === 'network') {
        notify('The browser preview uses the simulator; the Tauri shell opens real TCP.', 'neutral');
      }
      connectDemo();
      return;
    }
    const target = transport === 'usb' ? `serial:${port}` : `tcp:${address}`;
    await connectReal(target);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content connection-sheet" aria-describedby={undefined}>
          <header className="dialog-head">
            <div>
              <Dialog.Title className="dialog-title">Connect to your pedal</Dialog.Title>
              <p className="hint">
                {mobile
                  ? 'Wi-Fi discovery, or enter the pedal’s host and port.'
                  : 'USB CDC-ACM, a discovered network device, or the deterministic simulator.'}
              </p>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close connection sheet">
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>

          <div className="dialog-body connection-sheet__body">
            {connection.autoSearch === 'searching' && (
              <div className="connection-search" role="status">
                <span className="led led--on" aria-hidden="true" />
                <div>
                  <strong>Searching for StompStation</strong>
                  <span>Wi-Fi first, then USB. You can connect manually below.</span>
                </div>
              </div>
            )}
            {connection.autoSearch === 'failed' && (
              <div className="connection-search connection-search--failed" role="alert">
                <AlertTriangle size={15} />
                <div>
                  <strong>No pedal found automatically</strong>
                  <span>{connection.autoSearchMessage}</span>
                </div>
              </div>
            )}
            {connection.error && (
              <div className="connection-search connection-search--failed" role="alert">
                <AlertTriangle size={15} />
                <div>
                  <strong>Connection failed</strong>
                  <span>{connection.error}</span>
                </div>
              </div>
            )}
            <div className="segmented" role="group" aria-label="Transport">
              {!mobile && (
                <button type="button" aria-pressed={transport === 'usb'} onClick={() => setTransport('usb')}>
                  <Usb size={12} /> USB
                </button>
              )}
              <button
                type="button"
                aria-pressed={transport === 'network'}
                onClick={() => setTransport('network')}
              >
                <Wifi size={12} /> Wi-Fi / Network
              </button>
            </div>

            {transport === 'usb' && !mobile ? (
              <section className="connection-section">
                <div className="section-title">
                  <Cable size={13} /> Serial port
                  <span className="connection-section__badge">115200 baud</span>
                </div>
                <label className="field-label" htmlFor="serial-port">
                  Device
                  <span className="mono">CDC-ACM</span>
                </label>
                <select
                  id="serial-port"
                  className="select"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                >
                  {ports.map((item) => (
                    <option key={item.device} value={item.device}>
                      {item.device} — {item.description}
                    </option>
                  ))}
                </select>
                <div className="connection-toggles">
                  <button
                    type="button"
                    className="switch"
                    aria-checked={reconnect}
                    onClick={() => setReconnect((value) => !value)}
                  >
                    <span className="switch__track"><span className="switch__thumb" /></span>
                    Auto-reconnect
                  </button>
                  <button
                    type="button"
                    className="switch"
                    aria-checked={remember}
                    onClick={() => setRemember((value) => !value)}
                  >
                    <span className="switch__track"><span className="switch__thumb" /></span>
                    Reconnect on launch
                  </button>
                </div>
              </section>
            ) : (
              <section className="connection-section">
                <div className="section-title">
                  <Router size={13} /> Network discovery
                  <span className="connection-section__badge">mDNS · _http._tcp</span>
                </div>
                <div className="discovered-list">
                  {networkDevices.map((device) => {
                    const target = `${device.host}:${device.port}`;
                    return (
                      <button
                        key={device.service}
                        type="button"
                        className="discovered-device"
                        onClick={() => setAddress(target)}
                      >
                        <span className={`led ${device.valid ? 'led--on' : 'led--off'}`} aria-hidden="true" />
                        <span>
                          <strong>{device.name}</strong>
                          <small>
                            {device.valid ? 'mDNS · VoidX' : 'mDNS · not a VoidX device'}
                            {device.mac ? ` · ${device.mac}` : ''}
                          </small>
                        </span>
                        <span className="mono">{target}</span>
                        {address === target && <Check size={13} />}
                      </button>
                    );
                  })}
                  {networkDevices.length === 0 && (
                    <p className="hint">
                      {scanningNetwork
                        ? 'Scanning Wi-Fi for _http._tcp devices…'
                        : mobile
                          ? 'No Wi-Fi pedal answered mDNS. Enter an address below.'
                          : 'No Wi-Fi pedal answered mDNS. Enter an address below, or connect over USB.'}
                    </p>
                  )}
                </div>
                <label className="field-label" htmlFor="manual-address">
                  Manual address
                  <span className="mono">host:port</span>
                </label>
                <div className="connection-inline">
                  <input
                    id="manual-address"
                    className="input input--mono"
                    value={address}
                    placeholder="192.168.1.97:8080"
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={scanningNetwork}
                    onClick={() => void scanNetwork()}
                  >
                    <RefreshCw size={12} className={scanningNetwork ? 'spin' : undefined} />
                    {scanningNetwork ? 'Scanning…' : 'Scan'}
                  </button>
                </div>
              </section>
            )}

            {(demoAllowed || !tauri) && (
              <section className="connection-demo">
                <div>
                  <strong>Browser simulator</strong>
                  <p>
                    {tauri
                      ? 'Demo mode is enabled for this launch. USB and TCP commands go through the Rust device engine; the included simulator listens on 127.0.0.1:45678.'
                      : 'The browser preview is running against a deterministic local device. Open the Tauri shell to use real USB or TCP transports.'}
                  </p>
                </div>
                <span className="chip chip--good">{tauri ? 'Demo launch flag' : '132 nodes'}</span>
              </section>
            )}
            {tauri && !demoAllowed && (
              <section className="connection-demo connection-demo--info">
                <div>
                  <strong>
                    {mobile ? 'Wi-Fi discovery is enabled on launch' : 'Automatic discovery is enabled on launch'}
                  </strong>
                  <p>
                    {mobile
                      ? "The app searches Wi-Fi on launch. If nothing is found, enter the pedal's host and port here."
                      : 'The app searches Wi-Fi first, then USB. If nothing is found, choose a port or enter an address here. Demo mode is available only with --demo.'}
                  </p>
                </div>
              </section>
            )}
          </div>

          <footer className="dialog-foot connection-sheet__foot">
            {connection.connected ? (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            ) : (
              <span className="hint">
                {connection.connecting ? 'Talking to StompStation PRO…' : 'No device connection yet.'}
              </span>
            )}
            <div className="connection-sheet__actions">
              {(demoAllowed || !tauri) && (
                <button type="button" className="btn" onClick={() => connectDemo()}>
                  Use simulator
                </button>
              )}
              <button
                type="button"
                className="btn btn--primary"
                disabled={connection.connecting}
                onClick={() => void connect()}
              >
                {connection.connecting ? <RefreshCw size={13} className="spin" /> : <Cable size={13} />}
                {connection.connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
