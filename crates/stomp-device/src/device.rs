//! Synchronous device core. The Phase 0/1 actor wraps this behind one owner;
//! the type itself owns the transport, cache, and revision counter.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use stomp_protocol::command;
use stomp_protocol::editor::{block_editor, BlockEditor};
use stomp_protocol::frame::{parse_message, FrameBuffer, ParsedLine};
use stomp_protocol::node::NodeStore;
use stomp_protocol::preset::{preset_name_error, preset_state, rename_hex, PresetState};
use stomp_protocol::router::{available_blocks, chain_blocks, load_chain, ChainSlot, LinkType};
use stomp_protocol::{
    normalize_path, path_name, path_parent, ProtocolError, DEFAULT_CHAIN, IR_PATH, NAME_SIZE,
    NAM_DRIVE_PATH, NAM_PATH, PNAM_DRIVE_PATH, PNAM_PATH, PRESET_LIST_PATH, PRESET_PATH,
};
use stomp_transport::{ScriptedTransport, SerialTransport, TcpTransport, Transport};
use stomp_upload::{
    preflight, prepare_upload, AckOutcome, Preflight, PreparedUpload, UploadKind, UploadState,
};

use crate::snapshot::{
    capabilities, device_info, eq_view, library_lists, master_view, meters, AvailableBlock,
    ChainView, DeviceSnapshot, PresetView,
};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(3_000);
pub const BROWSE_TIMEOUT: Duration = Duration::from_millis(8_000);
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
        let name = name.unwrap_or(&preset.current).to_string();
        if name.is_empty() {
            return Err(ProtocolError::InvalidRequest(
                "there is no current preset to save".into(),
            ));
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
        };
        let item_type = list.item_type().to_ascii_lowercase();
        let known_capture_path = matches!(
            normalize_path(target).as_str(),
            NAM_PATH | NAM_DRIVE_PATH | PNAM_PATH | PNAM_DRIVE_PATH | IR_PATH
        );
        if !known_capture_path {
            return Err(ProtocolError::InvalidRequest(format!(
                "{target} is not a supported capture list; uploads are limited to \
                 the five NAM/PNAM/IR lists"
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
        mut on_progress: F,
    ) -> Result<Option<UploadResult>, ProtocolError>
    where
        F: FnMut(&UploadProgress) -> bool,
    {
        let preflight = self.preflight_upload(kind, raw, file_name, target, slot)?;
        let slot_size = self
            .nodes
            .get(target)
            .and_then(|node| node.size())
            .map(|size| size as usize);
        let prepared = prepare_upload(kind, raw, &preflight.name, slot_size)?;
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
            NAM_PATH | NAM_DRIVE_PATH | PNAM_PATH | PNAM_DRIVE_PATH | IR_PATH | PRESET_LIST_PATH
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
        let last = prepared.chunks.len().saturating_sub(1);
        prepared
            .chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                let reply_chunk = if index == last { -1 } else { chunk.number + 1 };
                Step::new(
                    command::dwrite(TARGET, 0, chunk.number, &chunk.value).unwrap(),
                    reply(format!(
                        r#"dwrite {TARGET}:{{"index":0,"chunk":{reply_chunk}}}"#
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
}
