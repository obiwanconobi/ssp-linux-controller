//! Wire protocol primitives for the Sonulab StompStation PRO.
//!
//! This crate is the Rust counterpart of the protocol core in `stomp.py`. It is
//! deliberately transport-free: parsing, encoding, node storage, router
//! geometry, preset discovery, and editor derivation all live here.

pub mod command;
pub mod editor;
pub mod error;
pub mod frame;
pub mod labels;
pub mod node;
pub mod preset;
pub mod router;

pub use command::hex_encode;
pub use error::ProtocolError;
pub use node::{Node, NodeStore};

/// NAM payload slots are zero-padded to 1 MiB.
pub const NAM_SLOT_SIZE: usize = 1024 * 1024;
/// Parametric NAM slots are 2 MiB.
pub const PNAM_SLOT_SIZE: usize = 2 * 1024 * 1024;
/// Legacy VXAMP/amp-model slots are 12 KiB and are not gzip-compressed.
pub const VXAMP_SLOT_SIZE: usize = 12 * 1024;
pub const CHUNK_SIZE: usize = 1024;
pub const NAME_SIZE: usize = 128;
pub const MAX_PRESET_NAME_BYTES: usize = 63;
pub const IR_LENGTH: usize = 2048;
pub const IR_GAIN: f64 = 0.319_141_304_936_481_1;
pub const EQ_SAMPLE_RATE: f64 = 48_000.0;

pub const DEFAULT_BAUD: u32 = 115_200;

pub const PRESET_PATH: &str = r"root\app\preset";
pub const PRESET_LIST_PATH: &str = r"root\presets";
pub const ROUTER_PATH: &str = r"root\app\router";
pub const NAM_PATH: &str = r"root\nam_amp";
pub const NAM_DRIVE_PATH: &str = r"root\nam_drive";
pub const PNAM_PATH: &str = r"root\pnam_list";
pub const PNAM_DRIVE_PATH: &str = r"root\pnam_drive";
pub const IR_PATH: &str = r"root\ir_list";
pub const VXAMP_PATH: &str = r"root\vxamp_list";
pub const MASTER_PATH: &str = r"root\app\output";
pub const GLOBAL_EQ_PATH: &str = r"root\app\output\global_eq";
pub const SETTINGS_PATH: &str = r"root\settings";
pub const TUNER_PATH: &str = r"root\settings\tuner";
pub const TUNER_ON_PATH: &str = r"root\settings\tuner\on_off";
pub const TUNER_MODULE_PATH: &str = r"root\settings\tuner\tuner";
pub const TUNER_FREQ_PATH: &str = r"root\settings\tuner\tuner\_freq";
pub const TUNER_LEVEL_PATH: &str = r"root\settings\tuner\tuner\lvl";
pub const TUNER_REF_PATH: &str = r"root\settings\tuner\tuner\ref";

/// Known fallback chain for older firmware that does not expose a router.
pub const DEFAULT_CHAIN: &[&str] = &[
    "gate", "pitch", "exp", "comp", "mod_pre", "drive", "amp", "ir", "eq", "mod", "delay", "reverb",
];

/// Hex-encoded 128-byte NUL-padded name chunk (upload chunk 0 / rename).
pub fn name_chunk_hex(name: &str) -> String {
    let mut bytes = name.as_bytes().to_vec();
    bytes.truncate(NAME_SIZE);
    bytes.resize(NAME_SIZE, 0);
    command::hex_encode(&bytes)
}

pub fn path_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

pub fn path_parent(path: &str) -> &str {
    path.rsplit_once('\\')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

/// Firmware occasionally double-escapes separators in JSON payloads.
pub fn normalize_path(path: &str) -> String {
    path.replace("\\\\", "\\")
}
