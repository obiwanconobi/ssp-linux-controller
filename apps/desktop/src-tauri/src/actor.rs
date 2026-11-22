//! Single-owner device actor.
//!
//! All transport work runs on one thread. Commands arrive through a queue,
//! polling and reconnect backoff run from the same scheduler, and every write
//! carries the connection generation it was issued against. A write queued
//! before a disconnect or reconnect is rejected instead of being applied to a
//! fresh connection.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use stomp_device::{
    parse_host_port, ChainEdit, ConnectionInfo, Device, DeviceSnapshot, UploadProgress,
};
use stomp_protocol::editor::BlockEditor;
use stomp_protocol::ProtocolError;
use stomp_upload::{Preflight, UploadKind};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::commands::{
    read_tuner, unavailable_tuner, TunerView, UploadCompletion, UploadProgressEvent,
};
use crate::error::{IpcError, IpcResult};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const NETWORK_BROWSE_INTERVAL: Duration = Duration::from_secs(2);
const WRITE_COOLDOWN: Duration = Duration::from_millis(250);
const DESTRUCTIVE_COOLDOWN: Duration = Duration::from_millis(750);
const UPLOAD_COOLDOWN: Duration = Duration::from_millis(900);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub type Reply<T> = oneshot::Sender<IpcResult<T>>;

#[derive(Debug, Clone, Serialize)]
pub struct ActorStatus {
    pub connected: bool,
    pub transport: String,
    pub address: String,
    pub reconnect_attempt: u32,
    pub retry_in_ms: Option<u64>,
    pub pending_writes: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActorDiagnostics {
    pub status: ActorStatus,
    pub snapshot: Option<DeviceSnapshot>,
}

pub enum ActorCommand {
    Connect {
        address: String,
        reply: Reply<ConnectionInfo>,
    },
    AutoConnect {
        reply: Reply<ConnectionInfo>,
    },
    Disconnect {
        reply: Reply<()>,
    },
    Snapshot {
        reply: Reply<DeviceSnapshot>,
    },
    Diagnostics {
        reply: Reply<ActorDiagnostics>,
    },
    Refresh {
        reply: Reply<DeviceSnapshot>,
    },
    BlockEditor {
        path: String,
        reply: Reply<BlockEditor>,
    },
    SetValue {
        path: String,
        value: Value,
        reply: Reply<DeviceSnapshot>,
    },
    SetBlock {
        path: String,
        on: bool,
        reply: Reply<DeviceSnapshot>,
    },
    SetPreset {
        name: String,
        reply: Reply<DeviceSnapshot>,
    },
    SavePreset {
        name: Option<String>,
        reply: Reply<DeviceSnapshot>,
    },
    RenamePreset {
        old_name: String,
        new_name: String,
        reply: Reply<DeviceSnapshot>,
    },
    EditChain {
        edit: ChainEdit,
        reply: Reply<DeviceSnapshot>,
    },
    SetMaster {
        control: String,
        value: f64,
        reply: Reply<DeviceSnapshot>,
    },
    SetEqBand {
        index: usize,
        field: String,
        value: f64,
        reply: Reply<DeviceSnapshot>,
    },
    SetEqType {
        index: usize,
        value: String,
        reply: Reply<DeviceSnapshot>,
    },
    SetEqEnabled {
        enabled: bool,
        reply: Reply<DeviceSnapshot>,
    },
    SetAlias {
        alias: String,
        reply: Reply<DeviceSnapshot>,
    },
    FactoryReset {
        reply: Reply<()>,
    },
    PreflightUpload {
        kind: UploadKind,
        file_path: String,
        target: String,
        slot: Option<usize>,
        reply: Reply<Preflight>,
    },
    BeginUpload {
        id: String,
        kind: UploadKind,
        file_path: String,
        target: String,
        slot: Option<usize>,
        reply: Reply<UploadCompletion>,
    },
    DeleteListItem {
        list_path: String,
        index: usize,
        reply: Reply<DeviceSnapshot>,
    },
    TunerOpen {
        reply: Reply<TunerView>,
    },
    TunerPoll {
        reply: Reply<TunerView>,
    },
    TunerClose {
        reply: Reply<()>,
    },
}

impl ActorCommand {
    fn is_write(&self) -> bool {
        matches!(
            self,
            Self::SetValue { .. }
                | Self::SetBlock { .. }
                | Self::SetPreset { .. }
                | Self::SavePreset { .. }
                | Self::RenamePreset { .. }
                | Self::EditChain { .. }
                | Self::SetMaster { .. }
                | Self::SetEqBand { .. }
                | Self::SetEqType { .. }
                | Self::SetEqEnabled { .. }
                | Self::SetAlias { .. }
                | Self::FactoryReset { .. }
                | Self::BeginUpload { .. }
                | Self::DeleteListItem { .. }
                | Self::TunerOpen { .. }
                | Self::TunerClose { .. }
        )
    }
}

struct ActorRequest {
    generation: u64,
    command: ActorCommand,
}

struct PendingWriteGuard(Arc<AtomicUsize>);

impl Drop for PendingWriteGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct ActorHandle {
    tx: Sender<ActorRequest>,
    generation: Arc<AtomicU64>,
    connected: Arc<AtomicBool>,
    pending_writes: Arc<AtomicUsize>,
    upload_active: Arc<AtomicBool>,
    upload_cancel: Arc<AtomicBool>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl ActorHandle {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel();
        let generation = Arc::new(AtomicU64::new(0));
        let connected = Arc::new(AtomicBool::new(false));
        let pending_writes = Arc::new(AtomicUsize::new(0));
        let upload_active = Arc::new(AtomicBool::new(false));
        let upload_cancel = Arc::new(AtomicBool::new(false));
        let app = Arc::new(Mutex::new(None));

        let actor = Actor {
            rx,
            app: app.clone(),
            generation: generation.clone(),
            connected: connected.clone(),
            pending_writes: pending_writes.clone(),
            upload_active: upload_active.clone(),
            upload_cancel: upload_cancel.clone(),
            device: None,
            last_target: None,
            last_info: None,
            last_snapshot: None,
            revision: 0,
            state_signature: None,
            last_poll: Instant::now(),
            last_browse: Instant::now(),
            poll_resume_at: Instant::now(),
            reconnect_at: None,
            reconnect_attempts: 0,
            consecutive_errors: 0,
            last_error: None,
            tuner_previous: None,
        };

        thread::Builder::new()
            .name("stomp-actor".to_string())
            .spawn(move || actor.run())
            .expect("could not start the device actor");

        Self {
            tx,
            generation,
            connected,
            pending_writes,
            upload_active,
            upload_cancel,
            app,
        }
    }

    pub fn attach_app(&self, app: AppHandle) {
        if let Ok(mut guard) = self.app.lock() {
            *guard = Some(app);
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn cancel_upload(&self) -> bool {
        if self.upload_active.load(Ordering::SeqCst) {
            self.upload_cancel.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub async fn call<T, F>(&self, build: F) -> IpcResult<T>
    where
        T: Send + 'static,
        F: FnOnce(Reply<T>) -> ActorCommand,
    {
        let (reply, response) = oneshot::channel();
        let command = build(reply);
        let write = command.is_write();
        let _pending = write.then(|| {
            self.pending_writes.fetch_add(1, Ordering::SeqCst);
            PendingWriteGuard(self.pending_writes.clone())
        });
        let request = ActorRequest {
            generation: self.generation.load(Ordering::SeqCst),
            command,
        };
        self.tx
            .send(request)
            .map_err(|_| IpcError::internal("device actor is not running"))?;
        response
            .await
            .map_err(|_| IpcError::internal("device actor dropped the reply"))?
    }
}

impl Default for ActorHandle {
    fn default() -> Self {
        Self::spawn()
    }
}

#[derive(Clone, Debug)]
enum Target {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
}

impl Target {
    fn parse(address: &str) -> IpcResult<Self> {
        if let Some(text) = address.strip_prefix("serial:") {
            let (port, baud) = text
                .split_once('@')
                .map(|(port, baud)| (port, baud.parse().unwrap_or(115_200)))
                .unwrap_or((text, 115_200));
            return Ok(Self::Serial {
                port: port.to_string(),
                baud,
            });
        }
        let address = address.strip_prefix("tcp:").unwrap_or(address);
        let (host, port) = parse_host_port(address).map_err(IpcError::from)?;
        Ok(Self::Tcp { host, port })
    }

    fn open(&self) -> Device {
        match self {
            Self::Serial { port, baud } => Device::serial(port.clone(), *baud),
            Self::Tcp { host, port } => Device::tcp(host.clone(), *port),
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Serial { port, baud } => format!("serial:{port}@{baud}"),
            Self::Tcp { host, port } => format!("tcp:{host}:{port}"),
        }
    }
}

fn open_target(target: &Target) -> IpcResult<(Device, ConnectionInfo)> {
    let mut device = target.open();
    let info = device.connect().map_err(IpcError::from)?;
    Ok((device, info))
}

fn stale_error() -> IpcError {
    IpcError {
        code: "stale_connection".to_string(),
        message: "the connection changed before this write was sent; retry".to_string(),
        retryable: true,
    }
}

fn is_connection_loss(error: &ProtocolError) -> bool {
    matches!(
        error,
        ProtocolError::NotConnected | ProtocolError::ConnectionClosed | ProtocolError::Io(_)
    )
}

/// Preserve the state from before the first open. A repeated open while the
/// tuner is already on must not turn the saved "off" state into "on".
fn remember_tuner_previous(previous: &mut Option<bool>, was_on: bool) {
    if previous.is_none() {
        *previous = Some(was_on);
    }
}

/// State signature used to bump revisions only when the board changes.
/// Meters are intentionally excluded so a live meter update does not count as
/// a device change; the snapshot is still emitted with the same revision.
fn snapshot_signature(snapshot: &DeviceSnapshot) -> u64 {
    let mut copy = snapshot.clone();
    copy.revision = 0;
    copy.meters.input = [0.0, 0.0];
    copy.meters.output = [0.0, 0.0];
    let bytes = serde_json::to_vec(&copy).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

struct Actor {
    rx: Receiver<ActorRequest>,
    app: Arc<Mutex<Option<AppHandle>>>,
    generation: Arc<AtomicU64>,
    connected: Arc<AtomicBool>,
    pending_writes: Arc<AtomicUsize>,
    upload_active: Arc<AtomicBool>,
    upload_cancel: Arc<AtomicBool>,
    device: Option<Device>,
    last_target: Option<Target>,
    last_info: Option<ConnectionInfo>,
    last_snapshot: Option<DeviceSnapshot>,
    revision: u64,
    state_signature: Option<u64>,
    last_poll: Instant,
    last_browse: Instant,
    poll_resume_at: Instant,
    reconnect_at: Option<Instant>,
    reconnect_attempts: u32,
    consecutive_errors: u8,
    last_error: Option<String>,
    tuner_previous: Option<bool>,
}

impl Actor {
    fn run(mut self) {
        loop {
            let wait = self.wait_duration();
            match self.rx.recv_timeout(wait) {
                Ok(request) => self.handle(request),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.tick();
        }
    }

    fn wait_duration(&self) -> Duration {
        let now = Instant::now();
        let mut next = now + POLL_INTERVAL;
        if let Some(at) = self.reconnect_at {
            if at < next {
                next = at;
            }
        }
        if self.device.is_some() {
            let poll_at = self.last_poll + POLL_INTERVAL;
            if poll_at < next {
                next = poll_at;
            }
            if self.poll_resume_at < next {
                next = self.poll_resume_at;
            }
            if self.is_network() {
                let browse_at = self.last_browse + NETWORK_BROWSE_INTERVAL;
                if browse_at < next {
                    next = browse_at;
                }
            }
        }
        next.saturating_duration_since(now)
            .max(Duration::from_millis(10))
    }

    fn tick(&mut self) {
        let now = Instant::now();
        if self.device.is_none() {
            if let Some(at) = self.reconnect_at {
                if now >= at {
                    self.try_reconnect();
                }
            }
            return;
        }
        if now < self.poll_resume_at {
            return;
        }
        if now.duration_since(self.last_poll) < POLL_INTERVAL {
            return;
        }
        let network = self.is_network();
        let browse = network && now.duration_since(self.last_browse) >= NETWORK_BROWSE_INTERVAL;

        let result = {
            let Some(device) = self.device.as_mut() else {
                return;
            };
            if browse {
                device.refresh_full_state().map(|_| ())
            } else {
                device.read_root().map(|_| ())
            }
        };

        self.last_poll = now;
        if browse {
            self.last_browse = now;
        }
        match result {
            Ok(()) => {
                self.consecutive_errors = 0;
                if let Some(device) = self.device.as_ref() {
                    self.emit_snapshot(device.state());
                }
            }
            Err(error) => {
                self.consecutive_errors = self.consecutive_errors.saturating_add(1);
                if self.consecutive_errors >= 3 || is_connection_loss(&error) {
                    self.connection_lost(&error.to_string());
                }
            }
        }
    }

    fn handle(&mut self, request: ActorRequest) {
        let ActorRequest {
            generation,
            command,
        } = request;
        match command {
            ActorCommand::Connect { address, reply } => {
                let _ = reply.send(self.connect(&address));
            }
            ActorCommand::AutoConnect { reply } => {
                let _ = reply.send(self.auto_connect());
            }
            ActorCommand::Disconnect { reply } => {
                self.disconnect();
                let _ = reply.send(Ok(()));
            }
            ActorCommand::Snapshot { reply } => {
                let _ = reply.send(self.snapshot());
            }
            ActorCommand::Diagnostics { reply } => {
                let _ = reply.send(Ok(ActorDiagnostics {
                    status: self.status(),
                    snapshot: self.last_snapshot.clone(),
                }));
            }
            ActorCommand::Refresh { reply } => {
                let _ = reply.send(self.refresh());
            }
            ActorCommand::BlockEditor { path, reply } => {
                let result = self.with_device(|device| Ok(device.block_editor(&path)));
                let _ = reply.send(result);
            }
            ActorCommand::SetValue { path, value, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_value(&path, value)
                });
            }
            ActorCommand::SetBlock { path, on, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_block(&path, on)
                });
            }
            ActorCommand::SetPreset { name, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_preset(&name)
                });
            }
            ActorCommand::SavePreset { name, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.save_preset(name.as_deref())
                });
            }
            ActorCommand::RenamePreset {
                old_name,
                new_name,
                reply,
            } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.rename_preset(&old_name, &new_name)
                });
            }
            ActorCommand::EditChain { edit, reply } => {
                let cooldown = match edit {
                    ChainEdit::Clear => DESTRUCTIVE_COOLDOWN,
                    _ => WRITE_COOLDOWN,
                };
                self.write_snapshot(generation, reply, cooldown, |device| {
                    device.edit_chain(edit)
                });
            }
            ActorCommand::SetMaster {
                control,
                value,
                reply,
            } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_master(&control, value)
                });
            }
            ActorCommand::SetEqBand {
                index,
                field,
                value,
                reply,
            } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_eq_band(index, &field, value)
                });
            }
            ActorCommand::SetEqType {
                index,
                value,
                reply,
            } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_eq_type(index, &value)
                });
            }
            ActorCommand::SetEqEnabled { enabled, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_eq_enabled(enabled)
                });
            }
            ActorCommand::SetAlias { alias, reply } => {
                self.write_snapshot(generation, reply, WRITE_COOLDOWN, |device| {
                    device.set_value(r"root\sys\alias", serde_json::json!(alias))
                });
            }
            ActorCommand::FactoryReset { reply } => {
                self.write_unit(generation, reply, DESTRUCTIVE_COOLDOWN, |device| {
                    device.set_value(
                        r"root\settings\misc\action\factory",
                        serde_json::json!("run"),
                    )
                });
            }
            ActorCommand::PreflightUpload {
                kind,
                file_path,
                target,
                slot,
                reply,
            } => {
                let result = self.preflight(kind, &file_path, &target, slot);
                let _ = reply.send(result);
            }
            ActorCommand::BeginUpload {
                id,
                kind,
                file_path,
                target,
                slot,
                reply,
            } => {
                let _ =
                    reply.send(self.begin_upload(generation, id, kind, &file_path, &target, slot));
            }
            ActorCommand::DeleteListItem {
                list_path,
                index,
                reply,
            } => {
                self.write_snapshot(generation, reply, DESTRUCTIVE_COOLDOWN, |device| {
                    device.delete_list_item(&list_path, index)
                });
            }
            ActorCommand::TunerOpen { reply } => {
                let _ = reply.send(self.tuner_open(generation));
            }
            ActorCommand::TunerPoll { reply } => {
                let result = self.with_device(|device| Ok(read_tuner(device)));
                let _ = reply.send(result);
            }
            ActorCommand::TunerClose { reply } => {
                let _ = reply.send(self.tuner_close(generation));
            }
        }
    }

    fn connect(&mut self, address: &str) -> IpcResult<ConnectionInfo> {
        let target = Target::parse(address)?;
        self.last_target = None;
        self.last_info = None;
        self.reconnect_at = None;
        self.reconnect_attempts = 0;
        self.close_current();
        match open_target(&target) {
            Ok((device, info)) => {
                self.install(device, info.clone(), target);
                Ok(info)
            }
            Err(error) => {
                self.last_error = Some(error.message.clone());
                self.emit_status();
                Err(error)
            }
        }
    }

    fn auto_connect(&mut self) -> IpcResult<ConnectionInfo> {
        self.last_target = None;
        self.last_info = None;
        self.reconnect_at = None;
        self.reconnect_attempts = 0;
        self.close_current();
        let mut last_error: Option<String> = None;

        for found in stomp_transport::discover_mdns(Duration::from_millis(2_500))
            .into_iter()
            .filter(|found| found.valid)
        {
            let target = Target::Tcp {
                host: found.host.clone(),
                port: found.port,
            };
            match open_target(&target) {
                Ok((device, info)) => {
                    self.install(device, info.clone(), target);
                    return Ok(info);
                }
                Err(error) => {
                    last_error = Some(format!("{}:{} ({})", found.host, found.port, error.message));
                }
            }
        }

        let ports = stomp_transport::list_serial_ports();
        let mut tried = Vec::new();
        for port in ports {
            if !(port.usb || stomp_transport::is_usb_serial_device(&port.device)) {
                continue;
            }
            if tried.len() >= 8 {
                break;
            }
            tried.push(port.device.clone());
            let target = Target::Serial {
                port: port.device.clone(),
                baud: 115_200,
            };
            match open_target(&target) {
                Ok((device, info)) => {
                    self.install(device, info.clone(), target);
                    return Ok(info);
                }
                Err(error) => {
                    last_error = Some(format!("{} ({})", port.device, error.message));
                }
            }
        }

        let detail = last_error
            .map(|error| format!(" Last error: {error}."))
            .unwrap_or_default();
        let message = if cfg!(mobile) {
            format!("No StompStation found over Wi-Fi.{detail} Enter the pedal's Wi-Fi address.")
        } else {
            let ports = if tried.is_empty() {
                "no USB serial ports were found".to_string()
            } else {
                format!("USB ports tried: {}.", tried.join(", "))
            };
            format!(
                "No StompStation found over Wi-Fi or USB ({ports}).{detail} Connect manually, or launch with --demo for the simulator."
            )
        };
        self.last_error = Some(message.clone());
        self.emit_status();
        Err(IpcError::no_device(message))
    }

    fn install(&mut self, device: Device, info: ConnectionInfo, target: Target) {
        self.device = Some(device);
        self.last_target = Some(target);
        self.last_info = Some(info);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        self.reconnect_at = None;
        self.reconnect_attempts = 0;
        self.consecutive_errors = 0;
        self.last_error = None;
        self.last_poll = Instant::now();
        self.last_browse = Instant::now();
        self.poll_resume_at = Instant::now();
        if let Some(device) = self.device.as_ref() {
            self.emit_snapshot(device.state());
        }
        self.emit_status();
    }

    fn close_current(&mut self) {
        if let Some(mut device) = self.device.take() {
            device.close();
        }
        self.connected.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.upload_active.store(false, Ordering::SeqCst);
        self.tuner_previous = None;
        self.state_signature = None;
    }

    fn disconnect(&mut self) {
        self.close_current();
        self.last_target = None;
        self.last_info = None;
        self.reconnect_at = None;
        self.reconnect_attempts = 0;
        self.tuner_previous = None;
        self.last_error = None;
        self.emit_status();
    }

    fn connection_lost(&mut self, message: &str) {
        self.close_current();
        self.last_error = Some(message.to_string());
        self.emit("device://error", message.to_string());
        self.schedule_reconnect();
        self.emit_status();
    }

    fn schedule_reconnect(&mut self) {
        if self.last_target.is_none() {
            self.reconnect_at = None;
            return;
        }
        let delay = Duration::from_millis(1_000)
            .saturating_mul(1u32 << self.reconnect_attempts.min(5))
            .min(MAX_BACKOFF);
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1);
        self.reconnect_at = Some(Instant::now() + delay);
    }

    fn try_reconnect(&mut self) {
        let Some(target) = self.last_target.clone() else {
            self.reconnect_at = None;
            return;
        };
        match open_target(&target) {
            Ok((device, info)) => {
                self.install(device, info, target);
                self.emit(
                    "device://reconnected",
                    self.last_info
                        .as_ref()
                        .map(|info| info.address.clone())
                        .unwrap_or_default(),
                );
            }
            Err(error) => {
                self.last_error = Some(error.message);
                self.schedule_reconnect();
                self.emit_status();
            }
        }
    }

    fn snapshot(&mut self) -> IpcResult<DeviceSnapshot> {
        let snapshot = self.with_device(|device| Ok(device.state()))?;
        self.consecutive_errors = 0;
        let snapshot = self.stamp(snapshot);
        self.last_snapshot = Some(snapshot.clone());
        Ok(snapshot)
    }

    fn refresh(&mut self) -> IpcResult<DeviceSnapshot> {
        let snapshot = self.with_device(|device| device.refresh_full_state())?;
        self.consecutive_errors = 0;
        let snapshot = self.stamp(snapshot);
        self.last_snapshot = Some(snapshot.clone());
        self.last_poll = Instant::now();
        self.last_browse = Instant::now();
        Ok(snapshot)
    }

    fn preflight(
        &mut self,
        kind: UploadKind,
        file_path: &str,
        target: &str,
        slot: Option<usize>,
    ) -> IpcResult<Preflight> {
        let path = std::path::PathBuf::from(file_path);
        let raw = std::fs::read(&path)
            .map_err(|error| IpcError::internal(format!("could not read file: {error}")))?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload")
            .to_string();
        self.with_device(|device| device.preflight_upload(kind, &raw, &file_name, target, slot))
    }

    fn begin_upload(
        &mut self,
        generation: u64,
        id: String,
        kind: UploadKind,
        file_path: &str,
        target: &str,
        slot: Option<usize>,
    ) -> IpcResult<UploadCompletion> {
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(stale_error());
        }
        if self.upload_active.swap(true, Ordering::SeqCst) {
            return Err(IpcError::from(ProtocolError::InvalidRequest(
                "another upload is already in flight".into(),
            )));
        }
        self.upload_cancel.store(false, Ordering::SeqCst);

        let path = std::path::PathBuf::from(file_path);
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) => {
                self.upload_active.store(false, Ordering::SeqCst);
                return Err(IpcError::internal(format!("could not read file: {error}")));
            }
        };
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload")
            .to_string();

        let app = self.app.lock().ok().and_then(|guard| guard.clone());
        let cancel = self.upload_cancel.clone();
        let target_label = target.to_string();
        let upload_id = id.clone();
        let result = {
            let Some(device) = self.device.as_mut() else {
                self.upload_active.store(false, Ordering::SeqCst);
                return Err(IpcError::from(ProtocolError::NotConnected));
            };
            let outcome = device.upload_with_progress(
                kind,
                &raw,
                &file_name,
                target,
                slot,
                |progress: &UploadProgress| {
                    if let Some(app) = app.as_ref() {
                        let total = progress.total_acks.max(1);
                        let _ = app.emit(
                            "device://upload",
                            UploadProgressEvent {
                                id: upload_id.clone(),
                                kind: progress.kind,
                                target: target_label.clone(),
                                slot: progress.slot,
                                name: progress.name.clone(),
                                ack: progress.ack,
                                total_acks: progress.total_acks,
                                progress: (progress.ack as f64 / total as f64) * 100.0,
                                bytes_sent: progress.bytes_sent,
                                total_bytes: progress.total_bytes,
                            },
                        );
                    }
                    !cancel.load(Ordering::SeqCst)
                },
            );
            match outcome {
                Ok(outcome) => Ok((outcome, device.state())),
                Err(error) => Err(error),
            }
        };
        self.upload_active.store(false, Ordering::SeqCst);

        match result {
            Ok((outcome, snapshot)) => {
                self.after_write(UPLOAD_COOLDOWN);
                let snapshot = self.stamp(snapshot);
                self.last_snapshot = Some(snapshot.clone());
                Ok(UploadCompletion {
                    cancelled: outcome.is_none(),
                    result: outcome,
                    snapshot,
                })
            }
            Err(error) => {
                self.after_write(UPLOAD_COOLDOWN);
                let fatal = is_connection_loss(&error);
                let message = error.to_string();
                if fatal {
                    self.connection_lost(&message);
                }
                Err(error.into())
            }
        }
    }

    fn tuner_open(&mut self, generation: u64) -> IpcResult<TunerView> {
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(stale_error());
        }
        let result = self.with_device(|device| {
            let on_path = r"root\settings\tuner\on_off";
            if !device.nodes().contains(on_path) {
                return Ok((None, unavailable_tuner()));
            }
            let was_on = device
                .nodes()
                .value_str(on_path)
                .is_some_and(|value| value.eq_ignore_ascii_case("ON"));
            if !was_on {
                device.set_value(on_path, serde_json::json!("ON"))?;
            }
            Ok((Some(was_on), read_tuner(device)))
        });
        match result {
            Ok((previous, view)) => {
                if let Some(was_on) = previous {
                    // A second open while the deck is already open must not
                    // replace the original pre-open state with "ON"; otherwise
                    // closing would restore ON and leave the pedal tuner on.
                    remember_tuner_previous(&mut self.tuner_previous, was_on);
                    self.after_write(WRITE_COOLDOWN);
                }
                Ok(view)
            }
            Err(error) => {
                self.after_write(WRITE_COOLDOWN);
                Err(error)
            }
        }
    }

    fn tuner_close(&mut self, generation: u64) -> IpcResult<()> {
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(stale_error());
        }
        let was_on = self.tuner_previous.take().unwrap_or(false);
        let result = self.with_device(|device| {
            let on_path = r"root\settings\tuner\on_off";
            if !device.nodes().contains(on_path) {
                return Ok(());
            }
            device.set_value(
                on_path,
                serde_json::json!(if was_on { "ON" } else { "OFF" }),
            )
        });
        self.after_write(WRITE_COOLDOWN);
        result
    }

    fn write_snapshot<F>(
        &mut self,
        generation: u64,
        reply: Reply<DeviceSnapshot>,
        cooldown: Duration,
        operation: F,
    ) where
        F: FnOnce(&mut Device) -> Result<(), ProtocolError>,
    {
        let Some(reply) = self.gate(generation, reply) else {
            return;
        };
        let result = self.with_device(|device| {
            operation(device)?;
            Ok(device.state())
        });
        match result {
            Ok(snapshot) => {
                self.after_write(cooldown);
                let snapshot = self.stamp(snapshot);
                self.last_snapshot = Some(snapshot.clone());
                let _ = reply.send(Ok(snapshot));
            }
            Err(error) => {
                self.after_write(cooldown);
                let _ = reply.send(Err(error));
            }
        }
    }

    fn write_unit<F>(&mut self, generation: u64, reply: Reply<()>, cooldown: Duration, operation: F)
    where
        F: FnOnce(&mut Device) -> Result<(), ProtocolError>,
    {
        let Some(reply) = self.gate(generation, reply) else {
            return;
        };
        let result = self.with_device(operation);
        self.after_write(cooldown);
        let _ = reply.send(result);
    }

    fn gate<T>(&self, generation: u64, reply: Reply<T>) -> Option<Reply<T>> {
        if generation == self.generation.load(Ordering::SeqCst) {
            Some(reply)
        } else {
            let _ = reply.send(Err(stale_error()));
            None
        }
    }

    fn with_device<T, F>(&mut self, operation: F) -> IpcResult<T>
    where
        F: FnOnce(&mut Device) -> Result<T, ProtocolError>,
    {
        let result = {
            let Some(device) = self.device.as_mut() else {
                return Err(IpcError::from(ProtocolError::NotConnected));
            };
            operation(device)
        };
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if is_connection_loss(&error) {
                    self.connection_lost(&error.to_string());
                }
                Err(error.into())
            }
        }
    }

    fn after_write(&mut self, cooldown: Duration) {
        let now = Instant::now();
        self.consecutive_errors = 0;
        self.last_poll = now;
        self.last_browse = now;
        self.poll_resume_at = now + cooldown;
    }

    fn is_network(&self) -> bool {
        self.device
            .as_ref()
            .is_some_and(|device| device.transport_description().starts_with("network"))
    }

    fn stamp(&mut self, mut snapshot: DeviceSnapshot) -> DeviceSnapshot {
        let signature = snapshot_signature(&snapshot);
        if self.state_signature != Some(signature) {
            self.revision = self.revision.saturating_add(1).max(1);
            self.state_signature = Some(signature);
        }
        snapshot.revision = self.revision;
        snapshot
    }

    fn emit_snapshot(&mut self, snapshot: DeviceSnapshot) {
        let snapshot = self.stamp(snapshot);
        self.last_snapshot = Some(snapshot.clone());
        self.emit("device://snapshot", snapshot);
    }

    fn emit_status(&self) {
        self.emit("device://status", self.status());
    }

    fn status(&self) -> ActorStatus {
        let now = Instant::now();
        ActorStatus {
            connected: self.device.is_some(),
            transport: self
                .device
                .as_ref()
                .map(Device::transport_description)
                .or_else(|| self.last_info.as_ref().map(|info| info.transport.clone()))
                .unwrap_or_else(|| "disconnected".to_string()),
            address: self
                .device
                .as_ref()
                .map(|device| device.connection_info().address)
                .or_else(|| self.last_info.as_ref().map(|info| info.address.clone()))
                .or_else(|| self.last_target.as_ref().map(Target::label))
                .unwrap_or_default(),
            reconnect_attempt: self.reconnect_attempts,
            retry_in_ms: self
                .reconnect_at
                .map(|at| at.saturating_duration_since(now).as_millis() as u64),
            pending_writes: self.pending_writes.load(Ordering::SeqCst),
            last_error: self.last_error.clone(),
        }
    }

    fn emit<S>(&self, event: &str, payload: S)
    where
        S: Serialize + Clone,
    {
        if let Some(app) = self.app.lock().ok().and_then(|guard| guard.clone()) {
            let _ = app.emit(event, payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_serial_and_tcp_targets() {
        let serial = Target::parse("serial:/dev/ttyACM0@115200").unwrap();
        assert!(matches!(
            serial,
            Target::Serial { ref port, baud }
                if port == "/dev/ttyACM0" && baud == 115_200
        ));
        let tcp = Target::parse("tcp:192.168.1.97:8080").unwrap();
        assert!(matches!(
            tcp,
            Target::Tcp { ref host, port }
                if host == "192.168.1.97" && port == 8080
        ));
    }

    #[test]
    fn classifies_connection_errors() {
        assert!(is_connection_loss(&ProtocolError::NotConnected));
        assert!(is_connection_loss(&ProtocolError::ConnectionClosed));
        assert!(!is_connection_loss(&ProtocolError::Timeout));
        assert!(!is_connection_loss(&ProtocolError::InvalidRequest(
            "bad".into()
        )));
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let mut actor = test_actor();
        actor.schedule_reconnect();
        assert_eq!(actor.reconnect_attempts, 1);
        for _ in 0..10 {
            actor.schedule_reconnect();
        }
        assert!(actor.reconnect_attempts >= 10);
        assert!(
            actor.reconnect_at.unwrap() <= Instant::now() + MAX_BACKOFF + Duration::from_millis(50)
        );
    }

    #[test]
    fn repeated_tuner_open_preserves_the_original_state() {
        let mut previous = None;
        remember_tuner_previous(&mut previous, false);
        assert_eq!(previous, Some(false));
        // The second open sees ON, but must keep the original OFF.
        remember_tuner_previous(&mut previous, true);
        assert_eq!(previous, Some(false));
    }

    #[test]
    fn revisions_are_monotonic_across_a_reconnect() {
        let mut actor = test_actor();
        let first = actor.stamp(DeviceSnapshot::default());
        assert_eq!(first.revision, 1);

        let same = actor.stamp(DeviceSnapshot::default());
        assert_eq!(same.revision, 1);

        actor.close_current();
        let after_reconnect = actor.stamp(DeviceSnapshot::default());
        assert_eq!(after_reconnect.revision, 2);
    }

    #[test]
    fn meters_do_not_bump_the_revision_but_state_changes_do() {
        let mut actor = test_actor();
        let first = actor.stamp(DeviceSnapshot::default());
        assert_eq!(first.revision, 1);

        let mut meters_only = DeviceSnapshot::default();
        meters_only.meters.input = [-20.0, -21.0];
        meters_only.meters.output = [-10.0, -11.0];
        assert_eq!(actor.stamp(meters_only).revision, 1);

        let mut changed = DeviceSnapshot::default();
        changed.preset.current = "Another patch".to_string();
        assert_eq!(actor.stamp(changed).revision, 2);
    }

    #[test]
    fn connection_loss_schedules_a_reconnect_and_bumps_generation() {
        let mut actor = test_actor();
        actor.device = Some(Device::scripted(Vec::new()));
        actor.last_info = Some(test_info());
        actor.connected.store(true, Ordering::SeqCst);
        let generation = actor.generation.load(Ordering::SeqCst);

        actor.connection_lost("socket closed");

        assert!(actor.device.is_none());
        assert!(!actor.connected.load(Ordering::SeqCst));
        assert!(actor.generation.load(Ordering::SeqCst) > generation);
        assert!(actor.reconnect_at.is_some());
        assert_eq!(actor.last_error.as_deref(), Some("socket closed"));
    }

    #[test]
    fn disconnect_cancels_reconnect() {
        let mut actor = test_actor();
        actor.device = Some(Device::scripted(Vec::new()));
        actor.reconnect_at = Some(Instant::now());
        actor.disconnect();
        assert!(actor.last_target.is_none());
        assert!(actor.reconnect_at.is_none());
        assert!(!actor.connected.load(Ordering::SeqCst));
    }

    #[test]
    fn install_marks_connected_and_clears_backoff() {
        let mut actor = test_actor();
        actor.reconnect_at = Some(Instant::now());
        actor.reconnect_attempts = 3;
        let generation = actor.generation.load(Ordering::SeqCst);
        actor.install(
            Device::scripted(Vec::new()),
            test_info(),
            Target::Tcp {
                host: "127.0.0.1".to_string(),
                port: 45678,
            },
        );
        assert!(actor.connected.load(Ordering::SeqCst));
        assert!(actor.generation.load(Ordering::SeqCst) > generation);
        assert!(actor.reconnect_at.is_none());
        assert_eq!(actor.reconnect_attempts, 0);
    }

    fn test_info() -> ConnectionInfo {
        ConnectionInfo {
            address: "tcp:127.0.0.1:45678".to_string(),
            transport: "network 127.0.0.1:45678".to_string(),
            device_name: "Simulator".to_string(),
            firmware: "test".to_string(),
            node_count: 0,
        }
    }

    #[test]
    fn rejects_a_write_queued_before_a_reconnect() {
        let mut actor = test_actor();
        actor.close_current();

        let (reply, response) = oneshot::channel();
        actor.handle(ActorRequest {
            generation: 0,
            command: ActorCommand::SetValue {
                path: r"root\sys\alias".to_string(),
                value: serde_json::json!("Stale"),
                reply,
            },
        });
        let error = response.blocking_recv().unwrap().unwrap_err();
        assert_eq!(error.code, "stale_connection");
    }

    #[test]
    #[ignore = "requires STOMP_TEST_TCP to point at a running simulator"]
    fn connects_reads_and_writes_against_a_simulator() {
        let Ok(address) = std::env::var("STOMP_TEST_TCP") else {
            return;
        };
        tauri::async_runtime::block_on(async {
            let handle = ActorHandle::spawn();
            let info = handle
                .call(|reply| ActorCommand::Connect { address, reply })
                .await
                .expect("actor connect");
            assert!(info.node_count > 0);
            let snapshot = handle
                .call(|reply| ActorCommand::Snapshot { reply })
                .await
                .expect("actor snapshot");
            assert!(snapshot.connected);
            assert!(!snapshot.chain.blocks.is_empty());
            let drive_before = snapshot
                .chain
                .blocks
                .iter()
                .find(|block| block.path == r"root\app\drive")
                .map(|block| block.control_revision)
                .expect("drive block");

            let updated = handle
                .call(|reply| ActorCommand::SetValue {
                    path: r"root\app\drive\gain".to_string(),
                    value: serde_json::json!(7.2),
                    reply,
                })
                .await
                .expect("actor write");
            let drive_after = updated
                .chain
                .blocks
                .iter()
                .find(|block| block.path == r"root\app\drive")
                .map(|block| block.control_revision)
                .expect("drive block after write");
            assert_ne!(drive_before, drive_after);
            let repeat = handle
                .call(|reply| ActorCommand::Snapshot { reply })
                .await
                .expect("repeat snapshot");
            assert_eq!(repeat.revision, updated.revision);

            let alias = handle
                .call(|reply| ActorCommand::SetAlias {
                    alias: "Actor Test".to_string(),
                    reply,
                })
                .await
                .expect("actor alias write");
            assert!(alias.revision >= 1);

            let diagnostics = handle
                .call(|reply| ActorCommand::Diagnostics { reply })
                .await
                .expect("actor diagnostics");
            assert!(diagnostics.status.connected);
            assert!(diagnostics.snapshot.is_some());

            handle
                .call(|reply| ActorCommand::Disconnect { reply })
                .await
                .expect("actor disconnect");
            assert!(!handle.is_connected());
        });
    }

    fn test_actor() -> Actor {
        let (_tx, rx) = mpsc::channel();
        Actor {
            rx,
            app: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            pending_writes: Arc::new(AtomicUsize::new(0)),
            upload_active: Arc::new(AtomicBool::new(false)),
            upload_cancel: Arc::new(AtomicBool::new(false)),
            device: None,
            last_target: Some(Target::Tcp {
                host: "127.0.0.1".to_string(),
                port: 45678,
            }),
            last_info: None,
            last_snapshot: None,
            revision: 0,
            state_signature: None,
            last_poll: Instant::now(),
            last_browse: Instant::now(),
            poll_resume_at: Instant::now(),
            reconnect_at: None,
            reconnect_attempts: 0,
            consecutive_errors: 0,
            last_error: None,
            tuner_previous: None,
        }
    }
}
