//! StompStation preset bundles (`.zip`): manifest, `.pst` payload, and capture
//! dependencies.
//!
//! The format mirrors the official app's export on firmware 2.5.3:
//!
//! ```text
//! bdinfo.json
//! preset/<Preset>.pst
//! dependencies/root/<list>/<Capture>.<ext>
//! ```
//!
//! Everything here is pure code: the device layer supplies the `.pst` and
//! dependency bytes, and this crate validates/assembles the archive.

use std::collections::BTreeSet;
use std::io::{Cursor, Read, Seek, Write};

use serde::{Deserialize, Serialize};
use stomp_protocol::preset::list_name_error;
use stomp_protocol::{
    normalize_path, IR_PATH, NAM_DRIVE_PATH, NAM_PATH, PNAM_DRIVE_PATH, PNAM_PATH,
};
use stomp_upload::{validate_capture, UploadKind};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

pub const APPLICATION_NAME: &str = "StompStation PRO";
pub const AUTHOR: &str = "SONULAB Audio Systems";
pub const MANIFEST_PATH: &str = "bdinfo.json";
pub const MAX_ARCHIVE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_PST_BYTES: usize = 32 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("bundle is not a valid zip archive: {0}")]
    Zip(String),
    #[error("bundle has no bdinfo.json manifest")]
    MissingManifest,
    #[error("bundle manifest is invalid: {0}")]
    Manifest(String),
    #[error("bundle preset is invalid: {0}")]
    Preset(String),
    #[error("bundle dependency is invalid: {0}")]
    Dependency(String),
    #[error("bundle archive contains an unsafe path: {0}")]
    UnsafePath(String),
    #[error("bundle archive contains an undeclared entry: {0}")]
    UndeclaredEntry(String),
    #[error("bundle archive is too large")]
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub application_name: String,
    pub author: String,
    pub version: String,
    pub preset: PresetManifest,
    pub dependencies: Vec<DependencyManifest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetManifest {
    pub name: String,
    pub extension: String,
    pub node_path: String,
    pub archive_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyManifest {
    pub name: String,
    pub extension: String,
    pub node_path: String,
    pub archive_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BundleDependency {
    pub manifest: DependencyManifest,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PstEntry {
    pub path: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PstSummary {
    pub entries: usize,
    pub chain_blocks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedBundle {
    pub manifest: BundleManifest,
    pub preset_bytes: Vec<u8>,
    pub dependencies: Vec<BundleDependency>,
    pub summary: PstSummary,
}

impl BundleManifest {
    /// Build the manifest for a new export. Dependency entries should already
    /// be in archive order.
    pub fn new(preset_name: &str, firmware: &str, dependencies: Vec<DependencyManifest>) -> Self {
        let archive_path = format!("preset/{}.pst", sanitize_component(preset_name));
        Self {
            application_name: APPLICATION_NAME.to_string(),
            author: AUTHOR.to_string(),
            version: firmware.to_string(),
            preset: PresetManifest {
                name: preset_name.to_string(),
                extension: "pst".to_string(),
                node_path: r"root\presets".to_string(),
                archive_path,
            },
            dependencies,
        }
    }
}

/// Write a bundle. `bdinfo.json` is written first for readability. File
/// contents are stored with deflate; extraction returns the exact bytes.
pub fn write_bundle<W: Write + Seek>(
    writer: W,
    manifest: &BundleManifest,
    preset_bytes: &[u8],
    dependencies: &[BundleDependency],
) -> Result<W, BundleError> {
    validate_manifest(manifest)?;
    if preset_bytes.is_empty() || preset_bytes.len() > MAX_PST_BYTES {
        return Err(BundleError::Preset(format!(
            "preset payload is {} bytes; expected at most {MAX_PST_BYTES}",
            preset_bytes.len()
        )));
    }
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|error| BundleError::Manifest(format!("cannot encode manifest: {error}")))?;
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(DateTime::default());
    let mut write_file = |name: &str, bytes: &[u8]| -> Result<(), BundleError> {
        zip.start_file(name, options)
            .map_err(|error| BundleError::Zip(error.to_string()))?;
        zip.write_all(bytes)
            .map_err(|error| BundleError::Zip(error.to_string()))
    };
    write_file(MANIFEST_PATH, &manifest_json)?;
    write_file(&manifest.preset.archive_path, preset_bytes)?;
    for dependency in dependencies {
        let expected = expected_dependency_path(&dependency.manifest)?;
        if expected != dependency.manifest.archive_path {
            return Err(BundleError::Dependency(format!(
                "{} does not match the expected archive path {expected}",
                dependency.manifest.archive_path
            )));
        }
        write_file(&expected, &dependency.bytes)?;
    }
    zip.finish()
        .map_err(|error| BundleError::Zip(error.to_string()))
}

/// Convenience wrapper that returns the finished archive bytes.
pub fn write_bundle_to_vec(
    manifest: &BundleManifest,
    preset_bytes: &[u8],
    dependencies: &[BundleDependency],
) -> Result<Vec<u8>, BundleError> {
    let cursor = write_bundle(
        Cursor::new(Vec::new()),
        manifest,
        preset_bytes,
        dependencies,
    )?;
    Ok(cursor.into_inner())
}

/// Parse and validate a bundle before any device write.
pub fn read_bundle(bytes: &[u8]) -> Result<LoadedBundle, BundleError> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(BundleError::TooLarge);
    }
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| BundleError::Zip(error.to_string()))?;
    if archive.len() > 64 {
        return Err(BundleError::Zip("too many archive entries".into()));
    }

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| BundleError::Zip(error.to_string()))?;
        let name = file
            .name()
            .map_err(|error| BundleError::Zip(error.to_string()))?
            .to_string();
        if file.is_dir() {
            continue;
        }
        if file.encrypted() {
            return Err(BundleError::Zip(format!(
                "encrypted entries are not supported ({name})"
            )));
        }
        validate_archive_name(&name)?;
        let size = file.size() as usize;
        total = total.saturating_add(size);
        if size > MAX_ARCHIVE_BYTES || total > MAX_ARCHIVE_BYTES {
            return Err(BundleError::TooLarge);
        }
        let mut data = Vec::with_capacity(size.min(MAX_ARCHIVE_BYTES));
        file.read_to_end(&mut data)
            .map_err(|error| BundleError::Zip(error.to_string()))?;
        if entries.iter().any(|(existing, _)| existing == &name) {
            return Err(BundleError::UnsafePath(format!(
                "duplicate archive entry {name}"
            )));
        }
        entries.push((name, data));
    }

    let manifest_bytes = entries
        .iter()
        .find(|(name, _)| name == MANIFEST_PATH)
        .map(|(_, bytes)| bytes)
        .ok_or(BundleError::MissingManifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(BundleError::Manifest("manifest is too large".into()));
    }
    let manifest: BundleManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| BundleError::Manifest(format!("could not parse JSON: {error}")))?;
    validate_manifest(&manifest)?;

    let preset_bytes = take_declared(&entries, &manifest.preset.archive_path)?;
    let summary = parse_pst(&preset_bytes)?;
    if preset_bytes.len() > MAX_PST_BYTES {
        return Err(BundleError::Preset(format!(
            "preset payload is {} bytes; expected at most {MAX_PST_BYTES}",
            preset_bytes.len()
        )));
    }

    let mut dependencies = Vec::new();
    let mut declared = BTreeSet::new();
    declared.insert(MANIFEST_PATH.to_string());
    declared.insert(manifest.preset.archive_path.clone());
    for dependency in &manifest.dependencies {
        let expected = expected_dependency_path(dependency)?;
        if expected != dependency.archive_path {
            return Err(BundleError::Dependency(format!(
                "{} does not match the expected archive path {expected}",
                dependency.archive_path
            )));
        }
        let bytes = take_declared(&entries, &dependency.archive_path)?;
        let kind = dependency_kind(&dependency.node_path).ok_or_else(|| {
            BundleError::Dependency(format!(
                "{} is not an allowed capture list",
                dependency.node_path
            ))
        })?;
        validate_capture(kind.upload_kind, &bytes)
            .map_err(|error| BundleError::Dependency(format!("{}: {error}", dependency.name)))?;
        if !declared.insert(dependency.archive_path.clone()) {
            return Err(BundleError::Dependency(format!(
                "duplicate dependency archive path {}",
                dependency.archive_path
            )));
        }
        dependencies.push(BundleDependency {
            manifest: dependency.clone(),
            bytes,
        });
    }
    for (name, _) in &entries {
        if !declared.contains(name) {
            return Err(BundleError::UndeclaredEntry(name.clone()));
        }
    }

    Ok(LoadedBundle {
        manifest,
        preset_bytes,
        dependencies,
        summary,
    })
}

fn take_declared(entries: &[(String, Vec<u8>)], path: &str) -> Result<Vec<u8>, BundleError> {
    entries
        .iter()
        .find(|(name, _)| name == path)
        .map(|(_, bytes)| bytes.clone())
        .ok_or_else(|| BundleError::Manifest(format!("archive entry {path} is missing")))
}

fn validate_manifest(manifest: &BundleManifest) -> Result<(), BundleError> {
    if manifest.application_name != APPLICATION_NAME && manifest.application_name != "StompStation"
    {
        return Err(BundleError::Manifest(format!(
            "unsupported application {:?}",
            manifest.application_name
        )));
    }
    let major = manifest
        .version
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    if major != Some(2) {
        return Err(BundleError::Manifest(format!(
            "unsupported bundle version {:?}; this build imports 2.x bundles",
            manifest.version
        )));
    }
    if let Some(problem) = list_name_error(manifest.preset.name.trim()) {
        return Err(BundleError::Manifest(format!(
            "invalid preset name: {problem}"
        )));
    }
    if manifest.preset.extension != "pst" {
        return Err(BundleError::Manifest("preset extension must be pst".into()));
    }
    if normalize_path(&manifest.preset.node_path) != r"root\presets" {
        return Err(BundleError::Manifest(
            "preset nodePath must be root\\presets".into(),
        ));
    }
    validate_archive_name(&manifest.preset.archive_path)?;
    if !manifest.preset.archive_path.starts_with("preset/") {
        return Err(BundleError::Manifest(
            "preset archivePath must live under preset/".into(),
        ));
    }

    let mut seen = BTreeSet::new();
    for dependency in &manifest.dependencies {
        let kind = dependency_kind(&dependency.node_path).ok_or_else(|| {
            BundleError::Dependency(format!(
                "{} is not an allowed capture list",
                dependency.node_path
            ))
        })?;
        if dependency.extension != kind.extension() {
            return Err(BundleError::Dependency(format!(
                "{} on {} must have extension {}",
                dependency.name,
                dependency.node_path,
                kind.extension()
            )));
        }
        if let Some(problem) = list_name_error(dependency.name.trim()) {
            return Err(BundleError::Dependency(format!(
                "{}: {problem}",
                dependency.name
            )));
        }
        if dependency.name.contains(['/', '\\']) {
            return Err(BundleError::Dependency(format!(
                "{} contains a path separator",
                dependency.name
            )));
        }
        validate_archive_name(&dependency.archive_path)?;
        if !dependency.archive_path.starts_with("dependencies/") {
            return Err(BundleError::Dependency(
                "dependency archivePath must live under dependencies/".into(),
            ));
        }
        let key = (
            normalize_path(&dependency.node_path),
            dependency.name.clone(),
        );
        if !seen.insert(key) {
            return Err(BundleError::Dependency(format!(
                "duplicate dependency {} on {}",
                dependency.name, dependency.node_path
            )));
        }
    }
    Ok(())
}

fn validate_archive_name(name: &str) -> Result<(), BundleError> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.split('/').any(|part| part == ".." || part.is_empty())
    {
        return Err(BundleError::UnsafePath(name.to_string()));
    }
    if name != MANIFEST_PATH && !name.starts_with("preset/") && !name.starts_with("dependencies/") {
        return Err(BundleError::UnsafePath(name.to_string()));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct DependencyKind {
    list_path: &'static str,
    extension: &'static str,
    upload_kind: UploadKind,
}

impl DependencyKind {
    fn extension(self) -> &'static str {
        self.extension
    }
}

fn dependency_kind(node_path: &str) -> Option<DependencyKind> {
    match normalize_path(node_path).as_str() {
        NAM_PATH => Some(DependencyKind {
            list_path: NAM_PATH,
            extension: "nam",
            upload_kind: UploadKind::Nam,
        }),
        NAM_DRIVE_PATH => Some(DependencyKind {
            list_path: NAM_DRIVE_PATH,
            extension: "nam",
            upload_kind: UploadKind::Nam,
        }),
        PNAM_PATH => Some(DependencyKind {
            list_path: PNAM_PATH,
            extension: "pnam",
            upload_kind: UploadKind::Pnam,
        }),
        PNAM_DRIVE_PATH => Some(DependencyKind {
            list_path: PNAM_DRIVE_PATH,
            extension: "pnam",
            upload_kind: UploadKind::Pnam,
        }),
        IR_PATH => Some(DependencyKind {
            list_path: IR_PATH,
            extension: "wav",
            upload_kind: UploadKind::Ir,
        }),
        _ => None,
    }
}

/// Build the archive path the official app uses for a dependency.
pub fn dependency_archive_path(name: &str, node_path: &str) -> Option<String> {
    let kind = dependency_kind(node_path)?;
    Some(format!(
        "dependencies/{}/{}.{}",
        kind.list_path.replace('\\', "/"),
        sanitize_component(name),
        kind.extension()
    ))
}

fn expected_dependency_path(manifest: &DependencyManifest) -> Result<String, BundleError> {
    let kind = dependency_kind(&manifest.node_path).ok_or_else(|| {
        BundleError::Dependency(format!(
            "{} is not an allowed capture list",
            manifest.node_path
        ))
    })?;
    Ok(format!(
        "dependencies/{}/{}.{}",
        kind.list_path.replace('\\', "/"),
        sanitize_component(&manifest.name),
        kind.extension()
    ))
}

/// Parse the CRLF-separated `.pst` lines and reject paths that are not
/// preset-scoped.
pub fn parse_pst(bytes: &[u8]) -> Result<PstSummary, BundleError> {
    let entries = parse_pst_entries(bytes)?;
    let mut chain_blocks = Vec::new();
    if let Some(router) = entries
        .iter()
        .find(|entry| entry.path == r"root\app\router")
    {
        if let Some(row) = router
            .value
            .get("value")
            .and_then(serde_json::Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(serde_json::Value::as_array)
        {
            for cell in row {
                if let Some(text) = cell.as_str() {
                    if text.starts_with("root\\app\\") {
                        chain_blocks.push(text.to_string());
                    }
                }
            }
        }
    }
    Ok(PstSummary {
        entries: entries.len(),
        chain_blocks,
    })
}

pub fn parse_pst_entries(bytes: &[u8]) -> Result<Vec<PstEntry>, BundleError> {
    if bytes.len() > MAX_PST_BYTES {
        return Err(BundleError::Preset(format!(
            "preset payload is {} bytes; expected at most {MAX_PST_BYTES}",
            bytes.len()
        )));
    }
    let end = bytes
        .iter()
        .rposition(|byte| *byte != 0)
        .map(|index| index + 1)
        .unwrap_or(0);
    let text = std::str::from_utf8(&bytes[..end])
        .map_err(|error| BundleError::Preset(format!("payload is not UTF-8: {error}")))?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for raw in text.split(['\r', '\n']) {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Some((path, value_text)) = line.split_once(':') else {
            return Err(BundleError::Preset(format!(
                "line is not path:json: {line}"
            )));
        };
        let path = normalize_path(path.trim());
        validate_pst_path(&path)?;
        if !seen.insert(path.clone()) {
            return Err(BundleError::Preset(format!("duplicate path {path}")));
        }
        let value: serde_json::Value = serde_json::from_str(value_text)
            .map_err(|error| BundleError::Preset(format!("invalid JSON for {path}: {error}")))?;
        if !value.is_object() {
            return Err(BundleError::Preset(format!(
                "value for {path} is not an object"
            )));
        }
        entries.push(PstEntry { path, value });
    }
    if entries.is_empty() {
        return Err(BundleError::Preset("preset payload is empty".into()));
    }
    Ok(entries)
}

fn validate_pst_path(path: &str) -> Result<(), BundleError> {
    let allowed = path.starts_with("root\\app\\")
        && path != r"root\app\preset"
        && !path.starts_with(r"root\app\output\global_eq")
        && !path.starts_with(r"root\app\output\vol")
        && !path.contains("\\action\\")
        && !path.contains("..")
        && !path
            .chars()
            .any(|character| character == '\0' || (character as u32) < 32);
    if allowed {
        Ok(())
    } else {
        Err(BundleError::Preset(format!(
            "path {path} is not a preset-scoped root\\app path"
        )))
    }
}

fn sanitize_component(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "preset".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_nam(name: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version":"0.5.4",
            "architecture":"WaveNet",
            "config":{},
            "weights":[0.1,0.2],
            "metadata":{"name":name,"gear_type":"amp"}
        }))
        .unwrap()
    }

    fn valid_wav() -> Vec<u8> {
        let frames = 2048u32;
        let data_len = frames * 2;
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

    fn preset_bytes() -> Vec<u8> {
        let mut bytes =
            br#"root\app\router:{"value":[["root\\app\\drive","s","root\\app\\amp","s",""]]}
root\app\drive\model:{"value":"Klone 3"}
root\app\output\pst\level:{"value":0.000000}
"#
            .to_vec();
        bytes.resize(MAX_PST_BYTES, 0);
        bytes
    }

    fn dependency(
        name: &str,
        extension: &str,
        node_path: &str,
        archive: &str,
    ) -> DependencyManifest {
        DependencyManifest {
            name: name.to_string(),
            extension: extension.to_string(),
            node_path: node_path.to_string(),
            archive_path: archive.to_string(),
        }
    }

    fn bundle() -> (BundleManifest, Vec<BundleDependency>) {
        let dependency = dependency(
            "Amp A",
            "nam",
            NAM_PATH,
            "dependencies/root/nam_amp/Amp A.nam",
        );
        let manifest = BundleManifest::new("Brave", "2.5.3", vec![dependency.clone()]);
        (
            manifest,
            vec![BundleDependency {
                manifest: dependency,
                bytes: valid_nam("Amp A"),
            }],
        )
    }

    #[test]
    fn round_trips_a_bundle_and_parses_the_pst() {
        let (manifest, dependencies) = bundle();
        let preset = preset_bytes();
        let bytes = write_bundle_to_vec(&manifest, &preset, &dependencies).unwrap();
        let loaded = read_bundle(&bytes).unwrap();
        assert_eq!(loaded.manifest.preset.name, "Brave");
        assert_eq!(loaded.preset_bytes.len(), MAX_PST_BYTES);
        assert_eq!(loaded.dependencies.len(), 1);
        assert_eq!(loaded.dependencies[0].bytes, valid_nam("Amp A"));
        assert_eq!(loaded.summary.entries, 3);
        assert_eq!(
            loaded.summary.chain_blocks,
            vec![r"root\app\drive".to_string(), r"root\app\amp".to_string()]
        );
    }

    #[test]
    fn rejects_unsafe_and_undeclared_entries() {
        let (manifest, dependencies) = bundle();
        let mut bytes = write_bundle_to_vec(&manifest, &preset_bytes(), &dependencies).unwrap();
        // Append a zip entry that the manifest does not declare.
        let mut extra = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        extra
            .start_file("dependencies/root/nam_amp/Extra.nam", options)
            .unwrap();
        extra.write_all(&valid_nam("Extra")).unwrap();
        let mut extra_bytes = extra.finish().unwrap().into_inner();
        bytes.append(&mut extra_bytes);
        assert!(read_bundle(&bytes).is_err());

        let mut traversal = manifest.clone();
        traversal.preset.archive_path = "preset/../evil.pst".to_string();
        assert!(write_bundle_to_vec(&traversal, &preset_bytes(), &dependencies).is_err());
    }

    #[test]
    fn rejects_out_of_scope_pst_paths_and_duplicates() {
        for line in [
            "root\\settings\\input\\gain1:{\"value\":0}",
            "root\\app\\output\\global_eq\\on_off:{\"value\":\"ON\"}",
            "root\\app\\preset:{\"value\":\"X\"}",
        ] {
            let mut bytes = line.as_bytes().to_vec();
            bytes.resize(MAX_PST_BYTES, 0);
            assert!(parse_pst(&bytes).is_err(), "{line}");
        }
        let duplicate =
            b"root\\app\\drive\\gain:{\"value\":1}\r\nroot\\app\\drive\\gain:{\"value\":2}\r\n";
        assert!(parse_pst(duplicate).is_err());
    }

    #[test]
    fn rejects_wrong_dependency_kinds_and_manifest_versions() {
        let (mut manifest, dependencies) = bundle();
        manifest.version = "1.9.0".to_string();
        assert!(write_bundle_to_vec(&manifest, &preset_bytes(), &dependencies).is_err());

        let (mut manifest, mut dependencies) = bundle();
        dependencies[0].manifest.extension = "wav".to_string();
        dependencies[0].manifest.archive_path = "dependencies/root/nam_amp/Amp A.wav".to_string();
        assert!(write_bundle_to_vec(&manifest, &preset_bytes(), &dependencies).is_err());
        manifest.dependencies[0] = dependencies[0].manifest.clone();
    }

    #[test]
    fn validates_ir_dependencies() {
        let manifest = BundleManifest::new(
            "Cab",
            "2.5.3",
            vec![dependency(
                "Cab A",
                "wav",
                IR_PATH,
                "dependencies/root/ir_list/Cab A.wav",
            )],
        );
        let dependencies = vec![BundleDependency {
            manifest: manifest.dependencies[0].clone(),
            bytes: valid_wav(),
        }];
        let bytes = write_bundle_to_vec(&manifest, &preset_bytes(), &dependencies).unwrap();
        let loaded = read_bundle(&bytes).unwrap();
        assert_eq!(loaded.dependencies[0].bytes, valid_wav());
    }
}
