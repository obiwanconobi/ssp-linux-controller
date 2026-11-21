//! TCP transport used for mDNS-discovered devices and manual addresses.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use stomp_protocol::ProtocolError;

use crate::{Result, Transport};

#[derive(Debug)]
pub struct TcpTransport {
    host: String,
    port: u16,
    connect_timeout: Duration,
    stream: Option<TcpStream>,
}

impl TcpTransport {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            connect_timeout: Duration::from_secs(5),
            stream: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }
}

impl Transport for TcpTransport {
    fn description(&self) -> String {
        format!("network {}:{}", self.host, self.port)
    }

    fn open(&mut self) -> Result<()> {
        let addresses = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map_err(|error| ProtocolError::Io(format!("could not resolve address: {error}")))?;
        let mut last_error = None;
        for address in addresses {
            match TcpStream::connect_timeout(&address, self.connect_timeout) {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    self.stream = Some(stream);
                    return Ok(());
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(ProtocolError::Io(format!(
            "could not connect to {}:{}: {}",
            self.host,
            self.port,
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no addresses".to_string())
        )))
    }

    fn close(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        let stream = self.stream.as_mut().ok_or(ProtocolError::NotConnected)?;
        stream
            .write_all(bytes)
            .map_err(|error| ProtocolError::Io(format!("socket write failed: {error}")))
    }

    fn read(&mut self, buffer: &mut [u8], timeout: Duration) -> Result<usize> {
        let stream = self.stream.as_mut().ok_or(ProtocolError::NotConnected)?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| ProtocolError::Io(format!("could not set timeout: {error}")))?;
        match stream.read(buffer) {
            Ok(count) => Ok(count),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(0)
            }
            Err(error) => Err(ProtocolError::Io(format!("socket read failed: {error}"))),
        }
    }
}
