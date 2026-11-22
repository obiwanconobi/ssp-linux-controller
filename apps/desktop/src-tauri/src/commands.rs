use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use stomp_device::{
    parse_host_port, validate_alias, ChainEdit, ConnectionInfo, Device, DeviceSnapshot,
    UploadProgress, UploadResult,
};
use stomp_protocol::editor::BlockEditor;
use stomp_protocol::ProtocolError;
use stomp_upload::{Preflight, UploadKind};

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct Bootstrap {
    pub product: String,
    pub version: String,
    pub platform: String,
    pub connected: bool,
    pub demo_allowed: bool,
    pub transports: Vec<String>,
    pub serial_ports: Vec<SerialPort>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerialPort {
    pub device: String,
    pub description: String,
    pub usb: bool,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgressEvent {
    pub id: String,
    pub kind: UploadKind,
    pub target: String,
    pub slot: usize,
    pub name: String,
    pub ack: usize,
    pub total_acks: usize,
    pub progress: f64,
    pub bytes_sent: usize,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadCompletion {
    pub cancelled: bool,
    pub result: Option<UploadResult>,
    pub snapshot: DeviceSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunerView {
    pub available: bool,
    pub message: Option<String>,
    pub enabled: bool,
    pub note: String,
    pub cents: f64,
    pub frequency: f64,
    pub reference: f64,
    pub level: f64,
    pub in_tune: bool,
}

fn lock<'a>(state: &'a AppState) -> IpcResult<MutexGuard<'a, Option<Device>>> {
    state
        .device
        .lock()
        .map_err(|_| IpcError::internal("device lock poisoned"))
}

async fn with_device<T, F>(device: Arc<Mutex<Option<Device>>>, operation: F) -> IpcResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Device) -> IpcResult<T> + Send + 'static,
{
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = device
            .lock()
            .map_err(|_| IpcError::internal("device lock poisoned"))?;
        let device = guard
            .as_mut()
            .ok_or_else(|| IpcError::from(ProtocolError::NotConnected))?;
        operation(device)
    })
    .await
    .map_err(|error| IpcError::internal(format!("device worker failed: {error}")))?;
    result
}

#[tauri::command]
pub fn get_bootstrap(app: AppHandle, state: State<'_, AppState>) -> Bootstrap {
    let ports = stomp_transport::list_serial_ports();
    Bootstrap {
        product: "StompStation PRO".to_string(),
        version: app.package_info().version.to_string(),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        connected: state.is_connected(),
        demo_allowed: state.demo_allowed.load(std::sync::atomic::Ordering::SeqCst),
        transports: vec![
            "Wi-Fi".to_string(),
            "USB".to_string(),
            "Manual TCP".to_string(),
        ],
        serial_ports: ports
            .into_iter()
            .map(|port| SerialPort {
                device: port.device,
                description: port.description,
                usb: port.usb,
                vendor_id: port.vendor_id,
                product_id: port.product_id,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn list_serial_ports() -> Vec<SerialPort> {
    stomp_transport::list_serial_ports()
        .into_iter()
        .map(|port| SerialPort {
            device: port.device,
            description: port.description,
            usb: port.usb,
            vendor_id: port.vendor_id,
            product_id: port.product_id,
        })
        .collect()
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    app: AppHandle,
    address: String,
) -> IpcResult<ConnectionInfo> {
    state.stop_poller();
    let device_slot = state.device.clone();
    let info = tauri::async_runtime::spawn_blocking(move || -> IpcResult<ConnectionInfo> {
        let mut device = if let Some(text) = address.strip_prefix("serial:") {
            let (port, baud) = text
                .split_once('@')
                .map(|(port, baud)| (port, baud.parse().unwrap_or(115_200)))
                .unwrap_or((text, 115_200));
            Device::serial(port, baud)
        } else {
            let address = address.strip_prefix("tcp:").unwrap_or(&address);
            let (host, port) = parse_host_port(address).map_err(IpcError::from)?;
            Device::tcp(host, port)
        };
        let info = device.connect().map_err(IpcError::from)?;
        let mut guard = device_slot
            .lock()
            .map_err(|_| IpcError::internal("device lock poisoned"))?;
        if let Some(previous) = guard.as_mut() {
            previous.close();
        }
        *guard = Some(device);
        Ok(info)
    })
    .await
    .map_err(|error| IpcError::internal(format!("connect worker failed: {error}")))??;
    state.start_poller(app);
    Ok(info)
}

#[tauri::command]
pub async fn auto_connect(state: State<'_, AppState>, app: AppHandle) -> IpcResult<ConnectionInfo> {
    state.stop_poller();
    let device_slot = state.device.clone();
    let info = tauri::async_runtime::spawn_blocking(move || -> IpcResult<ConnectionInfo> {
        let mut last_error: Option<String> = None;

        for found in stomp_transport::discover_mdns(Duration::from_millis(2_500))
            .into_iter()
            .filter(|found| found.valid)
        {
            let mut device = Device::tcp(found.host.clone(), found.port);
            match device.connect() {
                Ok(info) => {
                    let mut guard = device_slot
                        .lock()
                        .map_err(|_| IpcError::internal("device lock poisoned"))?;
                    if let Some(previous) = guard.as_mut() {
                        previous.close();
                    }
                    *guard = Some(device);
                    return Ok(info);
                }
                Err(error) => last_error = Some(format!("{}:{} ({error})", found.host, found.port)),
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
            let mut device = Device::serial(port.device.clone(), 115_200);
            match device.connect() {
                Ok(info) => {
                    let mut guard = device_slot
                        .lock()
                        .map_err(|_| IpcError::internal("device lock poisoned"))?;
                    if let Some(previous) = guard.as_mut() {
                        previous.close();
                    }
                    *guard = Some(device);
                    return Ok(info);
                }
                Err(error) => last_error = Some(format!("{} ({error})", port.device)),
            }
        }

        let detail = last_error
            .map(|error| format!(" Last error: {error}."))
            .unwrap_or_default();
        let message = if cfg!(mobile) {
            format!(
                "No StompStation found over Wi-Fi.{detail} Enter the pedal's Wi-Fi address."
            )
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
        Err(IpcError::no_device(message))
    })
    .await
    .map_err(|error| IpcError::internal(format!("auto-connect worker failed: {error}")))??;
    state.start_poller(app);
    Ok(info)
}

#[tauri::command]
pub async fn discover_wifi() -> IpcResult<Vec<stomp_transport::DiscoveredDevice>> {
    tauri::async_runtime::spawn_blocking(|| {
        stomp_transport::discover_mdns(Duration::from_millis(1_500))
    })
    .await
    .map_err(|error| IpcError::internal(format!("discovery worker failed: {error}")))
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> IpcResult<()> {
    state.stop_poller();
    let device = state.device.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = device
            .lock()
            .map_err(|_| IpcError::internal("device lock poisoned"))?;
        if let Some(device) = guard.as_mut() {
            device.close();
        }
        *guard = None;
        Ok(())
    })
    .await
    .map_err(|error| IpcError::internal(format!("disconnect worker failed: {error}")))?
}

#[tauri::command]
pub async fn get_snapshot(state: State<'_, AppState>) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), |device| Ok(device.state())).await
}

#[tauri::command]
pub async fn refresh(state: State<'_, AppState>) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), |device| {
        Ok(device.refresh_full_state()?)
    })
    .await
}

#[tauri::command]
pub async fn select_block(
    state: State<'_, AppState>,
    block_path: String,
) -> IpcResult<BlockEditor> {
    with_device(state.device.clone(), move |device| {
        Ok(device.block_editor(&block_path))
    })
    .await
}

#[tauri::command]
pub async fn set_control(
    state: State<'_, AppState>,
    path: String,
    value: Value,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_value(&path, value)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_block(
    state: State<'_, AppState>,
    block_path: String,
    on: bool,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_block(&block_path, on)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_preset(state: State<'_, AppState>, name: String) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_preset(&name)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn save_preset(
    state: State<'_, AppState>,
    name: Option<String>,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.save_preset(name.as_deref())?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn rename_preset(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.rename_preset(&old_name, &new_name)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn edit_chain(state: State<'_, AppState>, edit: ChainEdit) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.edit_chain(edit)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_master(
    state: State<'_, AppState>,
    control: String,
    value: f64,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_master(&control, value)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_eq_band(
    state: State<'_, AppState>,
    index: usize,
    field: String,
    value: f64,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_eq_band(index, &field, value)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_eq_type(
    state: State<'_, AppState>,
    index: usize,
    value: String,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_eq_type(index, &value)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_eq_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.set_eq_enabled(enabled)?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn set_alias(state: State<'_, AppState>, alias: String) -> IpcResult<DeviceSnapshot> {
    validate_alias(&alias)?;
    with_device(state.device.clone(), move |device| {
        device.set_value(r"root\sys\alias", json!(alias))?;
        Ok(device.state())
    })
    .await
}

#[tauri::command]
pub async fn factory_reset(state: State<'_, AppState>, confirm: String) -> IpcResult<()> {
    if confirm != "RESET" {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "type RESET to confirm the factory reset".into(),
        )));
    }
    with_device(state.device.clone(), |device| {
        device.set_value(r"root\settings\misc\action\factory", json!("run"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn preflight_upload(
    state: State<'_, AppState>,
    kind: String,
    file_path: String,
    target: String,
    slot: Option<usize>,
) -> IpcResult<Preflight> {
    with_device(state.device.clone(), move |device| {
        let kind = parse_upload_kind(&kind)?;
        let path = PathBuf::from(&file_path);
        let raw = std::fs::read(&path)
            .map_err(|error| IpcError::internal(format!("could not read file: {error}")))?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload");
        Ok(device.preflight_upload(kind, &raw, file_name, &target, slot)?)
    })
    .await
}

#[tauri::command]
pub async fn begin_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    kind: String,
    file_path: String,
    target: String,
    slot: Option<usize>,
) -> IpcResult<UploadCompletion> {
    use std::sync::atomic::Ordering;

    if state.upload_active.swap(true, Ordering::SeqCst) {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "another upload is already in flight".into(),
        )));
    }
    state.upload_cancel.store(false, Ordering::SeqCst);
    // Uploads own the transport. The poller must not steal chunk ACKs.
    state.poll_paused.store(true, Ordering::SeqCst);

    let cancel = state.upload_cancel.clone();
    let result = with_device(state.device.clone(), move |device| {
        let kind = parse_upload_kind(&kind)?;
        let path = PathBuf::from(&file_path);
        let raw = std::fs::read(&path)
            .map_err(|error| IpcError::internal(format!("could not read file: {error}")))?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload")
            .to_string();
        let event_app = app.clone();
        let outcome = device.upload_with_progress(
            kind,
            &raw,
            &file_name,
            &target,
            slot,
            |progress: &UploadProgress| {
                let total = progress.total_acks.max(1);
                let _ = event_app.emit(
                    "device://upload",
                    UploadProgressEvent {
                        id: id.clone(),
                        kind: progress.kind,
                        target: progress.target.clone(),
                        slot: progress.slot,
                        name: progress.name.clone(),
                        ack: progress.ack,
                        total_acks: progress.total_acks,
                        progress: (progress.ack as f64 / total as f64) * 100.0,
                        bytes_sent: progress.bytes_sent,
                        total_bytes: progress.total_bytes,
                    },
                );
                !cancel.load(Ordering::SeqCst)
            },
        )?;
        Ok(UploadCompletion {
            cancelled: outcome.is_none(),
            result: outcome,
            snapshot: device.state(),
        })
    })
    .await;

    state.poll_paused.store(false, Ordering::SeqCst);
    state.upload_active.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn cancel_upload(state: State<'_, AppState>) -> bool {
    use std::sync::atomic::Ordering;

    if state.upload_active.load(Ordering::SeqCst) {
        state.upload_cancel.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn delete_list_item(
    state: State<'_, AppState>,
    list_path: String,
    index: usize,
) -> IpcResult<DeviceSnapshot> {
    with_device(state.device.clone(), move |device| {
        device.delete_list_item(&list_path, index)?;
        Ok(device.state())
    })
    .await
}

fn parse_upload_kind(kind: &str) -> IpcResult<UploadKind> {
    match kind {
        "nam" => Ok(UploadKind::Nam),
        "pnam" => Ok(UploadKind::Pnam),
        "ir" => Ok(UploadKind::Ir),
        other => Err(IpcError::from(ProtocolError::InvalidRequest(format!(
            "unknown upload kind: {other}"
        )))),
    }
}

#[tauri::command]
pub async fn tuner_open(state: State<'_, AppState>) -> IpcResult<TunerView> {
    let previous = state.tuner_previous.clone();
    with_device(state.device.clone(), move |device| {
        let on_path = r"root\settings\tuner\on_off";
        if !device.nodes().contains(on_path) {
            return Ok(unavailable_tuner());
        }
        let was_on = device
            .nodes()
            .value_str(on_path)
            .is_some_and(|value| value.eq_ignore_ascii_case("ON"));
        *previous
            .lock()
            .map_err(|_| IpcError::internal("tuner state lock poisoned"))? = Some(was_on);
        if !was_on {
            device.set_value(on_path, json!("ON"))?;
        }
        read_tuner(device)
    })
    .await
}

#[tauri::command]
pub async fn tuner_poll(state: State<'_, AppState>) -> IpcResult<TunerView> {
    with_device(state.device.clone(), read_tuner).await
}

#[tauri::command]
pub async fn tuner_close(state: State<'_, AppState>) -> IpcResult<()> {
    let previous = state.tuner_previous.clone();
    with_device(state.device.clone(), move |device| {
        let on_path = r"root\settings\tuner\on_off";
        let was_on = previous
            .lock()
            .map_err(|_| IpcError::internal("tuner state lock poisoned"))?
            .take()
            .unwrap_or(false);
        if !device.nodes().contains(on_path) {
            return Ok(());
        }
        device.set_value(on_path, json!(if was_on { "ON" } else { "OFF" }))?;
        Ok(())
    })
    .await
}

fn unavailable_tuner() -> TunerView {
    TunerView {
        available: false,
        message: Some("This firmware does not expose a tuner.".to_string()),
        enabled: false,
        note: "—".to_string(),
        cents: 0.0,
        frequency: 0.0,
        reference: 440.0,
        level: -90.0,
        in_tune: false,
    }
}

fn read_tuner(device: &mut Device) -> IpcResult<TunerView> {
    if !device.nodes().contains(r"root\settings\tuner\on_off") {
        return Ok(unavailable_tuner());
    }
    for path in [
        r"root\settings\tuner\on_off",
        r"root\settings\tuner\note",
        r"root\settings\tuner\cents",
        r"root\settings\tuner\freq",
        r"root\settings\tuner\ref",
        r"root\settings\tuner\level",
    ] {
        let _ = device.read_path(path, std::time::Duration::from_millis(700));
    }
    let nodes = device.nodes();
    let cents = nodes.value_f64(r"root\settings\tuner\cents").unwrap_or(0.0);
    Ok(TunerView {
        available: true,
        message: None,
        enabled: nodes
            .value_str(r"root\settings\tuner\on_off")
            .is_some_and(|value| value.eq_ignore_ascii_case("ON")),
        note: nodes
            .value_str(r"root\settings\tuner\note")
            .unwrap_or("—")
            .to_string(),
        cents,
        frequency: nodes.value_f64(r"root\settings\tuner\freq").unwrap_or(0.0),
        reference: nodes.value_f64(r"root\settings\tuner\ref").unwrap_or(440.0),
        level: nodes
            .value_f64(r"root\settings\tuner\level")
            .unwrap_or(-90.0),
        in_tune: cents.abs() <= 3.0,
    })
}

#[tauri::command]
pub async fn copy_diagnostics(app: AppHandle, state: State<'_, AppState>) -> IpcResult<String> {
    let snapshot = with_device(state.device.clone(), |device| Ok(device.state())).await?;
    let transport = {
        let guard = lock(&state)?;
        guard
            .as_ref()
            .map(|device| device.transport_description())
            .unwrap_or_else(|| "disconnected".to_string())
    };
    let mut lines = vec![
        "StompStation PRO diagnostic report".to_string(),
        format!(
            "app {} / {}",
            app.package_info().version,
            std::env::consts::OS
        ),
        format!("transport: {transport}"),
        format!("device: {} ({})", snapshot.device_name, snapshot.device_id),
        format!("firmware: {}", snapshot.firmware),
        format!(
            "preset: {} ({:?})",
            snapshot.preset.current, snapshot.preset.index
        ),
        format!("chain slots: {}", snapshot.chain.slots.len()),
        format!("revision: {}", snapshot.revision),
        "serial ports:".to_string(),
    ];
    for port in stomp_transport::list_serial_ports() {
        lines.push(format!(
            "  {}  {}  usb={}  {:?}:{:?}",
            port.device, port.description, port.usb, port.vendor_id, port.product_id
        ));
    }
    Ok(lines.join("\n"))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalCapture {
    pub path: String,
    pub name: String,
    pub relative: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalScan {
    pub root: String,
    pub files: Vec<LocalCapture>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn scan_captures(directory: String) -> IpcResult<LocalScan> {
    tauri::async_runtime::spawn_blocking(move || scan_captures_impl(directory))
        .await
        .map_err(|error| IpcError::internal(format!("scan worker failed: {error}")))?
}

/// Recursively index .nam / .pnam / .wav captures in a user-selected folder.
/// This is read-only: it never loads a capture into the device.
fn scan_captures_impl(directory: String) -> IpcResult<LocalScan> {
    fn kind_for(path: &std::path::Path) -> Option<&'static str> {
        match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref()
        {
            Some("nam") => Some("nam"),
            Some("pnam") => Some("pnam"),
            Some("wav") => Some("ir"),
            _ => None,
        }
    }

    fn walk(
        root: &std::path::Path,
        directory: &std::path::Path,
        depth: usize,
        files: &mut Vec<LocalCapture>,
    ) {
        if depth > 16 || files.len() >= 5000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if files.len() >= 5000 {
                return;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if name.starts_with('.')
                    || matches!(name.as_str(), "target" | "node_modules" | "vendor")
                {
                    continue;
                }
                walk(root, &path, depth + 1, files);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(kind) = kind_for(&path) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            files.push(LocalCapture {
                path: path.to_string_lossy().to_string(),
                name,
                relative,
                kind: kind.to_string(),
                size: metadata.len(),
            });
        }
    }

    let root = std::path::PathBuf::from(&directory);
    if !root.is_dir() {
        return Err(IpcError::from(ProtocolError::InvalidRequest(format!(
            "not a directory: {directory}"
        ))));
    }
    let mut files = Vec::new();
    walk(&root, &root, 0, &mut files);
    let truncated = files.len() >= 5000;
    files.sort_by(|left, right| {
        left.kind.cmp(&right.kind).then_with(|| {
            left.relative
                .to_lowercase()
                .cmp(&right.relative.to_lowercase())
        })
    });
    Ok(LocalScan {
        root: root.to_string_lossy().to_string(),
        files,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::scan_captures_impl;

    #[test]
    fn scans_capture_files_recursively() {
        let root = std::env::temp_dir().join(format!("stomp-scan-{}", std::process::id()));
        let nested = root.join("sub").join("deeper");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("Amp.nam"), b"{}").unwrap();
        std::fs::write(root.join("Drive.PNAM"), b"{}").unwrap();
        std::fs::write(nested.join("Cab.wav"), b"RIFF").unwrap();
        std::fs::write(root.join("notes.txt"), b"ignore").unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden").join("Hidden.nam"), b"{}").unwrap();

        let scan = scan_captures_impl(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(scan.files.len(), 3);
        assert!(scan
            .files
            .iter()
            .any(|file| file.kind == "nam" && file.name == "Amp.nam"));
        assert!(scan.files.iter().any(|file| file.kind == "pnam"));
        assert!(scan
            .files
            .iter()
            .any(|file| file.kind == "ir" && file.relative.ends_with("Cab.wav")));
        assert!(!scan
            .files
            .iter()
            .any(|file| file.relative.contains(".hidden")));
        let _ = std::fs::remove_dir_all(root);
    }
}
