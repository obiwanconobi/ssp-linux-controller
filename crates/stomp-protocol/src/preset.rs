//! Preset discovery, naming rules, and rename payloads.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::command::hex_encode;
use crate::node::NodeStore;
use crate::{
    normalize_path, path_name, IR_PATH, MAX_PRESET_NAME_BYTES, NAM_DRIVE_PATH, NAM_PATH,
    PNAM_DRIVE_PATH, PNAM_PATH, PRESET_LIST_PATH, PRESET_PATH, VXAMP_PATH,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PresetState {
    pub path: Option<String>,
    pub list_path: Option<String>,
    pub current: String,
    pub names: Vec<String>,
}

impl PresetState {
    pub fn current_index(&self) -> Option<usize> {
        self.names.iter().position(|name| name == &self.current)
    }
}

pub fn preset_state(store: &NodeStore) -> PresetState {
    let mut preset_path = if store.contains(PRESET_PATH) {
        Some(PRESET_PATH.to_string())
    } else {
        store
            .iter()
            .find(|(path, node)| {
                path_name(path) == "preset"
                    && node.node_type() == "plist"
                    && node.value().is_some_and(|value| value.is_string())
            })
            .map(|(path, _)| path.clone())
    };

    let mut current = String::new();
    let mut list_path = None;
    if let Some(path) = preset_path.as_deref() {
        if let Some(node) = store.get(path) {
            if let Some(value) = node.value_str() {
                current = value.to_string();
            }
            if let Some(reference) = node.reference() {
                let reference = normalize_path(reference);
                if is_interesting_path(&reference) {
                    list_path = Some(reference);
                }
            }
        }
    }

    if list_path.is_none() && store.contains(PRESET_LIST_PATH) {
        list_path = Some(PRESET_LIST_PATH.to_string());
    }

    if list_path.is_none() {
        list_path = store
            .iter()
            .find(|(_, node)| node.node_type() == "list" && node.item_type().starts_with("pst"))
            .map(|(path, _)| path.clone());
    }

    let names: Vec<String> = list_path
        .as_deref()
        .and_then(|path| store.get(path))
        .and_then(|node| node.value())
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    serde_json::Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    if preset_path.is_none() && !names.is_empty() {
        preset_path = None;
    }

    PresetState {
        path: preset_path,
        list_path,
        current,
        names,
    }
}

/// One non-empty dependency recorded in `root\presets.used` for a preset slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PresetReference {
    pub preset_index: usize,
    pub preset_name: String,
    pub node_path: String,
    pub capture: String,
    pub list_path: String,
    pub extension: String,
}

/// Map the preset-relevant selector paths to the capture list they load.
///
/// Only confirmed 2.5.3 paths are listed. An unknown path in `used` is returned
/// separately by [`preset_references`] so export can refuse rather than guess.
pub fn capture_target(node_path: &str) -> Option<(&'static str, &'static str)> {
    match normalize_path(node_path).as_str() {
        r"root\app\amp\model" => Some((NAM_PATH, "nam")),
        r"root\app\amp\pmodel" => Some((PNAM_PATH, "pnam")),
        r"root\app\amp\nam2\model" => Some((NAM_PATH, "nam")),
        r"root\app\amp\nam2\pmodel" => Some((PNAM_PATH, "pnam")),
        r"root\app\drive\model" => Some((NAM_DRIVE_PATH, "nam")),
        r"root\app\drive\pmodel" => Some((PNAM_DRIVE_PATH, "pnam")),
        r"root\app\ir\ir" => Some((IR_PATH, "wav")),
        r"root\app\ir\ir2\ir" => Some((IR_PATH, "wav")),
        r"root\app\vxamp\model" => Some((VXAMP_PATH, "vxamp")),
        _ => None,
    }
}

/// Read `root\presets.used` into one entry per (preset, capture) pair.
///
/// The firmware stores an object keyed by selector path whose values are arrays
/// with one capture name per preset slot. Unknown selector paths are preserved
/// with empty `list_path`/`extension` so callers can reject them explicitly.
pub fn preset_references(store: &NodeStore) -> Vec<PresetReference> {
    let state = preset_state(store);
    let Some(list_path) = state.list_path.as_deref() else {
        return Vec::new();
    };
    let Some(list) = store.get(list_path) else {
        return Vec::new();
    };
    let Some(used) = list.raw().get("used").and_then(|value| value.as_object()) else {
        return Vec::new();
    };

    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (node_path, values) in used {
        let node_path = normalize_path(node_path);
        let (target_list, extension) = capture_target(&node_path).unwrap_or(("", ""));
        let Some(values) = values.as_array() else {
            continue;
        };
        for (index, value) in values.iter().enumerate() {
            let Some(capture) = value
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            if !seen.insert((index, target_list.to_string(), capture.to_string())) {
                continue;
            }
            out.push(PresetReference {
                preset_index: index,
                preset_name: state.names.get(index).cloned().unwrap_or_default(),
                node_path: node_path.clone(),
                capture: capture.to_string(),
                list_path: target_list.to_string(),
                extension: extension.to_string(),
            });
        }
    }
    out
}

/// Preset slots that reference the given capture in the given list.
pub fn presets_using(store: &NodeStore, list_path: &str, capture: &str) -> Vec<PresetReference> {
    let list_path = normalize_path(list_path);
    preset_references(store)
        .into_iter()
        .filter(|reference| reference.list_path == list_path && reference.capture == capture)
        .collect()
}

pub fn preset_name_error(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("patch name cannot be empty");
    }
    if name
        .chars()
        .any(|character| character == '\0' || (character as u32) < 32)
    {
        return Some("patch name cannot contain control characters");
    }
    if name.len() > MAX_PRESET_NAME_BYTES {
        return Some("patch name must be at most 63 bytes");
    }
    None
}

/// Same wire rules as preset names, with capture-specific wording.
pub fn list_name_error(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("capture name cannot be empty");
    }
    if name
        .chars()
        .any(|character| character == '\0' || (character as u32) < 32)
    {
        return Some("capture name cannot contain control characters");
    }
    if name.len() > MAX_PRESET_NAME_BYTES {
        return Some("capture name must be at most 63 bytes");
    }
    None
}

/// Encode the 128-byte name chunk used by rename and by upload chunk 0.
pub fn name_chunk(name: &str) -> Vec<u8> {
    let mut bytes = name.as_bytes().to_vec();
    bytes.truncate(crate::NAME_SIZE);
    bytes.resize(crate::NAME_SIZE, 0);
    bytes
}

pub fn rename_hex(name: &str) -> String {
    hex_encode(&name_chunk(name))
}

/// Validate a rename before any bytes are sent.
pub fn rename_error(names: &[String], old_name: &str, new_name: &str) -> Option<String> {
    if old_name.is_empty() {
        return Some("there is no preset selected to rename".into());
    }
    if let Some(problem) = preset_name_error(new_name) {
        return Some(problem.into());
    }
    let Some(index) = names.iter().position(|name| name == old_name) else {
        return Some(format!("preset {old_name:?} is not in the list"));
    };
    if new_name == old_name {
        return None;
    }
    if names.iter().enumerate().any(|(other, existing)| {
        other != index && !existing.is_empty() && existing.to_lowercase() == new_name.to_lowercase()
    }) {
        return Some(format!("a preset named {new_name:?} already exists"));
    }
    None
}

fn is_interesting_path(path: &str) -> bool {
    path == "root" || path.starts_with("root\\")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::Node;
    use serde_json::json;

    fn store() -> NodeStore {
        let mut store = NodeStore::new();
        store.insert(
            r"root\app\preset",
            Node::new(
                json!({"type":"plist","value":"Patch B","ref":"root\\presets"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        store.insert(
            r"root\presets",
            Node::new(
                json!({"type":"list","item_type":"pst_pst","value":["Patch A","Patch B",""]})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        store
    }

    #[test]
    fn discovers_reference_and_names() {
        let state = preset_state(&store());
        assert_eq!(state.current, "Patch B");
        assert_eq!(state.list_path.as_deref(), Some(r"root\presets"));
        assert_eq!(state.names.len(), 3);
        assert_eq!(state.current_index(), Some(1));
    }

    #[test]
    fn rename_validation_matches_device_rules() {
        let names = vec!["Patch A".into(), "Patch B".into(), String::new()];
        assert!(rename_error(&names, "Patch B", "Patch A").is_some());
        assert!(rename_error(&names, "Patch B", "patch a").is_some());
        assert!(rename_error(&names, "Patch B", &"x".repeat(64)).is_some());
        assert!(rename_error(&names, "Patch B", "Renamed B").is_none());
    }

    #[test]
    fn reads_preset_references_from_the_used_map() {
        let mut store = store();
        let list = store.get_mut(r"root\presets").unwrap();
        list.0.insert(
            "used".to_string(),
            json!({
                r"root\app\amp\model": ["", "Amp B", "Amp B"],
                r"root\app\drive\model": ["", "Drive A", ""],
                r"root\app\ir\ir": ["", "", "Cab X"],
                r"root\app\vxamp\model": ["Legacy A", "", ""]
            }),
        );

        let references = preset_references(&store);
        assert_eq!(references.len(), 5, "{references:?}");
        let amp = references
            .iter()
            .find(|reference| {
                reference.node_path == r"root\app\amp\model" && reference.preset_index == 1
            })
            .expect("amp reference");
        assert_eq!(amp.list_path, NAM_PATH);
        assert_eq!(amp.extension, "nam");
        assert_eq!(amp.capture, "Amp B");
        assert_eq!(amp.preset_name, "Patch B");

        let vxamp = references
            .iter()
            .find(|reference| reference.node_path == r"root\app\vxamp\model")
            .expect("VXAMP reference");
        assert_eq!(vxamp.list_path, VXAMP_PATH);
        assert_eq!(vxamp.extension, "vxamp");
        assert_eq!(vxamp.preset_index, 0);

        let used = presets_using(&store, NAM_PATH, "Amp B");
        assert_eq!(used.len(), 2, "both patch slots reference Amp B");
    }

    #[test]
    fn preserves_unknown_preset_reference_paths_for_export_rejection() {
        let mut store = store();
        store.get_mut(r"root\presets").unwrap().0.insert(
            "used".to_string(),
            json!({ r"root\app\mystery\model": ["Unknown"] }),
        );
        let references = preset_references(&store);
        assert_eq!(references.len(), 1);
        assert!(references[0].list_path.is_empty());
        assert!(references[0].extension.is_empty());
    }

    #[test]
    fn rename_payload_is_128_bytes_of_hex() {
        let hex = rename_hex("Renamed B");
        assert_eq!(hex.len(), crate::NAME_SIZE * 2);
        let decoded = hex::decode_len(&hex);
        assert_eq!(decoded, "Renamed B");
    }

    mod hex {
        pub fn decode_len(text: &str) -> String {
            let bytes: Vec<u8> = (0..text.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
                .collect();
            String::from_utf8_lossy(&bytes)
                .trim_end_matches('\0')
                .to_string()
        }
    }
}
