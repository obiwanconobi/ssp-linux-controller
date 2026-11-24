//! Deterministic StompStation simulator over TCP.
//!
//! The UI and the replay tests can develop without a pedal. It speaks the same
//! framing as the device: `<command>\r\n\0`, `path:json` reply lines, NUL
//! terminated, ACK-driven `dwrite`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use stomp_protocol::node::{Node, NodeStore};
use stomp_protocol::{
    normalize_path, IR_PATH, NAM_DRIVE_PATH, NAM_PATH, PNAM_DRIVE_PATH, PNAM_PATH, VXAMP_PATH,
};

#[derive(Debug, Default)]
struct SimState {
    nodes: NodeStore,
    /// Stored list payloads, keyed by (list path, slot).
    payloads: HashMap<(String, usize), Vec<u8>>,
    /// Partially received uploads.
    upload_buffers: HashMap<(String, usize), Vec<u8>>,
}

impl SimState {
    fn new() -> Self {
        let mut state = Self {
            nodes: demo_store(),
            payloads: HashMap::new(),
            upload_buffers: HashMap::new(),
        };
        seed_payloads(&mut state);
        state
    }
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn model_payload(name: &str) -> Vec<u8> {
    let raw = serde_json::to_vec(&json!({
        "version": "0.5.4",
        "architecture": "WaveNet",
        "config": {"layers": [], "head": null, "head_scale": 0.02},
        "weights": [0.0, 0.1],
        "sample_rate": 48000,
        "metadata": {"name": name, "gear_type": "amp"}
    }))
    .unwrap();
    let mut padded = raw;
    padded.resize(stomp_protocol::NAM_SLOT_SIZE, 0);
    gzip(&padded)
}

fn ir_payload() -> Vec<u8> {
    // The device stores 2048 little-endian f32 samples with no WAV header.
    (0..stomp_protocol::IR_LENGTH)
        .flat_map(|index| {
            let sample = ((index as f32) / 4096.0).sin() * 0.1;
            sample.to_le_bytes()
        })
        .collect()
}

fn pst_payload(name: &str) -> Vec<u8> {
    let mut text = String::new();
    text.push_str(r#"root\app\router:{"value":[["","s","","s","","s","","s","","s","root\\app\\drive","s","root\\app\\amp","s","root\\app\\ir","s","","s","","s","","s","","s","","s","","s",""]]}"#);
    text.push_str("\r\n");
    text.push_str(
        "root\\app\\drive\\model:{\"value\":\"Klone 3\"}\r\n\
         root\\app\\amp\\model:{\"value\":\"Match Brave Hi D 3\"}\r\n\
         root\\app\\ir\\ir:{\"value\":\"TJ3 58BND310\"}\r\n\
         root\\app\\drive\\on_off:{\"value\":\"ON\"}\r\n\
         root\\app\\output\\pst\\level:{\"value\":0.000000}\r\n\
         root\\app\\output\\pst\\tmp:{\"value\":120.000000}\r\n",
    );
    let _ = name;
    let mut bytes = text.into_bytes();
    bytes.resize(32768, 0);
    bytes
}

fn seed_payloads(state: &mut SimState) {
    for (path, kind) in [
        (NAM_PATH, "nam"),
        (NAM_DRIVE_PATH, "nam"),
        (PNAM_PATH, "pnam"),
        (PNAM_DRIVE_PATH, "pnam"),
        (IR_PATH, "ir"),
        (VXAMP_PATH, "vxamp"),
    ] {
        let names: Vec<String> = state
            .nodes
            .get(path)
            .and_then(|node| node.value())
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        for (index, name) in names.iter().enumerate() {
            if name.is_empty() {
                continue;
            }
            let payload = match kind {
                "ir" => {
                    let mut payload = ir_payload();
                    payload.resize(
                        state
                            .nodes
                            .get(path)
                            .and_then(|node| node.size())
                            .unwrap_or(8192) as usize,
                        0,
                    );
                    payload
                }
                _ => model_payload(name),
            };
            state.payloads.insert((path.to_string(), index), payload);
        }
    }

    let names: Vec<String> = state
        .nodes
        .get(r"root\presets")
        .and_then(|node| node.value())
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default();
    for (index, name) in names.iter().enumerate() {
        if !name.is_empty() {
            state
                .payloads
                .insert((r"root\presets".to_string(), index), pst_payload(name));
        }
    }
}

pub fn demo_store() -> NodeStore {
    let mut store = NodeStore::new();
    let mut add = |path: &str, fields: Value| {
        if let Some(object) = fields.as_object() {
            store.insert(path, Node::new(object.clone()));
        }
    };

    add("root", json!({"type":"root","value":""}));
    add(
        r"root\app",
        json!({"type":"item","item_type":"module","value":""}),
    );
    add(
        r"root\app\router",
        json!({
            "type":"router",
            "value":[["root\\app\\gate","s","root\\app\\pitch","s","root\\app\\comp","s",
                      "root\\app\\drive","s","root\\app\\amp","s","root\\app\\ir","s",
                      "root\\app\\mod","s","root\\app\\delay","s","root\\app\\reverb","s",""]],
            "fixed":[[false,false,false,false,false,false,false,false,true,false,false,false,true,false,true,false,false]]
        }),
    );

    type Control = (&'static str, &'static str, f64, f64, f64, &'static str);
    let blocks: Vec<(&str, &str, &str, &[Control])> = vec![
        (
            "gate",
            "Noise Gate",
            "utility",
            &[
                ("thresh", "Threshold", -80.0, 0.0, -45.0, "dB"),
                ("decay", "Decay", 0.0, 100.0, 20.0, "%"),
                ("attack", "Attack", 0.0, 100.0, 5.0, "ms"),
            ],
        ),
        (
            "pitch",
            "Pitch",
            "utility",
            &[
                ("pitch", "Pitch", -24.0, 24.0, 0.0, "st"),
                ("mix", "Mix", 0.0, 100.0, 100.0, "%"),
            ],
        ),
        (
            "comp",
            "Compressor",
            "comp",
            &[
                ("thresh", "Threshold", -60.0, 0.0, -18.0, "dB"),
                ("ratio", "Ratio", 1.0, 20.0, 4.0, ":1"),
                ("attack", "Attack", 0.1, 100.0, 10.0, "ms"),
                ("release", "Release", 10.0, 1000.0, 120.0, "ms"),
                ("lvl", "Level", 0.0, 10.0, 6.0, ""),
            ],
        ),
        (
            "drive",
            "Drive / Distortion",
            "drive",
            &[
                ("gain", "Gain", 0.0, 10.0, 6.4, ""),
                ("treble", "Tone", 0.0, 10.0, 5.2, ""),
                ("lvl", "Level", 0.0, 10.0, 7.0, ""),
                ("mix", "Mix", 0.0, 100.0, 100.0, "%"),
            ],
        ),
        (
            "amp",
            "Amp (NAM)",
            "amp",
            &[
                ("gain", "Gain", 0.0, 10.0, 6.2, ""),
                ("low", "Bass", 0.0, 10.0, 5.0, ""),
                ("mid", "Mid", 0.0, 10.0, 4.8, ""),
                ("treble", "Treble", 0.0, 10.0, 6.0, ""),
                ("lvl", "Level", 0.0, 10.0, 7.0, ""),
                ("pan1", "Pan 1", -100.0, 100.0, -30.0, ""),
            ],
        ),
        (
            "ir",
            "IR / Cabinet",
            "cab",
            &[
                ("lvl", "Level", -20.0, 20.0, -3.5, "dB"),
                ("blend", "Blend", 0.0, 100.0, 38.0, "%"),
                ("locut", "Low cut", 20.0, 300.0, 80.0, "Hz"),
                ("hicut", "High cut", 2000.0, 20000.0, 9000.0, "Hz"),
                ("pan", "Pan", -100.0, 100.0, 0.0, ""),
            ],
        ),
        (
            "mod",
            "Chorus",
            "mod",
            &[
                ("rate", "Rate", 0.0, 10.0, 2.4, "Hz"),
                ("depth", "Depth", 0.0, 100.0, 35.0, "%"),
                ("mix", "Mix", 0.0, 100.0, 28.0, "%"),
            ],
        ),
        (
            "delay",
            "Delay",
            "delay",
            &[
                ("dlytime", "Time", 20.0, 2000.0, 420.0, "ms"),
                ("fdbk", "Feedback", 0.0, 100.0, 35.0, "%"),
                ("mix", "Mix", 0.0, 100.0, 24.0, "%"),
                ("lvl", "Level", 0.0, 10.0, 6.0, ""),
            ],
        ),
        (
            "reverb",
            "Reverb",
            "reverb",
            &[
                ("mix", "Mix", 0.0, 100.0, 22.0, "%"),
                ("decay", "Decay", 0.0, 100.0, 40.0, "%"),
                ("predelay", "Pre-delay", 0.0, 200.0, 20.0, "ms"),
            ],
        ),
    ];
    for (name, desc, _family, controls) in blocks {
        let path = format!(r"root\app\{name}");
        add(
            &path,
            json!({"type":"item","item_type":"block","desc":desc}),
        );
        add(
            &format!("{path}\\on_off"),
            json!({"type":"enum","value": match name { "gate" | "pitch" | "delay" | "reverb" => "OFF", _ => "ON" }, "options":["ON","OFF"]}),
        );
        for (control_name, label, min, max, value, unit) in controls {
            add(
                &format!("{path}\\{control_name}"),
                json!({"type":"float","value":value,"min":min,"max":max,"desc":label,"unit":unit}),
            );
        }
    }

    // Model selectors.
    add(
        r"root\app\drive\model",
        json!({"type":"plist","value":"Klone 3","ref":"root\\nam_drive","desc":"Model"}),
    );
    add(
        r"root\app\amp\model",
        json!({"type":"plist","value":"Match Brave Hi D 3","ref":"root\\nam_amp","desc":"Model"}),
    );
    add(
        r"root\app\ir\ir",
        json!({"type":"plist","value":"TJ3 58BND310","ref":"root\\ir_list","desc":"IR"}),
    );
    add(
        r"root\app\amp\type",
        json!({"type":"enum","value":"NAM","options":["NAM","Parametric NAM"]}),
    );
    add(
        r"root\app\drive\type",
        json!({"type":"enum","value":"NAM","options":["NAM","Parametric NAM"]}),
    );

    // Dual NAM / dual IR groups.
    add(
        r"root\app\amp\nam2",
        json!({"type":"item","item_type":"vfolder","desc":"Dual Amp"}),
    );
    add(
        r"root\app\amp\nam2\on_off",
        json!({"type":"enum","value":"ON","options":["ON","OFF"]}),
    );
    add(
        r"root\app\amp\nam2\model",
        json!({"type":"plist","value":"64 Vibroverb D 2","ref":"root\\nam_amp","desc":"Model (2)"}),
    );
    add(
        r"root\app\amp\nam2\gain",
        json!({"type":"float","value":4.0,"min":0.0,"max":10.0,"desc":"Gain"}),
    );
    add(
        r"root\app\amp\nam2\low",
        json!({"type":"float","value":5.0,"min":0.0,"max":10.0,"desc":"Bass"}),
    );
    add(
        r"root\app\amp\nam2\treble",
        json!({"type":"float","value":5.5,"min":0.0,"max":10.0,"desc":"Treble"}),
    );
    add(
        r"root\app\amp\nam2\pan3",
        json!({"type":"float","value":30.0,"min":-100.0,"max":100.0,"desc":"Pan Model 2"}),
    );
    add(
        r"root\app\ir\ir2",
        json!({"type":"item","item_type":"vfolder","desc":"Stereo IR"}),
    );
    add(
        r"root\app\ir\ir2\on_off",
        json!({"type":"enum","value":"OFF","options":["ON","OFF"]}),
    );
    add(
        r"root\app\ir\ir2\ir",
        json!({"type":"plist","value":"TJ3 57","ref":"root\\ir_list","desc":"IR (2)"}),
    );
    add(
        r"root\app\ir\ir2\pan1",
        json!({"type":"float","value":-20.0,"min":-100.0,"max":100.0,"desc":"Pan IR 1"}),
    );

    // Legacy VXAMP block / raw amp model list.
    add(
        r"root\app\vxamp",
        json!({"type":"item","item_type":"block","desc":"VxAmp"}),
    );
    add(
        r"root\app\vxamp\on_off",
        json!({"type":"enum","value":"OFF","options":["ON","OFF"]}),
    );
    add(
        r"root\app\vxamp\model",
        json!({"type":"plist","value":"","ref":"root\\vxamp_list","desc":"Model"}),
    );

    // Available pool.
    add(
        r"root\app\chorus",
        json!({"type":"item","item_type":"block","desc":"Chorus"}),
    );
    add(
        r"root\app\chorus\on_off",
        json!({"type":"enum","value":"OFF","options":["ON","OFF"]}),
    );
    add(
        r"root\app\flanger",
        json!({"type":"item","item_type":"block","desc":"Flanger"}),
    );
    add(
        r"root\app\flanger\on_off",
        json!({"type":"enum","value":"OFF","options":["ON","OFF"]}),
    );

    // In-chain Parametric EQ (available pool; not in the default chain).
    add(
        r"root\app\parametric_eq",
        json!({"type":"item","item_type":"block","desc":"Parametric EQ"}),
    );
    add(
        r"root\app\parametric_eq\on_off",
        json!({"type":"enum","value":"ON","options":["ON","OFF"]}),
    );
    add(
        r"root\app\parametric_eq\eq_par",
        json!({"type":"item","item_type":"module","value":"eq_par","desc":"Parametric EQ"}),
    );
    for (index, band_type, freq, gain, q) in [
        (0, "LPS", 90.0, 4.0, 0.70),
        (1, "BP", 640.0, 2.5, 1.20),
        (2, "BP", 3200.0, -2.0, 2.40),
        (3, "HPS", 9000.0, 3.0, 0.70),
    ] {
        add(
            &format!(r"root\app\parametric_eq\eq_par\band_{index}"),
            json!({"type":"float","value":gain,"min":-15.0,"max":15.0,"desc":format!("Band {} gain", index + 1),"unit":"dB"}),
        );
        add(
            &format!(r"root\app\parametric_eq\eq_par\freq_{index}"),
            json!({"type":"float","value":freq,"min":50.0,"max":20000.0,"desc":format!("Band {} frequency", index + 1),"unit":"Hz"}),
        );
        add(
            &format!(r"root\app\parametric_eq\eq_par\q_{index}"),
            json!({"type":"float","value":q,"min":0.1,"max":10.0,"desc":format!("Band {} Q", index + 1)}),
        );
        add(
            &format!(r"root\app\parametric_eq\eq_par\type_{index}"),
            json!({"type":"enum","value":band_type,"options":["LPS","LP","BP","HP","HPS"],"desc":format!("Band {} type", index + 1)}),
        );
        add(
            &format!(r"root\app\parametric_eq\eq_par\slope_{index}"),
            json!({"type":"enum","value":"12dB/oct","style":"visible:false;","options":["6dB/oct","12dB/oct"],"desc":format!("Band {} slope", index + 1)}),
        );
    }

    // Preset rail.
    let names = preset_names();
    add(
        r"root\app\preset",
        json!({"type":"plist","value":"Match Brave Chorus","ref":"root\\presets"}),
    );
    let mut used_amp = vec![String::new(); names.len()];
    let mut used_drive = vec![String::new(); names.len()];
    let mut used_ir = vec![String::new(); names.len()];
    if let Some(slot) = used_amp.get_mut(3) {
        *slot = "Match Brave Hi D 3".to_string();
    }
    if let Some(slot) = used_drive.get_mut(3) {
        *slot = "Klone 3".to_string();
    }
    if let Some(slot) = used_ir.get_mut(3) {
        *slot = "TJ3 58BND310".to_string();
    }
    add(
        r"root\presets",
        json!({
            "type":"list",
            "item_type":"pst_pst",
            "value":names,
            "used": {
                r"root\app\amp\model": used_amp,
                r"root\app\drive\model": used_drive,
                r"root\app\ir\ir": used_ir
            },
            "size": 32768,
            "chunk": 1024
        }),
    );

    // Master and preset level.
    add(
        r"root\app\output",
        json!({"type":"item","item_type":"system"}),
    );
    add(
        r"root\app\output\vol",
        json!({"type":"float","value":72.0,"min":0.0,"max":100.0,"desc":"Master volume"}),
    );
    add(
        r"root\app\output\tempo_bpm",
        json!({"type":"float","value":120.0,"min":20.0,"max":300.0,"desc":"Tempo"}),
    );
    add(r"root\app\output\pst", json!({"type":"item"}));
    add(
        r"root\app\output\pst\level",
        json!({"type":"float","value":0.0,"min":-20.0,"max":20.0,"desc":"Preset level","unit":"dB"}),
    );

    // Global EQ.
    add(
        r"root\app\output\global_eq",
        json!({"type":"item","item_type":"block","desc":"Global EQ"}),
    );
    add(
        r"root\app\output\global_eq\on_off",
        json!({"type":"enum","value":"ON","options":["ON","OFF"]}),
    );
    for (index, band_type, freq, gain, q) in [
        (1, "LPS", 90.0, 4.0, 0.70),
        (2, "BP", 640.0, 2.5, 1.20),
        (3, "BP", 3200.0, -2.0, 2.40),
        (4, "HPS", 9000.0, 3.0, 0.70),
    ] {
        add(
            &format!(r"root\app\output\global_eq\band_{index}"),
            json!({"type":"float","value":gain,"min":-15.0,"max":15.0}),
        );
        add(
            &format!(r"root\app\output\global_eq\freq_{index}"),
            json!({"type":"float","value":freq,"min":20.0,"max":20000.0}),
        );
        add(
            &format!(r"root\app\output\global_eq\q_{index}"),
            json!({"type":"float","value":q,"min":0.1,"max":10.0}),
        );
        add(
            &format!(r"root\app\output\global_eq\type_{index}"),
            json!({"type":"enum","value":band_type,"options":["LPS","BP","HPS"]}),
        );
    }

    // Device identity and live meters.
    add(
        r"root\sys\_name",
        json!({"type":"item","value":"StompStation PRO"}),
    );
    add(r"root\sys\_ver", json!({"type":"item","value":"2.4.4"}));
    add(
        r"root\sys\_id",
        json!({"type":"item","value":"STOMPPRO-10000000be183ca1"}),
    );
    add(r"root\sys\_arch", json!({"type":"item","value":"aarch64"}));
    add(
        r"root\sys\alias",
        json!({"type":"text","value":"Studio board"}),
    );
    add(r"root\usb\_status", json!({"type":"item","value":"ON"}));
    add(r"root\sys\_meters", json!({"type":"item"}));
    for (key, value) in [
        ("in0", -12.0),
        ("in1", -11.5),
        ("out0", -9.0),
        ("out1", -8.6),
    ] {
        add(
            &format!(r"root\sys\_meters\_{key}"),
            json!({"type":"float","value":value,"min":-90.0,"max":12.0}),
        );
    }

    // Upload lists.
    add(
        NAM_PATH,
        json!({"type":"list","item_type":"nam","value":["Match Brave Hi D 3","64 Vibroverb D 2","","","","","",""],"size":1048576}),
    );
    add(
        NAM_DRIVE_PATH,
        json!({"type":"list","item_type":"nam","value":["Klone 3","Tone-King OD","","",""],"size":1048576}),
    );
    add(
        PNAM_PATH,
        json!({"type":"list","item_type":"pnam","value":["Dumble Pack A","","",""],"size":2097152}),
    );
    add(
        PNAM_DRIVE_PATH,
        json!({"type":"list","item_type":"pnam","value":["ZenDrive","","",""],"size":2097152}),
    );
    add(
        IR_PATH,
        json!({"type":"list","item_type":"ir","value":["TJ3 58BND310","TJ3 57","G12M Greenback","",""],"size":8192}),
    );
    add(
        VXAMP_PATH,
        json!({"type":"list","item_type":"vxamp","value":["","","","","","","","","","","","","","","",""],"size":12288}),
    );

    // Settings.
    add(
        r"root\settings",
        json!({"type":"item","item_type":"system"}),
    );
    add(r"root\settings\input", json!({"type":"item"}));
    add(
        r"root\settings\input\gain1",
        json!({"type":"float","value":0.0,"min":-15.0,"max":15.0,"desc":"In 1 digital gain","unit":"dB"}),
    );
    add(
        r"root\settings\input\gain2",
        json!({"type":"float","value":0.0,"min":-15.0,"max":15.0,"desc":"In 2 digital gain","unit":"dB"}),
    );
    add(
        r"root\settings\input\_connected1",
        json!({"type":"enum","value":"YES","options":["NO","YES"],"desc":"In 1 connection"}),
    );
    add(
        r"root\settings\input\_connected2",
        json!({"type":"enum","value":"NO","options":["NO","YES"],"desc":"In 2 connection"}),
    );
    add(
        r"root\settings\input\level",
        json!({"type":"float","value":50.0,"min":0.0,"max":100.0,"desc":"Input level"}),
    );
    add(r"root\settings\ctrl", json!({"type":"item"}));
    add(
        r"root\settings\ctrl\exp_min",
        json!({"type":"float","value":0.0,"min":0.0,"max":100.0,"desc":"Expression min"}),
    );
    add(
        r"root\settings\ctrl\exp_max",
        json!({"type":"float","value":100.0,"min":0.0,"max":100.0,"desc":"Expression max"}),
    );
    add(r"root\settings\misc", json!({"type":"item"}));
    add(
        r"root\settings\misc\action\factory",
        json!({"type":"action","desc":"Factory reset"}),
    );
    add(
        r"root\settings\tuner",
        json!({"type":"item","value":"","desc":"Tuner","item_type":"hfolder"}),
    );
    add(
        r"root\settings\tuner\on_off",
        json!({"type":"enum","value":"OFF","def":"OFF","desc":"Enable","options":["ON","OFF"]}),
    );
    add(
        r"root\settings\tuner\tuner",
        json!({"type":"item","value":"tuner","def":"tuner","desc":"Tuner","item_type":"module"}),
    );
    add(
        r"root\settings\tuner\tuner\ref",
        json!({"type":"enum","value":"440","def":"440","desc":"Ref","options":["432","434","436","438","440","442","444","446","448"]}),
    );
    add(
        r"root\settings\tuner\tuner\_freq",
        json!({"type":"float","value":110.0,"def":0.0,"min":0.0,"max":2000.0,"desc":"Freq"}),
    );
    add(
        r"root\settings\tuner\tuner\lvl",
        json!({"type":"float","value":-18.0,"def":0.0,"min":-60.0,"max":0.0,"desc":"Level","unit":"dB"}),
    );

    store
}

pub fn preset_names() -> Vec<String> {
    let mut names: Vec<String> = [
        "Dumble Clean",
        "Dumble Ford",
        "Dumble Carlton",
        "Match Brave Chorus",
        "Match Brave Cab",
        "Match Brave No Cab",
        "Tone-King",
        "Tone-King - Drive",
        "Tone-King - Drive Delay",
        "Purple Plexi",
        "SineWave",
        "Space Prince",
        "5150",
        "Bass Ampeg",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();
    for index in names.len()..42 {
        names.push(format!("Patch {:02}", index + 1));
    }
    // Leave the last ten slots empty so slot selection and import can be
    // exercised without overwriting a saved preset.
    names.resize(52, String::new());
    names
}

pub fn serve(port: u16, once: bool) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("stomp-sim listening on tcp://127.0.0.1:{port}");
    let state = Arc::new(Mutex::new(SimState::new()));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    if let Err(error) = handle_client(stream, state) {
                        eprintln!("client error: {error}");
                    }
                });
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
        if once {
            break;
        }
    }
    Ok(())
}

fn handle_client(mut stream: TcpStream, state: Arc<Mutex<SimState>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_millis(100)))?;
    stream.set_nodelay(true)?;
    let mut pending = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => pending.extend_from_slice(&buffer[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(error) => return Err(error),
        }

        while let Some(index) = pending.iter().position(|byte| *byte == 0) {
            let raw: Vec<u8> = pending.drain(..=index).collect();
            let command = String::from_utf8_lossy(&raw[..raw.len().saturating_sub(1)])
                .trim()
                .to_string();
            if command.is_empty() {
                continue;
            }
            let reply = {
                let mut state = state.lock().unwrap();
                respond(&command, &mut state)
            };
            stream.write_all(&reply)?;
            stream.flush()?;
        }
    }
}

fn respond(command: &str, state: &mut SimState) -> Vec<u8> {
    if command == "browse root" {
        let lines: Vec<String> = state
            .nodes
            .iter()
            .map(|(path, node)| format!("{path}:{}", Value::Object(node.raw().clone())))
            .collect();
        return frame(&lines);
    }
    if let Some(path) = command.strip_prefix("read ") {
        let path = normalize_path(path);
        if path == "root" {
            // Live root deltas: meters and preset value.
            let mut lines = Vec::new();
            for key in ["in0", "in1", "out0", "out1"] {
                let meter_path = format!(r"root\sys\_meters\_{key}");
                if let Some(node) = state.nodes.get(&meter_path) {
                    lines.push(format!(
                        "{meter_path}:{}",
                        Value::Object(node.raw().clone())
                    ));
                }
            }
            return frame(&lines);
        }
        return match state.nodes.get(&path) {
            Some(node) => frame(&[format!("{path}:{}", Value::Object(node.raw().clone()))]),
            None => b"\0".to_vec(),
        };
    }
    if let Some(body) = command.strip_prefix("dread ") {
        let Some((path, payload)) = body.split_once(':') else {
            return b"\0".to_vec();
        };
        let path = normalize_path(path);
        let Ok(object) = serde_json::from_str::<Value>(payload) else {
            return b"\0".to_vec();
        };
        let index = object.get("index").and_then(Value::as_i64).unwrap_or(-1);
        let chunk = object.get("chunk").and_then(Value::as_i64).unwrap_or(0);
        if index < 0 || chunk <= 0 {
            return b"\0".to_vec();
        }
        let Some(payload) = state.payloads.get(&(path.clone(), index as usize)) else {
            return b"\0".to_vec();
        };
        let size = payload.len();
        let chunk_size = state
            .nodes
            .get(&path)
            .and_then(|node| node.chunk())
            .unwrap_or(1024) as usize;
        let start = (chunk as usize - 1) * chunk_size;
        if start >= size {
            return b"\0".to_vec();
        }
        let end = (start + chunk_size).min(size);
        let value = stomp_protocol::hex_encode(&payload[start..end]);
        return frame(&[format!(
            "dread {path}:{}",
            json!({"index": index, "chunk": chunk, "size": size, "value": value})
        )]);
    }
    if let Some(body) = command.strip_prefix("write ") {
        let Some((path, payload)) = body.split_once(':') else {
            return b"\0".to_vec();
        };
        let path = normalize_path(path);
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(payload) else {
            return b"\0".to_vec();
        };
        if let Some(value) = object.get("value") {
            state.nodes.set_value(&path, value.clone());
        }
        return frame(&[format!("{path}:{}", Value::Object(object))]);
    }
    if let Some(body) = command.strip_prefix("dwrite ") {
        let Some((path, payload)) = body.split_once(':') else {
            return b"\0".to_vec();
        };
        let path = normalize_path(path);
        let Ok(object) = serde_json::from_str::<Value>(payload) else {
            return b"\0".to_vec();
        };
        let index = object.get("index").and_then(Value::as_i64).unwrap_or(-1);
        let chunk = object.get("chunk").and_then(Value::as_i64).unwrap_or(0);
        let value = object
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let reply_chunk = if chunk == -1 {
            // Rename: decode the padded 128-byte name and update the list.
            let decoded = decode_hex_name(&value);
            let mut old_name: Option<String> = None;
            if let Some(list) = state.nodes.get_mut(&path) {
                if let Some(items) = list.value().and_then(Value::as_array).cloned() {
                    let mut items = items;
                    if index >= 0 && (index as usize) < items.len() {
                        old_name = Some(
                            items[index as usize]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                        );
                        items[index as usize] = Value::String(decoded.clone());
                        list.0.insert("value".to_string(), Value::Array(items));
                    }
                }
            }
            if let Some(old_name) = old_name {
                if state.nodes.value_str(r"root\app\preset") == Some(old_name.as_str()) {
                    state
                        .nodes
                        .set_value(r"root\app\preset", Value::String(decoded));
                }
            }
            -1
        } else if index >= 0 {
            let key = (path.clone(), index as usize);
            if chunk == 0 {
                // Name chunk for a chunked upload.
                let decoded = decode_hex_name(&value);
                if let Some(list) = state.nodes.get_mut(&path) {
                    if let Some(items) = list.value().and_then(Value::as_array).cloned() {
                        let mut items = items;
                        if (index as usize) < items.len() {
                            items[index as usize] = Value::String(decoded);
                            list.0.insert("value".to_string(), Value::Array(items));
                        }
                    }
                }
                state.upload_buffers.insert(key, Vec::new());
                1
            } else {
                let mut data = value.as_str();
                let mut final_chunk = false;
                if let Some(position) = data.find("gz") {
                    data = &data[..position];
                    final_chunk = true;
                }
                let list_final = state
                    .nodes
                    .get(&path)
                    .and_then(|node| {
                        let size = node.size()?;
                        let chunk_size = node.chunk().unwrap_or(1024);
                        Some(chunk as u64 * chunk_size >= size)
                    })
                    .unwrap_or(false);
                if list_final
                    && path != NAM_PATH
                    && path != NAM_DRIVE_PATH
                    && path != PNAM_PATH
                    && path != PNAM_DRIVE_PATH
                {
                    final_chunk = true;
                }
                let bytes = decode_hex_bytes(data);
                let buffer = state.upload_buffers.entry(key.clone()).or_default();
                buffer.extend_from_slice(&bytes);
                if final_chunk {
                    let payload = state.upload_buffers.remove(&key).unwrap_or_default();
                    state.payloads.insert(key, payload);
                    -1
                } else {
                    chunk + 1
                }
            }
        } else {
            chunk + 1
        };
        return frame(&[format!(
            "dwrite {path}:{}",
            json!({"index": index, "chunk": reply_chunk})
        )]);
    }
    b"\0".to_vec()
}

fn frame(lines: &[String]) -> Vec<u8> {
    let mut out = lines.join("\r\n").into_bytes();
    out.push(0);
    out
}

fn decode_hex_bytes(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks(2)
        .filter_map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|text| u8::from_str_radix(text, 16).ok())
        })
        .collect()
}

fn decode_hex_name(value: &str) -> String {
    let bytes: Vec<u8> = value
        .as_bytes()
        .chunks(2)
        .filter_map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|text| u8::from_str_radix(text, 16).ok())
        })
        .collect();
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\0')
        .to_string()
}

fn main() {
    let mut port = 45678u16;
    let mut once = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(value) = args.next() {
                    port = value.parse().unwrap_or(port);
                }
            }
            "--once" => once = true,
            "--help" | "-h" => {
                println!("stomp-sim [--port 45678] [--once]");
                return;
            }
            other => eprintln!("unknown argument: {other}"),
        }
    }
    if let Err(error) = serve(port, once) {
        eprintln!("simulator failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_store_has_the_full_surface() {
        let store = demo_store();
        assert!(store.len() > 100);
        assert_eq!(store.value_str(r"root\sys\_ver"), Some("2.4.4"));
        assert!(store.contains(r"root\app\output\global_eq\band_2"));
        assert!(store.contains(r"root\app\amp\nam2\model"));
        assert!(store.contains(r"root\vxamp_list"));
        assert_eq!(
            store
                .get(r"root\presets")
                .and_then(Node::value)
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(52)
        );
    }

    #[test]
    fn simulator_ack_advances_chunks() {
        let mut state = SimState::new();
        let reply = respond(
            r#"dwrite root\nam_amp:{"index":2,"chunk":1,"value":"00"}"#,
            &mut state,
        );
        let text = String::from_utf8_lossy(&reply);
        assert!(text.contains(r#""chunk":2"#), "{text}");
    }
}
