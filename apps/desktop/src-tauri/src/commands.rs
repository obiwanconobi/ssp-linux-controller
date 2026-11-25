use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use stomp_device::{
    validate_alias, AuthStatus, ChainEdit, ConnectionInfo, Device, DeviceSnapshot, UploadResult,
};
use stomp_protocol::editor::BlockEditor;
use stomp_protocol::{
    ProtocolError, TUNER_FREQ_PATH, TUNER_LEVEL_PATH, TUNER_ON_PATH, TUNER_REF_PATH,
};
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
pub struct DownloadProgressEvent {
    pub id: String,
    pub list_path: String,
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub chunk: usize,
    pub total_chunks: usize,
    pub progress: f64,
    pub bytes: usize,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadFile {
    pub path: String,
    pub list_path: String,
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub extension: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadCompletion {
    pub cancelled: bool,
    pub file: Option<DownloadFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportCompletion {
    pub path: String,
    pub preset_name: String,
    pub dependencies: Vec<String>,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportCompletion {
    pub report: stomp_device::ImportReport,
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
pub async fn connect(
    state: State<'_, AppState>,
    address: String,
    password: Option<String>,
) -> IpcResult<ConnectionInfo> {
    state
        .actor
        .call(|reply| ActorCommand::Connect {
            address,
            password,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn auto_connect(
    state: State<'_, AppState>,
    password: Option<String>,
) -> IpcResult<ConnectionInfo> {
    state
        .actor
        .call(|reply| ActorCommand::AutoConnect { password, reply })
        .await
}

#[tauri::command]
pub async fn set_password(
    state: State<'_, AppState>,
    password: Option<String>,
) -> IpcResult<AuthStatus> {
    state
        .actor
        .call(|reply| ActorCommand::SetPassword { password, reply })
        .await
}

#[tauri::command]
pub fn load_device_password(address: String) -> IpcResult<Option<String>> {
    Ok(crate::credentials::load(&address))
}

#[tauri::command]
pub fn save_device_password(address: String, password: String) -> IpcResult<()> {
    crate::credentials::save(&address, &password)
        .map_err(|error| IpcError::internal(format!("could not save the password: {error}")))
}

#[tauri::command]
pub fn forget_device_password(address: String) -> IpcResult<()> {
    crate::credentials::forget(&address)
        .map_err(|error| IpcError::internal(format!("could not forget the password: {error}")))
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
pub async fn set_input_gain(
    state: State<'_, AppState>,
    channel: u8,
    value: f64,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::SetInputGain {
            channel,
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
pub async fn download_list_item(
    state: State<'_, AppState>,
    id: String,
    list_path: String,
    index: usize,
    destination: String,
    overwrite: bool,
) -> IpcResult<DownloadCompletion> {
    state
        .actor
        .call(|reply| ActorCommand::DownloadListItem {
            id,
            list_path,
            index,
            destination,
            overwrite,
            reply,
        })
        .await
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>) -> bool {
    state.actor.cancel_download()
}

#[tauri::command]
pub async fn export_preset(
    state: State<'_, AppState>,
    index: usize,
    destination: String,
    overwrite: bool,
) -> IpcResult<ExportCompletion> {
    state
        .actor
        .call(|reply| ActorCommand::ExportPreset {
            index,
            destination,
            overwrite,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn preflight_preset_import(
    state: State<'_, AppState>,
    bundle_path: String,
    target_slot: Option<usize>,
) -> IpcResult<stomp_device::ImportPreflight> {
    state
        .actor
        .call(|reply| ActorCommand::PreflightPresetImport {
            bundle_path,
            target_slot,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn import_preset_bundle(
    state: State<'_, AppState>,
    bundle_path: String,
    target_slot: usize,
    overwrite_preset: bool,
    overwrite_dependencies: bool,
) -> IpcResult<ImportCompletion> {
    state
        .actor
        .call(|reply| ActorCommand::ImportPresetBundle {
            bundle_path,
            target_slot,
            overwrite_preset,
            overwrite_dependencies,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn rename_list_item(
    state: State<'_, AppState>,
    list_path: String,
    index: usize,
    new_name: String,
) -> IpcResult<DeviceSnapshot> {
    state
        .actor
        .call(|reply| ActorCommand::RenameListItem {
            list_path,
            index,
            new_name,
            reply,
        })
        .await
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
        "vxamp" => Ok(UploadKind::Vxamp),
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
    if !device.nodes().contains(TUNER_ON_PATH) {
        return unavailable_tuner();
    }
    // Firmware exposes the live values under ...\tuner\tuner. Reading the
    // old guessed paths timed out and queued up polls faster than they could
    // finish, which delayed the OFF write until long after the deck closed.
    for path in [
        TUNER_ON_PATH,
        TUNER_FREQ_PATH,
        TUNER_LEVEL_PATH,
        TUNER_REF_PATH,
    ] {
        let _ = device.read_path(path, std::time::Duration::from_millis(300));
    }
    tuner_view(device.nodes())
}

pub(crate) fn tuner_view(nodes: &stomp_protocol::node::NodeStore) -> TunerView {
    if !nodes.contains(TUNER_ON_PATH) {
        return unavailable_tuner();
    }
    let frequency = nodes.value_f64(TUNER_FREQ_PATH).unwrap_or(0.0);
    let reference = nodes
        .value_f64(TUNER_REF_PATH)
        .filter(|value| *value > 0.0)
        .unwrap_or(440.0);
    let (note, cents) = tuner_note(frequency, reference);
    let enabled = nodes
        .value_str(TUNER_ON_PATH)
        .is_some_and(|value| value.eq_ignore_ascii_case("ON"));
    TunerView {
        available: true,
        message: None,
        enabled,
        note,
        cents,
        frequency,
        reference,
        level: nodes.value_f64(TUNER_LEVEL_PATH).unwrap_or(-90.0),
        in_tune: enabled && frequency > 0.0 && cents.abs() <= 3.0,
    }
}

/// Convert a detected frequency to the nearest note and cents deviation.
fn tuner_note(frequency: f64, reference: f64) -> (String, f64) {
    if frequency <= 0.0 {
        return ("—".to_string(), 0.0);
    }
    let reference = if reference > 0.0 { reference } else { 440.0 };
    let midi = 69.0 + 12.0 * (frequency / reference).log2();
    let nearest = midi.round() as i32;
    let cents = (midi - f64::from(nearest)) * 100.0;
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let name = NAMES[nearest.rem_euclid(12) as usize];
    let octave = nearest.div_euclid(12) - 1;
    (format!("{name}{octave}"), cents)
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
        format!(
            "device password: {}",
            if !status.requires_password {
                "not set"
            } else if status.authenticated {
                "accepted"
            } else {
                "required or rejected"
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

/// Open a StompStation release page in the user's default browser. Restricting
/// the URL to this project's releases keeps the command from becoming a
/// general-purpose launcher for arbitrary web content.
#[tauri::command]
pub fn open_release_page(app: AppHandle, url: String) -> IpcResult<()> {
    const RELEASES_BASE: &str = "https://github.com/obiwanconobi/ssp-linux-controller/releases";
    let allowed = url == RELEASES_BASE || url.starts_with(&format!("{RELEASES_BASE}/"));
    if !allowed {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "only StompStation release pages can be opened".into(),
        )));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| IpcError::internal(format!("could not open the release page: {error}")))
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
            Some("vxamp") | Some("vxam") => Some("vxamp"),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPreset {
    #[serde(default = "block_preset_version")]
    pub version: u32,
    pub name: String,
    pub block_key: String,
    pub block_path: String,
    pub block_label: String,
    pub family: String,
    pub saved_at: String,
    #[serde(default)]
    pub values: serde_json::Map<String, Value>,
}

fn block_preset_version() -> u32 {
    1
}

fn block_presets_root(app: &AppHandle) -> IpcResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("block-presets"))
        .map_err(|error| {
            IpcError::internal(format!("could not resolve the app data directory: {error}"))
        })
}

fn validate_block_key(block_key: &str) -> IpcResult<()> {
    let valid = !block_key.is_empty()
        && block_key.len() <= 64
        && block_key.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        });
    if !valid {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "invalid block preset folder name".into(),
        )));
    }
    Ok(())
}

fn validate_preset_name(name: &str) -> IpcResult<()> {
    if name.is_empty() {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "preset name cannot be empty".into(),
        )));
    }
    if name.len() > 63 {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "preset name must be at most 63 bytes".into(),
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(IpcError::from(ProtocolError::InvalidRequest(
            "preset name cannot contain control characters".into(),
        )));
    }
    Ok(())
}

fn sanitize_file_stem(name: &str) -> String {
    let mut stem: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    while stem.ends_with('.') || stem.ends_with(' ') {
        stem.pop();
    }
    let stem = stem.trim();
    if stem.is_empty() {
        return "preset".to_string();
    }
    let stem: String = stem.chars().take(80).collect();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        format!("_{stem}")
    } else {
        stem
    }
}

fn read_presets_from(directory: &Path) -> IpcResult<Vec<BlockPreset>> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(IpcError::internal(format!(
                "could not read block presets: {error}"
            )))
        }
    };

    let mut presets = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("json"))
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(preset) = serde_json::from_str::<BlockPreset>(&contents) else {
            continue;
        };
        presets.push(preset);
    }
    presets.sort_by_key(|preset| preset.name.to_lowercase());
    Ok(presets)
}

fn find_preset_path(directory: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("json"))
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(preset) = serde_json::from_str::<BlockPreset>(&contents) else {
            continue;
        };
        if preset.name.to_lowercase() == name.to_lowercase() {
            return Some(path);
        }
    }
    None
}

fn unique_preset_path(directory: &Path, stem: &str) -> PathBuf {
    let mut candidate = directory.join(format!("{stem}.json"));
    let mut suffix = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{stem} ({suffix}).json"));
        suffix += 1;
    }
    candidate
}

fn write_preset_file(path: &Path, preset: &BlockPreset) -> IpcResult<()> {
    let json = serde_json::to_string_pretty(preset)
        .map_err(|error| IpcError::internal(format!("could not encode block preset: {error}")))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, format!("{json}\n"))
        .map_err(|error| IpcError::internal(format!("could not write block preset: {error}")))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| {
            IpcError::internal(format!("could not replace block preset: {error}"))
        })?;
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        IpcError::internal(format!("could not finish block preset write: {error}"))
    })
}

fn save_preset_to(directory: &Path, mut preset: BlockPreset) -> IpcResult<BlockPreset> {
    preset.name = preset.name.trim().to_string();
    validate_block_key(&preset.block_key)?;
    validate_preset_name(&preset.name)?;
    std::fs::create_dir_all(directory).map_err(|error| {
        IpcError::internal(format!("could not create the block preset folder: {error}"))
    })?;
    let path = find_preset_path(directory, &preset.name)
        .unwrap_or_else(|| unique_preset_path(directory, &sanitize_file_stem(&preset.name)));
    write_preset_file(&path, &preset)?;
    Ok(preset)
}

fn delete_preset_from(directory: &Path, name: &str) -> IpcResult<bool> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(false);
    }
    let Some(path) = find_preset_path(directory, name) else {
        return Ok(false);
    };
    std::fs::remove_file(path).map_err(|error| {
        IpcError::internal(format!("could not delete the block preset: {error}"))
    })?;
    Ok(true)
}

#[tauri::command]
pub fn list_block_presets(app: AppHandle, block_key: String) -> IpcResult<Vec<BlockPreset>> {
    validate_block_key(&block_key)?;
    let directory = block_presets_root(&app)?.join(&block_key);
    read_presets_from(&directory)
}

#[tauri::command]
pub fn save_block_preset(app: AppHandle, preset: BlockPreset) -> IpcResult<BlockPreset> {
    validate_block_key(&preset.block_key)?;
    let directory = block_presets_root(&app)?.join(&preset.block_key);
    save_preset_to(&directory, preset)
}

#[tauri::command]
pub fn delete_block_preset(app: AppHandle, block_key: String, name: String) -> IpcResult<bool> {
    validate_block_key(&block_key)?;
    let directory = block_presets_root(&app)?.join(&block_key);
    delete_preset_from(&directory, &name)
}

/// Open the per-block preset folder in the system file manager. The folder is
/// created first so the button still works before the first preset is saved.
#[tauri::command]
pub fn open_block_presets_folder(app: AppHandle, block_key: String) -> IpcResult<()> {
    validate_block_key(&block_key)?;
    let directory = block_presets_root(&app)?.join(&block_key);
    std::fs::create_dir_all(&directory).map_err(|error| {
        IpcError::internal(format!("could not create the block preset folder: {error}"))
    })?;
    app.opener()
        .open_path(directory.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| {
            IpcError::internal(format!("could not open the block preset folder: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::{
        delete_preset_from, read_presets_from, sanitize_file_stem, save_preset_to,
        scan_captures_impl, tuner_note, tuner_view, validate_block_key, BlockPreset,
    };
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use stomp_protocol::node::{Node, NodeStore};
    use stomp_protocol::{TUNER_FREQ_PATH, TUNER_LEVEL_PATH, TUNER_ON_PATH, TUNER_REF_PATH};

    fn temporary_directory(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("stomp-{label}-{}-{stamp}", std::process::id()))
    }

    fn sample_preset(name: &str) -> BlockPreset {
        BlockPreset {
            version: 1,
            name: name.to_string(),
            block_key: "drive".to_string(),
            block_path: "root\\app\\drive".to_string(),
            block_label: "Drive / Distortion".to_string(),
            family: "drive".to_string(),
            saved_at: "2026-11-24T13:20:00Z".to_string(),
            values: json!({
                "root\\app\\drive\\gain": 0.55,
                "root\\app\\drive\\model": "Klone 3"
            })
            .as_object()
            .unwrap()
            .clone(),
        }
    }

    fn node(value: serde_json::Value) -> Node {
        Node::new(value.as_object().unwrap().clone())
    }

    #[test]
    fn reads_the_tuner_module_paths_and_computes_the_note() {
        let mut nodes = NodeStore::new();
        nodes.insert(
            TUNER_ON_PATH,
            node(json!({"type":"enum","value":"ON","options":["ON","OFF"]})),
        );
        nodes.insert(TUNER_FREQ_PATH, node(json!({"type":"float","value":110.0})));
        nodes.insert(
            TUNER_LEVEL_PATH,
            node(json!({"type":"float","value":-18.0})),
        );
        nodes.insert(TUNER_REF_PATH, node(json!({"type":"enum","value":"440"})));

        let view = tuner_view(&nodes);
        assert!(view.available);
        assert!(view.enabled);
        assert_eq!(view.note, "A2");
        assert!((view.frequency - 110.0).abs() < f64::EPSILON);
        assert!((view.reference - 440.0).abs() < f64::EPSILON);
        assert!((view.level + 18.0).abs() < f64::EPSILON);
        assert!(view.cents.abs() < 0.01);
        assert!(view.in_tune);
    }

    #[test]
    fn reports_no_pitch_and_unavailable_tuners() {
        assert_eq!(tuner_note(0.0, 440.0), ("—".to_string(), 0.0));
        assert_eq!(tuner_note(440.0, 0.0).0, "A4");
        assert_eq!(tuner_note(261.625_565, 440.0).0, "C4");

        let view = tuner_view(&NodeStore::new());
        assert!(!view.available);
        assert!(!view.enabled);
        assert_eq!(view.note, "—");
    }

    #[test]
    fn scans_capture_files_recursively() {
        let root = std::env::temp_dir().join(format!("stomp-scan-{}", std::process::id()));
        let nested = root.join("sub").join("deeper");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("Amp.nam"), b"{}").unwrap();
        std::fs::write(root.join("Drive.PNAM"), b"{}").unwrap();
        std::fs::write(nested.join("Cab.wav"), b"RIFF").unwrap();
        std::fs::write(root.join("Legacy.vxamp"), b"raw").unwrap();
        std::fs::write(root.join("notes.txt"), b"ignore").unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden").join("Hidden.nam"), b"{}").unwrap();

        let scan = scan_captures_impl(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(scan.files.len(), 4);
        assert!(scan
            .files
            .iter()
            .any(|file| file.kind == "nam" && file.name == "Amp.nam"));
        assert!(scan.files.iter().any(|file| file.kind == "pnam"));
        assert!(scan.files.iter().any(|file| file.kind == "vxamp"));
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

    #[test]
    fn block_preset_files_round_trip_and_overwrite_case_insensitively() {
        let directory = temporary_directory("block-presets");
        std::fs::create_dir_all(&directory).unwrap();

        let saved = save_preset_to(&directory, sample_preset("Klone Lead")).unwrap();
        assert_eq!(saved.name, "Klone Lead");
        assert!(directory.join("Klone Lead.json").exists());

        let mut renamed = sample_preset("KLONE LEAD");
        renamed
            .values
            .insert("root\\app\\drive\\gain".to_string(), json!(0.75));
        save_preset_to(&directory, renamed).unwrap();

        let presets = read_presets_from(&directory).unwrap();
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].name, "KLONE LEAD");
        assert_eq!(
            presets[0]
                .values
                .get("root\\app\\drive\\gain")
                .and_then(Value::as_f64),
            Some(0.75)
        );

        assert!(delete_preset_from(&directory, "klone lead").unwrap());
        assert!(read_presets_from(&directory).unwrap().is_empty());
        assert!(!delete_preset_from(&directory, "klone lead").unwrap());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn block_preset_names_survive_unsafe_file_characters() {
        let directory = temporary_directory("block-presets-names");
        std::fs::create_dir_all(&directory).unwrap();
        save_preset_to(&directory, sample_preset("Lead / Bright: 2")).unwrap();

        let files: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(!files[0].contains('/'));
        assert!(!files[0].contains(':'));

        let presets = read_presets_from(&directory).unwrap();
        assert_eq!(presets[0].name, "Lead / Bright: 2");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn block_preset_storage_rejects_path_traversal_and_corrupt_files() {
        assert!(validate_block_key("drive").is_ok());
        assert!(validate_block_key("delay2").is_ok());
        for key in ["", "../drive", "drive/lead", "drive\\lead", "drive lead"] {
            assert!(validate_block_key(key).is_err(), "{key} should be rejected");
        }
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(sanitize_file_stem("Lead / Bright"), "Lead _ Bright");

        let directory = temporary_directory("block-presets-corrupt");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("broken.json"), b"{not json").unwrap();
        std::fs::write(directory.join("ignored.txt"), b"ignore").unwrap();
        save_preset_to(&directory, sample_preset("Good")).unwrap();
        let presets = read_presets_from(&directory).unwrap();
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].name, "Good");
        let _ = std::fs::remove_dir_all(directory);
    }
}
