//! USB CDC-ACM serial transport.

use std::time::Duration;

use stomp_protocol::ProtocolError;

use crate::{Result, Transport};

#[derive(Debug)]
pub struct SerialTransport {
    port: String,
    baud: u32,
    handle: Option<Box<dyn serialport::SerialPort>>,
}

impl SerialTransport {
    pub fn new(port: impl Into<String>, baud: u32) -> Self {
        Self {
            port: port.into(),
            baud,
            handle: None,
        }
    }
}

impl Transport for SerialTransport {
    fn description(&self) -> String {
        format!("USB serial {} @ {}", self.port, self.baud)
    }

    fn open(&mut self) -> Result<()> {
        let handle = serialport::new(&self.port, self.baud)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|error| ProtocolError::Io(format!("could not open {}: {error}", self.port)))?;
        self.handle = Some(handle);
        Ok(())
    }

    fn close(&mut self) {
        self.handle.take();
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        use std::io::Write;
        let handle = self.handle.as_mut().ok_or(ProtocolError::NotConnected)?;
        handle
            .write_all(bytes)
            .and_then(|_| handle.flush())
            .map_err(|error| ProtocolError::Io(format!("serial write failed: {error}")))
    }

    fn read(&mut self, buffer: &mut [u8], timeout: Duration) -> Result<usize> {
        use std::io::Read;
        let handle = self.handle.as_mut().ok_or(ProtocolError::NotConnected)?;
        handle
            .set_timeout(timeout)
            .map_err(|error| ProtocolError::Io(format!("could not set timeout: {error}")))?;
        match handle.read(buffer) {
            Ok(count) => Ok(count),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(0)
            }
            Err(error) => Err(ProtocolError::Io(format!("serial read failed: {error}"))),
        }
    }
}
