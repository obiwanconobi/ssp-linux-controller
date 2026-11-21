//! Serial-port enumeration and the Linux USB diagnostic text.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortInfo {
    pub device: String,
    pub description: String,
    pub usb: bool,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
    pub serial_number: Option<String>,
}

#[cfg(feature = "serial")]
pub fn list_serial_ports() -> Vec<PortInfo> {
    let Ok(ports) = serialport::available_ports() else {
        return Vec::new();
    };
    let mut result: Vec<PortInfo> = ports
        .into_iter()
        .map(|port| match port.port_type {
            serialport::SerialPortType::UsbPort(info) => PortInfo {
                device: port.port_name,
                description: info.product.unwrap_or_else(|| "USB serial".to_string()),
                usb: true,
                vendor_id: Some(format!("{:04x}", info.vid)),
                product_id: Some(format!("{:04x}", info.pid)),
                serial_number: info.serial_number,
            },
            _ => PortInfo {
                device: port.port_name,
                description: "serial port".to_string(),
                usb: false,
                vendor_id: None,
                product_id: None,
                serial_number: None,
            },
        })
        .collect();
    result.sort_by_key(|port| (!port.usb, port.device.clone()));
    result
}

#[cfg(not(feature = "serial"))]
pub fn list_serial_ports() -> Vec<PortInfo> {
    Vec::new()
}

/// True for names the pedal can appear under on Linux, macOS, and Windows.
#[cfg(feature = "serial")]
pub fn is_usb_serial_device(device: &str) -> bool {
    let device = device.to_ascii_lowercase();
    ["ttyacm", "ttyusb", "usbmodem", "cu.usb", "tty.usb"]
        .iter()
        .any(|needle| device.contains(needle))
}

#[cfg(not(feature = "serial"))]
pub fn is_usb_serial_device(_device: &str) -> bool {
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredDevice {
    pub service: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub mac: Option<String>,
    /// True when the service's TXT `id` contains the device's VoidX tag.
    pub valid: bool,
}

/// Browse `_http._tcp` for a verified `voidx` service. Returns an empty list
/// when mDNS is unavailable or nothing is found; callers fall back to USB.
#[cfg(feature = "mdns")]
pub fn discover_mdns(timeout: std::time::Duration) -> Vec<DiscoveredDevice> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    use std::time::Instant;

    let Ok(daemon) = ServiceDaemon::new() else {
        return Vec::new();
    };
    let Ok(receiver) = daemon.browse("_http._tcp.local.") else {
        return Vec::new();
    };
    let deadline = Instant::now() + timeout;
    let mut found = Vec::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let txt_id = info.get_property_val_str("id").unwrap_or_default();
                let Some(host) = info
                    .get_addresses_v4()
                    .iter()
                    .next()
                    .map(|ip| ip.to_string())
                else {
                    continue;
                };
                let device = DiscoveredDevice {
                    service: info.get_fullname().trim_end_matches('.').to_string(),
                    name: info
                        .get_property_val_str("name")
                        .unwrap_or_else(|| info.get_hostname().trim_end_matches('.'))
                        .to_string(),
                    host,
                    port: info.get_port(),
                    mac: info.get_property_val_str("mac").map(str::to_string),
                    valid: txt_id.to_ascii_lowercase().contains("voidx"),
                };
                if !found.iter().any(|existing: &DiscoveredDevice| {
                    existing.host == device.host && existing.port == device.port
                }) {
                    found.push(device);
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    found
}

#[cfg(not(feature = "mdns"))]
pub fn discover_mdns(_timeout: std::time::Duration) -> Vec<DiscoveredDevice> {
    Vec::new()
}
