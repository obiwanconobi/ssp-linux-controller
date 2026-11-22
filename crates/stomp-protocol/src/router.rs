//! Router geometry, chain slots, and fixed-slot rules.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ProtocolError, Result};
use crate::labels::{block_family, block_label};
use crate::node::{Node, NodeStore};
use crate::{path_name, path_parent, DEFAULT_CHAIN, ROUTER_PATH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkType {
    Series,
    Parallel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChainSlot {
    pub row: usize,
    pub col: usize,
    pub path: Option<String>,
    pub fixed: bool,
    pub link: Option<LinkType>,
    pub label: String,
    pub family: String,
    pub on: Option<bool>,
}

impl ChainSlot {
    pub fn occupied(&self) -> bool {
        self.path.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChainBlock {
    pub path: String,
    pub label: String,
    pub family: String,
    pub on: Option<bool>,
    pub on_path: String,
    pub in_chain: bool,
    /// Hash of the block editor values (excluding on/off, which has its own
    /// field). Changes when a control value, model, or editor shape changes.
    #[serde(default)]
    pub control_revision: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ChainLayout {
    pub router_path: Option<String>,
    pub matrix: Vec<Vec<Value>>,
    pub fixed: Vec<Vec<bool>>,
}

impl ChainLayout {
    pub fn slots(&self, store: &NodeStore) -> Vec<ChainSlot> {
        let mut slots = Vec::new();
        for (row_index, row) in self.matrix.iter().enumerate() {
            for (col_index, cell) in row.iter().enumerate() {
                if is_link_cell(cell) {
                    continue;
                }
                let text = cell
                    .as_str()
                    .map(|text| crate::normalize_path(text).trim().to_string())
                    .unwrap_or_default();
                if !text.is_empty() && !is_interesting_path(&text) {
                    continue;
                }
                let fixed = self
                    .fixed
                    .get(row_index)
                    .and_then(|row| row.get(col_index))
                    .copied()
                    .unwrap_or(false);
                let link = if col_index > 0 {
                    link_type(&row[col_index - 1])
                } else {
                    None
                };
                let path = if text.is_empty() { None } else { Some(text) };
                let node = path.as_deref().and_then(|path| store.get(path));
                let label = match path.as_deref() {
                    Some(path) => block_label(path, node),
                    None => String::new(),
                };
                let family = path
                    .as_deref()
                    .map(|path| block_family(path_name(path)).to_string())
                    .unwrap_or_else(|| "utility".to_string());
                let on = path
                    .as_deref()
                    .and_then(|path| store.value_str(&format!("{path}\\on_off")))
                    .map(|value| value.eq_ignore_ascii_case("ON"));
                slots.push(ChainSlot {
                    row: row_index,
                    col: col_index,
                    path,
                    fixed,
                    link,
                    label,
                    family,
                    on,
                });
            }
        }
        slots
    }

    pub fn cell(&self, row: usize, col: usize) -> Result<&Value> {
        self.matrix
            .get(row)
            .and_then(|row| row.get(col))
            .ok_or_else(|| ProtocolError::InvalidRequest("chain slot is out of range".into()))
    }

    pub fn cell_fixed(&self, row: usize, col: usize) -> bool {
        self.fixed
            .get(row)
            .and_then(|row| row.get(col))
            .copied()
            .unwrap_or(false)
    }

    pub fn set_slot(&mut self, row: usize, col: usize, path: Option<&str>) -> Result<()> {
        if self.cell_fixed(row, col) {
            return Err(ProtocolError::InvalidRequest(
                "that chain slot is fixed".into(),
            ));
        }
        let row_values = self
            .matrix
            .get_mut(row)
            .ok_or_else(|| ProtocolError::InvalidRequest("chain slot is out of range".into()))?;
        let cell = row_values
            .get_mut(col)
            .ok_or_else(|| ProtocolError::InvalidRequest("chain slot is out of range".into()))?;
        *cell = Value::String(path.unwrap_or("").to_string());
        Ok(())
    }

    pub fn move_block(
        &mut self,
        row: usize,
        col: usize,
        target_row: usize,
        target_col: usize,
    ) -> Result<()> {
        if (row, col) == (target_row, target_col) {
            return Ok(());
        }
        let source = self.cell(row, col)?.clone();
        let target = self.cell(target_row, target_col)?.clone();
        if source.as_str().is_none_or(str::is_empty) {
            return Err(ProtocolError::InvalidRequest(
                "that chain slot is empty".into(),
            ));
        }
        if self.cell_fixed(row, col) || self.cell_fixed(target_row, target_col) {
            return Err(ProtocolError::InvalidRequest(
                "fixed blocks cannot be moved".into(),
            ));
        }
        self.matrix[row][col] = target;
        self.matrix[target_row][target_col] = source;
        Ok(())
    }

    pub fn link_into(&self, row: usize, col: usize) -> Result<LinkType> {
        if col == 0 {
            return Err(ProtocolError::InvalidRequest(
                "the first chain slot has no previous link".into(),
            ));
        }
        let Some(row) = self.matrix.get(row) else {
            return Err(ProtocolError::InvalidRequest(
                "chain row is out of range".into(),
            ));
        };
        let Some(cell) = row.get(col - 1) else {
            return Err(ProtocolError::InvalidRequest(
                "that chain position has no link".into(),
            ));
        };
        link_type(cell)
            .ok_or_else(|| ProtocolError::InvalidRequest("that chain position has no link".into()))
    }

    pub fn set_link(&mut self, row: usize, col: usize, parallel: bool) -> Result<()> {
        if col == 0 {
            return Err(ProtocolError::InvalidRequest(
                "the first chain slot has no previous link".into(),
            ));
        }
        let Some(row_values) = self.matrix.get_mut(row) else {
            return Err(ProtocolError::InvalidRequest(
                "chain row is out of range".into(),
            ));
        };
        let Some(cell) = row_values.get_mut(col - 1) else {
            return Err(ProtocolError::InvalidRequest(
                "that chain position has no link".into(),
            ));
        };
        if link_type(cell).is_none() {
            return Err(ProtocolError::InvalidRequest(
                "that chain position has no link".into(),
            ));
        }
        *cell = Value::String(if parallel { "p" } else { "s" }.to_string());
        Ok(())
    }

    /// Remove every movable block, preserving fixed slots and chain links.
    /// This mirrors the Python client's `clear_chain` exactly.
    pub fn clear(&mut self) {
        for row_index in 0..self.matrix.len() {
            for col_index in 0..self.matrix[row_index].len() {
                let fixed = self
                    .fixed
                    .get(row_index)
                    .and_then(|row| row.get(col_index))
                    .copied()
                    .unwrap_or(false);
                if fixed || is_link_cell(&self.matrix[row_index][col_index]) {
                    continue;
                }
                self.matrix[row_index][col_index] = Value::String(String::new());
            }
        }
    }

    pub fn value(&self) -> Value {
        Value::Array(self.matrix.iter().cloned().map(Value::Array).collect())
    }

    pub fn signature(&self) -> String {
        serde_json::to_string(&self.matrix).unwrap_or_default()
    }
}

/// Find the router path using the same preference order as the Python client.
pub fn find_router(store: &NodeStore) -> Option<String> {
    if store
        .get(ROUTER_PATH)
        .is_some_and(|node| node.node_type() == "router")
    {
        return Some(ROUTER_PATH.to_string());
    }

    // Prefer a router whose parent also owns a master/output child.
    let routers: Vec<&String> = store
        .iter()
        .filter(|(path, node)| path_name(path) == "router" && node.node_type() == "router")
        .map(|(path, _)| path)
        .collect();
    for path in &routers {
        let parent = path_parent(path);
        if store.contains(&format!("{parent}\\master"))
            || store.contains(&format!("{parent}\\output"))
        {
            return Some((*path).clone());
        }
    }
    routers.first().map(|path| (*path).clone())
}

pub fn load_chain(store: &NodeStore) -> Option<ChainLayout> {
    let router_path = find_router(store)?;
    let router = store.get(&router_path)?;
    let value = router.value()?;
    let matrix = router_rows(value);
    let fixed = fixed_rows(router.raw().get("fixed"), matrix.len());
    Some(ChainLayout {
        router_path: Some(router_path),
        matrix,
        fixed,
    })
}

pub fn chain_blocks(store: &NodeStore) -> Vec<ChainBlock> {
    let Some(layout) = load_chain(store) else {
        // Known-chain fallback for firmware that does not expose a router.
        return DEFAULT_CHAIN
            .iter()
            .filter_map(|name| {
                let path = format!(r"root\app\{name}");
                let on_path = format!("{path}\\on_off");
                let node = store.get(&path)?;
                if node.item_type() != "block" && !store.contains(&on_path) {
                    return None;
                }
                let on = store
                    .value_str(&on_path)
                    .map(|value| value.eq_ignore_ascii_case("ON"));
                Some(ChainBlock {
                    label: block_label(&path, Some(node)),
                    family: block_family(name).to_string(),
                    control_revision: editor_revision(store, &path),
                    path,
                    on,
                    on_path,
                    in_chain: true,
                })
            })
            .collect();
    };

    layout
        .slots(store)
        .into_iter()
        .filter_map(|slot| {
            let path = slot.path?;
            Some(ChainBlock {
                label: slot.label,
                family: slot.family,
                control_revision: editor_revision(store, &path),
                on_path: format!("{path}\\on_off"),
                on: slot.on,
                path,
                in_chain: true,
            })
        })
        .collect()
}

/// Stable-within-a-session hash of the editor values the UI consumes.
fn editor_revision(store: &NodeStore, path: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let editor = crate::editor::block_editor(store, path);
    let bytes = serde_json::to_vec(&editor).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Return block items in the router's parent that are not currently in the chain.
pub fn available_blocks(store: &NodeStore) -> Vec<Value> {
    let Some(layout) = load_chain(store) else {
        return Vec::new();
    };
    let Some(router_path) = layout.router_path.as_deref() else {
        return Vec::new();
    };
    let parent = path_parent(router_path);
    let used: Vec<String> = layout
        .slots(store)
        .into_iter()
        .filter_map(|slot| slot.path)
        .collect();

    let mut available: Vec<Value> = store
        .iter()
        .filter(|(path, node)| {
            path_parent(path) == parent
                && node.item_type() == "block"
                && !used.iter().any(|used_path| used_path == *path)
        })
        .map(|(path, node)| {
            json!({
                "path": path,
                "name": block_label(path, Some(node)),
                "desc": node.desc(),
            })
        })
        .collect();
    available.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&right["name"].as_str().unwrap_or_default().to_lowercase())
            .then_with(|| {
                left["path"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["path"].as_str().unwrap_or_default())
            })
    });
    available
}

pub fn flatten_router(value: &Value) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    walk_router(value, &mut found);
    found
}

fn walk_router(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let text = crate::normalize_path(text).trim().to_string();
            if is_link_cell(&Value::String(text.clone())) || text.is_empty() {
                return;
            }
            if is_interesting_path(&text) && !found.contains(&text) {
                found.push(text);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_router(item, found);
            }
        }
        _ => {}
    }
}

pub fn router_rows(value: &Value) -> Vec<Vec<Value>> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    if items.is_empty() {
        return Vec::new();
    }
    if items.iter().all(Value::is_array) {
        items
            .iter()
            .map(|row| row.as_array().cloned().unwrap_or_default())
            .collect()
    } else {
        vec![items.clone()]
    }
}

fn fixed_rows(value: Option<&Value>, rows: usize) -> Vec<Vec<bool>> {
    let Some(items) = value.and_then(Value::as_array) else {
        return vec![Vec::new(); rows];
    };
    if items.iter().all(Value::is_array) {
        items
            .iter()
            .map(|row| {
                row.as_array()
                    .map(|cells| {
                        cells
                            .iter()
                            .map(|cell| cell.as_bool().unwrap_or(false))
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect()
    } else {
        vec![items
            .iter()
            .map(|cell| cell.as_bool().unwrap_or(false))
            .collect()]
    }
}

pub fn is_link_cell(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "s" | "p" | "parallel" | "series"
    )
}

fn link_type(value: &Value) -> Option<LinkType> {
    let text = value.as_str()?.trim().to_ascii_lowercase();
    match text.as_str() {
        "p" | "parallel" => Some(LinkType::Parallel),
        "s" | "series" => Some(LinkType::Series),
        _ => None,
    }
}

fn is_interesting_path(text: &str) -> bool {
    text == "root" || text.starts_with("root\\")
}

/// Helper for tests and simulators: build a node store from JSON pairs.
pub fn store_from_pairs(pairs: Vec<(&str, Value)>) -> NodeStore {
    let mut store = NodeStore::new();
    for (path, value) in pairs {
        if let Some(object) = value.as_object() {
            store.insert(path, Node::new(object.clone()));
        }
    }
    store
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_store() -> NodeStore {
        store_from_pairs(vec![
            ("root", json!({"type":"root","value":""})),
            (r"root\app", json!({"type":"item","item_type":"module"})),
            (
                r"root\app\router",
                json!({
                    "type": "router",
                    "value": [["root\\\\app\\\\gate","s","root\\\\app\\\\drive"],["root\\\\app\\\\amp",""]]
                }),
            ),
            (
                r"root\app\gate",
                json!({"type":"item","item_type":"block","desc":"Gate"}),
            ),
            (r"root\app\gate\on_off", json!({"type":"enum","value":"ON"})),
            (
                r"root\app\drive",
                json!({"type":"item","item_type":"block","desc":"Drive"}),
            ),
            (
                r"root\app\drive\on_off",
                json!({"type":"enum","value":"OFF"}),
            ),
            (
                r"root\app\amp",
                json!({"type":"item","item_type":"block","desc":"Amp"}),
            ),
            (r"root\app\amp\on_off", json!({"type":"enum","value":"ON"})),
            (
                r"root\app\chorus",
                json!({"type":"item","item_type":"block","desc":"Chorus"}),
            ),
            (
                r"root\app\chorus\on_off",
                json!({"type":"enum","value":"OFF"}),
            ),
        ])
    }

    #[test]
    fn matrix_and_flat_forms_flatten() {
        let matrix = json!([
            ["root\\\\app\\\\gate", "s", "root\\\\app\\\\amp"],
            ["", "root\\\\app\\\\ir"]
        ]);
        assert_eq!(
            flatten_router(&matrix),
            vec![r"root\app\gate", r"root\app\amp", r"root\app\ir"]
        );
        let flat = json!(["root\\app\\gate", "s", "", "root\\app\\delay"]);
        assert_eq!(
            flatten_router(&flat),
            vec![r"root\app\gate", r"root\app\delay"]
        );
    }

    #[test]
    fn chain_slots_skip_link_cells() {
        let store = base_store();
        let layout = load_chain(&store).unwrap();
        let slots = layout.slots(&store);
        assert_eq!(slots.len(), 4);
        assert_eq!(slots[0].path.as_deref(), Some(r"root\app\gate"));
        assert_eq!(slots[1].path.as_deref(), Some(r"root\app\drive"));
        assert_eq!(slots[1].link, Some(LinkType::Series));
        assert_eq!(slots[3].path, None);
    }

    #[test]
    fn available_blocks_exclude_chain_members() {
        let store = base_store();
        let available = available_blocks(&store);
        assert_eq!(available.len(), 1);
        assert_eq!(available[0]["path"], r"root\app\chorus");
    }

    #[test]
    fn find_router_prefers_the_container_with_a_master() {
        let store = store_from_pairs(vec![
            (r"root\a\router", json!({"type":"router","value":[[]]})),
            (r"root\app\router", json!({"type":"router","value":[[""]]})),
            (r"root\app\output", json!({"type":"item"})),
        ]);
        assert_eq!(find_router(&store).as_deref(), Some(r"root\app\router"));
    }

    #[test]
    fn clear_preserves_fixed_blocks_and_links() {
        let store = store_from_pairs(vec![
            (
                r"root\app\router",
                json!({
                    "type": "router",
                    "value": [["root\\\\app\\\\amp", "s", "root\\\\app\\\\drive", ""]],
                    "fixed": [[true, false, false, false]]
                }),
            ),
            (r"root\app\amp", json!({"item_type":"block"})),
            (r"root\app\drive", json!({"item_type":"block"})),
        ]);
        let mut layout = load_chain(&store).unwrap();
        layout.clear();
        assert_eq!(layout.matrix[0][0], json!("root\\\\app\\\\amp"));
        assert_eq!(layout.matrix[0][1], "s");
        assert_eq!(layout.matrix[0][2], "");
        assert_eq!(layout.matrix[0][3], "");
    }

    #[test]
    fn fixed_slots_cannot_move() {
        let store = store_from_pairs(vec![
            (
                r"root\app\router",
                json!({"type":"router","value":[["root\\\\app\\\\amp","root\\\\app\\\\delay"]],"fixed":[[true,false]]}),
            ),
            (r"root\app\amp", json!({"item_type":"block"})),
            (r"root\app\delay", json!({"item_type":"block"})),
        ]);
        let mut layout = load_chain(&store).unwrap();
        assert!(layout.move_block(0, 0, 0, 1).is_err());
        assert!(layout.set_slot(0, 0, None).is_err());
        layout.move_block(0, 1, 0, 1).unwrap();
    }
}
