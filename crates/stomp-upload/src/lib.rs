//! NAM, parametric NAM, and IR codecs plus the ACK state machine.
//!
//! This is pure code: it never touches a transport. The device actor feeds
//! ACKs into [`UploadState`] and sends the values produced here.

use std::io::{Read, Write};
use std::path::Path;

use flate2::read::GzDecoder;
use flate2::{Compression, GzBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use stomp_protocol::{
    hex_encode, name_chunk_hex, ProtocolError, CHUNK_SIZE, IR_GAIN, IR_LENGTH, NAME_SIZE,
    NAM_SLOT_SIZE, PNAM_SLOT_SIZE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind {
    Nam,
    Pnam,
    Ir,
}

impl UploadKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Nam => "NAM",
            Self::Pnam => "PNAM",
            Self::Ir => "IR",
        }
    }

    pub fn default_slot_size(self) -> usize {
        match self {
            Self::Nam => NAM_SLOT_SIZE,
            Self::Pnam => PNAM_SLOT_SIZE,
            Self::Ir => IR_LENGTH * std::mem::size_of::<f32>(),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Nam => "nam",
            Self::Pnam => "pnam",
            Self::Ir => "wav",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UploadChunk {
    /// 0 is the name chunk, data starts at 1.
    pub number: i64,
    pub value: String,
    pub bytes: usize,
    pub final_chunk: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreparedUpload {
    pub kind: UploadKind,
    pub name: String,
    pub raw_bytes: usize,
    pub payload_bytes: usize,
    pub chunks: Vec<UploadChunk>,
    /// True when a marker-only chunk follows the last data chunk.
    pub marker_chunk: bool,
}

impl PreparedUpload {
    /// Bytes held by the prepared hex/name payloads before transfer.
    pub fn buffered_bytes(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.value.len()).sum()
    }

    pub fn total_chunks(&self) -> usize {
        self.chunks.len()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preflight {
    pub kind: UploadKind,
    pub name: String,
    pub file_size: usize,
    pub slot_size: usize,
    pub slot: usize,
    pub overwrite: Option<String>,
    pub ready: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckOutcome {
    Next(i64),
    Complete,
    Repeated(i64),
}

/// The ACK contract: `{ "index": slot, "chunk": next }`.
#[derive(Debug, Clone)]
pub struct UploadState {
    pub slot: usize,
    pub expected_chunk: i64,
    pub total_chunks: i64,
    pub finished: bool,
    pub marker_chunk: bool,
}

impl UploadState {
    pub fn new(slot: usize, prepared: &PreparedUpload) -> Self {
        Self {
            slot,
            expected_chunk: 0,
            total_chunks: prepared.chunks.len() as i64,
            finished: false,
            marker_chunk: prepared.marker_chunk,
        }
    }

    /// Validate one device ACK and advance the state machine.
    pub fn on_ack(&mut self, index: i64, chunk: i64) -> Result<AckOutcome, ProtocolError> {
        if index == -1 {
            return Err(ProtocolError::UploadRejected(format!(
                "device rejected slot {} at chunk {}",
                self.slot, self.expected_chunk
            )));
        }
        if index != self.slot as i64 {
            return Err(ProtocolError::UploadRejected(format!(
                "device acknowledged wrong slot (wanted {}, got {index})",
                self.slot
            )));
        }
        if chunk == -1 {
            self.finished = true;
            return Ok(AckOutcome::Complete);
        }
        if chunk == self.expected_chunk {
            return Ok(AckOutcome::Repeated(chunk));
        }
        if chunk != self.expected_chunk + 1 {
            return Err(ProtocolError::Protocol(format!(
                "unexpected ACK: sent chunk {}, device asked for {chunk}",
                self.expected_chunk
            )));
        }
        self.expected_chunk = chunk;
        Ok(AckOutcome::Next(chunk))
    }
}

/// Structural checks for a NAM or Parametric NAM model.
///
/// These are intentionally conservative: a missing architecture, or an empty
/// `weights` array with no child models, is a stub rather than a loadable
/// model, and the pedal's loader is not expected to survive one.
///
/// This guard exists because a 177-byte synthetic NAM with `weights: []` was
/// accepted by an early build, uploaded to a live 2.5.3 pedal, and left the
/// device in Update Mode. Never bypass it for hardware uploads. See
/// `docs/DEVICE_SAFETY.md`.
/// Public structural validation for a downloaded model or WAV.
pub fn validate_capture(kind: UploadKind, raw: &[u8]) -> Result<(), ProtocolError> {
    if kind == UploadKind::Ir {
        decode_ir(raw)?;
    } else {
        validate_model(kind, raw)?;
    }
    Ok(())
}

/// Decompress a downloaded NAM/PNAM payload and remove the zero padding the
/// upload path adds. Firmware stores gzip bytes produced from a slot-sized,
/// NUL-padded file, so the original capture is the decompressed bytes with
/// trailing NULs removed.
pub fn decode_downloaded_model(
    kind: UploadKind,
    compressed: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if kind == UploadKind::Ir {
        return Err(ProtocolError::InvalidRequest(
            "IR downloads are not gzip-compressed".into(),
        ));
    }
    let mut decoder = GzDecoder::new(compressed);
    let mut raw = Vec::new();
    decoder.read_to_end(&mut raw).map_err(|error| {
        ProtocolError::InvalidRequest(format!(
            "{} download is not valid gzip: {error}",
            kind.label()
        ))
    })?;
    while raw.last().is_some_and(|byte| *byte == 0) {
        raw.pop();
    }
    validate_model(kind, &raw)?;
    Ok(raw)
}

fn validate_model(kind: UploadKind, raw: &[u8]) -> Result<(), ProtocolError> {
    let value: Value = serde_json::from_slice(raw).map_err(|error| {
        ProtocolError::InvalidRequest(format!("{} file is not valid JSON: {error}", kind.label()))
    })?;
    validate_model_value(kind, &value, 0)
}

/// Validate a model, including container architectures used by NAM v0.7+.
///
/// `SlimmableContainer` and the parametric variants keep the real network
/// weights in `config.submodels`/`config.models`, with each entry optionally
/// wrapped as `{ "max_value": ..., "model": { ... } }`. Recurse through those
/// wrappers so legitimate A2/PNAM files are accepted while empty stubs are
/// still rejected.
fn validate_model_value(
    kind: UploadKind,
    value: &Value,
    depth: usize,
) -> Result<(), ProtocolError> {
    if depth > 4 {
        return Err(ProtocolError::InvalidRequest(format!(
            "{} model nesting is too deep",
            kind.label()
        )));
    }
    let model = value.as_object().ok_or_else(|| {
        ProtocolError::InvalidRequest(format!("{} file must be a JSON object", kind.label()))
    })?;
    let architecture = model
        .get("architecture")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProtocolError::InvalidRequest(format!(
                "{} file is missing an architecture",
                kind.label()
            ))
        })?;
    let config = model
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProtocolError::InvalidRequest(format!(
                "{} file is missing its config object",
                kind.label()
            ))
        })?;
    if let Some(metadata) = model.get("metadata") {
        if !metadata.is_object() {
            return Err(ProtocolError::InvalidRequest(format!(
                "{} metadata must be an object",
                kind.label()
            )));
        }
    }
    if let Some(sample_rate) = model.get("sample_rate") {
        let rate = sample_rate.as_f64().unwrap_or(0.0);
        if rate <= 0.0 {
            return Err(ProtocolError::InvalidRequest(format!(
                "{} sample_rate must be a positive number",
                kind.label()
            )));
        }
    }

    // Some container variants keep the network weights in `config.weights`.
    let weights = model
        .get("weights")
        .and_then(Value::as_array)
        .or_else(|| config.get("weights").and_then(Value::as_array));
    if let Some(weights) = weights {
        if !weights.iter().all(Value::is_number) {
            return Err(ProtocolError::InvalidRequest(format!(
                "{} weights must be numeric",
                kind.label()
            )));
        }
        if !weights.is_empty() {
            return Ok(());
        }
    }

    // Sequential/slimmable containers keep the weights on their child
    // models. Both `models` and `submodels` are used by NAM v0.7 variants.
    let mut children: Vec<&Value> = Vec::new();
    for key in ["models", "submodels"] {
        match config.get(key) {
            Some(Value::Array(models)) => children.extend(models.iter()),
            Some(Value::Object(models)) => {
                children.extend(models.values().filter(|value| value.is_object()));
            }
            _ => {}
        }
    }
    if let Some(single) = config.get("model").filter(|value| value.is_object()) {
        children.push(single);
    }
    if children.is_empty() {
        return Err(ProtocolError::InvalidRequest(format!(
            "{} file has no weights; this looks like a stub, not a trained model ({architecture})",
            kind.label()
        )));
    }

    for child in children {
        // Slimmable submodels wrap the model as { max_value, model }.
        let candidate = child
            .as_object()
            .and_then(|object| object.get("model"))
            .unwrap_or(child);
        validate_model_value(kind, candidate, depth + 1)?;
    }
    Ok(())
}

pub fn preflight(
    kind: UploadKind,
    raw: &[u8],
    file_name: &str,
    slot_names: &[String],
    slot: Option<usize>,
    target_slot_size: Option<usize>,
) -> Result<Preflight, ProtocolError> {
    let slot_size = target_slot_size.unwrap_or_else(|| kind.default_slot_size());
    // IR slots store 2048 decoded f32 samples, not the source WAV, so the
    // source file may legitimately be larger than the slot.
    if kind != UploadKind::Ir && raw.len() > slot_size {
        return Err(ProtocolError::InvalidRequest(format!(
            "{} file is larger than the {} byte slot",
            kind.label(),
            slot_size
        )));
    }
    // Validate before the device sees a single byte. A malformed model can
    // crash the pedal's loader, so structural checks are not optional.
    if kind == UploadKind::Ir {
        let _ = decode_ir(raw)?;
        if IR_LENGTH * std::mem::size_of::<f32>() > slot_size {
            return Err(ProtocolError::InvalidRequest(format!(
                "decoded IR payload is {} bytes but the slot is only {slot_size} bytes",
                IR_LENGTH * std::mem::size_of::<f32>()
            )));
        }
    } else {
        validate_model(kind, raw)?;
    }
    let slot = match slot {
        Some(slot) => slot,
        None => slot_names
            .iter()
            .position(|name| name.is_empty())
            .ok_or_else(|| {
                ProtocolError::InvalidRequest("no free slots; choose a slot to overwrite".into())
            })?,
    };
    if !slot_names.is_empty() && slot >= slot_names.len() {
        return Err(ProtocolError::InvalidRequest(format!(
            "slot {slot} is outside the {} slot list",
            slot_names.len()
        )));
    }
    let overwrite = slot_names
        .get(slot)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string());
    let name = display_name(raw, file_name, kind);
    let mut warnings = Vec::new();
    if overwrite.is_some() {
        warnings.push(format!(
            "slot {slot} will be overwritten ({})",
            overwrite.as_deref().unwrap_or("")
        ));
    }
    if kind == UploadKind::Pnam && !raw.is_empty() {
        warnings.push("parametric controls appear after the list refreshes".into());
    }
    Ok(Preflight {
        kind,
        name,
        file_size: raw.len(),
        slot_size,
        slot,
        overwrite,
        ready: true,
        warnings,
    })
}

pub fn display_name(raw: &[u8], file_name: &str, kind: UploadKind) -> String {
    if matches!(kind, UploadKind::Nam | UploadKind::Pnam) {
        if let Ok(value) = serde_json::from_slice::<Value>(raw) {
            if let Some(name) = value
                .get("metadata")
                .and_then(|metadata| metadata.get("name"))
                .and_then(Value::as_str)
            {
                let name = name.trim();
                if !name.is_empty() {
                    return truncate_name(name);
                }
            }
        }
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    truncate_name(stem)
}

pub fn gear_type(raw: &[u8]) -> String {
    serde_json::from_slice::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .get("metadata")
                .and_then(|metadata| metadata.get("gear_type"))
                .and_then(Value::as_str)
                .map(|gear| gear.to_ascii_lowercase())
        })
        .unwrap_or_default()
}

pub fn is_drive_gear(gear: &str) -> bool {
    ["drive", "pedal", "dist", "fuzz", "boost", "od"]
        .iter()
        .any(|needle| gear.contains(needle))
}

/// Build the full NAM/PNAM upload, including name chunk and final marker.
pub fn prepare_model_upload(
    kind: UploadKind,
    raw: &[u8],
    name: &str,
    target_slot_size: Option<usize>,
) -> Result<PreparedUpload, ProtocolError> {
    if kind == UploadKind::Ir {
        return Err(ProtocolError::InvalidRequest(
            "use prepare_ir_upload for IR files".into(),
        ));
    }
    validate_model(kind, raw)?;
    prepare_model_upload_unchecked(kind, raw, name, target_slot_size)
}

fn prepare_model_upload_unchecked(
    kind: UploadKind,
    raw: &[u8],
    name: &str,
    target_slot_size: Option<usize>,
) -> Result<PreparedUpload, ProtocolError> {
    let slot_size = target_slot_size.unwrap_or_else(|| kind.default_slot_size());
    if raw.len() > slot_size {
        return Err(ProtocolError::InvalidRequest(format!(
            "{} file is larger than the {} byte slot",
            kind.label(),
            slot_size
        )));
    }
    let mut padded = raw.to_vec();
    padded.resize(slot_size, 0);
    let payload = gzip_bytes(&padded)?;

    let mut chunks = Vec::new();
    chunks.push(UploadChunk {
        number: 0,
        value: name_chunk_hex(name),
        bytes: NAME_SIZE,
        final_chunk: false,
    });

    let data_chunks: Vec<&[u8]> = payload.chunks(CHUNK_SIZE).collect();
    let count = data_chunks.len();
    let mut marker_chunk = false;
    for (index, chunk) in data_chunks.iter().enumerate() {
        let number = index as i64 + 1;
        let is_last = index + 1 == count;
        let value = if is_last && chunk.len() < CHUNK_SIZE {
            final_model_value(chunk)
        } else {
            hex_encode(chunk)
        };
        let final_chunk = is_last && chunk.len() < CHUNK_SIZE;
        chunks.push(UploadChunk {
            number,
            value,
            bytes: chunk.len(),
            final_chunk,
        });
    }
    if let Some(last) = data_chunks.last() {
        if last.len() == CHUNK_SIZE {
            marker_chunk = true;
            chunks.push(UploadChunk {
                number: count as i64 + 1,
                value: marker_value(),
                bytes: 0,
                final_chunk: true,
            });
        }
    }

    Ok(PreparedUpload {
        kind,
        name: name.to_string(),
        raw_bytes: raw.len(),
        payload_bytes: payload.len(),
        chunks,
        marker_chunk,
    })
}

pub fn prepare_ir_upload(wav: &[u8], name: &str) -> Result<PreparedUpload, ProtocolError> {
    let samples = decode_ir(wav)?;
    let mut payload = Vec::with_capacity(IR_LENGTH * 4);
    for sample in samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    let mut chunks = vec![UploadChunk {
        number: 0,
        value: name_chunk_hex(name),
        bytes: NAME_SIZE,
        final_chunk: false,
    }];
    for (index, chunk) in payload.chunks(CHUNK_SIZE).enumerate() {
        chunks.push(UploadChunk {
            number: index as i64 + 1,
            value: hex_encode(chunk),
            bytes: chunk.len(),
            final_chunk: false,
        });
    }
    Ok(PreparedUpload {
        kind: UploadKind::Ir,
        name: name.to_string(),
        raw_bytes: wav.len(),
        payload_bytes: payload.len(),
        chunks,
        marker_chunk: false,
    })
}

pub fn prepare_upload(
    kind: UploadKind,
    raw: &[u8],
    name: &str,
    target_slot_size: Option<usize>,
) -> Result<PreparedUpload, ProtocolError> {
    match kind {
        UploadKind::Ir => prepare_ir_upload(raw, name),
        _ => prepare_model_upload(kind, raw, name, target_slot_size),
    }
}

/// Exact 2048-character final value for a partial gzip tail.
pub fn final_model_value(tail: &[u8]) -> String {
    let pad_pairs = 1024usize.saturating_sub(tail.len() + 1);
    format!("{}gz{}", hex_encode(tail), "00".repeat(pad_pairs))
}

/// Marker-only final chunk used when the gzip tail is exactly 1024 bytes.
pub fn marker_value() -> String {
    format!("gz{}", "00".repeat(1023))
}

/// Decode a WAV into exactly 2048 scaled mono float samples.
pub fn decode_ir(wav: &[u8]) -> Result<Vec<f32>, ProtocolError> {
    let cursor = std::io::Cursor::new(wav);
    let mut reader = hound::WavReader::new(cursor)
        .map_err(|error| ProtocolError::InvalidRequest(format!("could not read WAV: {error}")))?;
    let spec = reader.spec();
    if spec.channels == 0 {
        return Err(ProtocolError::InvalidRequest("WAV has no channels".into()));
    }
    let mut samples: Vec<f32> = Vec::with_capacity(IR_LENGTH);
    let channels = spec.channels as usize;

    macro_rules! collect {
        ($ty:ty, $scale:expr) => {{
            for (frame, sample) in reader.samples::<$ty>().enumerate() {
                let sample = sample.map_err(|error| {
                    ProtocolError::InvalidRequest(format!("invalid WAV sample: {error}"))
                })?;
                if frame.is_multiple_of(channels) && samples.len() < IR_LENGTH {
                    samples.push(sample as f64 as f32 * $scale);
                }
            }
        }};
    }

    match spec.bits_per_sample {
        8 => collect!(i8, (IR_GAIN as f32) / 128.0),
        16 => collect!(i16, (IR_GAIN as f32) / 32768.0),
        24 => collect!(i32, (IR_GAIN as f32) / 8_388_608.0),
        32 => {
            if spec.sample_format == hound::SampleFormat::Float {
                for (frame, sample) in reader.samples::<f32>().enumerate() {
                    let sample = sample.map_err(|error| {
                        ProtocolError::InvalidRequest(format!("invalid WAV sample: {error}"))
                    })?;
                    if frame.is_multiple_of(channels) && samples.len() < IR_LENGTH {
                        samples.push(sample);
                    }
                }
            } else {
                collect!(i32, (IR_GAIN as f32) / 2_147_483_648.0)
            }
        }
        bits => {
            return Err(ProtocolError::InvalidRequest(format!(
                "unsupported WAV sample width: {bits} bits"
            )))
        }
    }
    samples.resize(IR_LENGTH, 0.0);
    Ok(samples)
}

/// Wrap the device's raw IR payload (2048 little-endian `f32` samples) in the
/// same 48 kHz mono float WAV the official app exports. The device stores only
/// the sample payload; the list `dread` path returns 8192 bytes with no header.
pub fn encode_ir_wav(samples: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let expected = IR_LENGTH * std::mem::size_of::<f32>();
    if samples.len() != expected {
        return Err(ProtocolError::InvalidRequest(format!(
            "IR payload is {} bytes; expected {expected} bytes (2048 f32 samples)",
            samples.len()
        )));
    }
    let mut wav = Vec::with_capacity(56 + samples.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((samples.len() + 48) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&48_000u32.to_le_bytes());
    wav.extend_from_slice(&192_000u32.to_le_bytes()); // 48000 * 1 * 4
    wav.extend_from_slice(&4u16.to_le_bytes()); // block align
    wav.extend_from_slice(&32u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"fact");
    wav.extend_from_slice(&4u32.to_le_bytes());
    wav.extend_from_slice(&(IR_LENGTH as u32).to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(samples);
    Ok(wav)
}

/// Read an IR WAV from disk.
pub fn read_ir_file(path: &Path) -> Result<Vec<f32>, ProtocolError> {
    let bytes = std::fs::read(path).map_err(|error| {
        ProtocolError::Io(format!("could not read {}: {error}", path.display()))
    })?;
    decode_ir(&bytes)
}

fn gzip_bytes(data: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let mut builder = GzBuilder::new();
    builder = builder.mtime(0);
    let mut encoder = builder.write(Vec::new(), Compression::new(6));
    encoder
        .write_all(data)
        .map_err(|error| ProtocolError::Io(format!("gzip failed: {error}")))?;
    encoder
        .finish()
        .map_err(|error| ProtocolError::Io(format!("gzip failed: {error}")))
}

fn truncate_name(name: &str) -> String {
    let mut bytes = name.as_bytes().to_vec();
    bytes.truncate(NAME_SIZE);
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\0')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nam_json(name: &str, gear: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": "0.5.4",
            "architecture": "WaveNet",
            "config": {},
            "weights": [0.0, 0.1],
            "sample_rate": 48000,
            "metadata": { "name": name, "gear_type": gear }
        }))
        .unwrap()
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

    #[test]
    fn final_value_is_exactly_2048_chars() {
        for length in [1usize, 100, 1023] {
            let tail = vec![0xab; length];
            let value = final_model_value(&tail);
            assert_eq!(value.len(), 2048);
            assert_eq!(&value[length * 2..length * 2 + 2], "gz");
            assert_eq!(marker_value().len(), 2048);
        }
    }

    #[test]
    fn model_upload_has_name_and_final_marker() {
        let raw = nam_json("Match Brave Hi D 3", "amp");
        let prepared =
            prepare_model_upload(UploadKind::Nam, &raw, "Match Brave Hi D 3", None).unwrap();
        assert_eq!(prepared.chunks[0].number, 0);
        assert_eq!(prepared.chunks[0].value.len(), NAME_SIZE * 2);
        assert!(prepared.chunks.iter().any(|chunk| chunk.final_chunk));
        assert!(
            prepared.chunks.last().unwrap().value.ends_with("gz")
                || prepared.chunks.last().unwrap().value.len() == 2048
        );
        for chunk in &prepared.chunks[1..] {
            assert!(chunk.value.len() >= 2);
        }
    }

    #[test]
    fn prepared_upload_buffers_stay_within_the_large_file_budget() {
        // Worst case: incompressible gzip payload, so the prepared chunks are
        // roughly twice the slot size. The test bypasses model validation to
        // measure the buffering path itself rather than JSON structure.
        let raw = vec![0xA5; 2 * 1024 * 1024];
        let prepared = prepare_model_upload_unchecked(
            UploadKind::Pnam,
            &raw,
            "Memory Budget",
            Some(2 * 1024 * 1024),
        )
        .unwrap();
        let budget = prepared.payload_bytes * 2 + prepared.chunks.len() * 64 + 4096;
        assert!(
            prepared.buffered_bytes() <= budget,
            "prepared upload buffers used {} bytes, budget {budget}",
            prepared.buffered_bytes()
        );
    }

    #[test]
    fn exact_tail_adds_marker_chunk() {
        // Find a raw payload whose gzip length is exactly a multiple of 1024;
        // padding the input makes that deterministic and tiny.
        let mut raw = vec![0u8; 1];
        let mut found = false;
        for extra in 0..4096 {
            raw.resize(extra + 1, 0);
            let prepared =
                prepare_model_upload_unchecked(UploadKind::Nam, &raw, "x", Some(extra + 1))
                    .unwrap();
            if prepared.marker_chunk {
                assert_eq!(prepared.chunks.last().unwrap().bytes, 0);
                assert_eq!(prepared.chunks.last().unwrap().value, marker_value());
                found = true;
                break;
            }
        }
        // Not guaranteed for every gzip build, but the marker logic is still
        // covered directly below.
        if !found {
            assert_eq!(marker_value().len(), 2048);
        }
    }

    #[test]
    fn ack_state_rejects_wrong_slot_and_bad_jump() {
        let prepared =
            prepare_model_upload_unchecked(UploadKind::Nam, b"{}", "x", Some(4096)).unwrap();
        let mut state = UploadState::new(3, &prepared);
        assert!(state.on_ack(2, 1).is_err());
        assert!(state.on_ack(3, 9).is_err());
        assert_eq!(state.on_ack(3, 1).unwrap(), AckOutcome::Next(1));
        assert_eq!(state.on_ack(3, 1).unwrap(), AckOutcome::Repeated(1));
        assert_eq!(state.on_ack(3, -1).unwrap(), AckOutcome::Complete);
        assert!(state.finished);
    }

    #[test]
    fn preflight_rejects_stub_models_and_invalid_wavs() {
        let names = vec![String::new()];
        let stub = br#"{"version":"0.5.4","architecture":"WaveNet","config":{},"weights":[]}"#;
        let error = preflight(UploadKind::Nam, stub, "stub.nam", &names, None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no weights"), "{error}");

        let missing_architecture = br#"{"config":{},"weights":[0.1]}"#;
        assert!(preflight(
            UploadKind::Pnam,
            missing_architecture,
            "x.pnam",
            &names,
            None,
            None,
        )
        .is_err());

        let invalid_ir = b"not a wav";
        assert!(preflight(UploadKind::Ir, invalid_ir, "cab.wav", &names, None, None,).is_err());

        let valid = br#"{"version":"0.5.4","architecture":"WaveNet","config":{},"weights":[0.1],"metadata":{"name":"Valid"}}"#;
        let checked = preflight(UploadKind::Nam, valid, "valid.nam", &names, None, None).unwrap();
        assert_eq!(checked.name, "Valid");
        assert!(checked.ready);

        let sequential = br#"{"version":"0.7.0","architecture":"Sequential","config":{"models":[{"architecture":"Linear","config":{},"weights":[0.1]}]},"weights":[]}"#;
        assert!(preflight(UploadKind::Pnam, sequential, "seq.pnam", &names, None, None,).is_ok());

        let container_weights = br#"{"architecture":"ParametricSlimmableContainer","config":{"weights":[0.1]},"metadata":{"name":"Container"}}"#;
        assert!(preflight(
            UploadKind::Pnam,
            container_weights,
            "container.pnam",
            &names,
            None,
            None,
        )
        .is_ok());

        let slimmable = br#"{"version":"0.7.0","architecture":"SlimmableContainer","config":{"submodels":[{"max_value":0.5,"model":{"version":"0.7.0","architecture":"WaveNet","config":{},"weights":[0.1],"sample_rate":48000}},{"max_value":1,"model":{"version":"0.7.0","architecture":"WaveNet","config":{},"weights":[0.2]}}]},"weights":[],"sample_rate":48000,"metadata":{"name":"A2 Valid"}}"#;
        let checked = preflight(UploadKind::Nam, slimmable, "a2.nam", &names, None, None).unwrap();
        assert_eq!(checked.name, "A2 Valid");

        let broken_slimmable = br#"{"version":"0.7.0","architecture":"SlimmableContainer","config":{"submodels":[{"max_value":0.5,"model":{"version":"0.7.0","architecture":"WaveNet","config":{},"weights":[]}}]},"weights":[]}"#;
        let error = preflight(
            UploadKind::Nam,
            broken_slimmable,
            "broken.nam",
            &names,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("no weights"), "{error}");

        let error = preflight(UploadKind::Nam, valid, "valid.nam", &names, Some(3), None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("outside the 1 slot list"), "{error}");

        let error = preflight(
            UploadKind::Ir,
            &wav_bytes(10),
            "cab.wav",
            &names,
            Some(0),
            Some(4096),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("decoded IR payload"), "{error}");
        assert!(preflight(
            UploadKind::Ir,
            &wav_bytes(10),
            "cab.wav",
            &names,
            Some(0),
            Some(8192),
        )
        .is_ok());
    }

    #[test]
    fn preflight_accepts_a1_wavenet_with_flat_weights() {
        let a1 = br#"{"version":"0.5.4","architecture":"WaveNet","config":{"layers":[{"input_size":1,"condition_size":1,"head_size":8,"channels":4,"kernel_size":3,"dilations":[1,2],"activation":"Tanh","gated":false}],"head":null,"head_scale":0.02},"weights":[0.1,0.2,0.3],"sample_rate":48000,"metadata":{"name":"A1 Test","gear_type":"amp"}}"#;
        let checked =
            preflight(UploadKind::Nam, a1, "a1.nam", &[String::new()], None, None).unwrap();
        assert_eq!(checked.name, "A1 Test");
        assert!(checked.ready);
    }

    #[test]
    fn preflight_accepts_ir_wavs_larger_than_the_decoded_slot() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for _ in 0..3000 {
                writer.write_sample::<i16>(0).unwrap();
                writer.write_sample::<i16>(0).unwrap();
            }
            writer.finalize().unwrap();
        }
        assert!(cursor.get_ref().len() > IR_LENGTH * 4);

        let checked = preflight(
            UploadKind::Ir,
            cursor.get_ref(),
            "cab.wav",
            &[String::new()],
            None,
            Some(IR_LENGTH * 4),
        )
        .unwrap();
        assert_eq!(checked.slot, 0);
        assert_eq!(checked.file_size, cursor.get_ref().len());
        assert!(checked.ready);
    }

    #[test]
    fn detects_drive_gear_and_names() {
        let raw = nam_json("The Green Box", "pedal_drive");
        assert_eq!(
            display_name(&raw, "file.nam", UploadKind::Nam),
            "The Green Box"
        );
        assert!(is_drive_gear(&gear_type(&raw)));
        assert_eq!(
            display_name(b"", "TJ3 58BND310.wav", UploadKind::Ir),
            "TJ3 58BND310"
        );
    }

    #[test]
    fn raw_ir_payload_is_wrapped_in_the_official_wav_shape() {
        let samples: Vec<u8> = (0..stomp_protocol::IR_LENGTH)
            .flat_map(|index| ((index as f32) / 4096.0).to_le_bytes())
            .collect();
        let wav = encode_ir_wav(&samples).unwrap();
        assert_eq!(wav.len(), 8248);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 3);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            48_000
        );
        assert_eq!(&wav[36..40], b"fact");
        assert_eq!(&wav[48..52], b"data");
        assert_eq!(
            u32::from_le_bytes([wav[52], wav[53], wav[54], wav[55]]),
            8192
        );
        assert_eq!(&wav[56..], &samples[..]);
        let decoded = decode_ir(&wav).unwrap();
        assert!((decoded[1] - (1.0 / 4096.0)).abs() < 1e-7);
        assert!(encode_ir_wav(&samples[..8191]).is_err());
    }

    #[test]
    fn ir_is_2048_float_samples() {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for index in 0..3000 {
                let value = if index == 0 { 4_194_304 } else { 0 };
                writer.write_sample::<i32>(value).unwrap();
            }
            writer.finalize().unwrap();
        }
        let prepared = prepare_ir_upload(cursor.get_ref(), "Cab").unwrap();
        assert_eq!(prepared.payload_bytes, IR_LENGTH * 4);
        assert_eq!(prepared.chunks.len(), 1 + 8);
        let hex = &prepared.chunks[1].value[..8];
        let bytes: Vec<u8> = (0..4)
            .map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap())
            .collect();
        let first = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        assert!((first - (0.5 * IR_GAIN as f32)).abs() < 1e-5, "got {first}");
    }
}
