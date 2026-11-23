//! Headless probe / dump / bench CLI (not shipped with the desktop app).

use std::error::Error;
use std::path::PathBuf;
use std::time::Instant;

use stomp_device::{parse_host_port, ChainEdit, Device};
use stomp_protocol::ProtocolError;
use stomp_transport::{list_serial_ports, ScriptedTransport, Step, Transport};
use stomp_upload::UploadKind;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        usage();
        std::process::exit(2);
    };
    match command.as_str() {
        "ports" => {
            for port in list_serial_ports() {
                println!(
                    "{}  {}  usb={}  {:?}:{:?}",
                    port.device, port.description, port.usb, port.vendor_id, port.product_id
                );
            }
        }
        "inspect-bundle" => {
            let path = args.next().unwrap_or_else(usage_exit);
            let bytes = std::fs::read(&path)?;
            let bundle = stomp_preset_bundle::read_bundle(&bytes)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "path": path,
                    "archive_bytes": bytes.len(),
                    "preset_name": bundle.manifest.preset.name,
                    "version": bundle.manifest.version,
                    "preset_bytes": bundle.preset_bytes.len(),
                    "summary": bundle.summary,
                    "dependencies": bundle.dependencies.iter().map(|dependency| {
                        serde_json::json!({
                            "name": dependency.manifest.name,
                            "node_path": dependency.manifest.node_path,
                            "bytes": dependency.bytes.len(),
                        })
                    }).collect::<Vec<_>>(),
                }))?
            );
        }
        "dump" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            let started = Instant::now();
            let info = device.connect()?;
            let snapshot = device.state();
            eprintln!(
                "connected to {} ({} nodes) in {:?}",
                info.device_name,
                info.node_count,
                started.elapsed()
            );
            println!("{}", serde_json::to_string_pretty(&snapshot)?);
        }
        "set-block" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let block = args.next().unwrap_or_else(usage_exit);
            let value = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            device.connect()?;
            device.set_block(&block, value.eq_ignore_ascii_case("on"))?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "move-block" => {
            let values: Vec<String> = args.collect();
            if values.len() != 5 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.edit_chain(ChainEdit::Move {
                from: (values[1].parse()?, values[2].parse()?),
                to: (values[3].parse()?, values[4].parse()?),
            })?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "add-block" => {
            let values: Vec<String> = args.collect();
            if values.len() != 4 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.edit_chain(ChainEdit::Add {
                row: values[1].parse()?,
                col: values[2].parse()?,
                path: values[3].clone(),
            })?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "remove-block" => {
            let values: Vec<String> = args.collect();
            if values.len() != 3 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.edit_chain(ChainEdit::Remove {
                row: values[1].parse()?,
                col: values[2].parse()?,
            })?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "replace-block" => {
            let values: Vec<String> = args.collect();
            if values.len() != 4 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.edit_chain(ChainEdit::Replace {
                row: values[1].parse()?,
                col: values[2].parse()?,
                path: values[3].clone(),
            })?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "clear-chain" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            device.connect()?;
            device.edit_chain(ChainEdit::Clear)?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "download-list-item" => {
            let values: Vec<String> = args.collect();
            if values.len() != 4 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            let file = device.download_list_item(&values[1], values[2].parse()?)?;
            std::fs::write(&values[3], &file.raw)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "list_path": file.list_path,
                    "index": file.index,
                    "name": file.name,
                    "kind": file.kind,
                    "extension": file.extension,
                    "bytes": file.bytes,
                    "path": values[3],
                }))?
            );
        }
        "export-preset" => {
            let values: Vec<String> = args.collect();
            if values.len() != 3 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            let export = device.export_preset_bundle(values[1].parse()?)?;
            std::fs::write(&values[2], &export.archive)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "preset_name": export.preset_name,
                    "preset_index": export.preset_index,
                    "dependencies": export.dependencies,
                    "archive_bytes": export.archive_bytes,
                    "path": values[2],
                }))?
            );
        }
        "import-preset" => {
            let values: Vec<String> = args.collect();
            if values.len() < 3 {
                usage_exit();
            }
            let slot: usize = values[2].parse()?;
            let overwrite = values.iter().any(|value| value == "--overwrite");
            let bytes = std::fs::read(&values[1])?;
            let mut device = open(&values[0])?;
            device.connect()?;
            let preflight = device.import_preflight(&bytes, Some(slot))?;
            eprintln!("{}", serde_json::to_string_pretty(&preflight)?);
            if preflight.blocked {
                return Err(Box::new(ProtocolError::InvalidRequest(
                    "import preflight blocked the bundle".into(),
                )));
            }
            let report = device.import_bundle(
                &bytes,
                stomp_device::ImportOptions {
                    target_slot: slot,
                    overwrite_preset: overwrite,
                    overwrite_dependencies: overwrite,
                },
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        "delete-list-item" => {
            let values: Vec<String> = args.collect();
            if values.len() != 3 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.delete_list_item(&values[1], values[2].parse()?)?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "set-control" => {
            let values: Vec<String> = args.collect();
            if values.len() != 3 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            let value: serde_json::Value = serde_json::from_str(&values[2])?;
            device.set_value(&values[1], value)?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "save-preset" => {
            let values: Vec<String> = args.collect();
            if values.is_empty() || values.len() > 2 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            device.save_preset(values.get(1).map(String::as_str))?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "preset" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let name = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            device.connect()?;
            device.set_preset(&name)?;
            println!("{}", serde_json::to_string_pretty(&device.state())?);
        }
        "upload" => {
            let values: Vec<String> = args.collect();
            if values.len() < 5 {
                usage_exit();
            }
            let mut device = open(&values[0])?;
            device.connect()?;
            let kind = match values[1].as_str() {
                "nam" => UploadKind::Nam,
                "pnam" => UploadKind::Pnam,
                "ir" => UploadKind::Ir,
                other => {
                    return Err(Box::new(ProtocolError::InvalidRequest(format!(
                        "unknown upload kind: {other}"
                    ))))
                }
            };
            let path = PathBuf::from(&values[2]);
            let raw = std::fs::read(&path)?;
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("upload");
            let slot = if values[3] == "-" {
                None
            } else {
                Some(values[3].parse::<usize>()?)
            };
            let result = device
                .upload_with_progress(kind, &raw, file_name, &values[4], slot, |progress| {
                    eprintln!(
                        "ack {}/{} ({} bytes sent)",
                        progress.ack, progress.total_acks, progress.bytes_sent
                    );
                    true
                })?
                .ok_or("upload was cancelled")?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        "editor" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let path = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            device.connect()?;
            let editor = device.block_editor(&path);
            println!("{}", serde_json::to_string_pretty(&editor)?);
        }
        "fixture" => {
            let address = args.next().unwrap_or_else(usage_exit);
            let output = args.next().unwrap_or_else(usage_exit);
            let mut device = open(&address)?;
            device.connect()?;
            let snapshot = device.state();
            let mut editors = serde_json::Map::new();
            for block in &snapshot.chain.blocks {
                let editor = device.block_editor(&block.path);
                editors.insert(block.path.clone(), serde_json::to_value(editor)?);
            }
            let payload = serde_json::json!({
                "snapshot": snapshot,
                "editors": editors,
            });
            if let Some(parent) = PathBuf::from(&output).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            std::fs::write(&output, serde_json::to_vec_pretty(&payload)?)?;
            eprintln!(
                "wrote fixture to {output} ({} blocks)",
                devices_len(&payload)
            );
            fn devices_len(value: &serde_json::Value) -> usize {
                value["snapshot"]["chain"]["blocks"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0)
            }
        }
        "replay" => {
            let fixture = args.next().unwrap_or_else(usage_exit);
            let text = std::fs::read_to_string(fixture)?;
            let steps: Vec<Step> = serde_json::from_str(&text)?;
            let mut transport = ScriptedTransport::new(steps);
            transport.open()?;
            println!(
                "scripted transport loaded ({} steps)",
                transport.remaining_steps()
            );
        }
        "help" | "--help" | "-h" => usage(),
        other => {
            return Err(Box::new(ProtocolError::InvalidRequest(format!(
                "unknown command: {other}"
            ))))
        }
    }
    Ok(())
}

fn open(address: &str) -> Result<Device, Box<dyn Error>> {
    if let Some(text) = address.strip_prefix("serial:") {
        let (port, baud) = text
            .split_once('@')
            .map(|(port, baud)| (port, baud.parse().unwrap_or(115_200)))
            .unwrap_or((text, 115_200));
        Ok(Device::serial(port, baud))
    } else {
        let address = address.strip_prefix("tcp:").unwrap_or(address);
        let (host, port) = parse_host_port(address)?;
        Ok(Device::tcp(host, port))
    }
}

fn usage_exit() -> String {
    usage();
    std::process::exit(2);
}

fn usage() {
    eprintln!(
        "stomp <command>

  ports
  inspect-bundle <bundle.zip>              validate an exported preset bundle
  dump <addr>                              snapshot JSON
  set-block <addr> <block-path> on|off
  move-block <addr> <from-row> <from-col> <to-row> <to-col>
  add-block <addr> <row> <col> <block-path>
  remove-block <addr> <row> <col>
  replace-block <addr> <row> <col> <block-path>
  clear-chain <addr>
  download-list-item <addr> <list-path> <index> <output>
  export-preset <addr> <index> <output.zip>
  import-preset <addr> <bundle.zip> <slot> [--overwrite]
  delete-list-item <addr> <list-path> <index>
  set-control <addr> <node-path> <json-value>
  save-preset <addr> [name]
  preset <addr> <name>
  upload <addr> nam|pnam|ir <file> <slot|-> <target-path>
  editor <addr> <block-path>               editor JSON for one block
  fixture <addr> <output.json>             snapshot + every block editor
  replay <fixture.json>

Address forms:
  tcp:192.168.1.97:8080
  serial:/dev/ttyACM0
  serial:/dev/ttyACM0@115200"
    );
}
