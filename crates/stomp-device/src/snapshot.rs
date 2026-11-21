//! UI-facing view models. These are the only values the React layer sees:
//! opaque IDs (currently device paths), typed controls, no sockets.

use serde::{Deserialize, Serialize};
use stomp_eq::{BandType, EqBand};
use stomp_protocol::router::{ChainBlock, ChainSlot};
use stomp_protocol::NodeStore;
use stomp_protocol::{
    path_name, GLOBAL_EQ_PATH, IR_PATH, NAM_DRIVE_PATH, NAM_PATH, PNAM_DRIVE_PATH, PNAM_PATH,
};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceSnapshot {
    pub revision: u64,
    pub connected: bool,
    pub device_name: String,
    pub firmware: String,
    pub device_id: String,
    pub usb_status: String,
    pub preset: PresetView,
    pub chain: ChainView,
    pub master: MasterView,
    pub meters: Meters,
    pub eq: Option<EqView>,
    pub lists: Vec<LibraryList>,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PresetView {
    pub current: String,
    pub index: Option<usize>,
    pub names: Vec<String>,
    pub list_path: Option<String>,
    pub preset_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChainView {
    pub router_present: bool,
    pub slots: Vec<ChainSlot>,
    pub blocks: Vec<ChainBlock>,
    pub available_blocks: Vec<AvailableBlock>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AvailableBlock {
    pub path: String,
    pub name: String,
    pub desc: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MasterView {
    pub volume: Option<ControlValue>,
    pub tempo: Option<ControlValue>,
    pub preset_level: Option<ControlValue>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ControlValue {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub unit: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Meters {
    pub input: [f32; 2],
    pub output: [f32; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EqView {
    pub path: String,
    pub on_path: String,
    pub enabled: bool,
    pub bands: Vec<EqBandView>,
}

/// One EQ band as the UI sees it. `index` is always 1-based; `device_index` is
/// the firmware's own number (0-based on 2.4.4, 1-based on some simulators).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EqBandView {
    pub index: usize,
    pub device_index: usize,
    pub enabled: bool,
    pub kind: BandType,
    pub frequency: f64,
    pub gain_db: f64,
    pub q: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryList {
    pub path: String,
    pub label: String,
    pub kind: String,
    pub slot_size: usize,
    pub active_slot: Option<usize>,
    pub slots: Vec<LibrarySlot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibrarySlot {
    pub index: usize,
    pub name: String,
    pub used: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub router: bool,
    pub global_eq: bool,
    pub tuner: bool,
    pub dual_nam: bool,
    pub dual_ir: bool,
    pub parametric_nam: bool,
}

pub fn device_info(store: &NodeStore) -> (String, String, String, String) {
    (
        store
            .value_str(r"root\sys\_name")
            .unwrap_or_default()
            .to_string(),
        store
            .value_str(r"root\sys\_ver")
            .unwrap_or_default()
            .to_string(),
        store
            .value_str(r"root\sys\_id")
            .unwrap_or_default()
            .to_string(),
        store
            .value_str(r"root\usb\_status")
            .unwrap_or_default()
            .to_string(),
    )
}

pub fn master_view(store: &NodeStore) -> MasterView {
    let base = find_master_base(store);
    let Some(base) = base else {
        return MasterView::default();
    };
    let volume = control(store, &format!("{base}\\vol"), "Master volume", 1.0);
    let tempo = control(store, &format!("{base}\\tempo_bpm"), "Tempo", 1.0)
        .or_else(|| control(store, &format!("{base}\\pst\\tmp"), "Tempo", 1.0));
    let preset_level = control(store, &format!("{base}\\pst\\lvl"), "Preset level", 0.1)
        .or_else(|| control(store, &format!("{base}\\pst\\vol"), "Preset level", 0.1));
    MasterView {
        volume,
        tempo,
        preset_level,
    }
}

fn find_master_base(store: &NodeStore) -> Option<String> {
    if store.contains(r"root\app\output\vol") {
        return Some(r"root\app\output".to_string());
    }
    if store.contains(r"root\app\master\vol") {
        return Some(r"root\app\master".to_string());
    }
    store
        .iter()
        .find(|(path, _)| {
            matches!(path_name(path), "master" | "output")
                && store.contains(&format!("{path}\\vol"))
        })
        .map(|(path, _)| path.clone())
}

fn control(store: &NodeStore, path: &str, label: &str, step: f64) -> Option<ControlValue> {
    let node = store.get(path)?;
    let value = node.value_f64()?;
    Some(ControlValue {
        id: path.to_string(),
        label: label.to_string(),
        value,
        min: node.min().unwrap_or(0.0),
        max: node.max().unwrap_or(100.0),
        step,
        unit: node.unit().to_string(),
    })
}

pub fn meters(store: &NodeStore) -> Meters {
    let read = |name: &str| {
        store
            .value_f64(&format!(r"root\sys\_meters\_{name}"))
            .unwrap_or(0.0) as f32
    };
    Meters {
        input: [read("in0"), read("in1")],
        output: [read("out0"), read("out1")],
    }
}

pub fn eq_view(store: &NodeStore) -> Option<EqView> {
    let mut path = if store.contains(GLOBAL_EQ_PATH) {
        GLOBAL_EQ_PATH.to_string()
    } else {
        store
            .iter()
            .find(|(candidate, node)| {
                path_name(candidate) == "global_eq" && node.node_type() == "item"
            })
            .map(|(path, _)| path.clone())?
    };
    if store.get(&path).is_none() {
        path = GLOBAL_EQ_PATH.to_string();
    }
    let on_path = format!("{path}\\on_off");
    let enabled = store
        .value_str(&on_path)
        .map(|value| value.eq_ignore_ascii_case("ON"))
        .unwrap_or(false);

    let editor = stomp_protocol::editor::block_editor(store, &path);
    let mut bands: std::collections::BTreeMap<usize, EqBand> = std::collections::BTreeMap::new();
    for control in editor.flatten_controls() {
        let (prefix, index) = match control.name.rsplit_once('_') {
            Some((prefix, index)) => (prefix, index),
            None => continue,
        };
        let Ok(index) = index.parse::<usize>() else {
            continue;
        };
        let band = bands
            .entry(index)
            .or_insert_with(|| EqBand::new(index, stomp_eq::BandType::Bell, 1000.0, 0.0, 0.707));
        match prefix {
            "band" => band.gain_db = control.numeric_value().unwrap_or(0.0),
            "freq" => band.frequency = control.numeric_value().unwrap_or(1000.0),
            "q" => band.q = control.numeric_value().unwrap_or(0.707),
            "type" => {
                band.kind = stomp_eq::BandType::parse(control.value.as_str().unwrap_or("BELL"))
            }
            _ => {}
        }
    }
    if bands.is_empty() {
        return None;
    }
    let one_based = bands.keys().next().is_some_and(|index| *index >= 1);
    let bands = bands
        .into_iter()
        .map(|(device_index, band)| EqBandView {
            index: if one_based {
                device_index
            } else {
                device_index + 1
            },
            device_index,
            enabled: band.enabled,
            kind: band.kind,
            frequency: band.frequency,
            gain_db: band.gain_db,
            q: band.q,
        })
        .collect();
    Some(EqView {
        path,
        on_path,
        enabled,
        bands,
    })
}

pub fn library_lists(store: &NodeStore) -> Vec<LibraryList> {
    let mut paths: Vec<String> = Vec::new();
    for path in [
        NAM_PATH,
        PNAM_PATH,
        NAM_DRIVE_PATH,
        PNAM_DRIVE_PATH,
        IR_PATH,
    ] {
        if store.contains(path) {
            paths.push(path.to_string());
        }
    }
    for (path, node) in store.iter() {
        if node.node_type() == "list"
            && matches!(
                node.item_type().to_ascii_lowercase().as_str(),
                "nam" | "pnam" | "ir" | "wav"
            )
            && !paths.contains(path)
        {
            paths.push(path.clone());
        }
    }

    let mut out = Vec::new();
    for path in paths {
        let Some(node) = store.get(&path) else {
            continue;
        };
        let kind = if path == NAM_PATH || path == NAM_DRIVE_PATH {
            "nam"
        } else if path == PNAM_PATH || path == PNAM_DRIVE_PATH {
            "pnam"
        } else if path == IR_PATH {
            "ir"
        } else {
            match node.item_type().to_ascii_lowercase().as_str() {
                "pnam" => "pnam",
                "ir" => "ir",
                _ => "nam",
            }
        }
        .to_string();
        let names: Vec<String> = node
            .value()
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let active_slot = find_active_slot(store, &path);
        let slots = names
            .into_iter()
            .enumerate()
            .map(|(index, name)| LibrarySlot {
                index,
                used: !name.is_empty(),
                active: active_slot == Some(index),
                name,
            })
            .collect();
        let slot_size =
            node.size()
                .map(|size| size as usize)
                .unwrap_or_else(|| match kind.as_str() {
                    "pnam" => stomp_protocol::PNAM_SLOT_SIZE,
                    "ir" => stomp_protocol::IR_LENGTH * 4,
                    _ => stomp_protocol::NAM_SLOT_SIZE,
                });
        out.push(LibraryList {
            label: list_label(&path, node.desc()),
            path,
            kind,
            slot_size,
            active_slot,
            slots,
        });
    }
    out
}

fn find_active_slot(store: &NodeStore, list_path: &str) -> Option<usize> {
    for (_, node) in store.iter() {
        if node.node_type() != "plist" || node.reference() != Some(list_path) {
            continue;
        }
        let Some(name) = node.value_str() else {
            continue;
        };
        if let Some(names) = store
            .get(list_path)
            .and_then(|list| list.value())
            .and_then(|value| value.as_array())
        {
            if let Some(index) = names.iter().position(|item| item.as_str() == Some(name)) {
                return Some(index);
            }
        }
    }
    None
}

fn list_label(path: &str, desc: &str) -> String {
    if !desc.trim().is_empty() {
        return desc.to_string();
    }
    match path {
        NAM_PATH => "Amp models".to_string(),
        NAM_DRIVE_PATH => "Drive models".to_string(),
        PNAM_PATH => "Parametric amp models".to_string(),
        PNAM_DRIVE_PATH => "Parametric drive models".to_string(),
        IR_PATH => "Cabinet IRs".to_string(),
        _ => path_name(path).replace('_', " ").to_title_case(),
    }
}

trait TitleCase {
    fn to_title_case(&self) -> String;
}

impl TitleCase for String {
    fn to_title_case(&self) -> String {
        self.split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn capabilities(store: &NodeStore, chain: &ChainView) -> Capabilities {
    let dual_nam = chain
        .blocks
        .iter()
        .any(|block| block.family == "amp" && store.contains(&format!("{}\\nam2", block.path)));
    let dual_ir = chain
        .blocks
        .iter()
        .any(|block| block.family == "cab" && store.contains(&format!("{}\\ir2", block.path)));
    let parametric_nam = store
        .iter()
        .any(|(_, node)| node.item_type().eq_ignore_ascii_case("pnam"));
    Capabilities {
        router: chain.router_present,
        global_eq: store.contains(GLOBAL_EQ_PATH),
        tuner: store.contains(r"root\settings\tuner"),
        dual_nam,
        dual_ir,
        parametric_nam,
    }
}
