//! Synchronous device core. The Phase 0/1 actor wraps this behind one owner;
//! the type itself owns the transport, cache, and revision counter.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use stomp_preset_bundle::{
    dependency_archive_path, read_bundle, write_bundle_to_vec, BundleDependency, BundleError,
    BundleManifest, DependencyManifest,
};
use stomp_protocol::command;
use stomp_protocol::editor::{block_editor, BlockEditor};
use stomp_protocol::frame::{parse_message, FrameBuffer, ParsedLine};
use stomp_protocol::node::NodeStore;
use stomp_protocol::preset::{
    list_name_error, preset_name_error, preset_references, preset_state, presets_using, rename_hex,
    PresetState,
};
use stomp_protocol::router::{available_blocks, chain_blocks, load_chain, ChainSlot, LinkType};
use stomp_protocol::{
    normalize_path, path_name, path_parent, ProtocolError, CHUNK_SIZE, DEFAULT_CHAIN, IR_PATH,
    NAME_SIZE, NAM_DRIVE_PATH, NAM_PATH, PNAM_DRIVE_PATH, PNAM_PATH, PRESET_LIST_PATH, PRESET_PATH,
    VXAMP_PATH, VXAMP_SLOT_SIZE,
};
use stomp_transport::{ScriptedTransport, SerialTransport, TcpTransport, Transport};
use stomp_upload::{
    decode_downloaded_model, decode_ir, encode_ir_wav, preflight, prepare_upload, validate_capture,
    AckOutcome, Preflight, PreparedUpload, UploadKind, UploadState,
};

use crate::snapshot::{
    capabilities, device_info, eq_view, input_view, library_lists, master_view, meters,
    AvailableBlock, ChainView, DeviceSnapshot, PresetView, INPUT_GAIN_1_PATH, INPUT_GAIN_2_PATH,
};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(3_000);
pub const BROWSE_TIMEOUT: Duration = Duration::from_millis(8_000);
/// Firmware 2.5.3 stores one 32 KiB `.pst` payload per preset list slot.
pub const PRESET_SLOT_SIZE: usize = 32 * 1024;
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub address: String,
    pub transport: String,
    pub device_name: String,
    pub firmware: String,
    pub node_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UploadResult {
    pub target: String,
    pub slot: usize,
    pub name: String,
    pub chunks: usize,
    pub payload_bytes: usize,
}

/// One ACK boundary during an upload.
///
/// `ack` counts acknowledged chunks, including the name chunk, so it starts at
/// zero and reaches `total_acks` after the final ACK.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UploadProgress {
    pub kind: UploadKind,
    pub target: String,
    pub slot: usize,
    pub name: String,
    pub ack: usize,
    pub total_acks: usize,
    pub bytes_sent: usize,
    pub total_bytes: usize,
}

/// One downloaded list item. `raw` is the original file bytes (decompressed for
/// NAM/PNAM); it is not sent across the Tauri boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadedListFile {
    pub list_path: String,
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub extension: String,
    pub compressed: bool,
    pub bytes: usize,
    #[serde(skip)]
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PresetExport {
    pub preset_name: String,
    pub preset_index: usize,
    pub dependencies: Vec<String>,
    pub archive_bytes: usize,
    #[serde(skip)]
    pub archive: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportDependencyPlan {
    pub name: String,
    pub extension: String,
    pub node_path: String,
    pub archive_path: String,
    pub bytes: usize,
    pub existing_index: Option<usize>,
    pub target_index: Option<usize>,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportPreflight {
    pub preset_name: String,
    pub preset_bytes: usize,
    pub preset_entries: usize,
    pub chain_blocks: Vec<String>,
    pub chain_changes: Vec<String>,
    pub target_slot: Option<usize>,
    pub target_occupied_by: Option<String>,
    pub empty_slots: Vec<usize>,
    pub dependencies: Vec<ImportDependencyPlan>,
    pub blocked: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportOptions {
    pub target_slot: usize,
    pub overwrite_preset: bool,
    pub overwrite_dependencies: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportReport {
    pub preset_name: String,
    pub target_slot: usize,
    pub dependencies_written: Vec<String>,
    pub dependencies_reused: Vec<String>,
    pub preset_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub list_path: String,
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub chunk: usize,
    pub total_chunks: usize,
    pub bytes: usize,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChainEdit {
    Add {
        row: usize,
        col: usize,
        path: String,
    },
    Remove {
        row: usize,
        col: usize,
    },
    Move {
        from: (usize, usize),
        to: (usize, usize),
    },
    Link {
        row: usize,
        col: usize,
        parallel: bool,
    },
    Replace {
        row: usize,
        col: usize,
        path: String,
    },
    Clear,
}

pub struct Device {
    transport: Box<dyn Transport>,
    address: String,
    rx: FrameBuffer,
    nodes: NodeStore,
    connected: bool,
    revision: u64,
}

impl Device {
    pub fn new(transport: impl Transport + 'static) -> Self {
        let transport = Box::new(transport);
        let address = transport.description();
        Self {
            transport,
            address,
            rx: FrameBuffer::new(),
            nodes: NodeStore::new(),
            connected: false,
            revision: 0,
        }
    }

    pub fn serial(port: impl Into<String>, baud: u32) -> Self {
        let port = port.into();
        let mut device = Self::new(SerialTransport::new(port.clone(), baud));
        device.address = format!("serial:{port}@{baud}");
        device
    }

    pub fn tcp(host: impl Into<String>, port: u16) -> Self {
        let host = host.into();
        let mut device = Self::new(TcpTransport::new(host.clone(), port));
        device.address = if host.contains(':') {
            format!("tcp:[{host}]:{port}")
        } else {
            format!("tcp:{host}:{port}")
        };
        device
    }

    pub fn scripted(steps: Vec<stomp_transport::Step>) -> Self {
        Self::new(ScriptedTransport::new(steps))
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn nodes(&self) -> &NodeStore {
        &self.nodes
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn transport_description(&self) -> String {
        self.transport.description()
    }

    pub fn connection_info(&self) -> ConnectionInfo {
        let (device_name, firmware, _, _) = device_info(&self.nodes);
        ConnectionInfo {
            address: self.address.clone(),
            transport: self.transport.description(),
            device_name,
            firmware,
            node_count: self.nodes.len(),
        }
    }

    // ---- connection -----------------------------------------------------

    pub fn connect(&mut self) -> Result<ConnectionInfo, ProtocolError> {
        self.transport.open()?;
        self.rx.clear();
        self.connected = false;

        // Consume an optional immediate token announcement.
        let _ = self.read_frame(Duration::from_millis(350), Duration::from_millis(150));

        let name_command = command_text(command::read(r"root\sys\_name"))?;
        let _ = self.request(
            &name_command,
            |lines| lines.iter().any(|line| line.path == r"root\sys\_name"),
            Duration::from_millis(2_000),
            Duration::from_millis(250),
            false,
        );

        self.refresh_full_state()?;
        self.connected = true;
        self.revision += 1;
        Ok(self.connection_info())
    }

    pub fn close(&mut self) {
        self.connected = false;
        self.transport.close();
    }

    pub fn refresh_full_state(&mut self) -> Result<DeviceSnapshot, ProtocolError> {
        let browsed = match self.browse_root() {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!(%error, "browse root unavailable; trying read root");
                0
            }
        };
        let _ = self.read_root();
        if browsed == 0 {
            for path in [
                r"root\app\preset",
                r"root\presets",
                r"root\app\router",
                r"root\app\output",
                r"root\sys\_name",
                r"root\sys\_ver",
                r"root\sys\_id",
                r"root\usb\_status",
                IR_PATH,
            ] {
                let _ = self.read_path(path, Duration::from_millis(800));
            }
        }
        self.revision += 1;
        Ok(self.state())
    }

    pub fn reload(&mut self) -> Result<DeviceSnapshot, ProtocolError> {
        self.refresh_full_state()
    }

    // ---- framing --------------------------------------------------------

    fn read_frame(&mut self, timeout: Duration, idle: Duration) -> Result<Vec<u8>, ProtocolError> {
        if let Some(frame) = self.rx.take_message() {
            return Ok(frame);
        }
        let deadline = Instant::now() + timeout;
        let mut last_data = Instant::now();
        let mut buffer = [0u8; 4096];
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let wait = (deadline - now).min(Duration::from_millis(100));
            let count = self.transport.read(&mut buffer, wait)?;
            if count > 0 {
                self.rx.push(&buffer[..count]);
                last_data = Instant::now();
                if let Some(frame) = self.rx.take_message() {
                    return Ok(frame);
                }
            } else if !self.rx.is_empty() && Instant::now().duration_since(last_data) >= idle {
                if let Some(frame) = self.rx.take_pending() {
                    return Ok(frame);
                }
            }
        }
        if let Some(frame) = self.rx.take_pending() {
            return Ok(frame);
        }
        Err(ProtocolError::Timeout)
    }

    fn request<F>(
        &mut self,
        command: &str,
        matcher: F,
        timeout: Duration,
        idle: Duration,
        accept_empty: bool,
    ) -> Result<Vec<ParsedLine>, ProtocolError>
    where
        F: Fn(&[ParsedLine]) -> bool,
    {
        if command.contains('\0') {
            return Err(ProtocolError::InvalidRequest(
                "outgoing command contains a NUL byte".into(),
            ));
        }
        let mut framed = Vec::with_capacity(command.len() + 3);
        framed.extend_from_slice(command.as_bytes());
        framed.extend_from_slice(b"\r\n\0");
        if let Err(error) = self.transport.write_all(&framed) {
            self.connected = false;
            return Err(error);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ProtocolError::Timeout);
            }
            let frame = self.read_frame(remaining, idle)?;
            let text = String::from_utf8_lossy(&frame);
            let lines = parse_message(&text)?;
            self.handle_lines(&lines)?;
            if (accept_empty && lines.is_empty()) || matcher(&lines) {
                return Ok(lines);
            }
        }
    }

    fn handle_lines(&mut self, lines: &[ParsedLine]) -> Result<(), ProtocolError> {
        for line in lines {
            if line.command.as_deref() == Some("token") {
                let secure = line
                    .object()
                    .and_then(|object| object.get("secure"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if secure {
                    return Err(ProtocolError::AuthenticationRequired(
                        "this device requires a password; the VoidX token hash is not implemented"
                            .into(),
                    ));
                }
                continue;
            }
            if !is_interesting_path(&line.path) {
                continue;
            }
            let Some(object) = line.object() else {
                continue;
            };
            if line.command.as_deref() == Some("dread") {
                // `dread` payload lines are transfer bytes, not node fields.
                // Merging them would replace a list's `value` array with the
                // last hex chunk.
                continue;
            }
            if line.command.as_deref() == Some("dwrite")
                && (object.contains_key("index") || object.contains_key("chunk"))
            {
                continue;
            }
            self.nodes.merge(&line.path, object);
        }
        Ok(())
    }

    pub fn browse_root(&mut self) -> Result<usize, ProtocolError> {
        let browse_command = command_text(command::browse_root())?;
        let lines = self.request(
            &browse_command,
            |lines| {
                if lines.is_empty() {
                    return false;
                }
                if let Some(root) = lines.iter().find(|line| line.path == "root") {
                    if root
                        .object()
                        .is_some_and(|object| object.contains_key("type"))
                    {
                        return true;
                    }
                }
                let typed = lines
                    .iter()
                    .filter(|line| {
                        line.object()
                            .is_some_and(|object| object.contains_key("type"))
                    })
                    .count();
                typed >= 10 || lines.len() >= 40
            },
            BROWSE_TIMEOUT,
            Duration::from_millis(500),
            false,
        )?;

        let mut snapshot = indexmap::IndexMap::new();
        for line in &lines {
            if line.command.is_some() {
                continue;
            }
            if is_interesting_path(&line.path) && line.object().is_some() {
                snapshot.insert(line.path.clone(), line.value.clone());
            }
        }
        if snapshot.len() >= 10 {
            self.nodes
                .replace_from_pairs(snapshot.into_iter().collect())?;
            Ok(self.nodes.len())
        } else {
            // Values-only fallback: merge into the existing tree instead.
            for line in &lines {
                if let Some(object) = line.object() {
                    if is_interesting_path(&line.path) && line.command.is_none() {
                        self.nodes.merge(&line.path, object);
                    }
                }
            }
            Ok(self.nodes.len())
        }
    }

    pub fn read_root(&mut self) -> Result<Vec<ParsedLine>, ProtocolError> {
        let root_command = command_text(command::read("root"))?;
        self.request(
            &root_command,
            |_| true,
            Duration::from_millis(2_000),
            Duration::from_millis(200),
            true,
        )
    }

    pub fn read_path(
        &mut self,
        path: &str,
        timeout: Duration,
    ) -> Result<Vec<ParsedLine>, ProtocolError> {
        let expected = normalize_path(path);
        let read_command = command_text(command::read(path))?;
        self.request(
            &read_command,
            |lines| lines.iter().any(|line| line.path == expected),
            timeout,
            Duration::from_millis(250),
            false,
        )
    }

    // ---- writes ---------------------------------------------------------

    fn write_payload(&mut self, path: &str, payload: Value) -> Result<(), ProtocolError> {
        let command_text = command_text(command::write_raw(path, &payload)?)?;
        let expected = normalize_path(path);
        self.request(
            &command_text,
            |lines| lines.iter().any(|line| line.path == expected),
            DEFAULT_TIMEOUT,
            Duration::from_millis(250),
            false,
        )?;
        if let Some(value) = payload.get("value") {
            self.nodes.set_value(path, value.clone());
        }
        self.revision += 1;
        Ok(())
    }

    pub fn set_value(&mut self, path: &str, value: Value) -> Result<(), ProtocolError> {
        self.write_payload(path, json!({ "value": value }))
    }

    pub fn set_block(&mut self, block_path: &str, on: bool) -> Result<(), ProtocolError> {
        let on_path = format!("{block_path}\\on_off");
        self.set_value(&on_path, json!(if on { "ON" } else { "OFF" }))
    }

    pub fn set_preset(&mut self, name: &str) -> Result<(), ProtocolError> {
        let preset = preset_state(&self.nodes);
        let path = preset.path.unwrap_or_else(|| PRESET_PATH.to_string());
        self.set_value(&path, json!(name))
    }

    pub fn save_preset(&mut self, name: Option<&str>) -> Result<(), ProtocolError> {
        let preset = preset_state(&self.nodes);
        let target = preset.path.unwrap_or_else(|| PRESET_PATH.to_string());
        let requested = name.map(str::to_string);
        let name = requested.clone().unwrap_or_else(|| preset.current.clone());
        if name.is_empty() {
            return Err(ProtocolError::InvalidRequest(
                "there is no current preset to save".into(),
            ));
        }
        if let Some(problem) = preset_name_error(&name) {
            return Err(ProtocolError::InvalidRequest(problem.into()));
        }
        if requested.is_some()
            && preset.names.iter().any(|existing| {
                !existing.is_empty() && existing.to_lowercase() == name.to_lowercase()
            })
        {
            return Err(ProtocolError::InvalidRequest(format!(
                "a preset named {name:?} already exists"
            )));
        }
        self.write_payload(&target, json!({ "value": name, "save": "save" }))
    }

    pub fn rename_preset(&mut self, old_name: &str, new_name: &str) -> Result<(), ProtocolError> {
        let preset = preset_state(&self.nodes);
        let list_path = preset
            .list_path
            .clone()
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        if let Some(problem) = preset_name_error(new_name) {
            return Err(ProtocolError::InvalidRequest(problem.into()));
        }
        let Some(index) = preset.names.iter().position(|name| name == old_name) else {
            return Err(ProtocolError::InvalidRequest(format!(
                "preset {old_name:?} is not in the list"
            )));
        };
        if new_name != old_name {
            for (other, existing) in preset.names.iter().enumerate() {
                if other != index
                    && !existing.is_empty()
                    && existing.to_lowercase() == new_name.to_lowercase()
                {
                    return Err(ProtocolError::InvalidRequest(format!(
                        "a preset named {new_name:?} already exists"
                    )));
                }
            }
        }

        let (ack_index, ack_chunk) =
            self.dwrite_ack(&list_path, index as i64, -1, &rename_hex(new_name))?;
        if ack_index != -1 && ack_index != index as i64 {
            return Err(ProtocolError::UploadRejected(format!(
                "device acknowledged the wrong slot for rename (wanted {index}, got {ack_index})"
            )));
        }
        if ack_chunk != -1 {
            return Err(ProtocolError::Protocol("rename did not finish".into()));
        }
        let _ = self.read_path(&list_path, DEFAULT_TIMEOUT);
        let _ = self.read_path(
            &preset.path.unwrap_or_else(|| PRESET_PATH.to_string()),
            DEFAULT_TIMEOUT,
        );
        self.revision += 1;
        Ok(())
    }

    fn dwrite_ack(
        &mut self,
        path: &str,
        index: i64,
        chunk: i64,
        value: &str,
    ) -> Result<(i64, i64), ProtocolError> {
        let command_text = command_text(command::dwrite(path, index, chunk, value)?)?;
        let expected = normalize_path(path);
        let lines = self.request(
            &command_text,
            |lines| {
                lines.iter().any(|line| {
                    line.command.as_deref() == Some("dwrite")
                        && line.path == expected
                        && line.ack().is_some()
                })
            },
            Duration::from_millis(15_000),
            Duration::from_millis(400),
            false,
        )?;
        lines
            .iter()
            .find_map(ParsedLine::ack)
            .ok_or_else(|| ProtocolError::Protocol("no valid dwrite ACK".into()))
    }

    // ---- chain editing --------------------------------------------------

    pub fn chain_slots(&self) -> Vec<ChainSlot> {
        load_chain(&self.nodes)
            .map(|layout| layout.slots(&self.nodes))
            .unwrap_or_default()
    }

    pub fn available_blocks(&self) -> Vec<AvailableBlock> {
        available_blocks(&self.nodes)
            .into_iter()
            .map(|value| AvailableBlock {
                path: value["path"].as_str().unwrap_or_default().to_string(),
                name: value["name"].as_str().unwrap_or_default().to_string(),
                desc: value["desc"].as_str().unwrap_or_default().to_string(),
            })
            .collect()
    }

    pub fn edit_chain(&mut self, edit: ChainEdit) -> Result<(), ProtocolError> {
        let mut layout = load_chain(&self.nodes).ok_or_else(|| {
            ProtocolError::Unsupported("the device does not expose a signal-chain router".into())
        })?;
        let router_path = layout.router_path.clone().unwrap_or_default();
        match edit {
            ChainEdit::Add { row, col, path } => {
                let path = normalize_path(&path);
                let node = self.nodes.get(&path).ok_or_else(|| {
                    ProtocolError::InvalidRequest("that block is not available".into())
                })?;
                if node.item_type() != "block" {
                    return Err(ProtocolError::InvalidRequest(
                        "that node is not a block".into(),
                    ));
                }
                if layout
                    .slots(&self.nodes)
                    .iter()
                    .any(|slot| slot.path.as_deref() == Some(path.as_str()))
                {
                    return Err(ProtocolError::InvalidRequest(
                        "that block is already in the signal chain".into(),
                    ));
                }
                layout.set_slot(row, col, Some(&path))?;
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
                self.enable_ancestors(&path);
            }
            ChainEdit::Remove { row, col } => {
                if layout.cell_fixed(row, col) {
                    return Err(ProtocolError::InvalidRequest(
                        "fixed blocks cannot be removed".into(),
                    ));
                }
                layout.set_slot(row, col, None)?;
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
            }
            ChainEdit::Move { from, to } => {
                layout.move_block(from.0, from.1, to.0, to.1)?;
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
            }
            ChainEdit::Replace { row, col, path } => {
                let path = normalize_path(&path);
                let node = self.nodes.get(&path).ok_or_else(|| {
                    ProtocolError::InvalidRequest("that block is not available".into())
                })?;
                if node.item_type() != "block" {
                    return Err(ProtocolError::InvalidRequest(
                        "that node is not a block".into(),
                    ));
                }
                if layout
                    .slots(&self.nodes)
                    .iter()
                    .any(|slot| slot.path.as_deref() == Some(path.as_str()))
                {
                    return Err(ProtocolError::InvalidRequest(
                        "that block is already in the signal chain".into(),
                    ));
                }
                layout.set_slot(row, col, Some(&path))?;
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
                self.enable_ancestors(&path);
            }
            ChainEdit::Link { row, col, parallel } => {
                layout.set_link(row, col, parallel)?;
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
            }
            ChainEdit::Clear => {
                layout.clear();
                self.write_payload(&router_path, json!({ "value": layout.value() }))?;
            }
        }
        self.revision += 1;
        Ok(())
    }

    fn enable_ancestors(&mut self, block_path: &str) {
        let mut path = normalize_path(block_path);
        while !path.is_empty() && path != "root" {
            let on_path = format!("{path}\\on_off");
            if self
                .nodes
                .value_str(&on_path)
                .is_some_and(|value| !value.eq_ignore_ascii_case("ON"))
            {
                let _ = self.set_value(&on_path, json!("ON"));
            }
            path = path_parent(&path).to_string();
        }
    }

    pub fn chain_link(&self, row: usize, col: usize) -> Result<LinkType, ProtocolError> {
        load_chain(&self.nodes)
            .ok_or_else(|| {
                ProtocolError::Unsupported(
                    "the device does not expose a signal-chain router".into(),
                )
            })?
            .link_into(row, col)
    }

    // ---- editor / EQ / master -------------------------------------------

    pub fn block_editor(&self, block_path: &str) -> BlockEditor {
        block_editor(&self.nodes, block_path)
    }

    pub fn set_eq_band(
        &mut self,
        index: usize,
        field: &str,
        value: f64,
    ) -> Result<(), ProtocolError> {
        let eq = eq_view(&self.nodes)
            .ok_or_else(|| ProtocolError::Unsupported("this firmware has no global EQ".into()))?;
        let name = match field {
            "gain" => format!("band_{index}"),
            "frequency" => format!("freq_{index}"),
            "q" => format!("q_{index}"),
            other => {
                return Err(ProtocolError::InvalidRequest(format!(
                    "unknown EQ field {other}"
                )))
            }
        };
        let editor = block_editor(&self.nodes, &eq.path);
        let control = editor
            .flatten_controls()
            .into_iter()
            .find(|control| control.name == name)
            .ok_or_else(|| ProtocolError::Unsupported(format!("EQ band {index} is not exposed")))?;
        self.set_value(&control.path, json!(value))
    }

    pub fn set_eq_type(&mut self, index: usize, value: &str) -> Result<(), ProtocolError> {
        let eq = eq_view(&self.nodes)
            .ok_or_else(|| ProtocolError::Unsupported("this firmware has no global EQ".into()))?;
        let editor = block_editor(&self.nodes, &eq.path);
        let control = editor
            .flatten_controls()
            .into_iter()
            .find(|control| control.name == format!("type_{index}"))
            .ok_or_else(|| ProtocolError::Unsupported(format!("EQ band {index} is not exposed")))?;
        self.set_value(&control.path, json!(value))
    }

    pub fn set_eq_enabled(&mut self, enabled: bool) -> Result<(), ProtocolError> {
        let eq = eq_view(&self.nodes)
            .ok_or_else(|| ProtocolError::Unsupported("this firmware has no global EQ".into()))?;
        self.set_value(&eq.on_path, json!(if enabled { "ON" } else { "OFF" }))
    }

    /// Write one input channel's digital gain. These are global settings, not
    /// preset data, so they deliberately do not touch the preset dirty state.
    pub fn set_input_gain(&mut self, channel: u8, value: f64) -> Result<(), ProtocolError> {
        let path = match channel {
            1 => INPUT_GAIN_1_PATH,
            2 => INPUT_GAIN_2_PATH,
            other => {
                return Err(ProtocolError::InvalidRequest(format!(
                    "unknown input channel {other}"
                )))
            }
        };
        if !value.is_finite() {
            return Err(ProtocolError::InvalidRequest(
                "input gain must be a finite number".into(),
            ));
        }
        let node = self.nodes.get(path).ok_or_else(|| {
            ProtocolError::Unsupported(format!("input {channel} gain is not exposed"))
        })?;
        let min = node.min().unwrap_or(-15.0);
        let max = node.max().unwrap_or(15.0);
        if value < min - 1e-6 || value > max + 1e-6 {
            return Err(ProtocolError::InvalidRequest(format!(
                "input {channel} gain must be between {min} and {max} dB"
            )));
        }
        self.set_value(path, json!(value))
    }

    pub fn set_master(&mut self, kind: &str, value: f64) -> Result<(), ProtocolError> {
        let master = master_view(&self.nodes);
        let control = match kind {
            "volume" => master.volume,
            "tempo" => master.tempo,
            "preset_level" => master.preset_level,
            other => {
                return Err(ProtocolError::InvalidRequest(format!(
                    "unknown master control {other}"
                )))
            }
        }
        .ok_or_else(|| ProtocolError::Unsupported(format!("{kind} is not exposed")))?;
        self.set_value(&control.id, json!(value))
    }

    // ---- uploads --------------------------------------------------------

    pub fn preflight_upload(
        &self,
        kind: UploadKind,
        raw: &[u8],
        file_name: &str,
        target: &str,
        slot: Option<usize>,
    ) -> Result<Preflight, ProtocolError> {
        let list = self
            .nodes
            .get(target)
            .ok_or_else(|| ProtocolError::Unsupported(format!("{target} is not available")))?;
        // Uploads are limited to the model/IR capture lists. This rejects a
        // wrong-kind target (including non-capture lists) before any bytes are
        // sent, so a UI bug cannot turn into a device write. Do not widen this
        // to arbitrary lists; see `docs/DEVICE_SAFETY.md`.
        let expected = match kind {
            UploadKind::Nam => "nam",
            UploadKind::Pnam => "pnam",
            UploadKind::Ir => "ir",
            UploadKind::Vxamp => "vxamp",
        };
        let item_type = list.item_type().to_ascii_lowercase();
        let known_capture_path = matches!(
            normalize_path(target).as_str(),
            NAM_PATH | NAM_DRIVE_PATH | PNAM_PATH | PNAM_DRIVE_PATH | IR_PATH | VXAMP_PATH
        );
        if !known_capture_path {
            return Err(ProtocolError::InvalidRequest(format!(
                "{target} is not a supported capture list; uploads are limited to \
                 the NAM/PNAM/IR/VXAMP lists"
            )));
        }
        // Firmware tags list types in several forms: "ir", "wav", and rate
        // suffixed variants such as "wav_48000"; older builds may omit the
        // type entirely.
        let suffix = format!("{expected}_");
        let type_matches = item_type == expected
            || item_type.is_empty()
            || item_type.starts_with(&suffix)
            || (kind == UploadKind::Ir
                && (item_type == "wav"
                    || item_type.starts_with("wav_")
                    || item_type.starts_with("ir_")));
        if !type_matches {
            return Err(ProtocolError::InvalidRequest(format!(
                "{} cannot be uploaded to {target}: expected capture list type {expected}, found {}",
                kind.label(),
                if item_type.is_empty() {
                    "untyped"
                } else {
                    item_type.as_str()
                }
            )));
        }
        let names: Vec<String> = list
            .value()
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        preflight(
            kind,
            raw,
            file_name,
            &names,
            slot,
            list.size().map(|size| size as usize),
        )
    }

    pub fn upload(
        &mut self,
        kind: UploadKind,
        raw: &[u8],
        file_name: &str,
        target: &str,
        slot: Option<usize>,
    ) -> Result<UploadResult, ProtocolError> {
        self.upload_with_progress(kind, raw, file_name, target, slot, |_| true)?
            .ok_or_else(|| ProtocolError::Protocol("upload was cancelled unexpectedly".into()))
    }

    pub fn upload_named(
        &mut self,
        kind: UploadKind,
        raw: &[u8],
        file_name: &str,
        name: &str,
        target: &str,
        slot: Option<usize>,
    ) -> Result<UploadResult, ProtocolError> {
        self.upload_named_with_progress(kind, raw, file_name, Some(name), target, slot, |_| true)?
            .ok_or_else(|| ProtocolError::Protocol("upload was cancelled unexpectedly".into()))
    }

    /// Upload while reporting each ACK boundary.
    ///
    /// The callback returns `true` to continue or `false` to stop before the
    /// next chunk. Cancelling after the final ACK still completes the upload.
    /// `Ok(None)` means the caller cancelled before the final ACK.
    pub fn upload_with_progress<F>(
        &mut self,
        kind: UploadKind,
        raw: &[u8],
        file_name: &str,
        target: &str,
        slot: Option<usize>,
        on_progress: F,
    ) -> Result<Option<UploadResult>, ProtocolError>
    where
        F: FnMut(&UploadProgress) -> bool,
    {
        self.upload_named_with_progress(kind, raw, file_name, None, target, slot, on_progress)
    }

    /// Upload a capture while forcing the list slot name. Bundle import uses
    /// this so the dependency keeps the name recorded in `bdinfo.json` instead
    /// of whatever metadata the capture happens to contain.
    #[allow(clippy::too_many_arguments)]
    pub fn upload_named_with_progress<F>(
        &mut self,
        kind: UploadKind,
        raw: &[u8],
        file_name: &str,
        name_override: Option<&str>,
        target: &str,
        slot: Option<usize>,
        mut on_progress: F,
    ) -> Result<Option<UploadResult>, ProtocolError>
    where
        F: FnMut(&UploadProgress) -> bool,
    {
        let preflight = self.preflight_upload(kind, raw, file_name, target, slot)?;
        let name = name_override.unwrap_or(&preflight.name);
        if let Some(problem) = list_name_error(name.trim()) {
            return Err(ProtocolError::InvalidRequest(problem.into()));
        }
        let name = name.trim();
        let slot_size = self
            .nodes
            .get(target)
            .and_then(|node| node.size())
            .map(|size| size as usize);
        let prepared = prepare_upload(kind, raw, name, slot_size)?;
        let result = self.perform_upload(target, preflight.slot, &prepared, &mut on_progress)?;
        // Even a cancelled upload resyncs the target list so the UI never
        // shows a slot state that the device has already moved past.
        let _ = self.read_path(target, Duration::from_millis(3_000));
        self.revision += 1;
        Ok(result)
    }

    fn perform_upload<F>(
        &mut self,
        target: &str,
        slot: usize,
        prepared: &PreparedUpload,
        on_progress: &mut F,
    ) -> Result<Option<UploadResult>, ProtocolError>
    where
        F: FnMut(&UploadProgress) -> bool,
    {
        let mut state = UploadState::new(slot, prepared);
        let last_number = prepared
            .chunks
            .last()
            .map(|chunk| chunk.number)
            .ok_or_else(|| ProtocolError::InvalidRequest("upload has no chunks".into()))?;
        let mut progress = UploadProgress {
            kind: prepared.kind,
            target: target.to_string(),
            slot,
            name: prepared.name.clone(),
            ack: 0,
            total_acks: prepared.chunks.len(),
            bytes_sent: 0,
            total_bytes: prepared.chunks.iter().map(|chunk| chunk.bytes).sum(),
        };
        if !on_progress(&progress) {
            return Ok(None);
        }

        for chunk in &prepared.chunks {
            let (index, next) = self.dwrite_ack(target, slot as i64, chunk.number, &chunk.value)?;
            let outcome = state.on_ack(index, next)?;
            progress.ack = chunk.number as usize + 1;
            progress.bytes_sent += chunk.bytes;
            match outcome {
                AckOutcome::Complete => {
                    if chunk.number != last_number {
                        return Err(ProtocolError::Protocol(format!(
                            "device completed the upload at chunk {} of {}",
                            chunk.number, last_number
                        )));
                    }
                    // The final ACK is a success, even if the caller asked to
                    // cancel while that chunk was in flight.
                    let _ = on_progress(&progress);
                    return Ok(Some(UploadResult {
                        target: target.to_string(),
                        slot,
                        name: prepared.name.clone(),
                        chunks: prepared.chunks.len(),
                        payload_bytes: prepared.payload_bytes,
                    }));
                }
                AckOutcome::Next(next_chunk) => {
                    if next_chunk <= chunk.number {
                        return Err(ProtocolError::Protocol(format!(
                            "device did not advance past chunk {}",
                            chunk.number
                        )));
                    }
                }
                AckOutcome::Repeated(_) => {}
            }
            if !on_progress(&progress) {
                return Ok(None);
            }
        }
        if !state.finished {
            return Err(ProtocolError::Protocol(format!(
                "upload did not finish (last chunk {})",
                state.expected_chunk
            )));
        }
        Ok(Some(UploadResult {
            target: target.to_string(),
            slot,
            name: prepared.name.clone(),
            chunks: prepared.chunks.len(),
            payload_bytes: prepared.payload_bytes,
        }))
    }

    // ---- preset export --------------------------------------------------

    /// Collect the selected preset's `.pst` and every capture in
    /// `root\presets.used`, then build and verify a bundle archive.
    pub fn export_preset_bundle(&mut self, index: usize) -> Result<PresetExport, ProtocolError> {
        let preset = preset_state(&self.nodes);
        let list_path = preset
            .list_path
            .clone()
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        let preset_name = preset
            .names
            .get(index)
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                ProtocolError::InvalidRequest(format!("preset slot {} is empty", index + 1))
            })?;
        let firmware = self
            .nodes
            .value_str(r"root\sys\_ver")
            .filter(|version| version.starts_with("2."))
            .unwrap_or("2.5.3")
            .to_string();

        let all_references = preset_references(&self.nodes);
        let references: Vec<_> = all_references
            .iter()
            .filter(|reference| reference.preset_index == index)
            .collect();
        let mut manifests = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for reference in references {
            if reference.list_path.is_empty() || reference.extension.is_empty() {
                return Err(ProtocolError::InvalidRequest(format!(
                    "preset {preset_name:?} uses an unrecognized dependency path {}; \
                     export is blocked",
                    reference.node_path
                )));
            }
            if !seen.insert((reference.list_path.clone(), reference.capture.clone())) {
                continue;
            }
            let archive_path = dependency_archive_path(&reference.capture, &reference.list_path)
                .ok_or_else(|| {
                    ProtocolError::InvalidRequest(format!(
                        "{} is not a supported dependency list",
                        reference.list_path
                    ))
                })?;
            manifests.push(DependencyManifest {
                name: reference.capture.clone(),
                extension: reference.extension.clone(),
                node_path: reference.list_path.clone(),
                archive_path,
            });
        }
        manifests.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
        if manifests
            .windows(2)
            .any(|pair| pair[0].archive_path == pair[1].archive_path)
        {
            return Err(ProtocolError::InvalidRequest(
                "two dependencies resolve to the same archive path; export is blocked".into(),
            ));
        }

        // Verify every dependency is present before downloading anything, so a
        // missing capture blocks export cleanly instead of leaving a partial
        // transfer.
        for manifest in &manifests {
            let names = self
                .nodes
                .get(&manifest.node_path)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProtocolError::InvalidRequest(format!(
                        "dependency list {} is unavailable",
                        manifest.node_path
                    ))
                })?;
            if !names
                .iter()
                .any(|name| name.as_str() == Some(manifest.name.as_str()))
            {
                return Err(ProtocolError::InvalidRequest(format!(
                    "dependency {:?} is missing from {}",
                    manifest.name, manifest.node_path
                )));
            }
        }

        let preset_payload = self.download_list_item(&list_path, index)?;
        let mut dependencies = Vec::new();
        for manifest in &manifests {
            let dependency_index = {
                let list = self
                    .nodes
                    .get(&manifest.node_path)
                    .and_then(|node| node.value())
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        ProtocolError::InvalidRequest(format!(
                            "dependency list {} is unavailable",
                            manifest.node_path
                        ))
                    })?;
                list.iter()
                    .position(|name| name.as_str() == Some(manifest.name.as_str()))
                    .ok_or_else(|| {
                        ProtocolError::InvalidRequest(format!(
                            "dependency {:?} is missing from {}",
                            manifest.name, manifest.node_path
                        ))
                    })?
            };
            let file = self.download_list_item(&manifest.node_path, dependency_index)?;
            dependencies.push(BundleDependency {
                manifest: manifest.clone(),
                bytes: file.raw,
            });
        }

        let bundle_manifest = BundleManifest::new(&preset_name, &firmware, manifests);
        let archive = write_bundle_to_vec(&bundle_manifest, &preset_payload.raw, &dependencies)
            .map_err(bundle_error)?;
        // Re-open the archive before reporting success.
        let loaded = read_bundle(&archive).map_err(bundle_error)?;
        if loaded.preset_bytes != preset_payload.raw
            || loaded.dependencies.len() != dependencies.len()
            || loaded
                .dependencies
                .iter()
                .zip(dependencies.iter())
                .any(|(loaded, source)| {
                    loaded.bytes != source.bytes
                        || loaded.manifest.name != source.manifest.name
                        || loaded.manifest.node_path != source.manifest.node_path
                })
            || loaded.manifest.preset.name != preset_name
        {
            return Err(ProtocolError::Protocol(
                "exported archive failed its verification pass".into(),
            ));
        }
        Ok(PresetExport {
            preset_name,
            preset_index: index,
            dependencies: dependencies
                .iter()
                .map(|dependency| dependency.manifest.name.clone())
                .collect(),
            archive_bytes: archive.len(),
            archive,
        })
    }

    // ---- preset import --------------------------------------------------

    /// Validate a bundle against the current lists without writing anything.
    pub fn import_preflight(
        &mut self,
        bundle_bytes: &[u8],
        target_slot: Option<usize>,
    ) -> Result<ImportPreflight, ProtocolError> {
        let bundle = read_bundle(bundle_bytes).map_err(bundle_error)?;
        let preset = preset_state(&self.nodes);
        let list_path = preset
            .list_path
            .clone()
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        let names = self
            .nodes
            .get(&list_path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        let empty_slots: Vec<usize> = names
            .iter()
            .enumerate()
            .filter(|(_, name)| name.as_str().map(str::trim).unwrap_or_default().is_empty())
            .map(|(index, _)| index)
            .collect();
        let invalid_target = target_slot.filter(|index| *index >= names.len());
        let target = if invalid_target.is_some() {
            None
        } else {
            target_slot.or_else(|| empty_slots.first().copied())
        };
        let target_occupied_by = target
            .and_then(|index| names.get(index))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);

        let current_chain: std::collections::BTreeSet<String> = chain_blocks(&self.nodes)
            .into_iter()
            .map(|block| block.path)
            .collect();
        let bundle_chain: std::collections::BTreeSet<String> =
            bundle.summary.chain_blocks.iter().cloned().collect();
        let mut chain_changes: Vec<String> = bundle_chain
            .difference(&current_chain)
            .map(|path| format!("+ {}", path_name(path)))
            .collect();
        chain_changes.extend(
            current_chain
                .difference(&bundle_chain)
                .map(|path| format!("- {}", path_name(path))),
        );

        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let capacity_errors = dependency_slot_shortfalls(&self.nodes, &bundle.dependencies);
        let capacity_shortfall = !capacity_errors.is_empty();
        errors.extend(capacity_errors);
        if let Some(index) = invalid_target {
            errors.push(format!(
                "target preset slot {} is outside the list",
                index + 1
            ));
        } else if target.is_none() {
            errors
                .push("there is no free preset slot; choose an occupied slot to overwrite".into());
        }
        if let Some(name) = &target_occupied_by {
            warnings.push(format!(
                "preset slot {} currently contains {name:?}",
                target.unwrap_or_default() + 1
            ));
        }
        if let Some(slot) = names.iter().enumerate().find_map(|(slot, name)| {
            if target == Some(slot) {
                return None;
            }
            name.as_str()
                .filter(|name| {
                    !name.trim().is_empty()
                        && name.eq_ignore_ascii_case(bundle.manifest.preset.name.trim())
                })
                .map(|_| slot)
        }) {
            // The pedal silently ignores an upload whose name another slot
            // already has, while still acknowledging every chunk. Treat this
            // as an error instead of letting the import fail at read-back.
            errors.push(format!(
                "a preset named {:?} already exists in slot {}; the pedal ignores uploads \
                 under a duplicate name. Choose slot {} to overwrite it, or rename/delete \
                 the existing preset first",
                bundle.manifest.preset.name,
                slot + 1,
                slot + 1
            ));
        }
        if bundle.dependencies.is_empty() {
            warnings.push("this bundle has no capture dependencies".into());
        }

        let mut dependencies = Vec::new();
        let mut claimed: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        for dependency in &bundle.dependencies {
            let list = self
                .nodes
                .get(&dependency.manifest.node_path)
                .and_then(|node| node.value())
                .and_then(Value::as_array);
            let Some(list) = list else {
                errors.push(format!(
                    "{} is not available on this device",
                    dependency.manifest.node_path
                ));
                dependencies.push(ImportDependencyPlan {
                    name: dependency.manifest.name.clone(),
                    extension: dependency.manifest.extension.clone(),
                    node_path: dependency.manifest.node_path.clone(),
                    archive_path: dependency.manifest.archive_path.clone(),
                    bytes: dependency.bytes.len(),
                    existing_index: None,
                    target_index: None,
                    action: "blocked".into(),
                });
                continue;
            };
            let existing_index = list
                .iter()
                .position(|name| name.as_str() == Some(dependency.manifest.name.as_str()));
            let target_index = match existing_index {
                Some(index) => {
                    claimed
                        .entry(dependency.manifest.node_path.clone())
                        .or_default()
                        .insert(index);
                    Some(index)
                }
                None => {
                    let slots = claimed
                        .entry(dependency.manifest.node_path.clone())
                        .or_default();
                    let index = list
                        .iter()
                        .enumerate()
                        .find(|(index, name)| {
                            name.as_str().map(str::trim).unwrap_or_default().is_empty()
                                && !slots.contains(index)
                        })
                        .map(|(index, _)| index);
                    if let Some(index) = index {
                        slots.insert(index);
                    }
                    index
                }
            };
            if target_index.is_none() && !capacity_shortfall {
                errors.push(format!(
                    "no free slot for dependency {:?} in {}",
                    dependency.manifest.name, dependency.manifest.node_path
                ));
            }
            if existing_index.is_some() {
                let users = presets_using(
                    &self.nodes,
                    &dependency.manifest.node_path,
                    &dependency.manifest.name,
                );
                let usage = if users.is_empty() {
                    String::new()
                } else {
                    format!("; it is referenced by {} preset(s)", users.len())
                };
                warnings.push(format!(
                    "{:?} already exists in {}{usage}; its content will be compared before overwriting",
                    dependency.manifest.name, dependency.manifest.node_path
                ));
            }
            dependencies.push(ImportDependencyPlan {
                name: dependency.manifest.name.clone(),
                extension: dependency.manifest.extension.clone(),
                node_path: dependency.manifest.node_path.clone(),
                archive_path: dependency.manifest.archive_path.clone(),
                bytes: dependency.bytes.len(),
                existing_index,
                target_index,
                action: if existing_index.is_some() {
                    "compare".into()
                } else if target_index.is_some() {
                    "upload".into()
                } else {
                    "blocked".into()
                },
            });
        }

        Ok(ImportPreflight {
            preset_name: bundle.manifest.preset.name,
            preset_bytes: bundle.preset_bytes.len(),
            preset_entries: bundle.summary.entries,
            chain_blocks: bundle.summary.chain_blocks,
            chain_changes,
            target_slot: target,
            target_occupied_by,
            empty_slots,
            dependencies,
            blocked: !errors.is_empty(),
            errors,
            warnings,
        })
    }

    /// Write dependencies first, then the preset payload. Every step is
    /// verified; a partial failure names what was already written.
    pub fn import_bundle(
        &mut self,
        bundle_bytes: &[u8],
        options: ImportOptions,
    ) -> Result<ImportReport, ProtocolError> {
        let bundle = read_bundle(bundle_bytes).map_err(bundle_error)?;
        let preset = preset_state(&self.nodes);
        let list_path = preset
            .list_path
            .clone()
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        let names = self
            .nodes
            .get(&list_path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::Unsupported("preset list is unavailable".into()))?;
        if options.target_slot >= names.len() {
            return Err(ProtocolError::InvalidRequest(format!(
                "target slot {} is outside the preset list",
                options.target_slot + 1
            )));
        }
        let occupied = names
            .get(options.target_slot)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        if occupied.is_some() && !options.overwrite_preset {
            return Err(ProtocolError::InvalidRequest(format!(
                "preset slot {} is occupied; confirm overwrite or choose an empty slot",
                options.target_slot + 1
            )));
        }
        let preset_name = bundle.manifest.preset.name.trim();
        if let Some(other) = names.iter().enumerate().find_map(|(slot, name)| {
            if slot == options.target_slot {
                return None;
            }
            name.as_str()
                .filter(|name| !name.trim().is_empty() && name.eq_ignore_ascii_case(preset_name))
                .map(|_| slot)
        }) {
            return Err(ProtocolError::InvalidRequest(format!(
                "a preset named {preset_name:?} already exists in slot {}; the pedal ignores \
                 uploads under a duplicate name. Choose slot {} to overwrite it, or rename/delete \
                 the existing preset first",
                other + 1,
                other + 1
            )));
        }

        // Resolve and reserve every target slot before the first write. A
        // bundle can contain more than one new capture for the same list, so
        // each dependency must claim a distinct free slot.
        let capacity_errors = dependency_slot_shortfalls(&self.nodes, &bundle.dependencies);
        if !capacity_errors.is_empty() {
            return Err(ProtocolError::InvalidRequest(capacity_errors.join("; ")));
        }

        // Resolve every dependency before the first write. Existing captures
        // are downloaded and compared so an identical file is reused.
        struct Resolved {
            plan: ImportDependencyPlan,
            bytes: Vec<u8>,
            reuse: bool,
        }
        let mut resolved: Vec<Resolved> = Vec::new();
        let mut claimed: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        for dependency in &bundle.dependencies {
            let list = self
                .nodes
                .get(&dependency.manifest.node_path)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProtocolError::InvalidRequest(format!(
                        "{} is not available on this device",
                        dependency.manifest.node_path
                    ))
                })?;
            let existing_index = list
                .iter()
                .position(|name| name.as_str() == Some(dependency.manifest.name.as_str()));
            let (target_index, reuse) = match existing_index {
                Some(index) => {
                    claimed
                        .entry(dependency.manifest.node_path.clone())
                        .or_default()
                        .insert(index);
                    let existing =
                        self.download_list_item(&dependency.manifest.node_path, index)?;
                    let same = if dependency.manifest.extension == "wav" {
                        // IR WAV containers may differ in metadata while holding
                        // the same 2048 samples. Compare decoded audio.
                        match (decode_ir(&existing.raw), decode_ir(&dependency.bytes)) {
                            (Ok(left), Ok(right)) => left == right,
                            _ => existing.raw == dependency.bytes,
                        }
                    } else {
                        existing.raw == dependency.bytes
                    };
                    if same {
                        (index, true)
                    } else if options.overwrite_dependencies {
                        (index, false)
                    } else {
                        return Err(ProtocolError::InvalidRequest(format!(
                            "dependency {:?} already exists with different content in {}; \
                             confirm overwrite before importing",
                            dependency.manifest.name, dependency.manifest.node_path
                        )));
                    }
                }
                None => {
                    let slots = claimed
                        .entry(dependency.manifest.node_path.clone())
                        .or_default();
                    let index = list
                        .iter()
                        .enumerate()
                        .find(|(index, name)| {
                            name.as_str().map(str::trim).unwrap_or_default().is_empty()
                                && !slots.contains(index)
                        })
                        .map(|(index, _)| index)
                        .ok_or_else(|| {
                            ProtocolError::InvalidRequest(format!(
                                "no free slot for dependency {:?} in {}",
                                dependency.manifest.name, dependency.manifest.node_path
                            ))
                        })?;
                    slots.insert(index);
                    (index, false)
                }
            };
            resolved.push(Resolved {
                plan: ImportDependencyPlan {
                    name: dependency.manifest.name.clone(),
                    extension: dependency.manifest.extension.clone(),
                    node_path: dependency.manifest.node_path.clone(),
                    archive_path: dependency.manifest.archive_path.clone(),
                    bytes: dependency.bytes.len(),
                    existing_index,
                    target_index: Some(target_index),
                    action: if reuse {
                        "reuse".into()
                    } else if existing_index.is_some() {
                        "overwrite".into()
                    } else {
                        "upload".into()
                    },
                },
                bytes: dependency.bytes.clone(),
                reuse,
            });
        }

        let mut written = Vec::new();
        let mut reused = Vec::new();
        for dependency in &resolved {
            if dependency.reuse {
                reused.push(dependency.plan.name.clone());
                continue;
            }
            let kind = upload_kind_for_list(&dependency.plan.node_path).ok_or_else(|| {
                ProtocolError::InvalidRequest(format!(
                    "{} is not a supported capture list",
                    dependency.plan.node_path
                ))
            })?;
            let file_name = format!("{}.{}", dependency.plan.name, dependency.plan.extension);
            let result = self.upload_named(
                kind,
                &dependency.bytes,
                &file_name,
                &dependency.plan.name,
                &dependency.plan.node_path,
                dependency.plan.target_index,
            );
            match result {
                Ok(_) => written.push(dependency.plan.name.clone()),
                Err(error) => {
                    let partial = if written.is_empty() {
                        "no dependencies were written".to_string()
                    } else {
                        format!(
                            "dependencies written before the failure: {}",
                            written.join(", ")
                        )
                    };
                    return Err(ProtocolError::Protocol(format!(
                        "import stopped while writing dependency {:?}: {error}. {partial}. \
                         The preset was not written; retry after resolving the dependency.",
                        dependency.plan.name
                    )));
                }
            }
        }

        let preset_name = bundle.manifest.preset.name.clone();
        if let Err(error) = self.upload_preset_payload(
            &list_path,
            options.target_slot,
            &preset_name,
            &bundle.preset_bytes,
        ) {
            let partial = if written.is_empty() {
                "no dependencies were written".to_string()
            } else {
                format!("dependencies already written: {}", written.join(", "))
            };
            return Err(ProtocolError::Protocol(format!(
                "preset upload failed after the dependencies were processed: {error}. {partial}. \
                 The target preset slot was not verified; retry the import."
            )));
        }

        Ok(ImportReport {
            preset_name,
            target_slot: options.target_slot,
            dependencies_written: written,
            dependencies_reused: reused,
            preset_bytes: bundle.preset_bytes.len(),
        })
    }

    fn upload_preset_payload(
        &mut self,
        list_path: &str,
        index: usize,
        name: &str,
        bytes: &[u8],
    ) -> Result<(), ProtocolError> {
        if let Some(problem) = preset_name_error(name.trim()) {
            return Err(ProtocolError::InvalidRequest(problem.into()));
        }
        let name = name.trim();
        let node = self
            .nodes
            .get(list_path)
            .ok_or_else(|| ProtocolError::Unsupported(format!("{list_path} is unavailable")))?;
        let slot_size = node
            .size()
            .map(|size| size as usize)
            .unwrap_or(PRESET_SLOT_SIZE);
        let chunk_size = node.chunk().unwrap_or(CHUNK_SIZE as u64).max(1) as usize;
        if bytes.is_empty() || bytes.len() > slot_size {
            return Err(ProtocolError::InvalidRequest(format!(
                "preset payload is {} bytes; expected 1..={slot_size}",
                bytes.len()
            )));
        }
        let mut payload = bytes.to_vec();
        payload.resize(slot_size, 0);
        let total_chunks = payload.len().div_ceil(chunk_size);

        let (ack_index, ack_chunk) =
            self.dwrite_ack(list_path, index as i64, 0, &rename_hex(name))?;
        if ack_index != -1 && ack_index != index as i64 {
            return Err(ProtocolError::UploadRejected(format!(
                "device acknowledged the wrong preset slot (wanted {index}, got {ack_index})"
            )));
        }
        if ack_chunk == -1 {
            return Err(ProtocolError::Protocol(
                "device completed the preset upload before the data chunks".into(),
            ));
        }

        let mut completed = false;
        for (offset, chunk) in payload.chunks(chunk_size).enumerate() {
            let number = offset + 1;
            let (ack_index, ack_chunk) = self.dwrite_ack(
                list_path,
                index as i64,
                number as i64,
                &stomp_protocol::hex_encode(chunk),
            )?;
            if ack_index != -1 && ack_index != index as i64 {
                return Err(ProtocolError::UploadRejected(format!(
                    "device acknowledged the wrong preset slot at chunk {number} \
                     (wanted {index}, got {ack_index})"
                )));
            }
            if ack_chunk == -1 {
                if number != total_chunks {
                    return Err(ProtocolError::Protocol(format!(
                        "device completed the preset upload at chunk {number} of {total_chunks}"
                    )));
                }
                completed = true;
                break;
            }
            if ack_chunk == number as i64 {
                // Repeated ACK: keep going with the next chunk, mirroring the
                // capture uploader.
                continue;
            }
            if ack_chunk != number as i64 + 1 {
                return Err(ProtocolError::Protocol(format!(
                    "unexpected preset ACK at chunk {number}: device asked for {ack_chunk}"
                )));
            }
            if number == total_chunks {
                // Firmware may accept the final chunk without sending -1. The
                // read-back below is the authority.
                completed = true;
            }
        }
        if !completed {
            return Err(ProtocolError::Protocol(
                "preset upload did not finish".into(),
            ));
        }

        // A preset slot is name → data chunks → name commit. The final
        // name write at chunk -1 is what publishes the payload; without it
        // the pedal leaves the slot unchanged even after acknowledging every
        // data chunk.
        let (commit_index, commit_chunk) =
            self.dwrite_ack(list_path, index as i64, -1, &rename_hex(name))?;
        if commit_index != -1 && commit_index != index as i64 {
            return Err(ProtocolError::UploadRejected(format!(
                "device acknowledged the wrong preset slot for commit (wanted {index}, got {commit_index})"
            )));
        }
        if commit_chunk != -1 {
            return Err(ProtocolError::Protocol(format!(
                "preset commit did not finish (device asked for chunk {commit_chunk})"
            )));
        }

        let read = self.read_path(list_path, Duration::from_millis(3_000));
        let stored = self
            .nodes
            .get(list_path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(Value::as_str);
        if stored != Some(name) {
            return match read {
                Err(error) => Err(ProtocolError::Protocol(format!(
                    "preset was acknowledged but the list could not be read back: {error}"
                ))),
                Ok(_) => Err(ProtocolError::Protocol(
                    "device did not store the imported preset name".into(),
                )),
            };
        }

        let readback = self.download_list_item(list_path, index)?;
        if readback.raw != payload {
            return Err(ProtocolError::Protocol(
                "imported preset read-back does not match the uploaded payload".into(),
            ));
        }
        self.revision += 1;
        Ok(())
    }

    // ---- list downloads -------------------------------------------------

    /// Download one NAM/PNAM/IR capture (or, for preset export, one `.pst`).
    ///
    /// List payloads start at chunk 1 on firmware 2.5.3; chunk 0 is empty and
    /// there is no `chunk:-1` terminator. NAM/PNAM payloads are gzip-compressed
    /// and are decompressed before returning.
    pub fn download_list_item(
        &mut self,
        list_path: &str,
        index: usize,
    ) -> Result<DownloadedListFile, ProtocolError> {
        self.download_list_item_with_progress(list_path, index, |_| true)?
            .ok_or_else(|| ProtocolError::InvalidRequest("download was cancelled".into()))
    }

    pub fn download_list_item_with_progress<F>(
        &mut self,
        list_path: &str,
        index: usize,
        mut on_progress: F,
    ) -> Result<Option<DownloadedListFile>, ProtocolError>
    where
        F: FnMut(&DownloadProgress) -> bool,
    {
        let path = normalize_path(list_path);
        let node = self
            .nodes
            .get(&path)
            .ok_or_else(|| ProtocolError::Unsupported(format!("{list_path} is not available")))?;
        let kind = list_kind(&path, node).ok_or_else(|| {
            ProtocolError::InvalidRequest(format!(
                "{list_path} is not a preset or NAM/PNAM/IR/VXAMP list"
            ))
        })?;
        let names = node
            .value()
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::InvalidRequest(format!("{list_path} is not a list")))?;
        let name = names
            .get(index)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                ProtocolError::InvalidRequest(format!("{} slot {} is empty", path, index + 1))
            })?
            .to_string();

        let chunk_size = node.chunk().unwrap_or(CHUNK_SIZE as u64).max(1) as usize;
        let node_size = node.size().map(|size| size as usize);
        // NAM/PNAM report the compressed payload size on the first chunk. The
        // list node's `size` is the slot capacity for those lists; only presets
        // and IRs use it as the item size.
        let first = self.dread_chunk(&path, index, 1)?;
        let declared_size = match kind {
            ListKind::Nam | ListKind::Pnam => first.1.ok_or_else(|| {
                ProtocolError::Protocol(format!(
                    "{path} did not report the compressed payload size on chunk 1"
                ))
            })?,
            ListKind::Preset | ListKind::Ir | ListKind::Vxamp => node_size.ok_or_else(|| {
                ProtocolError::Protocol(format!("{path} does not declare an item size"))
            })?,
        };
        let slot_limit = match kind {
            ListKind::Preset => node_size.unwrap_or(PRESET_SLOT_SIZE),
            _ => node_size.unwrap_or_else(|| kind.default_slot_size()),
        };
        if declared_size > slot_limit + 64 * 1024 {
            return Err(ProtocolError::Protocol(format!(
                "{path} reported a {} byte payload for a {} byte slot",
                declared_size, slot_limit
            )));
        }
        let total_chunks = declared_size.div_ceil(chunk_size);
        let mut progress = DownloadProgress {
            list_path: path.clone(),
            index,
            name: name.clone(),
            kind: kind.label().to_string(),
            chunk: 0,
            total_chunks,
            bytes: 0,
            total_bytes: declared_size,
        };
        if !on_progress(&progress) {
            return Ok(None);
        }

        let mut payload = Vec::with_capacity(declared_size.min(4 * 1024 * 1024));
        for chunk in 1..=total_chunks {
            let (bytes, _) = if chunk == 1 {
                first.clone()
            } else {
                self.dread_chunk(&path, index, chunk)?
            };
            let short = bytes.len() < chunk_size;
            payload.extend_from_slice(&bytes);
            if payload.len() > declared_size {
                payload.truncate(declared_size);
            }
            progress.chunk = chunk;
            progress.bytes = payload.len();
            if !on_progress(&progress) {
                return Ok(None);
            }
            if payload.len() >= declared_size {
                break;
            }
            // IR slots may hold a source WAV shorter than the slot capacity;
            // VXAMP payloads may also be shorter than the fixed slot. The final
            // chunk is then short instead of padded.
            if matches!(kind, ListKind::Ir | ListKind::Vxamp) && short {
                break;
            }
        }
        if payload.len() < declared_size && !matches!(kind, ListKind::Ir | ListKind::Vxamp) {
            return Err(ProtocolError::Protocol(format!(
                "download ended after {} of {} bytes",
                payload.len(),
                declared_size
            )));
        }

        let (raw, compressed) = match kind {
            ListKind::Nam | ListKind::Pnam => {
                let kind = if kind == ListKind::Nam {
                    UploadKind::Nam
                } else {
                    UploadKind::Pnam
                };
                (decode_downloaded_model(kind, &payload)?, true)
            }
            ListKind::Ir => {
                // Firmware 2.5.3 stores 2048 little-endian f32 samples, not WAV
                // bytes. Wrap that payload in the official WAV header. Some
                // firmware may expose a WAV already; accept both shapes.
                let wav = if payload.starts_with(b"RIFF") {
                    payload
                } else {
                    encode_ir_wav(&payload)?
                };
                validate_capture(UploadKind::Ir, &wav)?;
                (wav, false)
            }
            ListKind::Vxamp => {
                validate_capture(UploadKind::Vxamp, &payload)?;
                (payload, false)
            }
            ListKind::Preset => (payload, false),
        };

        Ok(Some(DownloadedListFile {
            list_path: path,
            index,
            name,
            kind: kind.label().to_string(),
            extension: kind.extension().to_string(),
            compressed,
            bytes: raw.len(),
            raw,
        }))
    }

    /// Read one `dread` chunk and return its bytes plus any reported size.
    fn dread_chunk(
        &mut self,
        list_path: &str,
        index: usize,
        chunk: usize,
    ) -> Result<(Vec<u8>, Option<usize>), ProtocolError> {
        let command_text = command_text(command::dread(list_path, index as i64, chunk as i64)?)?;
        let expected = normalize_path(list_path);
        let lines = self.request(
            &command_text,
            |lines| {
                lines.iter().any(|line| {
                    line.path == expected
                        && line.object().is_some_and(|object| {
                            object.contains_key("value")
                                || object.contains_key("data")
                                || object.contains_key("size")
                        })
                })
            },
            Duration::from_millis(20_000),
            Duration::from_millis(400),
            false,
        )?;
        let line = lines
            .iter()
            .find(|line| {
                line.path == expected
                    && line.object().is_some_and(|object| {
                        object.contains_key("value")
                            || object.contains_key("data")
                            || object.contains_key("size")
                    })
            })
            .ok_or_else(|| ProtocolError::Protocol("dread returned no payload".into()))?;
        let object = line
            .object()
            .ok_or_else(|| ProtocolError::Protocol("dread payload is not an object".into()))?;
        let size = object
            .get("size")
            .and_then(Value::as_u64)
            .map(|size| size as usize);
        let bytes = match object.get("value").or_else(|| object.get("data")) {
            Some(Value::String(text)) => decode_hex(text)?,
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_u64()
                        .filter(|value| *value <= 255)
                        .map(|value| value as u8)
                        .ok_or_else(|| {
                            ProtocolError::Protocol("dread byte array is out of range".into())
                        })
                })
                .collect::<Result<Vec<u8>, _>>()?,
            Some(_) => {
                return Err(ProtocolError::Protocol(
                    "dread payload has an unsupported value type".into(),
                ))
            }
            None => Vec::new(),
        };
        Ok((bytes, size))
    }

    // ---- list deletion --------------------------------------------------

    /// Delete one element from a preset or capture list using the official
    /// app's generic zero-fill `dwrite`:
    ///
    /// `dwrite <listPath>:{"index":N,"chunk":-1,"value":"00" * 128}`
    ///
    /// The slot index is preserved; the device clears the name/content. The
    /// list is read back so a failed/ignored delete is reported.
    pub fn delete_list_item(&mut self, list_path: &str, index: usize) -> Result<(), ProtocolError> {
        let path = normalize_path(list_path);
        let preset_list = preset_state(&self.nodes).list_path;
        let allowed = matches!(
            path.as_str(),
            NAM_PATH
                | NAM_DRIVE_PATH
                | PNAM_PATH
                | PNAM_DRIVE_PATH
                | IR_PATH
                | VXAMP_PATH
                | PRESET_LIST_PATH
        ) || preset_list.as_deref() == Some(path.as_str());
        if !allowed {
            return Err(ProtocolError::InvalidRequest(format!(
                "{list_path} is not a deletable preset/capture list"
            )));
        }

        let names = self
            .nodes
            .get(&path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::InvalidRequest(format!("{list_path} is not a list")))?;
        if index >= names.len() {
            return Err(ProtocolError::InvalidRequest(format!(
                "slot {index} is outside the {} slot list",
                names.len()
            )));
        }
        if names
            .get(index)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err(ProtocolError::InvalidRequest(
                "the selected slot is already empty".into(),
            ));
        }

        let zeros = "00".repeat(NAME_SIZE);
        let (_, ack) = self.dwrite_ack(&path, index as i64, -1, &zeros)?;
        if ack != -1 {
            return Err(ProtocolError::Protocol(format!(
                "delete did not finish (device asked for chunk {ack})"
            )));
        }

        let read = self.read_path(&path, Duration::from_millis(3_000));
        let cleared = self
            .nodes
            .get(&path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(Value::as_str)
            .is_some_and(str::is_empty);
        if !cleared {
            return match read {
                Err(error) => Err(ProtocolError::Protocol(format!(
                    "delete was acknowledged but could not be verified: {error}"
                ))),
                Ok(_) => Err(ProtocolError::Protocol(
                    "device did not clear the list slot".into(),
                )),
            };
        }

        self.revision += 1;
        Ok(())
    }

    // ---- list rename ----------------------------------------------------

    /// Rename one capture in a NAM/PNAM/IR list.
    ///
    /// Firmware 2.5.3 has not been proven to rewrite preset references after a
    /// rename, so a capture referenced by any preset is blocked here rather
    /// than leaving a preset pointing at a missing model. See
    /// `docs/V0.6.0_PLAN.md` section 8.
    pub fn rename_list_item(
        &mut self,
        list_path: &str,
        index: usize,
        new_name: &str,
    ) -> Result<(), ProtocolError> {
        let path = normalize_path(list_path);
        let allowed = matches!(
            path.as_str(),
            NAM_PATH | NAM_DRIVE_PATH | PNAM_PATH | PNAM_DRIVE_PATH | IR_PATH | VXAMP_PATH
        );
        if !allowed {
            return Err(ProtocolError::InvalidRequest(format!(
                "{list_path} is not a renameable capture list"
            )));
        }
        if let Some(problem) = list_name_error(new_name.trim()) {
            return Err(ProtocolError::InvalidRequest(problem.into()));
        }
        let new_name = new_name.trim();
        let names = self
            .nodes
            .get(&path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::InvalidRequest(format!("{list_path} is not a list")))?;
        let old_name = names
            .get(index)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                ProtocolError::InvalidRequest("the selected capture slot is empty".into())
            })?
            .to_string();
        if old_name == new_name {
            return Ok(());
        }
        if names.iter().enumerate().any(|(other, existing)| {
            other != index
                && existing
                    .as_str()
                    .is_some_and(|name| name.to_lowercase() == new_name.to_lowercase())
        }) {
            return Err(ProtocolError::InvalidRequest(format!(
                "a capture named {new_name:?} already exists in this list"
            )));
        }

        let used = presets_using(&self.nodes, &path, &old_name);
        if !used.is_empty() {
            let names: Vec<String> = used
                .iter()
                .map(|reference| {
                    if reference.preset_name.is_empty() {
                        format!("slot {}", reference.preset_index + 1)
                    } else {
                        format!(
                            "{} (slot {})",
                            reference.preset_name,
                            reference.preset_index + 1
                        )
                    }
                })
                .collect();
            return Err(ProtocolError::InvalidRequest(format!(
                "{} is used by preset {}; renaming used captures is blocked until firmware \
                 reference updates are verified",
                old_name,
                names.join(", ")
            )));
        }

        let (ack_index, ack_chunk) =
            self.dwrite_ack(&path, index as i64, -1, &rename_hex(new_name))?;
        if ack_index != -1 && ack_index != index as i64 {
            return Err(ProtocolError::UploadRejected(format!(
                "device acknowledged the wrong slot for rename (wanted {index}, got {ack_index})"
            )));
        }
        if ack_chunk != -1 {
            return Err(ProtocolError::Protocol("rename did not finish".into()));
        }
        self.read_path(&path, Duration::from_millis(3_000))?;
        let renamed = self
            .nodes
            .get(&path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(Value::as_str);
        if renamed != Some(new_name) {
            return Err(ProtocolError::Protocol(format!(
                "device did not store the new name at slot {index}"
            )));
        }
        self.revision += 1;
        Ok(())
    }

    // ---- snapshot -------------------------------------------------------

    pub fn state(&self) -> DeviceSnapshot {
        let preset = preset_state(&self.nodes);
        let (device_name, firmware, device_id, usb_status) = device_info(&self.nodes);
        let layout = load_chain(&self.nodes);
        let slots = layout
            .as_ref()
            .map(|layout| layout.slots(&self.nodes))
            .unwrap_or_default();
        let blocks = chain_blocks(&self.nodes);
        let available = available_blocks(&self.nodes)
            .into_iter()
            .map(|value| AvailableBlock {
                path: value["path"].as_str().unwrap_or_default().to_string(),
                name: value["name"].as_str().unwrap_or_default().to_string(),
                desc: value["desc"].as_str().unwrap_or_default().to_string(),
            })
            .collect();
        let chain = ChainView {
            router_present: layout.is_some(),
            slots,
            blocks,
            available_blocks: available,
        };
        let presets = PresetView {
            index: preset.names.iter().position(|name| name == &preset.current),
            current: preset.current.clone(),
            names: preset.names.clone(),
            list_path: preset.list_path.clone(),
            preset_path: preset.path.clone(),
        };
        let capabilities = capabilities(&self.nodes, &chain);
        DeviceSnapshot {
            revision: self.revision,
            connected: self.connected,
            device_name,
            firmware,
            device_id,
            usb_status,
            preset: presets,
            chain,
            master: master_view(&self.nodes),
            input: input_view(&self.nodes),
            meters: meters(&self.nodes),
            eq: eq_view(&self.nodes),
            lists: library_lists(&self.nodes),
            capabilities,
        }
    }

    /// Default chain labels, used only by the empty shell before a connection.
    pub fn default_chain_names() -> impl Iterator<Item = &'static str> {
        DEFAULT_CHAIN.iter().copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Preset,
    Nam,
    Pnam,
    Ir,
    Vxamp,
}

impl ListKind {
    fn label(self) -> &'static str {
        match self {
            Self::Preset => "pst",
            Self::Nam => "nam",
            Self::Pnam => "pnam",
            Self::Ir => "ir",
            Self::Vxamp => "vxamp",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Preset => "pst",
            Self::Nam => "nam",
            Self::Pnam => "pnam",
            Self::Ir => "wav",
            Self::Vxamp => "vxamp",
        }
    }

    fn default_slot_size(self) -> usize {
        match self {
            Self::Preset => PRESET_SLOT_SIZE,
            Self::Nam => stomp_protocol::NAM_SLOT_SIZE,
            Self::Pnam => stomp_protocol::PNAM_SLOT_SIZE,
            Self::Ir => stomp_protocol::IR_LENGTH * 4,
            Self::Vxamp => VXAMP_SLOT_SIZE,
        }
    }
}

fn upload_kind_for_list(path: &str) -> Option<UploadKind> {
    match path {
        NAM_PATH | NAM_DRIVE_PATH => Some(UploadKind::Nam),
        PNAM_PATH | PNAM_DRIVE_PATH => Some(UploadKind::Pnam),
        IR_PATH => Some(UploadKind::Ir),
        VXAMP_PATH => Some(UploadKind::Vxamp),
        _ => None,
    }
}

fn list_kind(path: &str, node: &stomp_protocol::node::Node) -> Option<ListKind> {
    if path == PRESET_LIST_PATH || node.item_type().to_ascii_lowercase().starts_with("pst") {
        return Some(ListKind::Preset);
    }
    match path {
        NAM_PATH | NAM_DRIVE_PATH => return Some(ListKind::Nam),
        PNAM_PATH | PNAM_DRIVE_PATH => return Some(ListKind::Pnam),
        IR_PATH => return Some(ListKind::Ir),
        VXAMP_PATH => return Some(ListKind::Vxamp),
        _ => {}
    }
    let item_type = node.item_type().to_ascii_lowercase();
    if item_type == "pnam" || item_type.starts_with("pnam_") {
        Some(ListKind::Pnam)
    } else if item_type == "ir"
        || item_type == "wav"
        || item_type.starts_with("ir_")
        || item_type.starts_with("wav_")
    {
        Some(ListKind::Ir)
    } else if item_type == "vxamp" || item_type.starts_with("vxamp_") {
        Some(ListKind::Vxamp)
    } else if item_type == "nam" || item_type.starts_with("nam_") {
        Some(ListKind::Nam)
    } else {
        None
    }
}

fn bundle_error(error: BundleError) -> ProtocolError {
    ProtocolError::InvalidRequest(error.to_string())
}

/// Check that every list has enough free slots for all new captures in one
/// bundle. Per-dependency checks are not enough: a bundle can contain several
/// new captures for the same list, and each must get a distinct slot.
fn dependency_slot_shortfalls(nodes: &NodeStore, dependencies: &[BundleDependency]) -> Vec<String> {
    let mut required: BTreeMap<String, usize> = BTreeMap::new();
    let mut available: BTreeMap<String, usize> = BTreeMap::new();
    for dependency in dependencies {
        let Some(list) = nodes
            .get(&dependency.manifest.node_path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
        else {
            continue;
        };
        let existing = list
            .iter()
            .any(|name| name.as_str() == Some(dependency.manifest.name.as_str()));
        if !existing {
            *required
                .entry(dependency.manifest.node_path.clone())
                .or_default() += 1;
        }
        available.insert(
            dependency.manifest.node_path.clone(),
            list.iter()
                .filter(|name| name.as_str().map(str::trim).unwrap_or_default().is_empty())
                .count(),
        );
    }

    required
        .into_iter()
        .filter_map(|(path, needed)| {
            let free = available.get(&path).copied().unwrap_or(0);
            (free < needed).then(|| {
                format!(
                    "{path} has {free} free slot(s) but the bundle needs {needed} new capture(s); \
                     delete or free some slots first"
                )
            })
        })
        .collect()
}

fn decode_hex(text: &str) -> Result<Vec<u8>, ProtocolError> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) {
        return Err(ProtocolError::Protocol(
            "dread payload has an odd-length hex string".into(),
        ));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for index in (0..text.len()).step_by(2) {
        let byte = u8::from_str_radix(&text[index..index + 2], 16)
            .map_err(|_| ProtocolError::Protocol(format!("invalid hex byte at offset {index}")))?;
        out.push(byte);
    }
    Ok(out)
}

fn command_text(bytes: Vec<u8>) -> Result<String, ProtocolError> {
    let text = String::from_utf8(bytes)
        .map_err(|_| ProtocolError::InvalidRequest("command is not UTF-8".into()))?;
    Ok(text
        .trim_end_matches('\0')
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

fn is_interesting_path(path: &str) -> bool {
    path == "root" || path.starts_with("root\\")
}

/// Convenience for the CLI: parse a host:port pair.
pub fn parse_host_port(text: &str) -> Result<(String, u16), ProtocolError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ProtocolError::InvalidRequest("empty address".into()));
    }
    if let Some(rest) = text.strip_prefix('[') {
        let Some((host, tail)) = rest.split_once(']') else {
            return Err(ProtocolError::InvalidRequest("invalid IPv6 address".into()));
        };
        let port = tail
            .strip_prefix(':')
            .ok_or_else(|| ProtocolError::InvalidRequest("missing port".into()))?;
        return Ok((
            host.to_string(),
            port.parse()
                .map_err(|_| ProtocolError::InvalidRequest("invalid port".into()))?,
        ));
    }
    match text.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => Ok((
            host.to_string(),
            port.parse()
                .map_err(|_| ProtocolError::InvalidRequest("invalid port".into()))?,
        )),
        _ => Err(ProtocolError::InvalidRequest(
            "missing port (use host:port)".into(),
        )),
    }
}

/// Normalize a user-visible alias before writing it.
pub fn validate_alias(alias: &str) -> Result<(), ProtocolError> {
    if alias.chars().any(|character| (character as u32) < 32) {
        return Err(ProtocolError::InvalidRequest(
            "device alias cannot contain control characters".into(),
        ));
    }
    if alias.chars().count() > 128 {
        return Err(ProtocolError::InvalidRequest(
            "device alias must be at most 128 characters".into(),
        ));
    }
    Ok(())
}

/// Best-effort metadata source for the settings screen.
pub fn setting_paths() -> &'static [&'static str] {
    &[
        r"root\settings\input",
        r"root\settings\ctrl",
        r"root\settings\misc",
        r"root\settings\tuner",
        r"root\usb",
    ]
}

pub fn preset_summary(preset: &PresetState) -> String {
    format!(
        "{} / {}",
        preset.current,
        preset.names.iter().filter(|name| !name.is_empty()).count()
    )
}

pub fn block_name(path: &str) -> &str {
    path_name(path)
}

/// Unused field marker kept for serialization compatibility.
#[allow(dead_code)]
fn _map_marker(_: Map<String, Value>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use stomp_protocol::command;
    use stomp_transport::{ScriptedTransport, Step};

    const TARGET: &str = r"root\nam_amp";
    const RAW: &[u8] = br#"{"version":"0.5.4","architecture":"WaveNet","config":{},"weights":[0.0,0.1],"sample_rate":48000,"metadata":{"name":"Progress Test","gear_type":"amp"}}"#;

    fn list_node(names: &[&str]) -> stomp_protocol::node::Node {
        stomp_protocol::node::Node::new(
            json!({"type":"list","item_type":"nam","value":names,"size":65536})
                .as_object()
                .unwrap()
                .clone(),
        )
    }

    fn reply(text: String) -> Vec<u8> {
        let mut bytes = text.into_bytes();
        bytes.push(0);
        bytes
    }

    fn dwrite_steps(prepared: &PreparedUpload) -> Vec<Step> {
        dwrite_steps_for(TARGET, prepared)
    }

    fn dwrite_steps_for(target: &str, prepared: &PreparedUpload) -> Vec<Step> {
        let last = prepared.chunks.len().saturating_sub(1);
        prepared
            .chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                let reply_chunk = if index == last { -1 } else { chunk.number + 1 };
                Step::new(
                    command::dwrite(target, 0, chunk.number, &chunk.value).unwrap(),
                    reply(format!(
                        r#"dwrite {target}:{{"index":0,"chunk":{reply_chunk}}}"#
                    )),
                )
            })
            .collect()
    }

    fn wav_bytes(frames: usize) -> Vec<u8> {
        let data_len = (frames * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&96_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.resize(wav.len() + data_len as usize, 0);
        wav
    }

    fn read_step() -> Step {
        Step::new(
            command::read(TARGET),
            reply(format!(
                r#"{TARGET}:{{"type":"list","item_type":"nam","value":["Progress Test"],"size":65536}}"#
            )),
        )
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn dread_steps(path: &str, index: usize, payload: &[u8]) -> Vec<Step> {
        let chunk_size = 1024usize;
        payload
            .chunks(chunk_size)
            .enumerate()
            .map(|(offset, chunk)| {
                let number = offset + 1;
                Step::new(
                    command::dread(path, index as i64, number as i64).unwrap(),
                    reply(format!(
                        "dread {path}:{}",
                        json!({
                            "index": index,
                            "chunk": number,
                            "size": payload.len(),
                            "value": stomp_protocol::hex_encode(chunk)
                        })
                    )),
                )
            })
            .collect()
    }

    #[test]
    fn upload_reports_every_ack_and_refreshes_the_list() {
        let prepared = prepare_upload(UploadKind::Nam, RAW, "Progress Test", Some(65536)).unwrap();
        let mut steps = dwrite_steps(&prepared);
        steps.push(read_step());
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["", ""]));

        let mut seen = Vec::new();
        let result = device
            .upload_with_progress(
                UploadKind::Nam,
                RAW,
                "progress.nam",
                TARGET,
                Some(0),
                |progress| {
                    seen.push((progress.ack, progress.total_acks));
                    true
                },
            )
            .unwrap()
            .expect("upload should complete");

        assert_eq!(result.name, "Progress Test");
        assert_eq!(result.slot, 0);
        assert_eq!(seen.first().copied(), Some((0, prepared.chunks.len())));
        assert_eq!(
            seen.last().copied(),
            Some((prepared.chunks.len(), prepared.chunks.len()))
        );
        assert_eq!(seen.len(), prepared.chunks.len() + 1);
        assert_eq!(
            device
                .nodes
                .get(TARGET)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("Progress Test")
        );
    }

    #[test]
    fn clear_chain_edit_deserializes_from_the_ui_payload() {
        let edit: ChainEdit = serde_json::from_value(json!({"type":"clear"})).unwrap();
        assert_eq!(edit, ChainEdit::Clear);
    }

    #[test]
    fn delete_list_item_zero_fills_and_verifies() {
        let steps = vec![
            Step::new(
                command::dwrite(TARGET, 0, -1, &"00".repeat(NAME_SIZE)).unwrap(),
                reply(format!(r#"dwrite {TARGET}:{{"index":0,"chunk":-1}}"#)),
            ),
            Step::new(
                command::read(TARGET),
                reply(format!(
                    r#"{TARGET}:{{"type":"list","item_type":"nam","value":["","Second"],"size":65536}}"#
                )),
            ),
        ];
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            TARGET,
            stomp_protocol::node::Node::new(
                json!({"type":"list","item_type":"nam","value":["First","Second"],"size":65536})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        device.delete_list_item(TARGET, 0).unwrap();
        assert_eq!(
            device
                .nodes
                .get(TARGET)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("")
        );
    }

    fn preset_upload_steps(path: &str, index: usize, name: &str, payload: &[u8]) -> Vec<Step> {
        let mut payload = payload.to_vec();
        payload.resize(32768, 0);
        let mut steps = vec![Step::new(
            command::dwrite(path, index as i64, 0, &rename_hex(name)).unwrap(),
            reply(format!(r#"dwrite {path}:{{"index":{index},"chunk":1}}"#)),
        )];
        let chunks: Vec<&[u8]> = payload.chunks(1024).collect();
        let last = chunks.len();
        for (offset, chunk) in chunks.iter().enumerate() {
            let number = offset + 1;
            let ack = if number == last {
                -1
            } else {
                (number + 1) as i64
            };
            steps.push(Step::new(
                command::dwrite(
                    path,
                    index as i64,
                    number as i64,
                    &stomp_protocol::hex_encode(chunk),
                )
                .unwrap(),
                reply(format!(
                    r#"dwrite {path}:{{"index":{index},"chunk":{ack}}}"#
                )),
            ));
        }
        steps.push(Step::new(
            command::dwrite(path, index as i64, -1, &rename_hex(name)).unwrap(),
            reply(format!(r#"dwrite {path}:{{"index":{index},"chunk":-1}}"#)),
        ));
        let mut names = vec![String::new(); index + 1];
        names[index] = name.to_string();
        steps.push(Step::new(
            command::read(path),
            reply(format!(
                "{path}:{}",
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":names,
                    "size":32768,
                    "chunk":1024
                })
            )),
        ));
        steps.extend(dread_steps(path, index, &payload));
        steps
    }

    fn simple_bundle() -> (Vec<u8>, Vec<u8>) {
        let dependencies = Vec::new();
        let manifest =
            stomp_preset_bundle::BundleManifest::new("Imported Patch", "2.5.3", dependencies);
        let mut payload = b"root\\app\\amp\\model:{\"value\":\"Amp A\"}\r\n".to_vec();
        payload.resize(32768, 0);
        let archive = stomp_preset_bundle::write_bundle_to_vec(&manifest, &payload, &[]).unwrap();
        (archive, payload)
    }

    fn valid_nam(name: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version":"0.5.4",
            "architecture":"WaveNet",
            "config":{},
            "weights":[0.1,0.2],
            "metadata":{"name":name,"gear_type":"amp"}
        }))
        .unwrap()
    }

    fn multi_capture_bundle() -> Vec<u8> {
        let manifests: Vec<DependencyManifest> = ["Amp One", "Amp Two"]
            .into_iter()
            .map(|name| DependencyManifest {
                name: name.to_string(),
                extension: "nam".to_string(),
                node_path: r"root\nam_amp".to_string(),
                archive_path: format!("dependencies/root/nam_amp/{name}.nam"),
            })
            .collect();
        let dependencies: Vec<BundleDependency> = manifests
            .iter()
            .map(|manifest| BundleDependency {
                manifest: manifest.clone(),
                bytes: valid_nam(&manifest.name),
            })
            .collect();
        let manifest = BundleManifest::new("Two Captures", "2.5.3", manifests);
        let mut payload = b"root\\app\\amp\\model:{\"value\":\"Amp A\"}\r\n".to_vec();
        payload.resize(32768, 0);
        write_bundle_to_vec(&manifest, &payload, &dependencies).unwrap()
    }

    fn insert_preset_slots(device: &mut Device, names: Value) {
        device.nodes.insert(
            r"root\presets",
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":names,
                    "size":32768,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
    }

    fn insert_amp_slots(device: &mut Device, names: Value) {
        device.nodes.insert(
            r"root\nam_amp",
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"nam",
                    "value":names,
                    "size":1048576,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
    }

    #[test]
    fn import_preflight_reserves_distinct_slots_for_multiple_captures() {
        let archive = multi_capture_bundle();
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        insert_preset_slots(&mut device, json!(["A", "", ""]));
        insert_amp_slots(&mut device, json!(["Existing", "", ""]));

        let preflight = device.import_preflight(&archive, Some(1)).unwrap();
        assert!(!preflight.blocked, "{preflight:?}");
        let targets: Vec<_> = preflight
            .dependencies
            .iter()
            .map(|dependency| dependency.target_index)
            .collect();
        assert_eq!(targets, vec![Some(1), Some(2)]);
    }

    #[test]
    fn import_blocks_when_a_list_lacks_slots_for_all_captures() {
        let archive = multi_capture_bundle();
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        insert_preset_slots(&mut device, json!(["A", "", ""]));
        insert_amp_slots(&mut device, json!(["Existing", ""]));

        let preflight = device.import_preflight(&archive, Some(1)).unwrap();
        assert!(preflight.blocked, "{preflight:?}");
        assert!(
            preflight
                .errors
                .iter()
                .any(|error| error.contains("1 free slot(s)") && error.contains("needs 2")),
            "{preflight:?}"
        );

        let error = device
            .import_bundle(
                &archive,
                ImportOptions {
                    target_slot: 1,
                    overwrite_preset: false,
                    overwrite_dependencies: false,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("free slot"), "{error}");
    }

    #[test]
    fn import_preset_bundle_uploads_the_pst_and_reads_it_back() {
        let (archive, payload) = simple_bundle();
        let path = r"root\presets";
        let steps = preset_upload_steps(path, 2, "Imported Patch", &payload);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["A","B","","C"],
                    "size":32768,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let preflight = device.import_preflight(&archive, None).unwrap();
        assert!(!preflight.blocked, "{preflight:?}");
        assert_eq!(preflight.preset_name, "Imported Patch");
        assert_eq!(preflight.target_slot, Some(2));
        let report = device
            .import_bundle(
                &archive,
                ImportOptions {
                    target_slot: 2,
                    overwrite_preset: false,
                    overwrite_dependencies: false,
                },
            )
            .unwrap();
        assert_eq!(report.preset_name, "Imported Patch");
        assert_eq!(report.target_slot, 2);
        assert_eq!(
            device
                .nodes
                .get(path)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .and_then(|items| items.get(2))
                .and_then(Value::as_str),
            Some("Imported Patch")
        );
    }

    #[test]
    fn import_refuses_a_duplicate_preset_name() {
        let (archive, _) = simple_bundle();
        let path = r"root\presets";
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Imported Patch","",""],
                    "size":32768,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let preflight = device.import_preflight(&archive, None).unwrap();
        assert!(preflight.blocked, "{preflight:?}");
        assert!(
            preflight
                .errors
                .iter()
                .any(|error| error.contains("duplicate name")),
            "{preflight:?}"
        );

        let error = device
            .import_bundle(
                &archive,
                ImportOptions {
                    target_slot: 1,
                    overwrite_preset: false,
                    overwrite_dependencies: false,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate name"), "{error}");
    }

    #[test]
    fn import_refuses_an_occupied_slot_without_explicit_overwrite() {
        let (archive, _) = simple_bundle();
        let path = r"root\presets";
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["A","B"],
                    "size":32768,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
        let error = device
            .import_bundle(
                &archive,
                ImportOptions {
                    target_slot: 0,
                    overwrite_preset: false,
                    overwrite_dependencies: false,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("occupied"), "{error}");
        // No transport steps were consumed.
        assert_eq!(device.nodes.value_str(r"root\presets"), None);
    }

    #[test]
    fn download_nam_decompresses_and_validates_the_payload() {
        let raw = br#"{"version":"0.5.4","architecture":"WaveNet","config":{},"weights":[0.1,0.2],"metadata":{"name":"Downloaded"}}"#;
        let mut padded = raw.to_vec();
        padded.resize(65536, 0);
        let compressed = gzip(&padded);
        let steps = dread_steps(TARGET, 2, &compressed);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device
            .nodes
            .insert(TARGET, list_node(&["First", "Second", "Downloaded"]));

        let file = device.download_list_item(TARGET, 2).unwrap();
        assert_eq!(file.name, "Downloaded");
        assert_eq!(file.kind, "nam");
        assert_eq!(file.extension, "nam");
        assert!(file.compressed);
        assert_eq!(file.raw, raw);
    }

    #[test]
    fn input_gain_write_is_range_checked() {
        let steps = vec![Step::new(
            command::write_value(INPUT_GAIN_1_PATH, &json!(3.4)).unwrap(),
            reply(format!(
                r#"{INPUT_GAIN_1_PATH}:{{"type":"float","value":3.4,"min":-15.0,"max":15.0}}"#
            )),
        )];
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            INPUT_GAIN_1_PATH,
            stomp_protocol::node::Node::new(
                json!({"type":"float","value":0.0,"min":-15.0,"max":15.0})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        device.set_input_gain(1, 3.4).unwrap();
        assert_eq!(device.nodes.value_f64(INPUT_GAIN_1_PATH), Some(3.4));
        let error = device.set_input_gain(1, 22.0).unwrap_err().to_string();
        assert!(error.contains("between -15 and 15"), "{error}");
        assert!(device.set_input_gain(3, 0.0).is_err());
    }

    #[test]
    fn export_preset_bundle_collects_used_dependencies_and_verifies_the_zip() {
        let preset_path = r"root\presets";
        let mut preset_payload =
            b"root\\app\\amp\\model:{\"value\":\"Amp A\"}\r\nroot\\app\\output\\pst\\level:{\"value\":1.0}\r\n"
                .to_vec();
        preset_payload.resize(32768, 0);
        let mut model = br#"{"version":"0.5.4","architecture":"WaveNet","config":{},"weights":[0.1],"metadata":{"name":"Amp A"}}"#.to_vec();
        model.resize(65536, 0);
        let compressed = gzip(&model);
        let mut steps = dread_steps(preset_path, 0, &preset_payload);
        steps.extend(dread_steps(TARGET, 0, &compressed));
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            preset_path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Brave"],
                    "size":32768,
                    "chunk":1024,
                    "used":{"root\\app\\amp\\model":["Amp A"]}
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
        device.nodes.insert(TARGET, list_node(&["Amp A"]));
        device.nodes.insert(
            r"root\sys\_ver",
            stomp_protocol::node::Node::new(
                json!({"type":"item","value":"2.5.3"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        let export = device.export_preset_bundle(0).unwrap();
        assert_eq!(export.preset_name, "Brave");
        assert_eq!(export.dependencies, vec!["Amp A"]);
        let loaded = stomp_preset_bundle::read_bundle(&export.archive).unwrap();
        assert_eq!(loaded.manifest.preset.name, "Brave");
        while model.last().is_some_and(|byte| *byte == 0) {
            model.pop();
        }
        assert_eq!(loaded.dependencies[0].bytes, model);
        assert_eq!(loaded.preset_bytes.len(), 32768);
    }

    #[test]
    fn export_preset_bundle_allows_a_preset_with_no_dependencies() {
        let path = r"root\presets";
        let mut preset_payload = b"root\\app\\amp\\model:{\"value\":\"\"}\r\n".to_vec();
        preset_payload.resize(32768, 0);
        let steps = dread_steps(path, 0, &preset_payload);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Empty Patch"],
                    "size":32768,
                    "chunk":1024,
                    "used":{}
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let export = device.export_preset_bundle(0).unwrap();
        assert!(export.dependencies.is_empty());
        let loaded = stomp_preset_bundle::read_bundle(&export.archive).unwrap();
        assert_eq!(loaded.preset_bytes, preset_payload);
        assert!(loaded.dependencies.is_empty());
    }

    #[test]
    fn export_preset_bundle_blocks_missing_dependencies() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            r"root\presets",
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Brave"],
                    "size":32768,
                    "chunk":1024,
                    "used":{"root\\app\\amp\\model":["Missing Amp"]}
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
        device.nodes.insert(TARGET, list_node(&["Other Amp"]));
        let error = device.export_preset_bundle(0).unwrap_err().to_string();
        assert!(error.contains("is missing from"), "{error}");
        assert!(error.contains("Missing Amp"), "{error}");
    }

    #[test]
    fn download_ir_wraps_raw_float_samples_in_a_wav() {
        let mut samples = vec![0u8; stomp_protocol::IR_LENGTH * 4];
        samples[..4].copy_from_slice(&0.5f32.to_le_bytes());
        let steps = dread_steps(IR_PATH, 0, &samples);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            IR_PATH,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"wav_48000",
                    "value":["Cab"],
                    "size":8192,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let file = device.download_list_item(IR_PATH, 0).unwrap();
        assert_eq!(file.name, "Cab");
        assert_eq!(file.kind, "ir");
        assert_eq!(file.extension, "wav");
        assert_eq!(file.raw.len(), 8248);
        assert_eq!(&file.raw[..4], b"RIFF");
        assert_eq!(&file.raw[8..12], b"WAVE");
        let decoded = decode_ir(&file.raw).unwrap();
        assert!((decoded[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn download_preset_uses_the_list_size_and_chunk_size() {
        let path = r"root\presets";
        let mut payload = b"root\\app\\router:{\"value\":[]}\r\n".to_vec();
        payload.resize(32768, 0);
        let steps = dread_steps(path, 0, &payload);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            path,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Brave"],
                    "size":32768,
                    "chunk":1024
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let file = device.download_list_item(path, 0).unwrap();
        assert_eq!(file.name, "Brave");
        assert_eq!(file.kind, "pst");
        assert_eq!(file.raw.len(), 32768);
        assert_eq!(&file.raw[..16], b"root\\app\\router:");
    }

    #[test]
    fn download_can_be_cancelled_between_chunks() {
        let compressed = gzip(&{
            let mut padded = br#"{"architecture":"WaveNet","config":{},"weights":[0.1]}"#.to_vec();
            padded.resize(65536, 0);
            padded
        });
        let steps = dread_steps(TARGET, 0, &compressed);
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["Downloaded"]));

        let mut seen = 0;
        let result = device
            .download_list_item_with_progress(TARGET, 0, |_| {
                seen += 1;
                seen < 2
            })
            .unwrap();
        assert!(result.is_none());
        assert_eq!(seen, 2, "initial callback plus one chunk");
    }

    #[test]
    fn download_rejects_empty_slots_and_non_capture_lists() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["First", ""]));
        let error = device
            .download_list_item(TARGET, 1)
            .unwrap_err()
            .to_string();
        assert!(error.contains("empty"), "{error}");

        device.nodes.insert(
            r"root\other",
            stomp_protocol::node::Node::new(
                json!({"type":"list","item_type":"misc","value":["X"]})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        let error = device
            .download_list_item(r"root\other", 0)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("not a preset or NAM/PNAM/IR/VXAMP list"),
            "{error}"
        );
    }

    #[test]
    fn rename_list_item_validates_and_reads_back() {
        let steps = vec![
            Step::new(
                command::dwrite(TARGET, 1, -1, &rename_hex("Renamed Cab")).unwrap(),
                reply(format!(r#"dwrite {TARGET}:{{"index":1,"chunk":-1}}"#)),
            ),
            Step::new(
                command::read(TARGET),
                reply(format!(
                    r#"{TARGET}:{{"type":"list","item_type":"nam","value":["First","Renamed Cab"],"size":65536}}"#
                )),
            ),
        ];
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["First", "Second"]));

        device.rename_list_item(TARGET, 1, "Renamed Cab").unwrap();
        assert_eq!(
            device
                .nodes
                .get(TARGET)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .and_then(|items| items.get(1))
                .and_then(Value::as_str),
            Some("Renamed Cab")
        );
    }

    #[test]
    fn rename_list_item_blocks_captures_used_by_a_preset() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["First", "Second"]));
        device.nodes.insert(
            r"root\presets",
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"pst_pst",
                    "value":["Patch A","", ""],
                    "used":{"root\\app\\amp\\model":["First","",""]}
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let error = device
            .rename_list_item(TARGET, 0, "Renamed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("used by preset Patch A"), "{error}");
        assert!(error.contains("reference updates are verified"), "{error}");
    }

    #[test]
    fn rename_list_item_rejects_duplicates_and_empty_slots() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["First", "Second"]));

        let duplicate = device
            .rename_list_item(TARGET, 0, "second")
            .unwrap_err()
            .to_string();
        assert!(duplicate.contains("already exists"), "{duplicate}");
        let empty = device
            .rename_list_item(TARGET, 9, "Third")
            .unwrap_err()
            .to_string();
        assert!(empty.contains("empty"), "{empty}");
    }

    #[test]
    fn preflight_accepts_raw_vxamp_lists() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            VXAMP_PATH,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"vxamp",
                    "value":["",""],
                    "size":VXAMP_SLOT_SIZE
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let checked = device
            .preflight_upload(
                UploadKind::Vxamp,
                b"opaque legacy payload",
                "Legacy Amp.vxamp",
                VXAMP_PATH,
                None,
            )
            .unwrap();
        assert_eq!(checked.name, "Legacy Amp");
        assert_eq!(checked.slot, 0);
        assert_eq!(checked.slot_size, VXAMP_SLOT_SIZE);
        assert!(checked.ready);

        device.nodes.insert(
            r"root\custom_vxamp",
            stomp_protocol::node::Node::new(
                json!({"type":"list","item_type":"vxamp","value":[""],"size":VXAMP_SLOT_SIZE})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        let error = device
            .preflight_upload(
                UploadKind::Vxamp,
                b"raw",
                "x.vxamp",
                r"root\custom_vxamp",
                None,
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a supported capture list"), "{error}");
    }

    #[test]
    fn uploads_vxamp_as_raw_slot_data() {
        let raw = b"legacy vxamp payload";
        let prepared =
            prepare_upload(UploadKind::Vxamp, raw, "Legacy", Some(VXAMP_SLOT_SIZE)).unwrap();
        let mut steps = dwrite_steps_for(VXAMP_PATH, &prepared);
        steps.push(Step::new(
            command::read(VXAMP_PATH),
            reply(format!(
                r#"{VXAMP_PATH}:{{"type":"list","item_type":"vxamp","value":["Legacy"],"size":{VXAMP_SLOT_SIZE}}}"#
            )),
        ));
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(
            VXAMP_PATH,
            stomp_protocol::node::Node::new(
                json!({
                    "type":"list",
                    "item_type":"vxamp",
                    "value":[""],
                    "size":VXAMP_SLOT_SIZE
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let result = device
            .upload_with_progress(
                UploadKind::Vxamp,
                raw,
                "Legacy.vxamp",
                VXAMP_PATH,
                Some(0),
                |_| true,
            )
            .unwrap()
            .expect("VXAMP upload should complete");

        assert_eq!(result.name, "Legacy");
        assert_eq!(result.slot, 0);
        assert_eq!(result.payload_bytes, VXAMP_SLOT_SIZE);
        assert_eq!(result.chunks, prepared.chunks.len());
        assert_eq!(
            device
                .nodes
                .get(VXAMP_PATH)
                .and_then(|node| node.value())
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("Legacy")
        );
    }

    #[test]
    fn preflight_rejects_cross_kind_targets() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            r"root\ir_list",
            stomp_protocol::node::Node::new(
                json!({"type":"list","item_type":"ir","value":[""],"size":8192})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        let error = device
            .preflight_upload(UploadKind::Nam, RAW, "model.nam", r"root\ir_list", None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected capture list type nam"), "{error}");
    }

    #[test]
    fn preflight_rejects_typed_non_capture_lists() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            r"root\custom_nam",
            stomp_protocol::node::Node::new(
                json!({"type":"list","item_type":"nam","value":[""],"size":65536})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        let error = device
            .preflight_upload(
                UploadKind::Nam,
                RAW,
                "model.nam",
                r"root\custom_nam",
                Some(0),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a supported capture list"), "{error}");
    }

    #[test]
    fn preflight_accepts_untyped_and_rate_tagged_known_ir_lists() {
        for item_type in [None, Some("wav_48000")] {
            let mut device = Device::new(ScriptedTransport::new(Vec::new()));
            device.transport.open().unwrap();
            let mut fields = json!({"type":"list","value":[""],"size":8192});
            if let Some(item_type) = item_type {
                fields["item_type"] = Value::String(item_type.to_string());
            }
            device.nodes.insert(
                IR_PATH,
                stomp_protocol::node::Node::new(fields.as_object().unwrap().clone()),
            );

            let checked = device
                .preflight_upload(
                    UploadKind::Ir,
                    &wav_bytes(3000),
                    "cab.wav",
                    IR_PATH,
                    Some(0),
                )
                .unwrap();
            assert_eq!(checked.slot, 0);
            assert!(checked.ready);
        }
    }

    #[test]
    fn upload_cancel_stops_before_the_next_chunk() {
        let prepared = prepare_upload(UploadKind::Nam, RAW, "Progress Test", Some(65536)).unwrap();
        let first = prepared.chunks.first().unwrap();
        let mut steps = vec![Step::new(
            command::dwrite(TARGET, 0, first.number, &first.value).unwrap(),
            reply(format!(r#"dwrite {TARGET}:{{"index":0,"chunk":1}}"#)),
        )];
        steps.push(read_step());
        let mut device = Device::new(ScriptedTransport::new(steps));
        device.transport.open().unwrap();
        device.nodes.insert(TARGET, list_node(&["", ""]));

        let mut callbacks = 0;
        let result = device
            .upload_with_progress(
                UploadKind::Nam,
                RAW,
                "progress.nam",
                TARGET,
                Some(0),
                |progress| {
                    callbacks += 1;
                    progress.ack < 1
                },
            )
            .unwrap();

        assert!(result.is_none(), "cancelled upload should not complete");
        assert_eq!(callbacks, 2, "initial callback plus the first ACK");
    }

    #[test]
    fn save_preset_rejects_invalid_names_before_writing() {
        let mut device = Device::new(ScriptedTransport::new(Vec::new()));
        device.transport.open().unwrap();
        device.nodes.insert(
            stomp_protocol::PRESET_PATH,
            stomp_protocol::node::Node::new(
                json!({"type":"plist","value":"Dumble","ref":"root\\presets"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        device.nodes.insert(
            PRESET_LIST_PATH,
            stomp_protocol::node::Node::new(
                json!({"type":"list","value":["Dumble","Other"]})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );

        let error = device.save_preset(Some("bad\nname")).unwrap_err();
        assert!(error.to_string().contains("control characters"));
        let error = device.save_preset(Some(&"x".repeat(64))).unwrap_err();
        assert!(error.to_string().contains("63 bytes"));
        let error = device.save_preset(Some("other")).unwrap_err();
        assert!(error.to_string().contains("already exists"));
    }
}
