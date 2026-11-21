//! Command builders. Every command is `<body>\r\n\0`.

use crate::error::Result;
use crate::frame::COMMAND_SUFFIX;
use serde_json::{json, Value};

pub fn encode(body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + COMMAND_SUFFIX.len());
    out.extend_from_slice(body.as_bytes());
    out.extend_from_slice(COMMAND_SUFFIX);
    out
}

pub fn read(path: &str) -> Vec<u8> {
    encode(&format!("read {path}"))
}

pub fn browse_root() -> Vec<u8> {
    encode("browse root")
}

pub fn write_raw(path: &str, value: &Value) -> Result<Vec<u8>> {
    let payload = serde_json::to_string(value).map_err(|error| {
        crate::error::ProtocolError::InvalidRequest(format!("cannot encode value: {error}"))
    })?;
    Ok(encode(&format!("write {path}:{payload}")))
}

pub fn write_value(path: &str, value: &Value) -> Result<Vec<u8>> {
    write_raw(path, &json!({ "value": value }))
}

pub fn write_preset(path: &str, name: &str, save: bool) -> Result<Vec<u8>> {
    let value = if save {
        json!({ "value": name, "save": "save" })
    } else {
        json!({ "value": name })
    };
    write_raw(path, &value)
}

pub fn write_block_on(path: &str, on: bool) -> Result<Vec<u8>> {
    write_raw(
        &format!("{path}\\on_off"),
        &json!({ "value": if on { "ON" } else { "OFF" } }),
    )
}

pub fn dwrite(path: &str, index: i64, chunk: i64, value: &str) -> Result<Vec<u8>> {
    write_command(
        "dwrite",
        path,
        &json!({ "index": index, "chunk": chunk, "value": value }),
    )
}

pub fn dwrite_name_chunk(path: &str, index: i64, name: &str) -> Result<Vec<u8>> {
    let mut name_bytes = name.as_bytes().to_vec();
    name_bytes.truncate(crate::NAME_SIZE);
    name_bytes.resize(crate::NAME_SIZE, 0);
    dwrite(path, index, -1, &hex_encode(&name_bytes))
}

pub fn dread(path: &str, index: i64, chunk: i64) -> Result<Vec<u8>> {
    write_command("dread", path, &json!({ "index": index, "chunk": chunk }))
}

pub fn dmove(path: &str, index: i64, index2: i64) -> Result<Vec<u8>> {
    write_command("dmove", path, &json!({ "index": index, "index2": index2 }))
}

fn write_command(command: &str, path: &str, value: &Value) -> Result<Vec<u8>> {
    let payload = serde_json::to_string(value).map_err(|error| {
        crate::error::ProtocolError::InvalidRequest(format!("cannot encode value: {error}"))
    })?;
    Ok(encode(&format!("{command} {path}:{payload}")))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_nul_terminated() {
        assert_eq!(read(r"root\sys\_name"), b"read root\\sys\\_name\r\n\0");
        assert_eq!(browse_root(), b"browse root\r\n\0");
    }

    #[test]
    fn writes_compact_json() {
        let bytes = write_value(r"root\app\output\vol", &json!(72.0)).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "write root\\app\\output\\vol:{\"value\":72.0}\r\n\0"
        );
    }

    #[test]
    fn block_toggle_matches_python() {
        let bytes = write_block_on(r"root\app\drive", true).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "write root\\app\\drive\\on_off:{\"value\":\"ON\"}\r\n\0"
        );
    }

    #[test]
    fn preset_save_keeps_value_before_save_flag() {
        // The firmware applies fields in order: `value` selects the target
        // slot, then `save` persists the live state. Reversed order makes the
        // device reload the stored preset and discard unsaved edits.
        let bytes = write_preset(r"root\app\preset", "Dumble Carlton", true).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "write root\\app\\preset:{\"value\":\"Dumble Carlton\",\"save\":\"save\"}\r\n\0"
        );
    }

    #[test]
    fn chunked_write_keeps_index_before_chunk_and_value() {
        let bytes = dwrite("root\\nam_amp", 2, 7, "abcd").unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "dwrite root\\nam_amp:{\"index\":2,\"chunk\":7,\"value\":\"abcd\"}\r\n\0"
        );
    }
}
