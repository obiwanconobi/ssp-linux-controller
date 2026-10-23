#!/usr/bin/env python3
"""
stomp.py -- Core client for the Sonulab StompStation PRO.

This is a rewrite of the original CLI-oriented module using the protocol notes
in ``stompstation-pro-protocol.md`` and the real USB captures.

What it supports
----------------
* USB CDC-ACM serial (``/dev/ttyACM*``) and TCP (mDNS ``_http._tcp``).
* ``browse root`` node-tree snapshots with metadata, plus ``read root`` delta
  polling.
* Dynamic discovery of the current preset, the preset list, the signal-chain
  router, and the blocks in that router.  No hard-coded "12 blocks" list is
  required, although a fallback is kept for firmware that only answers
  ``read root``.
* Block enable/disable via ``<block>\\on_off``.
* Preset select/save.
* ACK-driven NAM and IR uploads (chunk 0 = name, data chunks, ``gz`` marker on
  the last NAM chunk).

Running this file directly launches the GTK4 UI in ``stomp_ui.py``::

    python3 stomp.py

The module itself has no GTK dependency and can be used as a library.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import socket
import struct
import sys
import threading
import time
import wave
from contextlib import contextmanager
from dataclasses import dataclass, field
from glob import glob
from typing import Any, Callable, Iterable, Iterator, Sequence

try:  # pyserial is only needed for the USB transport.
    import serial
    import serial.tools.list_ports
except Exception:  # pragma: no cover - exercised on systems without pyserial
    serial = None


# ---------------------------------------------------------------------------
# Protocol / device constants
# ---------------------------------------------------------------------------

NAM_SLOT_SIZE = 1024 * 1024          # NAM payloads are zero-padded to 1 MiB
CHUNK_SIZE = 1024
NAME_SIZE = 128
IR_LENGTH = 2048
IR_GAIN = 0.3191413049364811         # matches the official app (about -9.92 dB)

DEFAULT_BAUD = 115200
DEFAULT_POLL_INTERVAL = 0.5
DEFAULT_TIMEOUT = 3.0
BROWSE_TIMEOUT = 8.0
COMMAND_SUFFIX = b"\r\n\0"

# Known firmware paths, used only as hints/fallbacks.  The real paths are
# discovered from ``browse root`` whenever the device supports it.
PRESET_PATH = r"root\app\preset"
PRESET_LIST_PATH = r"root\presets"
ROUTER_PATH = r"root\app\router"
NAM_PATH = r"root\nam_amp"
NAM_DRIVE_PATH = r"root\nam_drive"
IR_PATH = r"root\ir_list"
MASTER_PATH = r"root\app\output"

KNOWN_LISTS = (NAM_PATH, NAM_DRIVE_PATH, IR_PATH)
OPTIONAL_STATE_PATHS = (
    PRESET_PATH,
    PRESET_LIST_PATH,
    ROUTER_PATH,
    NAM_PATH,
    NAM_DRIVE_PATH,
    IR_PATH,
    MASTER_PATH,
    r"root\sys\_name",
    r"root\sys\_ver",
    r"root\sys\_id",
    r"root\usb\_status",
)

# Friendly names for the standard chain and alternate block types.
BLOCK_LABELS = {
    "gate": "Noise Gate",
    "pitch": "Pitch",
    "pitch_time": "Pitch (Time)",
    "exp": "Expression",
    "comp": "Compressor",
    "dyna_comp": "Compressor (Dyna)",
    "mod_pre": "Modulation (pre)",
    "drive": "Drive / Distortion",
    "amp": "Amp (NAM)",
    "ir": "IR / Cabinet",
    "eq": "EQ",
    "eq2": "EQ 2",
    "parametric_eq": "Parametric EQ",
    "crossover": "Crossover",
    "mod": "Modulation (post)",
    "chorus": "Chorus",
    "flanger": "Flanger",
    "rotary": "Rotary",
    "pickup": "Pickup",
    "dtchr": "Detuner",
    "pcm42": "PCM 42",
    "delay": "Delay",
    "delay2": "Delay 2",
    "reverb": "Reverb",
    "reverb2": "Reverb 2",
}

# Used when browse/read do not expose a router (older firmware).
DEFAULT_CHAIN = (
    "gate", "pitch", "exp", "comp", "mod_pre", "drive",
    "amp", "ir", "eq", "mod", "delay", "reverb",
)

# Signal-chain connectors seen in the captures ("s" = series link).
_ROUTER_IGNORED_CELLS = {"", "s", "S", "p", "P", "parallel", "series"}


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class StompError(Exception):
    """Base class for all controller errors."""


class StompTimeout(StompError):
    """The device did not answer in time."""


class ConnectionClosed(StompError):
    """The transport was closed by the peer."""


class ProtocolError(StompError):
    """The device sent something we could not understand."""


class UploadRejected(StompError):
    """The device rejected an upload chunk or slot."""


class AuthenticationRequired(StompError):
    """The device requires a password token."""


# ---------------------------------------------------------------------------
# Small data model
# ---------------------------------------------------------------------------

@dataclass
class ParsedLine:
    path: str
    obj: Any
    command: str | None = None
    raw: str = ""


@dataclass
class BlockState:
    path: str
    label: str
    on: bool | None
    on_path: str
    in_chain: bool = True


@dataclass
class PresetState:
    path: str | None
    list_path: str | None
    current: str
    names: list[str] = field(default_factory=list)


@dataclass
class ControlState:
    path: str
    label: str
    value: float
    min: float
    max: float
    step: float = 1.0


@dataclass
class UploadTarget:
    path: str
    label: str
    kind: str          # "nam" or "ir"


@dataclass
class DeviceState:
    connected: bool = False
    device_name: str = ""
    firmware: str = ""
    device_id: str = ""
    usb_status: str = ""
    preset: PresetState = field(default_factory=lambda: PresetState(None, None, "", []))
    blocks: list[BlockState] = field(default_factory=list)
    volume: ControlState | None = None
    tempo: ControlState | None = None
    meter_in: float | None = None
    meter_out: float | None = None
    lists: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class DiscoveredDevice:
    service: str
    name: str
    host: str
    port: int
    txt: dict[str, str]
    source: str = ""
    valid: bool = False

    @property
    def address(self) -> str:
        return "%s:%d" % (self.host, self.port)

    @property
    def description(self) -> str:
        mac = self.txt.get("mac", "")
        suffix = " [%s]" % mac if mac else ""
        verified = "" if self.valid else " (unverified)"
        return "%s%s%s  -  %s" % (self.name, verified, suffix, self.address)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def path_parent(path: str) -> str:
    return path.rsplit("\\", 1)[0] if "\\" in path else ""


def path_name(path: str) -> str:
    return path.rsplit("\\", 1)[-1]


def normalize_path(path: str) -> str:
    return path.replace("\\\\", "\\")


def json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _interesting_path(path: str) -> bool:
    return path == "root" or path.startswith("root\\")


def parse_message(text: str) -> list[ParsedLine]:
    """Parse a complete ``path:json`` response message.

    The device uses CRLF-separated lines.  A few commands (notably ``dwrite``)
    echo the command name before the path, so that is stripped and recorded in
    ``ParsedLine.command``.  ``token <nonce> Y/N`` lines are returned as a
    synthetic line with ``command == "token"``.
    """
    out: list[ParsedLine] = []
    text = text.replace("\x00", "")
    for raw_line in re.split(r"\r\n|\n|\r", text):
        raw = raw_line.strip()
        if not raw:
            continue

        fields = raw.split()
        if len(fields) == 3 and fields[0] == "token":
            out.append(ParsedLine(
                path="", obj={"nonce": fields[1], "secure": fields[2] == "Y"},
                command="token", raw=raw,
            ))
            continue

        command = None
        for prefix in ("dwrite", "dmove", "dread", "browse", "write", "read"):
            if raw.startswith(prefix + " "):
                command = prefix
                raw = raw[len(prefix) + 1:].strip()
                break

        path, sep, value_text = raw.partition(":")
        if not sep or not path:
            continue
        try:
            obj: Any = json.loads(value_text)
        except (ValueError, TypeError):
            obj = value_text

        out.append(ParsedLine(path=normalize_path(path), obj=obj,
                              command=command, raw=raw_line.strip()))
    return out


def flatten_router(value: Any) -> list[str]:
    """Return block paths from a router value.

    Supports both the 2-D matrix described in the new protocol notes and the
    flat ``["root\\app\\gate", "s", ...]`` form seen in the USB captures.
    """
    found: list[str] = []

    def walk(item: Any) -> None:
        if isinstance(item, str):
            text = normalize_path(item).strip()
            if text.lower() in _ROUTER_IGNORED_CELLS:
                return
            if text.startswith("root\\") or text == "root":
                if text not in found:
                    found.append(text)
        elif isinstance(item, (list, tuple)):
            for child in item:
                walk(child)

    walk(value)
    return found


def block_label(path: str, node: dict | None = None) -> str:
    name = path_name(path)
    if name in BLOCK_LABELS:
        return BLOCK_LABELS[name]
    desc = (node or {}).get("desc")
    if isinstance(desc, str) and desc.strip():
        return desc.strip()
    return name.replace("_", " ").strip().title() or path


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_host_port(text: str, default_port: int | None = None) -> tuple[str, int]:
    """Parse ``host:port`` (IPv6 literals may be bracketed)."""
    text = text.strip()
    if not text:
        raise ValueError("empty address")
    if text.startswith("["):
        end = text.find("]")
        if end < 0:
            raise ValueError("invalid IPv6 address")
        host = text[1:end]
        rest = text[end + 1:]
        if rest.startswith(":"):
            return host, int(rest[1:])
        if default_port is not None:
            return host, default_port
        raise ValueError("missing port")
    if text.count(":") == 1:
        host, port_text = text.rsplit(":", 1)
        if not host:
            raise ValueError("missing host")
        return host, int(port_text)
    if text.count(":") > 1:  # bare IPv6 literal
        if default_port is not None:
            return text, default_port
        raise ValueError("IPv6 addresses need a port: [addr]:port")
    if default_port is not None:
        return text, default_port
    raise ValueError("missing port (use host:port)")


def is_usb_serial_device(device: str) -> bool:
    d = device.lower()
    return ("ttyacm" in d or "ttyusb" in d or "usbmodem" in d or
            "cu.usb" in d or "tty.usb" in d)


def list_serial_ports() -> list[tuple[str, str]]:
    """Return ``(device, description)``, USB devices first."""
    if serial is None:
        return []
    try:
        ports = list(serial.tools.list_ports.comports())
    except Exception:
        return []
    result = [(p.device, p.description or "") for p in ports]
    result.sort(key=lambda item: (not is_usb_serial_device(item[0]), item[0]))
    return result


def find_usb_stompstations(sysfs_root: str = "/sys/bus/usb/devices") -> list[dict[str, str]]:
    """Find StompStation USB devices in sysfs, even without a serial driver.

    The pedal is a Linux USB gadget with VID:PID ``1d6b:0104`` and the product
    string ``StompStation PRO``.  Interface 0 is CDC-ACM; if the ``cdc_acm``
    kernel module is missing or not bound, the device still appears here but
    there is no ``/dev/ttyACM*``.
    """
    found: list[dict[str, str]] = []
    try:
        entries = os.listdir(sysfs_root)
    except OSError:
        return found

    def read(base: str, name: str) -> str:
        try:
            with open(os.path.join(base, name), "r", encoding="utf-8",
                      errors="replace") as handle:
                return handle.read().strip()
        except OSError:
            return ""

    for entry in entries:
        base = os.path.join(sysfs_root, entry)
        if not os.path.isdir(base):
            continue
        product = read(base, "product")
        serial_number = read(base, "serial")
        if "stompstation" not in product.lower() and \
                not serial_number.upper().startswith("STOMPPRO"):
            continue
        vid = read(base, "idVendor")
        pid = read(base, "idProduct")
        # Is the CDC-ACM interface (class 02 / subclass 02) bound to a driver?
        acm_bound = False
        try:
            children = os.listdir(base)
        except OSError:
            children = []
        for child in children:
            if ":" not in child:
                continue
            iface = os.path.join(base, child)
            try:
                with open(os.path.join(iface, "bInterfaceClass"), "r") as handle:
                    if handle.read().strip().lower() != "02":
                        continue
            except OSError:
                continue
            if os.path.exists(os.path.join(iface, "driver")):
                acm_bound = True
        found.append({
            "sysfs": base,
            "device": entry,
            "vendor": vid,
            "product_id": pid,
            "product": product or "StompStation",
            "serial": serial_number,
            "acm_bound": "1" if acm_bound else "0",
        })
    return found


def usb_diagnostic_message() -> str | None:
    """Explain why a connected StompStation has no serial device."""
    devices = find_usb_stompstations()
    if not devices:
        return None

    acm_ports = [p for p, _desc in list_serial_ports()
                 if p.startswith("/dev/ttyACM") or p.startswith("/dev/ttyUSB")]
    if acm_ports:
        return ("StompStation USB serial device found: %s"
                % ", ".join(acm_ports))

    release = os.uname().release
    module_dir = "/lib/modules/%s" % release
    candidates = glob(os.path.join(
        module_dir, "kernel/drivers/usb/class/cdc-acm.ko*"))
    if not os.path.isdir(module_dir):
        detail = ("the running kernel (%s) has no module tree in /lib/modules; "
                  "you probably updated the kernel and have not rebooted"
                  % release)
    elif not candidates:
        detail = ("the cdc_acm module is not installed for the running kernel "
                  "(%s)" % release)
    else:
        detail = ("the cdc_acm module exists for %s but is not loaded or did "
                  "not bind to interface 0" % release)

    return (
        "StompStation PRO is connected over USB, but no /dev/ttyACM device "
        "exists: %s. Reboot into the installed matching kernel, then check "
        "with 'lsmod | grep cdc_acm' and 'ls /dev/ttyACM*'. On a normal "
        "kernel 'sudo modprobe cdc_acm' is enough; if it says the module is "
        "missing, reboot after the kernel update." % detail
    )


def nan_name_from_nam(nam_bytes: bytes) -> str | None:
    try:
        data = json.loads(nam_bytes.decode("utf-8"))
        name = data.get("metadata", {}).get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    except Exception:
        pass
    return None


def nam_gear_type(nam_bytes: bytes) -> str:
    try:
        data = json.loads(nam_bytes.decode("utf-8"))
        gear = data.get("metadata", {}).get("gear_type", "")
        return gear.lower() if isinstance(gear, str) else ""
    except Exception:
        return ""


def wav_to_ir_samples(filepath: str) -> tuple[list[float], int, int]:
    """Read a WAV and return (2048 float samples, sample_rate, channels)."""
    with wave.open(filepath, "rb") as wf:
        width = wf.getsampwidth()
        channels = wf.getnchannels()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
        if wf.getcomptype() != "NONE":
            raise ValueError("compressed WAV files are not supported")

    if width not in (1, 2, 3, 4):
        raise ValueError("unsupported WAV sample width: %d bytes" % width)

    if width == 1:
        scale = IR_GAIN / 128.0
        def convert(raw: bytes) -> float:
            return (raw[0] - 128) * scale
    else:
        bits = width * 8
        scale = IR_GAIN / float(1 << (bits - 1))
        def convert(raw: bytes) -> float:
            return int.from_bytes(raw, "little", signed=True) * scale

    step = width * channels
    samples: list[float] = []
    for offset in range(0, len(frames) - step + 1, step):
        if len(samples) >= IR_LENGTH:
            break
        samples.append(convert(frames[offset:offset + width]))
    if len(samples) < IR_LENGTH:
        samples.extend([0.0] * (IR_LENGTH - len(samples)))
    return samples, rate, channels


def _encode_name_chunk(name: str) -> bytes:
    encoded = name.encode("utf-8")[:NAME_SIZE]
    return encoded.ljust(NAME_SIZE, b"\x00")


def _split_chunks(data: bytes) -> list[bytes]:
    return [data[i:i + CHUNK_SIZE] for i in range(0, len(data), CHUNK_SIZE)]


def _nam_final_value(tail: bytes) -> str:
    """Build the final NAM chunk value (hex + "gz" + null padding)."""
    # The observed value is exactly 2048 characters: 2*len(tail) hex chars,
    # the literal "gz" marker, then "00" pairs up to 2048 characters.
    pad_pairs = max(0, 1024 - len(tail) - 1)
    return tail.hex() + "gz" + ("00" * pad_pairs)


def _nam_marker_value() -> str:
    """Marker-only final chunk, used when the gzip tail is exactly 1024 bytes."""
    return "gz" + ("00" * 1023)


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class Transport:
    """Minimal byte transport interface."""

    description = "transport"

    def open(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    def write(self, data: bytes) -> None:
        raise NotImplementedError

    def read(self, size: int, timeout: float) -> bytes:
        raise NotImplementedError


class SerialTransport(Transport):
    def __init__(self, port: str, baud: int = DEFAULT_BAUD):
        self.port = port
        self.baud = baud
        self._ser = None
        self.description = "USB serial %s" % port

    def open(self) -> None:
        if serial is None:
            raise StompError(
                "pyserial is not installed; install it with 'pip install pyserial'")
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.1,
                                      write_timeout=5.0)
        except Exception as exc:
            raise StompError("could not open %s: %s" % (self.port, exc)) from exc
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass

    def close(self) -> None:
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def write(self, data: bytes) -> None:
        ser = self._ser
        if ser is None:
            raise ConnectionClosed("serial port is not open")
        try:
            ser.write(data)
            ser.flush()
        except Exception as exc:
            raise ConnectionClosed("serial write failed: %s" % exc) from exc

    def read(self, size: int, timeout: float) -> bytes:
        ser = self._ser
        if ser is None:
            raise ConnectionClosed("serial port is not open")
        try:
            ser.timeout = max(0.01, timeout)
            return ser.read(size)
        except Exception as exc:
            raise ConnectionClosed("serial read failed: %s" % exc) from exc


class TCPTransport(Transport):
    def __init__(self, host: str, port: int, connect_timeout: float = 5.0):
        self.host = host
        self.port = port
        self.connect_timeout = connect_timeout
        self._sock: socket.socket | None = None
        self.description = "network %s:%d" % (host, port)

    def open(self) -> None:
        try:
            sock = socket.create_connection((self.host, self.port),
                                            timeout=self.connect_timeout)
            sock.settimeout(0.1)
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        except Exception as exc:
            raise StompError(
                "could not connect to %s:%d: %s" % (self.host, self.port, exc)
            ) from exc
        self._sock = sock

    def close(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def write(self, data: bytes) -> None:
        sock = self._sock
        if sock is None:
            raise ConnectionClosed("socket is not open")
        try:
            sock.sendall(data)
        except Exception as exc:
            raise ConnectionClosed("socket write failed: %s" % exc) from exc

    def read(self, size: int, timeout: float) -> bytes:
        sock = self._sock
        if sock is None:
            raise ConnectionClosed("socket is not open")
        try:
            sock.settimeout(max(0.01, timeout))
            data = sock.recv(size)
        except socket.timeout:
            return b""
        except Exception as exc:
            raise ConnectionClosed("socket read failed: %s" % exc) from exc
        if data == b"":
            raise ConnectionClosed("device closed the connection")
        return data


# ---------------------------------------------------------------------------
# mDNS discovery
# ---------------------------------------------------------------------------

def _dns_encode_name(name: str) -> bytes:
    out = bytearray()
    for label in name.rstrip(".").split("."):
        if not label:
            continue
        data = label.encode("utf-8")
        if len(data) > 63:
            raise ValueError("DNS label too long")
        out.append(len(data))
        out.extend(data)
    out.append(0)
    return bytes(out)


def _dns_read_name(data: bytes, offset: int, depth: int = 0) -> tuple[str, int]:
    if depth > 20:
        raise ValueError("DNS compression loop")
    labels: list[str] = []
    while True:
        if offset >= len(data):
            raise ValueError("truncated DNS name")
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise ValueError("truncated DNS pointer")
            pointer = ((length & 0x3F) << 8) | data[offset + 1]
            suffix, _ = _dns_read_name(data, pointer, depth + 1)
            if suffix:
                labels.append(suffix)
            offset += 2
            break
        offset += 1
        if offset + length > len(data):
            raise ValueError("truncated DNS label")
        labels.append(data[offset:offset + length].decode("utf-8", "replace"))
        offset += length
    return ".".join(labels), offset


@dataclass
class _DnsRecord:
    name: str
    rtype: int
    rdata_offset: int
    rdata: bytes
    packet: bytes


def _parse_dns_packet(data: bytes) -> list[_DnsRecord]:
    if len(data) < 12:
        return []
    try:
        _tid, _flags, qdcount, ancount, nscount, arcount = struct.unpack(
            "!HHHHHH", data[:12])
    except struct.error:
        return []
    offset = 12
    try:
        for _ in range(qdcount):
            _name, offset = _dns_read_name(data, offset)
            offset += 4
            if offset > len(data):
                return []
        records: list[_DnsRecord] = []
        for _ in range(ancount + nscount + arcount):
            name, offset = _dns_read_name(data, offset)
            if offset + 10 > len(data):
                break
            rtype, _rclass, _ttl, rdlength = struct.unpack(
                "!HHIH", data[offset:offset + 10])
            offset += 10
            rdata_offset = offset
            if offset + rdlength > len(data):
                break
            records.append(_DnsRecord(name, rtype, rdata_offset,
                                      data[offset:offset + rdlength], data))
            offset += rdlength
        return records
    except (ValueError, struct.error):
        return []


def _build_mdns_query(service: str) -> bytes:
    header = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0)
    # PTR / IN with the unicast-response bit set.  This makes discovery work
    # even when another mDNS daemon owns UDP 5353.
    question = _dns_encode_name(service) + struct.pack("!HH", 12, 0x8001)
    return header + question


def discover_mdns(timeout: float = 2.5,
                  service: str = "_http._tcp.local") -> list[DiscoveredDevice]:
    """Discover VoidX devices advertising ``_http._tcp`` via mDNS.

    This intentionally uses only the standard library.  It sends a PTR query
    and parses the PTR/SRV/TXT/A records in any replies.  Devices are returned
    sorted with VoidX-tagged services first.
    """
    query = _build_mdns_query(service)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        try:
            sock.bind(("", 5353))
        except OSError:
            sock.bind(("", 0))
        try:
            membership = socket.inet_aton("224.0.0.251") + socket.inet_aton("0.0.0.0")
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        except OSError:
            pass
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        except OSError:
            pass
        sock.settimeout(0.2)

        ptrs: dict[str, str] = {}
        srv: dict[str, tuple[int, str]] = {}
        txts: dict[str, dict[str, str]] = {}
        addresses: dict[str, list[str]] = {}
        sources: dict[str, str] = {}

        deadline = time.monotonic() + max(0.5, timeout)
        next_send = 0.0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_send:
                try:
                    sock.sendto(query, ("224.0.0.251", 5353))
                except OSError:
                    pass
                next_send = now + 0.8
            try:
                packet, addr = sock.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                break

            for record in _parse_dns_packet(packet):
                name = record.name.rstrip(".").lower()
                try:
                    if record.rtype == 12:  # PTR
                        target, _ = _dns_read_name(record.packet, record.rdata_offset)
                        target = target.rstrip(".")
                        if name == service.rstrip(".").lower() and target:
                            ptrs[target.lower()] = target
                            sources.setdefault(target.lower(), addr[0])
                    elif record.rtype == 33:  # SRV
                        target, _ = _dns_read_name(
                            record.packet, record.rdata_offset + 6)
                        priority, weight, port = struct.unpack(
                            "!HHH", record.rdata[:6])
                        del priority, weight
                        srv[name] = (port, target.rstrip("."))
                        sources.setdefault(name, addr[0])
                    elif record.rtype == 16:  # TXT
                        values: dict[str, str] = {}
                        pos = 0
                        while pos < len(record.rdata):
                            length = record.rdata[pos]
                            pos += 1
                            chunk = record.rdata[pos:pos + length]
                            pos += length
                            text = chunk.decode("utf-8", "replace")
                            key, sep, value = text.partition("=")
                            values[key.strip().lower()] = value if sep else ""
                        txts[name] = values
                        sources.setdefault(name, addr[0])
                    elif record.rtype == 1:  # A
                        if len(record.rdata) == 4:
                            addresses.setdefault(name, []).append(
                                socket.inet_ntoa(record.rdata))
                    elif record.rtype == 28:  # AAAA
                        if len(record.rdata) == 16:
                            addresses.setdefault(name, []).append(
                                socket.inet_ntop(socket.AF_INET6, record.rdata))
                except (ValueError, struct.error, OSError):
                    continue
    finally:
        sock.close()

    result: list[DiscoveredDevice] = []
    seen: set[tuple[str, int]] = set()
    for key, instance in ptrs.items():
        if key not in srv:
            continue
        port, target = srv[key]
        txt = txts.get(key, {})
        candidates = addresses.get(target.rstrip(".").lower(), [])
        if not candidates:
            candidates = addresses.get(key, [])
        v4 = [address for address in candidates if ":" not in address]
        if v4:
            host = v4[0]
        elif candidates:
            host = candidates[0]
        else:
            host = sources.get(key, "")
        # A link-local IPv6 address needs a scope id; the reply's IPv4 source
        # address is much more useful for a TCP connection.
        if host.startswith("fe80:") and sources.get(key):
            host = sources[key]
        if not host:
            host = target or sources.get(key, "")
        if not host or not port:
            continue
        dedupe = (host, port)
        if dedupe in seen:
            continue
        seen.add(dedupe)

        device_id = txt.get("id", "")
        name = txt.get("name") or instance.split(".")[0]
        valid = "voidx" in device_id.lower()
        result.append(DiscoveredDevice(
            service=instance, name=name, host=host, port=port, txt=txt,
            source=sources.get(key, ""), valid=valid,
        ))
    result.sort(key=lambda d: (not d.valid, d.name.lower(), d.address))
    return result


# ---------------------------------------------------------------------------
# Device client
# ---------------------------------------------------------------------------

class Device:
    """Line/JSON node client for a StompStation PRO."""

    def __init__(self, transport: Transport,
                 log: Callable[[str], None] | None = None,
                 poll_interval: float = DEFAULT_POLL_INTERVAL,
                 full_refresh_interval: float = 2.0):
        self.transport = transport
        self.poll_interval = poll_interval
        self.full_refresh_interval = full_refresh_interval
        self._log_cb = log
        self._io_lock = threading.RLock()
        self._cache_lock = threading.RLock()
        self._rx = bytearray()

        self.nodes: dict[str, dict[str, Any]] = {}
        self._connected = False

        self._poll_thread: threading.Thread | None = None
        self._poll_stop = threading.Event()
        self._poll_pause = threading.Event()
        self._poll_errors = 0

        self.device_name = ""
        self.firmware = ""
        self.device_id = ""

    # ---- basic plumbing -------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    def _log(self, message: str) -> None:
        if self._log_cb:
            try:
                self._log_cb(message)
            except Exception:
                pass

    def _send(self, command: str) -> None:
        if "\x00" in command:
            raise ProtocolError("outgoing command contains a NUL byte")
        try:
            self.transport.write(command.encode("utf-8") + COMMAND_SUFFIX)
        except StompError:
            self._connected = False
            raise

    def _read_frame(self, timeout: float, idle: float = 0.25) -> bytes:
        """Read one NUL-terminated frame.

        A fallback idle timeout is used because some older firmware does not
        NUL-terminate every answer.  The persistent ``_rx`` buffer keeps bytes
        that arrive after the first NUL for the next request.
        """
        with self._io_lock:
            if b"\0" in self._rx:
                frame, _, rest = bytes(self._rx).partition(b"\0")
                self._rx = bytearray(rest)
                return frame

            deadline = time.monotonic() + max(0.05, timeout)
            last_data = time.monotonic()
            while True:
                now = time.monotonic()
                if now >= deadline:
                    break
                wait = min(0.1, max(0.01, deadline - now))
                chunk = self.transport.read(4096, wait)
                if chunk:
                    self._rx.extend(chunk)
                    last_data = now
                    if b"\0" in self._rx:
                        frame, _, rest = bytes(self._rx).partition(b"\0")
                        self._rx = bytearray(rest)
                        return frame
                elif self._rx and (time.monotonic() - last_data) >= idle:
                    frame = bytes(self._rx)
                    self._rx.clear()
                    return frame
            if self._rx:
                # Return what we have rather than losing a response from
                # firmware that omits the final NUL.  Callers parse the lines.
                frame = bytes(self._rx)
                self._rx.clear()
                return frame
            raise StompTimeout("timeout waiting for a response from the device")

    def _handle_lines(self, lines: Sequence[ParsedLine]) -> None:
        secure = False
        for line in lines:
            if line.command == "token":
                nonce = line.obj.get("nonce", "")
                secure = bool(line.obj.get("secure"))
                if secure:
                    self._log("device requested password authentication "
                              "(nonce %s); this client does not implement the "
                              "proprietary VoidX hash" % nonce)
                continue
            if not _interesting_path(line.path):
                continue
            if not isinstance(line.obj, dict):
                continue
            # dwrite ACKs are not node state.
            if line.command == "dwrite" and ("index" in line.obj or "chunk" in line.obj):
                continue
            with self._cache_lock:
                node = self.nodes.setdefault(line.path, {})
                node.update(line.obj)
            if line.path == r"root\sys\_name" and isinstance(line.obj.get("value"), str):
                self.device_name = line.obj["value"]
            elif line.path == r"root\sys\_ver" and isinstance(line.obj.get("value"), str):
                self.firmware = line.obj["value"]
            elif line.path == r"root\sys\_id" and isinstance(line.obj.get("value"), str):
                self.device_id = line.obj["value"]
        if secure:
            raise AuthenticationRequired(
                "this device requires a password; the VoidX token hash is not "
                "implemented. Disable the password or use the official app.")

    def _request(self, command: str,
                 match: Callable[[Sequence[ParsedLine]], bool] | None = None,
                 timeout: float = DEFAULT_TIMEOUT,
                 idle: float = 0.25,
                 accept_empty: bool = False) -> list[ParsedLine]:
        with self._io_lock:
            self._send(command)
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise StompTimeout("no matching response to %r" % command)
                frame = self._read_frame(remaining, idle)
                text = frame.decode("utf-8", "replace")
                lines = parse_message(text)
                self._handle_lines(lines)
                if match is None or match(lines) or (accept_empty and not lines):
                    return lines

    def _ingest_snapshot(self, lines: Sequence[ParsedLine]) -> int:
        snapshot: dict[str, dict[str, Any]] = {}
        for line in lines:
            if line.command is not None:
                continue
            if _interesting_path(line.path) and isinstance(line.obj, dict):
                snapshot[line.path] = dict(line.obj)
        if len(snapshot) < 10:
            return 0
        with self._cache_lock:
            self.nodes = snapshot
        return len(snapshot)

    def _ensure_paths(self, paths: Iterable[str], timeout: float = 0.8) -> None:
        for path in paths:
            with self._cache_lock:
                if path in self.nodes:
                    continue
            try:
                self.read_path(path, timeout=timeout)
            except StompError:
                pass

    # ---- connection -----------------------------------------------------

    def connect(self) -> None:
        self.transport.open()
        self._rx.clear()
        try:
            # Consume an optional immediate "token ..." announcement.  Do not
            # fail if the device says nothing until the first request.
            try:
                frame = self._read_frame(0.35, idle=0.15)
                if frame.strip():
                    lines = parse_message(frame.decode("utf-8", "replace"))
                    self._handle_lines(lines)
            except StompTimeout:
                pass

            try:
                self._request(r"read root\sys\_name", timeout=2.0)
            except StompError as exc:
                self._log("device identity read failed: %s" % exc)

            self.refresh_full_state()
            self._connected = True
            self._log("connected to %s" % self.transport.description)
        except Exception:
            self._connected = False
            try:
                self.transport.close()
            except Exception:
                pass
            raise

    def close(self) -> None:
        self.stop_polling()
        self._connected = False
        try:
            self.transport.close()
        except Exception:
            pass

    def refresh_full_state(self) -> None:
        """Load metadata/state, preferring ``browse root``.

        New firmware returns the full node tree (with ``type``/``item_type``/
        values) from ``browse root``.  Older firmware/captures only answer
        ``read root``; in that case we fall back to explicit reads of the known
        paths.
        """
        browsed = 0
        try:
            browsed = self.browse_root()
        except StompError as exc:
            self._log("browse root unavailable (%s); falling back to read root" % exc)

        try:
            self.read_root()
        except StompError as exc:
            if not browsed:
                raise
            self._log("read root failed after browse: %s" % exc)

        # Core nodes and lists.
        if browsed:
            # A successful browse root is an authoritative snapshot.  Do not
            # waste time probing paths the device already told us are absent;
            # only fetch nodes that were present but had no value field.
            with self._cache_lock:
                nodes = dict(self.nodes)
            missing_values = [path for path in OPTIONAL_STATE_PATHS
                              if path in nodes and "value" not in nodes[path]]
            self._ensure_paths(missing_values)
        else:
            self._ensure_paths(OPTIONAL_STATE_PATHS)

        preset = self.get_preset_state()
        if preset.list_path:
            self._ensure_paths([preset.list_path])

        # Block on/off states may not be present in every browse response.
        block_paths = [b.path for b in self.get_chain_blocks()]
        self._ensure_paths([p + r"\on_off" for p in block_paths])

        master_paths = self._find_master_paths()
        if master_paths:
            self._ensure_paths([
                master_paths["base"] + r"\vol",
                master_paths["base"] + r"\tempo_bpm",
                master_paths["base"] + r"\pst\tmp",
            ])

    # ---- commands -------------------------------------------------------

    def read_root(self, timeout: float = 2.0) -> list[ParsedLine]:
        return self._request("read root", timeout=timeout, idle=0.2,
                             accept_empty=True)

    def browse_root(self, timeout: float = BROWSE_TIMEOUT,
                    quiet: bool = False) -> int:
        def match(lines: Sequence[ParsedLine]) -> bool:
            if not lines:
                return False
            paths = {line.path for line in lines}
            if "root" in paths:
                root = next((line.obj for line in lines if line.path == "root"), None)
                if isinstance(root, dict) and "type" in root:
                    return True
            typed = sum(1 for line in lines
                        if isinstance(line.obj, dict) and "type" in line.obj)
            return typed >= 10 or len(paths) >= 40

        lines = self._request("browse root", match=match, timeout=timeout,
                              idle=0.5)
        count = self._ingest_snapshot(lines)
        if not count:
            # Values-only fallback: merge into the existing tree.
            self._handle_lines(lines)
            with self._cache_lock:
                count = len(self.nodes)
        if not quiet:
            self._log("browse root loaded %d nodes" % count)
        return count

    def read_path(self, path: str,
                  timeout: float = DEFAULT_TIMEOUT) -> list[ParsedLine]:
        return self._request("read %s" % path, match=lambda lines: any(
            line.path == path for line in lines), timeout=timeout)

    def write(self, path: str, value: Any,
              extra: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"value": value}
        if extra:
            payload.update(extra)
        command = "write %s:%s" % (path, json_compact(payload))
        self._request(command, match=lambda lines: any(
            line.path == path for line in lines), timeout=DEFAULT_TIMEOUT)
        with self._cache_lock:
            self.nodes.setdefault(path, {})["value"] = value

    def set_block(self, block_path: str, on: bool) -> None:
        self.write(block_path + r"\on_off", "ON" if on else "OFF")

    def set_preset(self, name: str) -> None:
        preset = self.get_preset_state()
        self.write(preset.path or PRESET_PATH, name)

    def save_preset(self, name: str | None = None) -> None:
        preset = self.get_preset_state()
        target = preset.path or PRESET_PATH
        value = name if name is not None else preset.current
        if not value:
            raise StompError("there is no current preset to save")
        self.write(target, value, extra={"save": "save"})
        self._log("saved preset %r" % value)

    def read_list(self, path: str) -> list[str]:
        try:
            self.read_path(path)
        except StompError:
            pass
        return self.get_list(path)

    # ---- tree queries ---------------------------------------------------

    def _value(self, path: str) -> Any:
        with self._cache_lock:
            return self.nodes.get(path, {}).get("value")

    def get_list(self, path: str) -> list[str]:
        with self._cache_lock:
            value = self.nodes.get(path, {}).get("value")
        if isinstance(value, list):
            return [item if isinstance(item, str) else str(item) for item in value]
        return []

    def get_preset_state(self) -> PresetState:
        with self._cache_lock:
            nodes = dict(self.nodes)

        preset_path: str | None = None
        if PRESET_PATH in nodes:
            preset_path = PRESET_PATH
        else:
            for path, node in nodes.items():
                if (path_name(path) == "preset" and
                        node.get("type") == "plist" and
                        isinstance(node.get("value"), str)):
                    preset_path = path
                    break

        current = ""
        list_path: str | None = None
        if preset_path:
            node = nodes.get(preset_path, {})
            if isinstance(node.get("value"), str):
                current = node["value"]
            ref = node.get("ref")
            if isinstance(ref, str) and _interesting_path(normalize_path(ref)):
                list_path = normalize_path(ref)

        if not list_path:
            list_path = PRESET_LIST_PATH if PRESET_LIST_PATH in nodes else None

        if not list_path:
            for path, node in nodes.items():
                if node.get("type") == "list":
                    item_type = node.get("item_type")
                    if isinstance(item_type, str) and item_type.startswith("pst"):
                        list_path = path
                        break

        names: list[str] = []
        if list_path:
            value = nodes.get(list_path, {}).get("value")
            if isinstance(value, list):
                names = [item if isinstance(item, str) else str(item)
                         for item in value]

        return PresetState(preset_path, list_path, current, names)

    def _find_router_path(self) -> str | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if ROUTER_PATH in nodes:
            return ROUTER_PATH
        routers = [path for path, node in nodes.items()
                   if node.get("type") == "router"]
        if routers:
            # Prefer a router whose parent also contains a master/output item.
            for path in routers:
                parent = path_parent(path)
                if any(child in nodes for child in
                       (parent + r"\master", parent + r"\output")):
                    return path
            return routers[0]
        return None

    def get_chain_blocks(self) -> list[BlockState]:
        router_path = self._find_router_path()
        paths: list[str] = []
        with self._cache_lock:
            nodes = dict(self.nodes)

        if router_path:
            value = nodes.get(router_path, {}).get("value")
            paths = flatten_router(value)

        if not paths:
            # Older firmware may not expose a router node; use the known chain
            # if its blocks are present.
            candidate = [r"root\app\%s" % name for name in DEFAULT_CHAIN]
            present = [path for path in candidate
                       if path in nodes or (path + r"\on_off") in nodes]
            if present:
                paths = present

        if not paths:
            # Last resort: every direct child of root\app with an on_off node.
            prefix = "root\\app\\"
            for path in sorted(nodes):
                if path.startswith(prefix) and path.endswith(r"\on_off"):
                    block = path[:-len(r"\on_off")]
                    basename = path_name(block)
                    if basename in BLOCK_LABELS:
                        paths.append(block)

        result: list[BlockState] = []
        seen: set[str] = set()
        for path in paths:
            if path in seen:
                continue
            seen.add(path)
            node = nodes.get(path, {})
            on_path = path + r"\on_off"
            value = nodes.get(on_path, {}).get("value")
            if value == "ON":
                on: bool | None = True
            elif value == "OFF":
                on = False
            else:
                on = None
            result.append(BlockState(path=path,
                                     label=block_label(path, node),
                                     on=on, on_path=on_path))
        return result

    def _find_master_paths(self) -> dict[str, str] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        router_path = self._find_router_path()
        candidates: list[str] = []
        if router_path:
            parent = path_parent(router_path)
            candidates.extend([parent + r"\master", parent + r"\output"])
        candidates.extend([MASTER_PATH, r"root\app\master"])
        for base in candidates:
            if base in nodes and (base + r"\vol") in nodes:
                return {"base": base}
        for path in nodes:
            if path_name(path) in ("master", "output") and (path + r"\vol") in nodes:
                return {"base": path}
        return None

    def get_master_controls(self) -> tuple[ControlState | None, ControlState | None]:
        found = self._find_master_paths()
        if not found:
            return None, None
        base = found["base"]
        with self._cache_lock:
            nodes = dict(self.nodes)

        volume = None
        vol_path = base + r"\vol"
        vol_node = nodes.get(vol_path, {})
        vol_value = _as_float(vol_node.get("value"))
        if vol_value is not None:
            volume = ControlState(
                path=vol_path, label="Master volume", value=vol_value,
                min=_as_float(vol_node.get("min")) or 0.0,
                max=_as_float(vol_node.get("max")) or 100.0,
                step=1.0,
            )

        tempo = None
        tempo_path = base + r"\tempo_bpm"
        tempo_node = nodes.get(tempo_path, {})
        tempo_value = _as_float(tempo_node.get("value"))
        if tempo_value is None:
            tempo_path = base + r"\pst\tmp"
            tempo_node = nodes.get(tempo_path, {})
            tempo_value = _as_float(tempo_node.get("value"))
        if tempo_value is not None:
            tempo = ControlState(
                path=tempo_path, label="Tempo", value=tempo_value,
                min=_as_float(tempo_node.get("min")) or 20.0,
                max=_as_float(tempo_node.get("max")) or 300.0,
                step=1.0,
            )
        return volume, tempo

    def get_block_parameters(self, block_path: str) -> list[dict[str, Any]]:
        """Return the editable child parameters of a block node.

        Only direct children are returned (one level below the block).  Each
        entry is a dict with ``path``, ``name``, ``kind`` (one of ``float``,
        ``enum``, ``choice``, ``number``, ``bool``, ``text``), ``value`` and,
        where available, ``min``/``max``/``unit``/``options``/``desc``.
        """
        block_path = normalize_path(block_path)
        prefix = block_path + "\\"
        with self._cache_lock:
            nodes = dict(self.nodes)

        params: list[dict[str, Any]] = []
        for path, node in nodes.items():
            if not path.startswith(prefix):
                continue
            rel = path[len(prefix):]
            if "\\" in rel:
                continue  # only direct children for now
            name = path_name(path)
            if name == "on_off" or name.startswith("_"):
                continue

            value = node.get("value")
            ntype = node.get("type")
            desc = node.get("desc") or ""
            if ntype == "float":
                params.append({
                    "path": path, "name": name, "kind": "float",
                    "value": value,
                    "min": node.get("min"), "max": node.get("max"),
                    "unit": node.get("unit") or "", "dec": node.get("dec"),
                    "desc": desc,
                })
            elif ntype == "enum":
                options = node.get("options")
                if isinstance(options, list) and options:
                    params.append({
                        "path": path, "name": name, "kind": "enum",
                        "value": value,
                        "options": [str(option) for option in options],
                        "desc": desc,
                    })
            elif ntype == "plist":
                # A parameter list references a NodeList of choices (e.g. the
                # drive/amp model or the cabinet IR).  Offer the list entries
                # as selectable options.
                ref = node.get("ref")
                options: list[str] = []
                if isinstance(ref, str):
                    list_node = nodes.get(normalize_path(ref), {})
                    list_value = list_node.get("value")
                    if isinstance(list_value, list):
                        options = [str(item) for item in list_value if str(item)]
                params.append({
                    "path": path, "name": name, "kind": "choice",
                    "value": value, "options": options, "desc": desc,
                })
            elif isinstance(value, bool):
                params.append({"path": path, "name": name, "kind": "bool",
                               "value": value, "desc": desc})
            elif isinstance(value, (int, float)):
                params.append({"path": path, "name": name, "kind": "number",
                               "value": value, "desc": desc})
            elif isinstance(value, str) and value != "":
                params.append({"path": path, "name": name, "kind": "text",
                               "value": value, "desc": desc})

        params.sort(key=lambda param: param["name"])
        return params

    def get_upload_targets(self) -> list[UploadTarget]:
        with self._cache_lock:
            nodes = dict(self.nodes)
        targets = [
            UploadTarget(NAM_PATH, "Amp model (.nam)", "nam"),
            UploadTarget(NAM_DRIVE_PATH, "Drive model (.nam)", "nam"),
            UploadTarget(IR_PATH, "IR / cabinet (.wav)", "ir"),
        ]
        present = [t for t in targets if t.path in nodes]
        if present:
            return present
        # Before the first browse, show the common targets.
        return [targets[0], targets[2]]

    def state(self) -> DeviceState:
        preset = self.get_preset_state()
        blocks = self.get_chain_blocks()
        volume, tempo = self.get_master_controls()
        lists: dict[str, list[str]] = {}
        for target in self.get_upload_targets():
            lists[target.path] = self.get_list(target.path)
        if preset.list_path:
            lists[preset.list_path] = list(preset.names)

        meter_in = _as_float(self._value(r"root\sys\_meters\_in0"))
        in1 = _as_float(self._value(r"root\sys\_meters\_in1"))
        if in1 is not None and (meter_in is None or in1 > meter_in):
            meter_in = in1
        meter_out = _as_float(self._value(r"root\sys\_meters\_out0"))
        out1 = _as_float(self._value(r"root\sys\_meters\_out1"))
        if out1 is not None and (meter_out is None or out1 > meter_out):
            meter_out = out1

        return DeviceState(
            connected=self._connected,
            device_name=self.device_name or str(self._value(r"root\sys\_name") or ""),
            firmware=self.firmware or str(self._value(r"root\sys\_ver") or ""),
            device_id=self.device_id or str(self._value(r"root\sys\_id") or ""),
            usb_status=str(self._value(r"root\usb\_status") or ""),
            preset=preset,
            blocks=blocks,
            volume=volume,
            tempo=tempo,
            meter_in=meter_in,
            meter_out=meter_out,
            lists=lists,
        )

    # ---- polling --------------------------------------------------------

    def start_polling(self) -> None:
        if self._poll_thread and self._poll_thread.is_alive():
            return
        self._poll_stop.clear()
        self._poll_thread = threading.Thread(
            target=self._poll_loop, name="stomp-poller", daemon=True)
        self._poll_thread.start()

    def stop_polling(self) -> None:
        self._poll_stop.set()
        thread, self._poll_thread = self._poll_thread, None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    @contextmanager
    def pause_polling(self) -> Iterator[None]:
        """Stop the poller from stealing upload ACKs for the duration."""
        self._poll_pause.set()
        try:
            with self._io_lock:
                yield
        finally:
            self._poll_pause.clear()

    def _poll_loop(self) -> None:
        last_browse = 0.0
        while not self._poll_stop.is_set():
            if not self._poll_pause.is_set() and self._connected:
                try:
                    # Some firmware only reports live meters via `read root`
                    # on the network transport; periodically refresh the full
                    # tree so parameter/preset/chain changes are picked up.
                    if (self.full_refresh_interval > 0 and
                            time.monotonic() - last_browse >= self.full_refresh_interval):
                        self.browse_root(timeout=5.0, quiet=True)
                        last_browse = time.monotonic()
                    else:
                        self.read_root()
                    self._poll_errors = 0
                except AuthenticationRequired:
                    self._connected = False
                    break
                except StompError as exc:
                    self._poll_errors += 1
                    if self._poll_errors in (1, 10, 50):
                        self._log("poll error: %s" % exc)
                    if isinstance(exc, ConnectionClosed):
                        self._connected = False
                        break
            self._poll_stop.wait(self.poll_interval)

    # ---- uploads --------------------------------------------------------

    def _ack_for_chunk(self, path: str, slot: int, chunk: int, value: str,
                       timeout: float = 15.0) -> tuple[int, int]:
        command = "dwrite %s:%s" % (path, json_compact({
            "index": slot, "chunk": chunk, "value": value,
        }))

        def match(lines: Sequence[ParsedLine]) -> bool:
            return any(line.path == normalize_path(path) and
                       isinstance(line.obj, dict) and
                       "index" in line.obj and "chunk" in line.obj
                       for line in lines)

        lines = self._request(command, match=match, timeout=timeout, idle=0.4)
        for line in lines:
            if isinstance(line.obj, dict) and "index" in line.obj and "chunk" in line.obj:
                try:
                    return int(line.obj["index"]), int(line.obj["chunk"])
                except (TypeError, ValueError):
                    continue
        raise ProtocolError("no valid dwrite ACK for chunk %d" % chunk)

    def _upload(self, path: str, slot: int, name: str, payload: bytes,
                *, nam_final_marker: bool,
                progress: Callable[[float, str], None] | None = None) -> None:
        name_chunk = _encode_name_chunk(name)
        chunks = _split_chunks(payload)
        if not chunks:
            raise ValueError("nothing to upload")

        def report(done: int, total: int, message: str) -> None:
            if progress:
                try:
                    progress(min(1.0, done / max(1, total)), message)
                except Exception:
                    pass

        report(0, len(chunks) + 1, "name chunk")
        idx, ack = self._ack_for_chunk(path, slot, 0, name_chunk.hex())
        if idx == -1:
            raise UploadRejected("device rejected slot %d for %s" % (slot, path))
        if idx != slot:
            raise UploadRejected(
                "device acknowledged wrong slot (wanted %d, got %d)" % (slot, idx))

        total_steps = len(chunks) + 1
        last_ack: int | None = None
        for number, chunk in enumerate(chunks, start=1):
            is_last = number == len(chunks)
            value = chunk.hex()
            if is_last and nam_final_marker and len(chunk) < CHUNK_SIZE:
                value = _nam_final_value(chunk)
            elif is_last and nam_final_marker:
                # A 1024-byte tail cannot carry the marker; send it normally
                # and follow with a marker-only chunk.
                value = chunk.hex()

            report(number, total_steps, "chunk %d/%d" % (number, len(chunks)))
            idx, ack = self._ack_for_chunk(path, slot, number, value)
            if idx == -1:
                raise UploadRejected(
                    "device rejected chunk %d of %s (slot %d)" % (number, path, slot))
            if idx != slot:
                raise UploadRejected(
                    "device acknowledged wrong slot at chunk %d (wanted %d, got %d)"
                    % (number, slot, idx))
            if ack == -1:
                return
            last_ack = ack
            if ack not in (number + 1,):
                # Some firmware repeats the current chunk; accept a repeat,
                # but abort on a clearly bogus next-chunk number.
                if ack != number:
                    raise ProtocolError(
                        "unexpected ACK: sent chunk %d, device asked for %d"
                        % (number, ack))

        if nam_final_marker and len(chunks[-1]) == CHUNK_SIZE:
            marker_number = len(chunks) + 1
            report(marker_number, marker_number, "final marker")
            idx, ack = self._ack_for_chunk(
                path, slot, marker_number, _nam_marker_value())
            if idx == -1:
                raise UploadRejected("device rejected final NAM marker")
            if ack != -1:
                raise ProtocolError(
                    "NAM upload did not finish (device asked for chunk %d)" % ack)
        elif last_ack != -1:
            raise ProtocolError(
                "upload did not finish (device asked for chunk %r)" % last_ack)

    def load_nam(self, filepath: str, slot: int | None = None,
                 target: str | None = None, name: str | None = None,
                 progress: Callable[[float, str], None] | None = None) -> dict[str, Any]:
        with open(filepath, "rb") as f:
            nam = f.read()
        if len(nam) > NAM_SLOT_SIZE:
            raise ValueError("NAM file is larger than the 1 MiB slot")

        if name is None:
            name = nan_name_from_nam(nam) or os.path.splitext(
                os.path.basename(filepath))[0]
        name = name.strip()[:NAME_SIZE] or os.path.basename(filepath)

        if target is None:
            gear = nam_gear_type(nam)
            drive_like = any(key in gear for key in
                             ("drive", "pedal", "dist", "fuzz", "boost", "od"))
            if drive_like:
                with self._cache_lock:
                    has_drive = NAM_DRIVE_PATH in self.nodes
                target = NAM_DRIVE_PATH if has_drive else NAM_PATH
            else:
                target = NAM_PATH
        target = normalize_path(target)

        if slot is None:
            free = [i for i, value in enumerate(self.get_list(target)) if not value]
            if not free:
                raise StompError("no free slots in %s; choose a slot to overwrite"
                                 % target)
            slot = free[0]
        if slot < 0:
            raise ValueError("invalid slot")

        payload = gzip.compress(
            nam + b"\x00" * (NAM_SLOT_SIZE - len(nam)), compresslevel=6)
        self._log("uploading NAM %r (%d KiB -> %d KiB gzip) to %s slot %d"
                  % (name, len(nam) // 1024, len(payload) // 1024, target, slot))
        with self.pause_polling():
            self._upload(target, slot, name, payload, nam_final_marker=True,
                         progress=progress)
        self._log("NAM upload complete: %r -> slot %d" % (name, slot))
        try:
            time.sleep(0.15)
            self.read_path(target, timeout=3.0)
        except StompError:
            pass
        return {"target": target, "slot": slot, "name": name}

    def load_ir(self, filepath: str, slot: int | None = None,
                name: str | None = None,
                progress: Callable[[float, str], None] | None = None) -> dict[str, Any]:
        if name is None:
            name = os.path.splitext(os.path.basename(filepath))[0]
        name = name.strip()[:NAME_SIZE] or os.path.basename(filepath)

        if slot is None:
            free = [i for i, value in enumerate(self.get_list(IR_PATH)) if not value]
            if not free:
                raise StompError("no free IR slots; choose a slot to overwrite")
            slot = free[0]

        samples, rate, channels = wav_to_ir_samples(filepath)
        if rate != 48000:
            self._log("warning: IR sample rate is %d Hz (48 kHz expected)" % rate)
        if channels != 1:
            self._log("warning: IR has %d channels; using the first channel" % channels)
        payload = struct.pack("<%df" % IR_LENGTH, *samples)
        self._log("uploading IR %r (%d samples) to %s slot %d"
                  % (name, IR_LENGTH, IR_PATH, slot))
        with self.pause_polling():
            self._upload(IR_PATH, slot, name, payload, nam_final_marker=False,
                         progress=progress)
        self._log("IR upload complete: %r -> slot %d" % (name, slot))
        try:
            time.sleep(0.15)
            self.read_path(IR_PATH, timeout=3.0)
        except StompError:
            pass
        return {"target": IR_PATH, "slot": slot, "name": name}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: Sequence[str] | None = None) -> int:
    """Launch the modern GTK4 UI (or the legacy debug UI with ``--legacy``)."""
    args = list(sys.argv[1:] if argv is None else argv)
    if "--diagnose" in args:
        devices = find_usb_stompstations()
        if devices:
            for device in devices:
                print("USB device: %s  %s:%s  %s  serial=%s  cdc_acm_bound=%s"
                      % (device["device"], device["vendor"],
                         device["product_id"], device["product"],
                         device["serial"] or "-", device["acm_bound"]))
        else:
            print("USB device: no StompStation PRO found in /sys/bus/usb/devices")
        ports = list_serial_ports()
        if ports:
            print("Serial ports:")
            for device, description in ports:
                print("  %s  %s" % (device, description))
        else:
            print("Serial ports: none")
        message = usb_diagnostic_message()
        if message:
            print(message)
        return 0
    if "--legacy" in args:
        args.remove("--legacy")
        try:
            from stomp_ui_legacy import main as legacy_main
        except ImportError as exc:
            print("Could not start the legacy UI: %s" % exc, file=sys.stderr)
            return 1
        return legacy_main(args)
    try:
        from stomp_ui import main as ui_main
    except ImportError as exc:
        print("Could not start the GTK UI: %s" % exc, file=sys.stderr)
        print("Install PyGObject/GTK4 (e.g. 'sudo apt install python3-gi "
              "gir1.2-gtk-4.0') and try again.", file=sys.stderr)
        return 1
    return ui_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
