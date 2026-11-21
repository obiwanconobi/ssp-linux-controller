//! Preset discovery, naming rules, and rename payloads.

use serde::{Deserialize, Serialize};

use crate::command::hex_encode;
use crate::node::NodeStore;
use crate::{normalize_path, path_name, MAX_PRESET_NAME_BYTES, PRESET_LIST_PATH, PRESET_PATH};

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
