use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use stomp_device::{
    validate_alias, ChainEdit, ConnectionInfo, Device, DeviceSnapshot, UploadResult,
};
use stomp_protocol::editor::BlockEditor;
use stomp_protocol::ProtocolError;
use stomp_upload::{Preflight, UploadKind};

use crate::actor::ActorCommand;
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
pub async fn connect(state: State<'_, AppState>, address: String) -> IpcResult<ConnectionInfo> {
    state
        .actor
        .call(|reply| ActorCommand::Connect { address, reply })
        .await
}

#[tauri::command]
pub async fn auto_connect(state: State<'_, AppState>) -> IpcResult<ConnectionInfo> {
    state
        .actor
        .call(|reply| ActorCommand::AutoConnect { reply })
        .await
}

#[tauri::command]
pub async fn discover_wifi() -> IpcResult<Vec<stomp_transport::DiscoveredDevice>> {
    tauri::async_runtime::spawn_blocking(|| {
        stomp_transport::discover_mdns(std::time::Duration::from_millis(1_500))
    })
    .await
    .map_err(|error| IpcError::internal(format!("discovery worker failed: {error}")))
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> IpcResult<()> {
    state
        .actor
        .call(|reply| ActorCommand::Disconnect { reply })
        .await
}

#[tauri::command]
pub async fn get_snapshot(state: State<'_, AppState>) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::Snapshot { reply })
        .await
}

#[tauri::command]
pub async fn refresh(state: State<'_, AppState>) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::Refresh { reply })
        .await
}

#[tauri::command]
pub async fn select_block(
    state: State<'_, AppState>,
    block_path: String,
) -> IpcResult<BlockEditor> {
    state
        .actor
        .call(|reply| ActorCommand::BlockEditor {
            path: block_path,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn set_control(
    state: State<'_, AppState>,
    path: String,
    value: Value,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetValue { path, value, reply })
        .await
}

#[tauri::command]
pub async fn set_block(
    state: State<'_, AppState>,
    block_path: String,
    on: bool,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetBlock {
            path: block_path,
            on,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn set_preset(state: State<'_, AppState>, name: String) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetPreset { name, reply })
        .await
}

#[tauri::command]
pub async fn save_preset(
    state: State<'_, AppState>,
    name: Option<String>,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SavePreset { name, reply })
        .await
}

#[tauri::command]
pub async fn rename_preset(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::RenamePreset {
            old_name,
            new_name,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn edit_chain(state: State<'_, AppState>, edit: ChainEdit) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::EditChain { edit, reply })
        .await
}

#[tauri::command]
pub async fn set_master(
    state: State<'_, AppState>,
    control: String,
    value: f64,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetMaster {
            control,
            value,
            reply,
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
    state
        .actor
        .call(|reply| ActorCommand::SetEqBand {
            index,
            field,
            value,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn set_eq_type(
    state: State<'_, AppState>,
    index: usize,
    value: String,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetEqType {
            index,
            value,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn set_eq_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetEqEnabled { enabled, reply })
        .await
}

#[tauri::command]
pub async fn set_alias(state: State<'_, AppState>, alias: String) -> IpcResult<DeviceSnapshot> {
    validate_alias(&alias)?;
    state
        .actor
        .call(|reply| ActorCommand::SetAlias { alias, reply })
        .await
}

#[tauri::command]
pub async fn factory_reset(state: State<'_, AppState>, confirm: String) -> IpcResult<()> {
    if confirm != "RESET" {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "type RESET to confirm the factory reset".into(),
        )));
    }
    state
        .actor
        .call(|reply| ActorCommand::FactoryReset { reply })
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
    let kind = parse_upload_kind(&kind)?;
    state
        .actor
        .call(|reply| ActorCommand::PreflightUpload {
            kind,
            file_path,
            target,
            slot,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn begin_upload(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    file_path: String,
    target: String,
    slot: Option<usize>,
) -> IpcResult<UploadCompletion> {
    let kind = parse_upload_kind(&kind)?;
    state
        .actor
        .call(|reply| ActorCommand::BeginUpload {
            id,
            kind,
            file_path,
            target,
            slot,
            reply,
        })
        .await
}

#[tauri::command]
pub fn cancel_upload(state: State<'_, AppState>) -> bool {
    state.actor.cancel_upload()
}

#[tauri::command]
pub async fn delete_list_item(
    state: State<'_, AppState>,
    list_path: String,
    index: usize,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::DeleteListItem {
            list_path,
            index,
            reply,
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
    state
        .actor
        .call(|reply| ActorCommand::TunerOpen { reply })
        .await
}

#[tauri::command]
pub async fn tuner_poll(state: State<'_, AppState>) -> IpcResult<TunerView> {
    state
        .actor
        .call(|reply| ActorCommand::TunerPoll { reply })
        .await
}

#[tauri::command]
pub async fn tuner_close(state: State<'_, AppState>) -> IpcResult<()> {
    state
        .actor
        .call(|reply| ActorCommand::TunerClose { reply })
        .await
}

pub(crate) fn unavailable_tuner() -> TunerView {
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

pub(crate) fn read_tuner(device: &mut Device) -> TunerView {
    if !device.nodes().contains(r"root\settings\tuner\on_off") {
        return unavailable_tuner();
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
    TunerView {
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
    }
}

#[tauri::command]
pub async fn copy_diagnostics(app: AppHandle, state: State<'_, AppState>) -> IpcResult<String> {
    let diagnostics = state
        .actor
        .call(|reply| ActorCommand::Diagnostics { reply })
        .await?;
    let status = &diagnostics.status;
    let mut lines = vec![
        "StompStation PRO diagnostic report".to_string(),
        format!(
            "app {} / {}",
            app.package_info().version,
            std::env::consts::OS
        ),
        format!("transport: {}", status.transport),
        format!(
            "connection: {}",
            if status.connected {
                "connected"
            } else {
                "offline"
            }
        ),
        format!("pending writes: {}", status.pending_writes),
        format!("reconnect attempts: {}", status.reconnect_attempt),
    ];
    if let Some(error) = status.last_error.as_deref() {
        lines.push(format!("last error: {error}"));
    }
    if let Some(snapshot) = diagnostics.snapshot.as_ref() {
        lines.push(format!(
            "device: {} ({})",
            snapshot.device_name, snapshot.device_id
        ));
        lines.push(format!("firmware: {}", snapshot.firmware));
        lines.push(format!(
            "preset: {} ({:?})",
            snapshot.preset.current, snapshot.preset.index
        ));
        lines.push(format!("chain slots: {}", snapshot.chain.slots.len()));
        lines.push(format!("revision: {}", snapshot.revision));
    } else {
        lines.push("device: not connected".to_string());
    }
    lines.push("serial ports:".to_string());
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
