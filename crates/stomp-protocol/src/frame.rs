//! Request framing, response parsing, and the persistent receive buffer.

use crate::error::Result;
use crate::normalize_path;
use serde_json::{json, Value};

pub const COMMAND_SUFFIX: &[u8] = b"\r\n\0";

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub path: String,
    pub value: Value,
    /// Set for echoed commands (`dwrite`, `write`, ...) and `token` replies.
    pub command: Option<String>,
    pub raw: String,
}

impl ParsedLine {
    pub fn object(&self) -> Option<&serde_json::Map<String, Value>> {
        self.value.as_object()
    }

    pub fn ack(&self) -> Option<(i64, i64)> {
        let object = self.object()?;
        let index = object.get("index")?.as_i64()?;
        let chunk = object.get("chunk")?.as_i64()?;
        Some((index, chunk))
    }

    /// True for the firmware's password challenge/status line.
    pub fn is_token(&self) -> bool {
        self.command.as_deref() == Some("token")
    }

    /// The nonce carried by a `token` line.
    pub fn token_nonce(&self) -> Option<&str> {
        self.object()?.get("nonce")?.as_str()
    }

    /// The status carried by a `token` line. `Some(true)` is `y` (accepted),
    /// `Some(false)` is `n` (missing/invalid), `None` is not a token line.
    ///
    /// Firmware 2.5.3 sends lowercase `y`/`n`; older notes assumed uppercase
    /// `Y`, so both are accepted.
    pub fn token_accepted(&self) -> Option<bool> {
        if !self.is_token() {
            return None;
        }
        self.object()?.get("secure")?.as_bool()
    }

    /// True when this is a token rejection line (`token … n`).
    pub fn token_rejected(&self) -> bool {
        self.token_accepted() == Some(false)
    }
}

/// True when any line in a response rejects the request token.
pub fn has_token_rejection(lines: &[ParsedLine]) -> bool {
    lines.iter().any(ParsedLine::token_rejected)
}

/// True when any line in a response accepted the request token.
pub fn has_token_acceptance(lines: &[ParsedLine]) -> bool {
    lines.iter().any(|line| line.token_accepted() == Some(true))
}

/// The latest nonce carried by a response, if any.
pub fn latest_token_nonce(lines: &[ParsedLine]) -> Option<&str> {
    lines.iter().rev().find_map(ParsedLine::token_nonce)
}

/// Split a complete response message into `path:json` lines.
///
/// The first colon separates path from JSON. Paths never contain colons, but
/// JSON values do, so a naive `split(':')` would truncate values.
pub fn parse_message(text: &str) -> Result<Vec<ParsedLine>> {
    let cleaned = text.replace('\0', "");
    let mut out = Vec::new();

    for raw_line in cleaned.split(['\r', '\n']) {
        let mut raw = raw_line.trim();
        if raw.is_empty() {
            continue;
        }

        let fields: Vec<&str> = raw.split_whitespace().collect();
        if fields.len() == 3 && fields[0] == "token" {
            out.push(ParsedLine {
                path: String::new(),
                value: json!({
                    "nonce": fields[1],
                    "secure": fields[2].eq_ignore_ascii_case("y"),
                    "status": fields[2],
                }),
                command: Some("token".to_string()),
                raw: raw.to_string(),
            });
            continue;
        }

        let mut command = None;
        for prefix in ["dwrite", "dmove", "dread", "browse", "write", "read"] {
            if let Some(rest) = raw.strip_prefix(prefix) {
                if let Some(rest) = rest.strip_prefix(' ') {
                    command = Some(prefix.to_string());
                    raw = rest.trim();
                    break;
                }
            }
        }

        let Some((path, value_text)) = raw.split_once(':') else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(value_text)
            .unwrap_or_else(|_| Value::String(value_text.to_string()));

        out.push(ParsedLine {
            path: normalize_path(path),
            value,
            command,
            raw: raw_line.trim().to_string(),
        });
    }

    Ok(out)
}

/// Detect an authentication challenge before other parsing.
pub fn detect_token(lines: &[ParsedLine]) -> Option<bool> {
    lines.iter().find_map(|line| {
        if line.command.as_deref() == Some("token") {
            line.object()
                .and_then(|object| object.get("secure"))
                .and_then(Value::as_bool)
        } else {
            None
        }
    })
}

/// Persistent receive buffer.
///
/// Frames terminate with NUL, but some firmware replies omit it. The caller can
/// use [`FrameBuffer::take_pending`] after an idle timeout, exactly like the
/// Python client.
#[derive(Debug, Default, Clone)]
pub struct FrameBuffer {
    bytes: Vec<u8>,
}

impl FrameBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &[u8]) {
        self.bytes.extend_from_slice(data);
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn clear(&mut self) {
        self.bytes.clear();
    }

    /// Return the first NUL-terminated frame, if one is buffered.
    pub fn take_message(&mut self) -> Option<Vec<u8>> {
        let end = self.bytes.iter().position(|byte| *byte == 0)?;
        let mut frame: Vec<u8> = self.bytes.drain(..=end).collect();
        frame.pop();
        Some(frame)
    }

    /// Return everything buffered (idle-timeout fallback for non-terminated replies).
    pub fn take_pending(&mut self) -> Option<Vec<u8>> {
        if self.bytes.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.bytes))
        }
    }

    pub fn parse(&mut self) -> Result<Option<Vec<ParsedLine>>> {
        match self.take_message() {
            Some(frame) => {
                let text = String::from_utf8_lossy(&frame);
                Ok(Some(parse_message(&text)?))
            }
            None => Ok(None),
        }
    }
}

pub fn frame_text(text: &str) -> Result<Vec<ParsedLine>> {
    parse_message(text)
}

/// Returns true when a response looks like a connection/auth failure.
pub fn is_error_frame(frame: &str) -> bool {
    let lower = frame.to_ascii_lowercase();
    lower.contains("error") || lower.contains("denied") || lower.contains("unauthor")
}

/// Validate that a reply contains the expected path (used by `read`).
pub fn has_path(lines: &[ParsedLine], expected: &str) -> bool {
    let expected = normalize_path(expected);
    lines.iter().any(|line| line.path == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_values_and_acks() {
        let lines = parse_message(
            "root\\app\\preset:{\"value\":\" Dookie\"}\r\n\
             dwrite root\\nam_amp:{\"index\":22,\"chunk\":1}\r\n",
        )
        .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].path, r"root\app\preset");
        assert_eq!(lines[0].value["value"], " Dookie");
        assert_eq!(lines[1].command.as_deref(), Some("dwrite"));
        assert_eq!(lines[1].ack(), Some((22, 1)));
    }

    #[test]
    fn parses_token_challenge() {
        let lines = parse_message("token abcdef0123456789 Y\r\n").unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].command.as_deref(), Some("token"));
        assert_eq!(detect_token(&lines), Some(true));
        assert_eq!(lines[0].token_nonce(), Some("abcdef0123456789"));
        assert_eq!(lines[0].token_accepted(), Some(true));
    }

    #[test]
    fn parses_lowercase_token_status_from_firmware() {
        let lines = parse_message(
            "token 51FBF8B3B7BB5DC9 n\r\nroot\\sys\\_name:{\"value\":\"StompStation PRO\"}\0",
        )
        .unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].is_token());
        assert_eq!(lines[0].token_accepted(), Some(false));
        assert!(lines[0].token_rejected());
        assert!(has_token_rejection(&lines));
        assert!(!has_token_acceptance(&lines));
        assert_eq!(latest_token_nonce(&lines), Some("51FBF8B3B7BB5DC9"));
        assert_eq!(lines[1].path, r"root\sys\_name");
    }

    #[test]
    fn accepts_uppercase_and_mixed_case_token_status() {
        for status in ["Y", "y"] {
            let lines = parse_message(&format!("token ABCDEF0123456789 {status}\r\n")).unwrap();
            assert_eq!(lines[0].token_accepted(), Some(true));
        }
        for status in ["N", "n"] {
            let lines = parse_message(&format!("token ABCDEF0123456789 {status}\r\n")).unwrap();
            assert_eq!(lines[0].token_accepted(), Some(false));
        }
    }

    #[test]
    fn splits_at_first_colon_only() {
        let lines = parse_message(r#"root\app\preset:{"value":"a:b:c"}"#).unwrap();
        assert_eq!(lines[0].value["value"], "a:b:c");
    }

    #[test]
    fn persistent_buffer_keeps_trailing_frame() {
        let mut buffer = FrameBuffer::new();
        buffer.push(b"root\\a:{\"value\":1}\0root\\b:{\"value\":2");
        let first = buffer.parse().unwrap().unwrap();
        assert_eq!(first[0].path, r"root\a");
        assert!(!buffer.is_empty());
        buffer.push(b"}\0");
        let second = buffer.parse().unwrap().unwrap();
        assert_eq!(second[0].path, r"root\b");
        assert_eq!(second[0].value["value"], 2);
    }
}
