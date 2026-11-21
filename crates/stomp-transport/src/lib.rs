//! Byte transports. The device actor owns exactly one `Transport`.

pub mod discovery;
pub mod scripted;
#[cfg(feature = "serial")]
pub mod serial;
pub mod tcp;

use std::time::Duration;

pub use discovery::{
    discover_mdns, is_usb_serial_device, list_serial_ports, DiscoveredDevice, PortInfo,
};
pub use scripted::{ScriptedTransport, Step};
#[cfg(feature = "serial")]
pub use serial::SerialTransport;
#[cfg(not(feature = "serial"))]
pub use serial_stub::SerialTransport;
pub use tcp::TcpTransport;

/// Compile-only stand-in for platforms without a usable USB serial stack
/// (Android/iOS). The UI never offers serial there; a manual serial address
/// returns a clear unsupported error instead of failing to build.
#[cfg(not(feature = "serial"))]
mod serial_stub {
    use crate::{Result, Transport};
    use std::time::Duration;
    use stomp_protocol::ProtocolError;

    pub struct SerialTransport {
        description: String,
    }

    impl SerialTransport {
        pub fn new(port: impl Into<String>, baud: u32) -> Self {
            Self {
                description: format!("serial {} @ {}", port.into(), baud),
            }
        }
    }

    impl Transport for SerialTransport {
        fn description(&self) -> String {
            self.description.clone()
        }

        fn open(&mut self) -> Result<()> {
            Err(ProtocolError::Unsupported(
                "USB serial is not available on this platform".into(),
            ))
        }

        fn close(&mut self) {}

        fn write_all(&mut self, _bytes: &[u8]) -> Result<()> {
            Err(ProtocolError::Unsupported(
                "USB serial is not available on this platform".into(),
            ))
        }

        fn read(&mut self, _buffer: &mut [u8], _timeout: Duration) -> Result<usize> {
            Err(ProtocolError::Unsupported(
                "USB serial is not available on this platform".into(),
            ))
        }
    }
}

use stomp_protocol::ProtocolError;

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub trait Transport: Send {
    fn description(&self) -> String;
    fn open(&mut self) -> Result<()>;
    fn close(&mut self);
    fn write_all(&mut self, bytes: &[u8]) -> Result<()>;
    /// Blocking read with a bounded timeout. Returns 0 bytes on timeout.
    fn read(&mut self, buffer: &mut [u8], timeout: Duration) -> Result<usize>;
}

/// Every command is one request in flight; the actor handles the NUL framing.
pub fn write_command(transport: &mut dyn Transport, bytes: &[u8], timeout: Duration) -> Result<()> {
    let _ = timeout;
    transport.write_all(bytes)
}
