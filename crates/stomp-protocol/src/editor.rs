//! Derivation of typed editor controls from the raw browse tree.
//!
//! The firmware's nested folders, tempo modules, parametric NAM styles, and
//! type-aware visibility rules are all preserved here. This is the port of
//! `get_block_editor` / `_collect_control_children` from `stomp.py`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::labels::{block_family, block_label, label_alias};
use crate::node::{Node, NodeStore};
use crate::{normalize_path, path_name, path_parent};

const CONTROL_FOLDERS: &[&str] = &["vfolder", "vfolder_tc", "hfolder", "sfolder"];
const LEGACY_NAM_BLOCK_PARAMS: &[&str] = &["model", "gain", "low", "mid", "treble"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditorNode {
    /// `float`, `pfloat`, `enum`, `choice`, `bool`, `number`, `text`, `group`,
    /// or `time`.
    pub kind: String,
    pub path: String,
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub display_min: Option<f64>,
    #[serde(default)]
    pub display_max: Option<f64>,
    #[serde(default)]
    pub display_default: Option<f64>,
    #[serde(default)]
    pub decimals: Option<u8>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub pfloat: bool,
    #[serde(default)]
    pub vtype: String,
    #[serde(default)]
    pub item_type: String,
    #[serde(default)]
    pub on_off: Option<GroupSwitch>,
    #[serde(default)]
    pub module_value: Option<String>,
    #[serde(default)]
    pub rawdata: Option<Box<EditorNode>>,
    #[serde(default)]
    pub subdivision: Option<Box<EditorNode>>,
    #[serde(default)]
    pub lock: Option<Box<EditorNode>>,
    #[serde(default)]
    pub mode_options: Vec<ModeOption>,
    #[serde(default)]
    pub parameters: Vec<EditorNode>,
    #[serde(default)]
    pub items: Vec<EditorNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupSwitch {
    pub path: String,
    pub value: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModeOption {
    pub value: String,
    pub label: String,
}

impl EditorNode {
    pub fn is_control(&self) -> bool {
        !matches!(self.kind.as_str(), "group" | "time")
    }

    pub fn is_group(&self) -> bool {
        matches!(self.kind.as_str(), "group" | "time")
    }

    pub fn numeric_value(&self) -> Option<f64> {
        self.value.as_f64()
    }

    /// Display-domain value for a parametric control. The protocol value is
    /// normalized 0..1; `vmin`/`vmax` live in the style metadata.
    pub fn display_value(&self) -> Option<f64> {
        if self.kind == "pfloat" {
            let raw = self.numeric_value()?;
            let min = self.display_min?;
            let max = self.display_max?;
            let low = self.min.unwrap_or(0.0);
            let high = self.max.unwrap_or(1.0);
            if high <= low {
                return Some(min);
            }
            Some(min + (raw - low) / (high - low) * (max - min))
        } else {
            self.numeric_value()
        }
    }

    pub fn display_span(&self) -> (f64, f64) {
        if self.kind == "pfloat" {
            (
                self.display_min.unwrap_or(0.0),
                self.display_max.unwrap_or(1.0),
            )
        } else {
            (self.min.unwrap_or(0.0), self.max.unwrap_or(1.0))
        }
    }

    pub fn label_or_name(&self) -> &str {
        if !self.label.is_empty() {
            &self.label
        } else if !self.desc.is_empty() {
            &self.desc
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockEditor {
    pub path: String,
    pub label: String,
    pub family: String,
    pub on: Option<bool>,
    pub on_path: String,
    pub parameters: Vec<EditorNode>,
    pub items: Vec<EditorNode>,
}

impl BlockEditor {
    pub fn flatten_controls(&self) -> Vec<&EditorNode> {
        let mut out = Vec::new();
        for item in &self.items {
            flatten_node(item, &mut out);
        }
        out
    }

    /// The three controls a pedal shell should show, in priority order.
    pub fn knob_targets(&self) -> Vec<&EditorNode> {
        let eligible: Vec<&EditorNode> = self
            .flatten_controls()
            .into_iter()
            .filter(|node| node.visible && is_continuous(node))
            .collect();

        let mut chosen: Vec<&EditorNode> = Vec::new();
        for wanted in crate::labels::shell_knob_names(&self.family) {
            if let Some(node) = eligible.iter().find(|node| {
                node.name.eq_ignore_ascii_case(wanted)
                    || label_alias(&node.name).eq_ignore_ascii_case(label_alias(wanted))
            }) {
                if !chosen.iter().any(|existing| existing.path == node.path) {
                    chosen.push(node);
                }
            }
        }
        for node in eligible {
            if chosen.len() >= 3 {
                break;
            }
            if !chosen.iter().any(|existing| existing.path == node.path) {
                chosen.push(node);
            }
        }
        chosen.truncate(3);
        chosen
    }
}

fn flatten_node<'a>(node: &'a EditorNode, out: &mut Vec<&'a EditorNode>) {
    if node.is_group() {
        for child in &node.parameters {
            out.push(child);
        }
        for child in &node.items {
            if child.is_group() {
                flatten_node(child, out);
            } else if !out.iter().any(|existing| existing.path == child.path) {
                out.push(child);
            }
        }
    } else {
        out.push(node);
    }
}

pub fn is_continuous(node: &EditorNode) -> bool {
    matches!(node.kind.as_str(), "float" | "pfloat" | "number")
}

pub fn parse_style(style: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for part in style.split(';') {
        if let Some((key, value)) = part.split_once(':') {
            let key = key.trim();
            if !key.is_empty() {
                fields.insert(key.to_string(), value.trim().to_string());
            }
        }
    }
    fields
}

pub fn block_editor(store: &NodeStore, block_path: &str) -> BlockEditor {
    let block_path = normalize_path(block_path);
    let node = store.get(&block_path);
    let name = path_name(&block_path);
    let label = block_label(&block_path, node);
    let family = block_family(name).to_string();
    let on_path = format!("{block_path}\\on_off");
    let on = store
        .value_str(&on_path)
        .map(|value| value.eq_ignore_ascii_case("ON"));

    let mut parameters = Vec::new();
    let mut items = Vec::new();
    collect_children(store, &block_path, &mut parameters, &mut items);

    BlockEditor {
        path: block_path,
        label,
        family,
        on,
        on_path,
        parameters,
        items,
    }
}

pub fn flatten_editor_parameters(editor: &BlockEditor) -> Vec<EditorNode> {
    let mut out = Vec::new();
    for item in &editor.items {
        flatten_owned(item, &mut out);
    }
    out
}

fn flatten_owned(node: &EditorNode, out: &mut Vec<EditorNode>) {
    if node.is_group() {
        for child in &node.parameters {
            out.push(child.clone());
        }
        for child in &node.items {
            if child.is_group() {
                flatten_owned(child, out);
            } else if !out.iter().any(|existing| existing.path == child.path) {
                out.push(child.clone());
            }
        }
    } else {
        out.push(node.clone());
    }
}

fn collect_children(
    store: &NodeStore,
    path: &str,
    parameters: &mut Vec<EditorNode>,
    items: &mut Vec<EditorNode>,
) {
    for (child_path, node) in store.children(path) {
        let name = path_name(child_path);
        if name == "on_off" || name.starts_with('_') {
            continue;
        }
        let item_type = node.item_type();
        if item_type == "link" {
            continue;
        }
        if CONTROL_FOLDERS.contains(&item_type) || item_type == "module" {
            let group = group_from_node(store, child_path, node);
            items.push(group);
        } else if let Some(parameter) = parameter_from_node(store, child_path, node) {
            parameters.push(parameter.clone());
            items.push(parameter);
        }
    }
}

fn group_from_node(store: &NodeStore, path: &str, node: &Node) -> EditorNode {
    let item_type = node.item_type().to_string();
    let on_path = format!("{path}\\on_off");
    let on_off = store.get(&on_path).map(|on_node| GroupSwitch {
        path: on_path,
        value: on_node.value_bool(),
    });

    let mut parameters = Vec::new();
    let mut items = Vec::new();
    collect_children(store, path, &mut parameters, &mut items);

    let style = parse_style(node.style());
    let visible = !matches!(
        style.get("visible").map(|value| value.to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "false" | "0" | "no" | "off")
    );

    let mut group = EditorNode {
        kind: "group".to_string(),
        path: path.to_string(),
        name: path_name(path).to_string(),
        label: if node.desc().is_empty() {
            path_name(path).to_string()
        } else {
            node.desc().to_string()
        },
        value: Value::Null,
        visible,
        desc: node.desc().to_string(),
        item_type: item_type.clone(),
        on_off,
        parameters: parameters.clone(),
        items: items.clone(),
        ..EditorNode::empty()
    };

    if item_type == "module" {
        let named: HashMap<&str, &EditorNode> = parameters
            .iter()
            .map(|param| (param.name.as_str(), param))
            .collect();
        let rawdata = named.get("rawdata").copied();
        let subdivision = named.get("sbdv").copied();
        let lock = named.get("lock").copied();
        if let (Some(rawdata), Some(subdivision)) = (rawdata, subdivision) {
            let keep: Vec<EditorNode> = parameters
                .iter()
                .filter(|param| !matches!(param.name.as_str(), "rawdata" | "sbdv" | "lock"))
                .cloned()
                .collect();
            let keep_items: Vec<EditorNode> = items
                .iter()
                .filter(|item| !matches!(item.name.as_str(), "rawdata" | "sbdv" | "lock"))
                .cloned()
                .collect();
            let manual_label = if rawdata.unit.is_empty() {
                "Manual".to_string()
            } else {
                format!("Manual ({})", rawdata.unit)
            };
            group.kind = "time".to_string();
            group.module_value = node.value_str().map(str::to_string);
            group.parameters = keep;
            group.items = keep_items;
            group.mode_options = vec![
                ModeOption {
                    value: "partempo".to_string(),
                    label: "Tempo Sync".to_string(),
                },
                ModeOption {
                    value: "rawdata".to_string(),
                    label: manual_label,
                },
            ];
            group.rawdata = Some(Box::new(rawdata.clone()));
            group.subdivision = Some(Box::new(subdivision.clone()));
            group.lock = lock.map(|lock| Box::new(lock.clone()));
            if let Some(lock) = &group.lock {
                group.parameters.push((**lock).clone());
                group.items.push((**lock).clone());
            }
        }
    }

    group
}

/// Parse the firmware 2.5.3 PNAM switch spelling.
///
/// Newer firmware serializes a parametric model's switch positions as a JSON
/// array in the `vtype` style field, for example `vtype:["ON","OFF"]`.
/// Older firmware used separate `voptions`-style keys instead.
fn vtype_array_options(raw: &str) -> Option<Vec<String>> {
    let raw = raw.trim();
    if !raw.starts_with('[') {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    let options: Vec<String> = value
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|option| !option.is_empty())
        .map(str::to_string)
        .collect();
    (options.len() > 1).then_some(options)
}

fn parameter_from_node(store: &NodeStore, path: &str, node: &Node) -> Option<EditorNode> {
    let value = node.value()?.clone();
    let ntype = node.node_type();
    let desc = node.desc().to_string();
    let name = path_name(path).to_string();
    let style = parse_style(node.style());
    let mut visible = !matches!(
        style.get("visible").map(|value| value.to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "false" | "0" | "no" | "off")
    );
    let model_type = block_model_type(path, store);
    visible = type_aware_visibility(&name, ntype, "", visible, &model_type);

    let mut editor = EditorNode {
        kind: String::new(),
        path: path.to_string(),
        name: name.clone(),
        label: label_alias(&name).to_string(),
        value: value.clone(),
        visible,
        desc: desc.clone(),
        item_type: node.item_type().to_string(),
        ..EditorNode::empty()
    };

    match ntype {
        "pfloat" => {
            let raw_min = node.min().unwrap_or(0.0);
            let raw_max = node.max().filter(|max| *max > raw_min).unwrap_or(1.0);
            let display_min = style.get("vmin").and_then(|text| text.parse::<f64>().ok());
            let display_max = style.get("vmax").and_then(|text| text.parse::<f64>().ok());
            let display_default = style.get("vdef").and_then(|text| text.parse::<f64>().ok());
            let decimals = style
                .get("vdec")
                .and_then(|text| text.parse::<f64>().ok())
                .map(|value| value.clamp(0.0, 6.0) as u8)
                .unwrap_or(1);
            let raw_vtype = style
                .get("vtype")
                .cloned()
                .unwrap_or_else(|| "continuous".to_string());
            let mut options = Vec::new();
            for key in ["voptions", "vnames", "venums", "vvalues", "vitems", "vlist"] {
                if let Some(raw_options) = style.get(key) {
                    let parts: Vec<String> = raw_options
                        .split(['|', ','])
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(str::to_string)
                        .collect();
                    if parts.len() > 1 {
                        options = parts;
                        break;
                    }
                }
            }
            let switch_vtype = options.is_empty() && raw_vtype.trim().starts_with('[');
            if switch_vtype {
                options = vtype_array_options(&raw_vtype).unwrap_or_default();
            }
            editor.kind = "pfloat".to_string();
            editor.label = style.get("vname").cloned().unwrap_or_else(|| {
                if desc.is_empty() {
                    label_alias(&name).to_string()
                } else {
                    desc.clone()
                }
            });
            editor.min = Some(raw_min);
            editor.max = Some(raw_max);
            editor.display_min = display_min;
            editor.display_max = display_max;
            editor.display_default = display_default;
            editor.decimals = Some(decimals);
            editor.unit = style
                .get("vunit")
                .cloned()
                .or_else(|| Some(node.unit().to_string()).filter(|unit| !unit.is_empty()))
                .unwrap_or_default();
            editor.pfloat = true;
            editor.vtype = if switch_vtype && !options.is_empty() {
                "switch".to_string()
            } else {
                raw_vtype.to_ascii_lowercase()
            };
            editor.options = options;
        }
        "float" => {
            editor.kind = "float".to_string();
            editor.min = node.min();
            editor.max = node.max();
            editor.decimals = node.dec().map(|dec| dec.clamp(0, 6) as u8);
            editor.unit = node.unit().to_string();
        }
        "enum" => {
            let options = node.options();
            if options.is_empty() {
                return None;
            }
            editor.kind = "enum".to_string();
            editor.options = options;
        }
        "plist" => {
            let reference = node.reference().map(normalize_path);
            let (options, list_type) = if let Some(reference) = reference.as_deref() {
                let list_node = store.get(reference);
                let list_type = list_node.map(Node::item_type).unwrap_or("").to_string();
                let options = list_node
                    .and_then(Node::value)
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|item| !item.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (options, list_type)
            } else {
                (Vec::new(), String::new())
            };
            editor.kind = "choice".to_string();
            editor.options = options;
            editor.item_type = list_type.clone();
            editor.visible = type_aware_visibility(&name, ntype, &list_type, visible, &model_type);
        }
        _ => {
            if value.as_bool().is_some() {
                editor.kind = "bool".to_string();
            } else if value.is_number() {
                editor.kind = "number".to_string();
            } else {
                let text = value.as_str()?;
                if text.is_empty() {
                    return None;
                }
                editor.kind = "text".to_string();
            }
        }
    }
    Some(editor)
}

impl EditorNode {
    fn empty() -> Self {
        Self {
            kind: String::new(),
            path: String::new(),
            name: String::new(),
            label: String::new(),
            value: Value::Null,
            visible: true,
            desc: String::new(),
            min: None,
            max: None,
            display_min: None,
            display_max: None,
            display_default: None,
            decimals: None,
            unit: String::new(),
            options: Vec::new(),
            pfloat: false,
            vtype: String::new(),
            item_type: String::new(),
            on_off: None,
            module_value: None,
            rawdata: None,
            subdivision: None,
            lock: None,
            mode_options: Vec::new(),
            parameters: Vec::new(),
            items: Vec::new(),
        }
    }
}

/// Determine whether the nearest enclosing model block is NAM or parametric NAM.
pub fn block_model_type(path: &str, store: &NodeStore) -> String {
    let mut parent = path_parent(path);
    while !parent.is_empty() && parent != "root" {
        if let Some(type_node) = store.get(&format!("{parent}\\type")) {
            if type_node.node_type() == "enum" {
                let options: Vec<String> = type_node
                    .options()
                    .into_iter()
                    .map(|option| option.trim().to_ascii_lowercase())
                    .collect();
                let has_nam = options.iter().any(|option| option == "nam");
                let has_pnam = options.iter().any(|option| option.contains("parametric"));
                if has_nam && has_pnam {
                    let value = type_node
                        .value_str()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    if value.contains("parametric") {
                        return "pnam".to_string();
                    }
                    if value.contains("nam") {
                        return "nam".to_string();
                    }
                    return String::new();
                }
            }
        }
        parent = path_parent(parent);
    }
    String::new()
}

fn type_aware_visibility(
    name: &str,
    ntype: &str,
    list_type: &str,
    visible: bool,
    model_type: &str,
) -> bool {
    if model_type.is_empty() {
        return visible;
    }
    let parametric = model_type == "pnam";
    if ntype == "pfloat" {
        return visible && parametric;
    }
    if ntype == "plist" {
        if list_type == "pnam" {
            return parametric;
        }
        if list_type == "nam" {
            return !parametric;
        }
    }
    if LEGACY_NAM_BLOCK_PARAMS.contains(&name) {
        return !parametric;
    }
    visible
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::Node;
    use serde_json::json;

    fn insert(store: &mut NodeStore, path: &str, value: Value) {
        if let Some(object) = value.as_object() {
            store.insert(path, Node::new(object.clone()));
        }
    }

    fn delay_store() -> NodeStore {
        let mut store = NodeStore::new();
        insert(
            &mut store,
            r"root\app\delay",
            json!({"item_type":"block","desc":"Delay"}),
        );
        insert(
            &mut store,
            r"root\app\delay\on_off",
            json!({"type":"enum","value":"ON","options":["ON","OFF"]}),
        );
        insert(
            &mut store,
            r"root\app\delay\dlytime",
            json!({"type":"float","value":420.0,"min":0.0,"max":2000.0,"unit":"ms","desc":"Time"}),
        );
        insert(
            &mut store,
            r"root\app\delay\fdbk",
            json!({"type":"float","value":35.0,"min":0.0,"max":100.0,"desc":"Feedback"}),
        );
        insert(
            &mut store,
            r"root\app\delay\mix",
            json!({"type":"float","value":24.0,"min":0.0,"max":100.0,"desc":"Mix"}),
        );
        insert(
            &mut store,
            r"root\app\delay\tone",
            json!({"type":"float","value":5.0,"min":0.0,"max":10.0,"desc":"Tone"}),
        );
        insert(
            &mut store,
            r"root\app\delay\mode",
            json!({"type":"enum","value":"Digital","options":["Digital","Analog"]}),
        );
        insert(
            &mut store,
            r"root\app\delay\sync",
            json!({"item_type":"module","desc":"Sync"}),
        );
        insert(
            &mut store,
            r"root\app\delay\sync\rawdata",
            json!({"type":"float","value":500.0,"min":20.0,"max":2000.0,"unit":"ms"}),
        );
        insert(
            &mut store,
            r"root\app\delay\sync\sbdv",
            json!({"type":"enum","value":"1/4","options":["1/4","1/8"]}),
        );
        insert(
            &mut store,
            r"root\app\delay\sync\lock",
            json!({"type":"enum","value":"OFF","options":["ON","OFF"]}),
        );
        store
    }

    #[test]
    fn derives_parameters_and_time_module() {
        let store = delay_store();
        let editor = block_editor(&store, r"root\app\delay");
        assert_eq!(editor.label, "Delay");
        assert_eq!(editor.family, "delay");
        assert_eq!(editor.on, Some(true));
        assert_eq!(editor.parameters.len(), 5);
        let time = editor
            .items
            .iter()
            .find(|item| item.kind == "time")
            .unwrap();
        assert_eq!(time.on_off, None);
        assert_eq!(time.parameters.len(), 1); // lock
        assert_eq!(time.mode_options.len(), 2);
        assert_eq!(time.subdivision.as_ref().unwrap().name, "sbdv");
    }

    #[test]
    fn shell_knobs_follow_priority_not_tree_order() {
        let store = delay_store();
        let editor = block_editor(&store, r"root\app\delay");
        let names: Vec<&str> = editor
            .knob_targets()
            .iter()
            .map(|node| node.name.as_str())
            .collect();
        assert_eq!(names, vec!["dlytime", "fdbk", "mix"]);
    }

    #[test]
    fn pfloat_maps_normalized_value_to_display_range() {
        let mut store = NodeStore::new();
        insert(&mut store, r"root\app\drive", json!({"item_type":"block"}));
        insert(
            &mut store,
            r"root\app\drive\type",
            json!({"type":"enum","value":"Parametric NAM","options":["NAM","Parametric NAM"]}),
        );
        insert(
            &mut store,
            r"root\app\drive\gain",
            json!({"type":"pfloat","value":0.5,"min":0.0,"max":1.0,"style":"vname:Drive;vmin:0;vmax:10;vdec:1;visible:true"}),
        );
        insert(
            &mut store,
            r"root\app\drive\low",
            json!({"type":"float","value":5.0}),
        );
        let editor = block_editor(&store, r"root\app\drive");
        let gain = editor
            .parameters
            .iter()
            .find(|param| param.name == "gain")
            .unwrap();
        assert_eq!(gain.kind, "pfloat");
        assert_eq!(gain.label, "Drive");
        assert_eq!(gain.display_value(), Some(5.0));
        let low = editor
            .parameters
            .iter()
            .find(|param| param.name == "low")
            .unwrap();
        assert!(!low.visible);
    }

    #[test]
    fn pnam_switch_vtype_array_exposes_choices() {
        let mut store = NodeStore::new();
        insert(&mut store, r"root\app\amp", json!({"item_type":"block"}));
        insert(
            &mut store,
            r"root\app\amp\type",
            json!({"type":"enum","value":"Parametric NAM","options":["NAM","Parametric NAM"]}),
        );
        insert(
            &mut store,
            r"root\app\amp\p1",
            json!({
                "type":"pfloat",
                "value":0.5,
                "min":0.0,
                "max":1.0,
                "desc":"Parameter 1",
                "style":"vdef:0.000000;visible:true;vmax:1.000000;vmin:0.000000;vname:Gain-Boost;vtype:[\"ON\",\"OFF\"];"
            }),
        );
        let editor = block_editor(&store, r"root\app\amp");
        let gain_boost = editor
            .parameters
            .iter()
            .find(|param| param.name == "p1")
            .unwrap();
        assert_eq!(gain_boost.kind, "pfloat");
        assert_eq!(gain_boost.label, "Gain-Boost");
        assert_eq!(gain_boost.vtype, "switch");
        assert_eq!(gain_boost.options, vec!["ON", "OFF"]);
        // The device stores the selected index normalized to 0..1.
        assert_eq!(gain_boost.display_value(), Some(0.5));
    }

    #[test]
    fn parametric_model_hides_legacy_tone_controls() {
        let mut store = NodeStore::new();
        insert(&mut store, r"root\app\amp", json!({"item_type":"block"}));
        insert(
            &mut store,
            r"root\app\amp\type",
            json!({"type":"enum","value":"NAM","options":["NAM","Parametric NAM"]}),
        );
        insert(
            &mut store,
            r"root\app\amp\gain",
            json!({"type":"float","value":6.0,"min":0,"max":10}),
        );
        insert(
            &mut store,
            r"root\app\amp\treble",
            json!({"type":"float","value":6.0,"min":0,"max":10}),
        );
        insert(
            &mut store,
            r"root\app\amp\lvl",
            json!({"type":"float","value":6.0,"min":0,"max":10}),
        );
        let editor = block_editor(&store, r"root\app\amp");
        let visible: Vec<&str> = editor
            .parameters
            .iter()
            .filter(|param| param.visible)
            .map(|param| param.name.as_str())
            .collect();
        assert_eq!(visible, vec!["type", "gain", "treble", "lvl"]);
    }
}
