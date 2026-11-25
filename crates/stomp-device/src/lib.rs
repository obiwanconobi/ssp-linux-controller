//! Device orchestration: connect, browse, writes, chain edits, uploads, and
//! the derived snapshot the UI consumes.

pub mod device;
pub mod snapshot;

pub use device::{
    parse_host_port, preset_summary, setting_paths, validate_alias, AuthStatus, ChainEdit,
    ConnectionInfo, Device, DownloadProgress, DownloadedListFile, ImportOptions, ImportPreflight,
    ImportReport, PresetExport, UploadProgress, UploadResult, BROWSE_TIMEOUT,
    DEFAULT_POLL_INTERVAL, DEFAULT_TIMEOUT, PRESET_SLOT_SIZE,
};
pub use snapshot::*;
