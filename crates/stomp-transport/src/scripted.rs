//! Deterministic scripted transport for replay tests.

use std::collections::VecDeque;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use stomp_protocol::ProtocolError;

use crate::{Result, Transport};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub expect: Vec<u8>,
    pub reply: Vec<u8>,
    pub delay_ms: u64,
    pub drop_reply: bool,
}

impl Step {
    pub fn new(expect: impl Into<Vec<u8>>, reply: impl Into<Vec<u8>>) -> Self {
        Self {
            expect: expect.into(),
            reply: reply.into(),
            delay_ms: 0,
            drop_reply: false,
        }
    }

    pub fn delayed(mut self, millis: u64) -> Self {
        self.delay_ms = millis;
        self
    }

    pub fn dropped(mut self) -> Self {
        self.drop_reply = true;
        self
    }
}

#[derive(Debug, Default)]
pub struct ScriptedTransport {
    steps: VecDeque<Step>,
    pending: Vec<u8>,
    writes: Vec<Vec<u8>>,
    open: bool,
    failures: Vec<String>,
}

impl ScriptedTransport {
    pub fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: steps.into(),
            ..Self::default()
        }
    }

    pub fn writes(&self) -> &[Vec<u8>] {
        &self.writes
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    pub fn remaining_steps(&self) -> usize {
        self.steps.len()
    }
}

impl Transport for ScriptedTransport {
    fn description(&self) -> String {
        "scripted replay".to_string()
    }

    fn open(&mut self) -> Result<()> {
        self.open = true;
        Ok(())
    }

    fn close(&mut self) {
        self.open = false;
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        if !self.open {
            return Err(ProtocolError::NotConnected);
        }
        self.writes.push(bytes.to_vec());
        let Some(step) = self.steps.pop_front() else {
            self.failures
                .push("write after the script ran out of steps".to_string());
            return Ok(());
        };
        if step.expect != bytes {
            let failure = format!(
                "expected {:?}, wrote {:?}",
                String::from_utf8_lossy(&step.expect),
                String::from_utf8_lossy(bytes)
            );
            self.failures.push(failure.clone());
            return Err(ProtocolError::Protocol(format!(
                "scripted transport: {failure}"
            )));
        }
        if !step.drop_reply {
            self.pending.extend_from_slice(&step.reply);
        }
        Ok(())
    }

    fn read(&mut self, buffer: &mut [u8], timeout: Duration) -> Result<usize> {
        if !self.open {
            return Err(ProtocolError::NotConnected);
        }
        if self.pending.is_empty() {
            // A real transport returns 0 on timeout. Reproduce that without
            // sleeping for the full timeout in tests.
            let _ = timeout;
            return Ok(0);
        }
        let count = buffer.len().min(self.pending.len());
        buffer[..count].copy_from_slice(&self.pending[..count]);
        self.pending.drain(..count);
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asserts_exact_outgoing_bytes() {
        let mut transport = ScriptedTransport::new(vec![Step::new(
            b"read root\\sys\\_name\r\n\0".to_vec(),
            b"root\\sys\\_name:{\"value\":\"StompStation PRO\"}\0".to_vec(),
        )]);
        transport.open().unwrap();
        transport.write_all(b"read root\\sys\\_name\r\n\0").unwrap();
        let mut buffer = [0u8; 256];
        let count = transport
            .read(&mut buffer, Duration::from_millis(10))
            .unwrap();
        assert!(String::from_utf8_lossy(&buffer[..count]).contains("StompStation PRO"));
    }

    #[test]
    fn records_a_mismatched_write() {
        let mut transport =
            ScriptedTransport::new(vec![Step::new(b"read a\r\n\0".to_vec(), b"a:1\0".to_vec())]);
        transport.open().unwrap();
        assert!(transport.write_all(b"read b\r\n\0").is_err());
        assert_eq!(transport.failures().len(), 1);
    }
}
