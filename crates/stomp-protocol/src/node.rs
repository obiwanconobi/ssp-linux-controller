//! Node store. Raw device fields are preserved so an unknown firmware addition
//! can never break the tree.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{ProtocolError, Result};
use crate::normalize_path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct Node(pub Map<String, Value>);

impl Node {
    pub fn new(fields: Map<String, Value>) -> Self {
        Self(fields)
    }

    pub fn raw(&self) -> &Map<String, Value> {
        &self.0
    }

    pub fn node_type(&self) -> &str {
        self.str_field("type")
    }

    pub fn item_type(&self) -> &str {
        self.str_field("item_type")
    }

    pub fn desc(&self) -> &str {
        self.str_field("desc")
    }

    pub fn style(&self) -> &str {
        self.str_field("style")
    }

    pub fn unit(&self) -> &str {
        self.str_field("unit")
    }

    pub fn dec(&self) -> Option<i64> {
        self.0.get("dec").and_then(Value::as_i64)
    }

    pub fn size(&self) -> Option<u64> {
        self.0.get("size").and_then(Value::as_u64)
    }

    pub fn chunk(&self) -> Option<u64> {
        self.0.get("chunk").and_then(Value::as_u64)
    }

    pub fn value(&self) -> Option<&Value> {
        self.0.get("value")
    }

    pub fn value_str(&self) -> Option<&str> {
        self.value().and_then(Value::as_str)
    }

    pub fn value_f64(&self) -> Option<f64> {
        self.value().and_then(as_f64)
    }

    pub fn value_bool(&self) -> Option<bool> {
        match self.value()? {
            Value::Bool(value) => Some(*value),
            Value::String(value) => match value.to_ascii_lowercase().as_str() {
                "on" | "true" | "yes" | "1" => Some(true),
                "off" | "false" | "no" | "0" => Some(false),
                _ => None,
            },
            Value::Number(number) => number.as_f64().map(|value| value != 0.0),
            _ => None,
        }
    }

    pub fn options(&self) -> Vec<String> {
        self.0
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| match item {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn reference(&self) -> Option<&str> {
        self.0.get("ref").and_then(Value::as_str)
    }

    pub fn min(&self) -> Option<f64> {
        self.0.get("min").and_then(as_f64)
    }

    pub fn max(&self) -> Option<f64> {
        self.0.get("max").and_then(as_f64)
    }

    fn str_field(&self, name: &str) -> &str {
        self.0.get(name).and_then(Value::as_str).unwrap_or("")
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

/// Ordered node cache keyed by firmware path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeStore {
    nodes: IndexMap<String, Node>,
}

impl NodeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_nodes(nodes: IndexMap<String, Node>) -> Self {
        Self { nodes }
    }

    pub fn insert(&mut self, path: impl Into<String>, node: Node) {
        self.nodes.insert(normalize_path(&path.into()), node);
    }

    pub fn remove(&mut self, path: &str) -> Option<Node> {
        self.nodes.shift_remove(&normalize_path(path))
    }

    pub fn get(&self, path: &str) -> Option<&Node> {
        self.nodes.get(&normalize_path(path))
    }

    pub fn get_mut(&mut self, path: &str) -> Option<&mut Node> {
        let key = normalize_path(path);
        self.nodes.get_mut(&key)
    }

    pub fn contains(&self, path: &str) -> bool {
        self.nodes.contains_key(&normalize_path(path))
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Node)> {
        self.nodes.iter()
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.nodes.keys()
    }

    pub fn value(&self, path: &str) -> Option<&Value> {
        self.get(path).and_then(Node::value)
    }

    pub fn value_str(&self, path: &str) -> Option<&str> {
        self.get(path).and_then(Node::value_str)
    }

    pub fn value_f64(&self, path: &str) -> Option<f64> {
        self.get(path).and_then(Node::value_f64)
    }

    /// Direct children of `path`, in browse-tree order.
    pub fn children(&self, path: &str) -> Vec<(&String, &Node)> {
        let prefix = format!("{}\\", normalize_path(path));
        self.nodes
            .iter()
            .filter(|(child, _)| {
                child
                    .strip_prefix(&prefix)
                    .is_some_and(|relative| !relative.is_empty() && !relative.contains('\\'))
            })
            .collect()
    }

    /// Apply `read root` deltas. Unknown paths are inserted, not rejected.
    pub fn apply_deltas<'a>(&mut self, lines: impl IntoIterator<Item = (&'a str, &'a Value)>) {
        for (path, value) in lines {
            if !value.is_object() {
                continue;
            }
            let path = normalize_path(path);
            match self.nodes.get_mut(&path) {
                Some(node) => node.0 = value.as_object().cloned().unwrap_or_default(),
                None => {
                    if let Some(object) = value.as_object() {
                        self.nodes.insert(path, Node::new(object.clone()));
                    }
                }
            }
        }
    }

    /// Merge one `path:json` update into the cache, creating the node if needed.
    pub fn merge(&mut self, path: &str, fields: &Map<String, Value>) {
        let path = normalize_path(path);
        if let Some(node) = self.nodes.get_mut(&path) {
            for (key, value) in fields {
                node.0.insert(key.clone(), value.clone());
            }
        } else {
            self.nodes.insert(path, Node::new(fields.clone()));
        }
    }

    pub fn set_value(&mut self, path: &str, value: Value) {
        let path = normalize_path(path);
        let node = self
            .nodes
            .entry(path)
            .or_insert_with(|| Node::new(Map::new()));
        node.0.insert("value".to_string(), value);
    }

    pub fn replace_from_pairs(&mut self, pairs: Vec<(String, Value)>) -> Result<()> {
        let mut next = IndexMap::with_capacity(pairs.len());
        for (path, value) in pairs {
            let Some(object) = value.as_object() else {
                return Err(ProtocolError::Protocol(format!(
                    "browse row for {path} is not an object"
                )));
            };
            next.insert(normalize_path(&path), Node::new(object.clone()));
        }
        self.nodes = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> NodeStore {
        let mut store = NodeStore::new();
        store.insert(
            r"root\app\drive",
            Node::new(
                json!({"type":"item","item_type":"block"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        store.insert(
            r"root\app\drive\gain",
            Node::new(
                json!({"type":"float","value":6.5,"min":0,"max":10})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        store.insert(
            r"root\app\drive\folder\sub",
            Node::new(
                json!({"type":"float","value":2.0})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        store
    }

    #[test]
    fn children_are_direct_only() {
        let store = store();
        let names: Vec<&str> = store
            .children(r"root\app\drive")
            .iter()
            .map(|(path, _)| crate::path_name(path))
            .collect();
        assert_eq!(names, vec!["gain"]);
    }

    #[test]
    fn unknown_fields_survive() {
        let node = Node::new(
            json!({"type":"float","value":1.0,"future_field":{"x":1}})
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(node.raw()["future_field"]["x"], 1);
    }

    #[test]
    fn double_escaped_paths_are_normalized() {
        let mut store = NodeStore::new();
        store.insert(
            r"root\\app\\gate",
            Node::new(json!({"type":"item"}).as_object().unwrap().clone()),
        );
        assert!(store.contains(r"root\app\gate"));
    }
}
