use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use stomp_device::Device;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Default)]
pub struct AppState {
    pub device: Arc<Mutex<Option<Device>>>,
    pub tuner_previous: Arc<Mutex<Option<bool>>>,
    /// Interim poller. The dossier's full actor replaces this later; the
    /// invariant today is one mutex-serialized owner of the transport.
    pub poller: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub poller_stop: Arc<AtomicBool>,
    pub poll_paused: Arc<AtomicBool>,
    /// One upload owns the transport at a time. Cancelling sets the flag and
    /// the uploader stops at the next ACK boundary.
    pub upload_active: Arc<AtomicBool>,
    pub upload_cancel: Arc<AtomicBool>,
    /// The simulator/browser board is only auto-loaded when the app is started
    /// with `--demo` or `STOMPSTATION_DEMO=1`.
    pub demo_allowed: Arc<AtomicBool>,
}

impl AppState {
    pub fn is_connected(&self) -> bool {
        self.device
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// Stop and join the poller. Safe to call before locking the device.
    pub fn stop_poller(&self) {
        self.poller_stop.store(true, Ordering::SeqCst);
        let handle = self.poller.lock().ok().and_then(|mut guard| guard.take());
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    /// Start polling the current device. Replaces any previous poller.
    pub fn start_poller(&self, app: AppHandle) {
        self.stop_poller();
        self.poller_stop.store(false, Ordering::SeqCst);
        self.poll_paused.store(false, Ordering::SeqCst);

        let device = self.device.clone();
        let stop = self.poller_stop.clone();
        let paused = self.poll_paused.clone();

        let handle = thread::Builder::new()
            .name("stomp-poller".to_string())
            .spawn(move || {
                let mut last_browse = Instant::now();
                let mut errors = 0u8;
                while !stop.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(500));
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if paused.load(Ordering::SeqCst) {
                        continue;
                    }

                    let poll = {
                        let mut guard = match device.lock() {
                            Ok(guard) => guard,
                            Err(_) => break,
                        };
                        let Some(device) = guard.as_mut() else {
                            break;
                        };
                        if !device.is_connected() {
                            break;
                        }

                        // USB `read root` carries the useful live values. TCP
                        // firmware only reports meters via read root, so do a
                        // full browse every two seconds to pick up static edits.
                        let is_network = device.transport_description().starts_with("network");
                        let result =
                            if is_network && last_browse.elapsed() >= Duration::from_secs(2) {
                                last_browse = Instant::now();
                                device.refresh_full_state().map(|_| ())
                            } else {
                                device.read_root().map(|_| ())
                            };
                        match result {
                            Ok(()) => Ok(device.state()),
                            Err(error) => Err(error),
                        }
                    };

                    match poll {
                        Ok(snapshot) => {
                            errors = 0;
                            let _ = app.emit("device://snapshot", snapshot);
                        }
                        Err(error) => {
                            errors += 1;
                            if errors < 3 {
                                continue;
                            }
                            if let Ok(mut guard) = device.lock() {
                                if let Some(device) = guard.as_mut() {
                                    device.close();
                                }
                                *guard = None;
                            }
                            let _ = app.emit("device://error", error.to_string());
                            break;
                        }
                    }
                }
            })
            .ok();

        if let Ok(mut guard) = self.poller.lock() {
            *guard = handle;
        }
    }
}
